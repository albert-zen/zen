# LESSONS

非目标，以及 zen-legacy 踩过的坑。要把其中某项变为目标，先修改本文件
并说明当初的判断错在哪里。

## 非目标

- 持久化协调层：ProjectCoordinator、coordination journal、command ledger、
  durable lease、wait graph、handoff 状态机
- Project 作为运行时对象：cwd 是执行输入，"项目"最多是客户端派生的
  分组视图，不进入 Zen Core
- 在 shared codec / validation 仍能诚实承载 ZAS native 与 Codex App Server（CAS）
  mapped overlap 时，预建内容相同的两套 schema、endpoint 或客户端；native-only
  additive surface 可以明确排除在 CAS claim 外，分叉应由重叠语义的真实非同形需求触发
- 把多 agent 委派做成持久化领域模型（委派是模型和 runtime 的运行时能力，
  不是 Zen 的数据模型）
- 把流式 delta 逐条持久化（delta 只用于实时显示，journal 只收完整的 Item）
- 为插件发现或能力披露新增 `PluginCatalogSnapshotItem`、`ToolDisclosureItem`
  等 canonical Item（发现继续使用普通 tool call/result，从 ItemList 推导）
- 为每个插件建立 AgentRuntime、Thread、Turn、transcript 或 durable recovery
  state machine（Plugin Runtime 只拥有领域执行）
- 扫描、脱敏、重写模型文本、reasoning、tool call/result、title 等既有 trace；
  provider/plugin 能力变化只影响后续投影与调用结果
- risk scoring、参数级 scope graph、permission rules engine 或复杂 sandbox 产品矩阵；
  工具策略只保留默认 `full_access` 与可选 `ask_unknown`
- 把首版 `run_code` 宣传或实现成可运行 hostile code 的安全沙箱；它与 builtin shell
  权限等同，Worker 的空环境、heap/time/output 限制和 termination 只负责运行 containment
- 把超长 tool output 临时文件变成 durable artifact store 或第二份会话权威；canonical
  结果只是有界 head/tail receipt，需要跨重启保存完整结果时必须另行设计内容寻址 artifact
- 完整 marketplace 平台、registry backend、发布后台、签名 PKI、自定义 package store
  或跨插件 dependency solver。旧的“本阶段不做 Marketplace”判断是为了先闭合
  bundled/local 的 Catalog、Lifecycle、Runtime、UI 与安装入口；这些前置条件已经成立，
  因此现在只把复用同一 installer 的只读 package metadata 目录纳入范围，不扩大为新的分发 authority
- OS daemon、launch agent、云端 Plugin/ZAS service；本阶段 ZenX Host 只在应用进程中
  跨窗口存活，显式 Quit 后停止
- 独立 Skills 平台；本阶段插件以 main document 提供首要模型说明
- 借 Plugin Platform 或 Tool Presentation 顺带进行 Provider、图片、attachment 或
  compaction 重构
- 工具失败后的自动重试、fallback、自愈或 durable recovery 状态机；工具局部失败只
  结算一次 canonical failed result 并让模型决定下一步
- 把 `apply_patch` 包装成 durable filesystem transaction、workspace confinement 或第二套
  文件权限系统；它与 shell 使用同一 Host 权限边界，预检保证内容错误时零修改，I/O 失败
  则明确报告可能已经提交的前缀
- 覆盖率门禁、按层重复跑的测试矩阵
- 与 zen-legacy 的数据、协议、接口兼容

## 已解除的非目标

- **ZAS 自有协议（2026-09-03）**。原判断禁止 Zen 自创 wire protocol，是为了避免
  第二个 AppServer / Thread authority 与未收口的半迁移；错误在于把这项约束等同于
  让外部 CAS schema 定义 Zen 的产品语义。现在由 ZAS 拥有原生协议和演进权，CAS
  只映射可表达且已验收的调用面；第二 authority 和无真实非同形需求就复制 codec
  仍是非目标。
- **同一 Turn 的有界并行工具执行（2026-09-02）**。最初把它整体列为非目标，是为了
  在只有 builtin shell、Tool Environment 与 Plugin Platform 尚未闭合时避免提前引入
  调度器。现在混合 Tool Environment、插件发现和 canonical tool call/result 生命周期
  已经形成可运行纵向切片，programmatic tool calling 又需要在一次模型决策内组合多个
  独立调用，原判断的阶段性前提已不存在。目标只包括有并发上限、默认 fail-closed、
  可重建的执行重叠；无界并发、隐式重试/fallback、自愈和第二套 durable scheduler
  仍是非目标。

## 工程判断的教训

- **运行 containment 不能冒充产品安全需求。** `run_code` 与 shell 权限等同时，fresh
  Worker、资源上限和终止只解决失控执行；没有 hostile-code 隔离或逐操作企业审计需求时，
  不应为了更强威胁模型改用受限 VM、封死文件/网络，或强迫所有机器操作再经过一层工具审批。
- **阶段性实施顺序不能固化为长期非目标。** 在调用面尚未闭合时暂缓并发是合理顺序，
  但出现一次模型决策组合多个独立工具的真实需求后，应重审原前提，只保留有界、可取消、
  可从 canonical Items 重建等长期约束，不能继续用旧阶段限制产品能力。
- **Presentation 只决定模型看到的入口，不能删除可用的 fallback。** `direct`、`code` 与
  `both` 投影同一个 Tool Environment；为了概念纯度隐藏 shell/direct 会扩大单点失败并损害
  用户体验，初始化失败应按所选模式明确失败或回退，而不是偷偷撤掉底层 runtime。
- **局部确认超时不能升级成全局停机。** plugin reload ACK 超时只代表 child 当前展示的
  generation 待确认；exact generation token 已能保证调用不串代时，应暂存两代并通过迟到 ACK
  或当前值查询收敛，只串行化后续 replacement，不能停止仍健康的 Host 和正在进行的会话。
- **局部替换不能默认扩大故障域。** 单个插件的安装、启停、更新或开发 reload 应只撤销并
  替换目标 bundle/runtime；只有共享 IPC 或 Host 本身失效时才恢复 Host，不能用整进程重启
  代替精确生命周期设计。
- **Retirement 不能同步等待调用者自己持有的释放条件。** replacement 先拒绝旧 generation
  的新 admission，再让已准备/执行 lease 自然释放并异步关闭；在发起 replacement 的请求仍
  持有该 generation 时同步等待 drain，会形成循环等待而不是更强一致性。
- **Compatibility adapter 不是产品权威。** Codex schema 只定义固定 CAS adapter 的
  shape，真实客户端调用只提供逐客户端、逐版本、逐调用面的互操作证据；ZAS 自己定义
  canonical Thread/Turn 生命周期、Host policy、产品读模型和原生 surface。不得为了匹配
  CAS 缺失字段反向修改 Core，也不得把局部兼容失败描述成 Zen 产品失败。

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
