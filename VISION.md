# VISION

## 北极星

Zen 是本地优先的个人 agent 运行框架。它只有两个核心：

1. **Agent Runtime** — 一个 Thread 对应一个 agent 上下文，权威状态是一条 append-only 的 ItemList。一切皆 Item，agent 的运行就是不断追加 Item。
2. **App Server** — 按 thread 路由请求、驱动 Runtime、向订阅者广播事件的统一入口。

CLI、桌面、Web、IM 都是平级的接入端，全部只通过 App Server 协议工作。

## 不变量

这些规则高于任何单次实现决策。违反它们的代码不合入，无论多有用。

1. **会话状态可推导。** Thread 的所有会话语义与 Agent 执行结果，必须由
   append-only ItemList 推导。外部配置（凭证、Provider、workspace）负责提供
   执行环境，可以独立持久化，但不得保存或覆盖 Thread、Turn、Item 的运行状态。
   引入任何不可推导的会话状态前，必须先修改 ARCHITECTURE.md 并说明理由。
2. **配置在外侧。** Zen Core 只拥有 Thread ItemList 及其运行规则。API Key、
   Provider 账户、workspace/project 管理、诊断 telemetry 都在 Zen Core 外部。
   Thread 内只记录一份不含秘密的"生效配置描述"（用了什么 provider/model/
   credential 引用/cwd），用于复现，不用于执行。
3. **一切抽象可解释。** 每个模块、每个概念必须能在 ARCHITECTURE.md 用一句话
   解释清楚。解释不清，说明它不该存在。
4. **简单优先。** 简单、可读、可解释，优先于完整恢复、向后兼容和防御性工程。
   宁可在失败时明确告知用户，也不建自我修复的状态机。
5. **人在环。** 架构稳定之前，不恢复任何自主 issue 流水线；每次变更都经过
   人工对话式 review。

## Non-goals

以下东西在 zen-legacy 里出现过并造成了严重漂移，或在重启讨论中被明确否决。
如果未来某一项真的需要，先修改本文件并说明当初的判断错在哪里。

- 持久化协调层：ProjectCoordinator、coordination journal、command ledger、
  durable lease、wait graph、handoff 状态机
- **Project 作为运行时对象**：cwd 是执行输入，"项目"最多是客户端派生的
  分组视图，不进入 Zen Core
- 第二套 Server / 协议 / 客户端（包括 Zen 自创 wire protocol —— 对外协议
  只有一个：固定版本的 Codex App Server 兼容子集）
- 把多 agent 委派做成持久化领域模型（委派是模型和 runtime 的运行时能力，
  不是 Zen 的数据模型）
- 把流式 delta 逐条持久化（delta 只用于实时显示，journal 只收完整的 Item）
- 覆盖率门禁、按层重复跑的测试矩阵
- 与 zen-legacy 的数据、协议、接口兼容
- 自主 worker/reviewer 开发流水线及其过程档案（DAG、evidence、transcript）

## 判断标准

如果实现让核心概念难以看见，错的是实现。重写实现，而不是给概念打补丁。

一条记录该不该进 ItemList，判据是：**删除它之后，Agent 下一轮得到的上下文、
或用户理解的执行历史会不会改变？** 会，就是 Item；不会，就放外侧。
