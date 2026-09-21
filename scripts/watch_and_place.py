#!/usr/bin/env python3
"""
等待 music3 生成完成并自动落位（逐首落位，不等齐）

为什么要重写原来的 shell 版
--------------------------
shell 版的问题是 **它等四首全部完成才开始后处理**。但实测同一批曲目的耗时
能差近 10 倍（22 分钟 vs 194 分钟），"等齐"意味着先跑完的曲目白白闲置一两个小时。
这个脚本改成**每一首就绪就立刻落位**，并且：

  - 不再硬编码 run id，改为按歌曲名从 music3 反查（可重复、可续跑）
  - 同时覆盖自适应音乐族与主题曲两类资产
  - 幂等：产物比源文件新就跳过，随时可以杀掉重跑

覆盖范围
--------
  1. 自适应音乐族（submit_bgm_tracks.TRACKS）
       就绪 -> postprocess_bgm.py --key <key>   裁到整小节 + 循环点交叉淡化
  2. 主题曲《NO MORE WAITING》（submit_punk_anthem.VARIANTS）
       validate 就绪 -> collect_anthem.py --mode validate   取回试听稿
       full     就绪 -> collect_anthem.py --mode full       取回全曲并剪 48s 游戏版

用法
----
    nohup python3 scripts/watch_and_place.py > /tmp/audio_pipeline.log 2>&1 &
    tail -f /tmp/audio_pipeline.log
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

from submit_bgm_tracks import TRACKS  # noqa: E402  曲库规格的单一来源
from submit_punk_anthem import VARIANTS, load_state as load_anthem_state  # noqa: E402

BASE = "http://127.0.0.1:8766"
AUDIO_DIR = REPO / "public" / "audio"
PY = sys.executable

# 主题曲各模式对应的落位产物
ANTHEM_DESTS = {
    "validate": [AUDIO_DIR / "draft" / "no-more-waiting-30s.mp3"],
    "full": [AUDIO_DIR / "no-more-waiting.mp3", AUDIO_DIR / "no-more-waiting-48s.mp3"],
}


_stale_reported = False


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def music3_index() -> tuple[dict, dict]:
    """返回 (歌曲名 -> song_id, song_id -> 最近成功的输出路径)。"""
    songs = get("/api/songs")
    runs = get("/api/runs")
    by_name = {s.get("name"): s["id"] for s in songs}
    done: dict[int, Path] = {}
    skipped = 0
    for r in runs:
        if r.get("status") != "done" or not r.get("output"):
            continue
        sid = r.get("song_id")
        p = Path(r["output"])
        # music3 里会留着指向已删除文件的历史记录（换过输出目录、手工清理等）。
        # 必须先判存在再取 mtime —— 顺序反了会直接抛 OSError 把看守打死。
        if not p.exists():
            skipped += 1
            continue
        # 同一首歌多次生成时，保留时间戳最大的那次
        if sid not in done or p.stat().st_mtime > done[sid].stat().st_mtime:
            done[sid] = p
    global _stale_reported
    if skipped and not _stale_reported:
        log(f"提示：{skipped} 条历史 run 的输出文件已不存在，已跳过（不影响新产物）")
        _stale_reported = True
    return by_name, done


def source_for(song_id: int | None, done: dict) -> Path | None:
    return done.get(song_id) if song_id is not None else None


def newer_than(dests: list[Path], src: Path) -> bool:
    """所有产物都存在，且都比源文件新 —— 说明已经落位过。"""
    try:
        return all(d.exists() and d.stat().st_mtime >= src.stat().st_mtime for d in dests)
    except OSError:
        return False


def run_script(args: list[str]) -> int:
    cmd = [PY, str(HERE / args[0]), *args[1:]]
    p = subprocess.run(cmd, cwd=str(REPO), capture_output=True, text=True)
    tail = (p.stdout or "").strip().splitlines()[-6:]
    for line in tail:
        log("    | " + line)
    if p.returncode != 0:
        err = (p.stderr or "").strip().splitlines()[-4:]
        for line in err:
            log("    ! " + line)
    return p.returncode


def main() -> int:
    ap = argparse.ArgumentParser(description="等待生成完成并逐首落位")
    ap.add_argument("--max-wait-min", type=int, default=360, help="最长等待分钟数（默认 360）")
    ap.add_argument("--interval", type=int, default=60, help="轮询间隔秒（默认 60）")
    ap.add_argument("--once", action="store_true",
                    help="只跑一轮就退出（给定时任务用；长驻进程在本机会被回收，"
                         "定时调用单次模式才是可靠做法）")
    a = ap.parse_args()

    anthem_state = load_anthem_state()
    mode_desc = "单次检查" if a.once else f"常驻看守（最长 {a.max_wait_min} 分钟）"
    log(f"开始{mode_desc}：{len(TRACKS)} 首自适应音乐层 + "
        f"{len(anthem_state)} 个主题曲任务")
    if anthem_state:
        log("主题曲任务：" + ", ".join(
            f"{m}(song {r['song_id']}, run {r['run_ids']})" for m, r in anthem_state.items()))

    deadline = time.time() + a.max_wait_min * 60
    placed: set[str] = set()
    fail_streak: dict[str, int] = {}
    # 必须在循环外定义：超时分支里要用，定义在循环内会 UnboundLocalError
    expected: set[str] = {t["key"] for t in TRACKS} | {f"anthem:{m}" for m in anthem_state}

    while True:
        try:
            by_name, done = music3_index()
        except Exception as e:  # noqa: BLE001
            # 区分"服务不可达"和"数据异常"——后者不该被当成网络问题反复重试
            kind = "连不上 music3" if isinstance(e, OSError) else "读取 music3 数据出错"
            log(f"{kind}（{type(e).__name__}: {e}）")
            if a.once:
                return 1
            log(f"{a.interval}s 后重试")
            time.sleep(a.interval)
            continue

        # ---- 1. 自适应音乐族 ----
        for t in TRACKS:
            key = t["key"]
            if key in placed:
                continue
            src = source_for(by_name.get(t["name"]), done)
            dst = [AUDIO_DIR / f"{t['file']}.mp3"]
            if src and newer_than(dst, src):
                log(f"[跳过] {key} 已落位（产物比源文件新）")
                placed.add(key)
                continue
            if not src:
                continue
            log(f"[落位] {key} <- {src.name}")
            rc = run_script(["postprocess_bgm.py", "--key", key])
            if rc == 0:
                placed.add(key)
                log(f"[完成] {key}")
                # 同步到 outputs 测试目录（若存在）
                for test_dir in REPO.parent.glob("outputs/*/public/audio"):
                    if test_dir.is_dir():
                        import shutil
                        for f in dst:
                            if f.exists():
                                shutil.copy2(f, test_dir / f.name)
                                log(f"[同步] -> {test_dir / f.name}")
            else:
                fail_streak[key] = fail_streak.get(key, 0) + 1
                log(f"[失败] {key} 后处理退出码 {rc}（第 {fail_streak[key]} 次）")

        # ---- 2. 主题曲 ----
        for mode, rec in anthem_state.items():
            tag = f"anthem:{mode}"
            if tag in placed:
                continue
            src = source_for(rec["song_id"], done)
            if not src:
                continue
            if newer_than(ANTHEM_DESTS[mode], src):
                log(f"[跳过] {tag} 已落位")
                placed.add(tag)
                continue
            log(f"[落位] {tag} <- {src.name}")
            rc = run_script(["collect_anthem.py", "--mode", mode])
            if rc == 0:
                placed.add(tag)
                log(f"[完成] {tag}")
                if mode == "validate":
                    log("→ 试听稿已就位：打开 http://localhost:9010/audio-lab 判断音色")
            else:
                fail_streak[tag] = fail_streak.get(tag, 0) + 1
                log(f"[失败] {tag} 取回退出码 {rc}（第 {fail_streak[tag]} 次）")

        missing = expected - placed
        if not missing:
            log("全部就绪。")
            return 0

        if fail_streak:
            log(f"本轮有失败项：{fail_streak}")

        if a.once:
            log(f"单次检查结束，未就绪 {len(missing)} 项：" + ", ".join(sorted(missing)))
            return 1

        if time.time() >= deadline:
            log(f"等待超时（{a.max_wait_min} 分钟）。仍未落位：" + ", ".join(sorted(missing)))
            log("生成很慢时属正常，重新启动本看守即可继续等。")
            return 1

        log(f"等待中，未落位 {len(missing)} 项：" + ", ".join(sorted(missing)))
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
