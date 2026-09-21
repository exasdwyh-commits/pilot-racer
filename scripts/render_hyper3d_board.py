"""Re-import exported candidate GLBs to verify the deliverable, not the source."""
import bpy
import argparse
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--collection', default='hyper3d-2026-09-19')
parser.add_argument('--prefix', default='crimson')
parser.add_argument('--kart-kind', default='kart-parts', choices=['kart', 'kart-parts'])
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
ASSETS = ROOT / 'assets/models' / args.collection
OUTPUT = ROOT / 'artifacts' / args.collection / 'candidates-board.png'
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for kind, location in [(args.kart_kind, (-1.05, 0, 0)), ('driver', (1.85, 0.2, 0))]:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(ASSETS / f'{args.prefix}-{kind}-candidate.glb'))
    for obj in set(bpy.data.objects) - before:
        if obj.parent is None:
            obj.location += Vector(location)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'AgX'
scene.world.color = (0.22, 0.22, 0.22)
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.012))
floor = bpy.context.object
material = bpy.data.materials.new('Slate review floor')
material.use_nodes = True
shader = material.node_tree.nodes.get('Principled BSDF')
shader.inputs['Base Color'].default_value = (0.055, 0.085, 0.11, 1)
shader.inputs['Roughness'].default_value = 0.78
floor.data.materials.append(material)
for location, energy, size in [((0, -4, 6), 950, 5), ((-4, 0, 4), 650, 4), ((3, 4, 5), 1200, 3)]:
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.data.energy = energy
    light.data.shape = 'DISK'
    light.data.size = size
    light.rotation_euler = (Vector((0, 0, 0.7)) - light.location).to_track_quat('-Z', 'Y').to_euler()
bpy.ops.object.camera_add(location=(5.2, -9, 4.6))
camera = bpy.context.object
camera.rotation_euler = (Vector((0.2, 0, 0.95)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 6.9
scene.camera = camera
scene.render.filepath = str(OUTPUT)
bpy.ops.render.render(write_still=True)
