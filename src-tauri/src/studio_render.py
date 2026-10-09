# Tinysolver Studio — headless Blender render of one model material
# (embedded by studio_render.rs; the same file runs on every OS).
#   blender -b -P studio_render.py -- <job.json>
# job: { model, out, mode: turntable|still, frames, width, height,
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
objs = [o for o in sc.objects if o.type == 'MESH']
if not objs:
    json.dump({"ok": False, "note": "The model has no mesh."}, open(os.path.join(out, "result.json"), "w"))
    sys.exit(0)
# Bounds → centred, standing on the ground, height 2.
bpy.context.view_layer.update()
mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
for o in objs:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
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
if job.get("video", mode == "turntable") and frames > 1:
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
