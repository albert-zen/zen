# VISION

## 北极星

Zen 是本地优先的个人 agent 运行框架。它只有两个核心：

1. **Agent Runtime** — 一个 Thread 对应一个 agent 上下文，权威状态是一条 append-only 的 ItemList。一切皆 Item，agent 的运行就是不断追加 Item。
2. **App Server** — 按 thread 路由请求、驱动 Runtime、向订阅者广播事件的统一入口。

CLI、桌面、Web、IM 都是平级的接入端，全部只通过 App Server 协议工作。

## 不变量

这些规则高于任何单次实现决策。违反它们的代码不合入，无论多有用。

1. **一切状态可推导。** 所有持久化状态必须能从 Thread 的 ItemList 推导出来。不能推导的状态，必须先在 ARCHITECTURE.md 写明存在理由，才允许出现在代码里。
2. **一切抽象可解释。** 每个模块、每个概念必须能在 ARCHITECTURE.md 用一句话解释清楚。解释不清，说明它不该存在。
3. **简单优先。** 简单、可读、可解释，优先于完整恢复、向后兼容和防御性工程。宁可在失败时明确告知用户，也不建自我修复的状态机。
4. **人在环。** 架构稳定之前，不恢复任何自主 issue 流水线；每次变更都经过人工对话式 review。

## Non-goals

以下东西在 zen-legacy 里出现过并造成了严重漂移，明确列为不做。
如果未来某一项真的需要，先修改本文件并说明当初的判断错在哪里。

- 持久化协调层：ProjectCoordinator、coordination journal、command ledger、
  durable lease、wait graph、handoff 状态机
- 第二套 Server / 协议 / 客户端（任何 "AgentXxxServer 包住旧 XxxServer" 的迁移中间态）
- 把多 agent 委派做成持久化领域模型（委派是模型和 runtime 的运行时能力，不是 Zen 的数据模型）
- 覆盖率门禁、按层重复跑的测试矩阵
- 与 zen-legacy 的数据、协议、接口兼容
- 自主 worker/reviewer 开发流水线及其过程档案（DAG、evidence、transcript）

## 判断标准

如果实现让核心概念难以看见，错的是实现。重写实现，而不是给概念打补丁。
