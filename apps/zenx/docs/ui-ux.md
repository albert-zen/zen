# ZenX UI/UX decisions

更新日期：2026-08-20

## 1. 文档权威与规则等级

本文是 ZenX 当前 UI/UX durable product decisions 的**唯一权威文档**。正式实现、接口对接、设计评审和验收均以本文为准。

`prototypes/high-fidelity/zenx-high-fidelity-prototype.html` 是特定时点的静态设计快照。本文已经合并该原型中仍需保留的规则和后续已确认决策；后来的已确认决策优先于静态原型、历史截图、一次性验收记录和演示数据。变更当前规则时直接更新本文，不新增平行设计说明，也不从旧原型反推产品行为。

本文使用三类规则：

- **Durable product semantics**：状态归属、导航层级、产品对象和交互结果。实现必须遵守，直至新的已确认决策直接改写本文。
- **Interaction/state rules**：用户可观察的状态机、反馈、键盘和焦点行为。实现可以改变内部组件结构，但不能改变这些结果。
- **Visual guidance**：密度、比例、动效和断点方向。可以随平台与可用性验证调整，但不能破坏 durable semantics、信息层级或无障碍要求。

本文不能改变 `ARCHITECTURE.md` 的 Core、ItemList、Project 和协议边界。若 UI 需求需要新的领域抽象或不可推导会话状态，必须先按仓库规则更新架构文档。

## 2. Durable product semantics

### 2.1 权威数据与产品投影

- Zen App Server（ZAS / `AppServer`）是按 `threadId` 路由 Thread、驱动 `AgentRuntime` 并广播 Item events 的唯一服务入口；它拥有 ZenX Agent / Thread / Turn 主流程的 authority。
- ZenX 是围绕同一个 ZAS 构建的 Electron 产品。Electron main 托管并组合本机 ZAS host，同时持有 desktop-only host profile、capability、Trigger / Room 等外层产品状态；renderer 经 main/preload typed IPC 消费产品投影。
- Renderer、native IPC 与外层产品功能不复制 ZAS 的 Agent、Thread、Turn、transcript 或 scheduler authority。Codex protocol 是同一 ZAS 面向兼容客户端的 wire adapter；Codex DTO 不反向定义 ZenX 产品模型，也不是 renderer 的产品读取路径。
- Thread 会话内容与执行结果来自 append-only canonical ItemList。流式 delta 只用于实时显示，不能被 UI 当作第二份 durable history。
- Thread 列表产品数据来自 ZAS native `ThreadSummary` / `CurrentMetadata` read model，经 Electron main/preload typed IPC 投影。
- Thread 的名称与归档由 ZAS 产品元数据负责；当前选择、disclosure、草稿、打开的菜单和面板属于 renderer-local UI 状态。
- Archive 是可逆生命周期操作，不是永久删除。ZenX 不直接删除 journal，也不伪造 App Server 尚未定义的 Delete。
- Pin 是 profile-local ZenX 产品状态。Pinned Thread IDs 不进入 canonical Items、不跨设备同步，也不改变 runtime priority、scheduling priority 或 Inbox ordering；Pin 只改变 Sidebar prominence。

### 2.2 Project 身份与 cwd

- Project 是 ZenX 基于 host-profile workspace 与 Thread cwd 派生的产品投影，不是 Core/runtime 对象，也不是 repository aggregate。
- 当前规则是 **one canonical cwd = one Project**。symlink/junction aliases 指向同一 filesystem cwd 时必须归一为一个 Project identity，同时保留稳定、可理解的用户 display path。
- Canonical identity 的 realpath、platform case 与 lexical fallback 规则由 `ARCHITECTURE.md` 中的 `ZenXProjectProjection` 定义；UI 只消费该投影，不另建或简化路径身份算法。
- renderer 与 Agent self-control 必须消费同一个 main-process Project projection，不得各自实现路径归一或 Project 分组。
- Add project 使用 ZenX 只读 directory picker。移除 Project 只改变 host profile，不删除目录、目录内容或 Thread journal。
- 未来“一 Project 多 repository”属于单独的产品和数据模型工作；当前实现不得预埋 repository collection、迁移层、通用 `PathService` 或第二套 Project 状态。

### 2.3 Thread、Turn 与 Item 展示模型

界面围绕以下层级投影：

```text
Thread
└── Turn
    ├── Agent Message Item
    ├── Trace Group（连续 Thinking / Tool Call Item 的 UI 聚合）
    │   ├── Thinking Item
    │   ├── Tool Call Item
    │   └── ...
    ├── Agent Message Item
    └── Final Message Item
```

- Turn 是一段按顺序追加的 Items，不是独立时间线数据库。
- Agent Message 是 Turn 内一级 Item，不能嵌入 Thinking/Tool 容器。
- Trace Group 是可丢弃的 UI projection，不需要成为 Core 或协议实体。
- Thinking 与 Tool Call 在组内仍是独立 Item，保留 canonical 顺序和稳定 ID。
- Tool details 位于聊天流中对应 Trace Item 的 disclosure；不迁移到第二份执行 transcript 或常驻 Activity rail。
- 审批是 active Turn 的瞬态交互，显示在 Composer 上方；最终执行或拒绝仍由 canonical tool result 表达。

### 2.4 Provider 与模型身份

- Thread row 只显示 **Provider logo + model name**。
- 预设 Provider 使用随 ZenX 分发的本地正式品牌 asset；未知 Provider 使用克制的 generic fallback。
- Thread row 不显示 Provider 文本、内部 `modelProvider`、API/订阅标签或 Fake 品牌。
- Provider 类型、账户、订阅状态、API key 和 endpoint 配置只在 Settings / onboarding 中出现，不进入 Thread 或 canonical Items。
- Default model 影响新 Thread；已有 Thread 的当前模型以 ZAS Thread settings 为权威。Title model 与 Thread ModelCatalog 分离。

## 3. Product shell 与导航

### 3.1 默认布局与核心导航

- 默认 Agent 页面是 **Thread Sidebar + Chat** 两栏。中等宽度可以压缩密度，但仍保持该层级；窄屏才把 Sidebar 变为抽屉。
- Inbox 是品牌区的 icon-only 模式切换，不是 Projects / Inbox segmented control。Inbox 中每个 Thread 必须明确显示 Project 归属。
- Sidebar 的 Thread 列表只展示 active Threads。Archived Threads 的查看与 Unarchive 统一位于 Settings，不在 Sidebar 提供 Active / Archived switch。
- 核心 Sidebar 顺序是：品牌区与 Inbox、可选 Plugin spaces、显式 New thread、Projects/active Threads、左下 Settings。
- **New thread** 是独立、全宽、有文字标签的 row，位于 Plugin spaces 与 Projects 之间。
- **Settings** 是左下常规导航 row，不是浮动齿轮 tile。
- 插件只能使用受控 Plugin spaces contribution slot；它们不能重排、隐藏或覆写 Inbox、New thread、Projects/Threads 或 Settings。

### 3.2 Project 与 Thread 创建

- Projects 标题旁提供 icon-only **Add project**，具备 tooltip、accessible name、focus state 和完整 hit target。
- 每个 Project 提供 hover/focus 可达的 quick-create action，并用该 Project 的 cwd 创建 Thread。
- 存在 Project 时，全局 New thread 使用仍有效的 last-used Project。
- 没有 Project，或 last-used Project 已移除/失效时，全局 New thread 打开 ZenX directory picker，让用户明确选择 Project。
- 任何创建路径都不得回退到 Documents、`process.cwd()`、隐藏默认 Project 或其他隐式 cwd。
- 选择或创建 Thread 后进入 Agent page；移动端同时关闭 Sidebar drawer。

### 3.3 原生应用菜单与按需面板

- Packaged Windows/Linux 不安装 Electron 默认 application menu；macOS 只保留系统合规的 application、edit 和 window roles。原生菜单不得引入第二套产品导航。
- 不提供常驻右侧 Activity rail。Tool details 留在聊天流内；Workspace/Artifact 使用按需面板。
- Thread header 只保留职责明确的 search 与按需 Workspace/Artifact icon entry，不使用常驻 “Workspace” 文本按钮、空 overflow 或装饰性状态控件。

## 4. Interaction 与 state rules

### 4.1 Thread row 与管理菜单

- Thread management menu 存在于每个 Thread row，触发器使用正常重量的 horizontal ellipsis。
- ellipsis 默认视觉隐藏，只在 row hover、keyboard focus/focus-within 或菜单打开时显示。选中 row 本身不让它常驻。
- 隐藏状态不得拦截 pointer input；显示状态保留完整 hit target、accessible name、tooltip 和 focus ring。
- 菜单按当前生命周期提供 Rename、Archive/Unarchive、Pin/Unpin。
- Archive 在 active Turn 期间禁用。Thread 切换后也必须先恢复权威 running state，不能因本地选择变化短暂放开 Archive。
- Sidebar 只有 active Threads，因此 Unarchive 的 row 位于 Settings → Archived Threads；它可以复用同一管理模式。
- Escape 只在菜单或弹层确实打开时关闭并归还焦点，不得在无菜单时抢走当前焦点。
- Thread title、ellipsis 与状态在紧凑宽度下不得重叠。异步 summary/read 结果必须有 freshness fence，旧结果不能覆盖较新的 Thread 选择。
- 不提供永久 Delete。

### 4.2 Turn 状态与 disclosure

| Turn 状态             | 默认展示                   | Turn 级交互    | Agent Message                         |
| --------------------- | -------------------------- | -------------- | ------------------------------------- |
| Running / incomplete  | 完整展开历史               | 不允许整体收起 | 显示全部中间消息                      |
| Completed，默认       | 只显示 Final Message       | 可主动展开     | 隐藏中间消息，只保留 Final            |
| Completed，用户已展开 | 历史 Items + Final Message | 可再次收起     | 中间消息恢复，Final 仍只出现一次      |
| Interrupted / failed  | 按完成态投影并显示终止结果 | 可展开历史     | 保留明确的 interrupted/error fallback |

- Running Turn 不渲染可操作的 Turn collapse；运行状态文案只表达当前工作。
- Turn 完成后进入默认收起，但后续刷新不得反复覆盖用户已做出的 disclosure 选择。
- 如果完成后没有 Final Message，显示明确 fallback，不留下空 Turn。
- Final Message 是完成结果，不能与中间 Agent Message 重复渲染。

Trace Group projection 按 Item 顺序生成：

1. 遇到 Thinking 或 Tool Call，开始或继续当前 Trace Group。
2. 遇到 Agent Message、Final Message、approval 或其他独立 Item，结束当前 Trace Group。
3. 不按工具类型、状态或时间重新排序。
4. 流式追加只更新最后一个仍可合并的组，避免重建整个 Turn。

Trace Group 默认收起，只显示轻量摘要、Item 数量和 disclosure icon。展开后，每个 Thinking / Tool Call row 仍默认收起；row 使用一致的密度、字号、间距和 disclosure 行为，以图标、标签和状态区分。组关闭后可以把组内 Items 恢复为收起，但该行为必须稳定、可预测。

Tool 状态统一投影为 `queued / running / success / failed / cancelled / approval_required`。状态更新同一个稳定 Item，不创建重复 row；长 payload 在摘要截断，在详情内换行或局部滚动。

### 4.3 Message 与 Trace 视觉层级

以下是 visual guidance，不是协议或状态要求：

- 用户消息使用右对齐气泡；Agent Message 左侧自然排版，不使用气泡或重复头像轨道。
- Agent Message 与 Trace Group 位于 Turn 的同一一级流中，不制造错误缩进。
- 正文优先可读宽度、行高和段落节奏；Trace 比正文更小、更弱。
- Trace Group 保持轻量，不使用厚边框或每一步一个大卡片。
- Thinking 与 Tool row 采用一致的紧凑视觉；完成色保持克制，避免大量成功状态争夺注意力。
- 代码块属于相邻 Agent Message 内容，可以有容器，但不能被误认为 Tool Call。

### 4.4 Composer、审批与 live following

Composer 保持一个位置、几何和命中区域稳定的 primary action，只改变语义：

| Run 状态 | Draft     | Primary action   |
| -------- | --------- | ---------------- |
| Running  | Empty     | Stop             |
| Running  | Non-empty | Interrupt & Send |
| Idle     | Non-empty | Send             |
| Idle     | Empty     | Send disabled    |

- 不拆成常驻 Stop、Steer 和 Send 三个按钮。
- 状态切换不引发 Composer 几何跳动；按钮保持清晰图标、准确 `aria-label` / tooltip 和适合当前输入方式的 hit target。
- 附件、模型、权限与 primary action 共享视觉基线，并按宽度与优先级渐进隐藏。
- 不在 Composer 重复显示 Turn 已经表达的运行时长或状态。
- Approval bar 位于聊天流与 Composer 之间，不塞入 Trace Group 或 Composer toolbar。
- 用户处于实时底部时，新 Item 自动跟随；用户向上阅读后，不改变滚动位置，并显示 **Back to live**。
- Back to live 返回实时底部后才恢复自动跟随。流式 patch 不得丢失 disclosure、焦点或草稿。
- Tool completion 与 Final Message / Turn completion 的到达顺序可能不同；UI 等到可展示终态后再切换完成态投影。

### 4.5 Settings 与 onboarding

- Settings 是 routed page，因此不提供冗余 Done。
- Settings 明确管理 Archived Threads、Provider/Account 和 Plugins；General 可以承载其他 host-local preferences，但不能改变这些核心分区的所有权。
- restart-required changes 使用内容区内的 contextual **Apply & restart**。只有存在未应用的 dirty changes 时才 enabled/emphasized；pending、success 和 failure 留在当前 route 明确反馈。
- 本地 service state 是弱状态信息，只能在相关内容区提供诊断或说明；它不得成为 Settings navigation item、挤占导航，或盖过用户可执行设置。
- 未配置 host 的首次启动进入 provider onboarding；Subscription、OpenAI-compatible API 与 local demo 的 credential/configuration 仍遵守 Host/Core 安全边界。
- Settings → Plugins 是已安装插件的统一管理入口。Agent page 不散落 Marketplace、安装、grant 或 Provider configuration panel。

## 5. Responsive 与 accessibility

### 5.1 Responsive rules

- 宽屏保持 Sidebar + Chat 两栏，正文与 Composer 维持可读最大宽度。
- 中等宽度收紧 Sidebar、正文 padding 和低优先级 Composer controls，但不破坏两栏层级。
- 窄屏把 Sidebar 变为 drawer，主内容全宽；点击 scrim 或按 Escape 关闭。
- Composer 保持可见，底部区域不得遮挡最后一条消息。
- 所有容器使用 `min-width: 0`、可换行文案和受控溢出，禁止页面级横向滚动。
- 响应式隐藏不得留下不可见 focus target、改变逻辑 keyboard order，或让隐藏 action 拦截 pointer input。
- 触控布局中的 disclosure、Item row 和 icon action 使用至少 `44px × 44px` 的可操作目标；这是交互命中约束，不是截图坐标。

### 5.2 Keyboard、focus 与 motion

- disclosure 使用原生 `button` 或等效语义，同步维护 `aria-expanded`；折叠内容使用 `hidden` 或等效语义。
- Enter / Space 可操作 Turn、Trace Group、Item、plugin switch 和 icon action。
- 所有按钮保留清晰 `:focus-visible`；hover-only Project quick-create 与 Thread action 通过 focus/focus-within 获得等价可见性。
- Drawer、menu 和 dialog 打开后管理焦点；Escape/outside-click 关闭后把焦点返回触发器。
- Icon-only action 必须有可读 `aria-label`，纯装饰图标使用 `aria-hidden="true"`。
- 动画遵守 `prefers-reduced-motion`。
- Projects 或其他可折叠区域必须始终有可恢复入口，不能通过连续折叠留下无法退出的空 Sidebar。
- Directory picker 的 Back、Backspace、根目录和空 selection 状态都必须安全，不得因缺失 focus/ref 崩溃。

## 6. Plugin contribution UI

### 6.1 Contribution 边界

- Plugin 通过 manifest 声明受控 `sidebar` / `page` contributions，不取得 DOM、router 或核心导航的修改权。
- Sidebar 只开放一个 Plugin spaces slot。Host 使用稳定的 `pluginId:contributionId` key 投影已启用 contribution。
- Plugin spaces 位于 New thread / Projects 之前；全部为空时整个区域隐藏，核心导航自然上移。
- Plugin page 运行在受控 ZenX shell 中，复用顶部层级、颜色、focus 和 responsive rules；不能注入常驻右栏。
- 禁用 plugin 后，对应 contribution 和 route 不再可达；跨 plugin dependency 同步隐藏或显示有解释的 disabled state。
- Plugin 不能改变 Chat、Composer、Thread Item 层级或核心导航顺序。

### 6.2 管理状态

- Plugin enablement、Capability grant、per-call approval 和 runtime sandbox 是四个独立状态，UI 不得合并成一个 switch。
- “Installed” 不等于 “Granted”。Local package 必须先通过 manifest、provider、resources 和 integrity 验证，才能授权或暴露 tools。
- Tool-only packages 可以启用但没有 Sidebar contribution。Triggers / Rooms 同时提供 tools 和各自独立的 page/sidebar contribution。
- Grant/Revoke 或其他 restart-required mutation 使用 Settings 的 Apply & restart 模式，并保留 pending/success/failure/retry feedback。
- Provider diagnostics、permission 和 `foreground_required` 配置属于 Capability management；单次 Tool Call 参数、状态、结果和错误仍在聊天流 Item 中展示。
- Marketplace 不进入当前核心导航。未来 catalog/distribution 设计不得把 remote store 假装成已经存在的 capability registry 语义。

### 6.3 Triggers 与 Rooms

- Triggers 与 Rooms 是两个同级 plugin，不是 ZenX 核心导航。任一禁用只撤销自己的 contributions 和 tools。
- Trigger 是 ZenX 外层产品状态；命中后由同一个 ZAS 发起普通 canonical Turn，不建立第二套 Agent execution history。
- Trigger 类型包括 Timer、Thread turn completed、Room @mention 和 External signal。Room @mention 依赖 Rooms；Rooms 未启用时必须隐藏或显示有解释的 disabled state。
- Trigger overview/history 位于 plugin page；Thread 内只保留按需入口，不恢复常驻 Activity rail。
- Room 不是 Thread，也不拥有 Agent Runtime。它只保存共享消息、成员和有界路由上下文。
- Room 展示结论，不复制成员 Thread 的 Thinking / Tool Trace。Agent Room message 保留 `originThreadId` / `originTurnId` 并提供 Source Thread 跳转。
- Room member name / Thread binding 在同一 Room 内保持唯一；mutation 失败保留草稿并明确允许 retry。
- Signal simulator 必须明确标识为 local development tool，不能伪装成已上线的外部 event integration。

## 7. Implementation acceptance

### 7.1 推荐展示职责

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

“canonical Item → display node” projection 应优先写成 pure function；components 负责局部 interaction state 与 rendering。组件拆分是建议，不是新领域抽象。

### 7.2 数据与失败边界

- 正式实现绑定 canonical Item、ZAS events、Host plugin manifests、grants、approval、provider config 和 runtime state，不复制 prototype data model。
- Item streaming、tool status 与 disclosure 更新同一稳定 identity，避免 DOM 重建造成 focus/scroll loss。
- Query、mutation、provider、archive 和 restart failure 都在相关页面明确告知用户；不得建立 UI durable repair state machine。
- Stale async reads 不能覆盖较新 selection；active-Turn gating 不能因切换 Thread 或 summary refresh 丢失。
- Provider credential、subscription、API configuration、workspace config 和 local Pin state 均遵守各自外层 owner，不写入 canonical Items。

### 7.3 验收清单

- [ ] 默认是 active Thread Sidebar + Chat 两栏；Inbox 只由品牌区 icon 切换。
- [ ] Sidebar 无 Active/Archived segmented control；Archived Threads 只在 Settings 管理并可 Unarchive。
- [ ] New thread、Add project 和 Project quick-create 都可发现、可聚焦，并遵守显式 Project cwd 规则。
- [ ] canonical cwd aliases 归一为一个 Project，同时保留稳定 display path。
- [ ] Pinned section 只改变 Sidebar prominence，不改变 Inbox/runtime/scheduling。
- [ ] Thread row 只显示 local Provider logo + model name；unknown provider 使用 generic fallback。
- [ ] Horizontal ellipsis 只在 hover、focus-within 或 menu open 时显示；selection 不让它常驻。
- [ ] Thread menu 提供 Rename、Archive/Unarchive、Pin/Unpin，不提供 permanent Delete。
- [ ] Settings 使用左下 navigation row、routed page 和 dirty-only Apply & restart；没有 floating gear 或 Done。
- [ ] Tool details 位于 chat flow，approval 位于 Composer 上方，没有常驻 Activity rail。
- [ ] Running Turn 始终展开；Completed Turn 默认只显示一次 Final Message并可展开历史。
- [ ] Agent Message 不嵌套在 Trace Group；连续 Thinking/Tool Items 保持顺序并被轻量聚合。
- [ ] Composer 在 Stop、Interrupt & Send、Send 和 disabled 之间正确切换且几何稳定。
- [ ] 离开实时底部后显示 Back to live，streaming 不破坏 scroll、focus、draft 或 disclosure。
- [ ] 宽屏、紧凑桌面和移动 drawer 均无页面级横向滚动或 action/title overlap。
- [ ] Enter、Space、Escape、outside-click、focus return 和 reduced motion 行为正确。
- [ ] Plugin contributions 只能出现在 Plugin spaces / controlled pages，不能重排核心导航。
- [ ] Browser console 无由上述交互产生的 warning/error。

## 8. Prototype boundary

静态原型可继续用于视觉回归和讨论，但以下内容不是当前产品事实：

- 静态 Thread、Turn、Trace、Trigger、Room、账户、模型、权限数量和时间文案。
- 固定 plugin 数量、`Plugin spaces` label、contribution count 和演示排序。
- 演示用 `pluginState`、模拟保存/重启延迟、Toast、Signal simulator 和审批文案。
- 合成品牌标记、配色常量、内嵌 SVG 与某次截图的宽度、坐标和 DOM count。

需要调整 durable semantics 时更新本文；只调整视觉校准时也应说明它没有改变状态归属、导航语义或 interaction contract。Git 历史负责保存旧决策，不在仓库中维护第二份当前规则。
