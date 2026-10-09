# Tinysolver Studio — headless Blender render of one model material
# (embedded by studio_render.rs; the same file runs on every OS).
#   blender -b -P studio_render.py -- <job.json>
# job: { model, out, mode: turntable|still|walk, frames, width, height,
#        cam_dist, yaw, pitch, keyframes: [frame…], video: bool }
# Writes <out>/key_NNN.png per keyframe, <out>/video.mp4 when video, and
# <out>/result.json. Scene recipe from the 2026-10-07 measurement
# (handoff 3d-pose-bench turntable.py): height 2 on a ground plate, three
# area lights, a bright world, a camera on a pivot.
import bpy, math, sys, os, json, time
from mathutils import Vector

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
t0 = time.time()
model, out = job["model"], job["out"]
mode = job.get("mode", "turntable")
frames = max(1, int(job.get("frames", 72)))
width, height = int(job.get("width", 720)), int(job.get("height", 720))
cam_dist = float(job.get("cam_dist", 6.2))
yaw, pitch = float(job.get("yaw", 0)), float(job.get("pitch", 8))
keys = [k for k in job.get("keyframes", [1]) if 1 <= int(k) <= frames] or [1]
os.makedirs(out, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
if model.lower().endswith(".fbx"):
    bpy.ops.import_scene.fbx(filepath=model)
else:
    bpy.ops.import_scene.gltf(filepath=model)
sc = bpy.context.scene
# The glTF importer adds a mesh to draw bones with (an Icosphere at unit
# size); it is not part of the model and would skew the framing.
for arm in [o for o in sc.objects if o.type == 'ARMATURE']:
    for pb in arm.pose.bones:
        shape = pb.custom_shape
        if shape is not None and shape.name in bpy.data.objects:
            pb.custom_shape = None
            bpy.data.objects.remove(shape)
objs = [o for o in sc.objects if o.type == 'MESH']
if not objs:
    json.dump({"ok": False, "note": "The model has no mesh."}, open(os.path.join(out, "result.json"), "w"))
    sys.exit(0)
# Bounds → centred, standing on the ground, height 2. Measured on the
# evaluated vertices: a skinned mesh's bound_box can be far off its pose.
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
for o in objs:
    e = o.evaluated_get(dg); me = e.to_mesh()
    for v in me.vertices:
        w = e.matrix_world @ v.co
        mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
    e.to_mesh_clear()
s = 2.0 / max(max(mx - mn), 1e-6)
root = bpy.data.objects.new("root", None); sc.collection.objects.link(root)
for o in list(sc.objects):
    if o is not root and o.parent is None and o.type in ('MESH', 'ARMATURE', 'EMPTY'):
        o.parent = root
root.scale = (s, s, s)
ctr = (mn + mx) / 2
root.location = (-ctr.x * s, -ctr.y * s, -mn.z * s)

bpy.ops.mesh.primitive_plane_add(size=200)
g = bpy.context.object
m = bpy.data.materials.new("ground"); m.use_nodes = True
m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.93, 0.9, 0.86, 1)
g.data.materials.append(m)

def light(loc, energy, size):
    d = bpy.data.lights.new("area", 'AREA'); d.energy = energy; d.size = size
    o = bpy.data.objects.new("area", d); o.location = loc
    sc.collection.objects.link(o)
    o.rotation_euler = (Vector((0, 0, 1)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
light((3, -3, 4), 600, 3); light((-4, -1, 2.5), 200, 4); light((0, 4, 3), 300, 3)
world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.95, 0.93, 0.9, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.6

pivot = bpy.data.objects.new("pivot", None); sc.collection.objects.link(pivot)
pivot.location = (0, 0, 1.0)
cam_d = bpy.data.cameras.new("cam"); cam_d.lens = 50
cam = bpy.data.objects.new("cam", cam_d); sc.collection.objects.link(cam)
cam.parent = pivot
p = math.radians(pitch)
cam.location = (0, -cam_dist * math.cos(p), cam_dist * math.sin(p))
cam.rotation_euler = (math.radians(90) - p, 0, 0)
sc.camera = cam
sc.frame_start, sc.frame_end = 1, frames
sc.render.fps = 24
pivot.rotation_euler = (0, 0, math.radians(yaw))
if mode == "turntable":
    pivot.keyframe_insert("rotation_euler", frame=1)
    pivot.rotation_euler = (0, 0, math.radians(yaw + 360))
    pivot.keyframe_insert("rotation_euler", frame=frames + 1)


# ── walk: a procedural 1-second stride on a rigged model (model-pick
# bench/rig rigeval.py, 2026-10-08). Limbs are found by shape, not bone
# names (every auto-rigger names them differently): the outermost high leaf
# is a hand, the lowest leaf a foot, each chain walked back to the body.
def walk(frames):
    from mathutils import Matrix, Quaternion
    arms_ = [o for o in sc.objects if o.type == 'ARMATURE']
    if not arms_:
        return "The model has no skeleton. Rig it first (studio_generate_asset kind rig)."
    arm = max(arms_, key=lambda a: len(a.data.bones))
    vl = bpy.context.view_layer
    vl.update()
    mw = arm.matrix_world
    H = lambda b: mw @ b.head_local
    heads = [H(b) for b in arm.data.bones]
    zmin = min(h.z for h in heads); zmax = max(h.z for h in heads)
    xs = [h.x for h in heads]; cx = (max(xs) + min(xs)) / 2; tall = max(zmax - zmin, 1e-6)
    def chain_to_center(b):
        c = [b]
        while c[-1].parent is not None and abs(H(c[-1]).x - cx) > 0.02 * tall:
            c.append(c[-1].parent)
        return list(reversed(c))
    leaves = [b for b in arm.data.bones if not b.children]
    def pick(side, kind):
        if kind == "hand":
            cand = [b for b in leaves if (H(b).x - cx) * side > 0.08 * tall and H(b).z > zmin + 0.28 * tall]
            return max(cand, key=lambda b: (H(b).x - cx) * side, default=None)
        cand = [b for b in leaves if (H(b).x - cx) * side > 0.01 * tall and H(b).z < zmin + 0.35 * tall]
        return min(cand, key=lambda b: H(b).z, default=None)
    limbs = {}
    for side, sn in ((1, "L"), (-1, "R")):
        for kind in ("hand", "foot"):
            b = pick(side, kind)
            if b:
                limbs[f"{kind}{sn}"] = [x.name for x in chain_to_center(b)]
    # A sampled rig can come back as a star — every bone hanging straight off
    # the root, no thigh → shin chain (SkinTokens, seed-dependent). It cannot
    # walk; say so instead of rendering a twitching statue.
    legs = [v for k, v in limbs.items() if k.startswith("foot") and len(v) >= 3]
    if not legs:
        return ("The skeleton has no leg chains (its bones hang straight off the root), so it cannot walk. "
                "Add bones again with another seed (studio_generate_asset kind rig, seed …).")
    B = lambda n: arm.data.bones[n]
    def first_out(chain, leg):
        if leg:
            return chain[1] if len(chain) > 2 else chain[0]
        k = next((i for i in range(3, len(chain)) if len(B(chain[i]).children) > 1 or B(chain[i]).length < 0.07 * tall), len(chain) - 1)
        return chain[max(1, k - 2)]
    def next_of(chain, n):
        i = chain.index(n); return chain[i + 1] if i + 1 < len(chain) else None
    bpy.ops.object.select_all(action='DESELECT'); vl.objects.active = arm
    bpy.ops.object.mode_set(mode='POSE')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    A3 = mw.to_3x3().normalized(); A3i = A3.inverted()
    def reset():
        for pb in arm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0); pb.scale = (1, 1, 1)
        vl.update()
    def rot_world(name, q):
        pb = arm.pose.bones[name]; m = pb.matrix.copy(); h = m.translation.copy()
        R = (A3i @ q.to_matrix() @ A3).to_4x4()
        pb.matrix = Matrix.Translation(h) @ R @ Matrix.Translation(-h) @ m; vl.update()
    def dir_of(chain):
        a = arm.pose.bones[chain[0]]; b = arm.pose.bones[chain[-1]]
        return (mw @ b.head - mw @ a.head).normalized()
    def aim(name, chain, target):
        rot_world(name, dir_of(chain).rotation_difference(target.normalized()))
    def arms_down(deg=72):
        for sn, sg in (("L", 1), ("R", -1)):
            ch = limbs.get(f"hand{sn}")
            if ch:
                n = first_out(ch, False); a = math.radians(deg)
                aim(n, ch[ch.index(n):], Vector((sg * math.cos(a), 0, -math.sin(a))))
    for f in range(1, frames + 1):
        reset(); ph = 2 * math.pi * (f - 1) / 24
        arms_down()
        for sn, sg in (("L", 1), ("R", -1)):
            s_ = math.sin(ph) * sg
            ch = limbs.get(f"foot{sn}")
            if ch:
                thigh = first_out(ch, True)
                rot_world(thigh, Quaternion((1, 0, 0), math.radians(-28 * s_)))
                shin = next_of(ch, thigh)
                if shin:
                    bend = max(0, 35 * math.sin(ph + (0 if sg > 0 else math.pi) + 1.2))
                    rot_world(shin, Quaternion((1, 0, 0), math.radians(bend)))
            ha = limbs.get(f"hand{sn}")
            if ha:
                rot_world(first_out(ha, False), Quaternion((1, 0, 0), math.radians(22 * s_)))
        for pb in arm.pose.bones:
            pb.keyframe_insert("rotation_quaternion", frame=f)
    bpy.ops.object.mode_set(mode='OBJECT')
    return None

if mode == "walk":
    why = walk(frames)
    if why:
        json.dump({"ok": False, "note": why}, open(os.path.join(out, "result.json"), "w"))
        sys.exit(0)

engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
sc.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in engines else 'BLENDER_EEVEE_NEXT'
sc.view_settings.view_transform = "Standard"
sc.render.resolution_x, sc.render.resolution_y = width, height
sc.render.resolution_percentage = 100

img = sc.render.image_settings
if "media_type" in img.bl_rna.properties:
    img.media_type = 'IMAGE'
img.file_format = 'PNG'
written = []
for k in keys:
    sc.frame_set(int(k))
    name = f"key_{int(k):03d}.png"
    sc.render.filepath = os.path.join(out, name)
    bpy.ops.render.render(write_still=True)
    written.append({"frame": int(k), "file": name})

video = None
if job.get("video", mode != "still") and frames > 1:
    if "media_type" in img.bl_rna.properties:
        img.media_type = 'VIDEO'
    img.file_format = 'FFMPEG'
    ff = sc.render.ffmpeg
    ff.format = 'MPEG4'; ff.codec = 'H264'; ff.constant_rate_factor = 'HIGH'
    sc.render.filepath = os.path.join(out, "video_")
    bpy.ops.render.render(animation=True)
    made = [f for f in os.listdir(out) if f.startswith("video_") and f.endswith(".mp4")]
    if made:
        os.replace(os.path.join(out, made[0]), os.path.join(out, "video.mp4"))
        video = "video.mp4"

json.dump({
    "ok": True,
    "blender": bpy.app.version_string,
    "engine": sc.render.engine,
    "mode": mode,
    "frames": frames,
    "width": width,
    "height": height,
    "keyframes": written,
    "video": video,
    "seconds": round(time.time() - t0, 1),
}, open(os.path.join(out, "result.json"), "w"), indent=1)
print("STUDIO_RENDER_DONE")
