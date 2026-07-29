# ARCHITECTURE

## 核心概念

五个概念，各一句话。新抽象必须先在这里获得自己的一句话。

- **Item** — agent 运行的最小事实单元：用户消息、模型输出、推理、工具调用、工具结果、审批决定，都是 Item。
- **Thread** — 一个 agent 上下文，权威状态是一条 append-only 的 Item list。
- **Turn** — 一次交换：从一条用户输入开始、到 agent 完成响应为止追加的那段连续 Item。
- **AgentRuntime** — 驱动一个 Thread 的循环：从 ItemList 编译上下文 → 调用模型 → 执行工具，把发生的一切追加为 Item。
- **AppServer** — 按 threadId 把请求路由到 Thread、驱动 AgentRuntime、向订阅者广播 item 事件的唯一服务入口。

**Project** 不是一层：它只是 Thread 的 namespace 加共享配置（workspace root、provider、默认策略）。

## 在线协议

核心原语的 wire 协议对齐 Codex app-server 协议（JSON-RPC over stdio，
Thread / Turn / Item 三原语），理由：T3 Code 等编排工具已把它当作驱动
agent 的通用语，兼容即免费获得桌面端。

第一版只实现 T3 Code 实际调用的子集：

- 请求：`thread/start`、`thread/resume`、`thread/read`、`turn/start`、`turn/interrupt`
- 事件：`thread/started`、`turn/started`、`item/started`、`item/*/delta`、
  `item/completed`、`turn/completed`、`thread/tokenUsage/updated`
- 审批：server→client 请求（`item/commandExecution/requestApproval`、
  `item/fileChange/requestApproval`），客户端应答 decision。审批挂在 Item 上，
  与 ItemList 模型天然一致，作为原生设计采用。

规则：

- 未实现的方法一律返回 JSON-RPC `-32601`。sandbox 策略是请求上的可选枚举，
  映射到自己的工具审批策略即可；MCP 相关方法桩掉。
- 协议兼容收在独立的 `codex-compat` transport 包里。上游协议是 experimental、
  会随 Codex 版本变化——churn 只允许波及这一个包，内核接口是 Zen 自己的
  TypeScript 接口。
- 验收标准是"未修改的 T3 Code 能驱动 Zen"，不是追协议文档全集。

## Adapter 边界

内核只依赖接口，以下全部是 adapter：

- **持久化** — Thread journal，JSONL 追加文件，唯一的持久化记录。
- **ModelGateway** — 模型调用；API-key provider 先行，订阅认证后补（参考实现见 SALVAGE.md）。
- **工具** — shell 等工具的实际执行。
- **审批** — 审批请求的呈现与应答（各接入端自行实现 UI）。

## 并发

一个 Thread 内 Turn 串行。跨 Thread 并发用进程内的简单队列 / semaphore，
不持久化任何调度状态。进程崩了就崩了：重启后从 journal 恢复 Thread 内容，
正在跑的 Turn 视为中断，由用户重发。

## 目标结构

```text
packages/
  kernel/         # Item、ItemList、AgentRuntime、工具接口
  app-server/     # AppServer：路由、订阅、执行队列
  codex-compat/   # Codex app-server 协议 transport（唯一允许 churn 的地方）
  adapters/       # journal、model gateway、shell 工具
apps/
  cli/            # 薄 REPL 客户端
  imzen/          # IM gateway（fork 自 imcodex，见 PRODUCTS.md）
```
