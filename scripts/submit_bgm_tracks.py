#!/usr/bin/env python3
"""
极速等位赛 · BGM 曲库提交脚本（MiniMax-Music-3 / music3 workbench）

用途
----
把「海湾环线」自适应音乐曲库的创作简报送进本机 music3 工作台
(http://127.0.0.1:8766)，由 ComfyUI 上的 MiniMax-Music-3 渲染成 mp3。

为什么需要这个脚本，而不是在网页上点
------------------------------------
自适应音乐要求整族曲目在 **BPM / 调性 / 小节长度** 上严格一致，才能在运行时
按小节边界交叉淡入而不出现「换歌」的突兀感。这些约束必须版本化、可复现、
可重新生成；写在脚本里比写在网页表单里可靠。

曲库设计（改参数前先读 docs/AUDIO_DESIGN.md）
--------------------------------------------
比赛族：BPM 160，D 小调，4/4 -> 1 小节 = 1.500s
  32 小节 = 48.00s  巡航层 / 对抗层（同 seed 家族，保证素材同源可交叉淡化）
   8 小节 = 12.00s  结算层（不循环，正好匹配 12 秒成绩展示窗口）
候场族：BPM 120，C 大调，4/4 -> 1 小节 = 2.000s
  16 小节 = 32.00s  候场层（长时间循环不疲劳）

用法
----
    python3 scripts/submit_bgm_tracks.py --list          # 只打印简报，不提交
    python3 scripts/submit_bgm_tracks.py --submit        # 创建歌曲并排队生成
    python3 scripts/submit_bgm_tracks.py --submit --only lobby
    python3 scripts/submit_bgm_tracks.py --runs          # 查看本批生成进度

生成很慢（25s 曲目约 10-22 分钟），提交后排队即可，脚本会立刻返回。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8766"
SKILL_ID = 1  # MiniMax-Music-3 (MPS bf16 文本编码器 + fp16 DiT)

# ---------------------------------------------------------------------------
# 音乐族公共约束 —— 全部比赛曲目共用，改动即破坏交叉淡化
# ---------------------------------------------------------------------------
RACE_BPM = 160
RACE_KEY = "D 小调"
RACE_SEED = 160_2026  # 巡航层与对抗层刻意共用同一 seed：同源素材，便于交叉淡化

LOBBY_BPM = 120
LOBBY_KEY = "C 大调"
LOBBY_SEED = 120_2026

# 纯器乐，无歌词；用 [Section] 标记给模型段落感（MiniMax-Music-3 支持结构控制）
INSTRUMENTAL_TAG = "[Instrumental]"

# ---------------------------------------------------------------------------
# 循环层作曲规约（2026-09-12 负责人反馈后加入）
#
# 为什么必须显式写这段：生成模型默认按**单曲**作曲 —— 起承转合、intro、build、
# breakdown。但循环层是另一回事：
#   · 它会被同一批顾客听几十遍。任何「铺垫」在第 2 次循环时就变成障碍。
#   · 短循环里最抓耳的副歌常常还没到，循环就回到开头了。
# 实测（scripts/audit_loop_fitness.py）第一版四轨全部不合格：
#   lobby 动态跨度 31.4dB（3.0s 空洞 @23.5s）、final 17.2dB（4.25s 塌陷 @30.5s）、
#   race 钩子延后（主旋律被写到中段才进）、results 前 3s 从 -14dB 爬起。
# 根因就是简报里的这些措辞：gentle lift / lead melody enters /
# strip back · tension reset for the loop / breakdown to filtered build-up。
#
# 规约：第 1 拍即全编制 + 全程动态跨度 ≤3dB + 变化靠配器加层而非能量升降。
# 判据与体检入口见 docs/AUDIO_DESIGN.md 与 scripts/audit_loop_fitness.py。
# ---------------------------------------------------------------------------
LOOP_STEM_RULE = (
    "IMPORTANT - this is a LOOP STEM, not a song: no intro, no pickup, no fade-in, "
    "no build-up, no breakdown, no drop, no drum-less section, no filtered sweep, "
    "and no silence anywhere. The full arrangement plays at full loudness from the very "
    "first beat to the last; the whole loop stays within a 3 dB loudness range, and "
    "variation comes only from instrumentation and added layers, never from changing the "
    "energy level. The hook must be audible in bar 1 - never save the memorable melody "
    "for the middle or the end."
)

# 一次性短终结段（结算）用：同样不许软开场，但允许终止式收尾。
STING_RULE = (
    "IMPORTANT - a short 12-second sting: hit at full volume on the very first beat; "
    "no intro, no riser, no quiet opening, no building up, no silence. Keep the energy "
    "high from bar 1 all the way to the final resolved chord."
)

TRACKS: list[dict] = [
    # -----------------------------------------------------------------------
    # 候场 / 等位 —— 顾客扫码、起昵称、选头像、等人齐。这一段可能长达数分钟，
    # 所以「不疲劳」比「抓耳」重要：不做强爆点，动态平稳，中频友好。
    # -----------------------------------------------------------------------
    {
        "key": "lobby",
        "name": "等位·海湾傍晚 (候场循环 120BPM 32s)",
        "duration": 32.00,
        "bpm": LOBBY_BPM,
        "bars": 16,
        "loop": True,
        "seed": LOBBY_SEED,
        "cfg": 1.5,
        "steps": 16,
        "top_k": 50,
        "file": "bgm-lobby",
        "lyrics": "\n".join([
            INSTRUMENTAL_TAG,
            "(Relaxed city-pop lounge groove, 120 BPM, C major, no vocals, seamless 16-bar loop)",
            "[Bar 1 - the full groove is already playing: no intro, no pickup, no fade-in]",
            "(Electric piano chords, round slap bass, marimba, shaker and light drums all from the first beat)",
            "[Section A - 8 bars]",
            "(Steady groove holding one loudness level throughout: electric piano comping, round slap bass, "
            "marimba sparkle, shaker, soft kick and rimshot)",
            "[Section B - 8 bars]",
            "(Identical loudness - only add clean electric guitar strum and a soft string pad; "
            "that is a texture change, not a lift and not a build)",
        ]),
        "caption": (
            "Global Metadata: 轻快放松的等位候场循环层（Lobby / Queue Waiting LOOP STEM），"
            f"City Pop 融合轻 Funk 与海港 Lounge 风格，{LOBBY_BPM} BPM，{LOBBY_KEY}（明亮温暖），纯器乐无人声，无歌词。"
            "氛围：餐厅门口排队等候、傍晚海湾、期待与轻松，让人心情好但不打扰交谈。"
            "Arrangement: 干净的电钢琴和弦进行为骨架，弹性圆润的 slap bass 走主线，"
            "清脆马林巴与钢片琴点缀，shaker 与轻量鼓组（软底鼓、rimshot 军鼓、闭合踩镲）提供摇摆感，"
            "再叠温暖电吉他清音扫弦与柔和弦乐垫底。混音干净、中频友好、低频克制、无刺耳高频。"
            + LOOP_STEM_RULE
        ),
    },
    # -----------------------------------------------------------------------
    # 比赛主体 —— 巡航层。比赛中播放时间最长的一层，要「有推进力但不吵」。
    # -----------------------------------------------------------------------
    {
        "key": "race",
        "name": "海湾环线·香水狂飙 (Lança Perfume 极速纯乐 160BPM 48s)",
        "duration": 48.00,
        "bpm": RACE_BPM,
        "bars": 32,
        "loop": True,
        "seed": 19800816,
        "cfg": 1.5,
        "steps": 16,
        "top_k": 50,
        "file": "bgm-race",
        "lyrics": "\n".join([
            INSTRUMENTAL_TAG,
            "(High-speed arcade racing loop stem referencing Rita Lee - Lança Perfume, 160 BPM, D major, no vocals, seamless 32-bar loop)",
            "[Bar 1 - full groove WITH the iconic Lança Perfume hook melody is already playing: no intro, no pickup, no fade-in]",
            "(Punchy four-on-the-floor disco kick, crisp snappy snare with clap, driving slap bass AND the soaring brass-synth lead playing the catchy Lança Perfume chorus hook from the very first beat)",
            "[Section A - 8 bars: Chorus Hook]",
            "(Full arrangement at full loudness: punchy disco drums, driving 16th hats with offbeat open hats, bouncy slap bass octave pops, clavinet chops, soaring synth lead and brass stabs playing the iconic Lança Perfume hook)",
            "[Section B - 8 bars: Verse Melody]",
            "(Identical loudness - synth lead plays the bouncy syncopated verse melody with sunny Latin boogie chord chops; instruments are added, the energy level does not change)",
            "[Section C - 8 bars: Bridge & Funk Interlude]",
            "(Identical loudness - brass fanfares double the melody over funky slap bass and bright rhythm guitar; no breakdown, no drop, no filter sweep, no silence)",
            "[Section D - 8 bars: Climax Hook Return]",
            "(Identical loudness - lead synth plays the soaring anthemic hook an octave higher with all layers driving at full power; no fade-out, no drop, ends on seamless loop turnaround)",
        ]),
        "caption": (
            "Global Metadata: 高速街机赛车竞速循环音乐（Arcade Kart Racing LOOP STEM），"
            "参考 Rita Lee 经典名曲《Lança Perfume》的核心洗脑旋律与标志性 Brazilian Boogie / Latin Disco Funk 律动，"
            f"融合街机竞速风格，{RACE_BPM} BPM，D 大调（明亮欢快、阳光海风与极速冲刺），纯器乐无人声，无歌词，无歌唱。"
            "氛围：海湾城市赛道、阳光海岸、贴身追逐、极速狂飙、洗脑愉悦。"
            "Arrangement: 坚定有力的四拍舞曲底鼓（Punchy 4-on-the-floor kick）、清脆双掌声军鼓（Snare with clap）、疾速16分闭合踩镲与反拍开镲，"
            "极富弹性与跳跃感的 Slap Bass（走低音八度跳音与击勾弦），Funk 清音吉他切分扫弦与 Clavinet 律动，"
            "明亮高亢的合成器主音与铜管组从第 1 拍起就毫不迟疑地领奏《Lança Perfume》的核心旋律线，辅以温暖弦乐垫与闪烁琶音。"
            "整体音色油亮有光泽、律动紧凑推进、低频扎实弹性、旋律极度洗脑抓耳；"
            "全程保持高能稳态，结尾无终止式，小节间可完美无缝循环。"
            + LOOP_STEM_RULE
        ),
    },
    # -----------------------------------------------------------------------
    # 比赛最高张力层 —— 与巡航层同 BPM / 同调 / 同 seed，运行时叠在巡航层上，
    # 用于最后一圈、贴身对决、冲线时刻。
    # -----------------------------------------------------------------------
    {
        "key": "final",
        "name": "最后一圈·冲刺 (最高张力层 160BPM 48s)",
        "duration": 48.00,
        "bpm": RACE_BPM,
        "bars": 32,
        "loop": True,
        "seed": RACE_SEED,  # 与巡航层同 seed：保证素材同源
        "cfg": 1.5,
        "steps": 16,
        "top_k": 50,
        "file": "bgm-race-final",
        "lyrics": "\n".join([
            INSTRUMENTAL_TAG,
            "(Maximum-intensity final lap arcade racing loop stem, 160 BPM, D minor, no vocals, seamless 32-bar loop)",
            "[Bar 1 - maximum intensity is already playing: no intro, no riser, no build-up]",
            "(Pounding four-on-the-floor kick, dense snare rolls, distorted synth lead and brass fanfare "
            "all from the first beat)",
            "[Section A - 8 bars]",
            "(Relentless full-intensity groove: pounding kick, snare rolls, dense 16th hats, "
            "distorted synth lead, choir-like pad)",
            "[Section B - 8 bars]",
            "(Identical intensity and loudness - triumphant brass fanfare stabs layered on top; added layer only)",
            "[Section C - 8 bars]",
            "(Identical intensity - the lead plays a higher urgent counter-melody with a half-step harmonic "
            "lift; NO breakdown, NO filtered build-up, NO drum removal, NO silence)",
            "[Section D - 8 bars]",
            "(Identical intensity - all layers doubled for the finish; the loudness never dips anywhere in the loop)",
        ]),
        "caption": (
            "Global Metadata: 最后一圈冲刺的高张力街机竞速循环层（Final Lap High-Tension Racing LOOP STEM），"
            f"Hard Eurobeat 融合 Orchestral Brass 与硬核街机风格，{RACE_BPM} BPM，{RACE_KEY}，纯器乐无人声，无歌词。"
            "氛围：决胜最后一圈、贴身争夺、氮气全开、肾上腺素。比巡航层明显更密集、更满。"
            "Arrangement: 捶击感强烈的四拍底鼓与密集军鼓滚奏，高速 16 分踩镲，"
            "失真处理的高亢合成器主音从第一拍起就在前景领奏，威武的铜管 fanfare 齐奏插入，"
            "史诗感和声垫与紧张的半音进行推高情绪。"
            "整体密集、紧绷、昂扬；低频强劲但有控制，高频明亮不刺耳；结尾不做终止，可无缝循环。"
            + LOOP_STEM_RULE
        ),
    },
    # -----------------------------------------------------------------------
    # 结算 —— 12 秒成绩展示窗口。要有「冲过终点」的终结感，所以不循环。
    # -----------------------------------------------------------------------
    {
        "key": "results",
        "name": "结算颁奖 (12s 终结段 160BPM)",
        "duration": 12.00,
        "bpm": RACE_BPM,
        "bars": 8,
        "loop": False,
        "seed": 160_2027,
        "cfg": 1.5,
        "steps": 16,
        "top_k": 50,
        "file": "bgm-results",
        "lyrics": "\n".join([
            INSTRUMENTAL_TAG,
            "(Triumphant podium victory sting, 160 BPM, D major, no vocals, 12 seconds, ends on a resolved final chord)",
            "[Bar 1 - brass fanfare and drums hit at full volume immediately: no intro, no riser, no pickup]",
            "(Loud brass fanfare, big drums and bright synth lead all from the first beat)",
            "[Bars 1-6 - hold the energy high the whole time]",
            "(Continuous triumphant brass, driving drums, upward major-key melody; no quiet section, no riser, no build)",
            "[Bars 7-8 - final hit]",
            "(Land on one big resolved major chord and stop; clear ending, no fade-out)",
        ]),
        "caption": (
            "Global Metadata: 比赛结算与颁奖的短促胜利音乐（Results / Podium Victory Sting），"
            f"Orchestral Brass 融合 8-bit 街机音色，{RACE_BPM} BPM，D 大调（辉煌明亮），纯器乐无人声，无歌词，仅 12 秒。"
            "氛围：冲过终点线、成绩揭晓、荣誉与庆祝，明朗上扬。"
            "Arrangement: 嘹亮的铜管号角齐奏从第一拍起就宣告胜利，强劲的鼓组与镲片重击强化完成感，"
            "明亮合成器主音演奏向上的大调旋律，最后收在一个完整、辉煌、有明确终止感的和弦上。"
            "不要循环设计，必须有清晰的结尾；整体紧凑、干净、令人愉悦。"
            + STING_RULE
        ),
    },
]


# ---------------------------------------------------------------------------
# 简报自检：禁止「单曲式动态」
#
# 这些措辞一旦出现在简报里，模型就会按**单曲**叙事作曲 —— 循环层立刻变成
# 「前面铺垫、中间才进旋律、结尾还退潮」。第一版四轨就是这么废掉的：
#   final 简报里写了 "Breakdown to filtered build-up"，实测就出现 4.25s 塌陷。
# 允许这些词出现在**否定语境**里（"no breakdown"），因为那正是我们要求的。
# 判定：短语前 40 字符内出现否定词 → 视为禁令句，放行。
# ---------------------------------------------------------------------------
BANNED_SINGLE_TRACK_PHRASES = [
    "gentle lift", "melody enters", "melody comes in", "strip back", "strip down",
    "tension reset", "breakdown", "build-up", "build up", "builds up",
    "explosive drop", "excitement build", "slow build", "riser",
    "gradually add", "one by one", "starts sparse", "sparse intro", "fade-in",
    "intro", "build",
]
NEGATION_MARKERS = ("no ", "not ", "never ", "without ", "don't ", "avoid ",
                    "禁止", "不要", "无", "不")


def audit_brief(track: dict) -> list[str]:
    """检查单条简报是否有未加否定的「单曲式动态」措辞。空列表 = 通过。"""
    text = track["lyrics"] + "\n" + track["caption"]
    low = text.lower()
    bad: list[str] = []
    for phrase in BANNED_SINGLE_TRACK_PHRASES:
        start = 0
        while True:
            i = low.find(phrase, start)
            if i < 0:
                break
            window = low[max(0, i - 40):i]
            if not any(neg in window for neg in NEGATION_MARKERS):
                snippet = text[max(0, i - 30):i + len(phrase) + 20].replace("\n", " ")
                bad.append(f"「{phrase}」→ …{snippet}…")
            start = i + len(phrase)
    return bad


def audit_all_briefs() -> list[str]:
    """返回全部问题（带曲目名）。同时检查循环层必须挂上 LOOP_STEM_RULE。"""
    problems: list[str] = []
    for t in TRACKS:
        for msg in audit_brief(t):
            problems.append(f"{t['key']}: {msg}")
        if t["loop"] and LOOP_STEM_RULE not in t["caption"]:
            problems.append(f"{t['key']}: 循环层 caption 缺少 LOOP_STEM_RULE（钩子前置/稳态规约）")
        if not t["loop"] and STING_RULE not in t["caption"]:
            problems.append(f"{t['key']}: 终结段 caption 缺少 STING_RULE（禁止软开场）")
    return problems


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
    sysinfo = st.get("system_stats", {}).get("system", {})
    print(f"[就绪] ComfyUI {sysinfo.get('comfyui_version', '?')} 在线")
    return True


def do_list() -> None:
    print(f"\n共 {len(TRACKS)} 首曲目，目标目录 pilot-racer/public/audio/\n")
    for t in TRACKS:
        bar = 60.0 / (RACE_BPM if t["key"] != "lobby" else LOBBY_BPM) * 4
        bars = round(t["duration"] / bar, 2)
        kind = "循环层" if t["loop"] else "终结段"
        print(f"  {t['key']:<8} -> {t['file']}.mp3   [{kind}]")
        print(f"           时长 {t['duration']:.2f}s ≈ {bars} 小节  seed={t['seed']}  {t['name']}")

    problems = audit_all_briefs()
    print()
    if problems:
        print("✗ 简报自检未通过：")
        for p in problems:
            print(f"    {p}")
        print("\n  循环层规约：第 1 拍即全编制、动态跨度 ≤3dB、变化靠配器不靠能量升降。")
    else:
        print("✓ 简报自检通过：无可触发单曲式动态的措辞，钩子前置规约已挂载。")


def do_submit(only: str | None) -> None:
    # 先过简报自检再提交：生成的曲子一旦按单曲叙事作曲，100 分钟算力就白烧了。
    problems = audit_all_briefs()
    if problems:
        print("✗ 拒绝提交：简报自检未通过（这样生成的曲子不适合短循环）")
        for p in problems:
            print(f"    {p}")
        print("\n  先修简报：循环层必须第 1 拍即全编制、变化靠配器而非能量升降。")
        sys.exit(1)
    if not check_service():
        sys.exit(1)
    submitted = []
    for t in TRACKS:
        if only and t["key"] != only:
            continue
        payload = {
            "name": t["name"],
            "lyrics": t["lyrics"],
            "caption": t["caption"],
            "duration": t["duration"],
            "cfg": t["cfg"],
            "steps": t["steps"],
            "top_k": t["top_k"],
            "seed": t["seed"],
            "skill_id": SKILL_ID,
        }
        song = post("/api/songs", payload)
        res = post(f"/api/songs/{song['id']}/generate", {"count": 1})
        submitted.append((t["key"], song["id"], res["run_ids"]))
        print(f"[已排队] {t['key']:<8} song_id={song['id']} run_ids={res['run_ids']}  ({t['duration']:.1f}s)")
    print("\n提交完成。生成按队列串行，25s 曲目约 10-22 分钟；用 --runs 查进度。")
    print("原始文件落在 ComfyUI 输出目录，交付前需跑 scripts/postprocess_bgm.py 做小节对齐与循环处理。")
    print(json.dumps([{"key": k, "song_id": s, "run_ids": r} for k, s, r in submitted],
                     ensure_ascii=False, indent=1))


def do_runs() -> None:
    runs = get("/api/runs")
    if not runs:
        print("还没有运行记录。")
        return
    print(f"{'run':>5} {'song':>5} {'status':<8} {'文件'}")
    for r in runs[:20]:
        out = (r.get("output") or r.get("error") or "")[:96]
        print(f"{r['id']:>5} {str(r.get('song_id')):>5} {str(r.get('status')):<8} {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description="提交「极速等位赛」BGM 曲库到 music3")
    ap.add_argument("--list", action="store_true", help="只打印简报")
    ap.add_argument("--submit", action="store_true", help="创建歌曲并排队生成")
    ap.add_argument("--runs", action="store_true", help="查看生成进度")
    ap.add_argument("--only", help="只提交某一首（lobby/race/final/results）")
    a = ap.parse_args()
    if a.runs:
        do_runs()
    elif a.submit:
        do_submit(a.only)
    else:
        do_list()
        print("\n加 --submit 才会真正提交生成。")


if __name__ == "__main__":
    main()
