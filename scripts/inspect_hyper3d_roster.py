"""Render and inspect downloaded Hyper3D roster candidates without modifying them.

Run with:
  blender --background --factory-startup --python scripts/inspect_hyper3d_roster.py
"""

import bpy
import bmesh
import json
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/models/hyper3d-tech-roster"
OUTPUT = ROOT / "artifacts/hyper3d-tech-roster"
OUTPUT.mkdir(parents=True, exist_ok=True)


def bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector(min(point[i] for point in points) for i in range(3))
    high = Vector(max(point[i] for point in points) for i in range(3))
    return low, high


def island_sizes(mesh):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    unseen = set(bm.verts)
    sizes = []
    while unseen:
        seed = unseen.pop()
        stack = [seed]
        size = 1
        while stack:
            vertex = stack.pop()
            for edge in vertex.link_edges:
                other = edge.other_vert(vertex)
                if other in unseen:
                    unseen.remove(other)
                    stack.append(other)
                    size += 1
        if size >= 10:
            sizes.append(size)
    bm.free()
    return sorted(sizes, reverse=True)


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 960
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.world.color = (0.055, 0.065, 0.08)
scene.view_settings.look = "AgX - Medium High Contrast"

floor_material = bpy.data.materials.new("Review floor")
floor_material.diffuse_color = (0.06, 0.075, 0.09, 1)
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.015))
floor = bpy.context.object
floor.data.materials.append(floor_material)

for location, energy, size in [
    ((4, -5, 7), 1200, 5),
    ((-5, -1, 4), 850, 4),
    ((1, 6, 6), 1500, 4),
]:
    bpy.ops.object.light_add(type="AREA", location=location)
    light = bpy.context.object
    light.data.energy = energy
    light.data.shape = "DISK"
    light.data.size = size
    light.rotation_euler = (Vector((0, 0, 0.65)) - light.location).to_track_quat("-Z", "Y").to_euler()

bpy.ops.object.camera_add()
camera = bpy.context.object
camera.data.type = "ORTHO"
camera.data.ortho_scale = 3.4
scene.camera = camera

records = []
for source in sorted(SOURCE.glob("*-pbr.glb")):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(source))
    imported = list(set(bpy.data.objects) - before)
    meshes = [obj for obj in imported if obj.type == "MESH"]
    low, high = bounds(meshes)
    center = (low + high) * 0.5
    for obj in imported:
        obj.location += Vector((-center.x, -center.y, -low.z))
    bpy.context.view_layer.update()
    low, high = bounds(meshes)

    texture_sizes = set()
    for obj in meshes:
        for material in obj.data.materials:
            if material and material.use_nodes:
                for node in material.node_tree.nodes:
                    if node.type == "TEX_IMAGE" and node.image:
                        texture_sizes.add(tuple(node.image.size))

    record = {
        "asset": source.stem.removesuffix("-pbr"),
        "file": str(source.relative_to(ROOT)),
        "bytes": source.stat().st_size,
        "dimensions_blender_xyz": [round(value, 5) for value in (high - low)],
        "triangles": sum(len(poly.vertices) - 2 for obj in meshes for poly in obj.data.polygons),
        "mesh_objects": len(meshes),
        "materials": sum(len(obj.data.materials) for obj in meshes),
        "texture_sizes": [list(size) for size in sorted(texture_sizes)],
        "connected_islands": [island_sizes(obj.data) for obj in meshes],
    }
    records.append(record)

    target = Vector((0, 0, min(0.62, (high.z - low.z) * 0.48)))
    for view, location in [
        ("front", (3.2, -5.4, 2.55)),
        ("rear", (-3.2, 5.4, 2.45)),
    ]:
        camera.location = location
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(OUTPUT / f"{record['asset']}-{view}.png")
        bpy.ops.render.render(write_still=True)

    bpy.data.objects.remove(imported[0], do_unlink=True)
    for obj in imported[1:]:
        if obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)

(OUTPUT / "intake.json").write_text(json.dumps(records, indent=2) + "\n")
print("HYPER3D_ROSTER_INTAKE", json.dumps(records))
