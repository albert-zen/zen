# ZenX 高保真原型实现要点

更新日期：2026-08-19
原型：`zenx-high-fidelity-prototype.html`

## 1. 文档定位

本文记录高保真原型中已经确认的产品投影与交互规则，供 ZenX 正式实现、接口对接和验收时使用。

原型中的 Trace 内容是静态演示数据，结构和文案只需接近真实场景；正式实现应适配 ZEM 的真实 Item 类型、字段和事件，不应反向要求协议复制原型数据。

## 2. 核心信息模型

界面应围绕以下层级实现：

```text
Thread
└── Turn
    ├── Agent Message Item
    ├── Trace Group（由连续的 Thinking / Tool Call Item 投影产生）
    │   ├── Thinking Item
    │   ├── Tool Call Item
    │   └── ...
    ├── Agent Message Item
    └── Final Message Item
```

关键原则：

- Turn 是一组按顺序追加的 Item，不是时间线卡片。
- Agent Message 是 Turn 内的一级 Item，不能嵌入 Thinking/Tool 的容器中。
- Trace Group 是 UI 投影层的聚合，不一定需要成为后端实体。
- Thinking 和 Tool Call 在组内仍是独立 Item，必须保留原始顺序和稳定 ID。
- 不使用头像轨道、纵向时间线或每一步一个大卡片。

## 3. Turn 状态投影

| Turn 状态 | 默认展示 | Turn 级交互 | Agent Message |
| --- | --- | --- | --- |
| Running / incomplete | 完整展开历史 | 不允许整体收起 | 正常显示全部中间消息 |
| Completed，默认 | 只显示 Final Message | 可主动展开 | 隐藏中间消息，只保留 Final |
| Completed，用户已展开 | 历史 Items + Final Message | 可再次收起 | 中间消息恢复显示，Final 仍只出现一次 |
| Interrupted / failed | 建议按完成态投影 | 可展开历史 | 保留明确的终止或错误结果 |

实现注意点：

- Running Turn 不要渲染可操作的 Turn 折叠按钮；状态文案只负责提示“Working for …”。
- Turn 完成时自动切换为默认收起，但不要因为后续轮询或数据刷新反复覆盖用户已经做出的展开选择。
- Thread 切换时可以恢复该 Thread 的 disclosure 状态；如果首期不持久化，至少保证切换后状态确定且无闪烁。
- Final Message 属于完成结果，不应与中间 Agent Message 重复渲染。

## 4. Trace Group 生成规则

建议在展示层扫描 Turn Items：

1. 遇到 Thinking 或 Tool Call，开始或继续当前 Trace Group。
2. 遇到 Agent Message、Final Message、审批或其他需要独立展示的 Item，先结束当前 Trace Group。
3. 保持 Item 原始顺序，不按工具类型、状态或时间重新排序。
4. 流式追加时，只向最后一个仍可合并的 Trace Group 追加 Item，避免整个 Turn 重建。

伪代码：

```ts
for (const item of turn.items) {
  if (item.kind === "thinking" || item.kind === "tool_call") {
    appendToCurrentTraceGroup(item)
  } else {
    flushCurrentTraceGroup()
    appendStandaloneItem(item)
  }
}
flushCurrentTraceGroup()
```

Trace Group 摘要应由可读的行为概括和数量组成，例如“检查协议 Item 与投影约束 · 6 items”，而不是暴露内部事件名或原始 payload。

## 5. 两层 disclosure

### 5.1 Trace Group 层

- 默认收起，只显示一行组摘要、Item 数量和展开箭头。
- 用户展开后显示组内 Item 列表。
- 组本身应轻量，不使用厚边框或大面积卡片背景。

### 5.2 Item 层

- Thinking 与 Tool Call 都以等高、紧凑的单行小块展示。
- 每个 Item 默认收起；点击后才显示具体 reasoning、命令、参数、结果或错误。
- 原型基准：桌面 Item 行约 30px，Trace Group 摘要约 34px；移动端交互目标统一至少 44px。
- Thinking 和 Tool Call 使用一致的字号、间距、箭头和展开逻辑，只通过图标、标签及状态区分。
- 关闭 Trace Group 时，原型会重置组内 Item 为收起；正式实现可保留这一行为，避免再次展开时出现不可预测的局部状态。

工具状态建议统一为 `queued / running / success / failed / cancelled / approval_required`。状态信息应放在单行尾部，完成态使用克制的颜色，不要让大量绿色“Done”争夺注意力。

## 6. Agent Message 的视觉规则

- 用户消息：右对齐气泡。
- Agent Message：左侧自然排版，不使用气泡，不增加重复头像轨道。
- 中间 Agent Message 与 Trace Group 都位于 Turn 的同一一级流中，不能产生错误缩进层级。
- 正文宽度、行高和段间距优先保证阅读；Trace 区域应比正文更小、更弱。
- 代码块属于相邻 Agent Message 的内容，可以有独立容器，但不应被误认为 Tool Call。

## 7. Composer 状态机

Composer 几何尺寸在运行和空闲状态之间保持稳定，只改变主要动作的语义。

| Run 状态 | Draft | 主动作 |
| --- | --- | --- |
| Running | Empty | Stop |
| Running | Non-empty | Interrupt & Send |
| Idle | Non-empty | Send |
| Idle | Empty | Send disabled |

实现注意点：

- 保留一个统一的圆形主要动作，不拆成常驻的 Stop、Steer、Send 三个按钮。
- 主要动作保持 44px 可点击区域，但视觉圆约 36px、图标约 18px；缩小外圈而不是同步缩小图标或牺牲触控面积。
- 底部工具栏在 Composer 内略靠下对齐，底边保留约 4px 布局余量；附件、模型、权限与主要动作必须共享同一条视觉基线。
- 不在 Composer 右侧重复显示“Running · 24s”；运行状态已经在 Turn 中表达。
- 附件、模型和权限入口保留，但应按优先级渐进隐藏，避免小屏堆满控件。
- 运行中输入内容后，按钮语义必须即时切换为 Interrupt & Send，并提供准确的 `aria-label` 和 tooltip。
- 审批条位于聊天流与 Composer 之间，是独立状态，不塞进 Trace Group 或 Composer 工具栏。

## 8. Sidebar、Inbox 与模型身份

- 默认 Sidebar 是 Projects / Threads 层级。
- Inbox 通过品牌区图标切换，不做 Projects / Inbox 分段控件。
- Inbox 每个 Thread 必须明确显示项目归属。
- Thread 只显示 Provider Logo + 模型名称。
- 不展示内部 `modelProvider`、Provider 文本、API/订阅标签；Fake Provider 不应出现。
- Phase 1 不提供常驻右侧 Activity 栏；Workspace/Artifact 使用按需抽屉。
- 顶栏右侧面板入口只使用图标，不使用“Dark”或“Workspace”文字按钮。

## 9. 响应式实现

原型采用三档验证：1024、736、360 外层宽度。

- 宽屏：Sidebar + Chat 两栏，正文和 Composer 维持可读的最大宽度。
- 中等宽度：收窄 Sidebar、正文 padding 和 Composer 控件，但不破坏两栏结构。
- 小于约 640px：Sidebar 变为抽屉，主界面全宽；点击侧栏外 scrim 或按 Escape 关闭。
- 移动端 Trace Group 和 Item 行的触控高度至少 44px。
- 所有容器使用 `min-width: 0`、可换行文案和受控溢出，禁止页面级横向滚动。
- Composer 保持可见，底部区域不能遮挡最后一条消息；滚动离开底部时显示 Back to live。

## 10. 无障碍与键盘行为

- disclosure 使用原生 `button`，同步维护 `aria-expanded`。
- 折叠内容使用 `hidden` 或等效语义，避免仅做视觉隐藏。
- Enter 与 Space 必须能够操作 Turn、Trace Group 和 Item 展开。
- 所有按钮保留清晰的 `:focus-visible` 状态。
- 抽屉和弹层打开后管理焦点；Escape 关闭并将焦点返回触发按钮。
- 图标按钮必须有可读的 `aria-label`，纯装饰图标使用 `aria-hidden="true"`。
- 动画遵守 `prefers-reduced-motion`。

## 11. 流式数据与边界情况

正式接入真实 Trace 时需要特别处理：

- Item 追加期间不改变用户当前滚动位置；只有用户处于底部时才自动跟随。
- Tool Call 状态变化应更新同一个稳定 Item，不要创建重复行。
- Thinking 或 Tool payload 很长时，摘要行必须截断，详情内部允许换行或局部滚动。
- Tool error、取消和审批拒绝需要明确状态，但不能把整个 Turn 误判为仍在运行。
- Turn 完成事件与 Final Message 到达顺序可能不同，应等待可展示的最终结果后再切换为完成态投影。
- 如果完成后没有 Final Message，显示明确的 interrupted/error fallback，不能留下空 Turn。
- 避免因流式 patch 重建 DOM 而丢失 disclosure、焦点和滚动状态。

## 12. 建议的前端职责拆分

```text
ThreadView
├── TurnView
│   ├── RunningStatus / CompletedTurnToggle
│   ├── TurnHistory
│   │   ├── AgentMessageItem
│   │   └── TraceGroup
│   │       ├── TraceGroupSummary
│   │       └── TraceItemRow
│   └── FinalMessageItem
├── ApprovalBar
└── Composer
```

建议把“协议 Item → 展示节点”的 projection 写成纯函数，并为状态矩阵和分组边界编写单元测试；组件只负责交互状态和渲染。

## 13. 实现验收清单

- [ ] Running Turn 始终展开，且没有可操作的 Turn 收起入口。
- [ ] Running Turn 的所有 Agent Message 正常显示。
- [ ] Completed Turn 默认只显示 Final Message。
- [ ] 用户可主动展开 Completed Turn 查看历史 Items。
- [ ] Agent Message 不嵌套在 Trace Group 中。
- [ ] 连续 Thinking/Tool Call 被聚合成一个 Trace Group，顺序不变。
- [ ] Trace Group 默认收起；展开后每个 Item 仍默认收起。
- [ ] Thinking 与 Tool Item 的尺寸和密度一致。
- [ ] Composer 的 Stop、Interrupt & Send、Send 状态切换正确。
- [ ] Provider 信息只显示 Logo + 模型名称。
- [ ] 1024、736、360 三档无页面级横向滚动。
- [ ] Enter、Space、Escape 和焦点返回行为正常。
- [ ] 浏览器 Console 无 warning/error。
- [ ] 流式追加不会破坏滚动、焦点或 disclosure 状态。

## 14. 原型与正式实现的边界

原型已经确认视觉层级、状态投影、交互优先级和响应式方向；以下内容仍应由正式实现决定：

- ZEM Item 的真实 TypeScript 类型和字段映射。
- Trace Group 摘要的生成策略与国际化。
- disclosure 状态是否跨 Thread 切换或刷新持久化。
- Tool 详情的脱敏、日志截断和权限控制。
- 实时耗时、token、审批与工具状态的数据来源。

## 15. 产品页面盘点与导航

本轮以 Zen 仓库中的 `apps/zenx` 实际实现为功能依据，以当前高保真 Agent 页面为视觉和交互基准。旧 `prototype/zenx-ui` 只用于交叉核对历史功能，不作为新版视觉约束。

当前产品原型包含以下一级或独立工作空间：

| 产品面 | 现有应用依据 | 高保真原型中的投影 |
| --- | --- | --- |
| Agent / Thread | `ThreadView`、Composer、审批、模型切换 | 默认主页面，Projects/Inbox + Chat 两栏 |
| Settings | `SettingsView` | Account、Models & Provider、Plugins、General 四个分区；插件统一在这里启停 |
| Triggers plugin | `ScheduledView`、`TriggerRail` | 插件启用后贡献 Sidebar 入口；页面展示 Trigger、唤醒历史和开发信号模拟器 |
| Rooms plugin | `RoomView` | 插件启用后贡献 Sidebar 入口；页面包含成员、消息、Source Thread 跳转和 Room Composer |
| Plugin marketplace | Capability Registry、local package discovery | 代码保留但不进入当前评审主路径；当前只验证已安装插件的管理与贡献机制 |

导航规则：

- Agent / Thread 仍是默认入口，原生 Sidebar 只拥有品牌区、Inbox、Projects/Threads 与底部 Settings。
- 插件贡献位于 Projects 之前的独立 `Plugin spaces` 插槽，不插入 Projects 标题与项目列表之间，也不能改动 Chat、Composer 或 Thread Item 层级。
- Triggers 与 Rooms 是两个同级插件。各自启用时才显示自己的 Sidebar 入口；两个都关闭时，整个 `Plugin spaces` 区域隐藏，Projects 自动上移。
- 插件禁用时，对应页面不再可达；跨插件依赖项也同步隐藏或禁用，例如 Rooms 关闭后 Triggers 页面不再显示 Room mention 入口。
- 选择任意 Thread 或新建 Thread 时返回 Agent 页面；移动端同时关闭 Sidebar 抽屉。
- 插件页面复用受控产品壳，但不因此变成 ZenX 原生页面；禁用插件不删除实现代码，只撤销运行时贡献并卸载对应路由。

## 16. Settings、Plugin 与 Capability 实现要点

- Subscription 登录状态、账户标识、API Key、Provider Base URL 等都属于 ZenX Host 配置，不进入 Thread 或 ZEM Item。
- Thread 中只显示 Provider Logo + 模型名称；Settings 才能展示 Provider 类型、订阅状态与 API 配置。
- Provider 类型与当前应用一致：OpenAI subscription、OpenAI-compatible API、Local demo。
- Local demo 只用于离线 UI/协议演示，不应在 Thread 列表显示为 `Fake` 模型身份。
- Default model 影响新 Thread；现有 Thread 的模型仍以 App Server 的 Thread Settings 为权威。
- Title model 与 Thread ModelCatalog 分离，避免为了标题生成改变当前 Thread 模型。
- Settings 的 Plugins 分区是已安装插件的唯一管理入口；主对话页不提供 Marketplace、安装或授权面板。
- Plugin enablement、Capability grant、per-call approval、runtime sandbox 是四个独立状态，UI 不应合并成一个开关。
- 插件开关只决定该包是否加载，以及声明的页面/Sidebar contribution 是否挂载；不能从开关推导所有工具权限已经授权。
- Browser、Computer、ZenX self-control 这类只有 Agent 工具的插件可以启用但没有 Sidebar contribution。
- Triggers、Rooms 既暴露工具，也声明独立的页面与 Sidebar contribution；二者不应再被合并为一个 `Triggers & Rooms` 状态。
- Grant/Revoke 可能要求 Host 重启；交互必须提供进行中、成功、失败和重试状态，且保留用户当前页面。
- Provider diagnostics、最近调用、foreground-required 标签属于 Capability 管理详情，避免塞入 Agent 聊天流。

## 17. Plugins、Scheduled 与 Room 实现要点

### Plugin 管理与贡献契约

- 本轮不继续深化 Marketplace 视觉；Marketplace 代码保留但无一级导航入口，避免尚未确认的商店模型干扰原生对话评审。
- 已安装插件统一在 Settings → Plugins 管理，不在主 Agent 页面散落管理入口。
- Marketplace 是 Capability Registry 的产品化视图，不等同于远程商店；首期应优先准确展示 bundled/local package。
- 插件卡至少包含来源、版本、可用性、权限数量、工具数量与安装/管理动作。
- 搜索与 Discover/Installed/Updates 筛选必须作用于同一份稳定 catalog，不隐藏加载或错误状态。
- “Installed”不代表“Granted”；进入管理后仍需逐项确认权限。
- Local package 需要先验证 manifest、provider、resources 和完整性，再允许授权或暴露工具。

建议的首期扩展边界：

- 插件通过 manifest 声明 `contributions`，不能获得任意 DOM、路由或 Sidebar 修改能力。
- Sidebar 只开放一个统一的 `plugin-area` 插槽；插件可添加带稳定 ID、图标、标题、计数和目标路由的入口。
- 核心 Projects/Inbox/Threads/Settings 的顺序与语义由 ZenX 持有；Triggers 与 Rooms 不属于核心，插件不能重排、隐藏或覆写核心入口。
- Host 根据 `pluginId + contributionId` 生成稳定 key，按 manifest/order 规则排序；插件不能直接查询或改写 Sidebar DOM。
- 禁用插件时先停止新调用，再注销 contribution 与路由；正在运行的调用应进入可解释的完成/取消状态，而不是直接丢失。
- 插件页面运行在受控产品壳中，复用顶部高度、颜色、焦点和响应式规范；不允许注入常驻右侧栏。
- 插件需要的工具权限继续走 Capability Grant + per-call approval，不由 Sidebar 入口是否可见推导。

建议 manifest 结构：

```ts
type PluginManifest = {
  id: string
  contributions?: {
    sidebar?: Array<{
      id: string
      label: string
      icon: string
      route: string
      order?: number
    }>
  }
}
```

### Triggers plugin

- Trigger 属于 ZenX 外层产品状态；命中后仍通过 App Server 创建普通 Turn，不建立另一套 Agent 执行记录。
- Trigger 类型与当前应用保持一致：Timer、Thread turn completed、Room @mention、External signal。
- Room @mention 属于对 Rooms plugin 的可选依赖；Rooms 未启用时，此类入口和新建选项必须禁用并解释原因。
- Phase 1 不恢复常驻右侧 Trigger/Activity 栏；独立 Scheduled 页面承担总览与管理，Thread 内只保留按需入口。
- Active trigger、Recent wakeup 和取消失败应分别投影，不能把历史记录误认为仍在运行。
- 开发 Signal simulator 必须标明只用于本地测试，不能伪装成已上线的外部事件接入。

### Rooms plugin

- Room 不是 Thread，也不拥有独立 Agent Runtime；它只保存共享消息、成员关系和有限路由上下文。
- Room 中展示结论，不复制成员 Thread 的 Thinking 或 Tool Trace。
- @mention 命中后，把有界的近期 Room 上下文注入该成员对应 Thread 的普通新 Turn。
- Agent 发出的 Room 消息应保留 `originThreadId` / `originTurnId`，UI 提供 Source Thread 跳转。
- 成员名称与 Thread 绑定在同一 Room 内必须唯一；增加或删除成员失败时保留用户草稿并显式允许重试。

## 18. 顶部操作区决策

- 右上角三点按钮已移除：当前 `apps/zenx` 没有与之对应的稳定菜单或处理器，旧高保真原型中也没有实际交互。
- 不保留“将来可能用”的空入口。Thread 重命名、归档、置顶等功能落地时，应先定义明确菜单项、权限和状态反馈，再决定是否恢复 overflow menu。
- 当前 Thread 顶部只保留两个有明确职责的图标：Thread 内搜索、按需 Workspace/Artifact 抽屉。
- 小屏优先隐藏搜索，保留 Workspace/Artifact 入口；所有图标按钮仍需 44px 触控目标和可读 `aria-label`。

## 19. 本轮原型验收记录

- 1024px：Agent、Settings、Triggers、Rooms 全部可进入；根容器、Settings 页面和 Agent 页面横向溢出均为 0。
- 736px：保留 Sidebar + 主内容两栏，Sidebar 约 230px，Agent 页面横向溢出为 0。
- 360px：只做不破版基线；Sidebar 作为抽屉开合，Agent 与 Settings 页面横向溢出均为 0。Settings Tab 使用局部横向滚动承载四个分区；后续不以该档作为当前视觉细化重点。
- Running Turn 没有可操作的 Turn 级收起按钮；Trace Group 和 Item 默认收起。
- Completed Turn 默认只显示 Final Message，用户主动展开后恢复历史 Items。
- Composer 已实测 `Stop → Interrupt & Send → Stop` 状态转换。
- Triggers 新建表单、Signal simulator、Room 消息发送和 Source Thread 返回均已实际操作。
- Settings → Plugins 已实测 Triggers / Rooms 分开启停；单个关闭只撤销自己的 Sidebar contribution，两个都关闭时整个 Plugin spaces 区域隐藏。
- Rooms 关闭时，Triggers 页面中的 Room mention 行与新建选项会同步隐藏/禁用；重新启用后恢复。
- Settings Tab 已实测方向键切换，插件 `role=switch` 已实测 Space 切换并同步更新 `aria-checked`、可读标签与 Sidebar。
- 移动端 Sidebar 已实测图标打开、Escape 关闭，Composer 仍保持 44px 主动作命中区域且贴近底部。
- Workspace 抽屉在 360px 仍保留图标入口并可正常开合。
- 右上角 More 按钮与主导航 Marketplace 入口计数均为 0；浏览器 Console warning/error 读取结果为空。

## 20. Git 管理与原型边界

原型最初在独立交付目录中建立本地 Git 历史，现已作为非生产设计资产纳入 Zen 仓库；本次入库不修改正式 renderer 或运行时，也不向任何远程仓库 push。

建议后续每次评审变更都以一条主题明确的提交记录，并在正式实现任务中引用原型 commit，而不是复制某一张截图。原型 HTML 与实现注意事项分别保留可审阅历史；它们仍是设计参考，不直接进入正式 renderer 或运行时。

以下内容只是原型示意，正式实现不应照搬：

- 静态 Thread、Turn、Trace、Trigger、Room、账户、模型、权限数量和时间文案。
- 当前固定的五个插件、`Plugin spaces` 英文标签、贡献计数和排序。
- 演示用 `pluginState` 内存对象；正式实现必须由 Host 的安装状态、启用状态和 manifest projection 驱动。
- 模拟的保存/重启延迟、Toast、Signal simulator 与审批文案。
- 原型中的合成品牌标记、配色常量和内嵌 SVG 图标定义；正式实现应接入产品设计 token 与正式品牌资产。

仍需人类或正式产品实现决定：

- Plugin manifest 的版本、签名、贡献排序、名称冲突和卸载迁移规则。
- 插件依赖的产品语义：Rooms 缺失时是隐藏 Room mention、显示禁用态，还是要求安装依赖。
- 插件运行中被禁用时的调用排空、取消、审批撤回和恢复策略。
- 插件启用状态是否按用户、Workspace 或本机持久化，以及同步范围。
- Marketplace 的来源信任、更新策略、审核、回滚与离线包安装体验。
- Sidebar contribution 是否允许计数、次级路由或上下文菜单，以及最多可容纳的数量。
- Settings 的插件开关是否需要 Host restart；原型表现为即时投影，只用于验证信息架构。
