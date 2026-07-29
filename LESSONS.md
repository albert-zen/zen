# LESSONS

非目标，以及 zen-legacy 踩过的坑。要把其中某项变为目标，先修改本文件
并说明当初的判断错在哪里。

## 非目标

- 持久化协调层：ProjectCoordinator、coordination journal、command ledger、
  durable lease、wait graph、handoff 状态机
- Project 作为运行时对象：cwd 是执行输入，"项目"最多是客户端派生的
  分组视图，不进入 Zen Core
- 第二套 Server / 协议 / 客户端（包括 Zen 自创 wire protocol——对外协议
  只有一个：固定版本的 Codex App Server 兼容子集）
- 把多 agent 委派做成持久化领域模型（委派是模型和 runtime 的运行时能力，
  不是 Zen 的数据模型）
- 把流式 delta 逐条持久化（delta 只用于实时显示，journal 只收完整的 Item）
- 覆盖率门禁、按层重复跑的测试矩阵
- 与 zen-legacy 的数据、协议、接口兼容

## zen-legacy 的教训

- **复杂度来自开发流程，不是产品需求。** 自主 worker/reviewer 流水线会奖励
  "发现边界情况并加固"这类永远看似有价值的工作，最终长出 1,277 行
  ProjectCoordinator、两层 AppServer 和六种并存的持久状态。
- **没收尾的迁移是毒债。** AgentAppServer 包住 legacy AppServer，靠
  `as never` / `as unknown` 拼接两套协议，边界测试还要为 legacy import
  专门开例外。迁移要么收口，要么不开始。
- **过度持久化的状态机会自我繁殖。** 仓库最后的提交是连续十个
  `fix(imzen)`：serialize、freeze、harden、recover——每个 fix 都在修
  上一轮加固引入的边界情况。失败时明确告知用户，比自愈状态机便宜得多。
- **过程档案不是产品文档。** `docs/implementation` 积累了 1 MB、上万行的
  DAG、evidence 和 transcript，记录的是"怎么生产这批代码"，不是"Zen 是
  什么"。Git 历史已经是档案，仓库里只放当前事实。
- **第二套"事实"必然漂移。** ProjectCoordinationItem 与 kernel Item 并存，
  就意味着系统有两条累加事实链。权威状态只能有一条。
