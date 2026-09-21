import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';

// Candidates are deliberately NOT imported by app.mjs. These gates cover the
// portable static assets only; they do not certify rigging or phone performance.
function readGlb(kind, collection = 'hyper3d-2026-09-19', prefix = 'crimson') {
  const bytes = readFileSync(new URL(`../assets/models/${collection}/${prefix}-${kind}-candidate.glb`, import.meta.url));
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const end = 20 + bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8', 20, end));
  assert.equal(bytes.readUInt32LE(end + 4), 0x004e4942);
  return { bytes, json, binary: bytes.subarray(end + 8) };
}

function imageSize(bytes) {
  if (bytes.toString('ascii', 1, 4) === 'PNG') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'PNG or JPEG texture expected');
  for (let offset = 2; offset < bytes.length;) {
    assert.equal(bytes[offset++], 0xff, 'valid JPEG marker');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    const length = bytes.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    assert.ok(length >= 2, 'valid JPEG segment');
    offset += length;
  }
  assert.fail('JPEG dimensions missing');
}

for (const [kind, limit, collection, prefix, byteLimit] of [
  ['kart', 10000, 'hyper3d-2026-09-19', 'crimson', 1_200_000],
  ['driver', 6000, 'hyper3d-2026-09-19', 'crimson', 1_200_000],
  ['kart', 18000, 'tin-panda-2026-09-19', 'tin-panda', 1_500_000],
  ['driver', 10000, 'tin-panda-2026-09-19', 'tin-panda', 700_000],
  ['kart', 18000, 'pumpkin-capybara-2026-09-20', 'pumpkin-capybara', 1_500_000],
  ['driver', 10000, 'pumpkin-capybara-2026-09-20', 'pumpkin-capybara', 700_000],
  ['kart', 18000, 'shell-axolotl-2026-09-20', 'shell-axolotl', 1_500_000],
  ['driver', 10000, 'shell-axolotl-2026-09-20', 'shell-axolotl', 700_000],
]) {
  test(`${prefix} ${kind} candidate is embedded, bounded and within its static asset budget`, () => {
    const { bytes, json, binary } = readGlb(kind, collection, prefix);
    assert.ok(bytes.length < byteLimit, `candidate must remain below ${byteLimit} bytes`);
    assert.ok(json.buffers.every(buffer => !buffer.uri), 'no external buffer dependency');
    assert.equal(json.materials.length, 1);
    assert.equal(json.meshes.length, 1);
    let triangles = 0;
    for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
      assert.equal(primitive.mode ?? 4, 4, 'triangle topology');
      triangles += json.accessors[primitive.indices].count / 3;
    }
    assert.ok(triangles > 0 && triangles <= limit, 'triangle budget');
    assert.equal(json.images.length, 3, 'base color, normal and packed metallic/roughness');
    for (const image of json.images) {
      assert.equal(image.uri, undefined, 'no expiring texture URL');
      const view = json.bufferViews[image.bufferView];
      const start = view.byteOffset ?? 0;
      const dimensions = imageSize(binary.subarray(start, start + view.byteLength));
      assert.ok(dimensions.every(size => size > 0 && size <= 1024), 'texture size budget');
    }
    const box = new Box3();
    function visit(index, parent) {
      const node = json.nodes[index];
      const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
        new Vector3().fromArray(node.translation ?? [0, 0, 0]),
        new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
        new Vector3().fromArray(node.scale ?? [1, 1, 1]));
      const world = parent.clone().multiply(local);
      if (node.mesh !== undefined) for (const p of json.meshes[node.mesh].primitives) {
        const a = json.accessors[p.attributes.POSITION];
        box.union(new Box3(new Vector3().fromArray(a.min), new Vector3().fromArray(a.max)).applyMatrix4(world));
      }
      for (const child of node.children ?? []) visit(child, world);
    }
    for (const root of json.scenes[json.scene ?? 0].nodes) visit(root, new Matrix4());
    const center = box.getCenter(new Vector3()), size = box.getSize(new Vector3());
    assert.ok(Math.abs(box.min.y) < 0.0001, 'ground-level Y-up pivot');
    assert.ok(Math.abs(center.x) < 0.0001 && Math.abs(center.z) < 0.0001, 'centered footprint');
    assert.ok(Math.abs((kind === 'kart' ? size.z : size.y) - (kind === 'kart' ? 3.9 : 2.25)) < 0.001, 'normalized length/height');
    assert.equal(json.skins?.length ?? 0, 0, 'static candidate must not pretend to be rigged');
  });
}

test('split kart preserves geometry budget and exposes independent centered wheel pivots', () => {
  const { bytes, json } = readGlb('kart-parts');
  assert.ok(bytes.length < 1_200_000);
  assert.equal(json.materials.length, 1, 'all eight parts share one atlas material');
  assert.equal(json.meshes.length, 8, 'body, four wheels, wing and two exhausts');
  assert.equal(json.meshes.reduce((total, m) => total + m.primitives.reduce((s, p) => s + json.accessors[p.indices].count / 3, 0), 0), 10000);
  assert.ok(json.nodes.some(n => n.name === 'KartVisualRoot'));
  for (const axle of ['front', 'rear']) for (const side of ['xpos', 'xneg']) {
    const index = json.nodes.findIndex(n => n.name === `wheel_${axle}_${side}`);
    assert.ok(index >= 0, 'wheel is independently addressable');
    const node = json.nodes[index];
    for (const p of json.meshes[node.mesh].primitives) {
      const a = json.accessors[p.attributes.POSITION];
      assert.ok(a.min.every((v, axis) => Math.abs(v + a.max[axis]) < 0.0001), 'spin pivot is at wheel center');
    }
    if (axle === 'front') {
      const steer = json.nodes.find(n => n.name === `steer_front_${side}`);
      assert.deepEqual(steer?.children, [index], 'steering parent is separate from wheel spin');
    }
  }
});
