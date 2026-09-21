"""Build lightweight runtime GLBs from retained Hyper3D shaded sources."""

import bpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/models/hyper3d-tech-roster"
OUTPUT = SOURCE / "runtime"
OUTPUT.mkdir(parents=True, exist_ok=True)


def clear_import(objects):
    for obj in objects:
        if obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)
    for material in list(bpy.data.materials):
        if material.users == 0:
            bpy.data.materials.remove(material)
    for image in list(bpy.data.images):
        if image.users == 0:
            bpy.data.images.remove(image)


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

for source in sorted(SOURCE.glob("*-shaded.glb")):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(source))
    imported = list(set(bpy.data.objects) - before)
    meshes = [obj for obj in imported if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh in {source}")

    for obj in imported:
        obj.name = source.stem.removesuffix("-shaded")
    images = set()
    for obj in meshes:
        for material in obj.data.materials:
            if not material or not material.use_nodes:
                continue
            for node in material.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image:
                    images.add(node.image)
    for image in images:
        if max(image.size) > 1024:
            ratio = 1024 / max(image.size)
            image.scale(round(image.size[0] * ratio), round(image.size[1] * ratio))
        image.pack()

    bpy.ops.object.select_all(action="DESELECT")
    for obj in imported:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    target = OUTPUT / f"{source.stem.removesuffix('-shaded')}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(target),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_animations=False,
        export_image_format="JPEG",
        export_jpeg_quality=84,
        export_materials="EXPORT",
    )
    print("RUNTIME_GLTF", target.name, target.stat().st_size)
    clear_import(imported)
