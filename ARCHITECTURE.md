# ARCHITECTURE

## 核心概念

五个概念，各一句话。新抽象必须先在这里获得自己的一句话。

- **Item** — agent 运行的最小事实单元：Turn 生命周期、用户消息、模型输出、推理、
  工具调用、工具结果与失败，都是 Item。
- **Thread** — 一个 agent 上下文，权威状态是一条 append-only 的 Item list。
- **Turn** — 一次交换：从一条用户输入开始、到 agent 完成响应为止追加的那段连续 Item。
- **AgentRuntime** — 驱动一个 Thread 的循环：从 ItemList 编译上下文 → 调用模型 → 执行工具，把发生的一切追加为 Item。
- **AppServer** — 按 threadId 把请求路由到 Thread、驱动 AgentRuntime、向订阅者广播 item 事件的唯一服务入口。
- **SoftSteerDeliveryAnchor** — 当前执行在每次模型采样前设置的临时 response id；
  steer 的 canonical `user_message.deliveryAfter` 持久化这个排序锚点，使下一次
  采样能从 ItemList 重建正确上下文，而不形成第二份 mailbox 或会话状态。
- **TurnReplacementIntent** — canonical `turn_replacement_requested` Item 记录一次
  fenced Interrupt & send 的旧/新 Turn id、输入与幂等 key，使显式客户端重试能
  从 abort/start 崩溃间隙继续，而不依赖隐藏 command queue 或恢复表。
- **ComposerSubmission** — 接入端一次待确认的用户提交；只在 UI 内保留草稿、
  发送意图和稳定 `clientUserMessageId`，是否已进入会话仍完全由 App Server 的
  canonical Item 投影决定。
- **ThreadMetadataStore** — ZAS 按 threadId 持久化名称与归档状态等产品元数据的
  append-only 外部索引；归档只影响标准 `thread/list.archived` 产品筛选与生命周期通知，
  它由 App Server 投影但不进入 Agent 上下文或
  canonical ItemList。损坏或暂时不可读的产品元数据不得阻断 Thread 的创建、
  读取或列表；ZAS 降级为无展示名称并明确记录 warning，而 metadata 写入失败
  仍须返回错误。
- **UnavailableThreadSnapshot** — ZAS 在列举 Thread 时对无法重放的 canonical
  journal 生成的只读故障投影；它只暴露 threadId、可用的产品名称和
  `systemError`，不伪造或跳过权威会话历史。
- **ModelCatalog** — 宿主公开的可选模型与默认模型目录；App Server 只投影和
  校验它，credential 与 Provider 连接仍由宿主外部配置持有。目录必须有且仅有
  一个可见默认模型；`hidden` 只表示不在客户端选择器展示，已知模型 id 仍可由
  既有 Thread 或显式请求使用。
- **IMZenController** — IMZen 通过 IM Agent SDK typed actions，以及 SDK 明确保留
  的 App Server native Thread profile seam，组合 `/model`、`/permission` 与审批
  快捷命令的产品 UX；`/model` 是当前 typed contracts 外的 Zen native operation，
  Controller 仍不拥有 Thread、Turn、binding 或调度语义。
- **ImZenContentTransformer** — 在 SDK I1 强类型位置把已暂存的通用文件投影为
  Zen 可读 manifest，并保留图片的 typed content；它不改变消息身份、binding、
  continuation 或 correlation。
- **ImZenFailurePresenter** — 把 SDK 已分类并固定路由的终态入站失败渲染成
  IM 用户可见消息；它不决定重试，也不保存恢复状态。
- **IMZen App Server shared filesystem root** — 部署者对本地 App Server 可读目录的
  显式证明；SDK 仍负责把每个 local-image 路径限制在该目录内，未配置时 TCP
  App Server 不接收本地图片路径。
- **IMZen Gateway state file** — SDK SQLite repository 持久化 inbound/outbound
  幂等 claim 等可重建 bridge state，使 `side_effect_started` 在进程重启后仍不被
  重新授权；它不是 Zen Thread、transcript、queue 或 Agent state。
- **ZenXHostProfile** — ZenX 主进程持久化的 Provider、ModelCatalog、workspace 与
  审批默认值；它只用于组合本机 App Server host，不包含 credential，也不覆盖已存
  Thread 的生效设置。
- **ZenXCredentialVault** — ZenX 通过操作系统安全存储保护的 Provider credential
  存放点；解密后的 secret 只在主进程内存中交给 host，绝不进入 renderer、进程环境、
  App Server 协议或 canonical ItemList。
- **ZenXSystemProxyProjection** — ZenX 主进程把操作系统为当前 Provider endpoint
  解析出的代理投影为 host 子进程的 Provider transport；它是可丢弃的外部连接配置，不进入
  Zen Core、Thread、journal 或 credential store。
- **ProviderTransport** — 宿主为 Provider HTTP 请求注入的显式连接策略；首版只接受
  无 credential 的 HTTP(S) proxy URL，并保证 abort 与脱敏错误，不进入 Agent Runtime 状态。
- **ZenXTriggerRegistry** — ZenX 外层产品持久化的可审计唤醒条件与命中历史；每次
  命中只以稳定幂等 key 通过 App Server 发起普通新 Turn，失败明确记录且不自动补偿。
- **ZenXRoom** — ZenX 外层产品持有的共享协作转录与 Thread 路由表面；Room 本身不是
  Agent 上下文，只有明确命中 membership / mention 时才把带来源的内容投递给成员 Thread。
- **ZenXWakeupProjection** — ZenX 把 Trigger 命中的 `clientUserMessageId` 与外部审计记录
  关联成系统级唤醒卡片，并把有界、带明确来源的 completed Turn / Room 上下文作为
  新 Turn 输入投影；它不是第二份权威 transcript，canonical `user_message` 仍是唯一输入事实。
- **ZenXTriggerAppServerPort** — ZenX Trigger 服务观察 completed Item/Turn 并发起普通
  `turn/start` 所需的最小 host-local App Server 边界；它不引入另一套 Runtime、队列或重试器。
- **ZenXExternalLinkPolicy** — ZenX renderer 与 Electron 主进程共同执行的外链 allowlist；
  只有 `http:`、`https:`、`mailto:` 可交给操作系统，页内锚点留在 renderer 处理。
- **ZenXCapabilityRegistry** — ZenX 主进程注册 bundled/local capability package 的 manifest、
  显式权限与 provider，把已授权的结构化工具和 skill/prompt 资源组合进本机 host；执行历史仍只由
  canonical tool call/result 投影，credential、浏览器会话和默认屏幕内容不进入 journal。
- **ZenXCapabilityInteractionMode** — ZenX 把工具声明为不改变全局输入/焦点的 `background_safe`
  、必须接管前台的 `foreground_required` 或在独立桌面执行的 `isolated`，让产品提示、调度和 host policy
  协商实际影响且禁止静默降级。
- **ZenXCapabilityObservation** — ZenX provider 用短时、目标域绑定的 opaque ID 连接 observe→act，执行前按语义指纹
  重验且在导航、关闭、新观察或动作后失效；它是产品侧瞬时状态，不进入 Zen Core 或 durable journal。
- **ZenXUserBrowserAttachmentEpoch** — ZenX user-browser provider 用实际 CDP sessionId、target、逻辑 session owner 与
  attach attempt/incarnation 关联一次瞬时 attachment ownership，并在移除任何映射前把无法证明闭合的生命周期证据
  单调提升为有界 session taint；target 只在发布点原子授予一个逻辑 session/incarnation，且每次操作与清理都重验该
  owner；它不进入 Zen Core、durable journal，也绝不取得关闭用户 target 或 profile 的权限。
- **ZenXUserBrowserDocumentExecutionFence** — ZenX user-browser provider 把 target、精确 attachment epoch/session、逻辑
  session owner/incarnation、main-frame loader/url/revision、isolated execution context 与 provider revision 绑定为一次
  瞬时且 fail-closed 的 acquire→dispatch fence，先把 Page/Runtime domain enable 作为精确 attachment setup barrier，
  再在每个 awaited setup 步骤后及发送 page code 前按有序 CDP 事件流原子重验；它不进入 Zen Core 或 durable journal，
  且 mutation 已发送后的失效继续使用 outcome-unknown/taint 与 lease 语义。
- **ZenXWinAppCliComputerProvider** — ZenX Windows 产品层把 Microsoft WinApp CLI 的 HWND/UIA/WGC JSON
  投影为既有的有界 opaque observation 与 background-safe computer tools；外部 CLI 的安装、版本和进程生命周期
  不进入 Zen Core，缺失或协议错误只显式诊断且绝不降级成全局输入注入。
- **ZenXCapabilityProviderCatalog** — ZenX 产品层探测并诊断可选的成熟外部执行后端，按显式优先级选择
  Playwright、Peekaboo、WinApp 或适用平台的 bundled fallback；版本、权限与可用性只属于 host 配置和瞬时诊断，不进入 Zen Core。
- **ZenXSelfControlCapabilityPackage** — ZenX 产品层通过 capability registry 暴露 Project/Thread 自控工具，
  只从 workspace 与 canonical Thread 投影派生结果，并经进程内可替换的 typed App Server request port 执行操作，
  不持有第二套 Project、Thread、Turn、transcript 或调度状态。
- **ZenXThreadTitleProjection** — ZenX 外层产品按 threadId 持久化 provisional、generating、
  generated、manual 与 failed 标题生命周期及单调版本；它不进入 canonical ItemList，
  每次异步生成完成都用版本比较避免覆盖手动改名或重启后的新状态。
- **ZenXTitleInference** — ZenX 主进程使用独立配置的标题模型执行一次不写 journal、
  不创建 Turn 的辅助推理；credential 仍只在主进程内存中按当前 Provider 解析。
- **ZenXThreadTitleCoordinator** — ZenX 主进程从首条有意义的来源标注输入立即建立
  provisional 投影，并异步协调生成、显式重试与 authoritative manual rename；同一 durable
  projection 在一个进程内只能有一个 root ownership domain，coordinator、store 与 native mirror
  queue 都复用该 domain，不创建第二套 runtime 或 coordinator。
- **ZenXThreadTitleFailureClosure** — 标题 ownership 模块用一个 total、不会抛出的有界 normalizer
  在任意 retirement、abort、hook、scheduler、observation、tracked-work、store stage/write/rename/replace、
  cleanup 或 compensation 失败被丢弃前复制其证据，并同步 poison 精确 ownership domain；复制后的
  `Error` message 最多 160 字符且不保留 cause、proxy、getter 或对象图，按 transaction/occurrence 稳定排序，
  64 条后以一条确定性 saturation evidence 收口，normalization 自身失败也只生成同样有界的 fallback evidence。
- **ZenXThreadTitleOwnershipRoot** — 每个标题 ownership domain 的瞬时 root closure 在任何 nested
  transaction 可能拒绝前同步登记其 retirement outcome，并通过模块自有、逐 listener 捕获异常的 safe abort
  notification boundary 通知，而不依赖原生 `AbortSignal` 对 throwing listener 的 process-level 行为；hook、
  scheduler、abort、child、cleanup、observation、normalization 与 listener fault 都 fence 该 root，`stop`、
  successor claim 与 fresh read fail closed，且 poison 只留在该 domain。root 最多登记 128 个 descendant、
  129 个含 root 的 outcome、64 条 evidence、64 个 hook、64 个 failure listener、64 个 safe abort listener 与
  128 个 tracked operation；store domain 最多持有 128 个 transient failure listener，coordinator 最多持有 64 个
  transient change listener，超限或 listener fault 都有界且 fail closed。parent retirement 已结束后出现的合法 child
  仍加入同一 closure，250ms deadline 只结束等待，所有迟到 promise 仍保留 rejection observer，不引入 durable
  retry、scheduler 或 queue。
- **ZenXThreadTitleProjectionIdentity** — 默认文件 backend 以“最近存在祖先的 native realpath + 尚不存在的规范化
  suffix”形成 process-local projection key，Windows 上按不区分大小写的 pathname 语义折叠，因此 relative、
  absolute、symlink/canonical 与尚不存在文件的 case aliases 共享 identity；注入 backend 必须提供显式稳定
  identity，domain key 是 backend identity 与 projection key 的二元组。每个 backend registry 最多 64 个
  stable domain entry，容量用尽时明确失败；registry 以 identity 为弱键、不会持久化或成为第二个协调层。
- **ZenXThreadTitleOwnershipStore** — ownership-aware store 在共享 domain 内同步 claim owner、串行 read/stage/
  atomic replace/compensation/cleanup，并在任何 store boundary failure 上先以同一 failure closure 规范化、再同步
  poison domain 与当前 initialized coordinator/root 及 canonical aliases；future/in-flight claim/read/commit、
  snapshot、transaction 创建、native authority、stop/restart/fresh coordinator 都 fail closed，post-replace
  compensation failure 也不能把旧 durable projection 暴露给 successor，custom store 必须显式提供稳定
  `ownershipDomain`。
- **ZenXThreadTitleNativeMirrorQueue** — generated/manual 标题才进入与 ownership domain 完全同 identity 的瞬时镜像
  queue；每个 native notification 都是 authoritative，迟到 retired resolve/reject 只合并修复当前 successor，
  active/queued/quarantined/reservation/diagnostic 状态合计硬限 64 且 exactly-once release，domain poison 后不再取得
  authority 或派发额外 mirror。
- **ZenXThreadTitleLifecycle** — `stop`、`close`、`restart` 与 quit 在 250ms owner retirement 边界内尝试全部 cleanup，
  但任一 poison 都必须被报告；`restart` 只有在新 owner 完成 claim、恢复写入、native authority 激活并再次确认
  domain/root 健康后才可成功，不能返回一个其 `snapshot` 已不可用的 coordinator。
- **ZenXThreadTitleNotificationObserver** — ZenX 主进程在 App Server canonical
  `userMessage` 完成通知处幂等补观察跨客户端首条输入，失败只记录 warning 且不影响 Turn。
- **ZenXTriggerLifecycleGeneration** — Trigger 服务把定时器、瞬态完成证据、唤醒 admission
  与取消句柄绑定到一次可退休的进程内代数；迟到异步结果只能观察其创建代数，不能修改新代数或
  重新占用已释放的唤醒名额。
- **ZenXTriggerProgramRunner** — ZenX 外层以一次性、有界的本地子进程执行 Trigger predicate/action，
  通过稳定 invocation id、显式 stdin/stdout JSON、cwd/env、超时和取消把结果归约为 Trigger 历史中的
  明确 outcome；它不是 sandbox、队列、重试器或第二个 Runtime。
- **ZenXAutomationControlCapability** — ZenX capability registry 中由独立 read/write 权限保护的 Trigger
  与 Room 工具集合；工具只调用现有 Trigger/Room store 和 App Server port，不拥有 Agent、Thread、Turn
  或 transcript 语义。

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
初始配置由 `thread_metadata` 记录；Turn 之间的配置变化由
`thread_configuration_changed` canonical Item 追加记录。当前生效配置由初始
metadata 与后续配置 Item 依次归约；每个 Turn 使用其 `turn_started` 之前最后
一份生效配置。活跃 Turn 期间不得修改配置。
宿主也不会把完整进程环境交给 shell tool：工具只继承运行命令所需的最小环境，
Provider credential 即使来自环境变量也会被显式排除。

Thread 的用户展示名称、置顶与归档等产品状态不改变 Agent 下一轮上下文，因此
不进入 canonical ItemList。ZAS 可以知道、持久化并通过 App Server 同步这些
状态；客户端当前选中的 Thread 仍是每个客户端或 conversation binding 的状态，
ZAS 不保存全局 `currentThreadId`。

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
canonical `user_message` 可携带接入端提供的可选 `clientId`，仅用于跨接入端关联
同一条用户消息，并投影为 wire `userMessage.clientId`。active Turn 接受的 soft
steer 仍是普通 canonical `user_message`；若它在一次模型响应或其工具执行期间
到达，`deliveryAfter` 记录该模型响应的稳定 id。journal 顺序继续表达事实发生
顺序，模型采样投影则把 steer 放在该响应及其 tool results 之后。执行中的当前
anchor 仅是可丢弃 checkpoint；会改变重放或上下文的排序事实已经进入 Item。
崩溃重放时，尾部只有 `turn_started` 而没有终止 Item 的 Turn 派生为
interrupted，不追加 synthetic recovery record，也不恢复半截 stream。wire
`turn/started` / `turn/completed` 是这些 canonical lifecycle Item 的协议投影。
Hard steer 在任何副作用前先追加 `turn_replacement_requested`，再以普通
`turn_aborted` 结束旧 Turn，并以普通 `turn_started` + `user_message` 开始保留 id
的后继 Turn。replacement intent 不进入模型上下文；后继用户消息落盘后它即由
ItemList 推导为 resolved。进程不会自动继续未完成 intent，只有携带同一
`clientUserMessageId` 的显式 `turn/replace` 重试可以继续 abort/start 间隙；若
后继 `turn_started` 已落盘而初始用户消息未落盘，则明确报告 incomplete，不恢复
半截执行。

审批请求与应答是正在运行的 Turn 和接入端之间的瞬态交互，不写 journal。
最终执行或拒绝的结果由完整的 tool-result Item 表达。

## 在线协议

Zen 对外只有一个 wire protocol：**固定版本的 Codex App Server message
protocol 兼容子集**（Thread / Turn / Item 三原语）。transport 只是同一协议的
承载方式，不是第二套协议。当前兼容基线钉在 **codex-cli 0.146.0**，实现
JSONL stdio 与 loopback WebSocket 两种承载；Unix socket 尚未实现。兼容原版
Codex CLI、T3 Code 是收益，不是核心设计前提。

Zen 只在 Codex 0.146.0 没有等价原子语义时增加一项明确命名的协议扩展：
`turn/replace`。它不是 Codex compatibility claim，也不得复用或改变标准
`turn/steer`；客户端必须显式调用并处理 unsupported。

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
  `thread/unsubscribe`、`turn/start`、`turn/steer`、`turn/interrupt`，以及 Thread / Turn /
  Item 事件流和 command item 审批请求。精确清单见
  `src/protocol/codex/README.md`。
- `account/read`、`skills/list` 与 `model/list` 只投影宿主公开能力，不向 Zen Core 或 Thread 写入账户、skill、provider 状态。
- `thread/settings/update` 修改后续 Turn 使用的配置；`turn/start` 携带的模型
  override 复用同一内部更新路径。成功变更必须先追加
  `thread_configuration_changed`，再广播 `thread/settings/updated`。
- `turn/replace` 是 fenced Hard steer：成功响应前，旧 Turn 的 `turn_aborted`、
  新 Turn 的 `turn_started` 与初始 `user_message` 均已 durable；普通客户端不得
  用两个独立请求模拟其原子用户意图。
- ZAS 是 Thread 生效配置的唯一权威。所有接入端通过
  `thread/settings/updated` 与 `thread/resume` 返回值镜像同一份配置；恢复
  Thread 时不得用客户端缓存覆盖 ZAS，只有用户明确选择新模型时才提交配置
  变更。同值更新是空操作，即使 Turn 正在运行也不得阻断跨端恢复。
- Codex 协议投影不把 `thread_configuration_changed` 伪装成 Codex Thread Item；
  它只通过当前 `threadSettings` 与 settings 通知暴露结果，不承诺展示历史切换点。
  canonical ItemList 仍保留完整切换点和各 Turn 的生效模型，供 Zen 原生客户端
  重放。
- `thread/name/set` 修改 ZAS 的 ThreadMetadataStore 并广播
  `thread/name/updated`；名称不是 Agent Item。`thread/list`、`thread/read` 与
  `thread/resume` 返回当前名称。
- Codex 标准 `thread/archive` / `thread/unarchive` 修改同一 ThreadMetadataStore
  并广播对应生命周期通知；`thread/list` 默认只返回未归档 Thread，只有
  `archived: true` 才返回已归档 Thread，而 `thread/read` / `thread/resume` 始终可读。
- `thread/list` 必须隔离单个损坏 journal，并使用 Codex 标准
  `status: systemError` 显式返回该 threadId；`thread/read` / `thread/resume`
  仍明确失败，且不得用默认配置伪造可恢复的 Thread snapshot。
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
AbortController，以及可从 active Turn Item 重建的 SoftSteerDeliveryAnchor，
不把它们当成会话事实。Thread 的 runtime append、steer、interrupt 与终态提交
经过同一个 mutation boundary 线性化，禁止 canonical 用户消息落到 terminal
Item 之后。跨 Thread 直接并发运行，没有
ProjectCoordinator、调度队列或可持久化的 scheduler。进程崩了就崩了：重启后
从 journal 恢复 Thread 内容，未完成的 Turn 派生为中断，由用户重发。

## 目标结构

概念边界先用目录表达，不为了架构图拆 package。Core 与 CLI 暂时共用一个
Node package；IMZen 只因为复用 Python IM Agent SDK 生态而独立。

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
Python IM Agent SDK 的 Channel、Gateway、Application adapter 与 bridge state
ports 而作为独立 Python 应用存在。IMZen 只保留产品配置、命令/呈现与 composition
root；这些 package 关系不会长出 Project、第二套 Agent 或调度语义。

自建薄 CLI 是首个稳定接入端；原版 `codex --remote` / T3 Code 作为机会型兼容
验收，不反向塑造 Zen Core。
