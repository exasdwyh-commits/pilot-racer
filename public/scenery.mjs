import * as THREE from 'three';
import { trackAt, halfWidthAt, cornerCurvature, TRACK_LENGTH, currentMarks, clamp, wrap } from './simulation.mjs';

// Appearance only. No route, collision, ranking or item positions are authored here.
export const SCENERY_ZONES = Object.freeze({
  bay: [
    { from: .09, to: .16, shade: .23, name: '滨海高速段', kind: 'sails' },
    { from: .25, to: .34, shade: .28, name: '港湾发卡', kind: 'canyon' },
    { from: .405, to: .49, shade: .25, name: '跨海爬升桥', kind: 'sails' },
    { from: .665, to: .735, shade: .40, name: '岩壁隧道', kind: 'tunnel' },
    { from: .79, to: .88, shade: .24, name: '下坡连续弯', kind: 'grove' },
  ],
  ridge: [
    { from: .22, to: .36, shade: .29, name: '赤岩发卡', kind: 'canyon' },
    { from: .51, to: .62, shade: .26, name: '松林连弯', kind: 'grove' },
    { from: .68, to: .78, shade: .38, name: '山脊廊桥', kind: 'tunnel' },
  ],
});

const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
export function shadeAt(trackId, fraction) {
  const f = wrap(fraction, 1);
  let value = 0;
  for (const zone of SCENERY_ZONES[trackId] ?? []) {
    if (f < zone.from || f > zone.to) continue;
    const edge = Math.min(.014, (zone.to - zone.from) / 3);
    value = Math.max(value, zone.shade * smooth((f - zone.from) / edge) * smooth((zone.to - f) / edge));
  }
  return value;
}

export function daylightAt(state) {
  // A slow, single warm-up over the match, never a fast day/night cycle.
  const fraction = state?.phase === 'racing' || state?.phase === 'result'
    ? 1 - (state.remaining ?? 90) / Math.max(1, state.seconds ?? 90) : .18;
  return smooth(fraction) * .72;
}

export function makeDaylightRig({ sun, hemisphere, scene }) {
  const day = new THREE.Color('#fff4d5'), evening = new THREE.Color('#ffc394');
  const skyDay = new THREE.Color('#90cad8'), skyWarm = new THREE.Color('#b6c6ca');
  let blend = 0;
  return {
    update(state, dt) {
      const target = daylightAt(state);
      blend += (target - blend) * (1 - Math.exp(-Math.min(.1, Math.max(0, dt)) * .32));
      sun.color.copy(day).lerp(evening, blend);
      sun.intensity = 3.4 - blend * .55;
      // Keep the shadow direction moving by less than a degree per second.
      sun.position.set(-110 + blend * 34, 160 - blend * 28, 70 + blend * 28);
      hemisphere.intensity = 2.6 - blend * .22;
      scene.background.copy(skyDay).lerp(skyWarm, blend);
      if (scene.fog) scene.fog.color.copy(scene.background);
      return blend;
    },
  };
}

// Batch rigid duplicates by geometry/material AND a spatial cell. Dynamic parts
// are explicitly excluded. This cuts road/curb draw calls without one huge,
// always-visible instance batch covering the whole lap.
export function batchStaticScenery(root) {
  root.updateMatrixWorld(true);
  const batches = new Map();
  const position = new THREE.Vector3();
  const scan = object => {
    if (object.userData.dynamicScenery) return;
    if (object.isMesh && !object.isSkinnedMesh && !object.isInstancedMesh && !Array.isArray(object.material)) {
      object.getWorldPosition(position);
      const key = `${object.geometry.uuid}|${object.material.uuid}|${object.castShadow}|${object.receiveShadow}|${Math.floor(position.x / 65)}|${Math.floor(position.z / 65)}`;
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(object);
    }
    for (const child of object.children) scan(child);
  };
  scan(root);
  const inverse = root.matrixWorld.clone().invert(), matrix = new THREE.Matrix4();
  let removedCalls = 0;
  for (const objects of batches.values()) {
    if (objects.length < 3) continue;
    const first = objects[0], mesh = new THREE.InstancedMesh(first.geometry, first.material, objects.length);
    mesh.name = 'static-scenery-batch';
    mesh.castShadow = first.castShadow; mesh.receiveShadow = first.receiveShadow;
    objects.forEach((object, i) => {
      mesh.setMatrixAt(i, matrix.multiplyMatrices(inverse, object.matrixWorld));
      object.removeFromParent();
    });
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
    root.add(mesh); removedCalls += objects.length - 1;
  }
  return removedCalls;
}

export function buildSceneryKit(trackId, parent, { box, cylinder, board, material }) {
  const group = new THREE.Group(); group.name = `scenery-kit-${trackId}`; parent.add(group);
  const ridge = trackId === 'ridge', zones = SCENERY_ZONES[trackId] ?? [];
  const positions = Array.from({ length: 512 }, (_, i) => {
    const s = i / 512 * TRACK_LENGTH; return { ...trackAt(s), width: halfWidthAt(s) };
  });
  // Even in tight hairpins, a prop beside one segment must not overlap another.
  const clearRoad = (p, radius) => positions.every(q => Math.hypot(p.x - q.x, p.z - q.z) > q.width + radius + 2);
  const anchor = (s, lane = 0) => {
    const p = trackAt(s, lane), g = new THREE.Group();
    g.position.set(p.x, p.y, p.z); g.rotation.y = p.yaw; group.add(g); return g;
  };
  const rockGeo = new THREE.IcosahedronGeometry(1, 0), treeGeo = new THREE.ConeGeometry(1, 1, 7);
  const rocks = [], trees = [];
  for (let i = 0; i < (ridge ? 52 : 18); i++) {
    const s = (ridge ? .18 + i / 52 * .70 : .72 + i / 18 * .18) * TRACK_LENGTH;
    const side = i % 2 ? 1 : -1, lane = side * (halfWidthAt(s) + 9 + i % 4 * 3);
    const p = trackAt(s, lane), radius = ridge ? 4.5 + i % 3 : 2.8;
    if (!clearRoad(p, radius)) continue;
    const rock = new THREE.Mesh(rockGeo, material(ridge ? ['#a97759', '#c99671', '#d8b088'][i % 3] : '#c1b391'));
    rock.position.set(p.x, p.y - 1.5, p.z); rock.scale.set(radius, ridge ? 7 + i % 4 * 2 : 2.5, radius * .8);
    rock.rotation.y = i * 2.13; rock.castShadow = ridge; rock.receiveShadow = true; group.add(rock); rocks.push(rock);
  }
  if (ridge) {
    for (let i = 0; i < 52; i++) {
      const s = (.44 + i / 52 * .50) * TRACK_LENGTH, side = i % 2 ? 1 : -1;
      const p = trackAt(s, side * (halfWidthAt(s) + 10 + i % 5 * 2));
      if (!clearRoad(p, 3.8)) continue;
      cylinder(group, p.x, p.y + 1.4, p.z, .3, .45, 3.8, '#775744', 6, false);
      for (let level = 0; level < 3; level++) {
        const crown = new THREE.Mesh(treeGeo, material(level % 2 ? '#507766' : '#345d52'));
        crown.position.set(p.x, p.y + 3.2 + level * 2.0, p.z); crown.scale.set(3.8 - level * .75, 5.2 - level * .5, 3.8 - level * .75);
        crown.castShadow = i % 3 === 0; crown.receiveShadow = true; group.add(crown); trees.push(crown);
      }
    }
  } else {
    // Open-sided colored sail canopy: all posts outside the collision ribbon,
    // high roof and sparse spacing leave the next turn visible.
    for (let i = 0; i < 5; i++) {
      const s = (.15 + i * .012) * TRACK_LENGTH, hw = halfWidthAt(s), g = anchor(s);
      for (const x of [-hw - 2.4, hw + 2.4]) {
        cylinder(g, x, 4.1, 0, .16, .23, 8.2, '#f2dfbb', 6, true);
      }
      const points = new Float32Array([-hw - 2.4, 8.4, -3.6, hw + 2.4, 7.1, -3.6, hw + 2.4, 8.4, 3.6, -hw - 2.4, 7.1, 3.6]);
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(points, 3)); geo.setIndex([0, 1, 2, 0, 2, 3]); geo.computeVertexNormals();
      const sail = new THREE.Mesh(geo, material(i % 2 ? '#e89061' : '#48a6a2', { side: THREE.DoubleSide, roughness: .94 }));
      sail.castShadow = true; sail.receiveShadow = true; g.add(sail);
      box(g, -hw - 4.4, 1.2, 0, 2.4, 2.4, 4.8, i % 2 ? '#e5c887' : '#65a49a');
    }
  }
  // Three authored sector boards; they are road furniture, not new waypoints.
  for (const zone of zones) {
    const s = (zone.from - .035) * TRACK_LENGTH, hw = halfWidthAt(s), g = anchor(s);
    const side = ridge ? -1 : 1, x = side * (hw + 3.8);
    cylinder(g, x, 2.3, 0, .16, .19, 4.6, '#26434a', 6, false);
    board(g, x, 4.1, 0, 5.8, 1.6, zone.name, Math.PI, '#21474e', '#fff0c8');
  }
  // Advance corner warnings sampled from the unchanged centreline, so S bends
  // correctly flip their arrow rather than displaying a right arrow everywhere.
  const warningGeo = new THREE.PlaneGeometry(3.8, 2.1);
  let previousCorner = -100;
  for (let s = 25; s < TRACK_LENGTH - 20; s += 12) {
    const bend = cornerCurvature(s + 18);
    if (Math.abs(bend) < (ridge ? .030 : .022) || s - previousCorner < 38) continue;
    previousCorner = s;
    const side = bend > 0 ? 1 : -1, p = trackAt(s, side * (halfWidthAt(s) + 3.4));
    const g = new THREE.Group(); g.position.set(p.x, p.y, p.z); g.rotation.y = p.yaw; group.add(g);
    cylinder(g, 0, 1.6, 0, .12, .14, 3.2, '#263c43', 6, false);
    const face = board(g, 0, 3, 0, 3.8, 2.1, `${bend > 0 ? '‹' : '›'} ${Math.abs(bend) > .07 ? '急弯' : '弯道'}`, Math.PI, '#ffc756', '#342d24');
    face.geometry.dispose(); face.geometry = warningGeo;
  }
  // Broad, feathered road shade remains in low tier when shadow maps are off.
  // One vertex-color ribbon; alpha encodes zones. No extra textures/downloads.
  const shadePositions = [], shadeColors = [], shadeIndices = [];
  for (let i = 0; i <= 640; i++) {
    const f = i / 640, s = f * TRACK_LENGTH, dark = shadeAt(trackId, f);
    for (const lane of [-halfWidthAt(s), halfWidthAt(s)]) {
      const p = trackAt(s, lane); shadePositions.push(p.x, p.y + .045, p.z);
      shadeColors.push(.04, .10, .12, dark);
    }
    if (i < 640) { const a = i * 2; shadeIndices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const shadeGeo = new THREE.BufferGeometry(); shadeGeo.setAttribute('position', new THREE.Float32BufferAttribute(shadePositions, 3));
  shadeGeo.setAttribute('color', new THREE.Float32BufferAttribute(shadeColors, 4)); shadeGeo.setIndex(shadeIndices);
  const shadeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const shadeMesh = new THREE.Mesh(shadeGeo, shadeMat); shadeMesh.name = 'soft-sector-shade'; group.add(shadeMesh);
  // Geometry created for an unused family must not linger in GPU bookkeeping.
  if (!rocks.length) rockGeo.dispose(); if (!trees.length) treeGeo.dispose();
  if (previousCorner === -100) warningGeo.dispose();
  return { group, zones: zones.map(z => z.name), rocks: rocks.length, trees: trees.length };
}
