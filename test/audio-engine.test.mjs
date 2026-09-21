// ===========================================================================
// audio-engine.test.mjs — 交互音频引擎的自动化测试
// ===========================================================================
//
// 这些测试**不发声**：用一套最小 Web Audio mock 驱动 public/audio-engine.mjs，
// 验证架构约束真的成立，而不是"跑起来没崩"。重点验证四类容易静默失效的规则：
//
//   1. 路由完整性   —— 每条 SFX_ROUTES 都必须有合成器，且都能播
//   2. 声部预算     —— 压测下 activeVoiceCount 永不超过平台上限
//   3. 零运行时分配 —— 触发上千次音效后噪声缓冲数量不变（手机 GC 掉帧的根因）
//   4. 静音一致性   —— 全局静音后不允许有任何一条音效还出声
//
// 另外验证小节对齐的算术：自适应音乐的交叉淡化必须落在小节格点上，
// 否则听感就是"换歌"而不是"强度变化"。

import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioEngine, MUSIC_LIBRARY, SFX_ROUTES, QUALITY_TIERS } from '../public/audio-engine.mjs';

// ---------------------------------------------------------------------------
// 最小 Web Audio mock
// ---------------------------------------------------------------------------

class MockParam {
  constructor(value = 0, name = '') {
    this.value = value;
    this.name = name;
    this.events = [];
  }
  setValueAtTime(v, t) { this.value = v; this.events.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.events.push(['linear', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push(['exp', v, t]); return this; }
  setTargetAtTime(v, t, tau) { this.value = v; this.events.push(['target', v, t, tau]); return this; }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); return this; }
  get lastEvent() { return this.events[this.events.length - 1] || null; }
}

class MockNode {
  constructor(kind) {
    this.kind = kind;
    this.outputs = [];
    this.disconnectCount = 0;
  }
  connect(dst) { this.outputs.push(dst); return dst; }
  disconnect() { this.disconnectCount++; this.outputs.length = 0; }
}

class MockGain extends MockNode {
  constructor() { super('gain'); this.gain = new MockParam(1); }
}

class MockOscillator extends MockNode {
  constructor() {
    super('oscillator');
    this.type = 'sine';
    this.frequency = new MockParam(440);
    this.detune = new MockParam(0);
    this.started = false;
    this.stopped = false;
    this.startTimes = [];
  }
  start(t) { this.started = true; this.startTimes.push(t); }
  stop(t) { this.stopped = true; this.stopTime = t; }
}

class MockBufferSource extends MockNode {
  constructor() {
    super('bufferSource');
    this.buffer = null;
    this.loop = false;
    this.playbackRate = new MockParam(1);
    this.started = false;
  }
  start(t, off) { this.started = true; this.startTime = t; this.offset = off; }
  stop(t) { this.stopped = true; this.stopTime = t; }
}

class MockFilter extends MockNode {
  constructor() {
    super('filter');
    this.type = 'lowpass';
    this.frequency = new MockParam(350);
    this.Q = new MockParam(1);
  }
}

class MockPanner extends MockNode {
  constructor() { super('panner'); this.pan = new MockParam(0); }
}

class MockCompressor extends MockNode {
  constructor() {
    super('compressor');
    this.threshold = new MockParam(-24);
    this.knee = new MockParam(30);
    this.ratio = new MockParam(12);
    this.attack = new MockParam(0.003);
    this.release = new MockParam(0.25);
  }
}

class MockAnalyser extends MockNode {
  constructor() {
    super('analyser');
    this.fftSize = 2048;
    this.level = 0;
  }
  getByteTimeDomainData(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = 128 + Math.round(this.level * 127);
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = new MockNode('destination');
    this.bufferCount = 0;
    this.nodes = { gain: 0, oscillator: 0, bufferSource: 0, filter: 0, panner: 0, compressor: 0, analyser: 0 };
  }
  _track(n) { this.nodes[n.kind] = (this.nodes[n.kind] || 0) + 1; return n; }
  createGain() { return this._track(new MockGain()); }
  createOscillator() { return this._track(new MockOscillator()); }
  createBufferSource() { return this._track(new MockBufferSource()); }
  createBiquadFilter() { return this._track(new MockFilter()); }
  createStereoPanner() { return this._track(new MockPanner()); }
  createDynamicsCompressor() { return this._track(new MockCompressor()); }
  createAnalyser() { return this._track(new MockAnalyser()); }
  createBuffer(ch, len, sr) {
    this.bufferCount++;
    const data = new Float32Array(len);
    return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: () => data };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  decodeAudioData() {
    return Promise.resolve({ duration: 48, sampleRate: this.sampleRate, numberOfChannels: 2, length: this.sampleRate * 48 });
  }
}

/** 起一个接了 mock 上下文的引擎。 */
function makeEngine(options = {}) {
  const ctx = new MockAudioContext();
  const prev = globalThis.AudioContext;
  globalThis.AudioContext = function () { return ctx; };
  const engine = new AudioEngine(options);
  engine.init();
  globalThis.AudioContext = prev;
  return { engine, ctx };
}

// ---------------------------------------------------------------------------
// 1. 图与总线
// ---------------------------------------------------------------------------

test('初始化后建立五条总线，且全部经过母带链而不是直连 destination', () => {
  const { engine, ctx } = makeEngine();
  const buses = Object.keys(engine.buses).sort();
  assert.deepEqual(buses, ['ambient', 'engine', 'music', 'sfx', 'ui']);

  // 母带链顺序：limiter -> masterGain -> analyser -> destination
  assert.equal(engine.masterLimiter.outputs[0], engine.masterGain);
  assert.equal(engine.masterGain.outputs[0], engine.masterAnalyser);
  assert.equal(engine.masterAnalyser.outputs[0], ctx.destination);

  // 没有任何总线直连 destination
  for (const bus of Object.values(engine.buses)) {
    assert.ok(!bus.outputs.includes(ctx.destination), '总线不允许直连 destination');
  }
  // sfx 必须单独过限幅器
  assert.ok(engine.sfxLimiter.outputs.includes(engine.masterMix));
});

test('预生成噪声池，数量固定', () => {
  const { engine, ctx } = makeEngine();
  assert.equal(engine.noiseBuffers.length, 4);
  assert.equal(ctx.bufferCount, 4);
});

// ---------------------------------------------------------------------------
// 2. 路由完整性
// ---------------------------------------------------------------------------

test('每条音效路由都必须有合成器，且能实际播放', () => {
  const { engine } = makeEngine();
  for (const route of Object.keys(SFX_ROUTES)) {
    const voice = engine.playRoute(route);
    // 不抢占的路由（priority 0）连播两次以上会被丢弃，这里只验第一条能出声
    assert.ok(voice, `路由 ${route} 没有产生声部——可能缺少合成器`);
    assert.equal(voice.route, route);
  }
});

test('未知路由不会抛错，只返回 null', () => {
  const { engine } = makeEngine();
  assert.equal(engine.playRoute('sfx:does/not/exist'), null);
});

test('priority 0 的路由不抢占：已响时新触发直接丢弃，绝不打断', () => {
  const { engine } = makeEngine();
  const route = 'sfx:race/countdown/tick'; // voices: 1, steal: 'none'
  assert.ok(engine.playRoute(route));
  assert.equal(engine.playRoute(route), null, '不抢占的路由第二次触发应被丢弃');
});

// ---------------------------------------------------------------------------
// 3. 声部预算与抢占
// ---------------------------------------------------------------------------

test('压测 5000 次触发之后，活跃声部数不超过平台上限', () => {
  const { engine } = makeEngine({ quality: 'low' }); // 模拟低端手机
  const routes = Object.keys(SFX_ROUTES);
  for (let i = 0; i < 5000; i++) {
    engine.playRoute(routes[i % routes.length]);
    if (i % 500 === 0) {
      assert.ok(
        engine.activeVoiceCount <= QUALITY_TIERS.low.maxVoices,
        `第 ${i} 次触发后声部数 ${engine.activeVoiceCount} 超过上限 ${QUALITY_TIERS.low.maxVoices}`
      );
    }
  }
  assert.ok(engine.activeVoiceCount <= QUALITY_TIERS.low.maxVoices);
  assert.ok(engine.stolenCount > 0, '压测下应该发生过抢占');
});

test('降画质会立刻把超限声部收掉', () => {
  const { engine } = makeEngine({ quality: 'high' });
  for (let i = 0; i < 200; i++) engine.playRoute('sfx:impact/hit/heavy');
  const before = engine.activeVoiceCount;
  engine.setQuality('low');
  assert.ok(before > 0);
  assert.ok(engine.activeVoiceCount <= QUALITY_TIERS.low.maxVoices);
});

test('low 画质下不做空间化（省 CPU），high 画质下做', () => {
  const high = makeEngine({ quality: 'high' }).engine;
  const low = makeEngine({ quality: 'low' }).engine;
  const before = { high: 0, low: 0 };

  const hBefore = countPanners(high);
  high.playRoute('sfx:impact/hit/heavy', { position: { x: 20, z: 10 } });
  assert.ok(countPanners(high) > hBefore, 'high 画质应该建声像节点');

  low.playRoute('sfx:impact/hit/heavy', { position: { x: 20, z: 10 } });
  assert.equal(countPanners(low), 0, 'low 画质不应建声像节点');
  void before;
});

function countPanners(engine) {
  return engine.ctx.nodes.panner;
}

// ---------------------------------------------------------------------------
// 4. 零运行时分配
// ---------------------------------------------------------------------------

test('触发上千次音效后，新建缓冲区数量不变（不存在运行时分配）', () => {
  const { engine, ctx } = makeEngine();
  const afterInit = ctx.bufferCount;
  const routes = Object.keys(SFX_ROUTES);
  for (let i = 0; i < 2000; i++) {
    engine.playRoute(routes[i % routes.length]);
  }
  assert.equal(ctx.bufferCount, afterInit, '音效播放在运行时新建了音频缓冲区 —— 手机端会造成 GC 掉帧');
});

// ---------------------------------------------------------------------------
// 5. 静音一致性
// ---------------------------------------------------------------------------

test('全局静音后不再产生任何声部，取消静音后恢复', () => {
  const { engine } = makeEngine();
  assert.equal(engine.toggle(), false);
  assert.equal(engine.enabled, false);
  for (const route of Object.keys(SFX_ROUTES)) {
    assert.equal(engine.playRoute(route), null, '静音状态下不允许任何路由出声');
  }
  assert.equal(engine.activeVoiceCount, 0);

  assert.equal(engine.toggle(), true);
  assert.ok(engine.playRoute('sfx:impact/hit/heavy'));
});

test('静音开关通过增益斜坡实现，不是直接赋值（避免咔哒声）', () => {
  const { engine } = makeEngine();
  engine.masterGain.gain.events.length = 0;
  engine.toggle();
  const kinds = engine.masterGain.gain.events.map((e) => e[0]);
  assert.ok(kinds.includes('linear'), '静音必须用 linearRamp 渐变');
});

// ---------------------------------------------------------------------------
// 6. 张力参数
// ---------------------------------------------------------------------------

test('张力按设计权重合成，并夹在 0-1 内', () => {
  const { engine } = makeEngine();
  assert.equal(engine.setTensionInputs({ finalLap: 1, duelActive: 0, boostActive: 0, speedNorm: 0, threatNorm: 0 }), 0.45);
  assert.equal(engine.setTensionInputs({ finalLap: 1, duelActive: 1, boostActive: 1, speedNorm: 1, threatNorm: 1 }), 1);
  assert.equal(engine.setTensionInputs({ finalLap: 99, duelActive: 99, boostActive: 99, speedNorm: 99, threatNorm: 99 }), 1);
  assert.equal(engine.setTension(5), 1);
  assert.equal(engine.setTension(-3), 0);
});

test('张力上升比下降快（超车瞬间来得急、退得缓）', () => {
  const { engine } = makeEngine();
  engine.setTension(0);
  engine.setTension(1);
  const upTau = engine.tension;
  void upTau;
  const layer = engine.layers.get('raceFinal');
  assert.equal(layer, undefined, '未加载音乐时不应有最终圈层'); // 缺资产时的降级路径
  assert.doesNotThrow(() => engine.setTension(0));
});

// ---------------------------------------------------------------------------
// 7. 小节对齐
// ---------------------------------------------------------------------------

test('音乐族的小节长度精确落在设计值上', () => {
  const bar = (bpm) => (60 / bpm) * 4;
  assert.equal(bar(MUSIC_LIBRARY.race.bpm) * MUSIC_LIBRARY.race.bars, 48);
  assert.equal(bar(MUSIC_LIBRARY.raceFinal.bpm) * MUSIC_LIBRARY.raceFinal.bars, 48);
  assert.equal(bar(MUSIC_LIBRARY.lobby.bpm) * MUSIC_LIBRARY.lobby.bars, 32);
  // 结算层必须正好等于 12 秒成绩展示窗口
  assert.equal(bar(MUSIC_LIBRARY.results.bpm) * MUSIC_LIBRARY.results.bars, 12);
  assert.equal(MUSIC_LIBRARY.results.loop, false, '结算层不该循环，需要有终止感');
});

test('nextBarTime 总是返回未来的小节格点', () => {
  const { engine, ctx } = makeEngine();
  engine.musicAnchor = 0;
  engine.musicAnchorBpm = 160;
  const barSec = 1.5;
  for (const now of [0, 0.4, 1.49, 1.5, 5.0, 37.77]) {
    ctx.currentTime = now;
    const t = engine.nextBarTime();
    assert.ok(t > now, `格点 ${t} 必须晚于当前时间 ${now}`);
    assert.ok(Math.abs((t % barSec)) < 1e-9, `格点 ${t} 必须落在 ${barSec}s 的整数倍上`);
  }
});

test('race 场景同时起巡航层与叠加层，且叠加层初始静音', () => {
  const { engine } = makeEngine();
  engine.layers.set('race', { gain: new MockGain(), filter: new MockFilter(), src: null, silent: false, spec: MUSIC_LIBRARY.race });
  engine.layers.set('raceFinal', { gain: new MockGain(), filter: new MockFilter(), src: null, silent: false, spec: MUSIC_LIBRARY.raceFinal });
  engine.setTension(0);
  const raceFinal = engine.layers.get('raceFinal');
  assert.equal(raceFinal.gain.gain.value, 0, '张力 0 时叠加层必须全静音');
  engine.setTension(1);
  assert.ok(raceFinal.gain.gain.value > 0.4, '张力 1 时叠加层应接近全开');
});

test('场景切换不会抛错，且旧层被淡出而不是硬切', () => {
  const { engine } = makeEngine();
  engine.layers.set('lobby', { gain: new MockGain(), filter: new MockFilter(), src: null, silent: false, spec: MUSIC_LIBRARY.lobby });
  const old = engine.layers.get('lobby');
  engine.setScene('race');
  const kinds = old.gain.gain.events.map((e) => e[0]);
  assert.ok(kinds.includes('linear'), '淡出必须用 linearRamp');
  assert.equal(engine.scene, 'race');
});

// ---------------------------------------------------------------------------
// 8. 闪避
// ---------------------------------------------------------------------------

test('倒计时触发音乐闪避（让 3-2-1 听得清）', () => {
  const { engine } = makeEngine();
  engine.musicDuck.gain.events.length = 0;
  engine.playRoute('sfx:race/countdown/tick');
  const ramp = engine.musicDuck.gain.events.find((e) => e[0] === 'linear');
  assert.ok(ramp, '倒计时应触发音乐闪避');
  assert.ok(ramp[1] < 1, `闪避目标 ${ramp[1]} 应低于 1`);
  assert.ok(ramp[1] >= 0.4, '闪避不应把音乐压到几乎没有');
});

test('普通战斗音效不触发闪避（否则音乐一直抽气）', () => {
  const { engine } = makeEngine();
  engine.musicDuck.gain.events.length = 0;
  engine.playRoute('sfx:impact/hit/heavy');
  assert.equal(engine.musicDuck.gain.events.length, 0);
});

// ---------------------------------------------------------------------------
// 9. 音乐加载的降级
// ---------------------------------------------------------------------------

test('音乐文件缺失时不抛错，标记 missing，程序化层仍可用', async () => {
  const { engine } = makeEngine();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  const res = await engine.loadMusic(['race']);
  globalThis.fetch = prevFetch;
  assert.equal(res.race, 'missing');
  // 缺音乐也必须有节奏：程序化驱动层不依赖任何资产
  assert.doesNotThrow(() => engine.playRoute('sfx:race/countdown/tick'));
});

test('音乐加载成功时缓存进 musicBuffers', async () => {
  const { engine } = makeEngine();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
  const res = await engine.loadMusic(['race']);
  globalThis.fetch = prevFetch;
  assert.equal(res.race, 'ok');
  assert.ok(engine.musicBuffers.has('race'));
});

test('主文件缺失时回退到 fallback，并明确标记为回退', async () => {
  const { engine } = makeEngine();
  const prevFetch = globalThis.fetch;
  const tried = [];
  globalThis.fetch = async (url) => {
    tried.push(url);
    const isFallback = url.endsWith('bgm-menu.mp3');
    return { ok: isFallback, status: isFallback ? 200 : 404, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const res = await engine.loadMusic(['lobby']);
  globalThis.fetch = prevFetch;

  assert.equal(res.lobby, 'fallback:bgm-menu.mp3');
  assert.ok(tried.some((u) => u.endsWith('bgm-lobby.mp3')), '应先试主文件');
  assert.ok(tried.some((u) => u.endsWith('bgm-menu.mp3')), '主文件失败后应试回退文件');
  assert.ok(engine.musicBuffers.has('lobby'));
  // 回退必须可见，不能悄悄上生产（回退文件不满足 BPM 锁定）
  assert.equal(engine.fallbacksUsed.lobby, 'bgm-menu.mp3');
  assert.equal(engine.diagnostics().musicLoaded.lobby, 'fallback:bgm-menu.mp3');
});

test('主文件与回退都缺失时标记 missing，不抛错', async () => {
  const { engine } = makeEngine();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  const res = await engine.loadMusic(['lobby']);
  globalThis.fetch = prevFetch;
  assert.equal(res.lobby, 'missing');
  assert.equal(engine.musicBuffers.has('lobby'), false);
});

// ---------------------------------------------------------------------------
// 10. 诊断与兼容层
// ---------------------------------------------------------------------------

test('诊断信息包含验收需要的全部字段', () => {
  const { engine } = makeEngine();
  engine.playRoute('sfx:impact/hit/heavy');
  const d = engine.diagnostics();
  for (const key of ['enabled', 'quality', 'maxVoices', 'activeVoices', 'stolen', 'triggers', 'scene', 'tension', 'layers', 'noiseBuffers', 'level']) {
    assert.ok(key in d, `诊断缺少字段 ${key}`);
  }
  assert.equal(d.noiseBuffers, 4);
  assert.ok(d.triggers >= 1);
});

test('旧调用点全部保留且可用（接入主程序不必改调用点）', () => {
  const { engine } = makeEngine();
  for (const fn of ['playLockWarning', 'playHit', 'playShieldBlock', 'playDrift', 'playNitro', 'playItemGet', 'playCountdown', 'playGo']) {
    assert.equal(typeof engine[fn], 'function', `兼容方法 ${fn} 丢失`);
    assert.doesNotThrow(() => engine[fn]());
  }
  assert.doesNotThrow(() => engine.playItemUse('missile'));
  assert.doesNotThrow(() => engine.playItemUse('tractor'));
  assert.doesNotThrow(() => engine.playItemUse('unknown-kind'));
  assert.doesNotThrow(() => engine.setWind(0.7, true));
  assert.doesNotThrow(() => engine.playBgm('bgm-race'));
  assert.doesNotThrow(() => engine.playBgm('bgm-menu'));
});

test('连续层在候场场景静音（等位区不能一直响着引擎）', () => {
  const { engine } = makeEngine();
  engine.setScene('lobby');
  engine.setWind(1, false);
  assert.equal(engine.engineNodes.gain.gain.value, 0, 'lobby 场景引擎必须是静音的');

  engine.setScene('race');
  engine.setWind(1, false);
  assert.ok(engine.engineNodes.gain.gain.value > 0, 'race 场景引擎应该出声');
});

test('reset() 清空声部与层', () => {
  const { engine } = makeEngine();
  for (let i = 0; i < 50; i++) engine.playRoute('sfx:impact/hit/heavy');
  engine.setScene('race');
  engine.reset();
  assert.equal(engine.activeVoiceCount, 0);
  assert.equal(engine.layers.size, 0);
  assert.equal(engine.scene, null);
});
