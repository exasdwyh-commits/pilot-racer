"""Offline candidate intake; never modifies source GLBs or the live game.

Run with Blender --background --factory-startup --python this_file.py.
Coordinates below are Blender Z-up; GLB exports remain Y-up, +Z forward.
"""
import bpy
import bmesh
import json
import math
import argparse
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--collection', default='hyper3d-2026-09-19')
parser.add_argument('--prefix', default='crimson')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
ASSETS = ROOT / 'assets/models' / args.collection
REPORT = ROOT / 'artifacts' / args.collection
REPORT.mkdir(exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
records = []
models = {}

def bounds(objects):
    points = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
    low = Vector([min(p[i] for p in points) for i in range(3)])
    high = Vector([max(p[i] for p in points) for i in range(3)])
    return low, high

def islands(mesh):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00001)
    unseen = set(bm.verts)
    result = []
    while unseen:
        seed = unseen.pop()
        part, stack = [seed], [seed]
        while stack:
            v = stack.pop()
            for e in v.link_edges:
                other = e.other_vert(v)
                if other in unseen:
                    unseen.remove(other)
                    part.append(other)
                    stack.append(other)
        if len(part) >= 10:
            result.append({"vertices": len(part), "min": [min(v.co[i] for v in part) for i in range(3)], "max": [max(v.co[i] for v in part) for i in range(3)]})
    bm.free()
    return sorted(result, key=lambda x: -x['vertices'])

specs = [('kart', 3.9, 1), ('driver', 2.25, 2)]
if args.prefix == 'crimson' and (ASSETS / 'source/crimson-kart-parts-raw.glb').exists():
    specs.append(('kart-parts', 3.9, 1))
for kind, target, axis in specs:
    bpy.ops.object.select_all(action='DESELECT')
    before = set(bpy.data.objects)
    source = ASSETS / f'source/{args.prefix}-{kind}-raw.glb'
    bpy.ops.import_scene.gltf(filepath=str(source))
    imported = list(set(bpy.data.objects) - before)
    meshes = [o for o in imported if o.type == 'MESH']
    low, high = bounds(meshes)
    factor = target / (high - low)[axis]
    center = (low + high) * 0.5
    images = set()
    names = {
        'root.0': 'kart_body', 'root.1': 'wheel_front_xpos',
        'root.2': 'wheel_front_xneg', 'root.3': 'wheel_rear_xpos',
        'root.4': 'wheel_rear_xneg', 'root.5': 'rear_wing',
        'root.6': 'exhaust_xpos', 'root.7': 'exhaust_xneg',
    }
    for obj in meshes:
        for mat in obj.data.materials:
            if mat and mat.use_nodes:
                images.update(n.image for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
    record = {"asset": kind, "source_bytes": source.stat().st_size, "source_dimensions_blender": list(high-low), "scale": factor, "textures": [{"name": im.name, "source_size": list(im.size)} for im in images], "meshes": [], "rigged": False, "animations": []}
    for obj in meshes:
        record['meshes'].append({"name": obj.name, "triangles": sum(len(p.vertices)-2 for p in obj.data.polygons), "materials": len(obj.data.materials), "welded_islands": islands(obj.data)})
        # Bake importer transforms before normalization, preserving normals and UVs.
        transform = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world.identity()
        obj.data.transform(transform)
        for v in obj.data.vertices:
            v.co = (v.co - Vector((center.x, center.y, low.z))) * factor
        obj.name = names[obj.name] if kind == 'kart-parts' else f'{args.prefix}_{kind}_candidate'
        obj.data.update()
    for im in images:
        if max(im.size) > 1024:
            ratio = 1024 / max(im.size)
            im.scale(round(im.size[0]*ratio), round(im.size[1]*ratio))
            im.pack()
    export_objects = list(meshes)
    if kind == 'kart-parts':
        root = bpy.data.objects.new('KartVisualRoot', None)
        bpy.context.collection.objects.link(root)
        export_objects.append(root)
        # BANG emits eight identical materials using the same atlas. Sharing
        # that atlas avoids redundant material instances, not the eight draws.
        shared_material = meshes[0].data.materials[0]
        for obj in meshes:
            obj.data.materials.clear()
            obj.data.materials.append(shared_material)
            obj.parent = root
            if obj.name.startswith('wheel_'):
                points = [v.co for v in obj.data.vertices]
                low = Vector([min(p[i] for p in points) for i in range(3)])
                high = Vector([max(p[i] for p in points) for i in range(3)])
                pivot = (low + high) * 0.5
                for v in obj.data.vertices:
                    v.co -= pivot
                obj.location = pivot
                obj.location.z -= low.z  # All four tires touch the same plane.
                if obj.name.startswith('wheel_front_'):
                    steer = bpy.data.objects.new(obj.name.replace('wheel_', 'steer_'), None)
                    bpy.context.collection.objects.link(steer)
                    steer.parent = root
                    steer.location = obj.location.copy()
                    obj.parent = steer
                    obj.location = (0, 0, 0)
                    export_objects.append(steer)
            elif obj.name == 'rear_wing':
                pivot = sum((v.co for v in obj.data.vertices), Vector()) / len(obj.data.vertices)
                for v in obj.data.vertices:
                    v.co -= pivot
                obj.location = pivot
        record['articulation'] = 'Four wheel-center pivots, two front steering groups, wing pivot; no baked animation.'
    bpy.ops.object.select_all(action='DESELECT')
    for obj in export_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    output = ASSETS / f'{args.prefix}-{kind}-candidate.glb'
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True, export_yup=True, export_animations=False, export_image_format='JPEG', export_jpeg_quality=85)
    record['candidate_bytes'] = output.stat().st_size
    bpy.context.view_layer.update()
    low, high = bounds(meshes)
    record['candidate_dimensions_blender'] = list(high-low)
    record['candidate_texture_max'] = 1024
    records.append(record)
    models[kind] = meshes

(REPORT / 'intake.json').write_text(json.dumps(records, indent=2) + '\n')

# Render the actual imported geometry, not a concept-image approximation.
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 1440
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.world.color = (0.25, 0.25, 0.25)
scene.view_settings.view_transform = 'AgX'
ground_mat = bpy.data.materials.new('Review floor')
ground_mat.diffuse_color = (0.115, 0.15, 0.17, 1)
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.015))
floor = bpy.context.object
floor.data.materials.append(ground_mat)
for location, power, size in [((1, -4, 7), 1400, 5), ((-4, -1, 4), 900, 4), ((2, 5, 6), 1800, 4)]:
    bpy.ops.object.light_add(type='AREA', location=location)
    lamp = bpy.context.object
    lamp.data.energy = power
    lamp.data.shape = 'DISK'
    lamp.data.size = size
    lamp.rotation_euler = (Vector((0, 0, 0.7)) - lamp.location).to_track_quat('-Z', 'Y').to_euler()
bpy.ops.object.camera_add()
camera = bpy.context.object
camera.data.type = 'ORTHO'
scene.camera = camera
for kind, meshes in models.items():
    for other_kind, objects in models.items():
        for obj in objects:
            obj.hide_render = other_kind != kind
    height = 0.6 if kind.startswith('kart') else 1.08
    camera.data.ortho_scale = 5.7 if kind.startswith('kart') else 4.1
    for view, location in [('front', (4, -6, 3.6)), ('rear', (-4, 6, 3.4)), ('side', (7, 0, 2.8))]:
        camera.location = location
        camera.rotation_euler = (Vector((0, 0, height)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(REPORT / f'{kind}-{view}.png')
        bpy.ops.render.render(write_still=True)
    if kind == 'kart-parts':
        for obj in meshes:
            if obj.name.startswith('wheel_front_'):
                obj.parent.rotation_euler.z = math.radians(22)
        camera.location = (4, -6, 3.6)
        camera.rotation_euler = (Vector((0, 0, height)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(REPORT / 'kart-parts-steering.png')
        bpy.ops.render.render(write_still=True)
print('CANDIDATE_INTAKE', json.dumps(records))
