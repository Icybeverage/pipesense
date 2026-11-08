"""Path-traced stills and camera moves of an exported PipeSense scene: Blender
Cycles on Modal GPUs.

    modal run tools/blender/modal_cycles.py --glb scene.glb --hdr web/assets/env/carpentry_shop_02_1k.hdr --outdir out [--frames 72]

The GLB comes from the live three.js scene (window.PipeSense.world in a ?qa=1
session), so the render shows exactly what the lesson built. three.js and
Cycles use different light scales: one preview render measures the scene and
fixes film exposure, and every frame chunk reuses it so a move never flickers.
"""
import modal

app = modal.App("pipesense-cycles")
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libxrender1", "libxxf86vm1", "libxfixes3", "libxi6", "libxkbcommon0", "libsm6", "libgl1", "libegl1", "libgomp1")
    .pip_install("bpy==4.2.0", "numpy<2")
)

# Lesson camera target (three.js CAMERA_HOME.target) in Blender's Z-up frame.
TARGET = (0.0, -0.12, 0.72)
# Camera drift across the move, in Blender units (+Y is toward the wall): a slow
# push in that arcs from the right.
MOVE_FROM = (0.12, -0.04, 0.03)
MOVE_TO = (-0.03, 0.12, -0.015)


@app.function(gpu="L40S", image=image, timeout=1800)
def render(glb: bytes, hdr: bytes, opts: dict, frames: list, total: int, exposure) -> dict:
    import math

    import bpy
    import numpy as np

    open("/tmp/scene.glb", "wb").write(glb)
    open("/tmp/env.hdr", "wb").write(hdr)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath="/tmp/scene.glb")
    scene = bpy.context.scene

    cams = [o for o in scene.objects if o.type == "CAMERA"]
    cam = next((c for c in cams if "LessonCamera" in c.name), cams[0])
    world_matrix = cam.matrix_world.copy()
    cam.parent = None
    cam.matrix_world = world_matrix
    scene.camera = cam
    base = cam.location.copy()
    target = bpy.data.objects.new("target", None)
    target.location = TARGET
    scene.collection.objects.link(target)
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    cam.data.dof.use_dof = True
    cam.data.dof.focus_object = target
    cam.data.dof.aperture_fstop = opts.get("fstop", 4.0)

    for o in scene.objects:
        if o.type == "LIGHT":
            o.data.energy *= opts["light_gain"]
            o.data.shadow_soft_size = 0.06

    world = bpy.data.worlds.new("env")
    world.use_nodes = True
    nodes = world.node_tree.nodes
    env = nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load("/tmp/env.hdr")
    mapping = nodes.new("ShaderNodeMapping")
    coord = nodes.new("ShaderNodeTexCoord")
    mapping.inputs["Rotation"].default_value[2] = 1.1
    world.node_tree.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    world.node_tree.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    world.node_tree.links.new(env.outputs["Color"], nodes["Background"].inputs["Color"])
    nodes["Background"].inputs["Strength"].default_value = opts["world_strength"]
    scene.world = world

    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    device = "NONE"
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == kind
                device = kind
                break
        except Exception:
            continue
    scene.cycles.device = "GPU" if device != "NONE" else "CPU"
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"

    def place(frame):
        t = frame / max(1, total - 1)
        t = t * t * (3 - 2 * t)  # ease in/out
        cam.location = [base[i] + MOVE_FROM[i] + (MOVE_TO[i] - MOVE_FROM[i]) * t for i in range(3)]

    def shoot(w, h, spp, path):
        scene.render.resolution_x, scene.render.resolution_y = w, h
        scene.cycles.samples = spp
        scene.render.filepath = path
        scene.render.image_settings.file_format = "PNG"
        bpy.ops.render.render(write_still=True)
        return open(path, "rb").read()

    if exposure is None:
        place(total // 2)
        shoot(384, 216, 24, "/tmp/preview.png")
        img = bpy.data.images.load("/tmp/preview.png")
        px = np.array(img.pixels[:]).reshape(-1, 4)[:, :3]
        mean = float((px @ np.array([0.2126, 0.7152, 0.0722])).mean())
        exposure = max(-6.0, min(8.0, math.log2(0.30 / max(mean, 1e-4)) * 1.6))
    scene.view_settings.exposure = exposure

    out = {}
    for f in frames:
        place(f)
        out[f] = shoot(opts["width"], opts["height"], opts["samples"], f"/tmp/f{f:04d}.png")
    return {"frames": out, "device": device, "exposure": exposure}


@app.local_entrypoint()
def main(glb: str, hdr: str, outdir: str = "out", samples: int = 192, width: int = 1920, height: int = 1080,
         light_gain: float = 40.0, world_strength: float = 0.3, frames: int = 1, chunks: int = 6):
    import os

    os.makedirs(outdir, exist_ok=True)
    glb_b, hdr_b = open(glb, "rb").read(), open(hdr, "rb").read()
    opts = {"samples": samples, "width": width, "height": height, "light_gain": light_gain, "world_strength": world_strength}
    if frames == 1:
        res = render.remote(glb_b, hdr_b, opts, [0], 1, None)
        open(os.path.join(outdir, "still.png"), "wb").write(res["frames"][0])
        print(f"still device={res['device']} exposure={res['exposure']:.2f}")
        return
    # Measure once, then fan the frame range out with that exposure fixed.
    probe = render.remote(glb_b, hdr_b, {**opts, "width": 384, "height": 216, "samples": 16}, [frames // 2], frames, None)
    exposure = probe["exposure"]
    parts = [list(range(i, frames, chunks)) for i in range(chunks)]
    for res in render.starmap([(glb_b, hdr_b, opts, p, frames, exposure) for p in parts]):
        for f, data in res["frames"].items():
            open(os.path.join(outdir, f"f{int(f):04d}.png"), "wb").write(data)
    print(f"{frames} frames device={probe['device']} exposure={exposure:.2f}")
