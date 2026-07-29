# PRODUCTS

所有接入端平级，都只通过 App Server 协议工作。任何接入端都不得拥有
自己的 Agent、Thread、Turn 或调度语义。

## 第一客户端（候选优先级）

1. **原版 `codex --remote`** — Codex CLI 支持连接远程 App Server；若 Zen 的
   协议子集能承载它，第一客户端零开发。
2. **固定版本 T3 Code** — MIT 开源桌面编排器，用同一协议驱动 agent。
3. **自建薄 Zen CLI** — 仅当上面两者要求的子集过大时才做。

选择由 Phase 2 协议侦察决定：起一个最小 stub App Server，记录真实客户端
的实际调用，据此定子集。

## 桌面

近期不自建：目标是固定版本的 T3 Code 通过协议直接把 Zen 当 provider 驱动
（在验收跑通前不宣称已兼容）。ZenX 作为自研桌面应用**推迟**，直到出现
T3 Code / Traycer 这类通用编排工具表达不了的 Zen 特有需求。

## IMZen

IM Channel ↔ Zen App Server 的 gateway。策略已从"fork imcodex"更新为
**复用 + 指向**：

- imcodex 的 `channels` 层（QQ 等 IM 接入、鉴权、收发）依赖方向干净、
  可作为库直接复用——imt3 项目已验证这条边界。
- imcodex 的 backend 本来就说 Codex app-server 协议（`thread/start` /
  `thread/resume`）；Zen 兼容同一协议后，**imzen 的最小形态可能只是
  imcodex 指向 `zen app-server` 的一个 backend 配置**，待 Phase 2 后确认。
- 可靠性策略刻意从简：投递失败直接告知用户，不建 durable 路由/恢复状态机
  ——zen-legacy 结尾连续十个 `fix(imzen)` 加固提交是那条路的墓志铭。

相关项目：**imt3**（IM ↔ T3 编排层，`~/Code/imt3`）与 imzen 平行，
共享 imcodex 通道层，不属于 Zen 仓库。

## Web UI

推迟。将来只是同协议的浏览器客户端；多端、云端 agent 等想象力
留到核心稳定之后。

## 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| 1 | 宪法文档校准 | 文档定稿 |
| 2 | 协议侦察：stub server 记录 `codex --remote` / T3 Code 实际调用 | 确定协议子集与第一客户端，钉住 Codex 版本 |
| 3 | 纯内存最小链路（initialize → thread/start → turn/start → FakeModel → item 事件） | 上下文只从 ItemList 得到；单条代码路径可读懂完整生命周期 |
| 4 | append-only journal（每 Thread 一个 JSONL） | 重启恢复；未完成 Turn 呈现为明确中断 |
| 5 | 第一个 shell tool + item 级审批 | accept / decline / cancel 全链路 |
| 6 | 真实客户端兼容 | 所选客户端完成一轮会话 + 一次工具审批 |
| 7 | 真实模型（API-key provider 先行） | 真模型走通同一链路 |
| 8 | imzen（复用 imcodex 通道层） | IM 消息 → thread → 回复闭环 |
