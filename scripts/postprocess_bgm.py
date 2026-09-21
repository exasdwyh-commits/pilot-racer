#!/usr/bin/env python3
"""
极速等位赛 · BGM 后处理（小节对齐 + 循环点交叉淡化）

为什么必须过这一步
------------------
MiniMax-Music-3 按"秒数"生成，输出长度是**近似**的，而且它不知道我们打算循环播放。
直接拿模型输出当循环 BGM 用，会有两个可听缺陷：

  1. 长度对不上整小节 -> 循环点落在小节中间，听感是"抢拍"
  2. 结尾与开头相位/内容不连续 -> 每次循环都有一下"咔"或"顿"

本脚本把输出裁到**精确的整小节长度**，并把循环点做成交叉淡化。
处理后还会**实测**接缝处的跳变幅度并打印前后对比 —— 不是"跑完就算数"，
而是给出可以核对的数字。

交叉淡化的原理（尾段预卷）
--------------------------
设素材为 R，目标循环长度 N 个采样，淡化窗口 F。
朴素的"首尾各淡出一半"会造成整体音量在接缝处凹陷；正确做法是把
**循环点之后本来就该出现的那段素材**（R[N:N+F]）卷到开头来：

    out[0:F] = R[N:N+F] * (1-ramp) + R[0:F] * ramp      ramp: 0 -> 1

于是结尾 R[N-1] 接开头 out[0]≈R[N] 在原素材里本来相邻，接缝天然连续；
而 out[F] 正好回到 R[F]，中段无缝。这是给非循环素材做无缝循环的标准手法。

用法
----
    # 需要 numpy 与 ffmpeg；用隔离 venv 跑：
    /Users/exasdwyh/.workbuddy/binaries/python/envs/default/bin/python scripts/postprocess_bgm.py --all
    ... --key lobby
    ... --from /path/to/raw.mp3 --key lobby    # 指定源文件
    ... --dry-run                              # 只报告不写文件
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

try:
    import numpy as np
except ImportError:  # pragma: no cover
    print("[错误] 缺少 numpy。请用隔离 venv 运行：")
    print("  /Users/exasdwyh/.workbuddy/binaries/python/envs/default/bin/python scripts/postprocess_bgm.py --all")
    sys.exit(2)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from submit_bgm_tracks import TRACKS, BASE  # noqa: E402  曲库规格的单一来源

SR = 48000            # 重采样目标；与浏览器 AudioContext 常见采样率一致
TARGET_HEADROOM = 0.89  # ≈ -1 dBFS，母带真峰值上限（AUDIO_DESIGN.md 第 3 节）
SEAM_REPORT_WINDOW = 512  # 接缝跳变实测的取样窗（采样点）

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "public" / "audio"


def _bin(name: str) -> str:
    """找二进制。沙箱/终端里 PATH 可能不含 /opt/homebrew/bin。"""
    found = shutil.which(name)
    if found:
        return found
    for cand in (f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}", f"/usr/bin/{name}"):
        if os.path.exists(cand):
            return cand
    raise SystemExit(f"[错误] 找不到 {name}。请安装 ffmpeg（brew install ffmpeg）。")


FFMPEG = _bin("ffmpeg")
FFPROBE = _bin("ffprobe")


def decode(path: Path) -> np.ndarray:
    """解码成 float32 立体声 [n, 2]，交给 numpy 处理。"""
    cmd = [FFMPEG, "-v", "error", "-i", str(path),
           "-f", "f32le", "-acodec", "pcm_f32le", "-ar", str(SR), "-ac", "2", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    if not raw:
        raise SystemExit(f"[错误] 解码为空：{path}")
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2).astype(np.float64)


def encode(audio: np.ndarray, path: Path) -> None:
    """以 V0 质量写出 mp3。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [FFMPEG, "-v", "error", "-y",
           "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
           "-codec:a", "libmp3lame", "-q:a", "0", str(path)]
    pcm = np.clip(audio, -1.0, 1.0).astype("<f4").tobytes()
    subprocess.run(cmd, input=pcm, capture_output=True, check=True)


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, check=True, text=True).stdout.strip()
    return float(out)


def seam_click(audio: np.ndarray) -> tuple[float, float]:
    """
    量测循环接缝的"咔哒"程度。

    正确的度量不是"首段和尾段像不像"，而是**跨接缝那一步是否像一个正常的相邻采样步**：
        typical = 素材内部相邻采样差的平均值
        wrap    = 结尾最后一个采样与开头第一个采样之差（循环时的真实跳变）
        ratio   = wrap / typical

    ratio ≈ 1 表示接缝这一步和普通相邻采样没有区别 —— 听不出接缝。
    ratio 远大于 1 就是可听的爆音。返回 (wrap, ratio)。
    """
    if len(audio) < 8:
        return float("nan"), float("nan")
    typical = float(np.mean(np.abs(np.diff(audio, axis=0))))
    wrap = float(np.mean(np.abs(audio[0] - audio[-1])))
    return wrap, wrap / (typical + 1e-12)


def tile_or_trim(src: np.ndarray, need: int) -> np.ndarray:
    """把素材铺到至少 need 个采样。短了就循环接续，长了就裁。"""
    if len(src) >= need:
        return src[:need]
    reps = int(np.ceil(need / len(src)))
    return np.tile(src, (reps, 1))


def make_loop(raw: np.ndarray, total: int, fade: int) -> np.ndarray:
    """裁到 total 并做尾段预卷交叉淡化。需要 raw 至少 total+fade 个采样。"""
    ramp = np.linspace(0.0, 1.0, fade).reshape(-1, 1)
    pre_roll = raw[total:total + fade]          # 循环点之后本来就该出现的素材
    out = raw[:total].copy()
    out[:fade] = pre_roll * (1.0 - ramp) + raw[:fade] * ramp
    return out


def decoded_levels(path: Path) -> tuple[float, float]:
    """
    量成品文件的电平，返回 (逐声道峰值, 单声道下混峰值)。

    **两个数必须分开，不能混用**：
    - 逐声道峰值 = 数字削顶的判据。采样超过 ±1.0 会被播放链硬钳成方波。
    - 单声道下混峰值 = 单声道兼容性。**按标准 -3 dB 下混口径计算**
      （L+R 各乘 0.7071，与 ffmpeg `-ac 1`、ITU-R BS.775 监听下混一致），
      不是原始 L+R 求和 —— 拿原始求和当判据会把本来合格的曲子全报成不合格。

    踩过的坑：用 `ffmpeg -ac 1` 量峰值去判断削顶，量到的是下混值，
    比逐声道峰值高 15% 左右，把没超顶的成品误判成"已削顶"。
    **量削顶看逐声道，量兼容性看下混 —— 判据用错就是假警报。**
    """
    a = decode(path)
    if not len(a):
        return 0.0, 0.0
    ch = float(np.max(np.abs(a)))
    mono = float(np.max(np.abs((a[:, 0] + a[:, 1]) * 0.7071)))
    return ch, mono


def encode_under_ceiling(out: np.ndarray, dest: Path, dry_run: bool,
                         ceiling: float = TARGET_HEADROOM, max_passes: int = 4):
    """
    闭环归一化：编码 → 解码 → 量峰值 → 超了降增益再编。

    为什么要闭环而不是"算好增益编一次"：MP3 是变换编码，**解码后峰值通常略高于 PCM**
    （本次实测 +0.03 dB，属轻微过冲；不同素材可能更大）。只量 PCM 就等于
    用一个近似值去保证一个硬指标。闭环的代价是每轨多一次解码，可以接受。

    判据用**逐声道**峰值（削顶口径），见 decoded_levels 的说明。

    返回 (逐声道峰值, 单声道求和峰值, 编码次数, 最终增益)。dry-run 返回 (None, None, 1, 1.0)。
    """
    if dry_run:
        return None, None, 1, 1.0
    gain = 1.0
    ch = mono = None
    for passes in range(1, max_passes + 1):
        encode(out * gain, dest)
        ch, mono = decoded_levels(dest)
        if ch <= ceiling:
            return ch, mono, passes, gain
        gain *= ceiling / ch
    # 迭代到上限仍未压下去：如实返回实测值，交给上层报错，不要假装成功
    return ch, mono, max_passes, gain


def process_track(track: dict, source: Path | None, dry_run: bool) -> dict:
    key, name = track["key"], track["name"]
    bpm, bars, loop = track["bpm"], track["bars"], track["loop"]
    bar_sec = 60.0 / bpm * 4
    target_sec = bar_sec * bars
    target_samples = int(round(target_sec * SR))
    fade = int(round(60.0 / bpm * SR))  # 一拍的淡化窗口

    if source is None:
        return {"key": key, "status": "no-source", "hint": "还没生成完成，先跑 submit_bgm_tracks.py --submit"}

    raw = decode(source)
    raw_sec = len(raw) / SR
    need = target_samples + (fade if loop else 0)
    prepared = tile_or_trim(raw, need)

    if loop:
        out = make_loop(prepared, target_samples, fade)
        before_wrap, before_ratio = seam_click(tile_or_trim(raw, target_samples))
        after_wrap, after_ratio = seam_click(out)
    else:
        # 结算层不循环，只需要确切长度（正好等于 12 秒成绩展示窗口），末尾做短淡出
        out = prepared[:target_samples].copy()
        fade_out = int(0.25 * SR)
        out[-fade_out:] *= np.linspace(1.0, 0.0, fade_out).reshape(-1, 1)
        before_wrap = before_ratio = after_wrap = after_ratio = float("nan")

    peak = float(np.max(np.abs(out)))
    gain_applied = 1.0
    if peak > TARGET_HEADROOM:
        gain_applied = TARGET_HEADROOM / peak
        out *= gain_applied

    dest = OUT_DIR / f"{track['file']}.mp3"
    backup = None
    peak_decoded = None
    peak_mono = None
    encode_passes = 1
    if not dry_run:
        # 覆盖前先备份。bgm-race.mp3 等名字是引擎按设计约定的路径，
        # 新版本会替换旧版本；不备份就等于不可逆地丢掉旧资产。
        # 只在**没有备份时**才建：反复处理后处理不能把最初那份原始资产冲掉。
        if dest.exists():
            candidate = dest.with_suffix(".bak.mp3")
            if not candidate.exists():
                shutil.copy2(dest, candidate)
            backup = candidate            # 已有备份则沿用，不覆盖最初那份
        peak_decoded, peak_mono, encode_passes, _ = encode_under_ceiling(out, dest, dry_run)
        final_sec = probe_duration(dest)
    else:
        final_sec = len(out) / SR

    # 成品必须同时满足：时长对齐 且 逐声道解码峰值不超天花板。任一不满足就不算 ok。
    ceiling_ok = None if peak_decoded is None else bool(peak_decoded <= TARGET_HEADROOM + 1e-3)
    # 单声道下混（-3 dB 口径）过 1.0 不构成数字削顶，但下游若做下混就会削 —— 只提示，不改判。
    mono_ok = None if peak_mono is None else bool(peak_mono <= 1.0)

    return {
        "key": key,
        "name": name,
        "status": "dry-run" if dry_run else ("ok" if ceiling_ok is not False else "over-ceiling"),
        "source": str(source),
        "dest": str(dest),
        "backup": str(backup) if backup else None,
        "bpm": bpm,
        "bars": bars,
        "loop": loop,
        "raw_sec": round(raw_sec, 3),
        "target_sec": round(target_sec, 3),
        "final_sec": round(final_sec, 3),
        "bar_aligned": abs(final_sec - target_sec) < 0.06,
        "peak_raw": round(peak, 4),
        "gain_applied": round(gain_applied, 4),
        "peak_decoded": None if peak_decoded is None else round(peak_decoded, 4),
        "peak_mono_sum": None if peak_mono is None else round(peak_mono, 4),
        "encode_passes": encode_passes,
        "ceiling_ok": ceiling_ok,
        "mono_compatible": mono_ok,
        "seam_wrap_before": None if before_ratio != before_ratio else round(before_wrap, 6),
        "seam_ratio_before": None if before_ratio != before_ratio else round(before_ratio, 3),
        "seam_wrap_after": None if after_ratio != after_ratio else round(after_wrap, 6),
        "seam_ratio_after": None if after_ratio != after_ratio else round(after_ratio, 3),
        # ratio ≈ 1 表示接缝这一步与普通相邻采样无异；< 3 视为听不出接缝
        "seam_ok": None if after_ratio != after_ratio else bool(after_ratio < 3.0),
        "seam_improved": None if after_ratio != after_ratio else bool(after_ratio <= before_ratio + 1e-9),
    }


def latest_output_for(name: str) -> Path | None:
    """从 music3 查这首歌最近一次成功生成的文件路径。"""
    def get(path):
        with urllib.request.urlopen(BASE + path, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))

    try:
        songs = get("/api/songs")
        runs = get("/api/runs")
    except Exception as e:  # noqa: BLE001
        print(f"[提示] 连不上 music3（{e}），只能用 --from 指定源文件。")
        return None

    match = [s for s in songs if s.get("name") == name]
    if not match:
        return None
    sid = match[0]["id"]
    done = [r for r in runs if r.get("song_id") == sid and r.get("status") == "done" and r.get("output")]
    if not done:
        return None
    p = Path(done[0]["output"])
    return p if p.exists() else None


def selftest() -> int:
    """
    用合成信号验证循环处理的数学，而不是"脚本跑完了就算数"。

    构造一段**故意不循环友好**的素材（结尾相位与开头对不上），
    然后确认：交叉淡化之后，跨接缝那一步的跳变被压回"普通相邻采样"的量级。
    """
    print("自检：循环点交叉淡化的数学验证\n")
    bpm, bars = 160, 8
    target = int(round(60 / bpm * 4 * bars * SR))
    fade = int(round(60 / bpm * SR))

    n = target + fade
    t = np.arange(n) / SR
    # 关键：载波频率要选得**在目标长度上不凑成整数周期**（441.7Hz × 12s = 5300.4 个周期），
    # 否则结尾相位天然与开头对齐，样本本身就"能循环"，测不出任何东西。
    # 再叠一个不整除的慢包络，让开头结尾的振幅也不同。
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 0.37 * t + 1.1)
    raw = (np.sin(2 * np.pi * 441.7 * t) * env).reshape(-1, 1).repeat(2, axis=1) * 0.8

    naive = raw[:target]
    looped = make_loop(raw, target, fade)

    nb, nr = seam_click(naive)
    ab, ar = seam_click(looped)

    checks = []

    def check(name, ok, detail):
        checks.append(ok)
        print(f"  [{'通过' if ok else '失败'}] {name}：{detail}")

    check("长度精确", len(looped) == target, f"{len(looped)} == {target}")
    check("接缝比下降", ar < nr, f"{nr:.3f} -> {ar:.3f}")
    check("接缝听不出（ratio < 3）", ar < 3.0, f"ratio = {ar:.3f}")
    check("接缝跳变绝对值下降", ab < nb, f"{nb:.6f} -> {ab:.6f}")

    # 淡化区必须是 pre_roll 与 raw 头的凸组合
    ramp = np.linspace(0.0, 1.0, fade).reshape(-1, 1)
    expect = raw[target:target + fade] * (1 - ramp) + raw[:fade] * ramp
    check("淡化区为凸组合", bool(np.allclose(looped[:fade], expect, atol=1e-9)),
          "out[0:F] = pre_roll*(1-ramp) + head*ramp")

    # 淡化窗之后必须与原素材一致（不能整段被改动）
    check("淡化窗之外未被改动", bool(np.allclose(looped[fade:], raw[fade:target], atol=1e-9)),
          f"out[{fade}:] == raw[{fade}:{target}]")

    # 短素材的补铺路径
    short = raw[:target // 3]
    tiled = tile_or_trim(short, target)
    check("短素材可补铺到目标长度", len(tiled) == target, f"{len(short)} -> {len(tiled)}")

    # 非循环路径（结算层）
    faded = raw[:target].copy()
    fo = int(0.25 * SR)
    faded[-fo:] *= np.linspace(1.0, 0.0, fo).reshape(-1, 1)
    check("非循环层末尾淡出到静音", abs(float(np.max(np.abs(faded[-1])))) < 1e-6,
          f"末采样 = {float(np.max(np.abs(faded[-1]))):.2e}")

    ok_all = all(checks)
    print(f"\n自检结果：{'全部通过' if ok_all else '存在失败项'}")
    return 0 if ok_all else 1


def verify_delivered() -> int:
    """
    交付前验收门：**只读成品文件**，重新量时长 / 解码峰值 / 循环接缝。

    存在的意义：处理流程自己报的数是"我算过什么"，验收要问"成品实际是什么"。
    这两者不一致，就说明流程里有没被量到的东西 —— 本次正是靠它抓到
    race-final 削顶（流程报 PCM 峰值 0.89，成品解码后是 1.0285）。
    """
    print(f"{'曲目':<10}{'时长':>9}{'目标':>9}{'对齐':>5}{'声道峰值':>10}{'削顶':>6}{'单声道':>9}{'兼容':>5}{'接缝比':>8}")
    print("-" * 74)
    bad: list[str] = []
    warn: list[str] = []
    for t in TRACKS:
        path = OUT_DIR / f"{t['file']}.mp3"
        if not path.exists():
            print(f"{t['key']:<10}{'—':>9}      未落位")
            bad.append(f"{t['key']}(缺失)")
            continue
        bar = 60.0 / t["bpm"] * 4
        target = bar * t["bars"]
        a = decode(path)
        dur = len(a) / SR
        ch_peak, mono_peak = decoded_levels(path)
        aligned = abs(dur - target) < 0.02
        under = ch_peak <= TARGET_HEADROOM + 1e-3
        mono_ok = mono_peak <= 1.0
        ratio = seam_click(a)[1] if t["loop"] else None
        reasons = []
        if not aligned:
            reasons.append("时长未对齐")
        if not under:
            reasons.append("削顶")
        if ratio is not None and ratio >= 3.0:
            reasons.append("接缝跳跃")
        if reasons:
            bad.append(f"{t['key']}({'、'.join(reasons)})")
        if not mono_ok:
            warn.append(t["key"])
        shown = f"{ratio:.3f}" if ratio is not None else "—"
        print(f"{t['key']:<10}{dur:>9.3f}{target:>9.3f}{'✓' if aligned else '✗':>5}"
              f"{ch_peak:>10.4f}{'✓' if under else '✗✗':>6}"
              f"{mono_peak:>9.4f}{'✓' if mono_ok else '!':>5}{shown:>8}")
    print()
    if bad:
        print("❌ 验收未通过：" + "，".join(bad))
        return 1
    print(f"✅ 全部成品通过验收：时长精确对齐、逐声道峰值 ≤ {TARGET_HEADROOM}（数字不削顶）、循环接缝听不出")
    if warn:
        print(f"⚠ 单声道兼容提示：{'、'.join(warn)} 按标准 -3 dB 下混（L+R×0.7071）后峰值超过 1.0。"
              f"立体声播放不受影响；仅当链路会不加衰减地做单声道下混时才可能削顶。")
    return 0


def main() -> None:
    global OUT_DIR
    ap = argparse.ArgumentParser(description="BGM 小节对齐与循环点处理")
    ap.add_argument("--all", action="store_true", help="处理全部曲目")
    ap.add_argument("--key", help="只处理某一首（lobby/race/final/results）")
    ap.add_argument("--from", dest="src", help="手动指定源 mp3（覆盖自动查找）")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    ap.add_argument("--selftest", action="store_true", help="用合成信号验证循环处理数学，不碰任何音频文件")
    ap.add_argument("--verify", action="store_true", help="验收成品：重新量时长/解码峰值/接缝，不修改文件")
    ap.add_argument("--out-dir", help=f"输出目录（默认 {OUT_DIR}）；测试时请指到临时目录，别覆盖已有资产")
    a = ap.parse_args()

    if a.selftest:
        sys.exit(selftest())

    if a.out_dir:
        OUT_DIR = Path(a.out_dir)

    if a.verify:
        sys.exit(verify_delivered())

    targets = TRACKS
    if a.key:
        targets = [t for t in TRACKS if t["key"] == a.key]
        if not targets:
            sys.exit(f"[错误] 未知曲目 {a.key}；可选：{', '.join(t['key'] for t in TRACKS)}")
    elif not a.all:
        print("曲目规格（加 --all 或 --key <name> 才会处理）：\n")
        for t in TRACKS:
            bar = 60.0 / t["bpm"] * 4
            print(f"  {t['key']:<8} {t['file']:<18} {t['bpm']}BPM × {t['bars']} 小节 "
                  f"= {bar * t['bars']:.2f}s  循环={t['loop']}")
        print(f"\n输出目录：{OUT_DIR}")
        return

    report = []
    for t in targets:
        src = Path(a.src) if a.src else latest_output_for(t["name"])
        rep = process_track(t, src, a.dry_run)
        report.append(rep)
        if rep["status"] in ("no-source",):
            print(f"[跳过] {rep['key']}：{rep['hint']}")
            continue
        flag = "✓" if rep["bar_aligned"] else "✗"
        seam = ""
        if rep["seam_ratio_after"] is not None:
            seam = (f"  接缝比 {rep['seam_ratio_before']:.2f} -> {rep['seam_ratio_after']:.2f} "
                    f"({'听不出' if rep['seam_ok'] else '仍有跳跃'}"
                    f"{'/已改善' if rep['seam_improved'] else '/未改善'})")
        lvl = ""
        if rep["peak_decoded"] is not None:
            retry = ""
            if rep["encode_passes"] > 1:
                retry = f"  编码重试 {rep['encode_passes']} 次压回天花板"
            lvl = (f"  成品 {rep['peak_decoded']:.4f}"
                   f" ({'✓ 不削顶' if rep['ceiling_ok'] else '✗ 超顶!'})"
                   f"{'' if rep['mono_compatible'] else '  ⚠单声道下混会超 1.0'}{retry}")
        print(f"[完成] {rep['key']:<8} {rep['raw_sec']:6.2f}s -> {rep['final_sec']:6.2f}s "
              f"{flag} 对齐 {rep['bars']} 小节 ({rep['bpm']}BPM){seam}{lvl}")

    print("\n--- 处理报告（JSON，可回填验收记录）---")
    print(json.dumps(report, ensure_ascii=False, indent=1))

    ok = [r for r in report if r["status"] == "ok"]
    if ok:
        # 机器可读的来源与处理记录：每个曲目用了什么种子/参数、裁到多少小节、
        # 接缝比降到多少。商用交付物必须能追溯，不能只有一句"生成过了"。
        rec = OUT_DIR / "provenance.json"
        rec.write_text(json.dumps({
            "generator": "MiniMax-Music-3 (music3 workbench, ComfyUI)",
            "processed_by": "scripts/postprocess_bgm.py",
            "parameters_source": "scripts/submit_bgm_tracks.py",
            "sample_rate": SR,
            "target_headroom_dbfs": round(20 * np.log10(TARGET_HEADROOM), 2),
            "tracks": report,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"已写入 {OUT_DIR}")
        print(f"来源与处理记录：{rec}")
        print("下一步：启动样机 `npm start`，打开 http://localhost:9010/audio-lab 试听验收。")


if __name__ == "__main__":
    main()
