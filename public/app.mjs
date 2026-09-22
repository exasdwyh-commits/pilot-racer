import * as THREE from 'three';
import { trackAt, trackFrameAt, TRACK_LENGTH, WIDTH, LAPS, COLORS, wrap, clamp, joystickInput, landscapeSurface, surfaceDelta, ITEM_DEFS, ITEM_BOXES, ITEM_BOX_LANES, SMOKE_RADIUS, JUMP_DURATION, JUMP_HEIGHT, useTrack, TRACKS, halfWidthAt, currentMarks, currentTrackFeatures, pylonAt, PYLON_COUNT } from './simulation.mjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeDaylightRig, batchStaticScenery } from './scenery.mjs';
import {
  broadcastTemplateById,
  broadcastTemplates,
  resolveBroadcastTemplate,
  nextBroadcastTemplate,
  broadcastPose,
} from './broadcast-cameras.mjs';

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const spectator = location.pathname === '/display';
const hubMode = query.get('hub') === '1';
const hubName = (query.get('name') || '').trim().slice(0, 12);
const hubRound = (query.get('round') || '').trim().toUpperCase();
document.body.classList.toggle('spectator', spectator);
document.body.classList.toggle('hub-mode', hubMode);
const surface = $('game-surface');
let layout;

let isInputFocused = false;
let lastKnownLandscape = { width: 0, height: 0 };

function sizeSurface() {
  if (isInputFocused && layout && !spectator) {
    return;
  }
  const width = document.documentElement.clientWidth, height = innerHeight;
  layout = landscapeSurface(width, height, spectator);
  surface.style.width = `${layout.width}px`;
  surface.style.height = `${layout.height}px`;
  surface.style.transform = layout.rotated ? `translateX(${width}px) rotate(90deg)` : 'translate(0,0)';
}
sizeSurface();

document.addEventListener('focusin', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    isInputFocused = true;
  }
});
document.addEventListener('focusout', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    isInputFocused = false;
    setTimeout(() => {
      if (!isInputFocused) {
        sizeSurface();
        applyQuality();
      }
    }, 200);
  }
});

const info = await fetch('/info').then(r => r.json());
$('join-url').textContent = info.join;
$('join-url').href = info.join;
const qrImg = $('broadcast')?.querySelector('img');
if (qrImg) qrImg.src = `/qr.svg?code=${info.code}&t=${Date.now()}`;
if (hubMode) {
  const broadcast = $('broadcast');
  const startRace = $('start-race');
  const broadcastStart = $('broadcast-start');
  if (broadcast) broadcast.hidden = true;
  if (startRace) startRace.hidden = true;
  if (broadcastStart) broadcastStart.hidden = true;
  if (!spectator && hubName && $('join')) $('join').hidden = true;
}
const code = info.code || 'BAY888';
const canvas = $('world');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  $('error').hidden = false;
  $('error').textContent = '此浏览器无法启动 3D 画面，请使用支持 WebGL 2 的 Safari / Chrome。';
  throw new Error('WebGL unavailable');
}

// ---------------------------------------------------------------------------
// Quality Tiers & PCF Soft Shadows (手机画质自适应与一键切换)
// ---------------------------------------------------------------------------
let quality = spectator ? 'high' : 'high';
function applyQuality() {
  const isHigh = quality === 'high';
  renderer.shadowMap.enabled = isHigh;
  if (isHigh) {
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, spectator ? 1.5 : (isHigh ? 1.25 : 1.0)));
  renderer.setSize(layout.width, layout.height, false);
  const qBtn = $('quality-toggle');
  if (qBtn) qBtn.textContent = `画质 · ${isHigh ? '高清' : '节能'}`;
}
applyQuality();

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#90cad8');
scene.fog = new THREE.Fog('#90cad8', 210, 720);

const camera = new THREE.PerspectiveCamera(64, layout.width / layout.height, 0.12, 950);
const hemisphere = new THREE.HemisphereLight('#fff8e6', '#3b7888', 1.9);
scene.add(hemisphere);

// Lightweight local IBL: gives Hyper3D paint, metal, glass and water something
// coherent to reflect without adding a remote HDR download.
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnvironment = new RoomEnvironment();
scene.environment = pmrem.fromScene(roomEnvironment, 0.04).texture;
scene.environmentIntensity = spectator ? 0.78 : 0.68;
roomEnvironment.dispose?.();
pmrem.dispose();

// Direct Sun Lighting
const sun = new THREE.DirectionalLight('#fff4d5', 2.75);
sun.position.set(-110, 160, 70);
const sunTarget = new THREE.Object3D();
scene.add(sunTarget);
sun.target = sunTarget;
sun.castShadow = true;
sun.shadow.mapSize.width = spectator ? 2048 : 1024;
sun.shadow.mapSize.height = spectator ? 2048 : 1024;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 420;
const shadowRange = spectator ? 165 : 95;
sun.shadow.camera.left = -shadowRange;
sun.shadow.camera.right = shadowRange;
sun.shadow.camera.top = shadowRange;
sun.shadow.camera.bottom = -shadowRange;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.025;
scene.add(sun);
const daylightRig = makeDaylightRig({ sun, hemisphere, scene });
const sunFollow = new THREE.Vector3();

// Lightweight procedural sky dome: richer horizon/zenith separation and a
// soft sun bloom without post-processing or another texture download.
const skyUniforms = {
  topColor: { value: new THREE.Color('#5f9fc4') },
  horizonColor: { value: new THREE.Color('#d8e3dc') },
  sunColor: { value: new THREE.Color('#ffe5b0') },
  sunDirection: { value: new THREE.Vector3(-0.45, 0.78, 0.35).normalize() },
};
const skyMaterial = new THREE.ShaderMaterial({
  uniforms: skyUniforms,
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    uniform vec3 sunColor;
    uniform vec3 sunDirection;
    varying vec3 vDir;
    void main() {
      vec3 dir = normalize(vDir);
      float horizon = smoothstep(-0.18, 0.72, dir.y);
      vec3 color = mix(horizonColor, topColor, horizon);
      float sunDot = max(dot(dir, normalize(sunDirection)), 0.0);
      color += sunColor * pow(sunDot, 160.0) * 1.15;
      color += sunColor * pow(sunDot, 14.0) * 0.10;
      gl_FragColor = vec4(color, 1.0);
    }
  `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(820, 32, 18), skyMaterial);
skyDome.frustumCulled = false;
skyDome.renderOrder = -1000;
scene.add(skyDome);
const skyTopDay = new THREE.Color('#5f9fc4');
const skyTopWarm = new THREE.Color('#667b91');
const skyHorizonDay = new THREE.Color('#d8e3dc');
const skyHorizonWarm = new THREE.Color('#f0b58e');

// ---------------------------------------------------------------------------
// Procedural Web Audio Synthesizer (零外部依赖，极速即时反馈)
// ---------------------------------------------------------------------------
// 音乐与音频引擎 (BGM Player & Procedural SFX Synthesizer)
// ---------------------------------------------------------------------------
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.lastLockWarning = 0;
    this.lastDrift = 0;
    this.bgm = null;
    this.currentBgmTrack = null;
  }
  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) this.ctx = new AudioContext();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (this.enabled && this.currentBgmTrack && (!this.bgm || this.bgm.paused)) {
      this.playBgm(this.currentBgmTrack);
    }
  }
  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      if (this.bgm) this.bgm.pause();
      if (this.windGain && this.ctx) this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    } else {
      if (this.currentBgmTrack) this.playBgm(this.currentBgmTrack);
    }
    return this.enabled;
  }
  playBgm(track) {
    this.currentBgmTrack = track;
    if (!this.enabled) return;
    const url = `/audio/${track}.mp3`;
    if (!this.bgm) {
      this.bgm = new Audio();
      this.bgm.loop = true;
      this.bgm.volume = 0.52;
    }
    if (!this.bgm.src.endsWith(url)) {
      this.bgm.src = url;
      this.bgm.load();
    }
    this.bgm.volume = 0.52;
    this.bgm.play().catch(() => {});
  }
  playLockWarning() {
    if (!this.enabled || !this.ctx) return;
    const now = performance.now();
    if (now - this.lastLockWarning < 220) return;
    this.lastLockWarning = now;
    const t = this.ctx.currentTime;
    // PopKart Missile Lock Warning: alternating rapid dual-tone beeps
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc1.type = 'square';
    osc2.type = 'sawtooth';
    osc1.frequency.setValueAtTime(1046.5, t); // C6
    osc1.frequency.setValueAtTime(1318.5, t + 0.08); // E6
    osc2.frequency.setValueAtTime(2093.0, t);
    osc2.frequency.setValueAtTime(2637.0, t + 0.08);
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);
    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.19);
    osc2.stop(t + 0.19);
  }
  playHit() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.38);
    gain.gain.setValueAtTime(0.45, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.44);
    this.playNoise(t, 0.32, 0.28, 900);
  }
  playShieldBlock() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    // PopKart Shield Deflection Ping
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(1760, t);
    osc1.frequency.exponentialRampToValueAtTime(880, t + 0.3);
    osc2.frequency.setValueAtTime(3520, t);
    osc2.frequency.exponentialRampToValueAtTime(1760, t + 0.15);
    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);
    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.36);
    osc2.stop(t + 0.36);
  }
  playDrift() {
    if (!this.enabled || !this.ctx) return;
    const now = performance.now();
    if (now - this.lastDrift < 110) return;
    this.lastDrift = now;
    const t = this.ctx.currentTime;
    // PopKart Tire Skid: high resonant squeal + asphalt friction
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(2150, t);
    osc.frequency.exponentialRampToValueAtTime(1650, t + 0.12);
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2200, t);
    filter.Q.setValueAtTime(6.0, t);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.13);
    this.playNoise(t, 0.14, 0.11, 2800);
  }
  playNitro() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    // PopKart Nitro Boost: explosive air rush + turbo jet roar
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.22);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.48);
    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.52);
    this.playNoise(t, 0.28, 0.5, 1800);
  }
  playItemGet() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    // PopKart Item Get: sparkling 4-tone ascending bell arpeggio (C6-E6-G6-C7)
    const freqs = [1046.5, 1318.5, 1567.98, 2093.0];
    freqs.forEach((f, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t + idx * 0.045);
      gain.gain.setValueAtTime(0.2, t + idx * 0.045);
      gain.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.045 + 0.18);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t + idx * 0.045);
      osc.stop(t + idx * 0.045 + 0.2);
    });
  }
  playItemUse(kind) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (kind === 'missile') {
      // Missile launch whoosh & rocket ignite
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(330, t);
      osc.frequency.exponentialRampToValueAtTime(1320, t + 0.28);
      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.34);
      this.playNoise(t, 0.18, 0.28, 900);
    } else if (kind === 'shield') {
      // Shield deploy shimmer
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, t);
      osc.frequency.exponentialRampToValueAtTime(1400, t + 0.25);
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.34);
    } else if (kind === 'mine') {
      // Mine drop click & arming beep
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.setValueAtTime(880, t + 0.08);
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    } else if (kind === 'emp') {
      // Electric EMP shock wave
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.linearRampToValueAtTime(880, t + 0.15);
      osc.frequency.linearRampToValueAtTime(110, t + 0.35);
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.42);
      this.playNoise(t, 0.2, 0.35, 1400);
    } else {
      // General item use / jump / clean / boost
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(392, t);
      osc.frequency.exponentialRampToValueAtTime(784, t + 0.18);
      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    }
  }
  playCountdown() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, t);
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  }
  playGo() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.48);
  }
  playNoise(t, volume, duration, filterFreq) {
    if (!this.ctx) return;
    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(filterFreq, t);
    filter.Q.setValueAtTime(1.5, t);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    noise.start(t);
    noise.stop(t + duration);
  }
  // Continuous speed wind: one looping noise node, gain/filter follow speed.
  ensureWind() {
    if (!this.ctx || this.windGain) return;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 400;
    const g = this.ctx.createGain(); g.gain.value = 0;
    src.connect(filt); filt.connect(g); g.connect(this.ctx.destination);
    src.start();
    this.windGain = g; this.windFilt = filt;
  }
  setWind(s01, boosting) {
    if (!this.enabled || !this.ctx) return;
    this.ensureWind();
    if (!this.windGain) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(Math.min(0.16, s01 * s01 * 0.16 + (boosting ? 0.05 : 0)), t, 0.15);
    this.windFilt.frequency.setTargetAtTime(400 + s01 * 2600, t, 0.15);
  }
}
const audio = new AudioEngine();
window.addEventListener('pointerdown', () => audio.init(), { once: true });
$('audio-toggle').onclick = () => {
  audio.init();
  const on = audio.toggle();
  $('audio-toggle').textContent = `音效 · ${on ? '开' : '关'}`;
};
$('quality-toggle').onclick = () => {
  quality = quality === 'high' ? 'low' : 'high';
  applyQuality();
  applyVisualQuality();
};

// ---------------------------------------------------------------------------
// Material Cache & Geometry Helpers
// ---------------------------------------------------------------------------
const mats = new Map();
function material(color, options = {}) {
  const key = color + JSON.stringify(options);
  if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...options }));
  return mats.get(key);
}

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
function box(parent, x, y, z, w, h, d, color, rot = 0, shadow = true) {
  const m = new THREE.Mesh(boxGeo, material(color));
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  m.rotation.y = rot;
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function cylinder(parent, x, y, z, r1, r2, h, color, n = 8, shadow = true) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, n), material(color));
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function sphere(parent, x, y, z, r, color, shadow = false) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), material(color));
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function label(text, bg = '#18343c', fg = '#effbdc', w = 1024, h = 256, border = null) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 16;
    ctx.strokeRect(8, 8, w - 16, h - 16);
  }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${h * 0.52}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(text, w / 2, h / 2, w * 0.92);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
}

function board(parent, x, y, z, w, h, text, rot = 0, bg, fg, border = null) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), label(text, bg, fg, 1024, 256, border));
  m.position.set(x, y, z);
  m.rotation.y = rot;
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------------------
// 赛道复杂度与海湾地标 (Suspension Bridge, Tunnel, Marina, Lighthouse)
// ---------------------------------------------------------------------------
// 1. Water with moving micro-normal reflections. The normal texture is
// generated locally so the scene stays offline-first and has no extra CDN.
function makeWaterNormal(size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const ax = x / size * Math.PI * 2;
    const ay = y / size * Math.PI * 2;
    const dx = Math.cos(ax * 3 + ay * 1.7) * 0.42 + Math.cos(ax * 7 - ay * 2.2) * 0.17;
    const dz = Math.cos(ay * 4 - ax * 1.3) * 0.38 + Math.cos(ay * 9 + ax * 2.7) * 0.13;
    const n = new THREE.Vector3(-dx, 1, -dz).normalize();
    const i = (y * size + x) * 4;
    data[i] = Math.round((n.x * 0.5 + 0.5) * 255);
    data[i + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
    data[i + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
    data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(42, 42);
  tex.needsUpdate = true;
  return tex;
}
const waterNormal = makeWaterNormal();
const waterMat = new THREE.MeshPhysicalMaterial({
  color: '#16788e',
  roughness: 0.1,
  metalness: 0.05,
  clearcoat: 1,
  clearcoatRoughness: 0.08,
  normalMap: waterNormal,
  normalScale: new THREE.Vector2(0.42, 0.42),
  envMapIntensity: 1.15,
});
const water = new THREE.Mesh(new THREE.PlaneGeometry(1900, 1900), waterMat);
water.rotation.x = -Math.PI / 2;
water.position.y = -3;
water.receiveShadow = true;
scene.add(water);

const island = cylinder(scene, 0, -4, 0, 168, 175, 7, '#ebd8aa', 80, false);
island.scale.z = 0.77;
const ground = cylinder(scene, 0, -0.3, 0, 156, 162, 2, '#91a670', 80, false);
ground.scale.z = 0.76;
const park = cylinder(scene, 0, 0, 0, 65, 70, 1, '#a8bd7d', 64, false);
park.scale.z = 0.7;

// ---------------------------------------------------------------------------
// 赛道跟随场景 (road, landmarks, boxes): rebuilt on track switch.
// Everything track-following lives under trackGroup; global scenery
// (water, island, buildings, mountains) stays in scene permanently.
// ---------------------------------------------------------------------------
let trackGroup = null;
let beaconRay = null;
let buildPending = null;
let gantryMount = null;
const startLights = [];
const chevronPanels = [];
const itemBoxMeshes = [];
let builtTrackId = null;

function isSharedMat(m) {
  if (m === roadMaterial || m === waterMat) return true;
  if (modelOwned.has(m)) return true;
  for (const v of mats.values()) if (v === m) return true;
  return false;
}

// ---------------------------------------------------------------------------
// CC0 道具库 (Kenney Racing/Nature, 见 public/models/PROVENANCE.md)。
// 预加载失败时对应道具回退到程序化实现或直接跳过，场景绝不崩。
// ---------------------------------------------------------------------------
const MODEL_FILES = {
  fence: 'fenceStraight.glb', flag: 'flagCheckers.glb', stand: 'grandStand.glb',
  lamp: 'lightPostLarge.glb', tent: 'tent.glb',
  pylon: 'pylon.glb',
  palm: 'tree_palm.glb', palmTall: 'tree_palmTall.glb',
  rock: 'rock_largeA.glb', bush: 'plant_bush.glb',
};
const modelCache = new Map();
const modelOwned = new Set();
async function preloadModels() {
  const loader = new GLTFLoader();
  await Promise.all(Object.entries(MODEL_FILES).map(async ([kind, file]) => {
    try {
      const gltf = await loader.loadAsync(`/models/${file}`);
      gltf.scene.traverse(o => {
        if (o.isMesh) {
          o.castShadow = true; o.receiveShadow = true;
          if (o.geometry) modelOwned.add(o.geometry);
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const mt of ms) {
            modelOwned.add(mt);
            if (mt.map) modelOwned.add(mt.map);
          }
        }
      });
      modelCache.set(kind, gltf.scene);
    } catch {
      modelCache.set(kind, null);
    }
  }));
}
const modelsReady = preloadModels();
modelsReady.then(() => {
  try {
    window.__pilotModels = Object.fromEntries(
      Object.keys(MODEL_FILES).map(k => [k, !!modelCache.get(k)]),
    );
  } catch {}
});
/** 克隆一个缓存道具（共享几何体/材质）；缺失返回 null。 */
function prop(kind) {
  const t = modelCache.get(kind);
  return t ? t.clone(true) : null;
}
// Trackside ad boards: real-brand text creatives on procedural frames.
// (Brand names as text only; commercial placement needs the brand's sign-off.)
const AD_CREATIVES = [
  { bg: '#e1251b', fg: '#ffe23f', sub: '#ffffff', title: '王老吉', line: '怕上火 · 喝王老吉' },
  { bg: '#16181d', fg: '#ffffff', sub: '#ff3b30', title: '百 威', line: 'Budweiser · 敬真我' },
  { bg: '#e61a27', fg: '#ffffff', sub: '#ffffff', title: '可口可乐', line: '冰爽畅饮' },
];
function adBoardTexture(ad, wide = false) {
  const c = document.createElement('canvas');
  c.width = wide ? 2048 : 1024; c.height = wide ? 256 : 512;
  const W = c.width, H = c.height, k = W / 1024;
  const ctx = c.getContext('2d');
  ctx.fillStyle = ad.bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = ad.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let size = Math.round((wide ? 120 : 230) * k);
  const setTitle = () => { ctx.font = `900 ${size}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`; };
  setTitle();
  while (size > 40 && ctx.measureText(ad.title).width > W * 0.88) {
    size -= wide ? 6 : 10;
    setTitle();
  }
  ctx.fillText(ad.title, W / 2, H * (wide ? 0.38 : 0.42), W * 0.9);
  ctx.fillRect(W * 0.207, H * (wide ? 0.62 : 0.664), W * 0.586, Math.max(3, 6 * k));
  ctx.fillStyle = ad.sub;
  ctx.font = `600 ${Math.round((wide ? 44 : 64) * k)}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.fillText(ad.line, W / 2, H * (wide ? 0.8 : 0.81), W * 0.9);
  ctx.font = `500 ${Math.round(30 * k)}px system-ui, sans-serif`;
  ctx.strokeStyle = ad.fg; ctx.lineWidth = Math.max(2, 3 * k);
  ctx.strokeRect(W - 128 * k, 28 * k, 96 * k, 48 * k);
  ctx.fillStyle = ad.fg;
  ctx.fillText('广告', W - 80 * k, 54 * k);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
// Prime slot: start gantry face. Rebuilt with the ad group on copy change.
function applyGantryAd(ad) {
  if (!gantryMount) return;
  for (const ch of [...gantryMount.children]) {
    gantryMount.remove(ch);
    ch.geometry?.dispose?.();
    ch.material?.map?.dispose?.();
    ch.material?.dispose?.();
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 1.8),
    new THREE.MeshBasicMaterial({ map: adBoardTexture(ad, true) }),
  );
  gantryMount.add(mesh);
}
// Ad system: slots come from /api/ads (ads.json, mtime-versioned). The boards
// live in their own group so copy changes never rebuild the whole track.
// Ads refresh in lobby/demo/result only — never mid-race.
let adGroup = null;
let adsAppliedKey = '';
let adsFetching = false;
let lastAdsPoll = 0;
function clearAdGroup() {
  if (!adGroup) return;
  adGroup.traverse(o => {
    if (o.isMesh) {
      if (o.geometry && o.geometry !== boxGeo && !modelOwned.has(o.geometry)) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const mt of ms) {
        if (!mt || isSharedMat(mt)) continue;
        if (mt.map && !modelOwned.has(mt.map)) mt.map.dispose();
        mt.dispose();
      }
    }
  });
  trackGroup?.remove(adGroup);
  adGroup = null;
}
function validAdSlot(slot, trackId) {
  if (!slot || typeof slot !== 'object') return null;
  if (slot.track !== '*' && slot.track !== trackId) return null;
  if (slot.kind === 'gantry') {
    return { kind: 'gantry', creative: slot.creative | 0 };
  }
  const at = Number(slot.at);
  if (!Number.isFinite(at) || at < 0 || at > 1) return null;
  const side = slot.side === -1 ? -1 : 1;
  const off = Math.min(24, Math.max(3, Number(slot.off) || 7));
  const w = Math.min(10, Math.max(3, Number(slot.w) || 7));
  return { kind: 'board', at, side, off, w, double: slot.double === true, creative: slot.creative | 0 };
}
async function refreshAds() {
  if (adsFetching || !trackGroup || !builtTrackId) return;
  adsFetching = true;
  try {
    const res = await fetch('/api/ads');
    if (!res.ok) throw new Error('ads http ' + res.status);
    const data = await res.json();
    const key = `${data.version}|${builtTrackId}`;
    if (key === adsAppliedKey) return;
    const creatives = Array.isArray(data.creatives) && data.creatives.length ? data.creatives : AD_CREATIVES;
    const slots = (Array.isArray(data.slots) ? data.slots : [])
      .map(s => validAdSlot(s, builtTrackId))
      .filter(Boolean)
      .slice(0, 24);
    if (!slots.length) return;
    clearAdGroup();
    adGroup = new THREE.Group();
    trackGroup.add(adGroup);
    for (const slot of slots) {
      if (slot.kind === 'gantry') continue;
      const ad = creatives[((slot.creative % creatives.length) + creatives.length) % creatives.length];
      if (!ad || typeof ad.title !== 'string') continue;
      const s = slot.at * TRACK_LENGTH;
      buildAdBoardInto(adGroup, s, slot.side * (halfWidthAt(s) + slot.off), slot.side > 0 ? -Math.PI / 2 : Math.PI / 2, ad, slot.w, slot.double);
    }
    const gantrySlot = slots.find(s => s.kind === 'gantry');
    const gantryAd = gantrySlot
      ? creatives[((gantrySlot.creative % creatives.length) + creatives.length) % creatives.length]
      : creatives[3] ?? creatives[0];
    if (gantryAd && typeof gantryAd.title === 'string') applyGantryAd(gantryAd);
    adsAppliedKey = key;
    try { window.__adsKey = `${key}|boards=${adGroup.children.length}`; } catch {}
  } catch {
    // Offline or bad file: keep whatever boards are already up.
  } finally {
    adsFetching = false;
  }
}
function buildAdBoardInto(parent, s, lane, yawOff, ad, w = 7, doubleFace = false) {
  const p = trackAt(s, lane);
  const grp = new THREE.Group();
  grp.position.set(p.x, p.y, p.z);
  grp.rotation.y = p.yaw + yawOff;
  parent.add(grp);
  const ph = w * 0.514, cy = 2.7 + ph / 2;
  const frame = new THREE.Mesh(boxGeo, material('#1b2d36', { roughness: 0.6 }));
  frame.scale.set(w + 0.4, ph + 0.4, 0.25);
  frame.position.set(0, cy, 0);
  frame.castShadow = true;
  grp.add(frame);
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(w, ph),
    new THREE.MeshBasicMaterial({ map: adBoardTexture(ad) }),
  );
  face.position.set(0, cy, 0.14);
  grp.add(face);
  if (doubleFace) {
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(w, ph),
      new THREE.MeshBasicMaterial({ map: adBoardTexture(ad) }),
    );
    back.position.set(0, cy, -0.14);
    back.rotation.y = Math.PI;
    grp.add(back);
  }
  for (const x of [-(w / 2 - 0.6), w / 2 - 0.6]) {
    const post = new THREE.Mesh(boxGeo, material('#1b2d36', { roughness: 0.6 }));
    post.scale.set(0.35, 2.7, 0.35);
    post.position.set(x, 1.35, 0);
    post.castShadow = true;
    grp.add(post);
  }
}
/** 按赛道坐标放置道具；缺失返回 null，由调用方回退。 */
function placeProp(kind, s, lane, sx, sy, sz, yawOff = 0, dy = 0) {
  const m = prop(kind);
  if (!m || !trackGroup) return null;
  const p = trackAt(s, lane);
  m.position.set(p.x, p.y + dy, p.z);
  m.rotation.y = p.yaw + yawOff;
  m.scale.set(sx, sy, sz);
  trackGroup.add(m);
  return m;
}

function clearTrackScenery() {
  if (!trackGroup) return;
  trackGroup.traverse(o => {
    if (o.isMesh) {
      if (o.geometry && o.geometry !== boxGeo && !modelOwned.has(o.geometry)) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const mt of ms) {
        if (!mt || isSharedMat(mt)) continue;
        if (mt.map && !modelOwned.has(mt.map)) mt.map.dispose();
        mt.dispose();
      }
    }
  });
  scene.remove(trackGroup);
  trackGroup = null;
  beaconRay = null;
  gantryMount = null;
  adGroup = null;
  startLights.length = 0;
  chevronPanels.length = 0;
  itemBoxMeshes.length = 0;
}

const textureLoader = new THREE.TextureLoader();
const roadAlbedo = textureLoader.load('/assets/textures/asphalt_track_diff_1k.png');
roadAlbedo.colorSpace = THREE.SRGBColorSpace;
roadAlbedo.wrapS = roadAlbedo.wrapT = THREE.RepeatWrapping;
roadAlbedo.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const roadNormal = textureLoader.load('/assets/textures/asphalt_track_nor_gl_1k.png');
roadNormal.wrapS = roadNormal.wrapT = THREE.RepeatWrapping;
roadNormal.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const roadMaterial = new THREE.MeshStandardMaterial({
  color: '#e4e7e8',
  map: roadAlbedo,
  normalMap: roadNormal,
  normalScale: new THREE.Vector2(0.72, 0.72),
  roughness: 0.9,
  metalness: 0.02,
  envMapIntensity: 0.45,
  side: THREE.DoubleSide,
});

function applyVisualQuality() {
  const high = quality === 'high';
  roadMaterial.normalMap = high ? roadNormal : null;
  roadMaterial.needsUpdate = true;
  waterMat.normalMap = high ? waterNormal : null;
  waterMat.clearcoat = high ? 1 : 0.45;
  waterMat.needsUpdate = true;
  scene.environmentIntensity = spectator ? 0.78 : (high ? 0.68 : 0.5);
}
applyVisualQuality();

/** (Re)build all track-following scenery for the active simulation track. */
function buildTrackScenery(trackId) {
  clearTrackScenery();
  trackGroup = new THREE.Group();
  scene.add(trackGroup);
  const TG = trackGroup;
  // Deterministic trackside dressing per build.
  let tseed = 41;
  const trand = () => (tseed = (tseed * 1664525 + 1013904223) >>> 0) / 4294967296;

// 2. Asphalt Road Ribbon with distinct markings and shadow reception
function ribbon(left, right, color, yOffset = 0.0, options = {}) {
  const positions = [], indices = [], uvs = [];
  for (let i = 0; i <= 640; i++) {
    const s = i / 640 * TRACK_LENGTH;
    let edgeIndex = 0;
    for (const edge of [left, right]) {
      const p = trackAt(s, typeof edge === 'function' ? edge(s) : edge);
      positions.push(p.x, p.y + yOffset, p.z);
      uvs.push(edgeIndex * 2.2, s / 7.5);
      edgeIndex++;
    }
  }
  for (let i = 0; i < 640; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  const { material: customMaterial, ...materialOptions } = options;
  const mesh = new THREE.Mesh(
    g,
    customMaterial || material(color, { side: THREE.DoubleSide, ...materialOptions }),
  );
  mesh.receiveShadow = true;
  TG.add(mesh);
}

// Shoulder base, Dark Asphalt Road, and Markings (edges follow road width)
const hwEdge = s => halfWidthAt(s);
ribbon(s => -hwEdge(s) - 1.2, s => hwEdge(s) + 1.2, '#d6c9ad', -0.24, { roughness: 0.9 });
ribbon(s => -hwEdge(s), s => hwEdge(s), '#282d33', 0.0, { material: roadMaterial });
ribbon(-0.06, 0.06, '#f8fafc', 0.025, { roughness: 0.5 });
for (const side of [-1, 1]) {
  ribbon(s => side * hwEdge(s) - 0.14, s => side * hwEdge(s) + 0.14, '#f8fafc', 0.035, { roughness: 0.5 });
}

// Skill-route features: bright strips are deliberately offset from the ideal
// center line, so players must choose them rather than receiving free speed.
const gameplayFeatures = currentTrackFeatures();
for (const pad of gameplayFeatures.boostPads) {
  const s = pad.at * TRACK_LENGTH;
  const p = trackAt(s, pad.lane);
  const g = new THREE.Group();
  g.position.set(p.x, p.y, p.z);
  g.rotation.y = p.yaw;
  TG.add(g);
  for (let k = -2; k <= 2; k++) {
    const plate = new THREE.Mesh(
      boxGeo,
      material(k % 2 ? '#75f4ff' : '#35cfea', {
        emissive: '#179bb5',
        emissiveIntensity: 1.2,
        roughness: 0.28,
      }),
    );
    plate.position.set(0, 0.055, k * 0.72);
    plate.scale.set(pad.width * 2, 0.035, 0.48);
    plate.receiveShadow = true;
    g.add(plate);
  }
  const arrow = board(g, 0, 0.095, 0, pad.width * 1.7, 0.7, '»»', 0, '#146a78', '#bffcff');
  arrow.rotation.x = -Math.PI / 2;
}

for (const ramp of gameplayFeatures.ramps) {
  const s = ramp.at * TRACK_LENGTH;
  const p = trackAt(s, ramp.lane);
  const g = new THREE.Group();
  g.position.set(p.x, p.y, p.z);
  g.rotation.y = p.yaw;
  TG.add(g);
  const deck = box(g, 0, 0.18, 0, ramp.width * 2, 0.28, 5.0, '#d9dde2', 0, true);
  deck.rotation.x = -0.055;
  box(g, -ramp.width + 0.15, 0.18, 0, 0.18, 0.34, 5.1, '#ffcf4a', 0, false);
  box(g, ramp.width - 0.15, 0.18, 0, 0.18, 0.34, 5.1, '#ffcf4a', 0, false);
  const rampMark = board(g, 0, 0.36, -0.8, ramp.width * 1.5, 0.75, 'JUMP', 0, '#1b2d36', '#ffdf72');
  rampMark.rotation.x = -Math.PI / 2;
}

// Curbs, Barriers and Overhead Gantries
for (let i = 0; i < 320; i++) {
  const s = i / 320 * TRACK_LENGTH, p = trackAt(s), hw = halfWidthAt(s);
  for (const lane of [-hw - 0.48, hw + 0.48]) {
    const q = trackAt(s, lane);
    box(TG, q.x, q.y + 0.03, q.z, 0.9, 0.16, TRACK_LENGTH / 320 + 0.06, i % 2 ? '#f1faee' : '#e63946', q.yaw, false);
  }
  if (i % 4 === 0) {
    for (const lane of [-2.7, 2.7]) {
      const q = trackAt(s, lane);
      box(TG, q.x, q.y + 0.04, q.z, 0.12, 0.025, 2.5, '#f8fafc', q.yaw, false);
    }
  }
  if (i % 3 === 0) {
    const segLen = TRACK_LENGTH / 320 * 3 + 0.06;
    for (const lane of [-hw - 1.2, hw + 1.2]) {
      const q = trackAt(s, lane);
      const fence = prop('fence');
      if (fence) {
        // Kenney fence: length on x. Turn across the tangent, match old volume.
        fence.position.set(q.x, q.y + 0.1, q.z);
        fence.rotation.y = q.yaw + Math.PI / 2;
        fence.scale.set(segLen, 2.2, 6);
        TG.add(fence);
      } else {
        box(TG, q.x, q.y + 0.65, q.z, 0.38, 1.1, segLen, i % 6 ? '#153f47' : '#e0eee0', q.yaw, true);
      }
    }
  }
  if (i % 18 === 0) {
    box(TG, p.x, p.y / 2 - 1, p.z, 6, p.y + 2, 3, '#aeb3a7', p.yaw, true);
  }
}

// ---------------------------------------------------------------------------
// 地标 1: 海湾高架跨海悬索大桥 (Bay Suspension Viaduct)
// 位于赛道高海拔爬升段 (s ~ 150 - 240)
// ---------------------------------------------------------------------------
const bridgeTowers = [];
for (const f of currentMarks().bridge) {
  const p = trackAt(f * TRACK_LENGTH);
  const tower = new THREE.Group();
  tower.position.set(p.x, p.y, p.z);
  tower.rotation.y = p.yaw;
  TG.add(tower);
  bridgeTowers.push(tower);

  // Twin giant concrete/steel towers
  for (const x of [-9.8, 9.8]) {
    cylinder(tower, x, 18, 0, 1.1, 1.6, 38, '#f4ece1', 8, true);
    cylinder(tower, x, -8, 0, 1.8, 2.4, 18, '#70828a', 8, true); // Pier plunging into ocean
  }
  // Cross beams between tower legs
  box(tower, 0, 24, 0, 20.6, 1.8, 1.6, '#e64a19', 0, true);
  box(tower, 0, 36, 0, 20.6, 1.4, 1.4, '#f4ece1', 0, true);

  // Suspension stay cables
  for (let k = 1; k <= 6; k++) {
    for (const x of [-9.6, 9.6]) {
      const cable = box(tower, x, 18 + k * 2.6, (k - 3.5) * 6, 0.1, 0.1, 14, '#ff9800', 0, false);
      cable.rotation.x = 0.35 * (k < 4 ? 1 : -1);
    }
  }
}

// ---------------------------------------------------------------------------
// 地标 2: 海滨拱廊连拱隧道 (Cliffside Coastal Colonnade & Tunnel)
// 位于背山急弯段 (s ~ 380 - 440)
// ---------------------------------------------------------------------------
const colonnadeGroup = new THREE.Group();
TG.add(colonnadeGroup);
const _tm = currentMarks().tunnel;
for (let s = _tm.from * TRACK_LENGTH; s <= _tm.to * TRACK_LENGTH; s += _tm.step) {
  const p = trackAt(s), hw = halfWidthAt(s);
  const archFrame = new THREE.Group();
  archFrame.position.set(p.x, p.y, p.z);
  archFrame.rotation.y = p.yaw;
  colonnadeGroup.add(archFrame);

  // Mountain-side solid wall
  box(archFrame, -hw - 1.2, 3.2, 0, 1.2, 6.4, 5.2, '#c8b89e', 0, true);
  // Sea-side classical open pillars
  cylinder(archFrame, hw + 1.2, 3.2, 0, 0.5, 0.65, 6.4, '#e8dcce', 8, true);
  // Arched roof ceiling
  box(archFrame, 0, 6.6, 0, hw * 2 + 3.2, 0.8, 5.2, '#b8a68c', 0, true);
  // Warm amber tunnel lamps
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.25, 0.8), material('#ffb300', { emissive: '#ff9100', emissiveIntensity: 2.8 }));
  lamp.position.set(0, 6.1, 0);
  archFrame.add(lamp);
}

// ---------------------------------------------------------------------------
// 地标 3: 游艇码头与海面浮标 (Marina Boardwalk & Yachts)
// 位于近海直道旁
// ---------------------------------------------------------------------------
function buildYachtAt(s, lane, yawOff, color = '#f8fafc') {
  const p = trackAt(s, lane);
  const yacht = new THREE.Group();
  yacht.position.set(p.x, Math.min(-1.15, p.y - 2.5), p.z);
  yacht.rotation.y = p.yaw + yawOff;
  TG.add(yacht);

  box(yacht, 0, 0.8, 0, 5.4, 2.2, 16, color, 0, true);
  box(yacht, 0, 2.6, -1.2, 3.8, 1.8, 7.8, '#f0f4f8', 0, true);
  box(yacht, 0, 2.7, 0.2, 3.85, 1.2, 3.2, '#1a3340', 0, false);
  cylinder(yacht, 0, 4.6, -2.4, 0.08, 0.12, 3.2, '#c0ccd4', 6, true);
  return yacht;
}

// Track-relative marina: it remains next to the coast straight even when the
// centreline is redesigned, instead of being stranded at old world coords.
{
  const marinaS = TRACK_LENGTH * 0.135;
  const side = 1;
  const marinaLane = side * (halfWidthAt(marinaS) + 30);
  const p = trackAt(marinaS, marinaLane);
  const marina = new THREE.Group();
  marina.position.set(p.x, Math.min(-1.7, p.y - 3.0), p.z);
  marina.rotation.y = p.yaw;
  TG.add(marina);
  box(marina, 0, 0, 0, 64, 1.0, 7, '#9c7a53', 0, true);
  box(marina, 18, 0, 15, 7, 1.0, 38, '#9c7a53', 0, true);
  buildYachtAt(TRACK_LENGTH * 0.125, side * (halfWidthAt(TRACK_LENGTH * 0.125) + 42), 0.15, '#f8fafc');
  buildYachtAt(TRACK_LENGTH * 0.155, side * (halfWidthAt(TRACK_LENGTH * 0.155) + 48), -0.24, '#0288d1');
}

// ---------------------------------------------------------------------------
// 地标 4: 海角旋转探照灯塔 (Cape Lighthouse)
// ---------------------------------------------------------------------------
const lighthouseGroup = new THREE.Group();
const _lh = currentMarks().lighthouse;
const capePos = _lh.x !== undefined ? { x: _lh.x, y: _lh.y ?? 0.7, z: _lh.z } : trackAt(_lh.s * TRACK_LENGTH, _lh.lane);
lighthouseGroup.position.set(capePos.x, capePos.y, capePos.z);
TG.add(lighthouseGroup);

// Lighthouse rock base & red/white striped tower
cylinder(lighthouseGroup, 0, 3, 0, 6, 8, 6, '#616e68', 8, true);
for (let h = 0; h < 5; h++) {
  cylinder(lighthouseGroup, 0, 7.5 + h * 5, 0, 4.2 - h * 0.45, 4.6 - h * 0.45, 5, h % 2 === 0 ? '#e63946' : '#f8f9fa', 12, true);
}
// Top lantern room
cylinder(lighthouseGroup, 0, 33, 0, 2.8, 2.8, 3.4, '#1b2d36', 10, true);
beaconRay = new THREE.Group();
beaconRay.position.set(0, 33, 0);
lighthouseGroup.add(beaconRay);
// Dual rotating sweeping light cones: apex at the lamp, widening outward.
for (const rot of [0, Math.PI]) {
  const arm = new THREE.Group();
  arm.rotation.y = rot;
  beaconRay.add(arm);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(5, 45, 12), material('#fff59d', { emissive: '#fff59d', emissiveIntensity: 2.2, transparent: true, opacity: 0.35, depthWrite: false }));
  cone.rotation.x = -Math.PI / 2;
  cone.position.set(0, 0, 22.5);
  arm.add(cone);
}

// ---------------------------------------------------------------------------
// 赛道竞速细节: 漂移沥青胎印 & 动态流动弯道指示箭头 (Digital Chevrons)
// ---------------------------------------------------------------------------
// 1. Tire skidmarks at major hairpin corners
for (const ratio of [0.15, 0.28, 0.42, 0.58, 0.72, 0.86]) {
  const baseS = TRACK_LENGTH * ratio;
  for (const s of [baseS, baseS + 8, baseS + 16]) {
    for (const lane of [-2.2, -1.5, 1.6, 2.3]) {
      const p = trackAt(s, lane);
      box(TG, p.x, p.y + 0.02, p.z, 0.45, 0.015, 6.2, '#151719', p.yaw + 0.08, false);
    }
  }
}

// 2. Animated digital chevron LED panels
for (const s of [TRACK_LENGTH * 0.16, TRACK_LENGTH * 0.32, TRACK_LENGTH * 0.48, TRACK_LENGTH * 0.65, TRACK_LENGTH * 0.82]) {
  for (let k = 0; k < 3; k++) {
    const cs = s + k * 8;
    const p = trackAt(cs, halfWidthAt(cs) + 3.2);
    const g = new THREE.Group();
    g.position.set(p.x, p.y + 3.2, p.z);
    g.rotation.y = p.yaw + Math.PI / 2;
    TG.add(g);
    // Post
    cylinder(g, 0, -1.2, 0, 0.16, 0.2, 3.8, '#1e2d33', 6, true);
    // Electronic Board with glowing chevron
    box(g, 0, 1.2, 0, 4.5, 2.4, 0.3, '#101e24', 0, true);
    const arrow = board(g, 0, 1.2, 0.18, 4.2, 2.1, '›  ›  ›', 0, '#101e24', '#c5f574');
    chevronPanels.push({ group: g, arrow, s: s + k * 8 });
  }
}

// 3. Safety Tire Wall Stacks at sharp hairpin bends
for (const ratio of [0.15, 0.31, 0.47, 0.64, 0.81]) {
  const baseS = TRACK_LENGTH * ratio;
  for (const s of [baseS, baseS + 8]) {
    const hw = halfWidthAt(s);
    for (let t = 0; t < 4; t++) {
      const tp = trackAt(s + t * 2, hw + 1.8);
      for (let layer = 0; layer < 3; layer++) {
        cylinder(TG, tp.x, tp.y + 0.35 + layer * 0.65, tp.z, 0.85, 0.85, 0.6, (t + layer) % 2 ? '#e63946' : '#1b1e22', 10, true);
      }
    }
  }

// Starting Gantry with Countdown Signal Lights
// (furniture first so the gantry title stays on top visually)
for (let k = 0; k < 12; k++) {
  const s = k / 12 * TRACK_LENGTH, hw = halfWidthAt(s);
  placeProp('lamp', s, (k % 2 ? 1 : -1) * (hw + 4), 9, 9, 9);
}
{
  const hw0 = halfWidthAt(40);
  placeProp('stand', 40, hw0 + 16, 8, 8, 8, Math.PI / 2);
  placeProp('tent', 25, -(halfWidthAt(25) + 11), 6, 6, 6);
  placeProp('tent', 58, -(halfWidthAt(58) + 12), 6, 6, 6);
}
for (const s of [-6, 6]) {
  const hw = halfWidthAt(s);
  placeProp('flag', s, hw + 2, 5, 5, 5);
  placeProp('flag', s, -(hw + 2), 5, 5, 5);
}
// Ad boards arrive async from /api/ads (see refreshAds); fall back to the
// built-in trio if the file is missing so the track never looks empty.
builtTrackId = trackId;
try { window.__builtTrack = trackId; } catch {}
adsAppliedKey = '';
refreshAds().finally(() => {
  if (!adGroup) {
    clearAdGroup();
    adGroup = new THREE.Group();
    trackGroup.add(adGroup);
    AD_CREATIVES.forEach((ad, fi) => {
      const f = [0.2, 0.55, 0.85][fi];
      const s = f * TRACK_LENGTH;
      const side = fi % 2 ? -1 : 1;
      buildAdBoardInto(adGroup, s, side * (halfWidthAt(s) + 6), side > 0 ? -Math.PI / 2 : Math.PI / 2, ad, 7);
    });
    adsAppliedKey = `fallback|${trackId}`;
  }
});
}
for (let k = 1; k <= PYLON_COUNT; k++) {
  const py = pylonAt(k);
  placeProp('pylon', py.s, py.lane, 8, 8, 8);
}
const start = trackAt(0);
const gantry = new THREE.Group();
gantry.position.set(start.x, start.y, start.z);
gantry.rotation.y = start.yaw;
TG.add(gantry);
for (const x of [-9.3, 9.3]) box(gantry, x, 4.7, 0, 0.8, 10, 0.8, '#173c43', 0, true);
box(gantry, 0, 9.1, 0, 20, 2.2, 0.9, '#c5f574', 0, true);
// Start gantry face is the prime ad slot (filled by refreshAds).
gantryMount = new THREE.Group();
gantryMount.position.set(0, 9.1, -0.48);
gantryMount.rotation.y = Math.PI;
gantry.add(gantryMount);
// Countdown signal lights on the front face.
for (let li = 0; li < 3; li++) {
  const lampMesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), new THREE.MeshBasicMaterial({ color: '#2a3b42' }));
  lampMesh.position.set((li - 1) * 2.2, 7.6, -0.55);
  gantry.add(lampMesh);
  startLights.push(lampMesh);
}

// Start/finish line grid markings
for (let x = -7; x < 7; x++) for (let z = 0; z < 2; z++) box(gantry, x + 0.5, 0.065, z - 1, 1, 0.03, 1, (x + z) % 2 ? '#f6ead3' : '#28343a', 0, false);
for (let i = 0; i < 8; i++) {
  const p = trackAt(-Math.floor(i / 2) * 5, i % 2 ? 2.6 : -2.6);
  box(TG, p.x, p.y + 0.06, p.z, 2, 0.02, 3.5, '#7b8782', p.yaw, false);
}

// Track-relative city blocks. Buildings are children of the current track
// group (so switching tracks removes them cleanly) and follow the circuit
// rather than the obsolete world-centred island layout.
const buildingColors = ['#eac8a8', '#f0b7a1', '#eee3cb', '#d7d8bf', '#eccb87', '#a5c2ba'];
const glassMat = material('#264752', { roughness: 0.12, metalness: 0.72, envMapIntensity: 1.1 });
const roadSamples = Array.from({ length: 256 }, (_, i) => {
  const s = i / 256 * TRACK_LENGTH;
  return { ...trackAt(s), width: halfWidthAt(s) };
});
const clearsOtherRoad = (point, radius) => roadSamples.every(
  q => Math.hypot(point.x - q.x, point.z - q.z) > q.width + radius + 3,
);

// TV stations need intentional sight lines just like a real circuit. Buildings
// and tall palms are rejected from a corridor between every authored camera
// and its primary patch of track, so procedural scenery cannot blind the
// director after a layout rebuild.
function pointSegmentDistanceXZ(point, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const apx = point.x - a.x, apz = point.z - a.z;
  const denom = abx * abx + abz * abz || 1;
  const t = clamp((apx * abx + apz * abz) / denom, 0, 1);
  return Math.hypot(point.x - (a.x + abx * t), point.z - (a.z + abz * t));
}
const cameraSightLines = broadcastTemplates(trackId).map(template => {
  const s = template.at * TRACK_LENGTH;
  const target = trackAt(s, 0);
  const pose = broadcastPose(trackId, template, s, 0);
  return { camera: pose.camera, target };
});
const clearsBroadcastSight = (point, radius) => cameraSightLines.every(({ camera, target }) => {
  const cameraClear = Math.hypot(point.x - camera.x, point.z - camera.z) > radius + 22;
  const sightClear = pointSegmentDistanceXZ(point, camera, target) > radius + 9;
  return cameraClear && sightClear;
});

for (let i = 0; i < 38; i++) {
  const s = (0.025 + i / 38 * 0.94 + (trand() - 0.5) * 0.018) * TRACK_LENGTH;
  const side = i % 2 ? 1 : -1;
  const lane = side * (halfWidthAt(s) + 19 + trand() * 29);
  const p = trackAt(s, lane);
  const w = 5 + trand() * 8, d = 5 + trand() * 7, h = 6 + trand() * 14;
  const buildingRadius = Math.max(w, d) * 0.55;
  if (!clearsOtherRoad(p, buildingRadius) || !clearsBroadcastSight(p, buildingRadius)) continue;

  const building = new THREE.Group();
  building.position.set(p.x, p.y - 0.15, p.z);
  building.rotation.y = p.yaw + (side > 0 ? Math.PI : 0) + (trand() - 0.5) * 0.16;
  TG.add(building);

  box(building, 0, h / 2, 0, w, h, d, buildingColors[i % buildingColors.length], 0, true);
  box(building, 0, h + 0.35, 0, w + 0.45, 0.55, d + 0.45, '#f4e8d0', 0, true);
  if (i % 3 === 0) box(building, 0, h + 1.35, 0, w * 0.48, 1.4, d * 0.48, '#78a284', 0, true);

  for (let y = 2.8; y < h - 1; y += 3.3) {
    for (let f = -1; f <= 1; f++) {
      const front = new THREE.Mesh(boxGeo, glassMat);
      front.position.set(f * w * 0.29, y, d / 2 + 0.035);
      front.scale.set(Math.min(1.15, w * 0.16), 1.55, 0.055);
      building.add(front);
      const sideWin = new THREE.Mesh(boxGeo, glassMat);
      sideWin.position.set(w / 2 + 0.035, y, f * d * 0.28);
      sideWin.scale.set(0.055, 1.55, Math.min(1.15, d * 0.17));
      building.add(sideWin);
    }
  }
}

function palm(x, y, z, scale = 1) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.scale.setScalar(scale);
  TG.add(group);
  cylinder(group, 0, 3.8, 0, 0.17, 0.38, 7.6, '#aa8960', 8, true);
  for (let k = 0; k < 7; k++) {
    const a = k / 7 * Math.PI * 2;
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.8, 4.7, 4), material(k % 2 ? '#547f68' : '#6b9670'));
    leaf.castShadow = true;
    leaf.position.set(Math.cos(a) * 1.8, 7.4, Math.sin(a) * 1.8);
    leaf.rotation.set(Math.sin(a) * 1.1, 0, -Math.cos(a) * 1.1);
    group.add(leaf);
  }
}
for (let i = 0; i < 68; i++) {
  const p = trackAt(i / 68 * TRACK_LENGTH, i % 2 ? -15 : 15);
  if (!clearsBroadcastSight(p, 2.4)) continue;
  const pm = prop(i % 2 ? 'palmTall' : 'palm');
  if (pm) {
    pm.position.set(p.x, p.y, p.z);
    pm.rotation.y = trand() * Math.PI * 2;
    const sc = 4.2 + trand() * 1.2;
    pm.scale.set(sc, sc, sc);
    TG.add(pm);
  } else {
    palm(p.x, p.y, p.z, 0.7 + trand() * 0.6);
  }
}
// Trackside rocks & bushes (additive: skipped when models are missing).
for (let i = 0; i < 8; i++) {
  const s = trand() * TRACK_LENGTH, hw = halfWidthAt(s);
  const side = i % 2 ? 1 : -1;
  placeProp('rock', s, side * (hw + 3 + trand() * 7), 5, 5, 5);
}
for (let i = 0; i < 10; i++) {
  const s = trand() * TRACK_LENGTH, hw = halfWidthAt(s);
  const side = i % 2 ? 1 : -1;
  placeProp('bush', s, side * (hw + 2.5 + trand() * 6), 3.5, 3.5, 3.5);
}
for (let i = 0; i < 16; i++) {
  const a = i / 16 * Math.PI * 2;
  sphere(TG, Math.cos(a) * 72, 1, Math.sin(a) * 46, 3 + trand() * 3, '#7fa174', true);
}
for (let i = 0; i < 8; i++) {
  const x = -300 + i * 82;
  const mountain = cylinder(TG, x, 10, -310, 0, 65 + trand() * 40, 90 + trand() * 70, '#8baaa4', 5, false);
  mountain.rotation.y = trand() * 6;
}
for (let i = 0; i < 6; i++) {
  const x = -220 + i * 85, z = -165 - trand() * 90;
  for (let j = 0; j < 3; j++) {
    const cloud = sphere(TG, x + j * 10, 90 + trand() * 6, z, 12, '#e0ecdc', false);
    cloud.scale.set(1.7, 0.6, 1);
  }
}

// ---------------------------------------------------------------------------
// 道具箱高精模型 (Holographic Crystal Item Box with Floating Particles)
// ---------------------------------------------------------------------------
for (let i = 0; i < ITEM_BOXES; i++) {
  const g = new THREE.Group();
  const p = trackAt((i + 1) / ITEM_BOXES * TRACK_LENGTH, ITEM_BOX_LANES[i % 2]);
  g.position.set(p.x, p.y, p.z);
  g.rotation.y = p.yaw;
  TG.add(g);

  // Outer translucent crystal cube
  const core = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.35, 1.35), material('#ffd257', { emissive: '#ff9d2e', emissiveIntensity: 0.65, transparent: true, opacity: 0.88 }));
  core.position.y = 1.15;
  g.add(core);
  g.userData.core = core;

  // Inner spinning golden Question Mark: floats on the crystal face so it
  // reads through the translucency instead of hiding inside it.
  const banner = board(core, 0, 0, 0.72, 1.1, 0.9, '?', 0, '#ffd257', '#3e2723');
  g.userData.banner = banner;

  // Orbiting crystal sparkle satellites
  const sparkles = new THREE.Group();
  core.add(sparkles);
  for (let s = 0; s < 4; s++) {
    const sa = s / 4 * Math.PI * 2;
    const spark = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), material('#fff9c4', { emissive: '#fff', emissiveIntensity: 2 }));
    spark.position.set(Math.cos(sa) * 1.1, Math.sin(sa * 2) * 0.4, Math.sin(sa) * 1.1);
    sparkles.add(spark);
  }
  g.userData.sparkles = sparkles;
  itemBoxMeshes.push(g);
}

} // end buildTrackScenery

// ---------------------------------------------------------------------------
// 道具实体与分层粒子特效 (Missile Rockets, Tripwire Mines, EMP Arcs, Smoke)
// ---------------------------------------------------------------------------
const smokeMat = new THREE.MeshStandardMaterial({ color: '#dfe6e2', roughness: 1, transparent: true, opacity: 0.5, depthWrite: false });

function buildEntityMesh(kind) {
  const g = new THREE.Group();
  if (kind === 'missile') {
    // 3D Supersonic Rocket with 4 Delta Stabilizer Fins
    const body = cylinder(g, 0, 0, 0, 0.18, 0.18, 1.1, '#ff6e40', 12, true);
    body.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 12), material('#ffe082', { emissive: '#ff6e40', emissiveIntensity: 1.2 }));
    tip.rotation.x = Math.PI / 2; tip.position.z = 0.72; g.add(tip);

    // 4 Aerodynamic delta fins
    for (let f = 0; f < 4; f++) {
      const fin = box(g, 0, 0, -0.4, 0.04, 0.46, 0.35, '#37474f');
      fin.rotation.z = f * Math.PI / 4;
    }
    // High-thrust rocket flame
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.9, 8), material('#ffea00', { emissive: '#ff3d00', emissiveIntensity: 3.2 }));
    flame.rotation.x = Math.PI / 2; flame.position.z = -0.92; g.add(flame);

    // Trailing smoke puff particles attached to rocket
    const trail = new THREE.Group();
    g.add(trail);
    g.userData.trail = trail;
    for (let p = 0; p < 5; p++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(0.25 + p * 0.12, 1), smokeMat);
      puff.position.z = -1.2 - p * 0.7;
      trail.add(puff);
    }
  } else if (kind === 'mine') {
    // Spiked Magnetic Naval Mine with Red Laser Tripwire Beams
    const body = sphere(g, 0, 0.38, 0, 0.48, '#263238', true);
    // 8 Protruding trigger horns
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      const horn = cylinder(g, Math.cos(a) * 0.5, 0.38, Math.sin(a) * 0.5, 0.05, 0.08, 0.35, '#ff5722', 6, false);
      horn.rotation.z = Math.PI / 2; horn.rotation.y = -a;
    }
    // Pulsing Hazard Strobe Beacon
    g.userData.light = sphere(g, 0, 0.82, 0, 0.12, '#ff1744', false);

    // 4 Laser Tripwire Beams projected across track lanes
    const lasers = new THREE.Group();
    g.add(lasers);
    for (const rot of [0, Math.PI / 2]) {
      const laser = box(lasers, 0, 0.38, 0, 4.8, 0.03, 0.03, '#ff1744', rot, false);
      laser.material = new THREE.MeshBasicMaterial({ color: '#ff1744', transparent: true, opacity: 0.75 });
    }
    g.userData.lasers = lasers;
  } else if (kind === 'emp') {
    // Expanding Spherical Lightning Dome with Crackling Orbiting Arcs
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1.8, 20, 14), new THREE.MeshBasicMaterial({ color: '#00e5ff', transparent: true, opacity: 0.35, wireframe: true, depthWrite: false }));
    g.add(dome);
    g.userData.dome = dome;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.08, 8, 24), new THREE.MeshBasicMaterial({ color: '#80d8ff', transparent: true, opacity: 0.7 }));
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
    g.userData.ring = ring;
  } else {
    // Dense Volumetric Smoke Puffs
    for (let i = 0; i < 9; i++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(2.0 + Math.random() * 1.5, 1), smokeMat);
      puff.position.set((Math.random() - 0.5) * 7, 0.8 + Math.random() * 2.2, (Math.random() - 0.5) * 7);
      g.add(puff);
    }
  }
  g.visible = false;
  scene.add(g);
  return g;
}

const entityPools = new Map();
function acquireEntityMesh(kind) {
  let pool = entityPools.get(kind);
  if (!pool) { pool = []; entityPools.set(kind, pool); }
  let m = pool.find(x => !x.userData.live);
  if (!m) { m = buildEntityMesh(kind); pool.push(m); }
  m.visible = true;
  return m;
}

function syncEntities(now, dtStep) {
  for (const pool of entityPools.values()) for (const m of pool) m.userData.live = false;
  if (state) for (const e of state.entities) {
    const m = acquireEntityMesh(e.kind);
    m.userData.live = true;
    const p = trackAt(e.s, e.lane);
    if (e.kind === 'missile') {
      m.position.set(p.x, p.y + 0.8, p.z);
      m.rotation.y = p.yaw;
      if (m.userData.trail) {
        m.userData.trail.rotation.z += dtStep * 12;
      }
    } else if (e.kind === 'mine') {
      m.position.set(p.x, p.y + 0.08, p.z);
      m.rotation.y = p.yaw;
      m.userData.light.visible = (now % 600) < 300;
      if (m.userData.lasers) {
        m.userData.lasers.rotation.y += dtStep * 1.5;
      }
    } else if (e.kind === 'emp') {
      m.position.set(p.x, p.y + 0.9, p.z);
      const k = 1.4 + Math.sin(now * 0.02) * 0.45;
      m.userData.dome.scale.set(k * 1.6, 0.7 * k, k * 1.6);
      m.userData.ring.scale.set(k * 1.5, k * 1.5, 1);
    } else {
      m.position.set(p.x, p.y + 0.1, p.z);
      m.rotation.y += dtStep * 0.3;
    }
  }
  for (const pool of entityPools.values()) for (const m of pool) if (!m.userData.live) m.visible = false;
}

// ---------------------------------------------------------------------------
// 赛车高精分件模型、机械联动与 3 款专属皮肤
// ---------------------------------------------------------------------------
const SKINS = [
  // 0: 烈焰疾风 (Crimson Storm)
  { name: '赤潮 01', paint: '#d92525', accent: '#ffca28', aero: '#14171a', numberFg: '#ffffff', numberBg: '#d92525', hub: '#e2e8f0', border: '#ffca28' },
  // 1: 深海雷霆 (Cyber Volt)
  { name: '深海雷霆', paint: '#00a6c0', accent: '#6de300', aero: '#caf0f8', numberFg: '#6de300', numberBg: '#002b36', hub: '#caf0f8', border: '#6de300' },
  // 2: 黑曜极速 (Stealth Apex)
  { name: '黑曜极速', paint: '#1b1e24', accent: '#ff6622', aero: '#2b303c', numberFg: '#ff6622', numberBg: '#111317', hub: '#ffd166', border: '#ffd166' },
  // 3-7: Vibrant Arcade Liveries
  { name: '极光幻紫', paint: '#8338ec', accent: '#ff006e', aero: '#240046', numberFg: '#ffffff', numberBg: '#8338ec', hub: '#e2e8f0', border: '#ff006e' },
  { name: '骄阳冲刺', paint: '#ffb703', accent: '#fb8500', aero: '#023047', numberFg: '#023047', numberBg: '#ffb703', hub: '#e2e8f0', border: '#fb8500' },
  { name: '翡翠狂飙', paint: '#2a9d8f', accent: '#e76f51', aero: '#264653', numberFg: '#ffffff', numberBg: '#2a9d8f', hub: '#e2e8f0', border: '#e76f51' },
  { name: '霓虹夜影', paint: '#f72585', accent: '#4cc9f0', aero: '#3a0ca3', numberFg: '#ffffff', numberBg: '#f72585', hub: '#e2e8f0', border: '#4cc9f0' },
  { name: '蔚蓝守护', paint: '#3a86ff', accent: '#ffbe0b', aero: '#03045e', numberFg: '#ffffff', numberBg: '#3a86ff', hub: '#e2e8f0', border: '#ffbe0b' }
];

// Hyper3D race-ready shells. All eight slots prefer a real GLB; the original
// procedural karts remain as zero-risk loading fallbacks. 01 uses the retained
// split Crimson candidate, while 02-08 prefer the mobile runtime build and can
// fall back to the committed shaded source if runtime assets were not rebuilt.
// Simulation, collision and ranking continue to use the server-side kart body.
const KART_MODEL_FILES = [
  '/assets/models/hyper3d-2026-09-19/crimson-kart-parts-candidate.glb',
  '/assets/models/hyper3d-tech-roster/runtime/02-cobalt-manta.glb',
  '/assets/models/hyper3d-tech-roster/runtime/03-jade-lynx.glb',
  '/assets/models/hyper3d-tech-roster/runtime/04-crimson-kestrel.glb',
  '/assets/models/hyper3d-tech-roster/runtime/05-violet-nautilus.glb',
  '/assets/models/hyper3d-tech-roster/runtime/06-teal-courier.glb',
  '/assets/models/hyper3d-tech-roster/runtime/07-amber-dune.glb',
  '/assets/models/hyper3d-tech-roster/runtime/08-obsidian-pulse.glb',
];
const KART_MODEL_FALLBACK_FILES = [
  null,
  '/assets/models/hyper3d-tech-roster/02-cobalt-manta-shaded.glb',
  '/assets/models/hyper3d-tech-roster/03-jade-lynx-shaded.glb',
  '/assets/models/hyper3d-tech-roster/04-crimson-kestrel-shaded.glb',
  '/assets/models/hyper3d-tech-roster/05-violet-nautilus-shaded.glb',
  '/assets/models/hyper3d-tech-roster/06-teal-courier-shaded.glb',
  '/assets/models/hyper3d-tech-roster/07-amber-dune-shaded.glb',
  '/assets/models/hyper3d-tech-roster/08-obsidian-pulse-shaded.glb',
];
const kartModelLoader = new GLTFLoader();
const kartModelPromises = new Map();
window.__pilotKartModels = {};

// Original hero kart: 赤潮 01. Rounded surfaces use a small bevelled mesh;
// the existing rig owns animation, so this is a visual replacement only.
// Car 0 stays byte-identical; cars 1-7 reuse the same design language with
// their SKINS livery (paint + number + accent details).
const heroGeoCache = new Map();
function buildCrimsonKart(g) {
  buildHeroKart(g, { paint: '#cf292e', numberBg: '#fff0ce', numberFg: '#922328', num: '01', vent: null, hub: null, stripe: '#fff0ce', ball: '#e9b660' });
}
function buildHeroKart(g, livery) {
  const body = g.userData.bodyGroup;
  const flame = g.userData.flameGroup;
  for (const child of [...body.children]) {
    if (child === flame) continue;
    body.remove(child);
    child.traverse(o => {
      if (o.isMesh && o.geometry && o.geometry !== boxGeo) o.geometry.dispose();
    });
  }
  for (const wheel of g.userData.wheelGroups) {
    g.remove(wheel.parent);
    wheel.parent.traverse(o => {
      if (o.isMesh && o.geometry && o.geometry !== boxGeo) o.geometry.dispose();
    });
  }
  const paint = new THREE.MeshPhysicalMaterial({color:livery.paint, roughness:.28, metalness:.22, clearcoat:.8, clearcoatRoughness:.22});
  const cream = material('#fff0ce',{roughness:.38,metalness:.12});
  const dark = material('#172630',{roughness:.65,metalness:.15});
  const rubber = material('#20272c',{roughness:.92});
  const alloy = material('#d4dde0',{roughness:.3,metalness:.65});
  const gold = material('#e9b660',{roughness:.35,metalness:.5});
  const ventMat = livery.vent ? material(livery.vent,{roughness:.35,metalness:.45}) : alloy;
  const hubMat = livery.hub ? material(livery.hub,{roughness:.35,metalness:.45}) : paint;
  const stripeMat = material(livery.stripe,{roughness:.4,metalness:.3});
  const ballMat = material(livery.ball,{roughness:.35,metalness:.5});
  const geometries = heroGeoCache;
  function rounded(w,h,d,r=.08) {
    const key=[w,h,d,r].join(',');
    if(geometries.has(key)) return geometries.get(key);
    const geo=new THREE.BoxGeometry(w,h,d,8,6,8);
    const positions=geo.attributes.position,normals=geo.attributes.normal;
    const core=new THREE.Vector3(),offset=new THREE.Vector3(),v=new THREE.Vector3();
    for(let i=0;i<positions.count;i++){
      v.fromBufferAttribute(positions,i);
      core.set(clamp(v.x,-w/2+r,w/2-r),clamp(v.y,-h/2+r,h/2-r),clamp(v.z,-d/2+r,d/2-r));
      offset.copy(v).sub(core).normalize();v.copy(core).addScaledVector(offset,r);
      positions.setXYZ(i,v.x,v.y,v.z);normals.setXYZ(i,offset.x,offset.y,offset.z);
    }
    geometries.set(key,geo);return geo;
  }
  function part(parent,geo,mat,x,y,z) {
    const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;
  }
  function shell(parent,x,y,z,w,h,d,mat,r=.08){return part(parent,rounded(w,h,d,r),mat,x,y,z);}
  function oval(parent,x,y,z,w,h,d,mat){const m=part(parent,new THREE.SphereGeometry(1,20,12),mat,x,y,z);m.scale.set(w,h,d);return m;}
  function tube(parent,points,r,mat){return part(parent,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),16,r,6,false),mat,0,0,0);}
  const headMat = material('#fff5d6',{emissive:'#ffdfa0',emissiveIntensity:.7});
  // Toy proportions: wide tub, fat nose, chunky pods. Big bevels, few parts.
  shell(body,0,.30,0,2.0,.18,3.0,dark,.07);
  shell(body,0,.55,-.10,2.0,.50,2.2,paint,.18);
  shell(body,0,.55,1.35,1.7,.42,1.0,paint,.16);
  shell(body,0,.78,1.35,1.0,.05,.7,cream,.02);
  shell(body,0,.40,1.82,2.1,.22,.3,dark,.09);
  for(const sign of [-1,1]) {
    shell(body,sign*.5,.60,1.86,.3,.14,.06,headMat,.03);
    shell(body,sign*.95,.50,-.10,.5,.5,1.0,paint,.16);
    shell(body,sign*1.21,.55,-.10,.04,.12,.9,cream,.015);
  }
  // Wide toy wing, fat exhausts, taillight bar + tail number.
  shell(body,0,1.38,-1.5,2.2,.14,.45,cream,.055);
  for(const sign of [-1,1]) {
    shell(body,sign*1.06,1.38,-1.5,.08,.42,.55,paint,.035);
    shell(body,sign*.7,1.08,-1.5,.1,.5,.12,dark,.03);
    const exhaust=part(body,new THREE.CylinderGeometry(.13,.13,.34,16),alloy,sign*.36,.5,-1.60);exhaust.rotation.x=Math.PI/2;
    const hole=part(body,new THREE.CircleGeometry(.095,16),dark,sign*.36,.5,-1.777);hole.rotation.y=Math.PI;
  }
  shell(body,0,.72,-1.215,1.2,.08,.04,material('#f84c42',{emissive:'#ee2e22',emissiveIntensity:.6}),.012);
  board(body,0,.45,-1.215,.5,.36,livery.num,Math.PI,livery.numberBg,livery.numberFg);
  // Upholstered bucket seat, clothed torso, arms and rounded full-face helmet.
  shell(body,0,.72,-.21,.70,.24,.69,dark,.10);
  const seat=shell(body,0,1.02,-.55,.85,.85,.25,dark,.09);seat.rotation.x=-.12;
  shell(body,0,1.10,-.40,.55,.45,.07,material('#3a4650',{roughness:.95}),.025);
  oval(body,0,1.08,-.22,.30,.34,.26,paint);
  for(const sign of [-1,1]) {
    tube(body,[[sign*.24,1.28,-.20],[sign*.36,1.10,.10],[sign*.23,1.13,.48]],.095,paint);
    shell(body,sign*.12,1.20,.099,.055,.35,.032,dark,.015);
  }
  oval(body,0,1.81,-.10,.50,.52,.49,paint);
  const visor=part(body,new THREE.SphereGeometry(.50,24,16,0,Math.PI,.98,.72),material('#142c37',{roughness:.12,metalness:.55}),0,1.81,-.1);
  visor.rotation.y=0;
  // Cartoon visor shine.
  const shine=part(body,new THREE.SphereGeometry(.085,12,8),new THREE.MeshBasicMaterial({color:'#ffffff'}),-.17,1.99,.33);
  shine.castShadow=false;
  // Personality: helmet center stripe + rear antenna ball in livery colors.
  shell(body,0,2.315,-.10,.13,.05,.55,stripeMat,.02);
  part(body,new THREE.CylinderGeometry(.022,.022,.7,8),dark,-.8,1.15,-1.0);
  oval(body,-.8,1.55,-1.0,.085,.085,.085,ballMat);

  shell(body,0,1.56,.22,.55,.13,.20,paint,.05);
  const steering=new THREE.Group();steering.position.set(0,1.15,.55);steering.rotation.x=-.6;body.add(steering);g.userData.steeringGroup=steering;
  part(steering,new THREE.TorusGeometry(.235,.045,8,24),dark,0,0,0);
  shell(steering,0,0,0,.39,.055,.05,alloy,.018);
  oval(steering,0,0,.015,.075,.075,.035,hubMat);
  for(const sign of [-1,1])oval(steering,sign*.22,0,0,.075,.085,.065,cream);
  const badge=board(body,0,.775,1.30,.5,.36,livery.num,0,livery.numberBg,livery.numberFg);badge.rotation.x=-Math.PI/2;
  badge.material.map.dispose();badge.material.dispose();badge.material=label(livery.num,livery.numberBg,livery.numberFg,256,256);
  // Big toy tires; pivots stay on the rig grid so handling never changes.
  g.userData.frontPivots=[];g.userData.wheelGroups=[];
  const tireGeo=new THREE.CylinderGeometry(.5,.5,.42,24,1,false);
  const lipGeo=new THREE.TorusGeometry(.31,.03,6,24);
  for(const x of [-1.02,1.02])for(const z of [-.98,.98]) {
    const sign=Math.sign(x),pivot=new THREE.Group(),spin=new THREE.Group();
    pivot.position.set(x,.5,z);g.add(pivot);pivot.add(spin);
    g.userData.wheelGroups.push(spin);if(z>0)g.userData.frontPivots.push(pivot);
    const tire=part(spin,tireGeo,rubber,0,0,0);tire.rotation.z=Math.PI/2;
    for(const side of [-1,1]) {
      const shoulder=part(spin,new THREE.TorusGeometry(.41,.085,8,24),rubber,side*.16,0,0);shoulder.rotation.y=Math.PI/2;
    }
    const inner=part(spin,new THREE.CylinderGeometry(.3,.3,.03,20),dark,sign*.23,0,0);inner.rotation.z=Math.PI/2;
    const lip=part(spin,lipGeo,alloy,sign*.25,0,0);lip.rotation.y=Math.PI/2;
    for(let k=0;k<5;k++) {
      const a=k*Math.PI*2/5;
      const spoke=shell(spin,sign*.25,Math.cos(a)*.16,Math.sin(a)*.16,.05,.3,.08,alloy,.02);spoke.rotation.x=a;
    }
    const hub=part(spin,new THREE.CylinderGeometry(.09,.09,.05,6),gold,sign*.28,0,0);hub.rotation.z=Math.PI/2;
    for(const side of [-1,1]) {
      const groove=part(spin,new THREE.TorusGeometry(.5,.01,4,24),dark,side*.09,0,0);groove.rotation.y=Math.PI/2;
    }
  }
  g.userData.shadow.scale.set(1.0,1.55,1);
  g.userData.heroKart=true;
}

const carMeshes = [];
for (let id = 0; id < 8; id++) {
  const g = new THREE.Group();
  scene.add(g);
  carMeshes.push(g);

  const skin = SKINS[id];
  // 1. Soft contact ground shadow (always active, perfect on mobile and fallback)
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1.85, 20), new THREE.MeshBasicMaterial({ color: '#102228', transparent: true, opacity: 0.35, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(0.85, 1.45, 1);
  shadow.position.y = 0.012;
  g.add(shadow);
  g.userData.shadow = shadow;

  // 2. Chassis Body Group (for dynamic roll, squat and pitch)
  const bodyGroup = new THREE.Group();
  g.add(bodyGroup);
  g.userData.bodyGroup = bodyGroup;

  // High-gloss car paint & PBR materials
  const paintMat = material(skin.paint, { roughness: 0.22, metalness: 0.38 });
  const accentMat = material(skin.accent, { roughness: 0.25, metalness: 0.3 });
  const aeroMat = material(skin.aero, { roughness: 0.55, metalness: 0.35 });
  const tireMat = material('#16191b', { roughness: 0.94, metalness: 0.02 });
  const brakeRotorMat = material('#cfd8dc', { roughness: 0.12, metalness: 0.92 });
  const brakeCaliperMat = material('#d50000', { roughness: 0.35, metalness: 0.5 });
  const hubMat = material(skin.hub, { roughness: 0.12, metalness: 0.88 });
  const engineMat = material('#37474f', { roughness: 0.25, metalness: 0.85 });

  // Main streamlined chassis
  const chassis = new THREE.Mesh(boxGeo, paintMat);
  chassis.position.set(0, 0.52, 0); chassis.scale.set(1.72, 0.46, 2.85);
  chassis.castShadow = true; chassis.receiveShadow = true; bodyGroup.add(chassis);

  // Aerodynamic Front Nose Cone
  const nose = new THREE.Mesh(boxGeo, paintMat);
  nose.position.set(0, 0.84, 1.05); nose.scale.set(1.48, 0.32, 0.92);
  nose.castShadow = true; nose.receiveShadow = true; bodyGroup.add(nose);

  // Dual Racing Bonnet Stripes
  const stripe = new THREE.Mesh(boxGeo, accentMat);
  stripe.position.set(0, 0.86, 1.05); stripe.scale.set(0.38, 0.33, 0.93);
  stripe.castShadow = true; stripe.receiveShadow = true; bodyGroup.add(stripe);

  // Glowing LED Daytime Running Lights / Headlights
  for (const x of [-0.55, 0.55]) {
    const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.1, 0.08), material('#e0f7fa', { emissive: '#80deea', emissiveIntensity: 3.0 }));
    headlight.position.set(x, 0.85, 1.52);
    bodyGroup.add(headlight);
  }

  // Aerodynamic Front Splitter with Carbon Endplates
  const frontSplitter = new THREE.Mesh(boxGeo, aeroMat);
  frontSplitter.position.set(0, 0.42, 1.6); frontSplitter.scale.set(2.05, 0.12, 0.38);
  frontSplitter.castShadow = true; bodyGroup.add(frontSplitter);
  for (const x of [-1.02, 1.02]) {
    const canard = new THREE.Mesh(boxGeo, accentMat);
    canard.position.set(x, 0.55, 1.58); canard.scale.set(0.08, 0.28, 0.36);
    bodyGroup.add(canard);
  }

  // Streamlined Sidepods with Dark Radiator Grilles
  for (const x of [-0.92, 0.92]) {
    const sidepod = new THREE.Mesh(boxGeo, paintMat);
    sidepod.position.set(x, 0.54, -0.05); sidepod.scale.set(0.32, 0.42, 1.6);
    sidepod.castShadow = true; bodyGroup.add(sidepod);
    // Radiator Intake Vents
    const vent = new THREE.Mesh(boxGeo, material('#101518', { roughness: 0.9 }));
    vent.position.set(x, 0.56, 0.76); vent.scale.set(0.28, 0.34, 0.06);
    bodyGroup.add(vent);
  }

  // Exposed V-Twin / Turbo Engine Block Behind Cockpit
  const engineBlock = new THREE.Mesh(boxGeo, engineMat);
  engineBlock.position.set(0, 0.78, -0.92); engineBlock.scale.set(0.9, 0.45, 0.68);
  engineBlock.castShadow = true; bodyGroup.add(engineBlock);
  // Chrome Intake Manifolds
  for (const x of [-0.25, 0.25]) {
    cylinder(bodyGroup, x, 1.08, -0.92, 0.12, 0.12, 0.35, '#eceff1', 8, true);
  }
  // Polished Dual Exhaust Pipes
  for (const x of [-0.36, 0.36]) {
    const exhaust = cylinder(bodyGroup, x, 0.56, -1.56, 0.11, 0.14, 0.42, '#cfd8dc', 10, true);
    exhaust.rotation.x = Math.PI / 2;
  }

  // Cockpit & Articulated Driver
  const cockpitBlock = new THREE.Mesh(boxGeo, material('#1e2d33', { roughness: 0.3, metalness: 0.7 }));
  cockpitBlock.position.set(0, 0.95, -0.08); cockpitBlock.scale.set(0.8, 0.6, 0.85);
  cockpitBlock.castShadow = true; bodyGroup.add(cockpitBlock);

  // Driver Head & Aerodynamic Helmet
  const driverHead = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), material('#ffe0b2', { roughness: 0.6 }));
  driverHead.position.set(0, 1.52, -0.08); driverHead.castShadow = true; bodyGroup.add(driverHead);

  const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.48, 1), paintMat);
  helmet.position.set(0, 1.95, -0.08); helmet.castShadow = true; bodyGroup.add(helmet);

  const visor = new THREE.Mesh(boxGeo, material('#102027', { roughness: 0.08, metalness: 0.92 }));
  visor.position.set(0, 1.96, 0.31); visor.scale.set(0.68, 0.2, 0.1); bodyGroup.add(visor);

  // Driver Steering Wheel & Articulated Hands
  const steeringGroup = new THREE.Group();
  steeringGroup.position.set(0, 1.15, 0.55);
  steeringGroup.rotation.x = -0.6;
  bodyGroup.add(steeringGroup);
  g.userData.steeringGroup = steeringGroup;

  const steeringWheel = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.06, 6, 16), material('#213b42'));
  steeringGroup.add(steeringWheel);
  for (const x of [-0.22, 0.22]) {
    // Driver racing gloves
    const hand = sphere(steeringGroup, x, 0.02, 0, 0.08, skin.accent);
    hand.scale.set(1, 0.8, 1.2);
  }

  // GT Swan-Neck Rear Wing
  const wing = new THREE.Mesh(boxGeo, aeroMat);
  wing.position.set(0, 1.32, -1.52); wing.scale.set(2.18, 0.12, 0.46);
  wing.castShadow = true; bodyGroup.add(wing);
  // Swan-neck carbon wing struts
  for (const x of [-0.55, 0.55]) {
    const strut = cylinder(bodyGroup, x, 1.05, -1.48, 0.05, 0.06, 0.65, '#263238', 6, true);
    strut.rotation.x = 0.25;
  }
  // Wing endplates with accent skin color
  for (const x of [-1.1, 1.1]) {
    const endplate = new THREE.Mesh(boxGeo, accentMat);
    endplate.position.set(x, 1.32, -1.52); endplate.scale.set(0.06, 0.42, 0.52);
    bodyGroup.add(endplate);
  }

  // Dual-Stage Plasma Exhaust Flame
  const flameGroup = new THREE.Group();
  flameGroup.position.set(0, 0.56, -2.4);
  bodyGroup.add(flameGroup);
  g.userData.flameGroup = flameGroup;
  // Inner bright white/cyan core
  const flameCore = new THREE.Mesh(new THREE.ConeGeometry(0.22, 2.1, 8), material('#e0f7fa', { emissive: '#80deea', emissiveIntensity: 3.5 }));
  flameCore.rotation.x = -Math.PI / 2;
  flameGroup.add(flameCore);
  // Outer fiery plasma plume
  const flameOuter = new THREE.Mesh(new THREE.ConeGeometry(0.36, 2.6, 8), material('#7c4dff', { emissive: '#651fff', emissiveIntensity: 2.2, transparent: true, opacity: 0.75 }));
  flameOuter.rotation.x = -Math.PI / 2;
  flameGroup.add(flameOuter);
  flameGroup.visible = false;

  // Prominent High-Contrast Number Badges (visible from far distances)
  const numStr = String(id + 1).padStart(2, '0');
  const numHood = board(bodyGroup, 0, 1.02, 1.01, 0.58, 0.5, numStr, -Math.PI / 2, skin.numberBg, skin.numberFg, skin.border);
  numHood.rotation.x = -Math.PI / 2;
  const numWing = board(bodyGroup, 0, 1.4, -1.52, 0.52, 0.38, numStr, -Math.PI / 2, skin.numberBg, skin.numberFg);
  numWing.rotation.x = -Math.PI / 2;

  // ---------------------------------------------------------------------------
  // 机械车轮组: 转向联动 (Front Steering Pivot) & 真实转动 (Wheel Spin)
  // ---------------------------------------------------------------------------
  const wheelGroups = [];
  const frontPivots = [];

  function createWheelAssembly(x, z, isFront) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.4, z);
    g.add(pivot);

    const spinGroup = new THREE.Group();
    pivot.add(spinGroup);
    wheelGroups.push(spinGroup);

    // Treaded Rubber Tire
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.3, 16), tireMat);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true; tire.receiveShadow = true;
    spinGroup.add(tire);

    // Drilled Metallic Brake Rotor
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.04, 16), brakeRotorMat);
    rotor.position.x = x > 0 ? -0.12 : 0.12;
    rotor.rotation.z = Math.PI / 2;
    spinGroup.add(rotor);

    // Fixed Sport Brake Caliper (mounted to pivot, does not spin with rotor)
    const caliper = new THREE.Mesh(boxGeo, brakeCaliperMat);
    caliper.position.set(x > 0 ? -0.12 : 0.12, 0.16, 0);
    caliper.scale.set(0.06, 0.16, 0.22);
    pivot.add(caliper);

    // 5-Spoke Alloy Wheel Hub & Center Nut
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 12), hubMat);
    hub.position.x = x > 0 ? 0.16 : -0.16;
    hub.rotation.z = Math.PI / 2;
    spinGroup.add(hub);

    if (isFront) frontPivots.push(pivot);
  }

  for (const x of [-1.02, 1.02]) {
    createWheelAssembly(x, 0.98, true);   // Front wheels with steering pivot
    createWheelAssembly(x, -0.98, false); // Rear drive wheels
  }

  g.userData.wheelGroups = wheelGroups;
  g.userData.frontPivots = frontPivots;
  if (id === 0) {
    buildCrimsonKart(g);
  } else {
    buildHeroKart(g, {
      paint: skin.paint,
      numberBg: skin.numberBg,
      numberFg: skin.numberFg,
      num: String(id + 1).padStart(2, '0'),
      vent: skin.accent,
      hub: skin.accent,
      stripe: skin.accent,
      ball: skin.accent,
    });
  }

  // ---------------------------------------------------------------------------
  // 道具与状态力场: 六角晶格脉冲护盾、闪电环与炫晕星
  // ---------------------------------------------------------------------------
  const shieldAura = new THREE.Group();
  shieldAura.position.y = 1.05;
  g.add(shieldAura);
  // Dual forcefield shells
  const shieldSphere = new THREE.Mesh(new THREE.IcosahedronGeometry(2.35, 2), new THREE.MeshBasicMaterial({ color: '#5eead4', transparent: true, opacity: 0.32, depthWrite: false }));
  shieldAura.add(shieldSphere);
  const shieldRings = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.06, 8, 32), new THREE.MeshBasicMaterial({ color: '#26c6da', transparent: true, opacity: 0.75 }));
  shieldAura.add(shieldRings);
  shieldAura.visible = false;
  g.userData.shield = shieldAura;

  const shock = new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 1), new THREE.MeshBasicMaterial({ color: '#9fd9ff', transparent: true, opacity: 0.22, depthWrite: false, wireframe: true }));
  shock.position.y = 1.0; shock.visible = false; g.add(shock); g.userData.shock = shock;

  const dizzy = new THREE.Group();
  dizzy.position.y = 2.9; dizzy.visible = false; g.add(dizzy); g.userData.dizzy = dizzy;
  for (let k = 0; k < 3; k++) {
    sphere(dizzy, Math.cos(k / 3 * Math.PI * 2) * 0.7, 0, Math.sin(k / 3 * Math.PI * 2) * 0.7, 0.12, '#ffd257');
  }

  // Floating number + nickname tag (commentator readability). Scene-level so
  // it survives body rebuilds; texture redrawn only when identity changes.
  const tagCanvas = document.createElement('canvas');
  tagCanvas.width = 256; tagCanvas.height = 96;
  const tagTex = new THREE.CanvasTexture(tagCanvas);
  tagTex.colorSpace = THREE.SRGBColorSpace;
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthWrite: false }));
  tag.scale.set(3.4, 1.28, 1);
  tag.renderOrder = 20;
  scene.add(tag);
  g.userData.nameTag = tag;
}

function addRuntimePilot(body, id) {
  const skin = SKINS[id];
  const pilot = new THREE.Group();
  pilot.name = 'tech-pilot';
  pilot.position.set(0, 0.03, -0.08);
  body.add(pilot);

  const suit = material('#17242c', { roughness: 0.72, metalness: 0.12 });
  const trim = material(skin.accent, { roughness: 0.32, metalness: 0.45 });
  const helmetMat = material(skin.paint, { roughness: 0.24, metalness: 0.32 });
  const visorMat = material('#07151d', { roughness: 0.08, metalness: 0.8 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.42, 5, 10), suit);
  torso.position.set(0, 1.02, -0.18); torso.rotation.x = -0.13; torso.castShadow = true; pilot.add(torso);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.31), trim);
  chest.position.set(0, 1.14, 0.02); chest.rotation.x = -0.15; chest.castShadow = true; pilot.add(chest);
  const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.38, 2), helmetMat);
  helmet.scale.set(1, 1.05, 0.92); helmet.position.set(0, 1.58, -0.09); helmet.castShadow = true; pilot.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.37, 18, 10, 0.2, Math.PI - 0.4, 0.72, 0.8), visorMat);
  visor.position.set(0, 1.57, -0.02); visor.rotation.y = Math.PI; visor.castShadow = true; pilot.add(visor);
  for (const sign of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.38, 4, 8), suit);
    arm.position.set(sign * 0.24, 1.14, 0.22); arm.rotation.z = sign * 0.55; arm.rotation.x = -0.55; arm.castShadow = true; pilot.add(arm);
  }
  const steering = new THREE.Group();
  steering.position.set(0, 1.12, 0.48); steering.rotation.x = -0.58; pilot.add(steering);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.035, 7, 18), suit);
  steering.add(wheel);
  carMeshes[id].userData.steeringGroup = steering;
}

function installRuntimeKart(id, source) {
  const g = carMeshes[id];
  if (!g || g.userData.runtimeKart) return;
  const body = g.userData.bodyGroup;
  const flame = g.userData.flameGroup;

  // The old shell stays visible until this point, so a failed request always
  // leaves a complete playable kart instead of an empty chassis.
  for (const child of [...body.children]) if (child !== flame) body.remove(child);
  for (const wheel of g.userData.wheelGroups || []) {
    if (wheel.parent?.parent === g) g.remove(wheel.parent);
  }
  g.userData.wheelGroups = [];
  g.userData.frontPivots = [];

  const modelRoot = new THREE.Group();
  modelRoot.name = `hyper3d-kart-${String(id + 1).padStart(2, '0')}`;
  const model = source.clone(true);
  model.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of materials) {
      if (!mat) continue;
      if (mat.map) mat.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      if ('envMapIntensity' in mat) mat.envMapIntensity = Math.max(mat.envMapIntensity || 0, 1.05);
      if ('roughness' in mat) mat.roughness = clamp(mat.roughness, 0.18, 0.82);
    }
  });
  modelRoot.add(model);
  body.add(modelRoot);

  // Preserve any authored wheel hierarchy. Crimson 01 exposes these nodes and
  // therefore keeps real steering/wheel spin; one-piece roster shells safely
  // fall back to whole-body animation.
  const steerNames = ['steer_front_xpos', 'steer_front_xneg'];
  const wheelNames = [
    'wheel_front_xpos', 'wheel_front_xneg',
    'wheel_rear_xpos', 'wheel_rear_xneg',
  ];
  const authoredSteer = steerNames.map(name => model.getObjectByName(name)).filter(Boolean);
  const authoredWheels = wheelNames.map(name => model.getObjectByName(name)).filter(Boolean);
  if (authoredSteer.length) g.userData.frontPivots = authoredSteer;
  if (authoredWheels.length) g.userData.wheelGroups = authoredWheels;

  const rawBox = new THREE.Box3().setFromObject(model);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const scale = 3.85 / Math.max(0.01, rawSize.z);
  model.scale.setScalar(scale);
  const scaledBox = new THREE.Box3().setFromObject(model);
  const center = scaledBox.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y += 0.018 - scaledBox.min.y;

  addRuntimePilot(body, id);
  const skin = SKINS[id];
  const number = String(id + 1).padStart(2, '0');
  const hood = board(body, 0, 1.02, 1.23, 0.56, 0.42, number, 0, skin.numberBg, skin.numberFg, skin.border);
  hood.rotation.x = -Math.PI / 2;
  const rear = board(body, 0, 1.18, -1.72, 0.52, 0.38, number, Math.PI, skin.numberBg, skin.numberFg, skin.border);
  g.userData.shadow.scale.set(1.02, 1.58, 1);
  g.userData.runtimeKart = true;
}

async function loadRuntimeKart(id) {
  if (!KART_MODEL_FILES[id] || carMeshes[id]?.userData.runtimeKart) return;
  if (!kartModelPromises.has(id)) {
    window.__pilotKartModels[id + 1] = 'loading';
    kartModelPromises.set(id, (async () => {
      const urls = [KART_MODEL_FILES[id], KART_MODEL_FALLBACK_FILES[id]].filter(Boolean);
      let lastError;
      for (let sourceIndex = 0; sourceIndex < urls.length; sourceIndex++) {
        try {
          const gltf = await kartModelLoader.loadAsync(urls[sourceIndex]);
          installRuntimeKart(id, gltf.scene);
          window.__pilotKartModels[id + 1] =
            sourceIndex === 0 ? 'hyper3d' : 'hyper3d-source-fallback';
          return;
        } catch (error) {
          lastError = error;
        }
      }
      console.warn(`Hyper3D kart ${id + 1} unavailable; using procedural fallback.`, lastError);
      window.__pilotKartModels[id + 1] = 'fallback';
    })());
  }
  return kartModelPromises.get(id);
}

function loadRuntimeRoster(playerId = null) {
  // A phone only downloads its own kart. The display loads the full grid.
  if (playerId !== null) return loadRuntimeKart(playerId);
  return Promise.allSettled(KART_MODEL_FILES.map((_, id) => loadRuntimeKart(id)));
}

if (spectator) loadRuntimeRoster();

// Redraw one name tag: live rank plate + nickname, SKINS colors.
function drawNameTag(tag, id, name, rank) {
  const skin = SKINS[id];
  const c = tag.material.map.image, ctx = c.getContext('2d');
  const num = String(rank).padStart(2, '0');
  ctx.clearRect(0, 0, 256, 96);
  const r = 20;
  ctx.beginPath();
  ctx.moveTo(r, 2);
  ctx.lineTo(256 - r, 2); ctx.quadraticCurveTo(254, 2, 254, r);
  ctx.lineTo(254, 96 - r); ctx.quadraticCurveTo(254, 94, 256 - r, 94);
  ctx.lineTo(r, 94); ctx.quadraticCurveTo(2, 94, 2, 96 - r);
  ctx.lineTo(2, r); ctx.quadraticCurveTo(2, 2, r, 2);
  ctx.closePath();
  ctx.fillStyle = skin.numberBg; ctx.globalAlpha = 0.92; ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = skin.numberFg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '900 52px system-ui, sans-serif';
  ctx.fillText(num, 44, 50, 76);
  ctx.fillRect(84, 18, 3, 60);
  let size = 30;
  ctx.font = `700 ${size}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
  while (size > 14 && ctx.measureText(name).width > 152) {
    size -= 2;
    ctx.font = `700 ${size}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
  }
  ctx.fillText(name, 168, 50, 152);
  tag.material.map.needsUpdate = true;
  tag.userData.key = `${rank}|${name}`;
}

// Driver-view smoke veil
const smokeFog = $('smoke-fog');
function smokeVolumeAt(carS) {
  if (!state) return 0;
  let v = 0;
  for (const e of state.entities) if (e.kind === 'smoke') {
    const d = Math.abs(wrap(carS - e.s + TRACK_LENGTH / 2, TRACK_LENGTH) - TRACK_LENGTH / 2);
    v = Math.max(v, 1 - d / SMOKE_RADIUS);
  }
  return Math.max(0, v);
}

// Camera-space bonnet & wheel
const cockpit = new THREE.Group();
camera.add(cockpit);
scene.add(camera);
box(cockpit, 0, -0.83, -1.2, 1.28, 0.3, 0.8, '#d92525', 0, false);
box(cockpit, 0, -0.66, -0.87, 1.1, 0.13, 0.2, '#182d36', 0, false);
const wheelMesh = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.033, 8, 24), material('#213b42'));
wheelMesh.position.set(0, -0.48, -0.95);
cockpit.add(wheelMesh);
box(cockpit, 0, -0.48, -0.95, 0.36, 0.025, 0.025, '#bacdc3', 0, false);
cockpit.visible = false;
// First-person bonnet uses the same red/ivory language as the hero exterior.
const heroBonnet = new THREE.Group();cockpit.add(heroBonnet);
const bonnetMat = new THREE.MeshStandardMaterial({color:'#cf292e',roughness:.28,metalness:.22});
let bonnetSkin = -1;
const bonnet = new THREE.Mesh(new THREE.SphereGeometry(1,24,12),bonnetMat);
bonnet.position.set(0,-.89,-1.25);bonnet.scale.set(.68,.25,.53);heroBonnet.add(bonnet);
for(const x of [-.15,.15])box(heroBonnet,x,-.665,-1.34,.07,.015,.34,'#fff0ce',0,false);
const originalBonnet = cockpit.children.filter(c=>c!==heroBonnet&&c!==wheelMesh&&c.position.y<-.6);
const kartPreview = new URL(location.href).searchParams.get('kart') === '1';
let previewYaw=-.35,previewPointer=null,previewX=0;
if(kartPreview){
  document.querySelectorAll('#game-surface > :not(canvas)').forEach(el=>el.style.display='none');
  scene.background=new THREE.Color('#d9e3df');scene.fog=null;
  for(const child of scene.children)if(child!==carMeshes[0]&&child!==camera&&!child.isLight)child.visible=false;
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),material('#d9e3df',{roughness:.9}));
  floor.rotation.x=-Math.PI/2;floor.position.y=-.02;floor.receiveShadow=true;floor.userData.kartStage=true;scene.add(floor);
  surface.addEventListener('pointerdown',e=>{if(previewPointer!==null)return;previewPointer=e.pointerId;previewX=e.clientX;surface.setPointerCapture(e.pointerId);});
  surface.addEventListener('pointermove',e=>{if(e.pointerId===previewPointer){previewYaw+=(e.clientX-previewX)*.01;previewX=e.clientX;}});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])surface.addEventListener(type,e=>{if(e.pointerId===previewPointer)previewPointer=null;});
  const caption=document.createElement('div');caption.textContent='赤潮 01  /  CRIMSON TIDE';
  caption.style.cssText='position:absolute;left:28px;top:28px;color:#253c40;font:700 22px system-ui;letter-spacing:3px;pointer-events:none';surface.append(caption);
}


// ---------------------------------------------------------------------------
// 触控输入与全局指针防卡键系统 (100% Anti-Sticking Controls)
// ---------------------------------------------------------------------------
const keys = { left: false, right: false, drift: false, brake: false };
function capturePointer(el, pointerId) { try { el.setPointerCapture(pointerId); } catch {} }

let analogSteer = 0;
let stickPointer = null;
let itemPointer = null;
const controlPointers = new Map(); // buttonElement -> pointerId

let myItem = null, fxChips = [], toastUntil = 0, hlsTop = -1, lastSelfAt = -1, useSentAt = 0, lastFeatureAt = -1;
const stick = $('joystick'), thumb = $('stick-thumb');
let boost = false, socket = null, myId = null, seq = 0, state = null, lastStateAt = 0;
let lastSelfBoost = 0;
let role = spectator ? 'display' : 'preview', pending = null, manualId = null, auto = true, angle = 0, firstPerson = true;
let manualTemplateId = null, liveTemplateId = null, cameraCutKey = '';
let retry = null, round = -1, frameCount = 0, fps = 0, fpsAt = performance.now(), lastUi = 0;
let perfFrames = 0, perfAt = performance.now();
let token = '';

try {
  token = sessionStorage.getItem(`pilot:${code}`) || '';
  $('name').value = hubName || localStorage.getItem('pilot:name') || '';
} catch {
  if (hubName) $('name').value = hubName;
}

let userExited = false;
const error = message => { $('error').hidden = false; $('error').textContent = message; };

function connect() {
  clearTimeout(retry);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/socket`);
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    seq = 0;
    ws.send(JSON.stringify(pending ? { v: 1, type: 'hello', role: 'player', code, name: pending.name, token } : { v: 1, type: 'hello', role: 'display' }));
  };
  ws.onmessage = async ev => {
    if (socket !== ws) return;
    const m = JSON.parse(ev.data);
    if (m.type === 'error') { error(m.message); $('join-form').querySelector('button').disabled = false; return; }
    if (m.type === 'left') {
      userExited = true;
      try { sessionStorage.removeItem(`pilot:${code}`); } catch {}
      token = null; myId = null; role = null; lastSelfBoost = 0;
      document.body.classList.remove('driving');
      return;
    }
    if (m.type === 'welcome') {
      $('error').hidden = true;
      if (m.role === 'player') {
        myId = m.id;
        token = m.token;
        role = 'player';
        document.body.classList.add('driving');
        loadRuntimeRoster(myId);
        try { sessionStorage.setItem(`pilot:${code}`, token); localStorage.setItem('pilot:name', m.name); } catch {}
      } else {
        loadRuntimeRoster();
      }
      return;
    }
    if (m.type === 'state') {
      state = m;
      lastStateAt = performance.now();
      // Track switch (big-screen select in lobby): swap physics + scenery,
      // snap cars so they don't glide across the old map. Single-flight:
      // snapshots arrive at 30 Hz while models load, so concurrent rebuilds
      // must collapse into one or they tear each other's scene down.
      if (m.trackId && m.trackId !== builtTrackId && !buildPending) {
        buildPending = (async () => {
          try {
            await modelsReady;
            const latest = state;
            if (latest && latest.trackId && latest.trackId !== builtTrackId && useTrack(latest.trackId)) {
              buildTrackScenery(latest.trackId);
              if (trackGroup) {
                if (beaconRay) beaconRay.userData.dynamicScenery = true;
                if (gantryMount?.parent) gantryMount.parent.userData.dynamicScenery = true;
                for (const item of itemBoxMeshes) item.userData.dynamicScenery = true;
                for (const item of chevronPanels) item.group.userData.dynamicScenery = true;
                const removedCalls = batchStaticScenery(trackGroup);
                try { window.__pilotSceneBatches = removedCalls; } catch {}
              }
              for (const c of latest.cars) {
                carMeshes[c.id].userData.s = c.s;
                carMeshes[c.id].userData.lane = c.lane;
              }
            }
          } catch (e) {
            try { window.__pilotBuildErr = String(e && e.message || e); } catch {}
          } finally {
            buildPending = null;
          }
        })();
      }
      if (round !== m.round) {
        round = m.round;
        for (const c of m.cars) {
          carMeshes[c.id].userData.s = c.s;
          carMeshes[c.id].userData.lane = c.lane;
        }
      }
      updateItemUi(m);
      renderHighlights(m);
      renderDuel(m);
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    if (userExited) return;
    $('connection').textContent = hubMode && hubRound
      ? '本轮连接已结束 · 正在确认现场状态'
      : '连接断开 · 正在回到比赛';
    clearControls();

    if (hubMode && hubRound && !spectator) {
      void handleHubDisconnect();
      return;
    }

    retry = setTimeout(connect, 1200);
  };
  ws.onerror = () => {
    if (socket === ws && !userExited) $('connection').textContent = '无法连接 · 检查是否处于同一 Wi-Fi';
  };
}

async function handleHubDisconnect() {
  const hubApi =
    location.protocol + '//' + location.hostname + ':3001/api/platform/rounds';

  try {
    const response = await fetch(hubApi, { cache: 'no-store' });
    if (response.ok) {
      const payload = await response.json();
      const hostedRound = payload.rounds?.find(
        candidate => candidate.code === hubRound,
      );

      if (
        !hostedRound ||
        ['finished', 'cancelled', 'expired'].includes(hostedRound.status)
      ) {
        userExited = true;
        const returnUrl =
          location.protocol +
          '//' +
          location.hostname +
          ':5177/join/' +
          encodeURIComponent(hubRound);
        location.replace(returnUrl);
        return;
      }
    }
  } catch {
    // A transient Hub/API failure should not strand the player. Fall through
    // to the normal short reconnect loop and check again on the next close.
  }

  retry = setTimeout(connect, 1200);
}

if (hubName && !spectator) {
  pending = { name: hubName };
} else if (token && !spectator) {
  pending = { name: $('name').value || '车手' };
}
connect();

$('join-form').addEventListener('submit', e => {
  e.preventDefault();
  pending = { name: $('name').value.trim() || '车手' };
  $('join-form').querySelector('button').disabled = true;
  const old = socket; socket = null; old?.close();
  connect();
});

function clearControls() {
  for (const k in keys) keys[k] = false;
  boost = false;
  resetStick();
  releaseItemButton();
  for (const [b] of controlPointers.entries()) {
    b.classList.remove('pressed');
  }
  controlPointers.clear();
  document.querySelectorAll('[data-control]').forEach(b => b.classList.remove('pressed'));
  sendInput(true);
}

const PRESET_NICKNAMES = [
  '海湾车神', '极速闪电', '秋名山车神', '旋风阿冲', '超车狂人',
  '飞天小钢炮', '海风掠影', '涡轮增压喵', '漂移宗师', '贴地飞行员'
];

function getRandomNickname() {
  return PRESET_NICKNAMES[Math.floor(Math.random() * PRESET_NICKNAMES.length)];
}

const nameInput = $('name');
const randomBtn = $('random-name-btn');
const quickNamesEl = $('quick-names');

if (nameInput) {
  if (hubName) {
    nameInput.value = hubName;
  } else {
    try {
      const saved = localStorage.getItem('pilot:name');
      if (saved && saved.trim()) {
        nameInput.value = saved.trim();
      } else {
        nameInput.value = getRandomNickname();
      }
    } catch {
      nameInput.value = getRandomNickname();
    }
  }
}

if (randomBtn && nameInput) {
  randomBtn.addEventListener('click', () => {
    let next;
    for (let i = 0; i < 5; i++) {
      next = getRandomNickname();
      if (next !== nameInput.value) break;
    }
    nameInput.value = next;
  });
}

if (quickNamesEl && nameInput) {
  const chips = ['海湾车神', '极速闪电', '旋风阿冲', '漂移宗师'];
  quickNamesEl.replaceChildren();
  for (const name of chips) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'name-chip';
    chip.textContent = name;
    chip.addEventListener('click', () => {
      nameInput.value = name;
    });
    quickNamesEl.append(chip);
  }
}

let lastInputSend = 0;
function sendInput(force = false) {
  if (socket?.readyState !== WebSocket.OPEN || myId === null) return;
  const now = performance.now();
  if (!force && now - lastInputSend < 38) return;
  lastInputSend = now;
  socket.send(JSON.stringify({
    v: 1,
    type: 'input',
    seq: ++seq,
    steer: clamp(analogSteer + Number(keys.right) - Number(keys.left), -1, 1),
    drift: keys.drift,
    brake: keys.brake,
    boost
  }));
  boost = false;
}

const itemButton = $('item-button');
function releaseItemButton() {
  if (itemPointer !== null) {
    if (itemButton.hasPointerCapture(itemPointer)) itemButton.releasePointerCapture(itemPointer);
    itemPointer = null;
  }
  itemButton.classList.remove('pressed');
}

function triggerItem() {
  if (socket?.readyState !== WebSocket.OPEN || myId === null) return;
  if (myItem) audio.playItemUse(myItem);
  socket.send(JSON.stringify({ v: 1, type: 'use' }));
  useSentAt = performance.now();
  itemButton.classList.remove('ready');
  itemButton.classList.add('cooldown');
  $('item-state').textContent = '使用中…';
}

itemButton.addEventListener('pointerdown', e => {
  audio.init();
  if (itemPointer !== null) return;
  e.preventDefault();
  itemPointer = e.pointerId;
  capturePointer(itemButton, e.pointerId);
  itemButton.classList.add('pressed');
  triggerItem();
});
itemButton.addEventListener('contextmenu', e => e.preventDefault());

addEventListener('keydown', e => {
  if (document.activeElement?.tagName === 'INPUT') return;
  if (e.code === 'KeyE' && !e.repeat) { audio.init(); triggerItem(); }
});

setInterval(sendInput, 50);

function resetStick() {
  const oldPointer = stickPointer;
  stickPointer = null;
  analogSteer = 0;
  if (oldPointer !== null && stick.hasPointerCapture(oldPointer)) stick.releasePointerCapture(oldPointer);
  thumb.style.transform = 'translate(-50%,-50%)';
  stick.classList.remove('held');
  stick.setAttribute('aria-valuenow', '0');
}

function moveStick(e) {
  const rect = stick.getBoundingClientRect();
  const delta = surfaceDelta(e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2, layout.rotated);
  const input = joystickInput(delta.x, delta.y, rect.width * 0.31);
  analogSteer = input.steer;
  thumb.style.transform = `translate(calc(-50% + ${input.x}px),calc(-50% + ${input.y}px))`;
  stick.setAttribute('aria-valuenow', String(Math.round(analogSteer * 100)));
}

stick.addEventListener('pointerdown', e => {
  audio.init();
  if (stickPointer !== null) return;
  e.preventDefault();
  stickPointer = e.pointerId;
  capturePointer(stick, e.pointerId);
  stick.classList.add('held');
  moveStick(e);
});

stick.addEventListener('pointermove', e => {
  if (e.pointerId === stickPointer) {
    e.preventDefault();
    moveStick(e);
  }
});

// Window-level robust pointer release (Prevents any sticking / 卡键)
function releaseControlBtn(b) {
  controlPointers.delete(b);
  b.classList.remove('pressed');
  const key = b.dataset.control;
  if (key && key !== 'boost') {
    keys[key] = false;
  }
}

function handleGlobalPointerUp(e) {
  if (e.pointerId === stickPointer) {
    resetStick();
    sendInput(true);
  }
  if (e.pointerId === itemPointer) {
    releaseItemButton();
  }
  for (const [b, pid] of controlPointers.entries()) {
    if (pid === e.pointerId) {
      releaseControlBtn(b);
      sendInput(true);
    }
  }
}

window.addEventListener('pointerup', handleGlobalPointerUp, { capture: true });
window.addEventListener('pointercancel', handleGlobalPointerUp, { capture: true });
window.addEventListener('touchend', e => {
  if (e.touches && e.touches.length === 0) {
    clearControls();
  }
}, { passive: true });

for (const event of ['selectstart', 'contextmenu', 'dragstart']) {
  document.addEventListener(event, e => { if (!e.target.closest('input,textarea')) e.preventDefault(); });
}

for (const b of document.querySelectorAll('[data-control]')) {
  const key = b.dataset.control;
  b.addEventListener('pointerdown', e => {
    audio.init();
    if (controlPointers.has(b)) return;
    e.preventDefault();
    controlPointers.set(b, e.pointerId);
    capturePointer(b, e.pointerId);
    b.classList.add('pressed');
    if (key === 'boost') {
      boost = true;
      audio.playNitro();
    } else {
      keys[key] = true;
      if (key === 'drift') audio.playDrift();
    }
    sendInput(true);
  });
  b.addEventListener('contextmenu', e => e.preventDefault());
}

const mapping = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ShiftLeft: 'drift', ShiftRight: 'drift', ArrowDown: 'brake', KeyS: 'brake' };
addEventListener('keydown', e => {
  if (document.activeElement?.tagName === 'INPUT') return;
  audio.init();
  if (mapping[e.code]) {
    e.preventDefault();
    keys[mapping[e.code]] = true;
    if (mapping[e.code] === 'drift') audio.playDrift();
  }
  if (e.code === 'Space' && !e.repeat) {
    if (role === 'player') {
      e.preventDefault();
      boost = true;
      audio.playNitro();
      sendInput(true);
    } else if (state?.phase === 'lobby' || state?.phase === 'demo') {
      e.preventDefault();
      requestStartRace();
    }
  }
  if (e.code === 'Enter' && !e.repeat && (state?.phase === 'lobby' || state?.phase === 'demo')) {
    e.preventDefault();
    requestStartRace();
  }
});

addEventListener('keyup', e => {
  if (mapping[e.code]) {
    keys[mapping[e.code]] = false;
    sendInput(true);
  }
});

addEventListener('blur', clearControls);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearControls(); });

function requestStartRace() {
  audio.init();
  if (role === 'player') {
    toggleReady();
    return;
  }
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ v: 1, type: 'start' }));
  }
}

function toggleReady() {
  audio.init();
  if (socket?.readyState === WebSocket.OPEN && role === 'player' && myId !== null && state?.cars[myId]) {
    const curReady = Boolean(state.cars[myId].ready);
    socket.send(JSON.stringify({ v: 1, type: 'ready', ready: !curReady }));
  }
}

function leaveRoom() {
  userExited = true;
  if (socket?.readyState === WebSocket.OPEN && role === 'player') {
    try { socket.send(JSON.stringify({ v: 1, type: 'leave' })); } catch {}
  }
  try { sessionStorage.removeItem(`pilot:${code}`); } catch {}
  token = null;
  role = null;
  myId = null;
  document.body.classList.remove('driving');
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  const lobbyCard = $('lobby-card');
  if (lobbyCard) lobbyCard.hidden = true;
  $('results').hidden = true;
  $('join').hidden = false;
  $('join-form').reset();
  const joinBtn = $('join-form').querySelector('button');
  if (joinBtn) joinBtn.disabled = false;
  error('已退出比赛房间，可重新输入昵称或扫码加入');
  setTimeout(() => { userExited = false; }, 250);
}

$('start-race').onclick = requestStartRace;
const bStart = $('broadcast-start');
if (bStart) bStart.onclick = requestStartRace;
const pReady = $('player-ready-btn');
if (pReady) pReady.onclick = toggleReady;
const pLeave = $('lobby-leave-btn');
if (pLeave) pLeave.onclick = leaveRoom;
const resReady = $('results-ready-btn');
if (resReady) resReady.onclick = toggleReady;
const resLeave = $('results-leave-btn');
if (resLeave) resLeave.onclick = leaveRoom;

function setDirectorManual() {
  auto = false;
  $('auto').classList.remove('active');
}
function updateAngleButton() {
  $('angle').textContent = `镜头 · ${['赛道机位', '追踪车', '直升机'][angle]}`;
}
function chooseTemplate(delta) {
  if (!state) return;
  setDirectorManual();
  angle = 0;
  const focusId = manualId ?? state.focus ?? 0;
  const car = state.cars[focusId];
  const current = manualTemplateId
    ? broadcastTemplateById(state.trackId, manualTemplateId)
    : resolveBroadcastTemplate(state.trackId, car.s);
  manualTemplateId = nextBroadcastTemplate(state.trackId, current?.id, delta).id;
  updateAngleButton();
}
$('auto').onclick = () => {
  auto = true;
  manualTemplateId = null;
  $('auto').classList.add('active');
};
$('next').onclick = () => {
  setDirectorManual();
  manualId = ((manualId ?? state?.focus ?? 0) + 1) % 8;
  manualTemplateId = null;
};
$('angle').onclick = () => {
  setDirectorManual();
  angle = (angle + 1) % 3;
  if (angle !== 0) manualTemplateId = null;
  updateAngleButton();
};
$('camera-prev')?.addEventListener('click', () => chooseTemplate(-1));
$('camera-next')?.addEventListener('click', () => chooseTemplate(1));
updateAngleButton();

if (spectator) addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.code === 'KeyA') {
    $('auto').click();
  } else if (event.code === 'KeyN') {
    $('next').click();
  } else if (event.code === 'BracketLeft') {
    chooseTemplate(-1);
  } else if (event.code === 'BracketRight') {
    chooseTemplate(1);
  } else if (event.code === 'Digit1' || event.code === 'Digit2' || event.code === 'Digit3') {
    setDirectorManual();
    angle = Number(event.code.slice(-1)) - 1;
    manualTemplateId = null;
    updateAngleButton();
  } else {
    return;
  }
  event.preventDefault();
});
$('view').onclick = () => { firstPerson = !firstPerson; $('view').textContent = `视角 · ${firstPerson ? '第一人称' : '追尾'}`; };
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    error('此浏览器不支持页面全屏，横握手机可扩大驾驶画面');
  }
};

addEventListener('resize', () => {
  clearControls();
  sizeSurface();
  applyQuality();
  camera.aspect = layout.width / layout.height;
  camera.updateProjectionMatrix();
});

function renderRank(target, final = false) {
  target.replaceChildren();
  for (const [i, id] of state.order.entries()) {
    const c = state.cars[id], li = document.createElement('li');
    if (final) {
      const name = document.createElement('span');
      name.textContent = `${String(i + 1).padStart(2, '0')}  ${c.name}`;
      const time = document.createElement('span');
      const laps = state.laps ?? LAPS;
      time.textContent = c.finish !== null ? `${c.finish.toFixed(2)}s` : `${Math.round(clamp(c.s / (TRACK_LENGTH * laps), 0, 1) * 100)}%`;
      li.append(name, time);
      // Server-issued result title: one per car, so nobody is left anonymous.
      const award = state.awards?.find(a => a.id === id);
      if (award) {
        const chip = document.createElement('em');
        chip.className = `award-chip award-${award.key}`;
        chip.textContent = `${award.label} · ${award.detail}`;
        li.append(chip);
      }
    } else {
      li.classList.toggle('me', id === myId);
      const n = document.createElement('b'); n.textContent = String(i + 1).padStart(2, '0');
      const color = document.createElement('i'); color.className = 'car-color'; color.style.background = SKINS[id].paint;
      const name = document.createElement('span'); name.className = 'racer-name'; name.textContent = c.name;
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = c.human ? c.connected ? '玩家' : '托管' : 'AI';
      li.append(n, color, name, tag);
    }
    target.append(li);
  }
}

// ---------------------------------------------------------------------------
// 视觉反馈与视线保护 (Lock-Warning, Hit Flash, Deflect Pulse)
// ---------------------------------------------------------------------------
let trauma = 0; // Camera shake intensity for hit feedback

function triggerHitFeedback() {
  trauma = 0.8;
  audio.playHit();
  const vig = $('hit-vignette');
  if (vig) {
    vig.hidden = false;
    vig.style.boxShadow = 'inset 0 0 75px #ef4444e6';
    vig.style.opacity = '1';
    setTimeout(() => { if (vig) vig.style.opacity = '0'; }, 180);
    setTimeout(() => { if (vig && vig.style.opacity === '0') vig.hidden = true; }, 360);
  }
}

function triggerShieldDeflectFeedback() {
  audio.playShieldBlock();
  const vig = $('hit-vignette');
  if (vig) {
    vig.hidden = false;
    vig.style.boxShadow = 'inset 0 0 65px rgba(94, 234, 212, 0.85)';
    vig.style.opacity = '1';
    setTimeout(() => { if (vig) vig.style.opacity = '0'; }, 180);
    setTimeout(() => { if (vig && vig.style.opacity === '0') { vig.hidden = true; vig.style.boxShadow = ''; } }, 360);
  }
}

const FX_STYLES = {
  slow: ['bad', '◕ 减速中'],
  spin: ['bad', '✸ 车辆打转'],
  emp: ['info', '⚡ 氮气失效'],
  shield: ['good', '⛨ 护盾展开'],
  jump: ['good', '▲ 腾空'],
  item: ['info', '◆ 获得道具'],
  hit: ['bad', '✹ 被击中'],
  slowspin: ['bad', '✸ 撞雷打转'],
  draft: ['info', '⇢ 尾流蓄力'],
  draftBoost: ['good', '» 尾流弹射']
};

function setChip(key, style, text) {
  let chip = fxChips[key];
  if (!chip) {
    chip = document.createElement('div');
    chip.className = 'fx';
    $('effects').append(chip);
    fxChips[key] = chip;
  }
  chip.className = `fx ${style}`;
  chip.innerHTML = `<i>${text.slice(0, 2)}</i><span>${text.slice(2)}</span>`;
  chip.hidden = false;
  $('effects').hidden = false;
}

function clearChip(key) {
  const chip = fxChips[key];
  if (chip) { chip.remove(); delete fxChips[key]; }
  if (!$('effects').childElementCount) $('effects').hidden = true;
}

function showToast(text, ms = 1400) {
  const el = $('item-toast');
  el.textContent = text;
  el.hidden = false;
  toastUntil = performance.now() + ms;
}

function updateItemUi(m) {
  const me = myId !== null ? m.cars[myId] : null;
  const btn = itemButton, now = performance.now();
  if (me) {
    if (me.item !== myItem) {
      myItem = me.item;
      if (myItem) {
        audio.playItemGet();
        $('item-icon').textContent = ITEM_DEFS[myItem].icon;
        $('item-name').textContent = ITEM_DEFS[myItem].label;
        btn.disabled = false;
        btn.classList.add('ready');
        btn.classList.remove('empty', 'cooldown');
        $('item-state').textContent = '点击使用';
        if (now - lastSelfAt > 400) {
          showToast(`获得 ${ITEM_DEFS[myItem].label}`);
          lastSelfAt = now;
          setChip('item', ...FX_STYLES.item);
        }
      } else {
        $('item-icon').textContent = '—';
        $('item-name').textContent = '道具';
        btn.disabled = true;
        btn.classList.remove('ready', 'cooldown');
        btn.classList.add('empty');
        $('item-state').textContent = '等待道具箱';
        clearChip('item');
      }
    }
    const t = m.time;
    if (t < me.slowUntil) setChip('slow', ...FX_STYLES.slow); else clearChip('slow');
    if (t < me.spinUntil) setChip('spin', ...FX_STYLES.spin); else clearChip('spin');
    if (t < me.slowSpinUntil && t >= me.spinUntil) setChip('slowspin', ...FX_STYLES.slowspin); else clearChip('slowspin');
    if (t < me.empUntil) setChip('emp', ...FX_STYLES.emp); else clearChip('emp');
    if (t < me.shieldUntil) setChip('shield', ...FX_STYLES.shield); else clearChip('shield');
    if (t < me.jumpUntil) setChip('jump', ...FX_STYLES.jump); else clearChip('jump');
    if (me.drafting && me.draftBoost <= 0) setChip('draft', ...FX_STYLES.draft); else clearChip('draft');
    if (me.draftBoost > 0) setChip('draftBoost', ...FX_STYLES.draftBoost); else clearChip('draftBoost');

    if (Number.isFinite(me.featureEventAt) && me.featureEventAt > lastFeatureAt) {
      lastFeatureAt = me.featureEventAt;
      if (me.featureKind === 'boost-pad') {
        audio.playNitro();
        showToast('极速带 · 路线奖励');
      } else if (me.featureKind === 'ramp') {
        audio.playItemUse('jump');
        showToast('桥面飞跃！');
      } else if (me.featureKind === 'draft-release') {
        audio.playNitro();
        showToast('尾流弹射 · 超车！');
      }
    }

    if (myItem && me.item === myItem && btn.classList.contains('cooldown') && now - useSentAt > 700) {
      btn.classList.remove('cooldown');
      btn.classList.add('ready');
      $('item-state').textContent = '点击使用';
    }
  }
  if (toastUntil && now > toastUntil) {
    $('item-toast').hidden = true;
    toastUntil = 0;
  }
}

const HL_STYLES = {
  overtake: ['↗', '超车'],
  overtaken: ['↙', '被超车'],
  overtake_after_boost: ['»', '氮气超车'],
  missile_hit: ['➤', '导弹命中'],
  shield_block: ['⛨', '护盾格挡'],
  mine_hit: ['✸', '地雷命中'],
  last_lap: ['⚑', '最后一圈'],
  finish_line: ['🏁', '冲线'],
  car_collision: ['✹', '车辆碰撞'],
  item_use: ['◆', '道具交锋']
};

function renderHighlights(m) {
  if (m.highlights.length && m.highlights[0].id !== hlsTop) {
    hlsTop = m.highlights[0].id;
    const h = m.highlights[0];
    const text = HL_STYLES[h.type]?.[1] ?? h.type;
    if (role === 'player' && myId !== null) {
      const mine = h.actorId === myId || h.targetId === myId;
      if (mine) {
        if (h.type === 'missile_hit' || h.type === 'mine_hit') {
          if (h.targetId === myId) triggerHitFeedback();
          else audio.playHit();
          showToast(h.actorId === myId ? `${text} · 命中对手` : `遭到 ${text}`);
        } else if (h.type === 'shield_block') {
          triggerShieldDeflectFeedback();
          showToast(h.actorId === myId ? '护盾成功格挡！' : '对手格挡了攻击');
        }
      }
    } else {
      // Spectator mode audio feedback
      if (h.type === 'missile_hit' || h.type === 'mine_hit') audio.playHit();
      else if (h.type === 'shield_block') audio.playShieldBlock();
    }
  }
  const list = $('highlight-list');
  if (!list) return;
  // Spectator readability: generic launch spam ("道具交锋") stays out of the
  // list; outcomes (missile_hit, mine_hit, shield_block, overtakes) carry names.
  const visible = m.highlights.filter(h => h.type !== 'item_use');
  if (!m.highlights.length) {
    list.replaceChildren();
    const li = document.createElement('li'); li.className = 'empty'; li.textContent = '等待精彩瞬间…';
    list.append(li);
    return;
  }
  if (!visible.length) return;
  if (list.childElementCount === visible.length && list.dataset.top === String(visible[0].id)) return;
  list.dataset.top = String(visible[0].id);
  list.replaceChildren();
  for (const h of visible) {
    const li = document.createElement('li');
    const icon = document.createElement('span'); icon.className = 'hl-icon'; icon.textContent = HL_STYLES[h.type]?.[0] ?? '◆';
    const names = h.actorId !== null && h.actorId !== undefined ? m.cars[h.actorId]?.name ?? '' : '';
    const tname = h.targetId !== null && h.targetId !== undefined ? ` → ${m.cars[h.targetId]?.name ?? ''}` : '';
    const text = document.createElement('span'); text.className = 'hl-text'; text.textContent = `${HL_STYLES[h.type]?.[1] ?? h.type} · ${names}${tname}`;
    const time = document.createElement('span'); time.className = 'hl-time'; time.textContent = `${h.timestamp.toFixed(1)}s`;
    li.append(icon, text, time);
    list.append(li);
  }
}

let lastPhase = null;
let lastCountdownNumber = null;

// Duel bar: the big screen's tug-of-war between the two cars fighting for the
// same piece of road. The server decides who is duelling and who leads; the
// client only paints it, so phone and display can never disagree.
let duelPair = '', duelEls = null;
function renderDuel(m) {
  if (!duelEls) {
    const bar = $('duel-bar');
    if (!bar) return;
    duelEls = { bar, a: $('duel-a'), b: $('duel-b'), fill: $('duel-fill'), dots: bar.querySelectorAll('.duel-dot') };
  }
  const d = m.duel;
  if (!d || (m.phase !== 'racing' && m.phase !== 'countdown')) {
    duelEls.bar.hidden = true;
    duelPair = '';
    return;
  }
  const a = m.cars[d.a], b = m.cars[d.b];
  if (!a || !b) { duelEls.bar.hidden = true; return; }
  duelEls.bar.hidden = false;
  const key = `${d.a}-${d.b}`;
  if (key !== duelPair) {
    duelPair = key;
    duelEls.a.textContent = `#${d.a + 1} ${a.name}`;
    duelEls.b.textContent = `#${d.b + 1} ${b.name}`;
    duelEls.dots[0].style.background = SKINS[d.a].paint;
    duelEls.dots[1].style.background = SKINS[d.b].paint;
  }
  // d.ratio is the signed lead of car A over car B inside the duel window.
  duelEls.fill.style.width = `${clamp(50 + clamp(d.ratio, -1, 1) * 50, 0, 100)}%`;
  duelEls.bar.classList.toggle('flash', m.time - d.flash < 1);
}

function ui(now) {
  if (!state) return;
  if (state.phase !== lastPhase) {
    lastPhase = state.phase;
    if (state.phase === 'racing') {
      audio.playBgm('bgm-race');
    } else {
      audio.playBgm('bgm-menu');
    }
  }
  if (state.phase === 'countdown') {
    const num = Math.max(1, Math.ceil(state.phaseLeft));
    if (num !== lastCountdownNumber) {
      lastCountdownNumber = num;
      audio.playCountdown();
    }
  } else if (state.phase === 'racing') {
    if (lastCountdownNumber !== 'go') {
      lastCountdownNumber = 'go';
      audio.playGo();
    }
  } else {
    lastCountdownNumber = null;
  }

  const stale = now - lastStateAt > 1000;
  $('connection').textContent = stale ? '画面同步中断 · 正在恢复' : `● ${role === 'player' ? '已连接 · 你的独立驾驶视角' : '直播已连接'} · ${fps} FPS`;
  $('help').textContent = role === 'player' ? (navigator.maxTouchPoints > 0 ? '摇杆转向 · 漂移蓄能 · 氮气加速' : '方向键 / A D 转向 · Shift 漂移 · 空格氮气') : '海湾环线 · 高画质导播版';
  $('phase').textContent = { demo: 'AI 赛道巡游', lobby: '大厅报名中', countdown: '准备发车', racing: '比赛进行中', result: '比赛结束' }[state.phase] ?? state.phase;
  const t = Math.ceil(state.remaining);
  $('clock').textContent = state.phase === 'lobby' ? 'WAIT' : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const connectedHumans = state.cars.filter(c => c.human && c.connected);
  $('online').textContent = `${connectedHumans.length} / 8`;
  const trackInfo = TRACKS[state.trackId];
  if (trackInfo) $('track-sub').textContent = `${trackInfo.title} / ${trackInfo.name}`;
  const laps = state.laps ?? LAPS;
  const seconds = state.seconds ?? 90;
  $('round').textContent = `第 ${Math.max(1, state.round)} 场 · ${laps} 圈`;
  $('race-call').textContent = state.phase === 'countdown' ? String(Math.max(1, Math.ceil(state.phaseLeft))) : state.phase === 'racing' && state.remaining > seconds - 1.3 ? 'GO!' : state.phase === 'lobby' && role !== 'player' ? 'WAITING' : '';

  // Start race button display logic
  const startBtn = $('start-race');
  const broadcastStartBtn = $('broadcast-start');
  const canStart = (state.phase === 'lobby' || state.phase === 'demo') && connectedHumans.length > 0;
  if (startBtn) {
    startBtn.style.display = (role === 'player') ? 'none' : 'inline-flex';
    startBtn.disabled = !canStart && state.phase !== 'demo';
    startBtn.innerHTML = state.phase === 'lobby' ? `发车 (${connectedHumans.length}/8) <span>▶</span>` : `开始比赛 <span>▶</span>`;
  }
  if (broadcastStartBtn) {
    broadcastStartBtn.disabled = !canStart && state.phase !== 'demo';
    broadcastStartBtn.textContent = state.phase === 'lobby' ? `确认开赛 (${connectedHumans.length}人就绪) ▶` : `开始比赛 ▶`;
  }

  // Ad copy poll: lobby/demo/result only, ~5 s cadence, single-flight.
  if ((state.phase === 'lobby' || state.phase === 'demo' || state.phase === 'result') && now - lastAdsPoll > 5000) {
    lastAdsPoll = now;
    refreshAds();
  }
  const trackBox = $('track-select');
  if (trackBox && trackBox.dataset.cur !== (state.trackId ?? '')) {
    trackBox.dataset.cur = state.trackId ?? '';
    trackBox.replaceChildren();
    for (const id of Object.keys(TRACKS)) {
      const b = document.createElement('button');
      b.className = `glass small track-btn${id === state.trackId ? ' active' : ''}`;
      b.textContent = TRACKS[id].name;
      b.disabled = !(state.phase === 'lobby' || state.phase === 'demo');
      b.onclick = () => socket?.send(JSON.stringify({ v: 1, type: 'select-track', trackId: id }));
      trackBox.append(b);
    }
  }

  // Mobile player staging lobby card
  const lobbyCard = $('lobby-card');
  if (lobbyCard) {
    if (role === 'player' && (state.phase === 'lobby' || (state.phase === 'countdown' && state.phaseLeft > 3.2))) {
      lobbyCard.hidden = false;
      const driverList = $('lobby-drivers');
      if (driverList) {
        driverList.replaceChildren();
        for (const c of state.cars) {
          if (!c.connected && !c.human) continue;
          const chip = document.createElement('div');
          chip.className = `lobby-pilot-chip${c.id === myId ? ' me' : ''}`;
          const isReady = c.ready !== false;
          const statusText = isReady ? (c.id === myId ? '你已准备' : '已准备') : (c.id === myId ? '未准备' : '待准备');
          const statusClass = isReady ? 'ready' : 'waiting';
          chip.innerHTML = `<strong>#${c.id + 1} ${c.name}</strong><span class="${statusClass}">[${statusText}]</span>`;
          driverList.append(chip);
        }
      }
      const myCar = state.cars[myId];
      const pReady = $('player-ready-btn');
      if (pReady && myCar) {
        const isReady = myCar.ready !== false;
        pReady.textContent = isReady ? '已就绪 (点击取消)' : '点击准备';
        pReady.className = isReady ? 'primary ready-active' : 'primary ready-idle';
      }
    } else {
      lobbyCard.hidden = true;
    }
  }

  const focus = state.cars[auto ? state.focus : manualId ?? 0];
  $('focus-name').textContent = focus.name;
  const stationLabel = liveTemplateId
    ? broadcastTemplateById(state.trackId, liveTemplateId)?.label
    : null;
  $('focus-reason').textContent = auto
    ? `${state.focusReason}${stationLabel ? ' · ' + stationLabel : ''}`
    : `自由导播${stationLabel ? ' · ' + stationLabel : ''}`;
  const stationEl = $('camera-station');
  if (stationEl) stationEl.textContent = stationLabel || (auto ? 'AUTO' : 'FREE');
  // Name tags: live rank + nickname, redrawn only on change; hide own tag
  // in first person.
  const tagKeys = [];
  for (let id = 0; id < 8; id++) {
    const tag = carMeshes[id].userData.nameTag;
    if (!tag) continue;
    tag.visible = !(myId === id && firstPerson && role === 'player');
    const rank = state.order.indexOf(id) + 1;
    const key = `${rank}|${state.cars[id].name}`;
    if (tag.userData.key !== key) drawNameTag(tag, id, state.cars[id].name, rank);
    tagKeys.push(tag.userData.key);
  }
  try { window.__tagKeys = tagKeys; } catch {}
  // Focus gap readout: nearest unfinished rivals ahead/behind, wrap-aware.
  {
    const gapEl = $('focus-gap');
    if (gapEl) {
      let gapText = '';
      if (focus.finish !== null) {
        gapText = '已冲线';
      } else if (state.phase === 'racing' || state.phase === 'countdown') {
        const unfinished = state.order.filter(id => state.cars[id].finish === null);
        const ui2 = unfinished.indexOf(focus.id);
        const wrapD = d => ((d % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
        const parts = [];
        if (ui2 > 0) {
          const ahead = state.cars[unfinished[ui2 - 1]];
          parts.push(`前车 ${ahead.name} +${Math.round(wrapD(ahead.s - focus.s))}m`);
        } else {
          parts.push('领跑全场');
        }
        if (ui2 >= 0 && ui2 < unfinished.length - 1) {
          const behind = state.cars[unfinished[ui2 + 1]];
          parts.push(`后车 ${behind.name} -${Math.round(wrapD(focus.s - behind.s))}m`);
        }
        gapText = parts.join(' · ');
      }
      gapEl.textContent = gapText;
    }
  }
  // Big-screen readability: shrink the QR panel once the race is underway so
  // the tracked car owns the frame; lobby keeps the full-size signup code.
  document.body.classList.toggle('in-race',
    state.phase === 'countdown' || state.phase === 'racing' || state.phase === 'result');
  renderRank($('ranks'));
  $('results').hidden = state.phase !== 'result';
  if (state.phase === 'result') {
    renderRank($('final-ranks'), true);
    $('rematch').textContent = `${Math.ceil(state.phaseLeft)} 秒后回到发车站位 · 等待大屏确认开赛`;
    if (myId !== null && state.cars[myId]) {
      const myCar = state.cars[myId];
      const resReady = $('results-ready-btn');
      if (resReady) {
        const isReady = myCar.ready !== false;
        resReady.textContent = isReady ? '已准备下场 (点击取消)' : '准备下场';
        resReady.className = isReady ? 'primary ready-active' : 'primary ready-idle';
      }
    }
  }
  if (myId !== null) {
    const c = state.cars[myId];
    $('position').textContent = String(state.order.indexOf(myId) + 1).padStart(2, '0');
    $('lap').textContent = c.finish !== null ? '已完成比赛' : `第 ${clamp(Math.floor(c.s / TRACK_LENGTH) + 1, 1, laps)} / ${laps} 圈`;
    $('speed').textContent = String(Math.round(c.speed * 3.6));
    $('energy-value').textContent = `${Math.floor(c.energy)}%`;
    $('energy-fill').style.width = `${c.energy}%`;
    const driftMeter = $('drift-meter');
    if (driftMeter) {
      const active = c.drift || c.driftCharge > 0;
      const stage = c.driftStage || 0;
      driftMeter.hidden = !active;
      driftMeter.classList.toggle('ready', stage === 1);
      driftMeter.classList.toggle('perfect', stage === 2);
      $('drift-tier').textContent = stage === 2 ? '完美 · 松手喷射' : stage === 1 ? '小喷就绪' : '蓄力中';
      $('drift-fill').style.width = `${Math.round(clamp((c.driftCharge || 0) / 0.72, 0, 1) * 100)}%`;
    }
    const b = document.querySelector('[data-control="boost"]');
    if (b) b.style.opacity = c.energy >= 30 ? '1' : '0.5';

    // Lock-on alert (non-intrusive top banner + audio alert)
    const incoming = state.entities?.some(e => e.alive !== false && e.kind === 'missile' && e.targetId === myId);
    const lockEl = $('lock-warning');
    if (lockEl) {
      if (incoming) {
        lockEl.hidden = false;
        audio.playLockWarning();
      } else {
        lockEl.hidden = true;
      }
    }
  }
  if (toastUntil && now > toastUntil) {
    $('item-toast').hidden = true;
    toastUntil = 0;
  }
}

// ---------------------------------------------------------------------------
// 导播镜头打磨与主循环 (Smooth Camera Transitions, Rigged Cars & Dynamic VFX)
// ---------------------------------------------------------------------------
let previous = performance.now();
const targetCamera = new THREE.Vector3();
const look = new THREE.Vector3();
const smoothLook = new THREE.Vector3();
let cameraInit = false;

function setTvCamera(trackId, template, car, renderedS, renderedLane = car.lane) {
  const pose = broadcastPose(trackId, template, renderedS, renderedLane);
  targetCamera.set(pose.camera.x, pose.camera.y, pose.camera.z);
  look.set(pose.look.x, pose.look.y, pose.look.z);
  camera.fov = pose.fov;
  liveTemplateId = pose.id;
  return pose.id;
}

function setHelicopterCamera(car, renderedS, renderedLane) {
  // Aerial TV shot: stay well behind and outside the selected kart, then look
  // back at the kart itself. The previous shallow 6m/20m composition often
  // framed mostly infield on long bends and could lose the actual race.
  const high = trackAt(renderedS - 24, renderedLane + 16);
  const target = trackAt(renderedS + 1.5, renderedLane * 0.7);
  targetCamera.set(high.x, high.y + 30, high.z);
  look.set(target.x, target.y + 1.15, target.z);
  camera.fov = 49;
  liveTemplateId = null;
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - previous) / 1000, 0.05);
  previous = now;
  frameCount++;
  if (now - fpsAt > 1000) {
    fps = Math.round(frameCount * 1000 / (now - fpsAt));
    fpsAt = now;
    frameCount = 0;
  }

  // 1. Dynamic Environmental Animations: slow daylight, water shimmer,
  // lighthouse ray and digital chevrons.
  const daylightBlend = daylightRig.update(state, dt);
  // Follow the active camera so the limited shadow map is spent where the
  // audience/player can actually see it. This matters on the new ~1.1 km lap.
  sunFollow.set(camera.position.x, 0, camera.position.z);
  sunTarget.position.lerp(sunFollow, 1 - Math.exp(-dt * 2.4));
  sun.position.x += sunTarget.position.x;
  sun.position.z += sunTarget.position.z;
  sun.target.updateMatrixWorld();

  skyDome.position.copy(camera.position);
  skyUniforms.topColor.value.copy(skyTopDay).lerp(skyTopWarm, daylightBlend);
  skyUniforms.horizonColor.value.copy(skyHorizonDay).lerp(skyHorizonWarm, daylightBlend);
  skyUniforms.sunDirection.value.copy(sun.position).sub(sunTarget.position).normalize();
  renderer.toneMappingExposure = 1.08 - daylightBlend * 0.05;
  waterNormal.offset.x = (waterNormal.offset.x + dt * 0.007) % 1;
  waterNormal.offset.y = (waterNormal.offset.y + dt * 0.004) % 1;
  if (beaconRay) beaconRay.rotation.y += dt * 1.6;
  for (const [idx, chev] of chevronPanels.entries()) {
    const flowPhase = (now * 0.003 + idx * 0.4) % 1;
    chev.arrow.material.opacity = flowPhase > 0.3 ? 1.0 : 0.4;
  }

  if (state) {
    cockpit.visible = myId !== null && firstPerson && role === 'player';
    if (myId !== null && bonnetSkin !== myId && SKINS[myId]) {
      bonnetSkin = myId;
      bonnetMat.color.set(SKINS[myId].paint);
    }
    wheelMesh.rotation.z = -clamp(analogSteer + Number(keys.right) - Number(keys.left), -1, 1) * 0.55;
    const elapsed = Math.min((now - lastStateAt) / 1000, 0.15);
    const t = state.time;

    // 2. Item Box Floating & Holographic Rotation
    for (const [i, boxMesh] of itemBoxMeshes.entries()) {
      const data = state.boxes[i], open = data && data.item !== null && data.item !== undefined;
      boxMesh.visible = open && state.phase !== 'result';
      if (open) {
        boxMesh.userData.core.rotation.y += dt * 2.4;
        boxMesh.userData.core.rotation.x = Math.sin(now * 0.002 + i) * 0.28;
        boxMesh.userData.core.position.y = 1.15 + Math.sin(now * 0.003 + i * 2) * 0.16;
        if (boxMesh.userData.sparkles) boxMesh.userData.sparkles.rotation.y -= dt * 3.2;
      }
    }

    syncEntities(now, dt);

    // Start gantry signal lights: red count during countdown, green when live.
    if (startLights.length) {
      const live = state.phase === 'racing' || state.phase === 'result';
      const n = live ? 3 : state.phase === 'countdown'
        ? Math.min(3, Math.max(0, 3 - Math.floor(state.phaseLeft)))
        : 0;
      for (let li = 0; li < startLights.length; li++) {
        startLights[li].material.color.set(live ? '#3ecf8e' : li < n ? '#ef4444' : '#2a3b42');
      }
    }

    let selfSmoke = 0;
    for (const c of state.cars) {
      const g = carMeshes[c.id], active = state.phase === 'racing' || state.phase === 'demo';
      const targetS = c.s + (active && c.finish === null ? c.speed * elapsed : 0);
      g.userData.s += (targetS - g.userData.s) * Math.min(1, dt * 15);
      g.userData.lane += (c.lane - g.userData.lane) * Math.min(1, dt * 15);
      const jumpLeft = Math.max(0, c.jumpUntil - t);
      const hop = jumpLeft > 0 ? Math.sin((1 - jumpLeft / JUMP_DURATION) * Math.PI) * JUMP_HEIGHT : 0;
      const p = trackFrameAt(g.userData.s, g.userData.lane);

      g.position.set(p.x, p.y + 0.015 + hop, p.z);
      g.rotation.x = p.pitch;
      if (g.userData.nameTag) g.userData.nameTag.position.set(p.x, p.y + 2.92 + hop, p.z);
      // Cancel the parent jump so the contact shadow remains on the asphalt.
      g.userData.shadow.position.y = 0.012 - hop;
      g.userData.shadow.scale.setScalar(Math.max(0.5, 1 - hop * 0.18));

      // 3. Dynamic Mechanical Wheel Rigging: Turning + Spinning
      // AI wheels now follow the actual lateral velocity instead of a fake sine.
      const steerInput = c.human
        ? (Number.isFinite(c.steer) ? c.steer : 0)
        : clamp((c.lateral || 0) / 8, -1, 1);
      if (g.userData.frontPivots) {
        for (const pivot of g.userData.frontPivots) {
          pivot.rotation.y = steerInput * 0.44;
        }
      }
      if (g.userData.wheelGroups) {
        for (const wheelGroup of g.userData.wheelGroups) {
          wheelGroup.rotation.x += c.speed * dt * 2.8;
        }
      }
      // Steering wheel and driver hands turn with input
      if (g.userData.steeringGroup) {
        g.userData.steeringGroup.rotation.z = -steerInput * 0.58;
      }

      // 4. Chassis Suspension Dynamics: Dynamic Roll, Pitch & Squat
      const bg = g.userData.bodyGroup;
      if (bg) {
        // Lateral body roll on corners and drifts.
        const rollAngle = -c.lateral * (c.drift ? 0.075 : 0.035);
        bg.rotation.z += (rollAngle - bg.rotation.z) * Math.min(1, dt * 10);

        // Longitudinal weight transfer: acceleration lifts the nose slightly,
        // braking dives it, while the parent group already follows road grade.
        const previousSpeed = Number.isFinite(g.userData.previousSpeed)
          ? g.userData.previousSpeed
          : c.speed;
        const longitudinalAccel = (c.speed - previousSpeed) / Math.max(dt, 1 / 120);
        g.userData.previousSpeed = c.speed;
        const pitchAngle = clamp(-longitudinalAccel * 0.0034, -0.075, 0.075) +
          (c.boost > 0 ? -0.018 : 0);
        bg.rotation.x += (pitchAngle - bg.rotation.x) * Math.min(1, dt * 9);
      }

      if (c.spinUntil > t) g.rotation.z = (c.spinAge * 10) % (Math.PI * 2);
      else g.rotation.z = 0;
      // Body yaw now comes from the authoritative heading state rather than
      // faking steering from lane velocity.
      g.rotation.y = p.yaw - (c.headingError ?? 0);

      // Exhaust Flame Flaring
      if (g.userData.flameGroup) {
        g.userData.flameGroup.visible = c.boost > 0;
        g.userData.flameGroup.scale.setScalar(0.85 + Math.sin(now * 0.045) * 0.22);
      }

      // Shield & Aura Effects. Guard-only shows a white shell; real shield cyan.
      const shielding = c.shieldUntil > t, guarded = c.guardUntil > t, shocked = c.empUntil > t, dizzy = c.spinUntil > t;
      if (g.userData.shield) {
        g.userData.shield.visible = shielding || guarded;
        if (shielding || guarded) {
          const tint = shielding ? 0x5eead4 : 0xffffff;
          if (g.userData.shieldTint !== tint) {
            g.userData.shieldTint = tint;
            for (const part of g.userData.shield.children) {
              if (part.isMesh) part.material.color.setHex(tint);
            }
          }
          g.userData.shield.rotation.y += dt * 3.2;
          g.userData.shield.rotation.z += dt * 2.1;
        }
      }
      g.userData.shock.visible = shocked;
      if (shocked) g.userData.shock.rotation.y += dt * 9;
      g.userData.dizzy.visible = dizzy;
      if (dizzy) g.userData.dizzy.rotation.y -= dt * 7;

      g.visible = !(myId === c.id && firstPerson && role === 'player');
      if (myId === c.id && role === 'player') {
        selfSmoke = smokeVolumeAt(c.s);
        if (c.drift && c.speed > 15) {
          selfSmoke += 0.24 + Math.min(0.28, Math.abs(c.slipAngle ?? 0) * 1.8);
        }
        // Drift sustain skid + boost-start whoosh follow game state, not input.
        if (c.drift && state.phase === 'racing') audio.playDrift();
        if (c.boost > 0 && lastSelfBoost <= 0) audio.playNitro();
        lastSelfBoost = c.boost;
        audio.setWind(clamp(c.speed / 48, 0, 1), c.boost > 0);
      }
    }

    if (role !== 'player' || myId === null) {
      const fid = auto ? state.focus : manualId ?? 0;
      selfSmoke = smokeVolumeAt(state.cars[fid].s);
      const fc = state.cars[fid];
      if (fc && fc.drift && fc.speed > 15) {
        selfSmoke += 0.2 + Math.min(0.24, Math.abs(fc.slipAngle ?? 0) * 1.5);
      }
    }
    smokeFog.hidden = false;
    smokeFog.style.opacity = String(Math.min(0.92, selfSmoke * 0.24));

    // Boost speed-lines feedback for player
    const me = myId !== null ? state.cars[myId] : null;
    const speedLines = $('speed-lines');
    if (speedLines) {
      if (me && (me.boost > 0 || me.draftBoost > 0)) {
        speedLines.hidden = false;
        speedLines.style.opacity = '0.7';
      } else {
        speedLines.style.opacity = '0';
        speedLines.hidden = true;
      }
    }

    // 5. Camera Framing Logic: Director Shots & Follow Modes
    const id = myId !== null ? myId : auto ? state.focus : manualId ?? 0;
    const c = state.cars[id], g = carMeshes[id];
    const p = trackAt(g.userData.s, g.userData.lane);
    const heading = c.headingError ?? 0;
    const noseLane = g.userData.lane +
      clamp(Math.tan(heading) * 18, -6.5, 6.5);
    const ahead = trackAt(g.userData.s + 18, noseLane);

    let newCameraKey = 'player';
    liveTemplateId = null;

    if (myId !== null && firstPerson) {
      // Driver camera looks through the actual kart nose.
      targetCamera.set(p.x, p.y + 1.7, p.z);
      look.set(ahead.x, ahead.y + 1.5, ahead.z);
      camera.fov = 72 + (c.boost > 0 || c.draftBoost > 0 ? 8 : 0);
      newCameraKey = 'player:cockpit';
    } else if (myId === null && auto && state.shot === 'finish') {
      // Fixed finish-line television station. The camera does not chase the
      // winner; it pans through the gantry like a real finish-line operator.
      const gridId = state.trackId === 'ridge' ? 'ridge-grid' : 'bay-grid';
      const template = broadcastTemplateById(state.trackId, gridId) ||
        resolveBroadcastTemplate(state.trackId, 0);
      const templateId = setTvCamera(state.trackId, template, c, g.userData.s);
      camera.fov = Math.min(camera.fov, 46);
      newCameraKey = `auto:finish:${templateId}`;
    } else if (myId === null && auto && state.shot === 'aerial' && state.shotS !== null) {
      // Tactical aerial is reserved for missile/EMP moments. Everything else
      // stays on the circuit's authored TV stations.
      const activeMissile = state.entities?.find(e =>
        e.alive !== false && e.kind === 'missile' && e.targetId !== null
      );
      if (activeMissile && state.cars[activeMissile.targetId]) {
        const victim = state.cars[activeMissile.targetId];
        const mp = trackAt(activeMissile.s, activeMissile.lane);
        const vp = trackAt(victim.s, victim.lane);
        targetCamera.set(
          (mp.x + vp.x) / 2 + 14,
          Math.max(mp.y, vp.y) + 13,
          (mp.z + vp.z) / 2 + 12,
        );
        look.set(vp.x, vp.y + 1, vp.z);
        camera.fov = 56;
      } else {
        setHelicopterCamera(c, state.shotS, g.userData.lane);
      }
      newCameraKey = `auto:aerial:${state.focus}`;
    } else if (myId === null && auto) {
      // TV mode: freeze the camera station at shot start (shotS) while the
      // camera pans with the selected car. Crossing a sector boundary therefore
      // does not silently cut to another station.
      const stationS = state.shotS ?? g.userData.s;
      const template = resolveBroadcastTemplate(state.trackId, stationS);
      let targetS = g.userData.s;
      let targetLane = g.userData.lane;
      if (state.duel && state.focusReason === '贴身对决') {
        const da = state.cars[state.duel.a];
        const db = state.cars[state.duel.b];
        if (da && db) {
          const gap = wrap(db.s - da.s + TRACK_LENGTH / 2, TRACK_LENGTH) - TRACK_LENGTH / 2;
          targetS = da.s + gap * 0.5;
          targetLane = (da.lane + db.lane) * 0.5;
        }
      }
      const templateId = setTvCamera(state.trackId, template, c, targetS, targetLane);
      newCameraKey = `auto:trackside:${templateId}`;
    } else if (myId === null && !auto && angle === 0) {
      // Free director: either lock a chosen station or automatically use the
      // selected driver's current sector.
      const template = manualTemplateId
        ? broadcastTemplateById(state.trackId, manualTemplateId)
        : resolveBroadcastTemplate(state.trackId, g.userData.s);
      const templateId = setTvCamera(state.trackId, template, c, g.userData.s);
      newCameraKey = `manual:station:${templateId}`;
    } else if (myId === null && !auto && angle === 2) {
      setHelicopterCamera(c, g.userData.s, g.userData.lane);
      newCameraKey = `manual:helicopter:${id}`;
    } else {
      // Manual chase / player third person.
      const behindLane = g.userData.lane -
        clamp(Math.tan(heading) * 4.5, -2.5, 2.5);
      const behind = trackAt(g.userData.s - 9.5, behindLane);
      targetCamera.set(behind.x, behind.y + 5.0, behind.z);
      const chaseLane = g.userData.lane +
        clamp(Math.tan(heading) * 13, -5.5, 5.5);
      const chaseAhead = trackAt(g.userData.s + 14, chaseLane);
      look.set(chaseAhead.x, chaseAhead.y + 1, chaseAhead.z);
      camera.fov = 62 + Math.round(clamp(c.speed / 48, 0, 1) * 4);
      newCameraKey = myId === null ? `manual:chase:${id}` : 'player:chase';
    }

    // Ground clearance safety clamp
    targetCamera.y = Math.max(targetCamera.y, p.y + 0.8, 1.2);

    // Camera trauma rumble for hits + faint speed tremor.
    if (trauma > 0) {
      trauma = Math.max(0, trauma - dt * 3.5);
      const shake = trauma * trauma * 0.45;
      targetCamera.x += (Math.random() - 0.5) * shake;
      targetCamera.y += (Math.random() - 0.5) * shake;
    }
    {
      const wob = (c.speed / 48) * (c.speed / 48) * 0.12;
      targetCamera.x += (Math.random() - 0.5) * wob;
      targetCamera.y += (Math.random() - 0.5) * wob;
    }

    // Television stations CUT between cameras; they do not fly through the
    // scenery. Inside one station only the pan target eases. Chase/helicopter
    // cameras retain normal damping.
    const cut = newCameraKey !== cameraCutKey;
    cameraCutKey = newCameraKey;
    const alpha = myId !== null && firstPerson ? 1 : 1 - Math.exp(-dt * 4.8);
    if (!cameraInit || cut) {
      camera.position.copy(targetCamera);
      smoothLook.copy(look);
      cameraInit = true;
    } else {
      camera.position.lerp(targetCamera, alpha);
      smoothLook.lerp(look, alpha);
    }
    camera.lookAt(smoothLook);
    camera.updateProjectionMatrix();
    try {
      window.__broadcastCamera = {
        mode:auto ? 'auto' : 'free',
        shot:auto ? state.shot : ['station','chase','helicopter'][angle],
        templateId:liveTemplateId,
        focus:id,
      };
    } catch {}
  } else {
    camera.position.set(160, 140, 185);
    camera.lookAt(0, 0, 0);
  }

  if (now - lastUi > 150) {
    ui(now);
    lastUi = now;
  }
  // Keep cockpit paint consistent with the assigned GLB slot. The previous
  // generic fallback showed a red hood for cars 02-08, which broke livery
  // continuity in first person.
  heroBonnet.visible = myId !== null;
  for (const piece of originalBonnet) piece.visible = false;
  if(kartPreview){
    for(const child of scene.children)if(child!==carMeshes[0]&&child!==camera&&!child.isLight&&!child.userData.kartStage)child.visible=false;
    const hero=carMeshes[0];hero.visible=true;hero.position.set(0,0,0);hero.rotation.set(0,previewYaw,0);
    hero.userData.bodyGroup.rotation.set(0,0,0);hero.userData.flameGroup.visible=false;
    hero.userData.shield.visible=false;hero.userData.shock.visible=false;hero.userData.dizzy.visible=false;
    hero.userData.frontPivots.forEach(p=>p.rotation.y=-.15);
    for(const other of carMeshes.slice(1))other.visible=false;
    cockpit.visible=false;camera.position.set(4.1,2.9,5.8);camera.lookAt(0,.95,0);camera.fov=37;camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
  // Perf probe for playtests (calls/tris/geometries/textures + fps).
  try {
    perfFrames++;
    const elapsed = now - perfAt;
    if (elapsed >= 1000) {
      window.__perf = {
        fps: Math.round(perfFrames * 1000 / elapsed),
        calls: renderer.info.render.calls,
        tris: renderer.info.render.triangles,
        geos: renderer.info.memory.geometries,
        tex: renderer.info.memory.textures,
      };
      perfFrames = 0;
      perfAt = now;
    }
  } catch {}
}
requestAnimationFrame(animate);
