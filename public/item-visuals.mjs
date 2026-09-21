import * as THREE from 'three';
import { clamp, ITEM_BOX_RESPAWN } from './simulation.mjs';

export const ITEM_VISUALS = Object.freeze({
  missile: { color: '#ff9167', hint: '瞄准前车', label: '脉冲飞弹' },
  mine: { color: '#ffa5bc', hint: '放在车后', label: '泡沫地雷' },
  emp: { color: '#b6a0ff', hint: '近身干扰', label: '电磁风暴' },
  shield: { color: '#6be3d1', hint: '来弹时开', label: '能量护盾' },
  boost: { color: '#79d5ff', hint: '出弯加速', label: '超级氮气' },
  tractor: { color: '#ffe58a', hint: '追赶前车', label: '引力牵引' },
});

// Shared immutable resource kit. Track rebuild must not dispose this cache;
// entity pooling reuses it for the lifetime of the renderer.
export const itemVisualOwned = new Set();
const cache = new Map();
function resource(key, build) {
  if (!cache.has(key)) { const value = build(); cache.set(key, value); itemVisualOwned.add(value); }
  return cache.get(key);
}
function mat(color, basic = false, options = {}) {
  return resource(`m:${color}:${basic}:${JSON.stringify(options)}`, () => basic
    ? new THREE.MeshBasicMaterial({ color, ...options })
    : new THREE.MeshStandardMaterial({ color, roughness: .48, ...options }));
}
const geometry = (key, factory) => resource(`g:${key}`, factory);
function piece(parent, geo, material, xyz = [0, 0, 0], scale = [1, 1, 1]) {
  const m = new THREE.Mesh(geo, material); m.position.fromArray(xyz); m.scale.fromArray(scale); parent.add(m); return m;
}
const sphere = () => geometry('sphere', () => new THREE.SphereGeometry(1, 12, 8));
const cylinder = () => geometry('cylinder', () => new THREE.CylinderGeometry(1, 1, 1, 12));
const torus = () => geometry('ring', () => new THREE.TorusGeometry(1, .065, 5, 24));
const cube = () => geometry('cube', () => new THREE.BoxGeometry(1, 1, 1));

export function buildItemBox(questionMaterial) {
  if (questionMaterial) {
    itemVisualOwned.add(questionMaterial); if (questionMaterial.map) itemVisualOwned.add(questionMaterial.map);
  }
  const root = new THREE.Group(); root.name = 'item-capsule'; root.userData.dynamicScenery = true;
  const core = new THREE.Group(); core.position.y = 1.25; root.add(core);
  const shell = piece(core, cube(), mat('#ffd967', false, { metalness: .12 }), [0, 0, 0], [1.25, 1.25, 1.25]);
  shell.name = 'pickup-core';
  for (const y of [-.68, .68]) piece(core, cube(), mat('#2b575a'), [0, y, 0], [1.44, .16, 1.44]);
  const faceGeo = geometry('question-face', () => new THREE.PlaneGeometry(.86, .92));
  if (questionMaterial) for (let side = 0; side < 4; side++) {
    const a = side * Math.PI / 2;
    const face = piece(core, faceGeo, questionMaterial, [Math.sin(a) * .64, 0, Math.cos(a) * .64]); face.rotation.y = a;
  }
  const base = piece(root, torus(), mat('#ffe188', true), [0, .10, 0], [1.05, 1.05, 1.05]); base.rotation.x = Math.PI / 2;
  const pulse = piece(root, torus(), mat('#fff2b8', true), [0, .13, 0]); pulse.rotation.x = Math.PI / 2; pulse.visible = false;
  const empty = piece(root, torus(), mat('#667b80', true), [0, .085, 0], [1.05, 1.05, 1.05]); empty.rotation.x = Math.PI / 2;
  root.userData.core = core; root.userData.base = base; root.userData.empty = empty; root.userData.pulse = pulse;
  root.userData.wasOpen = null; root.userData.collectedAt = -Infinity;
  return root;
}

export function updateItemBox(root, available, time, index, phase, reducedMotion = false) {
  const data = root.userData;
  if (data.wasOpen === true && !available) data.collectedAt = time;
  data.wasOpen = available;
  root.visible = phase !== 'result'; data.core.visible = available; data.base.visible = available; data.empty.visible = !available;
  if (available) {
    data.core.rotation.y = reducedMotion ? .45 : time * .8 + index;
    data.core.position.y = 1.25 + (reducedMotion ? 0 : Math.sin(time * 2 + index * 2) * .12);
  }
  const age = time - data.collectedAt;
  data.pulse.visible = !reducedMotion && !available && age >= 0 && age < .38;
  if (data.pulse.visible) data.pulse.scale.setScalar(1.1 + age * 3.5);
  // Empty ground socket is distinct from the collectible. No predicted spawn
  // ever enables pickup; only the next authoritative box snapshot does that.
  data.empty.scale.setScalar(.82 + .2 * clamp(age / ITEM_BOX_RESPAWN, 0, 1));
}

export function buildItemEntity(kind) {
  const root = new THREE.Group(); root.name = `${kind}-visual`;
  if (kind === 'missile') {
    const orange = mat('#ed7650'), cream = mat('#fff1ce'), ink = mat('#29444b');
    const body = piece(root, cylinder(), cream, [0, 0, 0], [.23, 1.15, .23]); body.rotation.x = Math.PI / 2;
    const tip = piece(root, sphere(), orange, [0, 0, .64], [.24, .24, .36]);
    const band = piece(root, cylinder(), orange, [0, 0, .15], [.245, .22, .245]); band.rotation.x = Math.PI / 2;
    for (let i = 0; i < 4; i++) {
      const fin = piece(root, cube(), ink, [0, 0, -.4], [.07, .73, .38]); fin.rotation.z = i * Math.PI / 2;
    }
    const nozzle = piece(root, torus(), ink, [0, 0, -.6], [.25, .25, .25]);
    const flame = piece(root, sphere(), mat('#95e4ff', true), [0, 0, -.95], [.17, .17, .44]);
    root.userData.flame = flame;
    const trail = new THREE.Group(); root.add(trail); root.userData.trail = trail;
    for (let i = 0; i < 3; i++) piece(trail, sphere(), mat('#c9e3e7', true, { transparent: true, opacity: .28, depthWrite: false }), [0, 0, -1.4 - i * .65], [.20 + i * .08, .20 + i * .08, .28]);
    void tip; void nozzle;
  } else if (kind === 'mine') {
    // Foam mine = rounded pressure puck, not a naval bomb or fake tripwire.
    // Its 3 x 4.8 m warning footprint matches existing lateral/longitudinal rules.
    piece(root, cylinder(), mat('#394e59'), [0, .16, 0], [.76, .24, .76]);
    piece(root, sphere(), mat('#ef91ad'), [0, .38, 0], [.64, .36, .64]);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      piece(root, sphere(), mat('#ffdfba'), [Math.cos(a) * .53, .52, Math.sin(a) * .53], [.21, .19, .21]);
    }
    root.userData.light = piece(root, sphere(), mat('#ff635e', true), [0, .77, 0], [.14, .10, .14]);
    const warn = piece(root, geometry('mine-boundary', () => new THREE.RingGeometry(.94, 1, 24)), mat('#ffb092', true, { side: THREE.DoubleSide, transparent: true, opacity: .58, depthWrite: false }), [0, .06, 0], [1.5, 2.4, 1]);
    warn.rotation.x = -Math.PI / 2; root.userData.warning = warn;
    for (const angle of [-.65, .65]) {
      const cross = piece(root, cube(), mat('#fff4dc', true), [0, .73, 0], [.55, .025, .07]); cross.rotation.y = angle;
    }
  } else if (kind === 'emp') {
    const dome = piece(root, geometry('emp-dome', () => new THREE.IcosahedronGeometry(1.8, 1)), mat('#b4a3ff', true, { transparent: true, opacity: .20, wireframe: true, depthWrite: false }));
    const ring = piece(root, torus(), mat('#c2b3ff', true), [0, 0, 0], [2.1, 2.1, 2.1]); ring.rotation.x = Math.PI / 2;
    root.userData.dome = dome; root.userData.ring = ring;
  } else {
    for (let i = 0; i < 6; i++) piece(root, sphere(), mat('#dfe6e2', false, { transparent: true, opacity: .40, depthWrite: false }), [Math.cos(i * 2.4) * 2.5, .8 + i % 3 * .7, Math.sin(i * 2.4) * 2.5], [2.2, 2.2, 2.2]);
  }
  root.visible = false; return root;
}

export function addTractorFeedback(parent) {
  const root = new THREE.Group(); root.name = 'tractor-activation'; root.visible = false; parent.add(root);
  for (let i = 0; i < 3; i++) {
    const arc = piece(root, geometry('tractor-arc', () => new THREE.TorusGeometry(1, .045, 5, 18, Math.PI * 1.3)), mat('#ffe58a', true), [0, .3 + i * .12, .5 + i * .6], [1.15, 1.15, 1.15]);
    arc.rotation.x = Math.PI / 2; arc.rotation.z = -.15 * Math.PI;
  }
  return root;
}

export function tractorEventActive(events, carId, now) {
  // Both locked and blind use are already announced by the authoritative
  // server. Render an activation pulse, never invent a target/lock or hit.
  return events.some(event => event.car === carId && /^牵引(锁定|小喷)/.test(event.text) && now >= event.time && now - event.time < 1);
}
