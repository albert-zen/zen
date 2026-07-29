# PRODUCTS

所有接入端平级，都只通过 App Server 协议工作。任何接入端都不得拥有
自己的 Agent、Thread、Turn 或调度语义。

## CLI（第一个客户端）

Codex CLI 式的交互终端：极简 REPL，创建 thread、发消息、看流式输出、
应答审批。它是刻意的"协议减肥器"——CLI 用不到的协议面，都值得怀疑
是否真的需要。自建薄客户端，不 fork Codex CLI（十几万行 Rust，
要替换的恰恰是它的心脏而非边缘）。

## 桌面

近期不自建：T3 Code（MIT 开源）通过 codex-compat 协议直接把 Zen 当
provider 驱动，桌面端免费获得。ZenX 作为自研桌面应用**推迟**，直到
出现 T3 Code / Traycer 这类通用编排工具表达不了的 Zen 特有需求。

## IMZen

IM Channel ↔ App Server 的 gateway。fork 自 imcodex（自己的项目，
无上游跟踪负担）：保留 IM 通道传输层，重写 agent 绑定层为 App Server
客户端。可靠性策略刻意从简：投递失败直接告知用户，**不建 durable
路由/恢复状态机**——zen-legacy 结尾连续十个 `fix(imzen)` 加固提交
就是那条路的墓志铭。

## Web UI

推迟。将来只是同协议的浏览器客户端；多端、云端 agent 等想象力
留到核心稳定之后。

## 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| 2 | kernel + AppServer 最小子集 + CLI | FakeModel 对话跑通，链路一条文件路径可读 |
| 3 | 真模型 + codex-compat 补齐 | 未修改的 T3 Code 驱动 Zen 完成对话 + 命令审批 |
| 4 | imzen（fork imcodex） | QQ 消息 → thread → 回复闭环 |
| 5 | Web / ZenX / 并发策略 | 按真实痛点再定 |
