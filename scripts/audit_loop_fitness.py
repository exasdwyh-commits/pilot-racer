#!/usr/bin/env python3
"""
循环音乐适配性体检 —— 判断一首循环 BGM 是不是「钩子前置、全程稳态」。

存在的理由
----------
短循环音乐与单曲是两种不同的艺术形式，判据几乎相反：

| | 单曲（Single） | 循环层（Loop Stem） |
|---|---|---|
| 结构 | 起承转合，动态弧线 | 稳态高能，横向变化 |
| 前奏 | 越长越有铺垫感 | **任何铺垫在第 2 次循环时都变成障碍** |
| 变化手法 | 能量升降（build / drop） | 配器音色与加层（同能量级内） |
| 好听的段落 | 可以安排在 1/3 处 | **必须从第 1 拍就在响** |

生成模型默认按**单曲叙事**作曲，所以循环层必须在简报里**显式禁止**缓开场与退潮，
并在交付前用本脚本量出来。判据只认**成品文件的解码信号**，不认处理流程的自报值。

度量口径
--------
1. `dyn_span_db` 动态跨度 —— 1 秒平滑包络的 p95/p5 之比，取 dB。
   这是「稳态」的核心指标：广播/游戏循环层应 ≤ 8 dB；
   超过 15 dB 基本可以断定存在 intro / build / breakdown。
2. `head_ratio` 起段能量比 —— 前 2.0s RMS / 全曲中位数。
   < 0.85 → 有软开场（第 1 拍不是满编制）。
3. `sustain_sec` 进入稳态的时刻 —— 首次平滑包络 ≥ 0.9×中位数**且持续 ≥ 1.0s**。
   为什么要「持续」：模型常在开头放一个镲片重击，瞬时达标却在之后回落。
4. `hole_sec` / `hole_at` / `hole_db` 最长塌陷段 —— 平滑包络低于 0.5×中位数
   且持续 ≥ 0.75s 的最长一段。循环层里这就是「空洞」，玩家会以为音乐断了。
5. `tail_ratio` 尾部能量比 —— 末 1.0s / 中位数（仅循环曲目）。
   < 0.85 → 循环点处能量塌陷，接缝会听出来。
6. `centroid_lift` 谱心抬升 —— 中段谱心 / 前段谱心。
   > 1.15 → 「钩子延后」：抓耳元素被安排在后面，开头是铺垫。

用法
----
    python scripts/audit_loop_fitness.py                 # 体检 public/audio 下全部曲目
    python scripts/audit_loop_fitness.py --file x.mp3 --loop
    python scripts/audit_loop_fitness.py --json
    python scripts/audit_loop_fitness.py --bpm 160       # 附带按小节定位塌陷段
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 48000
WIN = 0.25            # 分析窗（秒）
SMOOTH_SEC = 1.0      # 平滑窗：滤掉逐拍起伏，保留段落级变化
HEAD_SEC = 2.0
TAIL_SEC = 1.0
BUCKETS = 32
FFMPEG = "/opt/homebrew/bin/ffmpeg"

# 循环层判据
LOOP_CRIT = {
    "dyn_span_db": 8.0,      # ≤
    "head_ratio": 0.85,      # ≥
    "sustain_frac": 0.05,    # ≤（占全长比例）
    "hole_sec": 0.50,        # ≤
    "tail_ratio": 0.85,      # ≥
    "centroid_lift": 1.15,   # ≤
}
# 一次性短音效/终结段判据（不循环，允许终止式，但同样不该软开场）
STING_CRIT = {
    "head_ratio": 0.60,      # ≥
    "sustain_frac": 0.30,    # ≤
    "hole_sec": 0.75,        # ≤
}

TRACKS: dict[str, tuple[str, bool]] = {
    "lobby": ("bgm-lobby.mp3", True),
    "race": ("bgm-race.mp3", True),
    "final": ("bgm-race-final.mp3", True),
    "results": ("bgm-results.mp3", False),
}

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "public" / "audio"


def decode(path: Path) -> np.ndarray:
    """解码为 (n, 2) float32。**不做下混** —— 下混求和会改变能量读数。"""
    r = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(path), "-f", "f32le",
         "-acodec", "pcm_f32le", "-ar", str(SR), "-"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode()[:300])
    a = np.frombuffer(r.stdout, dtype="<f4")
    if a.size % 2:
        a = a[:-1]
    return a.reshape(-1, 2).astype(np.float64)


def rms_curve(a: np.ndarray) -> np.ndarray:
    n = int(WIN * SR)
    frames = a[: len(a) // n * n].reshape(-1, n, 2)
    return np.sqrt(np.mean(frames ** 2, axis=(1, 2)))


def centroid_curve(a: np.ndarray) -> np.ndarray:
    """谱心（Hz）。旋律/高音区加入会抬高它 —— 「钩子是否延后」的代理指标。"""
    n = int(WIN * SR)
    frames = a[: len(a) // n * n].reshape(-1, n, 2)
    spec = np.abs(np.fft.rfft(frames[:, :, 0] * np.hanning(n), axis=1))
    freqs = np.fft.rfftfreq(n, 1 / SR)
    total = spec.sum(axis=1)
    total[total == 0] = 1e-12
    return (spec * freqs).sum(axis=1) / total


def smooth(x: np.ndarray, sec: float = SMOOTH_SEC) -> np.ndarray:
    k = max(1, int(round(sec / WIN)))
    if k <= 1 or len(x) < k:
        return x
    return np.convolve(x, np.ones(k) / k, mode="valid")


def db(x: float, ref: float) -> float:
    return float(20 * np.log10(max(x, 1e-9) / max(ref, 1e-9)))


def longest_below(sm: np.ndarray, ref: float, frac: float) -> tuple[float, float, float]:
    """返回 (起始秒, 持续秒, 最低 dB)。低于 frac×ref 且持续最久的一段。"""
    flag = sm < frac * ref
    best = (0.0, 0.0, 0.0)
    i = 0
    while i < len(flag):
        if flag[i]:
            j = i
            while j < len(flag) and flag[j]:
                j += 1
            dur = (j - i) * WIN
            if dur > best[1]:
                best = (i * WIN, dur, db(float(sm[i:j].min()), ref))
            i = j
        else:
            i += 1
    return best


def sparkline(values: np.ndarray) -> str:
    idx = np.linspace(0, len(values), BUCKETS + 1).astype(int)
    med = []
    for i in range(BUCKETS):
        seg = values[idx[i]: max(idx[i] + 1, idx[i + 1])]
        med.append(float(np.median(seg)) if len(seg) else 0.0)
    v = np.array(med)
    v = v / (v.max() or 1.0)
    return "".join(" ▁▂▃▄▅▆▇█"[min(8, max(0, int(round(x * 8))))] for x in v)


def analyse(path: Path, looping: bool, bpm: float | None) -> dict:
    a = decode(path)
    env = rms_curve(a)
    cen = centroid_curve(a)
    if len(env) < 8:
        raise RuntimeError("音频过短，无法分析")

    dur = len(a) / SR
    med = float(np.median(env)) or 1e-9
    sm = smooth(env)

    p05, p95 = np.percentile(sm, 5), np.percentile(sm, 95)
    dyn_span_db = db(float(p95), float(p05))

    head_ratio = float(np.mean(env[: max(1, int(HEAD_SEC / WIN))]) / med)

    # 首次「持续」进入稳态：滑动窗内全部 ≥ 0.9×中位数，且窗长 ≥ 1.0s
    need = max(1, int(round(1.0 / WIN)))
    thr = 0.9 * med
    sustain_sec = None
    run = 0
    for i, v in enumerate(env):
        run = run + 1 if v >= thr else 0
        if run >= need:
            sustain_sec = (i - need + 1) * WIN
            break
    sustain_frac = 1.0 if sustain_sec is None else sustain_sec / dur

    hole_at, hole_sec, hole_db = longest_below(sm, med, 0.5)
    tail_ratio = float(np.mean(env[-max(1, int(TAIL_SEC / WIN)):]) / med)

    third = max(1, len(cen) // 3)
    c_head, c_mid = float(np.median(cen[:third])), float(np.median(cen[third:2 * third]))
    centroid_lift = c_mid / c_head if c_head > 0 else 1.0

    problems: list[str] = []
    if looping:
        c = LOOP_CRIT
        if dyn_span_db > c["dyn_span_db"]:
            problems.append(f"动态跨度过大 {dyn_span_db:.1f}dB（上限 {c['dyn_span_db']}）→ 存在 intro/build/breakdown")
        if head_ratio < c["head_ratio"]:
            problems.append(f"软开场（起段能量比 {head_ratio:.2f} < {c['head_ratio']}）")
        if sustain_frac > c["sustain_frac"]:
            problems.append(f"铺垫过长（{sustain_sec:.1f}s 才进入稳态）" if sustain_sec else "全程未进入稳态")
        if hole_sec > c["hole_sec"]:
            problems.append(f"塌陷段 {hole_sec:.2f}s @ {hole_at:.1f}s，最低 {hole_db:.1f}dB")
        if tail_ratio < c["tail_ratio"]:
            problems.append(f"循环点能量塌陷（尾/中位 {tail_ratio:.2f}）")
        if centroid_lift > c["centroid_lift"]:
            problems.append(f"钩子延后（谱心中段/前段 {centroid_lift:.2f}）")
    else:
        c = STING_CRIT
        if head_ratio < c["head_ratio"]:
            problems.append(f"软开场（起段能量比 {head_ratio:.2f} < {c['head_ratio']}）")
        if sustain_frac > c["sustain_frac"]:
            problems.append(f"铺垫过长（{sustain_frac:.0%} 时长才进入稳态）")
        if hole_sec > c["hole_sec"]:
            problems.append(f"塌陷段 {hole_sec:.2f}s @ {hole_at:.1f}s，最低 {hole_db:.1f}dB")

    bar = 60.0 / bpm * 4 if bpm else None
    return {
        "key": path.stem,
        "file": path.name,
        "seconds": round(dur, 3),
        "loop": looping,
        "dyn_span_db": round(dyn_span_db, 2),
        "head_ratio": round(head_ratio, 3),
        "sustain_sec": None if sustain_sec is None else round(sustain_sec, 2),
        "sustain_frac": round(sustain_frac, 3),
        "hole_sec": round(hole_sec, 2),
        "hole_at_sec": round(hole_at, 2),
        "hole_db": round(hole_db, 1),
        "hole_bar": None if (bar is None or not hole_sec) else round(hole_at / bar, 2),
        "tail_ratio": round(tail_ratio, 3),
        "centroid_lift": round(centroid_lift, 3),
        "env_spark": sparkline(env),
        "cen_spark": sparkline(cen),
        "problems": problems,
        "ok": not problems,
    }


def _write_wav(path: Path, audio: np.ndarray, sr: int = SR) -> None:
    """写 16-bit 立体声 wav（自检用，不依赖 ffmpeg 编码）。"""
    import wave

    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def selftest() -> int:
    """用合成信号验证**度量本身**，而不是"跑完就算数"。

    三条合成信号，期望值是可推导的：
      flat  —— 恒定电平（这就是合格循环层的样子），应当**通过**
      build —— 从 −30 dB 线性升到 0 dB，应当被「软开场」抓住
      hole  —— 恒定电平中间挖掉 2 秒，应当被「塌陷段」抓住

    为什么必须有这个自检：如果尺子本身不准，它会一边放行烂音频、
    一边误杀好音频 —— 而两种错误都不会报错。
    """
    import tempfile

    rng = np.random.default_rng(7)
    n = int(12.0 * SR)
    t = np.arange(n) / SR
    base = 0.35 * np.sin(2 * np.pi * 220 * t) + 0.2 * rng.standard_normal(n)
    tone = np.stack([base, base], axis=1)

    hole_sig = tone * 0.5
    a, b = int(4.0 * SR), int(6.0 * SR)
    hole_sig[a:b] *= 10 ** (-30 / 20)

    cases = [
        ("flat", tone * 0.5, True),
        ("build", np.linspace(10 ** (-30 / 20), 1.0, n).reshape(-1, 1) * tone, False),
        ("hole", hole_sig, False),
    ]

    ok = True
    with tempfile.TemporaryDirectory() as td:
        for name, sig, should_pass in cases:
            p = Path(td) / f"{name}.wav"
            _write_wav(p, sig)
            r = analyse(p, True, None)
            got = r["ok"]
            good = got == should_pass
            ok = ok and good
            print(f"  {'✓' if good else '✗'} {name:<6} "
                  f"期望{'通过' if should_pass else '拦截'} / 实得{'通过' if got else '拦截'}   "
                  f"跨度 {r['dyn_span_db']:6.1f}dB  起段 {r['head_ratio']:.2f}  "
                  f"塌陷 {r['hole_sec']:.2f}s")
            if not good:
                print(f"      实际判据：{r['problems']}")

    print("自检通过：度量能放行稳态、拦截软开场与塌陷" if ok
          else "自检失败：度量的判据与预期不符，先修脚本再用它验收")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="循环音乐适配性体检（钩子前置 / 全程稳态）")
    ap.add_argument("--file", help="只体检单个 mp3")
    ap.add_argument("--loop", action="store_true", help="配合 --file：标记为循环曲目")
    ap.add_argument("--bpm", type=float, help="该曲目 BPM，用于把塌陷位置换算成小节")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true", help="用合成信号验证度量本身，不碰任何音频文件")
    ap.add_argument("--audio-dir", help=f"音频目录（默认 {AUDIO_DIR}）")
    a = ap.parse_args()

    if a.selftest:
        return selftest()

    bpm_of = {"bgm-lobby": 120.0, "bgm-race": 160.0, "bgm-race-final": 160.0, "bgm-results": 160.0}
    targets: list[tuple[Path, bool]] = []
    if a.file:
        targets.append((Path(a.file), a.loop))
    else:
        d = Path(a.audio_dir) if a.audio_dir else AUDIO_DIR
        for _k, (fn, lp) in TRACKS.items():
            p = d / fn
            if p.exists():
                targets.append((p, lp))

    if not targets:
        print("没有可体检的文件", file=sys.stderr)
        return 1

    reports = []
    for p, lp in targets:
        try:
            reports.append(analyse(p, lp, a.bpm or bpm_of.get(p.stem)))
        except Exception as e:  # noqa: BLE001
            print(f"[失败] {p.name}: {type(e).__name__}: {e}", file=sys.stderr)

    if a.json:
        print(json.dumps(reports, ensure_ascii=False, indent=1))
        return 0 if all(r["ok"] for r in reports) else 1

    print()
    print(f"{'曲目':<15}{'时长':>8}{'动态跨度':>10}{'起段比':>8}{'进稳态':>9}{'塌陷段':>9}{'尾/中位':>9}{'谱心':>7}  判定")
    print("-" * 104)
    for r in reports:
        sus = "—" if r["sustain_sec"] is None else f"{r['sustain_sec']:.1f}s"
        hole = "—" if not r["hole_sec"] else f"{r['hole_sec']:.1f}s"
        print(f"{r['key']:<15}{r['seconds']:>7.2f}s{r['dyn_span_db']:>9.1f}dB{r['head_ratio']:>8.2f}"
              f"{sus:>9}{hole:>9}{r['tail_ratio']:>9.2f}{r['centroid_lift']:>7.2f}  "
              f"{'✓ 合格' if r['ok'] else '✗ ' + '；'.join(r['problems'])}")

    print()
    for r in reports:
        print(f"  {r['key']:<15} 能量 {r['env_spark']}")
        print(f"  {'':<15} 谱心 {r['cen_spark']}   低→高 = 抓耳元素逐渐加入")
    print()

    bad = [r for r in reports if not r["ok"]]
    if bad:
        print(f"❌ {len(bad)}/{len(reports)} 首不适合短循环。")
        print("   循环层规约：第 1 拍就是全编制 + 全程动态跨度 ≤ 8dB + 变化靠配器不靠能量升降。")
        return 1
    print(f"✅ {len(reports)} 首全部合格：钩子前置、全程稳态、循环点无塌陷。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
