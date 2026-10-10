# Tinysolver Studio — headless Blender render (embedded by studio_render.rs;
# the same file runs on every OS).
#   blender -b -P studio_render.py -- <job.json>
# job: { model, out, mode: turntable|still|walk, frames, width, height,
#        cam_dist, yaw, pitch, keyframes: [frame…], video: bool }
#   or { mode: "set", out, set, camera, fps, start, frames, width, height,
#        keyframes, video } — a film set document (studio_set.rs, its models
#        given as absolute `model` paths) filmed through one of its cameras.
# Writes <out>/key_NNN.png per keyframe, <out>/video.mp4 when video, and
# <out>/result.json. One-model recipe from the 2026-10-07 measurement
# (handoff 3d-pose-bench turntable.py): height 2 on a ground plate, three
# area lights, a bright world, a camera on a pivot.
import bpy, math, sys, os, json, time
from mathutils import Vector, Matrix, Euler, Quaternion

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
t0 = time.time()
out = job["out"]
mode = job.get("mode", "turntable")
frames = max(1, int(job.get("frames", 72)))
width, height = int(job.get("width", 720)), int(job.get("height", 720))
keys = [k for k in job.get("keyframes", [1]) if 1 <= int(k) <= frames] or [1]
warnings = []
os.makedirs(out, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
sc = bpy.context.scene


def give_up(note):
    json.dump({"ok": False, "note": note}, open(os.path.join(out, "result.json"), "w"))
    sys.exit(0)


def import_model(path):
    """Import a GLB/FBX; the new top-level objects and all new objects."""
    before = set(o.name for o in sc.objects)
    if path.lower().endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in sc.objects if o.name not in before]
    # The glTF importer adds a mesh to draw bones with (an Icosphere at unit
    # size); it is not part of the model and would skew the framing.
    shapes = set()
    for arm in [o for o in new if o.type == 'ARMATURE']:
        for pb in arm.pose.bones:
            if pb.custom_shape is not None:
                shapes.add(pb.custom_shape.name)
                pb.custom_shape = None
    new = [o for o in new if o.name not in shapes]
    for name in shapes:
        if name in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[name])
    return new


def bounds(objs):
    """World bounds of the evaluated meshes: a skinned mesh's bound_box can
    be far off its pose."""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
    for o in objs:
        if o.type != 'MESH':
            continue
        e = o.evaluated_get(dg); me = e.to_mesh()
        for v in me.vertices:
            w = e.matrix_world @ v.co
            mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
        e.to_mesh_clear()
    return mn, mx


def fit(objs, name, tall=None, scale=None):
    """Parent `objs` under holder → fit: the footprint's middle at the
    holder's origin, standing on it, `tall` metres high (else `scale`)."""
    holder = bpy.data.objects.new(name, None); sc.collection.objects.link(holder)
    inner = bpy.data.objects.new(name + "_fit", None); sc.collection.objects.link(inner)
    inner.parent = holder
    mn, mx = bounds(objs)
    for o in objs:
        if o.parent is None:
            o.parent = inner
    if mx.z < mn.z:
        return holder
    s = (tall / max(mx.z - mn.z, 1e-6)) if tall else (scale or 1.0)
    ctr = (mn + mx) / 2
    inner.scale = (s, s, s)
    inner.location = (-ctr.x * s, -ctr.y * s, -mn.z * s)
    return holder


def material(rgb):
    m = bpy.data.materials.new("m"); m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
    return m


def area_light(loc, energy, size, target=(0, 0, 0), color=(1, 1, 1), kind='AREA', name="area"):
    d = bpy.data.lights.new(name, kind); d.energy = energy; d.color = color
    if kind == 'AREA':
        d.size = size
    o = bpy.data.objects.new(name, d); o.location = loc
    sc.collection.objects.link(o)
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return o


# ── walk: a procedural 1-second stride on a rigged model (model-pick
# bench/rig rigeval.py, 2026-10-08). Limbs are found by shape, not bone
# names (every auto-rigger names them differently): the outermost high leaf
# is a hand, the lowest leaf a foot, each chain walked back to the body.
def walk(frames, scope=None):
    from mathutils import Matrix, Quaternion
    arms_ = [o for o in (scope or sc.objects) if o.type == 'ARMATURE']
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


def one_model():
    """One material on a ground plate, the camera on a pivot around it."""
    model = job["model"]
    cam_dist = float(job.get("cam_dist", 6.2))
    yaw, pitch = float(job.get("yaw", 0)), float(job.get("pitch", 8))
    new = import_model(model)
    objs = [o for o in new if o.type == 'MESH']
    if not objs:
        give_up("The model has no mesh.")
    # Centred, standing on the ground, height 2.
    fit(new, "root", tall=2.0)

    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.object.data.materials.append(material((0.93, 0.9, 0.86)))
    area_light((3, -3, 4), 600, 3); area_light((-4, -1, 2.5), 200, 4); area_light((0, 4, 3), 300, 3)
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
    if mode == "walk":
        why = walk(frames)
        if why:
            give_up(why)


# ── film set: the document's space is metres, Y up (glTF); Blender is Z up.
C = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))


def B(v):
    return Vector((v[0], -v[2], v[1]))


def rot_b(r):
    """XYZ Euler degrees in the document's frame → a Blender rotation."""
    return (C @ Euler([math.radians(x) for x in r], 'XYZ').to_matrix() @ C.inverted()).to_euler('XYZ')


def linear(hex_):
    h = hex_.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def sample(item, t):
    """studio_set::sample — the same rule the 3D view uses."""
    ks = item.get("keys") or []
    if not ks:
        return None
    j = next((i for i, k in enumerate(ks) if k["t"] > t), None)
    if j == 0:
        a = b = ks[0]; u = 0.0
    elif j is None:
        a = b = ks[-1]; u = 0.0
    else:
        a, b = ks[j - 1], ks[j]
        span = b["t"] - a["t"]
        u = (t - a["t"]) / span if span > 0 else 0.0
        if item.get("ease") != "linear":
            u = u * u * (3 - 2 * u)
    lerp = lambda p, q: [p[i] + (q[i] - p[i]) * u for i in range(3)]
    s = {"position": lerp(a["position"], b["position"])}
    if "target" in a:
        s["target"] = lerp(a["target"], b["target"])
        s["roll"] = a.get("roll", 0) + (b.get("roll", 0) - a.get("roll", 0)) * u
    base = (item.get("rotation") or [0, 0, 0])[1]
    s["yaw"] = a.get("yaw", base) + (b.get("yaw", base) - a.get("yaw", base)) * u
    return s


def film_set():
    st = job["set"]
    fps = float(job.get("fps", st.get("fps", 24)))
    start = float(job.get("start", 0))
    at = lambda f: start + (f - 1) / fps
    sc.frame_start, sc.frame_end = 1, frames
    sc.render.fps = int(round(fps))
    stage = st.get("stage") or {}

    world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (*linear(stage.get("background", "#ebe6de")), 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = float(stage.get("ambient", 0.6))
    floor = stage.get("floor")
    if floor:
        bpy.ops.mesh.primitive_plane_add(size=float(floor.get("size", 30)))
        bpy.context.object.name = "floor"
        bpy.context.object.data.materials.append(material(linear(floor.get("color", "#d9d2c5"))))

    kinds = {"sun": 'SUN', "point": 'POINT', "spot": 'SPOT', "area": 'AREA'}
    for L in st.get("lights", []):
        area_light(B(L["position"]), float(L.get("power", 500)), float(L.get("size", 2)),
                   target=B(L.get("target", [0, 1, 0])), color=linear(L.get("color", "#ffffff")),
                   kind=kinds.get(L.get("type"), 'AREA'), name=L["id"])

    for kind in ("props", "actors"):
        for item in st.get(kind, []):
            tall = item.get("height") or (1.7 if kind == "actors" and not item.get("scale") else None)
            path = item.get("model")
            if path and os.path.isfile(path):
                new = import_model(path)
            else:
                warnings.append(f"{item['id']}: material `{item.get('asset')}` has no model file — drawn as a box")
                if kind == "actors":
                    bpy.ops.mesh.primitive_cylinder_add(radius=0.25, depth=1)
                else:
                    bpy.ops.mesh.primitive_cube_add(size=1)
                new = [bpy.context.object]
                new[0].data.materials.append(material((0.75, 0.7, 0.62)))
            holder = fit(new, item["id"], tall=tall, scale=item.get("scale"))
            if kind == "actors" and item.get("motion") == "walk":
                why = walk(frames, scope=new)
                if why:
                    warnings.append(f"{item['id']}: {why}")
            rot = list(item.get("rotation") or [0, 0, 0])
            if item.get("keys"):
                holder.rotation_mode = 'XYZ'
                for f in range(1, frames + 1):
                    s = sample(item, at(f))
                    holder.location = B(s["position"])
                    holder.rotation_euler = rot_b([rot[0], s["yaw"], rot[2]])
                    holder.keyframe_insert("location", frame=f)
                    holder.keyframe_insert("rotation_euler", frame=f)
            else:
                holder.location = B(item.get("position", [0, 0, 0]))
                holder.rotation_euler = rot_b(rot)

    spec = next(c for c in st["cameras"] if c["id"] == job["camera"])
    cam_d = bpy.data.cameras.new(spec["id"])
    cam_d.lens = float(spec.get("lens", 35)); cam_d.sensor_width = 36; cam_d.sensor_fit = 'AUTO'
    cam_d.clip_start = 0.05; cam_d.clip_end = 2000
    cam = bpy.data.objects.new(spec["id"], cam_d); sc.collection.objects.link(cam)
    cam.rotation_mode = 'QUATERNION'
    sc.camera = cam
    for f in range(1, frames + 1):
        s = sample(spec, at(f))
        loc = B(s["position"])
        look = B(s["target"]) - loc
        q = look.to_track_quat('-Z', 'Y') if look.length > 1e-9 else Quaternion()
        if s.get("roll"):
            q = q @ Quaternion((0, 0, 1), math.radians(s["roll"]))
        cam.location = loc; cam.rotation_quaternion = q
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_quaternion", frame=f)


if mode == "set":
    film_set()
else:
    one_model()

engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
sc.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in engines else 'BLENDER_EEVEE_NEXT'
# One material: true colours. A film set: AgX, so a lit floor near the key
# light rolls off instead of clipping to white (measured 2026-10-10).
sc.view_settings.view_transform = "Standard"
if mode == "set":
    for vt in ("AgX", "Filmic"):  # AgX from Blender 4.0, Filmic before
        try:
            sc.view_settings.view_transform = vt
            break
        except TypeError:
            pass
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
    "warnings": warnings,
}, open(os.path.join(out, "result.json"), "w"), indent=1)
print("STUDIO_RENDER_DONE")
