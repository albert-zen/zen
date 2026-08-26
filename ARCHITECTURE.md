# ARCHITECTURE

## 核心概念

五个概念，各一句话。新抽象必须先在这里获得自己的一句话。

- **Item** — agent 运行的最小事实单元：Turn 生命周期、用户消息、模型输出、推理、
  工具调用、工具结果与失败，都是 Item。
- **Thread** — 一个 agent 上下文，权威状态是一条 append-only 的 Item list。
- **Turn** — 一次交换：从一条用户输入开始、到 agent 完成响应为止追加的那段连续 Item。
- **AgentRuntime** — Zen 拥有的 provider-neutral agent loop：从 ItemList 编译上下文 → 调用模型 → 通过 Tool Environment 执行工具，并把 canonical `tool_call` / `tool_result` 在内的一切事实追加为 Item。
- **AppServer** — 按 threadId 把请求路由到 Thread、驱动 AgentRuntime、向订阅者广播 item 事件的唯一服务入口。
- **Tool Environment** — AgentRuntime 面向的混合工具执行环境，统一解析、投影、Host policy、取消、路由与结果回写，但不要求 Zen 自己实现每个工具的领域行为。
- **Tool Policy Store** — Host 按稳定 tool name 持有 `ask_unknown` 的 approved/denied 决定并通过可持久化 port 注入 Tool Environment，不进入 Thread 或 canonical ItemList。
- **Builtin Tool Provider** — Zen 内建并直接执行的工具 provider，例如 `shell`，其执行仍经同一个 Tool Environment 和 canonical call/result 生命周期。
- **Plugin Tool Provider** — Tool Environment 把 namespaced plugin tool 调用路由到 Plugin Runtime 的 provider，领域执行由插件拥有，Zen 只负责 admission、路由和结果回写。
- **External Tool Provider** — Tool Environment 把调用路由到 Zen/ZenX 之外服务的 provider，外部服务拥有领域执行，Zen 仍保留 Host policy 与 canonical settlement。
- **ZenX Host** — 独立于窗口生命周期的桌面宿主进程所有权边界，同时组合 Plugin Host 与 ZAS/AppServer 两项并列服务；关闭窗口不停止 Host，只有显式 Quit 才停止它。
- **Plugin Host** — ZenX Host 中负责插件 catalog、生命周期、UI/工具注册、Host policy 与 Runtime 路由的服务；它与 ZAS/AppServer 并列，不拥有 Agent、Thread、Turn 或 transcript。
- **Plugin Catalog** — Plugin Host 对已发布 package/profile 状态的唯一 durable 权威与提交点；每个原子 snapshot 记录 profile generation identity、直接 package 安装事实和独立 enablement，并让第一方与第三方 package 使用同一合同。
- **Plugin Runtime** — 实际执行插件领域行为的运行边界，可以是 bundled module、child process、本地服务或远程服务，失败由调用明确返回且不建立自动修复状态机。
- **Plugin Runtime ABI** — bundled module、child process 与 HTTP service 共享的 provider-neutral invocation/result、取消与 close 合同；它只传递稳定 package identity、namespaced tool、参数和一次调用上下文，不拥有 Agent 或会话语义。
- **Plugin Runtime Supervisor** — ZenX Host 持有的瞬时 runtime/provider registry，启动或附着 enabled runtime、向 Tool Environment 原子发布其 tool ownership，并在 disable/uninstall/quit 时先撤销新 admission、再等待已执行调用并关闭 runtime。
- **Plugin Runtime Adapter** — 把 trusted module 调用、bounded JSONL child process 或有界 HTTP request/continuation 映射到同一 Plugin Runtime ABI；transport 失败显式返回且不重试或重启。
- **ZenX Plugin Host SDK v1** — Plugin Host 按 package identity 注入的 provider-neutral 公共合同，以 `query / actions / ui / storage` 四组能力让 bundled 与隔离 runtime 使用相同产品语义，而不取得 ZenX 内部 store authority。
- **ZenX Plugin Developer Kit** — 仓库内公开的 `@zenx/plugin-sdk` package 提供与 Host SDK v1、Plugin Runtime/UI 和 manifest v2 一致的类型、runtime schema、无会话 authority 的内存 fixture Host，以及只负责 `create` / `validate` / 标准 npm `pack` 的薄开发者 CLI。
- **ZenX Plugin Storage** — Plugin Host 在 plugin id namespace 下原子持久化一个有界版本化 JSON document，按 package 提供的逐版本 migration 串行前移，disable/uninstall 不删除数据且失败不发布半状态。
- **ZenX Plugin AppServer Port** — Host SDK 唯一允许修改 Thread 的显式 `actions.threads.startTurn` 边界；它调用既有 AppServer 并返回该 authority 产生的 canonical Item 投影，不复制 Turn 或 transcript。
- **Plugin Package** — 一个普通 npm package，其 `package.json#zenx.plugin` 定位 `zenx.plugin.json`，由该 manifest 声明 main document、tools、UI contributions 与数据 namespace，生命周期只有 `installed`、`enabled`、`uninstalled`。
- **Plugin Package Source** — Catalog 为直接 dependency 记录 npm、commit-pinned Git、tarball、稳定本地复制或显式开发 `link:` 来源，实际解析继续使用 pnpm package spec。
- **Plugin Profile** — ZenX userData 下由普通 `package.json`、`pnpm-lock.yaml`、`node_modules` 和 Catalog 中独立 enablement 组成的 package 环境，只有 profile 的直接 dependencies 可成为插件。
- **Plugin Profile Generation** — 一次 package mutation 在唯一 identity 的新目录中生成的不可变 profile 内容；Catalog 尚未引用它时只是可丢弃 staging，引用它时才成为已发布 generation。
- **Plugin Dev Control** — 仅在显式开发模式启用的 Host-owned 鉴权 loopback 入口，把公开 CLI 的有界 `dev` 请求收敛到目标 ZenX 实例已有的可取消 `dev-link` profile transaction，并在提交后只替换该插件的运行时与 App Server 投影。
- **ZenX Bundled pnpm** — ZenX 从 App Resources 直接调用的固定版本 pnpm CLI，负责标准依赖解析、SemVer、lockfile、integrity、更新和删除，不依赖用户 PATH 上的 pnpm。
- **Plugin Package Trust** — 安装即信任 package 代码，但 dependency build scripts 只由 bundled pnpm 按 profile 显式 `allowBuilds` 执行，不引入风险引擎或参数级权限矩阵。
- **First-party Plugin Tarball** — Browser、Computer、ZenX self-control、Triggers 与 Rooms 的标准 npm tarball，随 App Resources 分发并通过同一个 profile installer 首装或重装。
- **Plugin Marketplace Inventory** — ZenX 唯一的插件浏览与管理读模型，把 Host-owned 内置库存、只读外部 package metadata 和 Catalog 中已安装 package 合并去重，所有动作仍委托同一个 profile lifecycle authority。
- **Plugin Discovery Projection** — 常驻 `zenx_plugin` 工具用普通 `discover` / `read` 调用选择后续模型可见插件能力；选择事实只由既有 tool call/result 推导，不新增 catalog/disclosure Item。
- **Generic UI Host** — ZenX 为插件提供 sidebar、pages/subroutes、settings、panel、commands/menu 与 result renderer 的受控宿主 surface，不允许插件直接接管核心 DOM、router 或 Agent 页面语义。
- **Plugin UI SDK** — 第一方 bundled 插件和隔离运行的第三方插件共享的逻辑 UI contribution API；信任和进程隔离不同，不产生两套产品语义。
- **Tool Result Renderer** — 按 namespaced content type 渲染既有 `ToolResultItem` 可选 structured content 的插件 UI contribution；renderer 缺失时必须回退 text/JSON，且不得改写历史 Item。
- **ZenX ZAS Endpoint** — ZenX Host 拥有的稳定、带认证、可供其他应用连接的固定 Codex App Server endpoint；它不创建第二个 AppServer authority，也不要求 OS daemon。
- **AttachmentStore** — ZAS 管理的不可变、SHA-256 内容寻址 payload store；
  canonical Item 只保存 provider-neutral `AttachmentRef`，Store 与 ItemList 合起来才足以重放输入，
  它不保存消息、Turn、引用关系或任何第二份会话状态。
- **ContextCompactionItem** — Zen 在完整 Turn 边界生成并追加的 provider-neutral
  context summary；它记录覆盖边界、稳定有序的保留 Item、冻结的 Provider selection、
  版本化算法与 token usage，使后续模型上下文和重启投影都只由 append-only ItemList 推导。
- **NativeThreadSummaryProjection** — ZAS 把 canonical journal 与
  ThreadMetadataStore 归约为可持久化、可删除重建的原生 `ThreadSummary` /
  `CurrentMetadata` 列表读取模型；它只加速产品读取，不成为新的权威状态。
- **CodexThreadSummaryAdapter** — `src/protocol/codex/` 在固定协议边界把 ZAS
  原生 summary 映射为兼容的 Codex Thread DTO，不反向定义 Zen 产品模型。
- **ZenXThreadSummaryAdapter** — ZenX Electron main 通过既有 host-local 进程边界查询
  ZAS 原生 summary，并以 typed IPC 暴露给产品层，不拥有 Thread 语义或新增 wire method。
- **ZenXImageAttachmentProjection** — ZenX Electron main 通过既有 host-local 边界从 canonical
  `user_message` 投影按 Item 顺序排列的 `AttachmentRef`，并以只接受这些引用的 typed preload IPC
  导入和读取 Attachment Store payload；renderer 只持有草稿引用与短时 object URL，不取得任意文件读取权。
- **ZenXProjectProjection** — ZenX main 的同一个实例把 host-profile workspace 与 ZAS
  原生 Thread cwd 按最近存在祖先的异步 realpath 归一为 UI 和 Agent self-control 共用的
  Project 读模型；Windows 路径折叠大小写，POSIX 路径保留大小写，配置保留用户选择的展示路径，
  realpath 不可用时退回 lexical absolute path，配置刷新按 latest-wins 发布且不长期缓存 filesystem identity，
  每次投影、筛选、创建或 workspace mutation 从一份不可变的 canonicalization snapshot 派生，mutation
  在既有队列内有界重验；最近使用项由同一 host profile 持有且失效时不隐式回退，
  它不拥有 Project、Thread、journal 或 durable coordination 状态。
- **ZenXDirectoryBrowser** — ZenX main 把 home、documents、Windows drive / POSIX root 与
  canonical 只读目录枚举投影给内部 picker；symlink/junction 只解析为目录目标，不修改文件系统。
- **ZenXApplicationMenuPolicy** — ZenX 在 Windows/Linux 移除 Electron 默认菜单，在 macOS
  只保留系统合规的应用、编辑与窗口命令，不由菜单引入第二套产品导航。
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
- **ModelCatalog** — 宿主按 Provider profile 公开的结构化模型目录；每项 capability
  以 `null` 保留 Unknown、以空集合表达已知不支持，App Server 只投影和校验它，
  credential 与 Provider 连接仍由宿主外部配置持有。目录必须有且仅有一个可见
  默认模型；`hidden` 只表示不在客户端选择器展示，已知模型 id 仍可由既有 Thread
  或显式请求使用。
- **ModelCatalogPreset** — 宿主版本化维护的内建 catalog 数据层，只记录仓库已确认的
  Provider/model metadata，并由手工配置覆盖、由 discovery 仅补充未知 capability 的 id。
- **ProviderRegistry** — 宿主以稳定 `providerProfileId` 把每个注入的 ModelAdapter
  与其 ModelCatalog 绑定；canonical selection 是
  `providerProfileId / modelId / reasoningEffort` 的原子三元组，Thread 只记录生效选择而不持有 profile 或 credential；
  输入省略 effort 时，目标支持当前 effort 就保留，否则使用目标 model 的默认 effort。
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
- **ZenXHostProfile** — ZenX 主进程用 v3 配置以稳定 `providerProfileId` 持久化多个 Provider
  连接及各自的结构化 ModelCatalog，并把默认/标题模型保存为
  `providerProfileId / modelId` 引用；workspace、审批默认值与本地产品偏好仍在同一
  host-owned 配置中，credential 不在其中，配置变更也不覆盖已存 Thread 的生效设置。
- **ZenXModelDiscovery** — ZenX 主进程用所选 OpenAI-compatible profile 的 endpoint、
  credential 与 transport 发起一次无持久状态的 `GET /models`，采信响应中可明确解析的
  modality metadata，并按完整 model id 用内建核验目录补全未知能力；匹配不到仍保持 Unknown，
  失败明确返回且不修改已配置条目。
- **ZenXImageCapabilityProbe** — 用户明确触发一次经目标 OpenAI-compatible profile 真实 adapter
  的极小图片请求；成功或明确图片类型拒绝写回既有 Host ModelCatalog，认证、额度、限流、网络及
  模糊失败保持 inconclusive，不进入 Thread、journal 或后台调度。
- **ZenXKnownProviderPreset** — ZenX 主进程版本化维护已确认的 OpenAI-compatible
  Provider 稳定 identity、显示名与正式 base URL，renderer 只消费这份连接数据创建
  host-owned profile，五家 Provider 继续复用同一个 adapter 与 discovery 边界。
- **ZenXAppearancePreference** — ZenX renderer 在本机 app profile 保存 System / Light / Dark
  偏好，并在首屏前把系统解析结果投影为同一套组件消费的语义色彩 token；它不进入 Core、
  Thread、Project、host restart 或 canonical ItemList。
- **ZenXThreadPinProjection** — ZenXHostProfile 按本机 threadId 顺序持久化 Sidebar Pin，
  renderer 只把仍存在的 active Thread 投影到独立 Pinned section；Pin 不同步、不进入
  canonical ItemList，也不改变 Runtime、调度或 Inbox 优先级。
- **ZenXSidebarOrderPreference** — ZenXHostProfile 按 canonical Project key 与 owning
  Project 分区的 threadId preference list 持久化本机 Sidebar 顺序；未知项按稳定投影追加、
  移除项忽略，且排序不改变 cwd、Project identity、Thread state 或 canonical ItemList。
- **ZenXCredentialVault** — ZenX 通过操作系统安全存储按 `providerProfileId` 保存
  Provider credential；每个 profile 的加密 secret 可独立读取、替换和清除，Host profile、
  renderer settings、进程环境与 App Server 协议配置字段都不主动序列化解密值。Provider、
  模型或工具返回的内容属于 trace，即使字节与 credential 相同也不扫描或改写，并可按正常
  Runtime 规则进入 canonical ItemList。
- **ZenXSystemProxyProjection** — ZenX 主进程把操作系统为当前 Provider endpoint
  解析出的代理投影为 host 子进程的 Provider transport；它是可丢弃的外部连接配置，不进入
  Zen Core、Thread、journal 或 credential store。
- **ProviderTransport** — 宿主为 Provider HTTP 请求注入的显式连接策略；首版只接受
  无 credential 的 HTTP(S) proxy URL，并保证 abort 与脱敏错误，不进入 Agent Runtime 状态。
- **ZenXTriggerRegistry** — `zenx-triggers` Plugin Package 在自身 storage namespace 持久化的可审计
  唤醒条件与命中历史；每次命中只以稳定幂等 key 通过 App Server 发起普通新 Turn，失败明确记录且不自动补偿。
- **ZenXRoom** — `zenx-rooms` Plugin Package 在自身 storage namespace 持有的共享协作转录与 Thread 路由表面；Room 本身不是
  Agent 上下文，只有明确命中 membership / mention 时才把带来源的内容投递给成员 Thread。
- **ZenXWakeupProjection** — ZenX 把 Trigger 命中的 `clientUserMessageId` 与外部审计记录
  关联成系统级唤醒卡片，并把有界、带明确来源的 completed Turn / Room 上下文作为
  新 Turn 输入投影；它不是第二份权威 transcript，canonical `user_message` 仍是唯一输入事实。
- **ZenXTriggerAppServerPort** — ZenX Trigger 服务观察 completed Item/Turn 并发起普通
  `turn/start` 所需的最小 host-local App Server 边界；它不引入另一套 Runtime、队列或重试器。
- **ZenXExternalLinkPolicy** — ZenX renderer 与 Electron 主进程共同执行的外链 allowlist；
  只有 `http:`、`https:`、`mailto:` 可交给操作系统，页内锚点留在 renderer 处理。
- **ZenXPluginCatalog** — ZenX 主进程从 profile 的直接 dependencies 注册 v2 package，原子管理
  lifecycle、runtime、结构化工具与完整 UI contribution snapshot；所有非 `shell` 能力只走这一路径。
- **ZenXPluginContribution** — Plugin Catalog 从 enabled package 原子投影受控 sidebar、page/subroute、
  settings、panel、command/menu 与 versioned bundle/surface；它不授予插件 DOM/router 权限。
- **ZenXPluginCatalogState** — Catalog 在同一原子配置文档中持久化 package descriptor、
  enablement、uninstall 与 profile generation；历史文件位置只为一次性 adoption 保留，不参与 runtime admission。
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
- **ZenXBrowserScreenshotArtifactStore** — ZenX provider 为一次最新 Browser observation 写入有界、短时、可清理的 PNG
  artifact，并把 observation identity 与 artifact metadata 一起投影；文件是外部瞬时观测，不进入 Zen Core 或 durable journal。
- **ZenXCapabilityTransientReset** — ZenX 主进程在 App Server/settings restart、provider replacement 或 close 时
  单调使 provider-owned artifacts 失效并重建可重建 backend；它不改写 canonical ItemList、Catalog lifecycle
  或 durable plugin data，也不成为第二个 runtime/coordinator。
- **ZenXBundledProviderProvisioning** — 打包 provider 只能由应用资源中的版本与 SHA-256 固定清单解析，实际执行的 browser payload 以有界目录摘要在选择与启动前重验，仅排除清单明确列出的非可执行 host-validation 状态；缺失、离线或校验失败只产生可诊断的 unavailable 状态，不改写 Core 会话语义。
- **ZenXPlaywrightSessionFence** — Playwright provider 在一个瞬时 CLI session 内串行执行操作，并用稳定 tab/document identity 与 lifecycle revision 围住选择、观察、截图、摘要和关闭；该 fence 不进入 Core 或 durable journal。
- **ZenXProviderLaunchVerification** — 外部 provider 在实际 spawn 前再次验证绑定的 canonical executable、browser payload、shim companion、manifest digest 与 pinned semantic version；失败只产生显式诊断，不自动改用未验证资产。
- **ZenXPackagedProviderSmoke** — ZenX 构建验证用真实 resources/providers manifest、asset hash、version pin 与 bundled-only catalog path 检查离线 packaged provisioning；它是一次性测试流程，不是运行时 coordinator 或 durable state。
- **VerifiedArtifactAcquisition** — ZenX release assembly 只以 artifact name、URL、SHA-256、deadline 与 cache location 取得 digest-addressed immutable file，并在内部以 per-digest 跨进程 transaction 收口 proxy-aware bounded transport、stream size、partial cleanup、no-follow cache revalidation 与 atomic publication；它不成为运行时下载器或第二条 packaging pipeline。
- **ZenXPackagingRunStaging** — portable app 与 packaged smoke 继续复用同一 provider assembly、digest injection 与 Electron packager，但每次只在私有 run directory 内写 build/resources/app/artifact，以 target lock 拒绝同目标并发并在完整 staging 后发布稳定产物；它不复制 release pipeline。
- **ZenXSelfControlCapabilityPackage** — ZenX 产品层通过 profile-managed Plugin Runtime 暴露 Project/Thread 自控工具，
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
  通过稳定 invocation id、显式 stdin/stdout JSON、cwd/env、超时、取消与平台化进程树终止把结果归约为
  Trigger 历史中的明确 outcome；它不是 sandbox、队列、重试器或第二个 Runtime。
- **ZenXTransientProcessContainment** — ZenX 本地程序 runner 以 OS-specific process identity、
  bounded termination 与反复 quiescence 证明约束瞬时子进程树；它不进入 durable state、scheduler 或 retry system，
  无法证明 containment 时只产生明确失败。
- **ZenXBundledAutomationPluginService** — 两个 bundled Plugin Package 共享仅承载 Room mention、reply route
  与 Trigger wakeup 真实交叉约束的第一方 domain service；Catalog runtime admission 分别控制各 package，
  Trigger/Room durable document 分居各自 namespace，只有显式唤醒继续调用既有 App Server port。
- **ZenXTriggerRoomRetention** — Trigger/Room plugin data 在 domain mutation 中执行显式数量、字段与
  UTF-8 字节上限；保留全部非 terminal wakeup，并只保留 bounded terminal audit 与 Room 消息，同时保留
  admission-failure audit，确保 65th admission-failure 事实不会被同一 mutation 淘汰。

**Project 不存在于 Zen Core**：Runtime 需要的只是某次执行的环境
（cwd、model、tool policy）。App Server 从协议请求与宿主配置解析这些输入并
转交 Runtime；credential 只由宿主的外部配置解析，不进入协议或 Thread。
Thread 记录实际使用的 cwd；"项目列表"是客户端按 workspace 派生的分组视图，
不是运行时容器。

## Plugin Platform 与 Tool Environment 目标合同

本节描述完整目标架构，不把局部实现声称为完整平台。当前 Core 已有 provider-neutral
`AgentRuntime` 的普通 tool loop，以及组合 builtin / plugin / external identity、动态 definitions、
prepare、Host policy、取消与执行的 Tool Environment；builtin `shell` 与可注入 provider 走同一边界。
Plugin Package v2、Catalog 和 installed/enabled/uninstalled 基础生命周期已经落在现有
capability runtime seam 上；Plugin Runtime Supervisor 通过同一 Catalog mutation seam 为 bundled
module、bounded JSONL child process 与 HTTP service 提供统一 ABI。install/enable 先在未发布状态
启动并验证 runtime，Catalog 持久化与内存提交后才把 enabled plugin 作为独立 provider 注入 Tool
Environment；任一步失败都会撤销该临时 runtime/provider。disable/uninstall 先撤销新调用，再等待
已 prepare/执行的调用结算和 close，持久化失败则恢复原 enabled provider；人类产品侧可经 Supervisor
直接调用而不创建 Turn。ZenX 的实际桌面 composition root 由主进程 `CapabilityService` 持有 Catalog、
Registry、Plugin Runtime Supervisor 与动态 Tool Environment；child-host 继续通过既有私有 bridge 接收
当前 capability snapshot，把 shell、仍需兼容的 external capability 与常驻 `zenx_plugin` 组合进唯一
AgentRuntime。provider-aware definition projection 在每次采样从完整 canonical ItemList 的成功普通
`read` call/result 对归约披露集合，并与当前 snapshot / Tool Environment 求交集；已披露的 ordinary
plugin 调用通过 bridge 回到主进程，由 Supervisor 的稳定 plugin provider lease 执行。
Plugin Runtime 由 Host 注入同一个 versioned Host SDK v1：bundled module
直接接收公共对象，JSONL process 使用双向 request/result，HTTP service 使用有界 continuation
request/result；三者只看 SDK operation，不取得 Project、storage 或 AppServer 的内部实现。SDK 的 Project
查询消费既有 ZenXProjectProjection，普通领域读写与 UI command 不创建 Turn，只有显式
`actions.threads.startTurn` 调用既有 AppServer port。每个 plugin namespace 的 JSON storage 使用
1..1000 的版本 metadata、1 MiB 文档上限、串行 mutation 与同目录临时文件 rename；package/runtime
提供的 `n -> n+1` migration 按顺序只在需要时运行，migration 或写入失败保留此前 durable/in-memory
state，且不建立恢复状态机。Generic UI Host 已按同一 v1 逻辑 SDK 装载 registry-backed trusted
bundled surface 或无 `allow-same-origin` 的 sandboxed iframe；两者只获得 theme/context、opaque handle、
navigation 与经 Host SDK UI port 校验的 command dispatch。disable/uninstall 直接撤销 Catalog projection，
已挂载 surface/listener 随 React lifecycle 清理。Settings 经 typed main/preload IPC 选择可信本地 v2 manifest，
并复用同一 Catalog transaction 完成 install/update/enable/disable/uninstall/reinstall/delete-data；更新暂存的新
runtime 与 Host SDK migration 在 catalog commit 失败时回滚到原 package/storage，不持久化恢复状态。既有
`ToolResultItem` 可附带成对出现的 namespaced `contentType` 与 1 MiB 内 JSON-compatible
`structuredContent`；Tool Environment 在 append 前校验 JSON、大小和 plugin namespace，并冻结副本，不改变
原有 text output、exit code 或模型上下文。v2 manifest 可按 plugin-owned content type 注册 result renderer；
Transcript 从当前 enabled snapshot 选择 trusted/isolated surface，缺失、disabled、uninstalled 或不兼容时
稳定显示 JSON 与原文本 fallback，重启只重放原 Item。ZenX Host 已把现有唯一 ZAS 通过私有、带认证的 loopback
connection descriptor 发布，并让该 authority 独立于窗口生命周期存活。

### 工具执行与发现

- AgentRuntime 始终拥有模型采样、provider-neutral tool loop，以及 canonical
  `tool_call` / `tool_result` 的编译和记录；Plugin Runtime 不能拥有自己的 AgentRuntime。
- Tool Environment 同时组合 Builtin、Plugin 与 External Tool Providers。Zen 解析
  stable tool name、执行 Host policy、路由与回写；插件或外部服务可以拥有实际领域执行。
- 模型初始只看到 builtin tools 与一个稳定入口 `zenx_plugin`。`discover` 只返回
  plugin id、name、short description、status；`read` 返回 main document 与 tool index。
  读取后，从后续模型采样开始披露该插件普通、namespaced structured tool schemas。
- `discover`、`read` 与后续插件调用全部使用既有普通 `tool_call` / `tool_result`。
  不新增 `PluginCatalogSnapshotItem`、`ToolDisclosureItem` 或任何其他 canonical Item；
  重放时从 ItemList 中已有调用与结果派生后续投影。
- 只有参数合法、`exitCode = 0`、结果 envelope 与请求 plugin id 一致的普通 `read`
  call/result 对才形成披露事实；`discover`、失败、malformed 或不匹配结果不披露。披露事实对
  Thread 持续存在，但 disabled、uninstalled 或当前 provider 缺失的插件不进入后续 schema 投影，
  重新可用时可由同一历史事实再次投影，历史 Item 不变。
- Plugin Package v2 为发现提供的最小 metadata 是稳定 `id`、非空 `name` / short
  `description` / `mainDocument`，以及普通 namespaced tool 的 `name` / `description` /
  `inputSchema`；这是所有非 builtin 工具的唯一 manifest 与 discovery 合同。
- 插件 main document 是首要模型说明；独立 Skills 平台暂缓，现有固定协议
  `skills/list` 不因此获得新的会话语义。
- 同一模型响应产生的多个工具调用当前仍按顺序执行；同一 Turn 的真正并行执行
  是后续效率优化，不属于本阶段。

### 历史、结果与能力变化

- 已写入的模型文本、reasoning、tool calls/results、title 与其他 trace 必须逐字保持。
  Zen/ZenX 不扫描、改写或按 credential 字节脱敏历史 trace；能力变化只影响后续
  模型投影或后续调用结果。
- structured result content 作为既有 `ToolResultItem` 的可选字段进入同一
  canonical Item，不新增 result Item 类型。Plugin result renderer 只决定展示；
  renderer 不可用、插件 disabled/uninstalled 或版本变化时，历史仍以 text/JSON
  fallback 可读，原始 trace 不变。

### 权限与 Host policy

- 目标工具策略只有两档：默认 `full_access` 直接执行；可选 `ask_unknown` 由 Host
  按稳定 tool name 维护 `approvedTools` / `deniedTools`。未知工具只询问一次，允许后
  加入 approved，拒绝后加入 denied。
- 安装一个 package 就表示信任其运行代码；dependency build scripts 仍只按 profile
  显式 pnpm `allowBuilds` 执行，未列入者保持 blocked，这一 package-manager policy
  不扩展成风险评分或新的权限语义。
- 不引入 risk scoring、参数级 scope graph、权限矩阵、rules engine 或复杂 sandbox
  产品框架；package 安装信任与 Host 的 `full_access` / `ask_unknown` 是现有的完整控制边界。

### 插件生命周期、UI 与 ZAS

Package 分发与 profile transaction 遵守以下边界：

- 开发者 package 以公开 `@zenx/plugin-sdk` 的类型、runtime schema 与 fixture Host 为唯一仓库外入口；fixture Host 只在内存提供 query/UI/storage 行为，`startTurn` 明确拒绝而不复制 Agent、Thread 或 Turn authority。
- `zenx-plugin create` 生成普通 npm process package，`dev` 在本机鉴权目标实例中消费唯一 `dev-link` transaction 并只 reload 目标插件，`validate` 从 `package.json#zenx.plugin` 校验当前 v2 manifest、稳定 identity、runtime/tool/UI 关系与包内 runtime 路径；`pack` 必须先通过同一验证再调用标准 `npm pack`，不定义 archive、registry、发布或依赖求解语义。
- Installer 只从 profile `package.json` 的直接 dependencies 建立 Catalog descriptor；即使传递依赖也带有 `zenx.plugin` metadata，它仍只是普通库，不进入 discovery、lifecycle、runtime 或 UI projection。
- npm spec、commit-pinned Git 来源和 tarball 原样交给 bundled pnpm 并由 lockfile 固定解析结果；稳定本地安装先把所选目录复制进 staging，使之后的源目录修改不改变已发布 generation，`link:` 只由显式 `dev` 流程创建并保留其开发期实时链接语义。
- Package dependency 变化在串行 mutation 中创建新 generation，并只在其中调用 bundled pnpm；enablement 作为 Catalog 中独立于 `node_modules` 的状态，可在同一串行 Catalog transaction 中复用当前 generation identity。
- 新 generation 的 pnpm mutation、`allowBuilds` 约束的 dependency scripts、直接 package metadata、manifest、除 Catalog snapshot replace 自身外的所有文件/进程 I/O、runtime 启动与校验，以及 UI 构造与校验都必须在 durable commit 前成功，并形成可直接发布的未公开对象；此前任何失败只撤销未 admission 的 runtime/UI 并保留旧状态。
- 原子 Catalog snapshot replace 提交 generation identity 后，只执行 non-fallible 的已准备对象与 admission 内存交换，不再做 I/O、校验、进程启动或其他可拒绝工作；交换完成前旧 runtime 继续承接已 admission 调用，交换后新调用只见新 snapshot。
- Catalog snapshot replace 是唯一 durable commit point：失败或中断发生在它之前时，旧 snapshot、generation 和 runtime 继续有效；发生在它之后时，新 snapshot 已是权威，重启只装载其 generation，不从 staging、`node_modules` 或运行中对象猜测状态。
- 显式 `dev` request 在全部 staging、identity、runtime 与 UI 检查期间可取消；紧邻唯一 Catalog replace 前的同步 commit fence 先检查 cancellation，再清除该 request 的 Host transaction timer 并禁止 disconnect/Host shutdown 中断。进入 fence 后 Host shutdown 等待 save 与既有 non-fallible publish 完成；save 拒绝仍返回失败且旧 Catalog 有效，不做补偿性 Catalog rollback。
- 未被 Catalog snapshot 引用的 generation 都是可丢弃 staging；启动时和 mutation 结束后可在没有 live runtime lease 时尽力清理，清理失败最多留下磁盘垃圾，不能发布 package、改变 enablement 或触发 durable recovery。
- 五个第一方 package 也产出普通 tarball 并随 App Resources 分发；首装、卸载后的重装和第三方 package 共用同一 installer、Catalog、lifecycle、runtime、UI 与 discovery 路径，`shell` 仍是 Agent Runtime builtin。
- Rooms 是首个完成迁移的第一方 package：App Resources 中的固定 `@zenx/rooms-plugin` tarball 经普通 profile transaction 首装，Catalog 以 bundled source、package name 与 generation 保存唯一 admission；重启只从该 generation 加载。已有的 pre-profile bundled Rooms descriptor 只能由同一 Host-owned transaction 在 package identity 完全匹配时一次性收编，保留 enablement/uninstall 与数据状态且不写第二个 migration authority。只有这项 Host-owned allowlist 可给 installed runtime/trusted UI 注入既有 automation service，外部 package 不能靠 manifest 自行取得 bundled/trusted admission。
- Browser、Computer、ZenX self-control 与 Triggers 同样由普通 `@zenx/*` tarball 经该 profile transaction 装载；provider selector 先选择既有精确 manifest，再选择 App Resources 中同一 package identity 的固定离线变体。Browser mode 或 Computer provider 改变时，Host 只允许 exact bundled identity/source 进行同版本变体替换，并把 candidate backend、runtime 和 generation 一起 staging，仍以新 generation 的单次 Catalog save 提交；重启时若当前 Browser selector 与 Catalog 变体不同，Catalog 的精确 backend 先独占恢复旧 generation，当前 selector backend 只作为未发布 candidate，因此两个 generation 不共享可关闭的 backend。提交前旧 runtime/backend 继续服务，失败只丢弃 candidate，提交后的 ownership swap 不再执行可失败工作，旧 backend 仅异步退役。外部/local package 不能使用该入口。`zenx-self-control` 为保留既有 canonical `zenx_projects_*` / `zenx_threads_*` 名称，在 SDK package-shape validation 使用固定完整名称集合，而 Host runtime 只对 bundled exact identity/source admission；近似名称和 external/local 同 ID 仍按通用 namespace 拒绝。
- Marketplace 是唯一的插件浏览与管理 surface：Host 永久投影五个内置条目，再与只读外部 metadata 目录及 Catalog 中已安装的非目录 package 合并去重；Installed 只是筛选。内置首次安装/重装从 App Resources 选择 Host-owned fixed tarball，Browser/Computer 使用当前 provider selector 的精确变体，随后仍进入同一 profile transaction；provider 不可用时条目保留并显示原因，不注册虚假 capability。外部目录失败或为空不隐藏本地库存，Marketplace 不保存 package 内容、不成为安装 authority，也不引入 registry backend、发布后台、审核工作流、自定义 store/solver 或签名 PKI。

- Plugin Package 生命周期只有 `installed`、`enabled`、`uninstalled`。Bundled plugin
  也可以卸载并在以后重装；卸载撤销 runtime/UI/tool 注册但默认保留 plugin data，
  “删除数据”是独立显式动作。
- Plugin Runtime 可为 bundled module、child process、本地服务或远程服务，并拥有
  实际领域执行。Plugin Host 负责解析、admission、路由、取消与显式失败，不做
  durable 自动恢复。
- Generic UI Host 支持 sidebar、pages/subroutes、settings、panel、commands/menu 与
  result renderers。第一方和第三方使用同一逻辑 Plugin UI SDK；第三方在隔离边界运行。
- 人类直接操作插件 UI 不创建 Turn。只有插件提供的显式 **Run Agent** 动作才通过
  AppServer 发起普通 Turn；插件的查询、存储与领域 mutation 不得绕出 Plugin Host
  或复制 Thread/Turn authority。
- Plugin Host 与 ZAS/AppServer 是 ZenX Host 下的并列服务。ZAS 继续由 ZenX Host
  拥有并暴露稳定、带认证的可连接 endpoint；关闭所有窗口不停止 Host，显式 Quit
  才停止。当前阶段不实现 OS daemon、launch agent 或云端 service。
- 本阶段只建设上述统一 Marketplace inventory 与只读外部 metadata 目录，不建设 registry backend、发布后台、签名 PKI、
  自定义 package store/dependency solver，也不顺带重构 Provider、图片、attachment 或 compaction。

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

图片 payload 是 canonical Item 所引用的不可变数据，而不是可独立解释的会话状态：
本地路径或 wire data URI 只在 ZAS 导入边界存在；导入先校验受支持的图片 MIME、格式、
字节数与像素尺寸，再以 SHA-256 寻址并通过同目录临时文件原子发布。canonical
`user_message` 只保存 typed text part 与 `AttachmentRef`（hash、MIME、字节数、宽高），
不得保存 base64、临时路径或原始本地路径。Provider adapter 每次请求时从 Store
读取并校验引用，再转换为目标 API 的图片 part；因此重启只依赖同一 journal 与
Attachment Store，不依赖 adapter cache。

首版只支持 PNG、JPEG、GIF 与 WebP 图片，单个 payload 上限 20 MiB，宽高各不超过
16,384 像素且总像素不超过 40,000,000；不建立任意文件平台。备份与 Thread 导出必须
包含 journal 中可达的全部附件 blob 和 refs；只复制 journal 不是完整备份。删除 Thread
不自动删除 blob，同内容跨 Thread 去重。未来 GC 只能是显式操作：从选定的完整
canonical journals 扫描 `AttachmentRef` 计算可达集合，先完成约定的备份/导出边界，
再删除不可达 blob；首版不实现自动 GC。

一条记录该不该进 ItemList，判据是：**删除它之后，Agent 下一轮得到的上下文、
或用户理解的执行历史会不会改变？** 会，就是 Item；不会，就放外侧。
Thread 内可以保留一份不含秘密的生效配置描述（`providerProfileId / modelId /
`reasoningEffort / cwd / tool_policy`），记录"当时用了什么"；credential 及其引用都不进入 Thread。
初始配置由 `thread_metadata`记录；Turn 之间的配置变化由`thread_configuration_changed`canonical Item 追加记录。当前生效配置由初始
metadata 与后续配置 Item 依次归约。provider、model 与 effort 作为一个 selection
原子变更；每个新 Turn 在 admission 时冻结 selection，并由`turn_started`记录，
执行期间追加的配置变更只对下一 Turn 生效，即使两项持久化因并发交错也能从
ItemList 恢复实际选择；旧`turn_started`没有 selection 时仍按它之前最后一份配置派生。
既有 v1`provider / model`Items 重放为同名 profile、model 与`medium` effort，
不重写历史 journal。
宿主也不会把完整进程环境交给 shell tool：工具只继承运行命令所需的最小环境，
Provider credential 即使来自环境变量也会被显式排除。

Thread 的用户展示名称、置顶与归档等产品状态不改变 Agent 下一轮上下文，因此
不进入 canonical ItemList。ZAS 可以知道、持久化并通过 App Server 同步这些
状态；客户端当前选中的 Thread 仍是每个客户端或 conversation binding 的状态，
ZAS 不保存全局 `currentThreadId`。

手动 context compaction 只在没有 active / incomplete Turn 时取最新
`turn_completed` 作为覆盖边界；调用者不能指定任意 Item。Zen 以 admission 时
Thread 当前生效的 `providerProfileId / modelId / reasoningEffort` 调用所选 Provider，
使用版本化、provider-neutral 的 summary 指令且不使用 Provider opaque compaction
或 cache。v1 确定性保留该最新完整 Turn 的全部 canonical Item；生成、abort、验证或
journal append 失败都明确返回且不追加 compaction Item，不隐藏重试。

成功 Turn 使用 admission 时冻结的 Provider adapter、selection、catalog entry 与
`contextWindow` 判断自动 compaction；只有 Provider 实际报告的有效 `inputTokens`
达到窗口的 80% 整数上界才执行，多次采样或 tool round 取观察到的最高 input context。
Unknown window、缺失或无效 usage、非成功 Turn 与已覆盖边界都不猜测、不追加。
自动生成、验证或 persistence 必须在成功 Turn handle settle 前完成；失败通过既有
Turn execution error surface 明确返回且不重试，已完成 Turn 的原始 canonical trace
保持不变。

`context_compaction` canonical Item 记录 `coveredThroughItemId`、原样 summary、
稳定 canonical 顺序的 `retainedItemIds`、实际 Provider selection、
`algorithmVersion` 与 input/output token usage。覆盖目标必须是已存在的
`turn_completed`；保留引用必须已存在、不重复、不晚于覆盖边界且按 journal 顺序排列，
并完整保留同一模型响应的 tool-call 集及每个 call/result 对。相同或更早的有效边界
不得再次追加。最新有效 compaction 决定模型投影并 supersede 更早投影状态，但所有
compaction 与原始 Item 都继续留在 journal。

模型上下文编译器先投影最新 compaction 的 retained canonical Item，再加入稳定标记的
summary，最后加入覆盖边界后的 canonical Item；当前实现没有独立 system/developer
message，未来若有则必须置于这些 compaction 输入之前。未包含 compaction 的 legacy
journal 继续按原始 ItemList 编译。Thread/Turn transcript 始终从完整原始历史派生，
默认忽略 compaction Item；保留 Item 中的 `AttachmentRef` 仍通过同一 Attachment Store
在 Provider request boundary 解析。

canonical `reasoning` Item 可在既有 summary 旁内联保存 Provider reasoning item id、
原始 summary parts 与 `encrypted_content`；这些字段只在它所属 Turn 的
`turn_started.selection` 与目标 subscription profile/model 兼容时重放，公共协议与展示仍只投影 summary。

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

Zen 只在 Codex 0.146.0 没有等价原子语义时增加明确命名的协议扩展：
`turn/replace` 与 `thread/compact`。它们不是 Codex compatibility claim，也不得
复用或改变标准方法；客户端必须显式调用并处理 unsupported。

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
- `account/read`、`skills/list` 与 `model/list` 只投影宿主公开能力，不向 Zen Core 或 Thread 写入账户、skill、provider 状态；
  `model/list` 用稳定 opaque model key 区分不同 profile 的同名 model，reasoning effort
  仍使用固定 Codex 字段；固定 schema 无法表达的非默认 Unknown/不可运行条目只从
  wire 投影省略，不从 Host/Core catalog 删除，默认模型则必须可表示且可运行。
  opaque key 的编码与解析只存在于协议目录。
- `thread/settings/update` 修改后续 Turn 使用的配置；`turn/start` 携带的模型
  与 effort override 复用同一内部更新路径。provider/model/effort 必须原子解析并追加；成功变更必须先追加
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
- **ProviderRegistry** — 宿主注入的 profile 路由表；Runtime 每个 Turn 只取得已冻结
  selection 对应的 adapter，profile 缺失不阻断 Thread 读取，但新 Turn 明确失败。
- **SubscriptionAuthProfile** — 宿主持有的 OAuth credential store 与
  request-time token resolver；它位于 Core 外，不进入 ItemList，ModelAdapter
  只拿一次请求所需的 access lease；服务端提前拒绝仍未到期的 lease 时，adapter
  只允许按被拒 access token 作为跨进程比较条件刷新并重试一次，避免并发刷新覆盖
  已轮换 credential。provider 的 sessionId 只允许作为可丢弃的
  transport cache / affinity hint，不得映射或持久化第二套 Thread。
- **工具** — AgentRuntime 只依赖 Tool Environment；builtin `shell` 由 Zen 执行，plugin / external
  tools 分别路由到拥有领域行为的 Plugin Runtime 或外部服务。
- **审批** — 审批请求的呈现与应答（各接入端自行实现 UI）。
- **接入端权限预设** — 当前固定 Codex wire 仍分别携带 sandbox 与 approval 字段；
  Plugin Platform 的目标产品策略只把它们归约为默认 `full_access` 与可选
  `ask_unknown`，不由接入端扩展新的 risk/scope 权限模型。

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
  provider-registry.ts
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
