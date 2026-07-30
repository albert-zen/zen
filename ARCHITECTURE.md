# ARCHITECTURE

## 核心概念

五个概念，各一句话。新抽象必须先在这里获得自己的一句话。

- **Item** — agent 运行的最小事实单元：Turn 生命周期、用户消息、模型输出、推理、
  工具调用、工具结果与失败，都是 Item。
- **Thread** — 一个 agent 上下文，权威状态是一条 append-only 的 Item list。
- **Turn** — 一次交换：从一条用户输入开始、到 agent 完成响应为止追加的那段连续 Item。
- **AgentRuntime** — 驱动一个 Thread 的循环：从 ItemList 编译上下文 → 调用模型 → 执行工具，把发生的一切追加为 Item。
- **AppServer** — 按 threadId 把请求路由到 Thread、驱动 AgentRuntime、向订阅者广播 item 事件的唯一服务入口。

**Project 不存在于 Zen Core**：Runtime 需要的只是某次执行的环境
（cwd、model、tool policy）。App Server 从协议请求与宿主配置解析这些输入并
转交 Runtime；credential 只由宿主的外部配置解析，不进入协议或 Thread。
Thread 记录实际使用的 cwd；"项目列表"是客户端按 workspace 派生的分组视图，
不是运行时容器。

## 不变量

违反这些规则的代码不合入，无论多有用。

1. **会话状态可推导。** Thread 的所有会话语义与执行结果必须由 append-only
   ItemList 推导。引入不可推导的会话状态前，先修改本文件并说明理由。
2. **配置在外侧。** 凭证、Provider 账户、workspace 配置在 Zen Core 外部，
   可独立持久化，但不得保存或覆盖 Thread、Turn、Item 的运行状态。
3. **一切抽象可解释。** 每个新的领域抽象必须在本文件有一句话解释；
   解释不清，说明它不该存在。
4. **失败明确告知。** 出错时明确告诉用户，不建自我修复的 durable 状态机。

## 状态边界

| 状态类别       | 例子                                                    | 归属                           |
| -------------- | ------------------------------------------------------- | ------------------------------ |
| 会话语义状态   | Turn 生命周期、消息、模型输出、工具调用、工具结果、失败 | Thread ItemList（唯一权威）    |
| 外部运行配置   | API Key、Provider 账户、默认模型、workspace 配置        | Zen Core 外部的配置层          |
| 观测与展示状态 | 流式 delta、延迟指标、debug log、UI 状态                | 临时事件 / telemetry，不持久化 |

一条记录该不该进 ItemList，判据是：**删除它之后，Agent 下一轮得到的上下文、
或用户理解的执行历史会不会改变？** 会，就是 Item；不会，就放外侧。
Thread 内可以保留一份不含秘密的生效配置描述（`provider / model / cwd /
tool_policy`），记录"当时用了什么"；credential 及其引用都不进入 Thread。
宿主也不会把完整进程环境交给 shell tool：工具只继承运行命令所需的最小环境，
Provider credential 即使来自环境变量也会被显式排除。

首版不实现 context compaction。未来若引入，compaction 结果必须作为新的
canonical Item 追加，已有 Item 不改写、不删除。

## Item 的三种形态

写 journal 之前必须分清，否则会重新长出两套状态：

1. **canonical Item** — 进入 ItemList，持久化、可重放。
2. **transient delta** — 仅通过 App Server 实时下发用于流式显示，**不写 journal**；
   Item 完成后一次性追加完整体。
3. **协议事件** — ItemList 状态变化向 wire protocol 的投影，不是独立状态。

Turn 边界对齐 Codex rollout 语义：canonical `turn_started` 开始 Turn，
`turn_completed` / `turn_aborted` 结束 Turn；完成的语义 Item 在二者之间追加。
崩溃重放时，尾部只有 `turn_started` 而没有终止 Item 的 Turn 派生为
interrupted，不追加 synthetic recovery record，也不恢复半截 stream。wire
`turn/started` / `turn/completed` 是这些 canonical lifecycle Item 的协议投影。

审批请求与应答是正在运行的 Turn 和接入端之间的瞬态交互，不写 journal。
最终执行或拒绝的结果由完整的 tool-result Item 表达。

## 在线协议

Zen 对外只有一个 wire protocol：**固定版本的 Codex App Server message
protocol 兼容子集**（Thread / Turn / Item 三原语）。transport 只是同一协议的
承载方式，不是第二套协议。当前兼容基线钉在 **codex-cli 0.146.0**，实现
JSONL stdio 与 loopback WebSocket 两种承载；Unix socket 尚未实现。兼容原版
Codex CLI、T3 Code 是收益，不是核心设计前提。

规则：

- **固定版本**：协议 schema 以 codex-cli 0.146.0 的生成结果为准，不承诺
  "兼容最新"。升级版本是一次显式决策。
- **强制握手**：每个连接先 `initialize` → `initialized`，之后才接受其他方法。
- **WebSocket 访问控制在宿主侧**：loopback listener 拒绝浏览器 `Origin`，可选
  bearer credential 仅用于 transport 握手，不进入 Zen Core、Thread 或 journal。
- **stdio ↔ WebSocket bridge 只是 transport adapter**：它原样转发固定协议消息，
  不创建 runtime、Thread 或任何可持久化状态。
- **子集先由 Zen 生命周期定义**：实现 Zen 自建 CLI 所需的最小生命周期，再用
  stub 记录原版 `codex --remote` 与固定版本 T3 Code 的实际调用，机会性扩展
  兼容面。当前请求子集包括 `account/read`、`skills/list`、`model/list`、
  `thread/start`、`thread/resume`、`thread/read`、`thread/list`、
  `thread/unsubscribe`、`turn/start`、`turn/interrupt`，以及 Thread / Turn /
  Item 事件流和 command item 审批请求。精确清单见
  `src/protocol/codex/README.md`。
- `account/read`、`skills/list` 与 `model/list` 只投影宿主公开能力，不向 Zen Core 或 Thread 写入账户、skill、provider 状态。
- 未实现的方法一律返回 JSON-RPC `-32601`；不返回伪造的成功结果。
- **sandbox 与 approval 分离**：sandbox 限制工具实际上能做什么，approval
  决定何时询问用户。首版只接受明确支持的 sandbox mode，其他 mode 返回
  unsupported；审批不能冒充隔离。MCP 相关方法在未实现时同样明确返回 unsupported。
  当前唯一模式 `danger-full-access` **不是安全隔离**；最小环境与已知 secret
  脱敏只防止意外泄漏，不能阻止已批准的命令主动读取本机可访问的文件。
- **协议边界是目录不是包**：内部保持极小的 `Item` / `Thread` 类型，
  `src/protocol/codex/` 存放固定版本的 wire types 和普通函数映射。协议 churn
  只允许波及这个目录。只有出现"同时支持多个 Codex 版本"或"多个独立消费者"
  时才拆包。
- 在真实客户端跑通验收（一轮会话 + 一次工具审批）之前，不宣称兼容任何客户端。

## Adapter 边界

内核只依赖接口，以下全部是 adapter：

- **持久化** — Thread journal：每个 Thread 一个 JSONL，每行一个 canonical Item；
  启动时扫描 journal 得到 thread 列表，不建数据库索引。
- **ModelAdapter** — 模型调用；当前有 OpenAI-compatible API-key 与
  ChatGPT subscription / Codex Responses 两个 adapter，模型响应只能通过追加
  Item 改变 Thread。
- **SubscriptionAuthProfile** — 宿主持有的 OAuth credential store 与
  request-time token resolver；它位于 Core 外，不进入 ItemList，ModelAdapter
  只拿一次请求所需的 access lease。provider 的 sessionId 只允许作为可丢弃的
  transport cache / affinity hint，不得映射或持久化第二套 Thread。
- **工具** — shell 等工具的实际执行。
- **审批** — 审批请求的呈现与应答（各接入端自行实现 UI）。
- **接入端权限预设** — `Full Access` / `Approval Required` 只是接入端对新
  Thread 的显示与配置预设，分别投影为独立的 sandbox 与 approval policy
  协议字段；它不修改已有 Thread，也不进入 Zen Core。

## 并发

一个 Thread 内最多运行一个 Turn；App Server 只保留当前进程内的执行句柄和
AbortController，不把它们当成会话事实。跨 Thread 直接并发运行，没有
ProjectCoordinator、调度队列或可持久化的 scheduler。进程崩了就崩了：重启后
从 journal 恢复 Thread 内容，未完成的 Turn 派生为中断，由用户重发。

## 目标结构

概念边界先用目录表达，不为了架构图拆 package。Core 与 CLI 暂时共用一个
Node package；IMZen 只因为复用 Python channel 生态而独立。

```text
src/
  item.ts
  thread.ts
  runtime.ts
  app-server.ts
  journal.ts
  model.ts
  model/
    openai-compatible.ts
    openai-subscription.ts
  tool.ts
  protocol/
    codex/         # 0.146.0 wire types + 映射（唯一允许协议 churn 的地方）
apps/
  cli/             # 薄协议客户端；host 在这里组合外部配置、OAuth profile 与 adapters
  imzen/           # 与 CLI/Web/桌面平级的独立接入端
```

这里的 package 只是安装与依赖边界，不是 Zen 领域模型。Core 与 CLI 当前共用
一个 Node package，但代码边界分别是 `src/` 与 `apps/cli/`；IMZen 因复用
Python 的 imcodex channel adapters 而作为独立 Python 应用存在。它们不会由
package 关系长出 Project、Agent 或调度语义。

自建薄 CLI 是首个稳定接入端；原版 `codex --remote` / T3 Code 作为机会型兼容
验收，不反向塑造 Zen Core。
