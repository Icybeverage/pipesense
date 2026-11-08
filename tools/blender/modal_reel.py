"""Render the pitch-reel shots (tools/blender/reel_shots.py) on Modal L40S GPUs.

    modal run tools/blender/modal_reel.py --shot A --glb full.glb --hdr web/assets/env/carpentry_shop_02_1k.hdr --outdir out/A
    modal run tools/blender/modal_reel.py --shot B --glb leak.glb ... --exposure 1.6

One probe render fixes film exposure (unless --exposure is given), then the
frame range fans out over --chunks containers with that exposure, so cuts
between chunks never flicker. Frames are interleaved across chunks.
"""
import os

import modal

app = modal.App("pipesense-reel")
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libxrender1", "libxxf86vm1", "libxfixes3", "libxi6", "libxkbcommon0", "libsm6", "libgl1", "libegl1", "libgomp1")
    .pip_install("bpy==4.2.0", "numpy<2")
)
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reel_shots.py")


@app.function(gpu="L40S", image=image, timeout=2400)
def render(src: str, glb: bytes, hdr: bytes, shot: str, opts: dict, frames: list, exposure) -> dict:
    import time

    ns = {"__name__": "reel_shots"}
    exec(compile(src, "reel_shots.py", "exec"), ns)
    open("/tmp/scene.glb", "wb").write(glb)
    open("/tmp/env.hdr", "wb").write(hdr)
    scene, device = ns["setup"]("/tmp/scene.glb", "/tmp/env.hdr", shot, opts)
    if exposure is None:
        exposure = ns["measure_exposure"](scene, frames[len(frames) // 2])
    scene.view_settings.exposure = exposure
    out = {}
    t0 = time.time()
    for f in frames:
        ns["shoot"](scene, f, opts["width"], opts["height"], opts["samples"], f"/tmp/f{f:04d}.png")
        out[f] = open(f"/tmp/f{f:04d}.png", "rb").read()
    return {"frames": out, "device": device, "exposure": exposure, "secs": time.time() - t0}


@app.local_entrypoint()
def main(shot: str, glb: str, hdr: str, outdir: str = "out", samples: int = 160, width: int = 1920, height: int = 1080,
         frames: str = "", chunks: int = 8, exposure: float = -99.0):
    import ast

    ns = {"__name__": "reel_shots_local"}
    src = open(SRC).read()
    # Read the shot table without importing bpy locally.
    tree = ast.parse(src)
    shots = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "SHOTS")
    total = shots[shot]["frames"]
    todo = [int(x) for x in frames.split(",")] if frames else list(range(total))
    os.makedirs(outdir, exist_ok=True)
    glb_b, hdr_b = open(glb, "rb").read(), open(hdr, "rb").read()
    opts = {"samples": samples, "width": width, "height": height}
    if exposure == -99.0:
        probe = render.remote(src, glb_b, hdr_b, shot, {**opts, "width": 384, "height": 216, "samples": 16}, [total // 2], None)
        exposure = probe["exposure"]
        print(f"probe exposure={exposure:.2f}")
    n = max(1, min(chunks, len(todo)))
    parts = [todo[i::n] for i in range(n)]
    secs = 0.0
    for res in render.starmap([(src, glb_b, hdr_b, shot, opts, p, exposure) for p in parts]):
        secs += res["secs"]
        for f, data in res["frames"].items():
            open(os.path.join(outdir, f"f{int(f):04d}.png"), "wb").write(data)
    print(f"shot {shot}: {len(todo)} frames device={res['device']} exposure={exposure:.2f} gpu_render_secs={secs:.0f}")
