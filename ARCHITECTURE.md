# ARCHITECTURE

## 核心概念

五个概念，各一句话。新抽象必须先在这里获得自己的一句话。

- **Item** — agent 运行的最小事实单元：用户消息、模型输出、推理、工具调用、工具结果、审批决定，都是 Item。
- **Thread** — 一个 agent 上下文，权威状态是一条 append-only 的 Item list。
- **Turn** — 一次交换：从一条用户输入开始、到 agent 完成响应为止追加的那段连续 Item。
- **AgentRuntime** — 驱动一个 Thread 的循环：从 ItemList 编译上下文 → 调用模型 → 执行工具，把发生的一切追加为 Item。
- **AppServer** — 按 threadId 把请求路由到 Thread、驱动 AgentRuntime、向订阅者广播 item 事件的唯一服务入口。

**Project 不存在于 Zen Core**：Runtime 需要的只是某次执行的环境
（cwd、model、credential 引用、tool policy），由 App Server 作为请求输入
接收并转交。Thread 记录创建时实际使用的 cwd；"项目列表"是客户端按
workspace 派生的分组视图，不是运行时容器。

## 状态边界

| 状态类别 | 例子 | 归属 |
|---|---|---|
| 会话语义状态 | 消息、模型输出、工具调用、审批、工具结果、中断、compaction 结果 | Thread ItemList（唯一权威） |
| 外部运行配置 | API Key、Provider 账户、默认模型、workspace 配置 | Zen Core 外部的配置层 |
| 观测与展示状态 | 流式 delta、延迟指标、debug log、UI 状态 | 临时事件 / telemetry，不持久化 |

判据见 VISION.md：删除该记录会改变 agent 的上下文或用户理解的历史，才是 Item。
Thread 内保留一份不含秘密的生效配置描述（`provider / model / credential_ref /
cwd / tool_policy`），记录"当时用了什么"，不记录秘密本身。

## Item 的三种形态

写 journal 之前必须分清，否则会重新长出两套状态：

1. **canonical Item** — 进入 ItemList，持久化、可重放。
2. **transient delta** — 仅通过 App Server 实时下发用于流式显示，**不写 journal**；
   Item 完成后一次性追加完整体。
3. **协议事件** — ItemList 状态变化向 wire protocol 的投影，不是独立状态。

Turn 的开始留下持久记录；崩溃重放时能识别"开始但未完成的 Turn"，
呈现为明确的 interrupted，不试图恢复半截 stream。

## 在线协议

Zen 对外只有一个 wire protocol：**固定版本的 Codex App Server 协议兼容子集**
（JSON-RPC over stdio，Thread / Turn / Item 三原语）。理由：Codex CLI
（`codex --remote`）、T3 Code 等工具都以它驱动 agent，兼容即接入现有生态。

规则：

- **固定版本**：兼容目标钉在一个具体 Codex 版本上（协议 schema 按安装版本
  生成），不承诺"兼容最新"。升级版本是一次显式决策。
- **强制握手**：每个连接先 `initialize` → `initialized`，之后才接受其他方法。
- **子集由真实客户端定义**：先用最小 stub 记录原版 `codex --remote` 与固定
  版本 T3 Code 实际调用的方法（Phase 2 侦察），再实现那个子集。已知核心：
  `thread/start`、`thread/resume`、`thread/read`、`turn/start`、`turn/interrupt`、
  `thread/*` `turn/*` `item/*` 事件流、item 级审批请求与应答。
- 未实现的方法一律返回 JSON-RPC `-32601`；sandbox 策略是请求上的可选枚举，
  映射到 Zen 的工具审批策略；MCP 相关方法桩掉。
- **协议边界是目录不是包**：内部保持极小的 `Item` / `Thread` 类型，
  `src/protocol/codex/` 存放生成的 wire types 和普通函数映射。协议 churn
  只允许波及这个目录。只有出现"同时支持多个 Codex 版本"或"多个独立消费者"
  时才拆包。
- 在真实客户端跑通验收（一轮会话 + 一次工具审批）之前，不宣称兼容任何客户端。

## Adapter 边界

内核只依赖接口，以下全部是 adapter：

- **持久化** — Thread journal：每个 Thread 一个 JSONL，每行一个 canonical Item；
  启动时扫描 journal 得到 thread 列表，不建数据库索引。
- **ModelGateway** — 模型调用；API-key provider 先行，订阅认证后补
  （参考实现见 SALVAGE.md）。模型响应只能通过追加 Item 改变 Thread。
- **工具** — shell 等工具的实际执行。
- **审批** — 审批请求的呈现与应答（各接入端自行实现 UI）。

## 并发

一个 Thread 内 Turn 串行。跨 Thread 并发用进程内的简单队列 / semaphore，
不持久化任何调度状态。进程崩了就崩了：重启后从 journal 恢复 Thread 内容，
未完成的 Turn 标记为中断，由用户重发。

## 目标结构

第一版单 package，概念用目录表达；出现真实的独立消费者之前不拆包。

```text
src/
  item.ts
  thread.ts
  runtime.ts
  app-server.ts
  journal.ts
  protocol/
    codex/        # 固定版本 wire types + 映射（唯一允许协议 churn 的地方）
```

是否需要自建 CLI，由 Phase 2 协议侦察决定（原版 `codex --remote` 是第一候选）。
