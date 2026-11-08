"""Hero props for the PipeSense web scene, built procedurally in Blender.

    blender -b -P tools/blender/build_props.py -- web/assets/models

Each prop is modelled in the same local frame as its procedural twin in
web/src/props.js (three.js, Y up), so swapping the mesh never moves an
interaction anchor. B() converts a three.js point to Blender's Z-up frame;
the glTF exporter converts it back.
"""
import math
import sys

import bmesh
import bpy

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "web/assets/models"


def B(x, y, z):
    return (x, -z, y)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, metallic, roughness, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = roughness
    if coat:
        p.inputs["Coat Weight"].default_value = coat
    return m


def link(obj, mat):
    obj.data.materials.append(mat)
    bpy.context.collection.objects.link(obj)
    return obj


def lathe(name, profile, segments=96):
    """Solid of revolution about Blender Z. profile(theta) -> closed loop of (r, h)."""
    bm = bmesh.new()
    rings = []
    for i in range(segments):
        th = 2 * math.pi * i / segments
        pts = profile(th)
        rings.append([bm.verts.new((r * math.cos(th), r * math.sin(th), h)) for r, h in pts])
    n = len(rings[0])
    for i in range(segments):
        a, b = rings[i], rings[(i + 1) % segments]
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((a[j], b[j], b[k], a[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return bpy.data.objects.new(name, me)


def extrude(name, outline_xz, y0, y1):
    """Prism from a three.js XZ outline, spanning three.js Y in [y0, y1]."""
    bm = bmesh.new()
    bot = [bm.verts.new(B(x, y0, z)) for x, z in outline_xz]
    top = [bm.verts.new(B(x, y1, z)) for x, z in outline_xz]
    bm.faces.new(bot)
    bm.faces.new(top)
    n = len(bot)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bot[i], bot[j], top[j], top[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return bpy.data.objects.new(name, me)


def box(name, x0, x1, y0, y1, z0, z1):
    return extrude(name, [(x0, z0), (x1, z0), (x1, z1), (x0, z1)], y0, y1)


def bevel(obj, width, segments=2, angle=0.7):
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = angle
    mod.harden_normals = True
    return obj


def cut(target, cutter, union=False):
    mod = target.modifiers.new(cutter.name, "BOOLEAN")
    mod.operation = "UNION" if union else "DIFFERENCE"
    mod.solver = "EXACT"
    mod.object = cutter
    cutter.hide_render = True
    cutter.hide_set(True)
    return cutter


def smooth(obj, angle=0.6):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    for p in obj.data.polygons:
        p.use_smooth = True
    try:
        bpy.ops.object.shade_auto_smooth(angle=angle)
    except Exception:
        pass


def circle_xz(cx, cz, r, n=40, a0=0.0, a1=2 * math.pi):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cz + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def export(path, objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True)
    print("exported", path)


# ------------------------------------------------------------------ slip nut
def build_nut():
    reset()
    R, H, ribs = 0.031, 0.026, 28
    plastic = material("slipnut", (0.16, 0.18, 0.21), 0.0, 0.42, coat=0.25)
    rubber = material("washer", (0.02, 0.02, 0.022), 0.0, 0.8)

    def nut_profile(th):
        rib = 0.5 + 0.5 * math.cos(ribs * th)
        ro = R - 0.0016 * (1 - rib ** 3)
        return [(0.0245, -H / 2), (ro - 0.0012, -H / 2), (ro, -H / 2 + 0.0014), (ro, H / 2 - 0.0035),
                (ro - 0.0022, H / 2 - 0.0006), (R - 0.004, H / 2), (0.0228, H / 2), (0.0222, H / 2 - 0.0025),
                (0.0245, H / 2 - 0.006)]

    nut = link(lathe("slip_nut", nut_profile), plastic)
    smooth(nut, 0.5)
    washer = link(lathe("washer", lambda th: [(0.0222, -H / 2 - 0.0055), (R * 0.9, -H / 2 - 0.0055),
                                               (R * 0.9, -H / 2 - 0.0015), (0.0222, -H / 2 - 0.0015)], 64), rubber)
    smooth(washer)
    export(f"{OUT}/slip_nut.glb", [nut, washer])


# -------------------------------------------------------------------- wrench
def build_wrench():
    reset()
    steel = material("cr_v_steel", (0.72, 0.73, 0.75), 1.0, 0.26)
    dark = material("worm_steel", (0.35, 0.36, 0.38), 1.0, 0.38)

    # Handle: stadium outline tapering toward the head, hang hole at z=0.006.
    def hw(z):
        return 0.0088 + 0.0032 * (z / 0.195)
    left = [(-hw(z), z) for z in [0.006 + i * 0.0094 for i in range(21)]]
    end = circle_xz(0, 0.006, hw(0.006), 16, math.pi, 2 * math.pi)
    outline = end + [(x, z) for x, z in reversed([(-x, z) for x, z in left])] + [(hw(0.2), 0.2), (-hw(0.2), 0.2)] + list(reversed(left))[:-1]
    handle = link(extrude("wrench", outline, -0.006, 0.006), steel)

    head = link(extrude("head", circle_xz(-0.0015, 0.224, 0.0235, 48), -0.0078, 0.0078), steel)
    jaw = link(extrude("jaw_fixed", [(-0.0222, 0.214), (-0.0086, 0.214), (-0.0086, 0.272), (-0.0118, 0.278), (-0.0222, 0.268)], -0.0078, 0.0078), steel)
    cut(handle, head, union=True)
    cut(handle, jaw, union=True)
    cut(handle, link(box("slot", -0.0086, 0.03, -0.02, 0.02, 0.236, 0.30), steel))
    cut(handle, link(box("worm_window", -0.003, 0.018, -0.003, 0.003, 0.222, 0.247), steel))
    hole = link(extrude("hole", circle_xz(0, 0.006, 0.0048, 24)[:-1], -0.01, 0.01), steel)
    cut(handle, hole)
    for sy in (-1, 1):  # shallow I-beam recess on both faces of the handle
        cut(handle, link(box(f"recess{sy}", -0.0045, 0.0045, sy * 0.0048, sy * 0.009, 0.03, 0.175), steel))
    bevel(handle, 0.0011, 2)

    slide = link(extrude("jaw_slide", [(0.0094, 0.232), (0.0212, 0.232), (0.0212, 0.262), (0.0124, 0.271), (0.0094, 0.271)], -0.0068, 0.0068), steel)
    bevel(slide, 0.0008, 2)

    def worm_profile(th):
        pts = [(0.0, -0.0095)]
        for i in range(40):
            h = -0.0095 + 0.019 * i / 39
            pts.append((0.0062 + 0.0009 * (0.5 + 0.5 * math.cos(2 * math.pi * h / 0.0016 + th)), h))
        return pts + [(0.0, 0.0095)]
    worm = link(lathe("worm", worm_profile, 48), dark)
    worm.rotation_euler = (0, math.pi / 2, 0)
    worm.location = B(0.0075, 0, 0.2345)

    for o in (handle, slide, worm):
        smooth(o, 0.5)
    export(f"{OUT}/wrench.glb", [handle, slide, worm])


# ------------------------------------------------------------- faucet handle
def build_faucet_handle():
    reset()
    chrome = material("chrome", (0.9, 0.91, 0.92), 1.0, 0.07)
    stem = link(lathe("stem", lambda th: [(0, 0), (0.0115, 0), (0.0112, 0.004), (0.0098, 0.014), (0.0102, 0.02), (0, 0.022)], 48), chrome)
    stem.location = B(0, 0, 0)
    # Tapered lever: an XZ outline extruded through Y, then softened.
    lever = link(extrude("lever", [(-0.0095, 0.002), (0.0095, 0.002), (0.0068, 0.062), (0.0, 0.074), (-0.0068, 0.062)], 0.0105, 0.0215), chrome)
    bevel(lever, 0.0035, 4, angle=1.2)
    smooth(stem)
    smooth(lever, 1.2)
    export(f"{OUT}/faucet_handle.glb", [stem, lever])


# --------------------------------------------------------- angle-stop lever
def build_valve_lever():
    reset()
    chrome = material("chrome", (0.9, 0.91, 0.92), 1.0, 0.09)
    collar = link(lathe("collar", lambda th: [(0, -0.009), (0.0125, -0.009), (0.0135, -0.004), (0.0135, 0.004), (0.0118, 0.009), (0, 0.009)], 40), chrome)
    collar.rotation_euler = (0, math.pi / 2, 0)
    # Arm along +X in three.js; outline in XZ, thickness in Y.
    arm = link(extrude("arm", [(0.004, -0.0062), (0.066, -0.0042), (0.066, 0.0042), (0.004, 0.0062)], -0.0068, 0.0068), chrome)
    bevel(arm, 0.0022, 3, angle=1.2)
    smooth(collar)
    smooth(arm, 1.2)
    export(f"{OUT}/valve_lever.glb", [collar, arm])


build_nut()
build_wrench()
build_faucet_handle()
build_valve_lever()
