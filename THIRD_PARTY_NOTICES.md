# 样机来源与许可证

本样机依赖由 npm 注册表安装，精确版本和完整传递依赖在 package-lock.json。服务运行后所有模块由本机提供，游戏不依赖远程 CDN。

| 直接依赖 | 锁定版本 | 来源 | 许可文本 |
|---|---|---|---|
| Three.js | 0.186.0 | https://github.com/mrdoob/three.js | MIT，licenses/three.txt |
| ws | 8.21.3 | https://github.com/websockets/ws | MIT，licenses/ws.txt |
| qrcode | 1.5.4 | https://github.com/soldair/node-qrcode | MIT，licenses/qrcode.txt |

Three.js 原封不动以 ES 模块供客户端加载；ws 用作服务端 WebSocket；qrcode 生成本机加入二维码。以上许可证来自对应已安装版本。传递依赖自带许可证保留在 node_modules，重新安装由 lockfile 确定；正式打包前须收集所有随包分发组件的声明。

海湾赛道、车辆、驾驶员、建筑、树木、码头、天空和 UI：本轮原创程序几何/样式，来源 public/app.mjs、public/simulation.mjs、public/styles.css，无外部素材文件。

调研过的 KenneyNL/Starter-Kit-Racing、mrdoob/Starter-Kit-Racing、endel/Multiplayer-Starter-Kit-Racing、SuperTuxKart 均仅作候选与设计参考，没有复制其代码或资产，因此不记录虚构采用提交。具体调研在 ../docs/OPEN_SOURCE_REFERENCES.md。

## 2026-09-12 引入的外部素材（可商用 CC0 / 已验证下载）

以下素材已下载至本样机 `assets/` 目录，用于替换/补充原创程序几何。全部为 CC0（公共领域，可商用、可修改、可随产品分发，无需署名），符合仓库"仅允许非商业使用的内容不得进产品"红线。

| 素材 | 本地路径 | 来源 URL | 许可证 | 说明 |
|---|---|---|---|---|
| Kenney 赛车 GLB（多色） | `assets/racing/*.glb` | https://github.com/shorepine/kenney (3d/racing/*.glb) 及官方 https://kenney.nl/assets/racing-kit | CC0 | glTF 二进制 v2，Three.js 原生 `GLTFLoader` 可载；Godot 亦支持 glTF。5 meshes / 6 nodes 每辆。 |
| Poly Haven 赛道 PBR 贴图 | `assets/textures/*_diff_1k.png` / `*_nor_gl_1k.png` | https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/{name}/（asphalt_01/02/03、asphalt_track、running_track） | CC0 | 1024×1024，albedo(diff)+normal_gl；GL 法线贴图适用 Three.js；Godot 需法线格式转换或 `TextureNormal`。 |

采用提交记录：本变更由 owner 授权新增；文件内容未修改（原样二进制），修改情况=无。正式打包前须将上述素材许可证（CC0 声明文本）随产品交付。
