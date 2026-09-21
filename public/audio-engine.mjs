// ===========================================================================
// audio-engine.mjs — 极速等位赛 交互音频引擎
// ===========================================================================
//
// 设计依据：docs/AUDIO_DESIGN.md（本文所有参数以那份文档为准）
//
// 这个文件替代 app.mjs 里原来那段"振荡器直连 destination"的 AudioEngine。
// 它把音频从"音效播放"做成"用声音表达比赛状态"：
//
//   · 五条总线的混音架构 + 两级限幅（防 8 台车同帧开火削顶）
//   · 音乐闪避（倒计时听得清）
//   · 自适应音乐：一个 0-1 张力参数驱动层混合，按小节边界交叉淡化
//   · 程序化驱动层（16 分踩镲与加花底鼓），与音乐 BPM 逐拍锁定
//   · 音效随机化容器（音高/增益/时长每次不同，没有两次一模一样）
//   · 声部上限 + 三种抢占模式（低端手机不会因为 8 台车开火而卡住）
//   · 复用噪声缓冲（零运行时分配，消除 GC 掉帧）
//   · 大屏空间音频（声像 + 距离衰减）
//   · 引擎/风/胎噪连续层，随速度实时调制
//
// 零外部依赖。不依赖 DOM（可在 Node 里用 mock AudioContext 做单元测试）。
//
// 快速用法
// --------
//   import { audio } from './audio-engine.mjs';
//   window.addEventListener('pointerdown', () => audio.init(), { once: true });
//   await audio.loadMusic();               // 大屏才需要；手机可跳过
//   audio.setScene('lobby');
//   audio.setTensionInputs({ finalLap: 1, duelActive: 1 });
//   audio.playRoute('sfx:impact/hit/heavy');
//
// 兼容旧调用：playBgm('bgm-race'|'bgm-menu')、playHit()、playNitro() 等
// 全部保留，内部转成新的路由与场景，接入主程序不需要改调用点。
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. 配置表
// ---------------------------------------------------------------------------

/**
 * 音乐族。BPM 与长度锁定是交叉淡化可用的前提，改动前先读 AUDIO_DESIGN.md 第 5 节。
 *
 * `fallback`：新曲库尚未生成时的回退文件。候场层回退到仓库既有的 `bgm-menu.mp3`，
 * 这样音频系统在音乐生成完成之前就能整体跑起来（比赛层本来就有 bgm-race.mp3）。
 * 回退文件不符合 BPM 锁定，只用于开发期试听，不能作为最终交付。
 */
export const MUSIC_LIBRARY = {
  lobby: { file: 'bgm-lobby.mp3', fallback: 'bgm-menu.mp3', bpm: 120, bars: 16, loop: true, gain: 0.55 },
  race: { file: 'bgm-race.mp3', bpm: 160, bars: 32, loop: true, gain: 0.55 },
  raceFinal: { file: 'bgm-race-final.mp3', bpm: 160, bars: 32, loop: true, gain: 0.5 },
  results: { file: 'bgm-results.mp3', bpm: 160, bars: 8, loop: false, gain: 0.6 },
};

/** 旧代码用的曲名 -> 新场景名。保留是为了接入时不必改调用点。 */
const LEGACY_TRACK_ALIAS = { 'bgm-menu': 'lobby', 'bgm-race': 'race' };

/** 总线配置。所有声音必须走总线，禁止直连 destination。 */
export const BUS_CONFIG = {
  music: { gain: 0.55, limiter: false },
  engine: { gain: 0.35, limiter: false },
  sfx: { gain: 0.7, limiter: true },
  ui: { gain: 0.8, limiter: false },
  ambient: { gain: 0.25, limiter: false },
};

/**
 * 音效路由表。priority 越小越重要；steal 决定声部满时踢掉谁。
 * 见 AUDIO_DESIGN.md 第 6 节（这张表与那里的表必须一致）。
 */
export const SFX_ROUTES = {
  'sfx:race/countdown/tick': { priority: 0, voices: 1, steal: 'none', bus: 'ui', duck: true },
  'sfx:race/countdown/go': { priority: 0, voices: 1, steal: 'none', bus: 'ui', duck: true },
  'sfx:race/finish/line': { priority: 0, voices: 2, steal: 'none', bus: 'ui', duck: true },
  'sfx:race/lap/final': { priority: 0, voices: 1, steal: 'none', bus: 'ui', duck: true },
  'sfx:ui/button/click': { priority: 0, voices: 4, steal: 'none', bus: 'ui' },
  'sfx:weapon/missile/lock': { priority: 1, voices: 1, steal: 'oldest', bus: 'sfx' },
  'sfx:defense/shield/perfect': { priority: 1, voices: 2, steal: 'oldest', bus: 'sfx' },
  'sfx:motion/boost/nitro': { priority: 1, voices: 2, steal: 'oldest', bus: 'sfx' },
  'sfx:motion/boost/mini': { priority: 2, voices: 2, steal: 'oldest', bus: 'sfx' },
  'sfx:pickup/box/open': { priority: 1, voices: 4, steal: 'oldest', bus: 'sfx' },
  'sfx:weapon/missile/launch': { priority: 2, voices: 4, steal: 'farthest', bus: 'sfx' },
  'sfx:weapon/mine/drop': { priority: 2, voices: 4, steal: 'farthest', bus: 'sfx' },
  'sfx:defense/shield/deploy': { priority: 2, voices: 2, steal: 'farthest', bus: 'sfx' },
  'sfx:motion/emp/blast': { priority: 2, voices: 2, steal: 'farthest', bus: 'sfx' },
  'sfx:motion/tractor/pull': { priority: 2, voices: 2, steal: 'farthest', bus: 'sfx' },
  'sfx:impact/hit/heavy': { priority: 2, voices: 6, steal: 'farthest', bus: 'sfx' },
  'sfx:weapon/tractor/pull': { priority: 3, voices: 4, steal: 'oldest', bus: 'sfx' },
  'sfx:race/overtake/up': { priority: 3, voices: 4, steal: 'oldest', bus: 'sfx' },
  'sfx:race/overtake/down': { priority: 3, voices: 4, steal: 'oldest', bus: 'sfx' },
};

/** 画质档 -> 声部上限。见 AUDIO_DESIGN.md 第 9 节。 */
export const QUALITY_TIERS = {
  high: { maxVoices: 48, virtualVoices: 128, spatial: true },
  low: { maxVoices: 12, virtualVoices: 32, spatial: false },
};

const NOISE_BUFFER_SECONDS = 2;
const NOISE_BUFFER_COUNT = 4;

/** 跨 BPM 场景切换用长淡化（无法对齐相位，只能用时长换平滑）。 */
const SCENE_FADE_BARS = 4;
/** 同 BPM 层间切换用 2 小节，对齐小节边界。 */
const LAYER_FADE_BARS = 2;

// ---------------------------------------------------------------------------
// 2. 小工具
// ---------------------------------------------------------------------------

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const rand = (a, b) => a + Math.random() * (b - a);

/** 音高随机 ±cents 音分，返回频率倍率。音效"随机化容器"的基础。 */
const centsMul = (cents) => Math.pow(2, cents / 1200);

/** 60/BPM*4 —— 4/4 拍一小节的秒数。 */
const barSeconds = (bpm) => (60 / bpm) * 4;

// ---------------------------------------------------------------------------
// 3. 引擎主体
// ---------------------------------------------------------------------------

export class AudioEngine {
  constructor(options = {}) {
    this.ctx = null;
    this.enabled = true;
    /** 音乐是否在本端播放。手机应保持 false —— 见 AUDIO_DESIGN.md 第 4 节。 */
    this.musicEnabled = options.musicEnabled !== false;
    this.quality = options.quality || 'high';
    this.baseUrl = options.baseUrl || '/audio/';

    // 总线
    this.buses = {};
    this.masterGain = null;
    this.masterLimiter = null;
    this.musicDuck = null;
    this.masterAnalyser = null;

    // 音乐
    this.scene = null;
    this.musicBuffers = new Map();
    this.layers = new Map(); // key -> { src, gain, filter, startedAt, spec }
    this.musicAnchor = 0;
    this.pendingFades = [];

    // 声部
    this.voices = [];
    this.stolenCount = 0;
    this.triggerCount = 0;

    // 噪声池
    this.noiseBuffers = [];
    this.noiseCursor = 0;

    // 张力
    this.tensionInputs = { finalLap: 0, duelActive: 0, boostActive: 0, speedNorm: 0, threatNorm: 0 };
    this.tension = 0;
    this._tensionTarget = 0;

    // 连续层
    this.engineNodes = null;
    this.windNodes = null;
    this.tireNodes = null;

    // 调度
    this._schedulerTimer = null;
    this._driveStep = 0;
    this._nextDriveTime = 0;
    this._lastLockWarning = 0;
    this._lastDrift = 0;

    // 闪避
    this._duckUntil = 0;
    this._duckActive = false;

    this._visibilityBound = false;
  }

  // -------------------------------------------------------------------------
  // 3.1 生命周期
  // -------------------------------------------------------------------------

  /**
   * 创建/恢复 AudioContext 与总线。必须在用户手势里调用（浏览器自动播放策略）。
   * 幂等：重复调用只做 resume。
   */
  init() {
    if (!this.ctx) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) return false;
      this.ctx = new Ctor();
      this._buildGraph();
      this._primeNoise();
      this._bindVisibility();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  }

  _buildGraph() {
    const ctx = this.ctx;

    // 母带链：masterMix -> masterLimiter -> masterGain -> analyser -> destination
    this.masterMix = ctx.createGain();
    this.masterLimiter = ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -6;
    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.attack.value = 0.003;
    this.masterLimiter.release.value = 0.12;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.enabled ? 1 : 0;

    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;

    this.masterMix.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterGain);
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(ctx.destination);

    // 音乐闪避节点单独串在 music 总线上
    this.musicDuck = ctx.createGain();
    this.musicDuck.gain.value = 1;
    this.musicDuck.connect(this.masterMix);

    // 音效限幅器：管住"同帧 8 台车一起爆炸"，与母带限幅分工（AUDIO_DESIGN.md 第 3 节）
    const sfxLimiter = ctx.createDynamicsCompressor();
    sfxLimiter.threshold.value = -10;
    sfxLimiter.knee.value = 3;
    sfxLimiter.ratio.value = 12;
    sfxLimiter.attack.value = 0.002;
    sfxLimiter.release.value = 0.1;
    sfxLimiter.connect(this.masterMix);

    for (const [name, cfg] of Object.entries(BUS_CONFIG)) {
      const g = ctx.createGain();
      g.gain.value = cfg.gain;
      if (name === 'music') g.connect(this.musicDuck);
      else if (cfg.limiter) g.connect(sfxLimiter);
      else g.connect(this.masterMix);
      this.buses[name] = g;
    }
    this.sfxLimiter = sfxLimiter;
  }

  /** 预生成噪声缓冲。运行时零分配 —— 这是消除手机 GC 掉帧的关键。 */
  _primeNoise() {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * NOISE_BUFFER_SECONDS);
    for (let i = 0; i < NOISE_BUFFER_COUNT; i++) {
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let j = 0; j < len; j++) d[j] = Math.random() * 2 - 1;
      this.noiseBuffers.push(buf);
    }
  }

  /** 取一张噪声缓冲并轮换，避免连续两次用同一段噪声（听感上会"重复"）。 */
  _noiseBuffer() {
    const b = this.noiseBuffers[this.noiseCursor];
    this.noiseCursor = (this.noiseCursor + 1) % this.noiseBuffers.length;
    return b;
  }

  _bindVisibility() {
    if (this._visibilityBound) return;
    const doc = globalThis.document;
    if (!doc || !doc.addEventListener) return;
    this._visibilityBound = true;
    doc.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (doc.hidden) {
        this.pauseAll();
      } else if (this.enabled) {
        this.ctx.resume().catch(() => {});
        this.setScene(this.scene, { immediate: true });
        this._startScheduler();
      }
    });
  }

  /** 切后台：暂停音乐与调度，不销毁上下文。回到前台由 visibilitychange 恢复。 */
  pauseAll() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const layer of this.layers.values()) {
      layer.gain.gain.cancelScheduledValues(t);
      layer.gain.gain.setTargetAtTime(0, t, 0.05);
    }
    this._stopScheduler();
    this.setTension(0);
  }

  /** 全局静音开关。必须让**所有**总线归零，不能漏。 */
  toggle() {
    this.enabled = !this.enabled;
    if (!this.ctx) return this.enabled;
    const t = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(t);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, t);
    this.masterGain.gain.linearRampToValueAtTime(this.enabled ? 1 : 0, t + 0.12);
    if (this.enabled) {
      if (this.scene) this.setScene(this.scene, { immediate: true });
      this._startScheduler();
    } else {
      this._stopScheduler();
    }
    return this.enabled;
  }

  setQuality(tier) {
    if (!QUALITY_TIERS[tier]) return this.quality;
    this.quality = tier;
    // 降档时立刻把超出新上限的声部收掉
    this._enforceVoiceLimit();
    return this.quality;
  }

  get maxVoices() {
    return QUALITY_TIERS[this.quality].maxVoices;
  }

  // -------------------------------------------------------------------------
  // 3.2 音乐：解码缓冲 + 采样级精确循环 + 小节对齐交叉淡化
  // -------------------------------------------------------------------------

  /**
   * 加载音乐缓冲。只在需要播放音乐的端调用（大屏）。
   * 单轨失败不影响其它轨，也不影响程序化驱动层 —— 这是刻意的降级设计。
   * 主文件缺失时尝试 fallback（见 MUSIC_LIBRARY 注释）。
   */
  async loadMusic(keys = null) {
    if (!this.init()) return {};
    const targets = keys || Object.keys(MUSIC_LIBRARY);
    const result = {};
    await Promise.all(
      targets.map(async (key) => {
        if (this.musicBuffers.has(key)) {
          result[key] = 'cached';
          return;
        }
        const spec = MUSIC_LIBRARY[key];
        if (!spec) {
          result[key] = 'unknown';
          return;
        }
        const candidates = [spec.file, spec.fallback].filter(Boolean);
        for (const file of candidates) {
          try {
            const res = await fetch(this.baseUrl + file);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const raw = await res.arrayBuffer();
            const buf = await this.ctx.decodeAudioData(raw);
            this.musicBuffers.set(key, buf);
            if (file !== spec.file) {
              // 回退文件不满足 BPM/长度锁定，会让小节对齐失准 —— 明确告警，别让它悄悄上生产
              this.fallbacksUsed = this.fallbacksUsed || {};
              this.fallbacksUsed[key] = file;
              if (globalThis.console) {
                console.warn(`[audio] 层 ${key} 使用回退文件 ${file}（非最终交付，仅开发期可用）`);
              }
              result[key] = `fallback:${file}`;
            } else {
              result[key] = 'ok';
            }
            return;
          } catch {
            /* 试下一个候选 */
          }
        }
        // 缺文件是预期情况（音乐在生成中/仅大屏部署），不抛错
        result[key] = 'missing';
        if (globalThis.console) {
          console.info(`[audio] 音乐层 ${key} 未加载（试过 ${candidates.join(', ')}）`);
        }
      })
    );
    this.musicLoadResult = result;
    return result;
  }

  /**
   * 切换音乐场景。scene ∈ 'lobby' | 'race' | 'results' | null。
   * 兼容旧调用：setScene('bgm-race') 会被别名成 'race'。
   */
  setScene(scene, opts = {}) {
    if (!this.ctx) {
      this.scene = scene; // 记住意图，init 后再起
      return;
    }
    const name = LEGACY_TRACK_ALIAS[scene] || scene;
    if (this.scene === name && !opts.immediate) return;

    // 淡出用**旧曲目**的 BPM 计算时长，淡入用新曲目的 —— 否则跨 BPM 切换的
    // 淡化时长会算错，听起来就是"掐断"。
    const oldBpm = this.musicAnchorBpm || 160;
    this.scene = name;
    if (!this.musicEnabled || !name) {
      this._fadeOutAll(SCENE_FADE_BARS, [], oldBpm);
      return;
    }

    const spec = MUSIC_LIBRARY[name];
    if (!spec) return;

    // 判断是否需要保留旧层（race 场景内 cruise/final 是层间关系，不是场景切换）
    const keep = name === 'race' ? ['race', 'raceFinal'] : [];

    this._fadeOutAll(SCENE_FADE_BARS, keep, oldBpm);

    const fadeSec = barSeconds(spec.bpm) * (opts.immediate ? 0.25 : SCENE_FADE_BARS);
    const startAt = this.ctx.currentTime + 0.05;

    // 场景锚点：所有该 BPM 的层都以它为相位基准
    this.musicAnchor = startAt;
    this.musicAnchorBpm = spec.bpm;

    if (name === 'race') {
      this._ensureLayer('race', { startAt, fadeSec, fadeIn: true, initialGain: 0 });
      // raceFinal 先起但静音，张力上来时只改增益 —— 保证随时可入且永远同相
      this._ensureLayer('raceFinal', { startAt, fadeSec: 0.01, fadeIn: false, initialGain: 0 });
      this._startScheduler();
    } else {
      this._ensureLayer(name, { startAt, fadeSec, fadeIn: true, initialGain: 0 });
      this._stopScheduler();
    }
  }

  _ensureLayer(key, { startAt, fadeSec, fadeIn, initialGain }) {
    const ctx = this.ctx;
    const spec = MUSIC_LIBRARY[key];
    const buffer = this.musicBuffers.get(key);

    // 已有层：只调增益（层间切换的常规路径）
    const existing = this.layers.get(key);
    if (existing) {
      existing.gain.gain.cancelScheduledValues(ctx.currentTime);
      existing.gain.gain.setValueAtTime(existing.gain.gain.value, ctx.currentTime);
      if (fadeIn) {
        existing.gain.gain.linearRampToValueAtTime(spec.gain, ctx.currentTime + Math.max(fadeSec, 0.05));
      }
      return existing;
    }

    const gain = ctx.createGain();
    gain.gain.value = initialGain;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 20000;
    gain.connect(filter);
    filter.connect(this.buses.music);

    let src = null;
    let startedAt = startAt;
    if (buffer) {
      src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = spec.loop;
      src.connect(gain);
      try {
        src.start(startAt);
      } catch {
        src.start();
        startedAt = ctx.currentTime;
      }
      if (fadeIn) {
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(spec.gain, ctx.currentTime + Math.max(fadeSec, 0.05));
      }
    }

    const layer = { key, src, gain, filter, startedAt, spec, silent: !buffer };
    this.layers.set(key, layer);
    return layer;
  }

  _fadeOutAll(bars, keep = [], bpm = this.musicAnchorBpm || 160) {
    const ctx = this.ctx;
    if (!ctx) return;
    const fadeSec = Math.max(0, barSeconds(bpm) * bars);
    for (const [key, layer] of [...this.layers.entries()]) {
      if (keep.includes(key)) continue;
      const t = ctx.currentTime;
      layer.gain.gain.cancelScheduledValues(t);
      layer.gain.gain.setValueAtTime(layer.gain.gain.value, t);
      layer.gain.gain.linearRampToValueAtTime(0, t + fadeSec);
      const stopAt = t + fadeSec + 0.1;
      if (layer.src) {
        try {
          layer.src.stop(stopAt);
        } catch {
          /* 已经停过 */
        }
      }
      this.layers.delete(key);
    }
  }

  /**
   * 音乐张力 0-1。驱动 raceFinal 层增益、滤波亮度与程序化驱动层。
   * 上升快（150ms）下降慢（1.2s）—— 超车瞬间紧张感来得急退得缓。
   */
  setTension(v) {
    this.tension = clamp(v, 0, 1);
    if (!this.ctx) return this.tension;
    const ctx = this.ctx;
    const up = this.tension > this._tensionTarget;
    const tau = up ? 0.15 : 1.2;
    this._tensionTarget = this.tension;

    const finalLayer = this.layers.get('raceFinal');
    if (finalLayer) {
      const base = MUSIC_LIBRARY.raceFinal.gain;
      // 0.35 以下不该听到叠加层；0.65 以上全开
      const mix = clamp((this.tension - 0.35) / 0.3, 0, 1);
      finalLayer.gain.gain.setTargetAtTime(base * mix, ctx.currentTime, tau);
      finalLayer.filter.type = 'lowpass';
      finalLayer.filter.frequency.setTargetAtTime(1200 + mix * 18800, ctx.currentTime, tau);
    }
    const raceLayer = this.layers.get('race');
    if (raceLayer) {
      // 高张力时把主层稍微让位给叠加层，避免中频堆积
      const base = MUSIC_LIBRARY.race.gain;
      raceLayer.gain.gain.setTargetAtTime(base * (1 - 0.25 * this.tension), ctx.currentTime, tau);
      raceLayer.filter.frequency.setTargetAtTime(8000 + this.tension * 12000, ctx.currentTime, tau);
    }
    this._updateContinuousLayers();
    return this.tension;
  }

  /**
   * 从游戏状态推导张力。调用点应该每 ~0.2s 调一次，不要逐帧调。
   * 权重见 AUDIO_DESIGN.md 第 5.2 节。
   */
  setTensionInputs(inputs) {
    Object.assign(this.tensionInputs, inputs);
    const i = this.tensionInputs;
    const t =
      0.45 * clamp(i.finalLap || 0, 0, 1) +
      0.25 * clamp(i.duelActive || 0, 0, 1) +
      0.15 * clamp(i.boostActive || 0, 0, 1) +
      0.1 * clamp(i.speedNorm || 0, 0, 1) +
      0.05 * clamp(i.threatNorm || 0, 0, 1);
    return this.setTension(t);
  }

  /** 兼容旧调用：playBgm('bgm-race') / playBgm('bgm-menu') */
  playBgm(track) {
    this.setScene(LEGACY_TRACK_ALIAS[track] || track);
  }

  /** 当前场景的下一个小节边界（ctx 时间）。 */
  nextBarTime(bpm = this.musicAnchorBpm || 160, anchor = this.musicAnchor) {
    const bar = barSeconds(bpm);
    const elapsed = this.ctx.currentTime - anchor;
    const k = Math.floor(elapsed / bar) + 1;
    return anchor + k * bar;
  }

  // -------------------------------------------------------------------------
  // 3.3 程序化驱动层：与音乐 BPM 逐拍锁定，张力越高越密
  // -------------------------------------------------------------------------

  _startScheduler() {
    if (this._schedulerTimer || !this.ctx) return;
    this._nextDriveTime = this.ctx.currentTime + 0.1;
    this._schedulerTimer = setInterval(() => this._schedulerTick(), 25);
    // 浏览器里返回值是数字（没有 unref）；Node 里是 Timeout 对象。
    // unref 让测试进程结束后能正常退出，不会因为调度器挂着而卡住。
    if (typeof this._schedulerTimer?.unref === 'function') this._schedulerTimer.unref();
  }

  _stopScheduler() {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
    }
  }

  /**
   * 前瞻调度（标准 look-ahead 模式）：每 25ms 醒来，把未来 120ms 内的拍点排好。
   * 用 ctx 时钟而不是 setInterval 累加，所以不会漂移。
   */
  _schedulerTick() {
    if (!this.ctx || !this.enabled) return;
    if (this.scene !== 'race') return;
    const bpm = this.musicAnchorBpm || 160;
    const sixteenth = 60 / bpm / 4;
    const horizon = this.ctx.currentTime + 0.12;
    let guard = 0;
    while (this._nextDriveTime < horizon && guard++ < 64) {
      this._scheduleDriveStep(this._driveStep, this._nextDriveTime);
      this._driveStep = (this._driveStep + 1) % 16;
      this._nextDriveTime += sixteenth;
    }
  }

  /** 一个 16 分格点。只有张力够高时才出声 —— 低张力时音乐本身已经够满。 */
  _scheduleDriveStep(step, when) {
    const t = this.tension;
    if (t < 0.5) return;
    const drive = clamp((t - 0.5) / 0.5, 0, 1);
    const beat = step % 4 === 0;
    const eighth = step % 2 === 0;

    // 底鼓：张力高时在 3 拍与 4 拍半加花
    const kickHere = beat && (step === 0 || step === 8) ||
      (drive > 0.7 && (step === 12 || step === 14));
    if (kickHere) this._synthDriveKick(when, 0.5 + 0.5 * drive);

    // 闭合踩镲：0.5-0.65 走 8 分，0.65 以上走 16 分
    const hatHere = drive > 0.3 ? (drive > 0.65 ? true : eighth) : false;
    if (hatHere) this._synthDriveHat(when, (eighth ? 0.18 : 0.11) * (0.6 + 0.4 * drive), step);
  }

  _synthDriveKick(when, amp) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, when);
    osc.frequency.exponentialRampToValueAtTime(46, when + 0.09);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(amp * 0.5, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
    osc.connect(g);
    g.connect(this.buses.sfx);
    osc.start(when);
    osc.stop(when + 0.18);
  }

  _synthDriveHat(when, amp, step) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer();
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'highpass';
    bp.frequency.value = 7000 + rand(-500, 500);
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + (step % 4 === 2 ? 0.09 : 0.04));
    src.connect(bp);
    bp.connect(g);
    g.connect(this.buses.sfx);
    src.start(when, rand(0, 1));
    src.stop(when + 0.12);
  }

  // -------------------------------------------------------------------------
  // 3.4 声部管理：上限 + 抢占
  // -------------------------------------------------------------------------

  /**
   * 把声部数裁到上限以内。
   * @param {number} reserve 为新声部预留的槽位。调用方在**将要 push 之前**调用时
   *   必须传 1，否则 push 之后会短暂超限一个 —— 这正是压测会抓到的那个 bug。
   */
  _enforceVoiceLimit(reserve = 0) {
    const limit = Math.max(0, this.maxVoices - reserve);
    const now = this.ctx ? this.ctx.currentTime : 0;
    this.voices = this.voices.filter((v) => v.stopAt > now - 0.05);
    while (this.voices.length > limit) this._stealOne('oldest');
  }

  _stealOne(mode) {
    if (!this.voices.length) return;
    let victim = this.voices[0];
    if (mode === 'farthest') {
      victim = this.voices.reduce((a, b) => ((b.distance || 0) > (a.distance || 0) ? b : a), this.voices[0]);
    } else if (mode === 'quietest') {
      victim = this.voices.reduce((a, b) => ((b.peak || 0) < (a.peak || 0) ? b : a), this.voices[0]);
    }
    // 把受害者快速淡出（8ms），不做硬切 —— 硬切会产生咔哒声
    const t = this.ctx.currentTime;
    try {
      victim.gain.gain.cancelScheduledValues(t);
      victim.gain.gain.setValueAtTime(victim.gain.gain.value, t);
      victim.gain.gain.linearRampToValueAtTime(0, t + 0.008);
    } catch {
      /* 节点可能已断开 */
    }
    for (const node of victim.nodes || []) {
      try {
        node.stop(t + 0.012);
      } catch {
        /* 已停 */
      }
    }
    this.voices = this.voices.filter((v) => v !== victim);
    this.stolenCount++;
  }

  /** 已激活的声部数（诊断用）。 */
  get activeVoiceCount() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    this.voices = this.voices.filter((v) => v.stopAt > now);
    return this.voices.length;
  }

  // -------------------------------------------------------------------------
  // 3.5 播放入口
  // -------------------------------------------------------------------------

  /**
   * 播一条音效路由。
   * @param {string} route  形如 'sfx:impact/hit/heavy'
   * @param {object} opts   { position:{x,y,z}, spatial:boolean, gain, pitchCents, pan }
   */
  playRoute(route, opts = {}) {
    if (!this.enabled || !this.ctx) return null;
    const cfg = SFX_ROUTES[route];
    if (!cfg) {
      if (globalThis.console) console.warn(`[audio] 未知路由 ${route}`);
      return null;
    }
    const synth = SYNTHS[route];
    if (!synth) return null;

    // 路由级并发限制：同一路由同时最多 cfg.voices 个
    const now = this.ctx.currentTime;
    const same = this.voices.filter((v) => v.route === route && v.stopAt > now);
    if (same.length >= cfg.voices && cfg.steal !== 'none') {
      const victim = cfg.steal === 'oldest' ? same[0] : same[same.length - 1];
      this._stealOne('oldest');
      void victim;
    } else if (same.length >= cfg.voices && cfg.steal === 'none') {
      return null; // 不抢占的路由直接丢弃，永不打断已响的
    }

    // 预留 1 个槽位给即将创建的新声部，否则 push 之后会短暂超限
    this._enforceVoiceLimit(1);

    const bus = this.buses[cfg.bus] || this.buses.sfx;
    const t = now + 0.002;

    // 每条音效独立增益，便于抢占与随机化
    const vGain = this.ctx.createGain();
    let head = vGain;

    // 空间化：大屏才有；low 档退化为纯 2D（省 CPU）
    const useSpatial = opts.spatial !== false && QUALITY_TIERS[this.quality].spatial && !!opts.position;
    if (useSpatial) {
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = this._panOf(opts.position);
      const dist = this._attenuation(opts.position);
      vGain.gain.value = dist.gain;
      if (dist.lowpass) {
        // 远处低通：模拟空气吸收，让"很远的车"听起来真的远
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = dist.lowpass;
        vGain.connect(lp);
        lp.connect(pan);
      } else {
        vGain.connect(pan);
      }
      pan.connect(bus);
    } else {
      vGain.connect(bus);
    }

    const started = synth(this.ctx, head, t, {
      noise: () => this._noiseBuffer(),
      gain: opts.gain != null ? opts.gain : 1,
      pitch: opts.pitchCents || 0,
    });

    const voice = {
      route,
      gain: vGain,
      nodes: started.nodes,
      stopAt: started.duration ? t + started.duration : t + 0.5,
      distance: opts.position ? Math.hypot(opts.position.x || 0, opts.position.z || 0) : 0,
      peak: started.peak || 0.3,
      busName: cfg.bus,
    };
    this.voices.push(voice);
    this.triggerCount++;

    if (cfg.duck) this._duck();

    return voice;
  }

  _attenuation(pos) {
    const d = Math.hypot(pos.x || 0, pos.z || 0);
    const min = 8;
    const max = 90;
    const gain = d <= min ? 1 : clamp(min / d, 0, 1) * clamp(1 - (d - min) / (max - min), 0, 1);
    const lowpass = d <= min ? 0 : 20000 - clamp((d - min) / (max - min), 0, 1) * 18800;
    return { gain, lowpass };
  }

  _panOf(pos) {
    const x = pos.x || 0;
    const z = pos.z || 1;
    return clamp(x / Math.max(1, Math.hypot(x, z)) * 0.9, -1, 1);
  }

  /** 音乐闪避：UI/关键事件期间压低音乐，让提示听得清。 */
  _duck() {
    if (!this.ctx || !this.musicDuck) return;
    const ctx = this.ctx;
    const target = 0.45; // ≈ -7dB
    const t = ctx.currentTime;
    this.musicDuck.gain.cancelScheduledValues(t);
    this.musicDuck.gain.setValueAtTime(this.musicDuck.gain.value, t);
    this.musicDuck.gain.linearRampToValueAtTime(target, t + 0.12);
    this._duckUntil = t + 0.9;
    if (!this._duckActive) {
      this._duckActive = true;
      this._duckTimer = setInterval(() => {
        if (!this.ctx) return;
        if (this.ctx.currentTime >= this._duckUntil) {
          const now = this.ctx.currentTime;
          this.musicDuck.gain.cancelScheduledValues(now);
          this.musicDuck.gain.setValueAtTime(this.musicDuck.gain.value, now);
          this.musicDuck.gain.linearRampToValueAtTime(1, now + 0.9);
          this._duckActive = false;
          clearInterval(this._duckTimer);
        }
      }, 120);
      if (typeof this._duckTimer?.unref === 'function') this._duckTimer.unref();
    }
  }

  // -------------------------------------------------------------------------
  // 3.6 连续层：引擎 / 风 / 胎噪
  // -------------------------------------------------------------------------

  _ensureContinuous() {
    if (this.engineNodes || !this.ctx) return;
    const ctx = this.ctx;

    // 引擎：基频 + 五度泛音经带通。用合成而不是采样 —— 不占资源包，转速可连续变化。
    const eGain = ctx.createGain();
    eGain.gain.value = 0;
    const eOscA = ctx.createOscillator();
    const eOscB = ctx.createOscillator();
    const eBp = ctx.createBiquadFilter();
    eOscA.type = 'sawtooth';
    eOscB.type = 'sawtooth';
    eOscA.frequency.value = 70;
    eOscB.frequency.value = 105;
    eBp.type = 'lowpass';
    eBp.frequency.value = 900;
    eBp.Q.value = 4;
    eOscA.connect(eBp);
    eOscB.connect(eBp);
    eBp.connect(eGain);
    eGain.connect(this.buses.engine);
    eOscA.start();
    eOscB.start();
    this.engineNodes = { gain: eGain, a: eOscA, b: eOscB, bp: eBp };

    // 风噪：平方律（低速几乎无声）
    const wSrc = ctx.createBufferSource();
    wSrc.buffer = this._noiseBuffer();
    wSrc.loop = true;
    const wLp = ctx.createBiquadFilter();
    wLp.type = 'lowpass';
    wLp.frequency.value = 400;
    const wGain = ctx.createGain();
    wGain.gain.value = 0;
    wSrc.connect(wLp);
    wLp.connect(wGain);
    wGain.connect(this.buses.engine);
    wSrc.start();
    this.windNodes = { gain: wGain, filter: wLp };

    // 胎噪：漂移时的高频摩擦带
    const tSrc = ctx.createBufferSource();
    tSrc.buffer = this._noiseBuffer();
    tSrc.loop = true;
    const tBp = ctx.createBiquadFilter();
    tBp.type = 'bandpass';
    tBp.frequency.value = 2600;
    tBp.Q.value = 2.2;
    const tGain = ctx.createGain();
    tGain.gain.value = 0;
    tSrc.connect(tBp);
    tBp.connect(tGain);
    tGain.connect(this.buses.engine);
    tSrc.start();
    this.tireNodes = { gain: tGain, filter: tBp };
  }

  _updateContinuousLayers() {
    this._ensureContinuous();
    if (!this.ctx || !this.engineNodes) return;
    const ctx = this.ctx;
    const { speedNorm, boostActive } = this.tensionInputs;
    const s = clamp(speedNorm || 0, 0, 1);
    const boosting = boostActive ? 1 : 0;
    const racing = this.scene === 'race';

    // 候场时引擎完全静音：等位区一直响着引擎会让店员发疯
    const target = racing ? 0.1 + 0.25 * s + 0.12 * boosting : 0;
    this.engineNodes.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.2);
    const rpm = 62 + s * 190 + boosting * 85;
    this.engineNodes.a.frequency.setTargetAtTime(rpm, ctx.currentTime, 0.12);
    this.engineNodes.b.frequency.setTargetAtTime(rpm * 1.5, ctx.currentTime, 0.12);
    this.engineNodes.bp.frequency.setTargetAtTime(700 + s * 2200 + boosting * 900, ctx.currentTime, 0.15);

    const wTarget = racing ? Math.min(0.16, s * s * 0.16 + boosting * 0.05) : 0;
    this.windNodes.gain.gain.setTargetAtTime(wTarget, ctx.currentTime, 0.15);
    this.windNodes.filter.frequency.setTargetAtTime(400 + s * 2600, ctx.currentTime, 0.15);

    const tireTarget = racing && this.tensionInputs.drifting ? 0.12 : 0;
    this.tireNodes.gain.gain.setTargetAtTime(tireTarget, ctx.currentTime, 0.08);
  }

  /** 兼容旧调用：setWind(speed01, boosting) */
  setWind(s01, boosting) {
    this.tensionInputs.speedNorm = clamp(s01, 0, 1);
    this.tensionInputs.boostActive = boosting ? 1 : 0;
    this._updateContinuousLayers();
  }

  setDrifting(on) {
    this.tensionInputs.drifting = on ? 1 : 0;
    this._updateContinuousLayers();
  }

  // -------------------------------------------------------------------------
  // 3.7 诊断（给 audio-lab.html 的 HUD 与自动化测试用）
  // -------------------------------------------------------------------------

  /** 主输出瞬时电平 0-1。 */
  getLevel() {
    if (!this.masterAnalyser) return 0;
    const data = new Uint8Array(this.masterAnalyser.fftSize);
    this.masterAnalyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  diagnostics() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    const layers = {};
    for (const [k, l] of this.layers.entries()) {
      layers[k] = l.silent ? 0 : Number(l.gain.gain.value.toFixed(3));
    }
    return {
      enabled: this.enabled,
      quality: this.quality,
      maxVoices: this.maxVoices,
      activeVoices: this.activeVoiceCount,
      stolen: this.stolenCount,
      triggers: this.triggerCount,
      scene: this.scene,
      tension: Number(this.tension.toFixed(3)),
      tensionInputs: { ...this.tensionInputs },
      layers,
      musicLoaded: this.musicLoadResult || null,
      noiseBuffers: this.noiseBuffers.length,
      ducked: this.ctx ? this.musicDuck.gain.value < 0.99 : false,
      level: Number(this.getLevel().toFixed(4)),
      now: Number(now.toFixed(3)),
    };
  }

  /** 测试用：把所有声部与层清掉。 */
  reset() {
    this._stopScheduler();
    if (this._duckTimer) {
      clearInterval(this._duckTimer);
      this._duckTimer = null;
      this._duckActive = false;
    }
    for (const v of this.voices) {
      for (const n of v.nodes || []) {
        try {
          n.stop();
        } catch {
          /* noop */
        }
      }
    }
    this.voices = [];
    this._fadeOutAll(0);
    this.layers.clear();
    this.scene = null;
    this.setTension(0);
    this.stolenCount = 0;
    this.triggerCount = 0;
  }

  // -------------------------------------------------------------------------
  // 3.8 兼容旧 API 的薄封装
  // -------------------------------------------------------------------------
  // 这些方法刻意放在**类**上而不是单例上，这样任何实例（含测试里新建的）都有，
  // 接入主程序时也完全不必改调用点。

  /** 飞弹锁定预警。节流 220ms，避免每帧都响。 */
  playLockWarning() {
    const now = globalThis.performance ? globalThis.performance.now() : Date.now();
    if (now - this._lastLockWarning < 220) return;
    this._lastLockWarning = now;
    this.playRoute('sfx:weapon/missile/lock');
  }

  playHit() {
    this.playRoute('sfx:impact/hit/heavy');
  }

  /** perfect=true 时播"完美格挡"（更亮的金属音），否则播普通格挡。 */
  playShieldBlock(perfect) {
    this.playRoute(perfect ? 'sfx:defense/shield/perfect' : 'sfx:defense/shield/deploy');
  }

  playDrift() {
    const now = globalThis.performance ? globalThis.performance.now() : Date.now();
    if (now - this._lastDrift < 110) return;
    this._lastDrift = now;
    this.playRoute('sfx:motion/drift/skid');
  }

  playNitro() {
    this.playRoute('sfx:motion/boost/nitro');
  }

  playItemGet() {
    this.playRoute('sfx:pickup/box/open');
  }

  /** kind ∈ missile|mine|emp|shield|boost|tractor（与服务端 ITEM_DEFS 一致）。 */
  playItemUse(kind) {
    this.playRoute(LEGACY_ITEM_ROUTE[kind] || 'sfx:motion/boost/mini');
  }

  playCountdown() {
    this.playRoute('sfx:race/countdown/tick');
  }

  playGo() {
    this.playRoute('sfx:race/countdown/go');
  }

  playFinalLap() {
    this.playRoute('sfx:race/lap/final');
  }

  playFinish() {
    this.playRoute('sfx:race/finish/line');
  }
}

/** 服务端道具 ID -> 音效路由。键必须与 simulation.mjs 的 ITEM_DEFS 一致。 */
const LEGACY_ITEM_ROUTE = {
  missile: 'sfx:weapon/missile/launch',
  mine: 'sfx:weapon/mine/drop',
  shield: 'sfx:defense/shield/deploy',
  emp: 'sfx:motion/emp/blast',
  boost: 'sfx:motion/boost/nitro',
  tractor: 'sfx:motion/tractor/pull',
};

// ---------------------------------------------------------------------------
// 4. 合成器库
// ---------------------------------------------------------------------------
//
// 每个合成器签名： (ctx, dest, t, util) -> { nodes, duration, peak }
//   util.noise()  取一张复用的噪声缓冲
//   util.gain     该次触发的整体增益
//   util.pitch    音高偏移（音分）
//
// 随机化是硬要求：音高 ±cents、增益 ±dB、时长 ±% ——
// 没有任何两次触发听起来完全一样。这是"专业音效"与"程序音"的分界线。

const SYNTHS = {
  // ---- UI / 比赛播报 -----------------------------------------------------
  'sfx:ui/button/click': (ctx, dest, t, u) => {
    const g = ctx.createGain();
    const o = ctx.createOscillator();
    o.type = 'square';
    const f = 1250 * centsMul(rand(-120, 120));
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.62, t + 0.05);
    g.gain.setValueAtTime(0.14 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.07);
    return { nodes: [o], duration: 0.07, peak: 0.14 };
  },

  'sfx:race/countdown/tick': (ctx, dest, t, u) => {
    const nodes = [];
    const p = centsMul(u.pitch);
    // 双音，不是单正弦 —— 单正弦一听就是程序音
    [[660, 0.2], [1320, 0.09]].forEach(([f, a]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f * p * centsMul(rand(-25, 25)), t);
      g.gain.setValueAtTime(a * u.gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + 0.2);
      nodes.push(o);
    });
    return { nodes, duration: 0.2, peak: 0.2 };
  },

  'sfx:race/countdown/go': (ctx, dest, t, u) => {
    const nodes = [];
    const p = centsMul(u.pitch);
    // 上滑大三和弦，给"出发"一个明确的向上感
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sawtooth';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(4000, t);
      o.frequency.setValueAtTime(f * p, t + i * 0.02);
      o.frequency.exponentialRampToValueAtTime(f * p * 1.5, t + 0.55 + i * 0.02);
      g.gain.setValueAtTime(0.0001, t + i * 0.02);
      g.gain.exponentialRampToValueAtTime(0.16 * u.gain, t + i * 0.02 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6 + i * 0.02);
      o.connect(lp);
      lp.connect(g);
      g.connect(dest);
      o.start(t + i * 0.02);
      o.stop(t + 0.62 + i * 0.02);
      nodes.push(o);
    });
    return { nodes, duration: 0.65, peak: 0.16 };
  },

  'sfx:race/lap/final': (ctx, dest, t, u) => {
    const nodes = [];
    // 钟琴质感的两音提示：告诉玩家"最后一圈"，但不打断音乐
    [[1568, 0.0], [2093, 0.14]].forEach(([f, off]) => {
      const o = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o2.type = 'sine';
      o.frequency.value = f * centsMul(u.pitch);
      o2.frequency.value = f * 2.76 * centsMul(u.pitch); // 非整数倍 -> 金属感
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.2 * u.gain, t + off + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.75);
      o.connect(g);
      o2.connect(g);
      g.connect(dest);
      o.start(t + off);
      o2.start(t + off);
      o.stop(t + off + 0.78);
      o2.stop(t + off + 0.78);
      nodes.push(o, o2);
    });
    return { nodes, duration: 0.95, peak: 0.2 };
  },

  'sfx:race/finish/line': (ctx, dest, t, u) => {
    const nodes = [];
    // 冲线号角：D-F-A-D 上行，铜管质感（锯齿 + 低通 + 轻微失谐）
    const notes = [587.33, 698.46, 880, 1174.66];
    notes.forEach((f, i) => {
      const off = i * 0.1;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.19 * u.gain, t + off + 0.02);
      g.gain.setValueAtTime(0.19 * u.gain, t + off + 0.28);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + (i === notes.length - 1 ? 1.1 : 0.3));
      [0, -7].forEach((detune) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f * centsMul(u.pitch + detune);
        o.connect(lp);
        o.start(t + off);
        o.stop(t + off + 1.2);
        nodes.push(o);
      });
      lp.connect(g);
      g.connect(dest);
    });
    return { nodes, duration: 1.4, peak: 0.19 };
  },

  // ---- 武器 / 道具 -------------------------------------------------------
  'sfx:weapon/missile/lock': (ctx, dest, t, u) => {
    const nodes = [];
    const base = 1046.5 * centsMul(u.pitch);
    [0, 0.08].forEach((off, i) => {
      [[1, 'square', 0.14], [2, 'sawtooth', 0.07]].forEach(([mul, type, amp]) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(base * mul * (1 + i * 0.26) * centsMul(rand(-40, 40)), t + off);
        g.gain.setValueAtTime(amp * u.gain, t + off);
        g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.09);
        o.connect(g);
        g.connect(dest);
        o.start(t + off);
        o.stop(t + off + 0.1);
        nodes.push(o);
      });
    });
    return { nodes, duration: 0.2, peak: 0.14 };
  },

  'sfx:weapon/missile/launch': (ctx, dest, t, u) => {
    const nodes = [];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    const f = 330 * centsMul(u.pitch);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 4, t + 0.26);
    g.gain.setValueAtTime(0.2 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.32);
    nodes.push(o);

    const n = noiseBurst(ctx, dest, t, u, { vol: 0.15, dur: 0.26, freq: 900, q: 1.4, type: 'bandpass' });
    nodes.push(...n.nodes);
    return { nodes, duration: 0.34, peak: 0.2 };
  },

  'sfx:weapon/mine/drop': (ctx, dest, t, u) => {
    const nodes = [];
    [[587, 0], [1174, 0.075]].forEach(([f, off]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * centsMul(u.pitch), t + off);
      g.gain.setValueAtTime(0.16 * u.gain, t + off);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.14);
      o.connect(g);
      g.connect(dest);
      o.start(t + off);
      o.stop(t + off + 0.16);
      nodes.push(o);
    });
    return { nodes, duration: 0.25, peak: 0.16 };
  },

  'sfx:defense/shield/deploy': (ctx, dest, t, u) => {
    const nodes = [];
    const o = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o2.type = 'triangle';
    o.frequency.setValueAtTime(600 * centsMul(u.pitch), t);
    o.frequency.exponentialRampToValueAtTime(1400 * centsMul(u.pitch), t + 0.24);
    o2.frequency.setValueAtTime(1200 * centsMul(u.pitch), t);
    o2.frequency.exponentialRampToValueAtTime(2800 * centsMul(u.pitch), t + 0.24);
    g.gain.setValueAtTime(0.22 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(g);
    o2.connect(g);
    g.connect(dest);
    o.start(t);
    o2.start(t);
    o.stop(t + 0.36);
    o2.stop(t + 0.36);
    nodes.push(o, o2);
    return { nodes, duration: 0.36, peak: 0.22 };
  },

  'sfx:defense/shield/perfect': (ctx, dest, t, u) => {
    const nodes = [];
    // 完美格挡必须比普通格挡听起来**明显更好**，否则玩家学不会去练它。
    // 亮度更高、泛音更多、带一层短促"升调金属光边"。
    [[1760, 1], [3520, 0.7], [5280, 0.35]].forEach(([f, amp]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * centsMul(u.pitch), t);
      o.frequency.exponentialRampToValueAtTime(f * 1.5 * centsMul(u.pitch), t + 0.18);
      g.gain.setValueAtTime(0.2 * amp * u.gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + 0.44);
      nodes.push(o);
    });
    const n = noiseBurst(ctx, dest, t, u, { vol: 0.1, dur: 0.2, freq: 6200, q: 2.4, type: 'bandpass' });
    nodes.push(...n.nodes);
    return { nodes, duration: 0.46, peak: 0.2 };
  },

  'sfx:motion/emp/blast': (ctx, dest, t, u) => {
    const nodes = [];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220 * centsMul(u.pitch), t);
    o.frequency.linearRampToValueAtTime(880, t + 0.14);
    o.frequency.linearRampToValueAtTime(110, t + 0.34);
    g.gain.setValueAtTime(0.22 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.42);
    nodes.push(o);
    const n = noiseBurst(ctx, dest, t, u, { vol: 0.17, dur: 0.36, freq: 1400, q: 1.2, type: 'bandpass' });
    nodes.push(...n.nodes);
    return { nodes, duration: 0.44, peak: 0.22 };
  },

  'sfx:motion/tractor/pull': (ctx, dest, t, u) => {
    const nodes = [];
    const o = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o2.type = 'sine';
    o.frequency.setValueAtTime(180 * centsMul(u.pitch), t);
    o.frequency.exponentialRampToValueAtTime(720, t + 0.4);
    o2.frequency.setValueAtTime(90, t);
    o2.frequency.exponentialRampToValueAtTime(360, t + 0.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2 * u.gain, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g);
    o2.connect(g);
    g.connect(dest);
    o.start(t);
    o2.start(t);
    o.stop(t + 0.52);
    o2.stop(t + 0.52);
    nodes.push(o, o2);
    return { nodes, duration: 0.52, peak: 0.2 };
  },

  'sfx:weapon/tractor/pull': (ctx, dest, t, u) => SYNTHS['sfx:motion/tractor/pull'](ctx, dest, t, u),

  'sfx:impact/hit/heavy': (ctx, dest, t, u) => {
    const nodes = [];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    const f = 220 * centsMul(u.pitch);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.13, t + 0.36);
    g.gain.setValueAtTime(0.4 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.44);
    nodes.push(o);
    const n = noiseBurst(ctx, dest, t, u, { vol: 0.24, dur: 0.3, freq: 900, q: 1.5, type: 'lowpass' });
    nodes.push(...n.nodes);
    return { nodes, duration: 0.46, peak: 0.4 };
  },

  // ---- 运动 -------------------------------------------------------------
  'sfx:motion/boost/nitro': (ctx, dest, t, u) => {
    const nodes = [];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    const f = 880 * centsMul(u.pitch);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.22);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.46);
    g.gain.setValueAtTime(0.3 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.52);
    nodes.push(o);
    const n = noiseBurst(ctx, dest, t, u, { vol: 0.24, dur: 0.48, freq: 1800, q: 0.9, type: 'lowpass' });
    nodes.push(...n.nodes);
    return { nodes, duration: 0.52, peak: 0.3 };
  },

  'sfx:motion/boost/mini': (ctx, dest, t, u) => {
    const nodes = [];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    const f = 392 * centsMul(u.pitch);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 2, t + 0.16);
    g.gain.setValueAtTime(0.18 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.24);
    nodes.push(o);
    return { nodes, duration: 0.24, peak: 0.18 };
  },

  // 漂移由连续胎噪层负责（见 _updateContinuousLayers）。这里只做触发瞬间的"咬地"质感。
  'sfx:motion/drift/skid': (ctx, dest, t, u) => {
    const nodes = [];
    const o = ctx.createOscillator();
    const bp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(2150 * centsMul(u.pitch), t);
    o.frequency.exponentialRampToValueAtTime(1600, t + 0.11);
    bp.type = 'bandpass';
    bp.frequency.value = 2200 + rand(-200, 200);
    bp.Q.value = 6;
    g.gain.setValueAtTime(0.1 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(bp);
    bp.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.13);
    nodes.push(o);
    const n = noiseBurst(ctx, dest, t, u, { vol: 0.09, dur: 0.13, freq: 2800, q: 1.5, type: 'bandpass' });
    nodes.push(...n.nodes);
    return { nodes, duration: 0.14, peak: 0.11 };
  },

  // ---- 拾取 / 名次 ------------------------------------------------------
  'sfx:pickup/box/open': (ctx, dest, t, u) => {
    const nodes = [];
    // 上行四音铃；每次触发的音高与音符间隔都有微差
    const base = 1046.5 * centsMul(u.pitch);
    const steps = [1, 1.26, 1.5, 2];
    const gap = 0.045 * rand(0.88, 1.12);
    steps.forEach((s, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(base * s, t + i * gap);
      g.gain.setValueAtTime(0.17 * u.gain, t + i * gap);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * gap + 0.17);
      o.connect(g);
      g.connect(dest);
      o.start(t + i * gap);
      o.stop(t + i * gap + 0.19);
      nodes.push(o);
    });
    return { nodes, duration: 0.36, peak: 0.17 };
  },

  'sfx:race/overtake/up': (ctx, dest, t, u) => {
    const nodes = [];
    // 超越：向上的短滑音，轻量，不抢音乐
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(660 * centsMul(u.pitch), t);
    o.frequency.exponentialRampToValueAtTime(1320 * centsMul(u.pitch), t + 0.18);
    g.gain.setValueAtTime(0.13 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.26);
    nodes.push(o);
    return { nodes, duration: 0.26, peak: 0.13 };
  },

  'sfx:race/overtake/down': (ctx, dest, t, u) => {
    const nodes = [];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(660 * centsMul(u.pitch), t);
    o.frequency.exponentialRampToValueAtTime(392 * centsMul(u.pitch), t + 0.2);
    g.gain.setValueAtTime(0.11 * u.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.28);
    nodes.push(o);
    return { nodes, duration: 0.28, peak: 0.11 };
  },
};

/**
 * 噪声爆发。复用噪声池，**不新建缓冲** —— 这是消除手机 GC 掉帧的关键。
 */
function noiseBurst(ctx, dest, t, u, { vol, dur, freq, q, type }) {
  const src = ctx.createBufferSource();
  src.buffer = u.noise();
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq * centsMul(rand(-150, 150)), t);
  f.Q.setValueAtTime(q, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol * u.gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t, rand(0, 1));
  src.stop(t + dur);
  return { nodes: [src] };
}

// ---------------------------------------------------------------------------
// 5. 单例
// ---------------------------------------------------------------------------
//
// 游戏代码统一 import 这个单例。旧 app.mjs 的调用点全部能原样保留：
//   audio.playHit() / playNitro() / playItemUse(kind) / setWind() ...
// 兼容方法定义在 AudioEngine 类上（见 3.8 节），所以单例和测试实例行为一致。

export const audio = new AudioEngine();

export default audio;
