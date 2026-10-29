# blender -b file.blend --python tools/inspect_blend.py
import bpy
print("=== FILE", bpy.data.filepath)
def walk(c, d=0):
    print("  " * d + f"[C] {c.name} hide_render={c.hide_render}")
    for o in c.objects:
        extra = ""
        if o.type == "MESH":
            extra = f"polys={len(o.data.polygons)} mats={[m.name for m in o.data.materials if m]} keys={len(o.data.shape_keys.key_blocks) if o.data.shape_keys else 0} arm={[m.object.name for m in o.modifiers if m.type=='ARMATURE' and m.object]} mods={[m.type for m in o.modifiers]}"
        print("  " * (d + 1) + f"{o.type} {o.name} parent={o.parent.name if o.parent else None} {extra}")
    for ch in c.children:
        walk(ch, d + 1)
for s in bpy.data.scenes:
    print("SCENE", s.name); walk(s.collection)
for a in bpy.data.armatures:
    deform = [b.name for b in a.bones if b.use_deform]
    print(f"ARMATURE {a.name} bones={len(a.bones)} deform={len(deform)}")
    for b in a.bones:
        if b.use_deform:
            print(f"   {b.name} <- {b.parent.name if b.parent else None}")
for o in bpy.data.objects:
    if o.type == "MESH" and o.data.shape_keys:
        print("KEYS", o.name, [k.name for k in o.data.shape_keys.key_blocks][:80])
for i in bpy.data.images:
    print("IMG", i.name, i.filepath, i.size[:], "missing" if not i.has_data and i.source=='FILE' else "")
