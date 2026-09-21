# Hyper3D 科技车队候选验收

日期：2026-09-21  
生成器：Hyper3D Rodin Gen-2.5（官方 MCP）  
设置：Gen-2.5-High / Raw / 20,000 triangles / GLB / 默认 PBR 2K  
用途：02–08 号比赛车正式运行时资产；01 号保留现有英雄车。

## 结果

| 编号 | 车型 | Hyper3D 任务 | PBR GLB | 尺寸 X/Y/Z | 结论 |
| --- | --- | --- | --- | --- | --- |
| 02 | Cobalt Manta | [查看](https://hyper3d.ai/workspace/rodin/ecaa0502-ea04-4bd5-8dbf-b12cd6caa9a2) | `02-cobalt-manta-pbr.glb` | 1.459 / 1.892 / 0.685 | 通过候选验收 |
| 03 | Jade Lynx | [查看](https://hyper3d.ai/workspace/rodin/3af01b1b-8117-4bb6-b2b9-164d0c51178b) | `03-jade-lynx-pbr.glb` | 1.510 / 1.892 / 0.924 | 通过候选验收 |
| 04 | Crimson Kestrel | [查看](https://hyper3d.ai/workspace/rodin/e50f07eb-430b-4152-819e-26c1a900301f) | `04-crimson-kestrel-pbr.glb` | 1.369 / 1.899 / 0.743 | 通过候选验收 |
| 05 | Violet Nautilus | [查看](https://hyper3d.ai/workspace/rodin/f3fb9345-7cbe-4875-9acf-20889dd30bba) | `05-violet-nautilus-pbr.glb` | 1.411 / 1.903 / 0.751 | 通过候选验收 |
| 06 | Teal Courier | [查看](https://hyper3d.ai/workspace/rodin/d2e196e1-557e-4bc8-9be0-fa005e9dcf6e) | `06-teal-courier-pbr.glb` | 1.488 / 1.898 / 0.768 | 通过候选验收 |
| 07 | Amber Dune | [查看](https://hyper3d.ai/workspace/rodin/fee463c1-6886-4632-ab83-3664c45611be) | `07-amber-dune-pbr.glb` | 1.491 / 1.900 / 0.841 | 通过候选验收 |
| 08 | Obsidian Pulse | [查看](https://hyper3d.ai/workspace/rodin/fa088d13-18e8-47a3-8fd6-af6fb69e40f3) | `08-obsidian-pulse-pbr.glb` | 1.608 / 1.894 / 0.821 | 通过候选验收 |

每辆同时保留 PBR 与 Shaded 源文件；PBR 单车约 8.9–11 MB，Shaded 单车约 4.4–5.4 MB。比赛使用 `runtime/` 内的 1024 贴图版，单车约 1.4–1.6 MB。全部是 20,000 三角面、1 个网格对象、1 个材质，中心接近原点，无骨骼动画。

## 视觉检查

- 前后轮、座舱、方向盘、尾翼和尾部推进结构均可读。
- 七辆车的车头轮廓与配色差异明显，大屏远景可区分。
- 轮胎接地与车身比例合理，没有观察到缺失后部或明显漂浮大部件。
- 车型风格成熟、机能化，没有回到儿童玩具语言。
- 02/04 更偏低趴高速，03/07 强化越野轮胎，06 偏工业机能，08 偏重装防御，角色定位清楚。

## 已完成的比赛接入

1. `public/app.mjs` 已将 02–08 车位替换为 Hyper3D GLB，加载完成前保留旧车，失败则自动回退。
2. 车壳在客户端统一长度、中心和接地高度，并加入大屏可读编号、全覆面科技车手、接地阴影与原氮气尾焰。
3. 大屏按需加载全部 7 辆；手机只下载自己的车位资产，01 号不增加 GLB 下载。
4. 服务端碰撞盒、物理、排名、道具和 `pilot-racer/1` 协议未改变。
5. 单网格轮胎暂时跟随整车侧倾，不独立旋转；后续可对特写优先级车型做 BANG/手工分件，不影响当前上车。

## 验证

- 大屏 8 车实际比赛、追踪/侧拍/全景导播已检查，新车比例、朝向、路面接地和编号正常。
- `npm run check` → **82 passed, 0 failed**。
- 资产测试锁定 7 个本地 GLB、文件上限、网格/材质/贴图完整性、车位映射、手机单车加载和程序车回退。

## 质检产物

- `front-board.png`：七辆车前视三分之四实模渲染。
- `rear-board.png`：七辆车后视三分之四实模渲染。
- `intake.json`：文件大小、三角面、材质、贴图和包围盒记录。
- 检查脚本：`scripts/inspect_hyper3d_roster.py`。
- 运行版构建脚本：`scripts/build_hyper3d_runtime_roster.py`。
