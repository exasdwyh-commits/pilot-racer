#!/usr/bin/env python3
"""
霓虹等位极速赛 · 主题曲《NO MORE WAITING》取回与落位

职责
----
把 music3 生成出来的原始 mp3 取回来，做**单曲需要的**处理，然后放到位。

单曲和 BGM 的处理是相反的：
    BGM   -> 裁到整小节 + 循环点交叉淡化（为了无缝）
    单曲  -> 保留完整演唱 + 峰值归一化（为了好听，不循环）
所以本脚本不调用 postprocess_bgm.py 的主流程，只复用它的解码/编码/量测工具。

两个产物
--------
1. `no-more-waiting.mp3`      完整单曲（对外传播用）
2. `no-more-waiting-48s.mp3`  游戏开场版 = 全曲前 32 小节 = 48.00s

**游戏版是从全曲裁出来的，不是二次生成**：
全曲按「副歌前置」（Cold Open）排布，160 BPM 下前 32 小节 = 48.00s 正好是
「副歌 → 主歌 → 副歌」—— 开场第一拍就是 hook。裁切省掉约 100 分钟算力，
而且保证与单曲是同一场演出（人声/音色/速度完全一致）。

> 历史上的第一版结构是 Intro + 主歌 + 预副 + 副歌，副歌落在 48 秒的末尾，
> 游戏里几乎听不到 —— 负责人 2026-09-12 指出「还没到副歌就结束了」后已重排。
> 循环层的同类规约（钩子前置、全程稳态）见 docs/AUDIO_DESIGN.md。

用法
----
    python3 scripts/collect_anthem.py --selftest
    python3 scripts/collect_anthem.py --mode validate        # 取回 30s 验证片段
    python3 scripts/collect_anthem.py --mode full            # 取回全曲 + 剪 48s 游戏版
    python3 scripts/collect_anthem.py --mode full --from /path/to/raw.mp3
    python3 scripts/collect_anthem.py --mode full --loop     # 游戏版做成无缝循环（默认是带收尾的一次性开场）
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# 复用后处理脚本里已经验证过的解码 / 编码 / 量测 / ffmpeg 定位
from postprocess_bgm import (  # noqa: E402
    SR,
    TARGET_HEADROOM,
    decode,
    encode,
    probe_duration,
    seam_click,
    _bin,
)
from submit_punk_anthem import (  # noqa: E402
    BPM,
    KEY,
    TITLE,
    VARIANTS,
    load_state,
    BAR_SECONDS,
)

FFMPEG = _bin("ffmpeg")
FFPROBE = _bin("ffprobe")

AUDIO_DIR = HERE.parent / "public" / "audio"
DRAFT_DIR = AUDIO_DIR / "draft"          # 试听稿，明确不是交付物
SOURCE_DIR = Path("/Users/exasdwyh/ComfyUI-Shared/output/audio")

# 游戏开场版长度：32 小节 = 48.00s
GAME_BARS = 32
GAME_SECONDS = GAME_BARS * BAR_SECONDS   # 48.0
FADE_SECONDS = 0.12                      # 一次性开场版的收尾淡出，避免裁切点咔哒


# ---------------------------------------------------------------------------
# 取源文件
# ---------------------------------------------------------------------------
def find_source(mode: str) -> Path | None:
    """从 music3 查这一 mode 最近一次成功生成的文件路径。"""
    import urllib.request

    state = load_state()
    rec = state.get(mode)
    if not rec:
        print(f"[错误] 没有 mode={mode} 的提交记录，先跑 submit_punk_anthem.py --submit --mode {mode}")
        return None

    song_id = rec["song_id"]
    try:
        with urllib.request.urlopen("http://127.0.0.1:8766/api/runs", timeout=20) as r:
            runs = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"[提示] 连不上 music3（{e}），只能用 --from 指定源文件。")
        return None

    done = [r for r in runs
            if r.get("song_id") == song_id and r.get("status") == "done" and r.get("output")]
    if not done:
        running = [r for r in runs if r.get("song_id") == song_id]
        sts = ", ".join(f"{r['id']}:{r.get('status')}" for r in running) or "无记录"
        print(f"[等待中] song_id={song_id} 还没有成功产物（{sts}）")
        return None

    p = Path(done[0]["output"])
    if not p.exists():
        # music3 记录的是绝对路径，理论上存在；万一不在了就按文件名在输出目录里找
        alt = SOURCE_DIR / p.name
        if alt.exists():
            return alt
        print(f"[错误] 记录中的文件不存在：{p}")
        return None
    return p


# ---------------------------------------------------------------------------
# 量测
# ---------------------------------------------------------------------------
def integrated_lufs(path: Path) -> float | None:
    """用 ffmpeg 的 ebur128 量整轨响度（LUFS）。拿不到就返回 None，不当作失败。"""
    try:
        p = subprocess.run(
            [FFMPEG, "-v", "error", "-i", str(path),
             "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
            capture_output=True, text=True, timeout=180,
        )
        # ebur128 的结果打在 stderr 上
        text = (p.stderr or "") + (p.stdout or "")
        val = None
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("I:") and "LUFS" in s:
                val = float(s.split()[1])
        return val
    except Exception:  # noqa: BLE001
        return None


def normalize(audio: np.ndarray) -> tuple[np.ndarray, float, float]:
    """峰值归一化到 -1 dBFS。返回 (结果, 原始峰值, 施加增益)。"""
    peak = float(np.max(np.abs(audio))) or 1e-9
    gain = TARGET_HEADROOM / peak
    out = np.clip(audio * gain, -1.0, 1.0)
    return out, peak, gain


def trim_fade(audio: np.ndarray, seconds: float, fade: float) -> np.ndarray:
    """裁到指定秒数，末尾加短淡出（一次性片段用，避免裁切点咔哒）。"""
    n = int(round(seconds * SR))
    out = audio[:n].copy()
    f = int(round(fade * SR))
    if f and f < len(out):
        out[-f:] *= np.linspace(1.0, 0.0, f).reshape(-1, 1)
    return out


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def run(mode: str, source: Path | None, use_loop: bool) -> int:
    v = VARIANTS[mode]
    src = source or find_source(mode)
    if not src:
        return 1

    print(f"源文件：{src.name}")
    raw = decode(src)
    raw_sec = len(raw) / SR
    print(f"原始时长 {raw_sec:.3f}s （模型目标 {v['duration']:.2f}s）")

    audio, peak, gain = normalize(raw)
    print(f"峰值 {peak:.4f} -> 归一化增益 ×{gain:.3f}（母带上限 -1 dBFS）")

    report: dict = {
        "title": TITLE,
        "mode": mode,
        "bpm": BPM,
        "key": KEY,
        "seed": v["seed"],
        "source": str(src),
        "raw_sec": round(raw_sec, 3),
        "target_sec": v["duration"],
        "peak_raw": round(peak, 4),
        "gain_applied": round(gain, 4),
        "outputs": [],
    }

    if mode == "validate":
        # 试听稿放 draft/：这是给人判断"模型能不能唱"的，不是交付物
        dest = DRAFT_DIR / "no-more-waiting-30s.mp3"
        encode(audio, dest)
        sec = probe_duration(dest)
        lufs = integrated_lufs(dest)
        report["outputs"].append({"role": "试听稿", "path": str(dest), "sec": round(sec, 3),
                                  "lufs": lufs})
        print(f"\n[已写出] 试听稿 {dest}")
        print(f"         {sec:.3f}s" + (f"  {lufs:.1f} LUFS" if lufs else ""))
        print("\n下一步：打开 http://localhost:9010/audio-lab 试听，"
              "判断两点 —— 主歌的英文 rapping 是否可信、副歌的失真吉他墙与帮腔齐唱是否立得起来。")
        print(f"方向对了就上全曲：python3 scripts/submit_punk_anthem.py --submit --mode full")
    else:
        # 1) 完整单曲。刻意不做小节对齐、不做裁切：
        #    这是作品，不是循环层；模型的结尾就是它该有的结尾。
        full = AUDIO_DIR / "no-more-waiting.mp3"
        encode(audio, full)
        full_sec = probe_duration(full)
        full_lufs = integrated_lufs(full)
        report["outputs"].append({"role": "完整单曲", "path": str(full),
                                  "sec": round(full_sec, 3), "lufs": full_lufs})
        print(f"\n[已写出] 完整单曲 {full}  {full_sec:.3f}s"
              + (f"  {full_lufs:.1f} LUFS" if full_lufs else ""))

        # 2) 游戏开场版 = 前 32 小节
        if raw_sec < GAME_SECONDS:
            print(f"[警告] 源文件只有 {raw_sec:.2f}s，短于游戏版需要的 {GAME_SECONDS:.2f}s，"
                  f"跳过裁切。请检查生成结果或改用更短的段落。")
        elif use_loop:
            # 无缝循环版：复用 BGM 流水线里已经验证过的尾段预卷交叉淡化
            n = int(round(GAME_SECONDS * SR))
            fade = int(round(BAR_SECONDS * SR))          # 淡化窗取一拍
            ramp = np.linspace(0.0, 1.0, fade).reshape(-1, 1)
            pre = audio[n:n + fade]
            if len(pre) < fade:
                print(f"[警告] 素材不足以取循环点之后的预卷段，改为一次性开场版。")
                cut = trim_fade(audio, GAME_SECONDS, FADE_SECONDS)
            else:
                cut = audio[:n].copy()
                cut[:fade] = pre * (1.0 - ramp) + audio[:fade] * ramp
                wrap, ratio = seam_click(cut)
                report["game_loop_seam_ratio"] = round(ratio, 3)
                print(f"游戏版按无缝循环处理，接缝比 {ratio:.2f}（<3 视为听不出接缝）")
        else:
            cut = trim_fade(audio, GAME_SECONDS, FADE_SECONDS)

        game = AUDIO_DIR / "no-more-waiting-48s.mp3"
        encode(cut, game)
        game_sec = probe_duration(game)
        game_lufs = integrated_lufs(game)
        report["outputs"].append({"role": "游戏开场版", "path": str(game),
                                  "sec": round(game_sec, 3), "lufs": game_lufs,
                                  "bars": GAME_BARS, "loop": bool(use_loop)})
        print(f"[已写出] 游戏开场版 {game}  {game_sec:.3f}s / {GAME_BARS} 小节"
              + (f"  {game_lufs:.1f} LUFS" if game_lufs else ""))

        # 游戏版必须严格落在小节网格上，否则接不进自适应音乐的时序
        drift = abs(game_sec - GAME_SECONDS)
        ok = drift < 0.06
        print(f"        小节网格对齐：{'✓' if ok else '✗'} "
              f"(目标 {GAME_SECONDS:.2f}s，实测偏差 {drift * 1000:.1f}ms)")
        report["game_bar_aligned"] = bool(ok)

    # 写来源记录 —— 仓库硬规则：生成的资产必须可追溯
    prov = AUDIO_DIR / "ANTHEM_PROVENANCE.json"
    prev = {}
    if prov.exists():
        try:
            prev = json.loads(prov.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            prev = {}
    prev[mode] = report
    prov.write_text(json.dumps(prev, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n来源记录已更新：{prov}")
    return 0


# ---------------------------------------------------------------------------
# 自检 —— 验证数学，而不是"脚本跑完了就算数"
# ---------------------------------------------------------------------------
def selftest() -> int:
    print("自检：单曲处理与游戏版裁切的数学验证\n")
    fails = []

    # 1) 小节网格：160 BPM / 4-4，32 小节必须正好是 48.00s
    if abs(BAR_SECONDS - 1.5) > 1e-12:
        fails.append(f"1 小节应为 1.500s，实得 {BAR_SECONDS}")
    if abs(GAME_SECONDS - 48.0) > 1e-9:
        fails.append(f"32 小节应为 48.000s，实得 {GAME_SECONDS}")
    print(f"  1 小节 = {BAR_SECONDS:.3f}s   32 小节 = {GAME_SECONDS:.3f}s  "
          f"{'OK' if not fails else 'FAIL'}")

    # 2) 归一化：峰值必须被推到 -1 dBFS 上限，且不能削顶
    rng = np.random.default_rng(7)
    sig = (rng.standard_normal((SR * 2, 2)) * 0.05).clip(-0.2, 0.2)   # 故意很轻的素材
    norm, peak, gain = normalize(sig)
    got_peak = float(np.max(np.abs(norm)))
    if abs(got_peak - TARGET_HEADROOM) > 1e-6:
        fails.append(f"归一化后峰值应达 {TARGET_HEADROOM}，实得 {got_peak:.6f}")
    if got_peak > 1.0:
        fails.append("归一化后削顶")
    print(f"  归一化：{peak:.4f} ×{gain:.2f} -> {got_peak:.4f}  "
          f"{'OK' if abs(got_peak - TARGET_HEADROOM) <= 1e-6 else 'FAIL'}")

    # 3) 裁切长度必须精确；且淡出不能把整段吃掉
    long_sig = rng.standard_normal((SR * 120, 2)) * 0.1
    cut = trim_fade(long_sig, GAME_SECONDS, FADE_SECONDS)
    cut_sec = len(cut) / SR
    if abs(cut_sec - GAME_SECONDS) > 1e-6:
        fails.append(f"裁切应得 {GAME_SECONDS}s，实得 {cut_sec}")
    tail_energy = float(np.max(np.abs(cut[-int(0.01 * SR):])))
    head_energy = float(np.max(np.abs(cut[:int(0.01 * SR)])))
    if not tail_energy < head_energy * 0.2:
        fails.append("末尾淡出没有生效（尾部能量仍接近开头）")
    print(f"  裁切：{cut_sec:.3f}s，尾/首能量比 {tail_energy / head_energy:.3f}  "
          f"{'OK' if tail_energy < head_energy * 0.2 else 'FAIL'}")

    # 4) 无缝循环版：接缝比必须回到"普通相邻采样"量级
    #    用一段**故意不循环友好**的合成信号（载波在目标长度上不凑整数周期）
    t = np.arange(int(52 * SR)) / SR
    loop_src = (np.sin(2 * np.pi * 441.7 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.31 * t + 1.1))
                ).reshape(-1, 1).repeat(2, axis=1) * 0.6
    n = int(round(GAME_SECONDS * SR))
    fade = int(round(BAR_SECONDS * SR))
    naive = loop_src[:n]
    _, ratio_before = seam_click(naive)
    ramp = np.linspace(0.0, 1.0, fade).reshape(-1, 1)
    pre = loop_src[n:n + fade]
    looped = loop_src[:n].copy()
    looped[:fade] = pre * (1.0 - ramp) + loop_src[:fade] * ramp
    _, ratio_after = seam_click(looped)
    improved = ratio_after < ratio_before
    print(f"  无缝循环：接缝比 {ratio_before:.2f} -> {ratio_after:.2f}  "
          f"{'OK' if improved else 'FAIL'}")
    if not improved:
        fails.append(f"循环处理未改善接缝（{ratio_before:.2f} -> {ratio_after:.2f}）")

    print()
    if fails:
        for f in fails:
            print(f"  ✗ {f}")
        print(f"\n自检失败：{len(fails)} 项")
        return 1
    print("自检全部通过。")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=f"取回主题曲《{TITLE}》并落位")
    ap.add_argument("--selftest", action="store_true", help="验证处理数学")
    ap.add_argument("--mode", choices=sorted(VARIANTS), help="取回哪个模式")
    ap.add_argument("--from", dest="src", help="直接指定源 mp3（不查 music3）")
    ap.add_argument("--loop", action="store_true",
                    help="游戏版做成无缝循环（默认是带收尾的一次性开场）")
    a = ap.parse_args()

    if a.selftest:
        sys.exit(selftest())
    if not a.mode:
        ap.error("需要 --mode {validate,full} 或 --selftest")
    sys.exit(run(a.mode, Path(a.src) if a.src else None, a.loop))


if __name__ == "__main__":
    main()
