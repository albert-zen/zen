# PRODUCTS

所有接入端平级，都只通过 App Server 协议工作。任何接入端都不得拥有
自己的 Agent、Thread、Turn 或调度语义。

## 第一客户端

**自建薄 Zen CLI** 是首个稳定接入端，只覆盖启动 / 恢复 Thread、发送消息、
流式显示、审批与模型选择，不拥有 Agent 或调度语义。交互式 `/model` 只调用
App Server 的 Thread 设置操作；可用模型来自 ZAS 投影的宿主 ModelCatalog。
目录按 Provider profile 隔离，并保留 reasoning/input/context capability 的
Unknown；接入端不得从模型名补写能力。

原版 `codex --remote` 与固定版本 T3 Code 是机会型兼容目标：Phase 2 用最小
stub App Server 记录真实调用，在不污染 Zen Core 的前提下扩展协议子集。能接入
是生态收益，不能接入也不阻塞 Zen 自身产品。

## 桌面

**ZenX 正在开发**，是与 CLI、IMZen 平级的本地桌面接入端。当前已跑通 Electron
host、Thread 列表与恢复、流式 Item、审批、模型切换、soft steer、interrupt 与
Interrupt & send；Provider/onboarding、安全 Markdown、Trigger / Watching / Room，
以及可显式授权的 bundled/local capability registry 已形成可运行 vertical slice。
这套 capability package / registry、child-host bridge、Tool Environment 与 Generic UI Host
已经形成可运行的 Plugin Platform 纵向切片；渐进发现与 structured result renderer 已完成，
安装、启停、卸载、重装与独立删除数据的产品入口已经完成。
ZenX 的产品读取模型来自 ZAS 原生 `ThreadSummary` 查询，并经 Electron main/preload
typed IPC 暴露；Codex Thread DTO 只属于兼容协议 adapter，不定义 ZenX 产品模型。
高保真 renderer 的当前 UI/UX 合同单独维护在 `apps/zenx/docs/ui-ux.md`，本文件不重复
具体布局。Thread 的重命名、归档与取消归档全部通过既有 App Server 操作；Archive
作为可逆的安全删除替代，不提供永久删除，也不在活动 Turn 期间暗改 Thread 设置。
Plugin Package v2 manifest 与 Host-owned Catalog 已建立 installed / enabled / uninstalled
基础生命周期，并继续复用现有 capability runtime seam。Catalog 原子持久化 package descriptor、
安装事实与独立 enablement；旧 capability grants 原样迁移保留但不再定义目标权限 UX。Bundled
Triggers/Rooms 与本地 v2 process package 使用同一 install/lifecycle API；disable/uninstall 会撤销
当前 runtime/tool/sidebar/page 注册，bundled package 可从应用提供的 package 重装。Uninstall 默认
保留 namespaced plugin data，显式 delete-data 只删除目标 namespace。
Triggers 与 Rooms 的人类 CRUD 已经由 manifest-contributed Generic UI page 经 Plugin Host command
直接到 package service，不再经过产品专用 renderer route/IPC，也不会创建 Turn；两者从旧
`trigger-registry.json` 确定性、幂等初始化各自 namespace 且保留旧文件。只有 timer/predicate、Room mention
等明确 Agent 唤醒继续走同一个 AppServer authority 并追加既有 canonical Items。

Plugin Runtime Supervisor 与统一 ABI 现已实现为 ZenX Host seam：trusted bundled module、持续 child
process 和 HTTP service 都归约为同一个 namespaced tool invocation/result、取消和 close 合同，并作为
独立 plugin provider 注入 Tool Environment。Catalog 的异步 install/enable 先启动未发布 runtime，
持久化与内存提交后才开放 Tool Environment admission；失败会撤销 runtime/provider。disable/uninstall
先关闭新 admission，已 prepare/执行的调用仍在其 admitted runtime 上结算后再 close，持久化失败则恢复
原 enabled provider；disabled plugin 重装后仍保持 disabled。runtime crash、malformed/oversized process message 与 HTTP failure
都显式失败且不重试。人类产品侧可以直接经 Supervisor 调用 runtime，不创建 AppServer Turn；只有 Agent
Tool Environment 路径产生既有 canonical tool call/result。versioned Plugin Host SDK v1 现以
`query / actions / ui / storage` 四组公共能力注入 runtime：Project 查询复用 main 的既有 projection，
namespaced JSON storage 串行原子写入并执行 package-owned 逐版本 migration，disable/uninstall 保留数据；
只有显式 `actions.threads.startTurn` 经 AppServer port 产生 canonical Items。bundled module 直接拿 SDK，
process/HTTP 只经既有 ABI 的 SDK request/result 边界访问同一逻辑操作，不取得内部 store。Generic UI
Host 从同一 lifecycle snapshot 投影 sidebar、page/subroute、settings、panel、command/menu 与
plugin-owned namespaced result renderer；trusted
bundled module 只在分配的 React surface 内挂载，local/third-party renderer 使用没有 same-origin 权限的
sandboxed iframe 与验证过的 message API。两者共享 v1 theme/context、opaque handle、navigation 与 command
合同，command 经 Host SDK UI port 回到 enabled package。实际桌面 composition 已把主进程
CapabilityService 的 Catalog/Registry/Supervisor 与 hosted AppServer 接通：child-host 从当前 snapshot
组合 shell、仍需兼容的 external capability 与常驻 `zenx_plugin`，并在每次模型采样从普通 canonical
read call/result 投影该插件精确 namespaced schemas。普通插件调用沿既有私有 bridge 回到主进程，由
Supervisor 的稳定 plugin provider 执行；重启无需额外状态，disable/uninstall 只影响后续投影和新调用。
Settings 已通过 typed main/preload IPC 提供本地 manifest 选择、安装、版本更新、启停、
卸载/重装与独立 delete-data；bundled/local 都显示同一生命周期，旧 v1 grant 只留在明确标注的
兼容区。更新先验证并暂存新 runtime、UI 与 Host SDK storage migration，再原子提交 catalog；
失败恢复旧 catalog、runtime 与 storage，且不建立 durable 恢复状态机。Tool Environment 只在
JSON-compatible、1 MiB 内且 content type 属于 provider namespace 时把可选 structured content 附加到既有
canonical `tool_result`；原 output/exitCode 和模型上下文不变。Transcript 把 immutable structured data 与文本
fallback 交给当前 enabled renderer；disable/uninstall/missing 时显示确定性的 JSON/Text fallback，reinstall 从
同一历史 Item 恢复 renderer。v1 capability 继续保留在原兼容
seam，不参与 v2 发现合同。

普通 npm package/profile 分发已实现完整 source/lifecycle matrix。开发者侧提供公开的
`@zenx/plugin-sdk` manifest/schema、Host SDK/Runtime/UI 类型、无会话 authority 的 fixture Host，
以及 `create` / `validate` / 委托标准 npm 的 `pack`；由它生成的普通 npm package 可以经 Settings 的
npm spec、commit-pinned Git、tarball、稳定本地复制或显式开发 `link:` installer 进入 profile。package 以
`package.json#zenx.plugin` 定位 manifest，ZenX 用 App Resources 中固定版本的 pnpm 在 userData
不可变 generation 内生成 `package.json`、lockfile 与 `node_modules`，且只有 profile 直接 dependencies
进入 Catalog。Catalog descriptor 保存原始 package spec、source mode、精确解析身份与 profile package name；
Settings/typed IPC 的 install/update/remove/reinstall/enable/disable/delete-data 全部进入同一个服务级串行
mutation 边界并返回 typed post-commit capability refresh 结果。npm、Git 与 tarball 交给同一 installer；
稳定本地目录使用复制快照，只有显式开发模式使用 `link:`。卸载通过 pnpm 从新 generation 删除直接
dependency，同时保留 source tombstone 和默认 plugin data；重装从同一来源重新解析，显式 delete-data
只删除目标 namespace。安装即信任 package 代码，但 dependency build scripts 只按 profile 显式 pnpm
`allowBuilds` 执行。pnpm、全部准备期 I/O 与 manifest/runtime/UI 准备和校验完成后，原子 Catalog snapshot
才提交 generation identity；提交后只做 non-fallible 的已准备对象/admission 内存交换，不再执行 I/O、
校验或其他可拒绝工作。此前失败或中断继续使用旧 generation，重启也只读取 Catalog 指向的 generation。
Rooms 已作为随应用分发的标准第一方 tarball 离线首装：它使用公开 SDK 合同打包，在 profile 中成为
直接 dependency，并与第三方 package 共用 Catalog、runtime、UI、discovery 与
install/disable/uninstall/reinstall/delete-data 路径；卸载保留既有 Room 数据，重装从 Catalog 指向的
generation 恢复。升级时，同一 transaction 会把 identity 完全匹配的旧 bundled Rooms Catalog descriptor
收编进 profile，并原样保留 disabled/uninstalled 与数据状态。只有 Host-owned App Resources allowlist 可以启用其 bundled runtime 与 trusted UI，
外部 tarball 自报同类信任会被拒绝。Browser、Computer、ZenX self-control 与 Triggers 仍将在后续切片
迁移到同一路径。
公开 `zenx-plugin dev` 只连接显式开发模式启动的单个本机 Host，复用上述 `dev-link` transaction；同版本
reload 仅在该显式语义下成立，并只更新目标插件 runtime 与 App Server capability projection，不重启或替换
其他插件实例。
薄 Marketplace
只提供 package metadata 与 installer 入口，不成为 registry、发布后台或新的 package authority。

目标 Plugin Platform 保持 Zen `AgentRuntime` 拥有 provider-neutral agent loop 和 canonical
tool call/result；混合 Tool Environment 组合 builtin、plugin 与 external providers，Zen 负责解析、
Host policy、路由和回写，插件或外部服务拥有实际领域执行。Plugin Runtime 可以是 bundled module、
child process、本地服务或远程服务。模型初始只看到 builtin tools 与 `zenx_plugin`：`discover`
返回 id/name/short description/status，`read` 返回 main document/tool index，随后采样才披露所选
插件的普通 namespaced schemas。整个过程只使用既有 tool call/result，不新增 discovery Item。

目标插件生命周期只有 installed / enabled / uninstalled；bundled plugin 同样可卸载、以后重装，
卸载默认保留数据，删除数据是独立动作。目标权限只有默认 `full_access` 与可选 `ask_unknown`；后者
由 Host 按稳定 tool name 维护 approved/denied 集合，不保留现有细粒度 grant UX，也不增加风险引擎。
通用 UI Host 已支持 sidebar、pages/subroutes、settings、panel、commands/menu 与 result renderer。
第一方/第三方共用逻辑 UI SDK且第三方隔离运行。直接操作插件 UI 不创建 Turn，只有显式 Run Agent
才调用 AppServer。现有 `ToolResultItem` 已增加可选 structured content；renderer 缺失时使用
text/JSON fallback，历史文本、reasoning、tool/title trace 永不扫描或改写。

ZAS 与 Plugin Host 是 ZenX Host 下的并列服务。ZenX Host 已通过稳定的私有 descriptor
向其他应用暴露唯一 ZAS 的带认证 loopback endpoint；ZenX renderer 与外部客户端因此观察
同一 Thread / ItemList authority。关闭全部窗口保留 Host 与 active Turn，activation 重建 UI，
显式 Quit 撤销发现入口并停止 ZAS。本阶段仍不做 OS daemon。
首批 browser provider 默认优先复用 Playwright CLI 的跨平台 headless 隔离 session，缺失或不兼容时
回落到 bundled Electron/CDP 临时 profile；用户也可显式选择 loopback CDP user-session
provider 附着到自己预先开启的 Chrome/Edge/Chromium，原位使用认证状态而不导出 cookie、
storage 或 auth header，连接失败时绝不回落到隔离登录态；三者都只暴露有界 DOM 操作。computer
公共 contract 暴露语义动作、平台能力与 background-safe/foreground-required 影响协商；
当前 macOS provider 优先复用 Peekaboo 3.x 的 background-first 操作，缺失或不兼容时以 bundled
AX/窗口定向截图和明确提示、可取消的前台输入形成基线；
后续 Windows provider 可用 UIA/Windows Graphics Capture/SendInput 接入同一 seam；manifest、权限、
provider 与当前 capability instruction resources 均由 ZenX 持有，不进入 Zen Core 或 Codex 协议；
独立 Skills 平台暂缓，目标插件以 main document 承担首要说明。上述外层配置
和调度状态不进入 Zen Core，命中 Trigger 仍只通过 App Server 发起普通 Turn；在真实
桌面验收完成前不夸大为稳定发布。

ZenX Agent 的自控工具同样属于产品层：bundled capability package 经现有 registry
显式授权 workspace/local-device 权限后才向 Agent 暴露；Project 列表只按已配置
workspace 与 Thread 实际 cwd 的 canonical filesystem identity 派生，symlink/junction alias
合并但保留用户选择的展示路径；Thread 的创建、读取、状态、重命名、归档与取消归档，以及
`start | steer | replace` 发送全部经由 App Server。工具调用和目标 Thread 的结果分别
进入各自权威 ItemList，不另建委派记录、消息队列或 transcript；互相监听
`turn_completed` 后继续发起普通 Turn 是允许的。

Project/Workspace 由 main 中同一个 ZenX 投影实例同时服务 renderer 与 Agent 自控工具；
Add Project 使用只读的内部目录 picker。Windows/Linux 不安装 Electron 默认菜单，macOS
只保留系统合规的最小 native menu；这些都属于桌面产品外层，不改变 Core 或 wire protocol。
顶部 New thread 只使用 host profile 中仍有效的最近使用 workspace；没有记录时由用户明确
选择 Project，不把 Documents、进程 cwd 或默认 Project 当作隐式替代。

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

| 阶段 | 当前结果                                                                          | 状态                                                                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | VISION / ARCHITECTURE / LESSONS / PRODUCTS 定义当前产品边界                       | 完成                                                                                                                                                                                                                                                           |
| 2    | 协议钉在 codex-cli 0.146.0；精确子集记录在 `src/protocol/codex/README.md`         | 完成                                                                                                                                                                                                                                                           |
| 3    | 内存 ItemList → Runtime → App Server → FakeModel 事件链                           | 完成                                                                                                                                                                                                                                                           |
| 4    | 每 Thread 一个 append-only JSONL；stale open Turn 派生为 interrupted              | 完成                                                                                                                                                                                                                                                           |
| 5    | shell + command item 瞬态审批；accept / decline / cancel / interrupt              | 完成                                                                                                                                                                                                                                                           |
| 6    | 薄 Zen CLI；stdio 与 loopback WebSocket                                           | 完成                                                                                                                                                                                                                                                           |
| 7    | OpenAI-compatible 与 ChatGPT subscription adapters；两轮 tool-call                | 实现完成；订阅真实网络闭环已通过                                                                                                                                                                                                                               |
| 8    | 独立 IMZen；组合固定提交的 IM Agent SDK                                           | SDK/本地闭环通过；真实 QQ 需频道凭证                                                                                                                                                                                                                           |
| 9    | ZenX 桌面 vertical slice；Provider、Markdown、Trigger / Watching / Room           | 开发中                                                                                                                                                                                                                                                         |
| 10   | ZenX Plugin Platform：Tool Environment、Plugin Host/Runtime、通用 UI/ZAS 生命周期 | Public SDK/create/validate/pack、Package lifecycle、Runtime/SDK、渐进发现、structured result renderer、桌面 AppServer composition、Generic UI Host、ZAS lifecycle、完整 profile source/lifecycle matrix 与 thin Marketplace 已完成纵向切片；首批插件迁移待后续 |

原版 `codex --remote` 0.146.0 还会调用账户、模型、配置、hooks 等 bootstrap
方法，Zen 当前明确返回 unsupported，因此不宣称兼容原版 TUI。这不阻塞 Zen CLI，
也不会反向扩大 Core。
