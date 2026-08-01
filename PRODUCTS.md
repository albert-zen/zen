# PRODUCTS

所有接入端平级，都只通过 App Server 协议工作。任何接入端都不得拥有
自己的 Agent、Thread、Turn 或调度语义。

## 第一客户端

**自建薄 Zen CLI** 是首个稳定接入端，只覆盖启动 / 恢复 Thread、发送消息、
流式显示、审批与模型选择，不拥有 Agent 或调度语义。交互式 `/model` 只调用
App Server 的 Thread 设置操作；可用模型来自 ZAS 投影的宿主 ModelCatalog。

原版 `codex --remote` 与固定版本 T3 Code 是机会型兼容目标：Phase 2 用最小
stub App Server 记录真实调用，在不污染 Zen Core 的前提下扩展协议子集。能接入
是生态收益，不能接入也不阻塞 Zen 自身产品。

## 桌面

近期不自建：目标是固定版本的 T3 Code 通过协议直接把 Zen 当 provider 驱动
（在验收跑通前不宣称已兼容）。ZenX 作为自研桌面应用**推迟**，直到出现
T3 Code / Traycer 这类通用编排工具表达不了的 Zen 特有需求。

## IMZen

IMZen 和 CLI、桌面、Web 一样，是 App Server 上的一种接入端；它不是单独的
架构层。实现策略是**复用通道，不复用 agent backend**：

- imcodex 的 `channels` 层（QQ 等 IM 接入、鉴权、收发）依赖方向干净、
  作为固定 commit 的库直接复用。
- 这种复用只是固定版本的 package 依赖：IMZen 拥有自己的进程、channel
  配置与 credential，不读取运行中 imcodex 的配置或状态，也不要求二者使用
  同一个机器人账号。
- IMZen 自己只保留薄 middleware、IM conversation 到 Zen thread 的内存绑定。
  它仅复用 imcodex package 中通用的 `AppServerClient` 类，由 IMZen 进程直接
  连接 Zen App Server；请求不经过正在运行的 imcodex 服务。它不导入 imcodex
  的 agent、backend、store 或持久化路由语义。
- 可靠性策略刻意从简：投递失败直接告知用户，不建 durable 路由/恢复状态机
  ——zen-legacy 结尾连续十个 `fix(imzen)` 加固提交是那条路的墓志铭。

相关项目：**imt3**（IM ↔ T3 编排层，`~/Code/imt3`）与 imzen 平行，
共享 imcodex 通道层，不属于 Zen 仓库。

### IMAgent SDK 候选边界

IM channel 与后端 agent service 之间确实存在可复用端口，但暂不为了一个实现
立即拆 package。先让 IMZen 内的最小接口被真实使用；出现第二个独立后端后再抽
`IMAgent SDK`：

- channel 侧只产生统一 inbound message、接收 outbound message；
- service 侧提供 create/list/read/resume thread、start/interrupt turn、回应审批
  与事件订阅；
- “切换 Thread”是 gateway 的 conversation → thread 临时绑定，不是后端新增
  一份会话状态；
- status 从 service 的 Thread/Turn 投影读取，不另建状态表。

这样抽取发生在接入端边界，不会把通道、Project 或第二套 Agent 语义带进 Zen
Core。

## Web UI

推迟。将来只是同协议的浏览器客户端；多端、云端 agent 等想象力
留到核心稳定之后。

## 里程碑

| 阶段 | 当前结果                                                                  | 状态                                 |
| ---- | ------------------------------------------------------------------------- | ------------------------------------ |
| 1    | VISION / ARCHITECTURE / LESSONS / PRODUCTS 定义当前产品边界               | 完成                                 |
| 2    | 协议钉在 codex-cli 0.146.0；精确子集记录在 `src/protocol/codex/README.md` | 完成                                 |
| 3    | 内存 ItemList → Runtime → App Server → FakeModel 事件链                   | 完成                                 |
| 4    | 每 Thread 一个 append-only JSONL；stale open Turn 派生为 interrupted      | 完成                                 |
| 5    | shell + command item 瞬态审批；accept / decline / cancel / interrupt      | 完成                                 |
| 6    | 薄 Zen CLI；stdio 与 loopback WebSocket                                   | 完成                                 |
| 7    | OpenAI-compatible 与 ChatGPT subscription adapters；两轮 tool-call        | 实现完成；订阅真实网络闭环已通过     |
| 8    | 独立 IMZen；复用固定版 imcodex channels 与 AppServerClient                | 本地完整闭环通过；真实频道需频道凭证 |

原版 `codex --remote` 0.146.0 还会调用账户、模型、配置、hooks 等 bootstrap
方法，Zen 当前明确返回 unsupported，因此不宣称兼容原版 TUI。这不阻塞 Zen CLI，
也不会反向扩大 Core。
