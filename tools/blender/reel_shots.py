"""Pitch-reel shots of an exported PipeSense scene in Blender Cycles.

Shared by tools/blender/modal_reel.py (Modal L40S, bpy 4.2) and a local
preview path (Blender with Metal):

    blender -b -P tools/blender/reel_shots.py -- --glb scene.glb --hdr env.hdr \
        --shot A --frames 0,95 --width 640 --height 360 --samples 32 --outdir out

Shots are written in three.js coordinates (Y up, +Z toward the viewer) and
converted to Blender's Z-up frame with B(). Every shot is fully keyframed
(camera, focus target, water drops), so motion blur is real and any frame
range renders identically in any container.

Scene corrections applied here, not in the web app:
  * The backsplash tile plane is 1.36 m wide but the rig's legs end at
    x = +/-0.625 with no right-hand side panel, so 5.5 cm of lit tile shows
    past the right rear leg as a bright vertical strip. It is trimmed to the
    leg line (TILE_WIDTH).
  * Water drips are re-shaded as water and, for the leak shot, re-animated:
    a drop swells under the loose wall nut, lets go and falls to the shelf.
"""
import math
import sys

import bpy

TILE_WIDTH = 1.22  # tile plane trimmed to the rig's leg line (x = +/-0.61)
FPS = 24


def B(x, y, z):
    """three.js (Y up) -> Blender (Z up)."""
    return (x, -z, y)


# Each shot: camera path (from -> to, eased), look-at target path, lens (mm on
# a 36 mm sensor), f-stop, frame count. Points are three.js coordinates.
SHOTS = {
    # Hero push-in on the finished trap: whole bowl and counter edge stay in
    # frame on the last frame.
    "A": {
        "frames": 96, "scene": "full", "lens": 30.0, "fstop": 5.6, "hide_block": True,
        "cam": [(0.66, 0.96, 2.25), (0.38, 0.92, 1.68)],
        "target": [(0.03, 0.80, 0.20), (0.0, 0.82, 0.20)],
        "focus": [(0.0, 0.62, 0.26), (0.0, 0.62, 0.26)],
    },
    # The failure: slow close-up of the loose wall joint with drops falling.
    # The camera sits inside the open rig, right of the trap, so neither the
    # rig's front leg nor the trap's rising leg (z = 0.18) hides the fall
    # line (z = 0.134).
    "B": {
        "frames": 72, "scene": "leak", "lens": 40.0, "fstop": 2.8, "drops": True, "shutter": 0.2,
        "cam": [(0.47, 0.64, 0.47), (0.41, 0.625, 0.38)],
        "target": [(0.0, 0.56, 0.14), (0.0, 0.56, 0.14)],
        "focus": [(0.0, 0.58, 0.135), (0.0, 0.58, 0.135)],
    },
    # Clean wide establishing shot, slow lateral drift.
    "C": {
        "frames": 72, "scene": "full", "lens": 32.0, "fstop": 8.0, "hide_block": True, "level": True,
        "cam": [(0.85, 1.30, 3.00), (0.62, 1.28, 2.92)],
        "target": [(0.06, 0.78, 0.25), (0.02, 0.78, 0.25)],
        "focus": [(0.0, 0.70, 0.30), (0.0, 0.70, 0.30)],
    },
}


def ease(t):
    return t * t * (3 - 2 * t)


def lerp3(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def water_material():
    m = bpy.data.materials.new("water")
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (0.92, 0.97, 1.0, 1)
    p.inputs["Roughness"].default_value = 0.02
    p.inputs["IOR"].default_value = 1.333
    p.inputs["Transmission Weight"].default_value = 1.0
    return m


def wet_material():
    """Thin water film on the shelf: a glossy clear-coat darkening, no colour."""
    m = bpy.data.materials.new("wet")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1)
    p.inputs["Roughness"].default_value = 0.04
    p.inputs["IOR"].default_value = 1.333
    p.inputs["Transmission Weight"].default_value = 1.0
    p.inputs["Alpha"].default_value = 0.55
    try:
        m.surface_render_method = "DITHERED"
    except Exception:
        pass
    return m


def fix_scene(scene, opts):
    """Trim the tile plane; re-shade or remove exported water fx."""
    from mathutils import Vector

    for o in list(scene.objects):
        if o.type != "MESH":
            continue
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        dims = [max(v[i] for v in bb) - min(v[i] for v in bb) for i in range(3)]
        # Backsplash tiles: 1.36 x 1.0 plane just in front of the back wall.
        if abs(dims[0] - 1.36) < 0.01 and abs(dims[2] - 1.0) < 0.01 and dims[1] < 0.005:
            o.scale.x *= TILE_WIDTH / 1.36
            print("tile plane trimmed:", o.name)
        # Featureless 0.8 x 0.55 x 1.15 m block cabinet (depth silhouette)
        # reads as an untextured CG box in a wide shot.
        if opts.get("hide_block") and abs(dims[0] - 0.8) < 0.01 and abs(dims[1] - 0.55) < 0.01 and abs(dims[2] - 1.15) < 0.01:
            bpy.data.objects.remove(o)
            print("block cabinet removed")
    water = water_material()
    wet = wet_material()
    for o in list(scene.objects):
        if o.name.startswith("fx_drip"):
            if opts.get("drops"):
                bpy.data.objects.remove(o)  # re-animated below
            else:
                o.data.materials.clear()
                o.data.materials.append(water)
        elif o.name.startswith("fx_puddle_floor"):
            bpy.data.objects.remove(o)
        elif o.name.startswith("fx_puddle_shelf"):
            o.data.materials.clear()
            o.data.materials.append(wet)
            o.scale = (o.scale[0] * 0.55, o.scale[1] * 0.55, o.scale[2])
            # Pool where the drops land, under the wall joint.
            o.location = B(0.02, 0.4012, 0.17)
    return water


def add_drops(scene, water, total):
    """Drops that swell under the loose wall nut, let go and fall to the shelf."""
    import bmesh

    me = bpy.data.meshes.new("drop")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=16, radius=0.0048)
    # Teardrop: pinch the top.
    for v in bm.verts:
        if v.co.z > 0:
            k = v.co.z / 0.0048
            v.co.x *= 1 - 0.55 * k * k
            v.co.y *= 1 - 0.55 * k * k
            v.co.z *= 1.35
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(water)

    hang_z = 0.626   # three.js Y of the drop's centre while it hangs
    shelf = 0.403
    g = 3.2          # the web app's drip gravity: reads as gentle slow motion
    # (start frame, x offset, z offset): two drip points on the nut, irregular rhythm.
    events = []
    f = -10
    i = 0
    rhythm = [19, 23, 17, 25, 21, 18]
    while f < total + 30:
        events.append((f, (0.002, -0.006, 0.008)[i % 3], (0.130, 0.133, 0.129)[i % 3]))
        f += rhythm[i % len(rhythm)]
        i += 1
    grow = 14
    fall = math.sqrt(2 * (hang_z - shelf) / g) * FPS
    for n, (start, dx, dz) in enumerate(events):
        o = bpy.data.objects.new(f"drop_{n}", me)
        scene.collection.objects.link(o)
        for fr in range(-1, total + 1):
            t = fr - start
            if t < 0 or t > grow + fall + 1:
                s, y, stretch = 0.0, hang_z, 1.0
            elif t <= grow:
                k = t / grow
                s = 0.35 + 0.65 * k ** 0.7
                y = hang_z + 0.004 * (1 - k)
                stretch = 1.0 + 0.25 * k
            else:
                tt = (t - grow) / FPS
                y = hang_z - 0.5 * g * tt * tt
                v = g * tt
                s = 1.0
                stretch = 1.25 + min(0.9, v * 0.45)
                if y <= shelf:
                    s, y = 0.0, shelf
            o.location = B(dx, y, dz)
            o.scale = (s, s, s * stretch)
            o.keyframe_insert("location", frame=fr)
            o.keyframe_insert("scale", frame=fr)
    # Small kick light near the lens: gives each drop a specular glint so it
    # reads against the pale tile.
    glint = bpy.data.lights.new("glint", "POINT")
    glint.energy = 1.5
    glint.shadow_soft_size = 0.03
    glint.color = (1.0, 0.95, 0.88)
    lo = bpy.data.objects.new("glint", glint)
    lo.location = B(0.30, 0.70, 0.36)
    scene.collection.objects.link(lo)
    print("drops:", len(events))


def setup(glb, hdr, shot, opts):
    spec = SHOTS[shot]
    total = opts.get("total") or spec["frames"]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    scene = bpy.context.scene
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 0, total - 1

    for o in list(scene.objects):
        if o.type == "CAMERA":
            bpy.data.objects.remove(o)
    water = fix_scene(scene, {"drops": spec.get("drops"), "hide_block": spec.get("hide_block")})
    if spec.get("drops"):
        add_drops(scene, water, total)

    cam_data = bpy.data.cameras.new("ReelCam")
    cam_data.lens = spec["lens"]
    cam_data.sensor_width = 36
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.clip_start = 0.01
    cam = bpy.data.objects.new("ReelCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = bpy.data.objects.new("look", None)
    focus = bpy.data.objects.new("focus", None)
    scene.collection.objects.link(target)
    scene.collection.objects.link(focus)
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    cam_data.dof.use_dof = True
    cam_data.dof.focus_object = focus
    cam_data.dof.aperture_fstop = opts.get("fstop") or spec["fstop"]
    for fr in range(-1, total + 1):
        t = ease(min(1, max(0, fr / max(1, total - 1))))
        c = lerp3(*spec["cam"], t)
        tg = lerp3(*spec["target"], t)
        cam.location = B(*c)
        if spec.get("level"):
            # Level camera, framed with lens shift: verticals stay vertical.
            target.location = B(tg[0], c[1], tg[2])
            dist = math.hypot(tg[0] - c[0], tg[2] - c[2])
            cam_data.shift_y = (tg[1] - c[1]) / dist * spec["lens"] / 36.0
            cam_data.keyframe_insert("shift_y", frame=fr)
        else:
            target.location = B(*tg)
        focus.location = B(*lerp3(*spec["focus"], t))
        for ob in (cam, target, focus):
            ob.keyframe_insert("location", frame=fr)

    for o in scene.objects:
        if o.type == "LIGHT" and o.name != "glint":
            o.data.energy *= opts.get("light_gain", 40.0)
            o.data.shadow_soft_size = 0.06

    world = bpy.data.worlds.new("env")
    try:
        world.use_nodes = True
    except Exception:
        pass
    nodes = world.node_tree.nodes
    env = nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(hdr)
    mapping = nodes.new("ShaderNodeMapping")
    coord = nodes.new("ShaderNodeTexCoord")
    mapping.inputs["Rotation"].default_value[2] = 1.1
    world.node_tree.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    world.node_tree.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    bg = next(n for n in nodes if n.type == "BACKGROUND")
    world.node_tree.links.new(env.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = opts.get("world_strength", 0.3)
    scene.world = world

    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    device = "NONE"
    for kind in ("OPTIX", "CUDA", "METAL"):
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
    scene.cycles.max_bounces = 12
    scene.cycles.transmission_bounces = 12
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.cycles.blur_glossy = 1.0
    scene.cycles.sample_clamp_indirect = 8.0
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = spec.get("shutter", 0.5)
    scene.view_settings.view_transform = "AgX"
    for look in ("AgX - Medium High Contrast", "Medium High Contrast"):
        try:
            scene.view_settings.look = look
            break
        except Exception:
            continue
    return scene, device


def shoot(scene, frame, w, h, spp, path):
    scene.frame_set(frame)
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.cycles.samples = spp
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    return path


def measure_exposure(scene, frame):
    import numpy as np

    scene.view_settings.exposure = 0.0
    shoot(scene, frame, 384, 216, 24, "/tmp/reel_preview.png")
    img = bpy.data.images.load("/tmp/reel_preview.png")
    px = np.array(img.pixels[:]).reshape(-1, 4)[:, :3]
    mean = float((px @ np.array([0.2126, 0.7152, 0.0722])).mean())
    return max(-6.0, min(8.0, math.log2(0.30 / max(mean, 1e-4)) * 1.6))


def local_main():
    import argparse
    import os

    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--hdr", required=True)
    ap.add_argument("--shot", default="A")
    ap.add_argument("--frames", default="0")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=360)
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--exposure", type=float, default=None)
    ap.add_argument("--outdir", default="out")
    a = ap.parse_args(argv)
    os.makedirs(a.outdir, exist_ok=True)
    scene, device = setup(a.glb, a.hdr, a.shot, {})
    frames = [int(x) for x in a.frames.split(",")]
    exposure = a.exposure if a.exposure is not None else measure_exposure(scene, frames[len(frames) // 2])
    scene.view_settings.exposure = exposure
    for f in frames:
        shoot(scene, f, a.width, a.height, a.samples, os.path.join(os.path.abspath(a.outdir), f"{a.shot}_{f:04d}.png"))
    print(f"local shot={a.shot} device={device} exposure={exposure:.2f}")


if __name__ == "__main__":
    local_main()
