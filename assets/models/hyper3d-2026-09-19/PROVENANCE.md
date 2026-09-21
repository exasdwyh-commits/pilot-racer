# 赤潮 01 候选资产来源

日期：2026-09-19。用户明确授权使用 Hyper3D 重新设计卡丁车与驾驶员。

- 概念图：OpenAI imagegen 为本项目原创生成，保存在 `../../concepts/hyper3d-2026-09-19/`。没有上传第三方角色或品牌图。
- 三维模型：Hyper3D Rodin Gen-2.5-Medium，image-to-3D，Raw 三角面，GLB/PBR。
- 车体任务：`df7d8b02-9923-4602-99d5-fc195cf7e302`，目标 10,000 三角面。
- 驾驶员任务：`b380f88a-35f4-4c02-9299-cd010e23c85a`，目标 6,000 三角面。
- 车体拆分：Hyper3D BANG，`545c027a-d4e8-47ab-a97f-d08cd0cad3ce`，Basic，strength 6，自动拆分规划。
- 本地处理：Blender 5.2.1 LTS；尺寸与落地点归一、1024 贴图、JPEG 85、共享车体材质、四轮轮心与前轮转向节点、尾翼转轴。
- 权利说明：生成资产适用本次 Hyper3D/OpenAI 账户及服务条款，**不是 Kenney CC0 资产，也不声明 CC0**。正式商业分发前应留存账户对应许可记录。
- 本目录是候选区，未接入游戏运行时。`source/` 保留服务端原始输出，禁止用处理版覆盖源文件。

## 交付文件

| 文件 | 用途 | 字节 | 三角面 |
|---|---|---:|---:|
| `crimson-kart-parts-candidate.glb` | 推荐继续接入的拆分车体 | 911604 | 10000 |
| `crimson-driver-candidate.glb` | 独立 A 姿态驾驶员，尚未蒙皮绑定 | 500624 | 6000 |
| `crimson-kart-candidate.glb` | 未拆分的静态比较基准 | 917044 | 10000 |

SHA-256：

```text
602c9945f972442ed33448df5dae8c33fa1a910243270528dc7387c9fb605f20  crimson-kart-parts-candidate.glb
1c43bf8164dc16f2de97bacede747e3b8d12727f0b711df85ccc19fd419840de  crimson-driver-candidate.glb
feca31777c67ba60f473e2f990b48a2a65fa0dfce9b36d6ab3cf1192e5d64ee1  crimson-kart-candidate.glb
70f06292757274be6510df8a6a791aaff84ebdad4a56f7598b4f2791820eff80  source/crimson-kart-raw.glb
4c58563a099b3d4ceb5a0b96498e65daf6067cbebaca0105244ede7f009e353e  source/crimson-driver-raw.glb
d0a2c3617adcf46b58089692193b1e4da821f04081031199eb7e876b56695499  source/crimson-kart-parts-raw.glb
```

提示词、生成参数与任务恢复点：`../../../artifacts/hyper3d-2026-09-19.json` 和 `../../../artifacts/hyper3d-2026-09-19-parts.json`。不保存访问令牌或临时签名下载链接。
