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

**ZenX 正在开发**，是与 CLI、IMZen 平级的本地桌面接入端。当前已跑通 Electron
host、Thread 列表与恢复、流式 Item、审批、模型切换、soft steer、interrupt 与
Interrupt & send；Provider/onboarding、安全 Markdown、Trigger / Watching / Room，
以及可显式授权的 bundled/local capability registry 已形成可运行 vertical slice。
首批 browser provider 以独立临时 profile/session 暴露跨平台有界 DOM 操作，computer
公共 contract 暴露语义动作、平台能力与 background-safe/foreground-required 影响协商；
当前 macOS provider 以 AX/窗口定向截图和明确提示、可取消的前台输入形成 tracer bullet，
后续 Windows provider 可用 UIA/Windows Graphics Capture/SendInput 接入同一 seam；manifest、权限、
provider 与 skill/prompt 均由 ZenX 持有，不进入 Zen Core 或 Codex 协议。上述外层配置
和调度状态不进入 Zen Core，命中 Trigger 仍只通过 App Server 发起普通 Turn；在真实
桌面验收完成前不夸大为稳定发布。

ZenX Agent 的自控工具同样属于产品层：bundled capability package 经现有 registry
显式授权 workspace/local-device 权限后才向 Agent 暴露；Project 列表只按已配置
workspace 与 Thread 实际 cwd 派生；Thread 的创建、读取、状态与
`start | steer | replace` 发送全部经由 App Server。工具调用和目标 Thread 的结果分别
进入各自权威 ItemList，不另建委派记录、消息队列或 transcript；互相监听
`turn_completed` 后继续发起普通 Turn 是允许的。

固定版本 T3 Code 仍是机会型兼容目标：它可以通过协议直接把 Zen 当 provider
驱动，但不会替代 ZenX 的外层产品能力，也不会反向扩大 Zen Core。

## IMZen

IMZen 和 CLI、桌面、Web 一样，是 App Server 上的一种接入端；它不是单独的
架构层。实现策略是**组合 IM Agent SDK，不在产品内复制 bridge runtime**：

- 固定 commit 的 `im-agent-sdk` 提供 QQ/Telegram/飞书/微信 Channel adapters、
  `ImAgentGateway`、`ZenApplicationAdapter`、App Server client、typed contracts、
  projection/request routing 与 in-memory binding repository。
- IMZen 拥有自己的进程、channel 配置与 credential；不读取其他产品的配置或
  状态，也不要求共用机器人账号。
- IMZen 代码只保留环境配置、SDK channel factory 调用、产品命令/权限预设、
  通用文件到文字 manifest 的映射、错误/审批呈现和 composition root。
- Conversation → Thread binding 使用 SDK 的内存 repository；重启后从下一条消息
  新建 Thread，或由用户 `/threads` + `/pick` 重新选择。SDK SQLite repository
  只持久化 inbound/outbound 幂等等 bridge state，防止重启重新授权已有或结果未知
  的 native message；两者都不是 Zen 会话权威，也不进入 ItemList。
- 切换 Thread 只改变 Gateway binding，不隐式改变任何原生 UI 的 active Thread；
  status/history/catch-up 均从 Zen App Server 的权威投影读取。
- 投递或处理失败通过 SDK 的终态 failure presenter 明确告知用户；不在 IMZen
  新建 durable queue、outbox 或自我修复状态机。

SDK 依赖固定在已合入 `im-agent-sdk` `main` 的完整 ADR 0015 rollout 提交
`57f255fb1f40a095aeabb5a6967380ba057494a3`。IMZen 只配置它实际使用的强类型
I1 inbound content transformer、I2 classified failure presenter 与 request
presenter；其他扩展位置缺席，因此保持 SDK 默认行为。

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
| 8    | 独立 IMZen；组合固定提交的 IM Agent SDK                                   | SDK/本地闭环通过；真实 QQ 需频道凭证 |
| 9    | ZenX 桌面 vertical slice；Provider、Markdown、Trigger / Watching / Room   | 开发中                               |

原版 `codex --remote` 0.146.0 还会调用账户、模型、配置、hooks 等 bootstrap
方法，Zen 当前明确返回 unsupported，因此不宣称兼容原版 TUI。这不阻塞 Zen CLI，
也不会反向扩大 Core。
