#!/usr/bin/env python3
"""
霓虹等位极速赛 · 英文朋克摇滚主题曲《NO MORE WAITING》
提交脚本（MiniMax-Music-3 / music3 workbench）

为什么单独一支脚本，而不是加进 submit_bgm_tracks.py
----------------------------------------------------
两者是**不同类别的资产**，约束也完全相反：

  submit_bgm_tracks.py  -> 自适应音乐族。纯器乐、必须无缝循环、
                           必须整族同 BPM 同调性、靠小节边界交叉淡化衔接。
  本脚本                 -> 有主唱的单曲。不循环、有明确开头结尾、
                           靠段落结构讲一个完整的情绪弧线。

混在一起会让「曲库约束」和「单曲自由」互相污染。但两者**共享 160 BPM / D 小调**，
所以主题曲天然能跟比赛音乐族同调同速 —— 这是刻意的，不是巧合。

风格定位（重要）
----------------
目标听感：英语 Rap-Rock / 朋克颂歌 —— 重型半速主歌 + 高亢齐唱副歌。
**简报里刻意不出现任何真实乐队名或既有曲目标题**：一来商标与曲风模仿在商用场景
有法律风险，二来模型对"流派 + 配器 + 调性 + 速度"这类结构化描述的反应，
比对艺人名的反应更稳定可控。用流派词描述，反而更好用。

速度矛盾怎么解
--------------
"快朋克"和"重型说唱"在 BPM 上是矛盾的。解法不是折中选个中间值，
而是**同一 BPM 下换律动密度**：160 BPM 是小节骨架，主歌走 half-time（听感 80 BPM 的
重型律动），副歌切回八分/十六分的疾速朋克推进。反差来自律动，不来自速度。
附带好处是整首曲子的小节网格与游戏音乐族完全对齐。

副歌前置（2026-09-12 负责人反馈后重排）
------------------------------------
负责人指出：游戏音乐是简单循环，缓开场的曲子「还没到副歌就结束了」，
而好听的恰恰是副歌。所以全曲改成 **Cold Open** —— 第 1 小节直接进副歌，
把最好的东西放在最前面：

    Chorus 12 + V1 8 + Chorus 12 = 32 小节 = 48.00s
    全曲 70 小节 = 105.00s

**前 32 小节 = 48.00s 恰好是「副歌 → 主歌 → 副歌」**，所以游戏开场版直接从
全曲裁前 48.00s 即可 —— 开场第一拍就是 hook，而不是等着音乐"热起来"。
同样省约 100 分钟算力，且保证是同一场演出（人声、音色、速度完全一致）。

为什么不用常规的「Intro + Verse × N + Chorus」：那样副歌落在 48 秒的末尾，
游戏里等于玩家几乎听不到它。副歌前置同时也是摇滚单曲的 Cold Open 惯例。

两种模式
--------
    --mode validate   20 小节 = 30.00s 音色验证片段（intro 2 + rap主歌 6 + 副歌 12）
    --mode full       70 小节 = 105.00s 完整单曲（副歌前置）

验证片段存在的唯一理由：**这是全流程最大的未知风险**。
模型能不能唱出可信的英文 rapping、副歌的失真吉他墙与帮腔齐唱能不能立起来，
没人知道。先花约 30 分钟确认，再决定要不要投 100 分钟做全曲。

用法
----
    python3 scripts/submit_punk_anthem.py --list
    python3 scripts/submit_punk_anthem.py --list --mode full
    python3 scripts/submit_punk_anthem.py --submit --mode validate
    python3 scripts/submit_punk_anthem.py --submit --mode full
    python3 scripts/submit_punk_anthem.py --runs
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8766"
SKILL_ID = 1

# ---------------------------------------------------------------------------
# 音乐约束 —— 与比赛音乐族共用，改动前先读 docs/AUDIO_DESIGN.md
# ---------------------------------------------------------------------------
BPM = 160
KEY = "D 小调"
TUNING = "Drop D"
BAR_SECONDS = 60.0 / BPM * 4  # 160 BPM / 4-4 -> 1.500s

# 主题曲专属种子。与比赛族（160_2026）、结算层（160_2027）刻意错开：
# 同族同种子是为了交叉淡化时"素材同源"，主题曲不参与交叉淡化，所以要独立种子。
ANTHEM_SEED = 160_2028

TITLE = "NO MORE WAITING"

# ---------------------------------------------------------------------------
# 歌词
# ---------------------------------------------------------------------------
# 设计意图：主题必须**同时成立在两个语境里** ——
#   游戏里：等位排号、最后一圈、越过所有慢车
#   游戏外：任何"被叫号、被晾着、不想再等"的处境
# 所以核心意象只用了排队与赛道的公共交集：号码、线、绿灯、圈速。
# 这样它才可能"出圈"—— 没玩过游戏的人也能对号入座。

VERSE_1 = """Tick-tick, the clock is chewing on my name
Same four walls, same number, same game
Everybody standing in a perfect line
Begging for a turn that was never mine
I paid my dues, I bit my tongue
I wore the smile, I played along
But the meter's running and the night ain't done
And I'm done being patient with a number"""

PRE_CHORUS = """I can hear the engine in my chest
Every second louder than the last
And I'm not, no I'm not, I'm not waiting"""

# 副歌是整首歌的资产所在：四句、短、每句同一个起手词。
# 首句带标题词（NO MORE WAITING），保证听过的人记得住名字。
CHORUS = """LIGHT IT UP, no more waiting for the green
LIGHT IT UP, I'm the fastest thing you've seen
LIGHT IT UP, no more waiting in your line
LIGHT IT UP, every second's mine"""

VERSE_2 = """Neon on the wet road bleeding red
Nothing in the mirror but the things I said
You can keep the queue, you can keep the crown
I already lapped you, look around
Every light is green from where I stand
Every closed door is a door I ran
You can keep the number, keep the name
I'm not standing in it, I'm the flame"""

BRIDGE = """All this time
All this time
I was standing in the dark
Waiting for a spark"""


def lyrics_validate() -> str:
    """30 秒验证片段：2 + 6 + 12 = 20 小节 = 30.00s。

    刻意**不写长前奏**：验证要听到的是人声与副歌，前奏占掉时间就白花了。
    副歌唱两遍，确认它的重复性不让人烦 —— 这是副歌能不能当记忆点的最小测试。
    """
    return "\n".join([
        "[Intro - 2 bars only, start vocals fast]",
        "",
        "[Verse 1 - 6 bars]",
        VERSE_1,
        "",
        "[Pre-Chorus - 2 bars]",
        PRE_CHORUS,
        "",
        "[Chorus - 10 bars, repeat the hook]",
        CHORUS,
    ])


def lyrics_full() -> str:
    """105 秒完整单曲：12 + 8 + 12 + 8 + 4 + 12 + 6 + 8 = 70 小节 = 105.00s。

    结构意图（**副歌前置**）：
      - 第 1 小节直接进副歌（Cold Open）。游戏开场版要的就是这个 ——
        前 32 小节 = 48.00s 正好是「副歌 → 主歌 → 副歌」，第一拍就是 hook。
      - 第二个副歌之后才进 verse 2 与 pre-chorus，把「等待感」放到中段铺垫。
      - 末段收在升八度齐唱的最终副歌，不做长尾 outro：
        朋克应该"摔门而去"，不是"渐弱消失"。
    """
    return "\n".join([
        # 小节数写进段落标签：模型只收到段落顺序和总时长时，容易把前奏铺得过长，
        # 而第二段副歌必须正好在 32 小节（48.00s）处收尾 —— 那是游戏开场版的切点。
        "[Chorus - 12 bars, cold open: the hook starts on bar 1 with the full band]",
        CHORUS,
        "",
        "[Verse 1 - 8 bars, rapped]",
        VERSE_1,
        "",
        "[Chorus - 12 bars]",
        CHORUS,
        "",
        "[Verse 2 - 8 bars, rapped]",
        VERSE_2,
        "",
        "[Pre-Chorus - 4 bars, building]",
        PRE_CHORUS,
        "",
        "[Chorus - 12 bars]",
        CHORUS,
        "",
        "[Bridge - 6 bars, drop to quiet half-time then explode]",
        BRIDGE,
        "",
        "[Final Chorus - 8 bars, octave up, gang vocals]",
        CHORUS,
    ])


# 人声与配器描述 —— 两种模式共用，只在"是不是节选"上有差别
VOICE_SPEC = (
    "语言：英语人声。男性主唱，音色偏亮的朋克嗓：主歌为紧咬节奏的 rapping（半说半唱、"
    "咬字清晰有力），预副歌逐步攀升，副歌为高亢齐唱的朋克式大喊旋律，"
    "全曲叠加多层帮腔齐唱（gang vocals）"
)

ARRANGEMENT_FULL = (
    "Arrangement: 冷开场 —— 第 1 小节直接进副歌，明亮强力和弦扫弦、密集双踩与军鼓重击、"
    "多层帮腔齐唱立刻全部到位，不要前奏、不要渐入、不要留白；"
    "随后主歌落到 half-time 重型律动 —— 失真双轨节奏吉他下扫、sub bass 与合成器衬底、鼓组稀疏但沉重，"
    "人声压抑克制，与副歌形成强烈落差；主歌之后再次冲回副歌，"
    "预副歌加入军鼓滚奏与上升的合成器张力线；桥段突然抽空成半速安静段落，"
    "再爆发回最终副歌并升八度齐唱收尾。"
    "全场混音紧凑、低频扎实有控制、中高频明亮但不刺耳，人声始终清晰靠前；"
    "不要走电子舞曲路线，不要加 auto-tune 滤镜，保留摇滚乐队的粗粝质感。"
)

ARRANGEMENT_EXCERPT = (
    "Arrangement: 开场**立刻**进入人声，只给极短的一拍电子脉冲起手，不要长前奏；"
    "主歌走 half-time 重型律动 —— 失真双轨节奏吉他下扫、sub bass 衬底、鼓组稀疏沉重，人声紧咬节奏；"
    "副歌全面放开 —— 明亮强力和弦扫弦、密集双踩与军鼓重击、多层帮腔齐唱、"
    "高把位旋律吉他叠在失真墙之上。这是节选片段，必须让人声与副歌在 30 秒内完整呈现，"
    "不要渐入、不要留白、不要以安静收尾。混音紧凑有力、人声清晰靠前，保留摇滚乐队的粗粝质感。"
)


# 两种模式的曲目定义
VARIANTS: dict[str, dict] = {
    "validate": {
        "name": f"不再等待·音色验证 (英文朋克摇滚 {BPM}BPM 30s)",
        "duration": 30.00,
        "bars": 20,
        "seed": ANTHEM_SEED,
        "lyrics": lyrics_validate,
        "caption": lambda: (
            "Global Metadata: 英文朋克摇滚单曲的 30 秒音色验证节选"
            "（English Rap-Rock / Punk Anthem, 30-second timbre validation excerpt），"
            f"曲名《{TITLE}》。{VOICE_SPEC}。"
            f"{BPM} BPM，{KEY}，吉他 {TUNING} 调弦，4/4 拍，仅 30 秒。"
            "情绪：不甘等待、破线而出。这是一段用于试听验收的节选，不是完整作品。"
            + ARRANGEMENT_EXCERPT
        ),
    },
    "full": {
        "name": f"不再等待 (英文朋克摇滚主题曲 {BPM}BPM 105s)",
        "duration": 105.00,
        "bars": 70,
        "seed": ANTHEM_SEED,
        "lyrics": lyrics_full,
        "caption": lambda: (
            "Global Metadata: 完整英文朋克摇滚单曲"
            "（English Rap-Rock / Punk Anthem，完整单曲），"
            f"曲名《{TITLE}》。{VOICE_SPEC}。"
            f"{BPM} BPM，{KEY}，吉他 {TUNING} 调弦，4/4 拍，时长 105 秒。"
            "情绪弧线：副歌开场即全面爆发 -> 主歌压抑隐忍 -> 再次爆发 -> 撞线；"
            "主题是「拒绝继续等待」，同时成立在排队与赛车的两个语境里。"
            "注意副歌前置：第 1 小节就是副歌，不要前奏、不要渐入。"
            + ARRANGEMENT_FULL
        ),
    },
}


# ---------------------------------------------------------------------------
# 不变量校验
# ---------------------------------------------------------------------------
def declared_bars(lyrics: str) -> int:
    """把段落标签里声明的小节数加起来（如 `[Verse 1 - 12 bars]` -> 12）。

    存在的理由：段落小节数是**手写的**，和 VARIANTS 里的 bars 是两处独立数据，
    极易漂移。作者本人第一次手算就多算了 4 小节（74 而非 70）。
    这个函数让脚本自己拦住这类错误，而不是等到 100 分钟后才发现曲子长了 6 秒。
    """
    total = 0
    for m in re.finditer(r"\[[^\]]*?-\s*(\d+)\s*bars?", lyrics):
        total += int(m.group(1))
    return total


def verify(mode: str) -> list[str]:
    """返回问题列表；空列表表示通过。"""
    v = VARIANTS[mode]
    problems: list[str] = []
    got = declared_bars(v["lyrics"]())
    if got != v["bars"]:
        problems.append(
            f"[{mode}] 段落标签声明 {got} 小节，但曲目定义为 {v['bars']} 小节"
        )
    if abs(v["duration"] - v["bars"] * BAR_SECONDS) > 1e-9:
        problems.append(
            f"[{mode}] 时长 {v['duration']}s 与 {v['bars']} 小节 × {BAR_SECONDS}s 不符"
        )
    return problems


def check_all() -> int:
    problems: list[str] = []
    for mode in sorted(VARIANTS):
        problems += verify(mode)
    if problems:
        print("简报自检失败：")
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("简报自检通过：段落小节数与曲目定义一致，时长落在小节网格上。")
    for mode in sorted(VARIANTS):
        v = VARIANTS[mode]
        print(f"  {mode:<9} {v['bars']:>3} 小节 = {v['duration']:.2f}s")
    return 0


# ---------------------------------------------------------------------------
# 网络
# ---------------------------------------------------------------------------
def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def check_service() -> bool:
    try:
        st = get("/api/comfy")
    except Exception as e:  # noqa: BLE001
        print(f"[错误] 连不上 music3 ({BASE})：{e}")
        print("       先双击 music3/start-music.command 启动工作台。")
        return False
    ver = st.get("system_stats", {}).get("system", {}).get("comfyui_version", "?")
    print(f"[就绪] ComfyUI {ver} 在线")
    return True


# ---------------------------------------------------------------------------
# 状态文件 —— 记录 run_ids，供后续取产物与追溯
# ---------------------------------------------------------------------------
STATE_FILE = pathlib.Path(__file__).resolve().parent / "punk_anthem_runs.json"


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# 命令
# ---------------------------------------------------------------------------
def do_list(mode: str) -> None:
    v = VARIANTS[mode]
    print(f"\n《{TITLE}》 mode={mode}")
    print(f"  时长 {v['duration']:.2f}s = {v['bars']} 小节 "
          f"({BPM} BPM, 1 小节 = {BAR_SECONDS:.3f}s)")
    print(f"  调性 {KEY} / 吉他 {TUNING}   seed={v['seed']}")
    print(f"  提交名: {v['name']}")
    print("\n  --- 歌词 ---")
    for line in v["lyrics"]().splitlines():
        print("  " + line)
    print("\n  --- caption ---")
    print("  " + v["caption"]())
    print()


def do_submit(mode: str) -> None:
    # 提交前先过不变量校验：宁可现在报错，也不要 100 分钟后拿到一条结构不对的曲子
    problems = verify(mode)
    if problems:
        for p in problems:
            print("  ✗ " + p)
        sys.exit("简报自检失败，未提交。先修好段落小节数。")
    if not check_service():
        sys.exit(1)
    v = VARIANTS[mode]
    payload = {
        "name": v["name"],
        "lyrics": v["lyrics"](),
        "caption": v["caption"](),
        "duration": v["duration"],
        "cfg": 1.5,
        "steps": 16,
        "top_k": 50,
        "seed": v["seed"],
        "skill_id": SKILL_ID,
    }
    song = post("/api/songs", payload)
    res = post(f"/api/songs/{song['id']}/generate", {"count": 1})

    state = load_state()
    state[mode] = {
        "song_id": song["id"],
        "run_ids": res["run_ids"],
        "name": v["name"],
        "duration": v["duration"],
        "bars": v["bars"],
        "bpm": BPM,
        "key": KEY,
        "seed": v["seed"],
    }
    save_state(state)

    print(f"[已排队] mode={mode}  song_id={song['id']}  run_ids={res['run_ids']}  "
          f"({v['duration']:.1f}s / {v['bars']} 小节)")
    print("\n跑完之后：原始文件落在 /Users/exasdwyh/ComfyUI-Shared/output/audio/")
    print("先用 listen 脚本取回试听，确认方向再决定是否提交全曲。")
    print("\n查看进度：python3 scripts/submit_punk_anthem.py --runs")


def do_runs() -> None:
    state = load_state()
    if not state:
        print("还没有提交记录（punk_anthem_runs.json 不存在）")
        return
    try:
        rs = get("/api/runs")
    except Exception as e:  # noqa: BLE001
        print(f"[错误] 查不到运行记录：{e}")
        return
    by_id = {r["id"]: r for r in rs}
    import time

    now = time.time()
    for mode, rec in state.items():
        print(f"\nmode={mode}  song_id={rec['song_id']}  "
              f"{rec['duration']:.1f}s / {rec['bars']} 小节")
        for rid in rec["run_ids"]:
            r = by_id.get(rid)
            if not r:
                print(f"  run {rid}: 记录不存在")
                continue
            started, fin = r.get("started_at"), r.get("finished_at")
            el = ((fin - started) if (started and fin)
                  else (now - started if started else 0)) / 60
            out = str(r.get("output") or r.get("error") or "")
            print(f"  run {rid}: {str(r.get('status')):<8} 已用 {el:6.1f} 分钟  {out[-70:]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=f"提交英文朋克摇滚主题曲《{TITLE}》")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--list", action="store_true", help="只打印简报，不提交")
    g.add_argument("--submit", action="store_true", help="创建歌曲并排队生成")
    g.add_argument("--runs", action="store_true", help="查看本曲生成进度")
    g.add_argument("--check", action="store_true",
                   help="校验段落小节数与时长是否自洽（不联网，不提交）")
    ap.add_argument("--mode", choices=sorted(VARIANTS), default="validate",
                    help="validate=30s 音色验证（默认） / full=105s 全曲")
    a = ap.parse_args()

    if a.check:
        sys.exit(check_all())
    if a.list:
        do_list(a.mode)
    elif a.submit:
        do_submit(a.mode)
    else:
        do_runs()


if __name__ == "__main__":
    main()
