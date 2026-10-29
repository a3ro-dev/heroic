# Converts a rigged .blend into a realtime-friendly .glb for Heroic.
#   blender -b model.blend --python tools/export_hero.py -- out.glb [LOD collection name]
#
# What it does, in order:
#  1. picks the skinned meshes to ship (one LOD if the file has LOD collections)
#  2. copies the armature, strips every non-deform bone and reparents each deform bone to its
#     nearest deform ancestor, so control rigs (CloudRig, Rigify) export as a plain skeleton
#  3. drops modifiers other than Armature (subsurf, cloth, smoothing don't survive realtime)
#  4. exports a GLB; tools/build_heroes.mjs then shrinks textures and compresses geometry
import bpy
import re
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
out_path = argv[0]
lod_name = argv[1] if len(argv) > 1 else "LOD1"

scene = bpy.context.scene
lod_cols = [c for c in bpy.data.collections if c.name.upper().startswith("LOD")]


def in_wrong_lod(obj):
    return lod_cols and any(obj.name in c.objects for c in lod_cols if c.name != lod_name)


def unhide(lc):
    lc.exclude = False
    lc.hide_viewport = False
    lc.collection.hide_viewport = False
    lc.collection.hide_select = False
    for ch in lc.children:
        unhide(ch)


unhide(bpy.context.view_layer.layer_collection)

meshes = []
for o in scene.objects:
    if o.type != "MESH" or in_wrong_lod(o):
        continue
    arm_mods = [m for m in o.modifiers if m.type == "ARMATURE" and m.object]
    if arm_mods:
        meshes.append((o, arm_mods[0].object))
if not meshes:
    sys.exit("no skinned meshes found")
src_arm = meshes[0][1]
print("exporting", [m.name for m, _ in meshes], "with", src_arm.name)

# Copy the armature and reduce it to deform bones.
arm = src_arm.copy()
arm.data = src_arm.data.copy()
arm.name = "Heroic_Rig"
arm.animation_data_clear()
arm.data.animation_data_clear()
scene.collection.objects.link(arm)
for pb in arm.pose.bones:
    for c in list(pb.constraints):
        pb.constraints.remove(c)
    pb.matrix_basis.identity()

bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = arm
arm.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
ebones = arm.data.edit_bones
deform = {b.name for b in arm.data.bones if b.use_deform}
PREFIX = re.compile(r"^(STR|MCH|ORG|CTR|CTRL|TGT|IK|FK|P|ROT|DEF|TWK)(-I)?[-_.]", re.I)


def base(name):
    while PREFIX.match(name):
        name = PREFIX.sub("", name, count=1)
    return name


def_by_base = {base(n): n for n in deform}


def would_cycle(child, parent, parents):
    p = parent
    while p:
        if p == child:
            return True
        p = parents.get(p)
    return False


# Control rigs parent DEF bones under STR/MCH helpers, and CloudRig's "P-" helpers get their real
# parent from an Armature/Child Of constraint rather than the hierarchy. Follow that logical chain
# and take the first ancestor that is, or names, a deform bone ("STR-Head" -> "DEF-Head").
def logical_parent(name):
    pb = src_arm.pose.bones.get(name)
    if pb:
        for c in pb.constraints:
            if c.mute:
                continue
            if c.type == "ARMATURE" and len(c.targets):
                t = max(c.targets, key=lambda t: t.weight)
                if t.target == src_arm and t.subtarget:
                    return t.subtarget
            if c.type in ("CHILD_OF", "COPY_TRANSFORMS") and c.target == src_arm and c.subtarget:
                return c.subtarget
    b = src_arm.data.bones[name]
    return b.parent.name if b.parent else None


parents = {}
for name in deform:
    p = logical_parent(name)
    found, seen = None, set()
    while p and p not in seen:
        seen.add(p)
        cand = p if p in deform else def_by_base.get(base(p))
        if cand and cand != name and not would_cycle(name, cand, parents):
            found = cand
            break
        p = logical_parent(p)
    parents[name] = found

# Still floating (bones parented straight to the rig root): keep the one with the most
# descendants as the root and attach the rest to the nearest deform joint.
def is_under(o, n):
    p = parents.get(o)
    while p:
        if p == n:
            return True
        p = parents.get(p)
    return False


roots = [n for n in deform if not parents[n]]
root = max(roots, key=lambda n: sum(1 for o in deform if is_under(o, n)))
for name in roots:
    if name == root:
        continue
    head = ebones[name].head
    best, dist = None, float("inf")
    for other in deform:
        if other == name or is_under(other, name):
            continue
        d = min((ebones[other].tail - head).length, (ebones[other].head - head).length)
        if d < dist:
            best, dist = other, d
    parents[name] = best

for name, p in parents.items():
    eb = ebones[name]
    eb.use_connect = False
    eb.parent = ebones[p] if p else None
print("deform roots:", [n for n, p in parents.items() if not p])
for eb in list(ebones):
    if eb.name not in deform:
        ebones.remove(eb)
bpy.ops.object.mode_set(mode="OBJECT")
arm.data.pose_position = "POSE"

# Point the meshes at the clean rig and drop non-realtime modifiers.
for o, _ in meshes:
    for m in list(o.modifiers):
        if m.type == "ARMATURE":
            m.object = arm
        else:
            o.modifiers.remove(m)
    if o.parent == src_arm:
        mw = o.matrix_world.copy()
        o.parent = arm
        o.matrix_world = mw


ROLES = [  # first match wins; detail maps (pores, dirt, reflection) are skipped
    ("skip", r"pore|dirt|reflection|lightmap"),
    ("emission", r"emis|(^|[_ ])e$|\de$"),
    ("normal", r"(_n|normal|norm|nrm)$|_n_|lod\d_n"),
    ("roughness", r"(_r|rough|roughness)$"),
    ("metallic", r"(_m|metal|metallic)$"),
    ("specular", r"(_sp|spec|specular)$"),
    ("base", r"(_c|_d|diff|diffuse|basecolor|albedo|col)$|^[^_]*_\d+$|_\d+$"),
]


def role(img):
    name = re.sub(r"\.(png|jpe?g|tga|tiff?|webp)(\.\d+)?$", "", img.name.lower())
    for r, pat in ROLES:
        if re.search(pat, name):
            return r
    return None


def principled_has_image_base(nt):
    for l in nt.links:
        if l.to_node.type == "BSDF_PRINCIPLED" and l.to_socket.name == "Base Color":
            return l.from_node.type == "TEX_IMAGE"
    return False


def simplify(mat):
    """Rebuild custom shader trees as a plain Principled BSDF so glTF picks the right maps."""
    nt = mat.node_tree
    if not mat.use_nodes or principled_has_image_base(nt):
        return
    imgs = {}
    for n in nt.nodes:
        if n.type == "TEX_IMAGE" and n.image:
            r = role(n.image)
            # several LOD normal maps: keep the one for the LOD we ship
            if r and (r not in imgs or lod_name.lower() in n.image.name.lower()):
                imgs[r] = n.image
    if "base" not in imgs:
        return
    print("  rebuilding", mat.name, {k: v.name for k, v in imgs.items()})
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    def tex(img, non_color=False):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = img
        if non_color:
            img.colorspace_settings.name = "Non-Color"
        return n

    base = tex(imgs["base"])
    nt.links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    if mat.blend_method != "OPAQUE" or getattr(mat, "surface_render_method", "") == "BLENDED":
        nt.links.new(base.outputs["Alpha"], bsdf.inputs["Alpha"])
    if "normal" in imgs:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tex(imgs["normal"], True).outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if "roughness" in imgs:
        nt.links.new(tex(imgs["roughness"], True).outputs["Color"], bsdf.inputs["Roughness"])
    elif "specular" in imgs:
        bsdf.inputs["Roughness"].default_value = 0.35
    if "metallic" in imgs:
        nt.links.new(tex(imgs["metallic"], True).outputs["Color"], bsdf.inputs["Metallic"])
    if "emission" in imgs:
        nt.links.new(tex(imgs["emission"]).outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 1.0


for o, _ in meshes:
    for slot in o.material_slots:
        if slot.material:
            simplify(slot.material)

bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True)
for o, _ in meshes:
    o.hide_set(False)
    o.hide_viewport = False
    o.select_set(True)
arm.hide_set(False)

bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format="GLB",
    use_selection=True,
    export_yup=True,
    export_apply=False,
    export_skins=True,
    export_morph=True,
    export_morph_normal=False,
    export_animations=False,
    export_lights=False,
    export_cameras=False,
    export_extras=False,
)
print("wrote", out_path)
