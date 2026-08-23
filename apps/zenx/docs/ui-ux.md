# ZenX UI/UX decisions

更新日期：2026-08-23

## 1. 文档权威与规则等级

本文是 ZenX 当前 UI/UX durable product decisions 的**唯一权威文档**。正式实现、接口对接、设计评审和验收均以本文为准。

`prototypes/high-fidelity/zenx-high-fidelity-prototype.html` 是特定时点的静态设计快照。本文已经合并该原型中仍需保留的规则和后续已确认决策；后来的已确认决策优先于静态原型、历史截图、一次性验收记录和演示数据。变更当前规则时直接更新本文，不新增平行设计说明，也不从旧原型反推产品行为。

本文使用四类规则：

- **Durable product semantics**：状态归属、导航层级、产品对象和交互结果。实现必须遵守，直至新的已确认决策直接改写本文。
- **Interaction/state rules**：用户可观察的状态机、反馈、键盘和焦点行为。实现可以改变内部组件结构，但不能改变这些结果。
- **Visual guidance**：密度、比例、动效和断点方向。可以随平台与可用性验证调整，但不能破坏 durable semantics、信息层级或无障碍要求。
- **Experiment / TBD**：仍在验证或尚未决定的 IA、视觉与交互方案。它们可以指导原型，但不是实现合同，也不能进入验收清单，直到用户明确确认并把它们升级到前述规则。

本文不能改变 `ARCHITECTURE.md` 的 Core、ItemList、Project 和协议边界。若 UI 需求需要新的领域抽象或不可推导会话状态，必须先按仓库规则更新架构文档。

## 2. Durable product semantics

### 2.1 权威数据与产品投影

- Zen App Server（ZAS / `AppServer`）是按 `threadId` 路由 Thread、驱动 `AgentRuntime` 并广播 Item events 的唯一服务入口；它拥有 ZenX Agent / Thread / Turn 主流程的 authority。
- ZenX 是围绕同一个 ZAS 构建的 Electron 产品。Electron main 托管并组合本机 ZAS host，同时持有 desktop-only host profile、capability、Trigger / Room 等外层产品状态；renderer 经 main/preload typed IPC 消费产品投影。
- 目标 ZenX Host 同时拥有并列的 ZAS/AppServer 与 Plugin Host 服务。Plugin Host 负责插件生命周期、UI/tool 注册与 Runtime 路由，但不拥有 Agent、Thread、Turn 或 transcript；人类直接操作插件 UI 不创建 Turn，只有显式 **Run Agent** 才调用 AppServer。
- 目标 ZAS 暴露稳定、带认证、可供其他应用连接的 endpoint。关闭最后一个窗口只关闭 UI，不停止 ZenX Host；显式 Quit 才停止 Host 和 ZAS。本阶段不做 OS daemon。当前实现仍使用 child-host 临时 loopback endpoint，且 Windows/Linux 关闭所有窗口会退出，因此这项是目标合同而非已完成行为。
- Renderer、native IPC 与外层产品功能不复制 ZAS 的 Agent、Thread、Turn、transcript 或 scheduler authority。Codex protocol 是同一 ZAS 面向兼容客户端的 wire adapter；Codex DTO 不反向定义 ZenX 产品模型，也不是 renderer 的产品读取路径。
- Thread 会话内容与执行结果来自 append-only canonical ItemList。流式 delta 只用于实时显示，不能被 UI 当作第二份 durable history。
- Thread 列表产品数据来自 ZAS native `ThreadSummary` / `CurrentMetadata` read model，经 Electron main/preload typed IPC 投影。
- Thread 的名称与归档由 ZAS 产品元数据负责；当前选择、disclosure、草稿、打开的菜单和面板属于 renderer-local UI 状态。
- Archive 是当前已定义的可逆生命周期操作。本阶段 ZenX 不直接删除 journal，也不伪造 App Server 尚未定义的 Delete；永久 Delete 的 ownership、恢复、附件与历史语义仍为 **TBD**，这里不是永久产品禁令。
- Pin 是 profile-local ZenX 产品状态。Pinned Thread IDs 不进入 canonical Items、不跨设备同步，也不改变 runtime priority、scheduling priority 或 Inbox ordering；Pin 只允许改变本地 Sidebar prominence。Pin 不改变 Thread 的 owning Project，也不清除其 Project 内排序偏好。是否使用独立 Pinned section、放置位置与该 section 自身的排序规则仍为 **TBD**。
- Project 与 Thread 的 Sidebar 顺序是 Settings-owned host-profile local preference，不是 canonical Item/journal fact，也不跨设备同步。Project 使用 canonical Project key 排序；Thread 顺序按 owning Project 分区保存，排序操作不能改变 cwd、Project identity 或把 Thread 移到另一 Project。
- 持久化顺序是 preference list：仍存在的已知 ID 按记录顺序出现；未知或新出现的 Project/Thread 按当前稳定投影顺序追加；已移除的 ID 被忽略，并可在后续用户排序写入时自然修剪。Settings mutation 按用户操作调用顺序串行化，最后一次操作获胜。

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

### 3.1 品牌与 Logo

- 产品壳必须保留正式 **ZenX logo / wordmark** 的位置。Provider logo 只用于 Thread 的 Provider / model identity，不能替代 ZenX 产品标识；原型中的合成品牌标记不是正式资产。
- [ZenX Logo 概念参考板](assets/brand/zenx-logo-concept-board.png) 是用户制作的设计概念参考：两个相同组件在中心形成连接，概念说明以 overlap 表达 symmetry、connection 与 infinite potential，同时配合 ZENX 字标。平面构造图中的 X 两件组件在中心接缝相接，不共享内部几何区域。
- Production ZX 由用户确认的概念板 04 黑白轮廓经过机械阈值分割、闭合区域填充和 Potrace 曲线拟合生成：Z 与 X 保持两个独立 path，X 两片在源轮廓中分离并在 compact mark 中保留为两个独立构件；不嵌入 raster，不保留线稿 stroke，也不把金属效果带入 canonical SVG。概念板保持 byte-identical，是用户创作的唯一设计来源；mechanical SVG 是其工程化派生资产。字标仍是无字体依赖的路径化光学校准近似。
- 资产角色：`zenx-symbol.svg` 是完整 Z + X 符号，`zenx-lockup.svg` 用于较大品牌场景，`zenx-wordmark.svg` 是无字体依赖的路径字标，`zenx-mark.svg` 是方形 app / Sidebar 小标。Renderer 只经 `ZenXBrand` 的可替换 asset seam 使用 mark 与 wordmark，不把几何写入布局/CSS，也不与 Provider branding 混用。
- 小尺寸默认使用 compact X center-seam mark：16 / 20 / 24 / 32px 均保持一个单色 silhouette；低于 16px 不使用。完整 symbol、lockup 和 wordmark 不在 32px 小图标位压缩。对比预览中的压缩 ZX 方案在 32px 以下过密，因此不作为产品资产。
- Canonical SVG 使用透明背景、稳定 `viewBox` 和 `currentColor` 单色填充。直接内嵌时设置 `color`；作为外部 asset 时由组件用 CSS mask 投影当前文字色。深色背景使用浅色，浅色背景使用近黑色，并保持清晰对比；不通过 outline、shadow 或滤镜补偿低对比。
- macOS application icon 使用独立的 `1024×1024` vector source：近黑平面圆角 tile + 暖白 compact mark，图形限制在 80px source safe area 内；`.icns` 由同一 source 的 16–1024px deterministic raster set 生成。该固定双色是 application-icon fill contract，不改变 canonical monochrome masters。
- `ZENX` 字标按概念板可见的宽体几何笔画进行路径化光学近似，不声称复刻未知 proprietary font；其字宽、横画与字距只服务于与原板一致的技术感。
- 金属、发光、压印、材质、outline 和展示板阴影只属于 presentation treatment，不进入正常产品 UI、canonical SVG 或 app icon。
- [Production contact sheet](assets/brand/zenx-brand-preview.svg) 以确定性 SVG 展示深/浅背景、16 / 20 / 24 / 32 / 64 / 128 / 512px、compact mark、完整 symbol / lockup、wordmark、compact 方案对比与 macOS icon safe area。

### 3.2 默认布局与核心导航

- 默认桌面 Agent 页面是 **Thread Sidebar + Chat** 两栏。
- Inbox 是品牌区的 icon-only 模式切换，不是 Projects / Inbox segmented control。Inbox 中每个 Thread 必须明确显示 Project 归属。
- Sidebar 的 Thread 列表只展示 active Threads。Archived Threads 的查看与 Unarchive 统一位于 Settings，不在 Sidebar 提供 Active / Archived switch。
- 已确认的 Sidebar anchors 是品牌区与 Inbox、Projects/active Threads，以及左下 Settings。可选 Plugin spaces 位于完整的 Projects group 之前，不能插入 Projects header 与 Project/Thread list 之间。
- **Settings** 是左下常规导航 row，不是浮动齿轮 tile。
- 插件只能使用受控 Plugin spaces contribution slot；它们不能重排、隐藏或覆写 Inbox、New thread、Projects/Threads 或 Settings。

**Experiment / TBD — New thread IA：** 是否使用独立全宽文字 row、它相对 Plugin spaces / Projects 的准确顺序，以及全局入口与 Project quick-create 的关系都尚未决定。现有原型与 issue 中的排布只能作为实验，不能据此锁定最终导航。

### 3.3 Project 与 Thread 创建

- Projects 标题旁提供 icon-only **Add project**，具备 tooltip、accessible name、focus state 和完整 hit target。
- Add project 使用 ZenX 只读 directory picker；Thread 创建最终必须解析为明确的 cwd，并消费同一个 canonical Project projection。
- **Experiment / TBD：** Project quick-create 是否保留、全局 New thread 是否复用 last-used Project，以及 last-used 失效时是否直接打开 picker，均属于最终 New thread IA 的待定部分。不得把 Documents、`process.cwd()` 或隐藏默认 Project 当成已经确认的产品 fallback。

### 3.4 原生应用菜单与按需面板

- Packaged Windows/Linux 不安装 Electron 默认 application menu；macOS 只保留系统合规的 application、edit 和 window roles。原生菜单不得引入第二套产品导航。
- 不提供常驻右侧 Activity rail。Tool details 留在聊天流内；Workspace/Artifact 使用按需面板。
- Thread header 只保留职责明确的 search 与按需 Workspace/Artifact icon entry，不使用常驻 “Workspace” 文本按钮、空 overflow 或装饰性状态控件。
- Workspace/Artifact 面板的最终内容组成与 tabs 仍为 **TBD**。早期原型中的 Files / Trigger / Room 等内容不是已确认合同；Trigger 与 Room 作为 plugin 不能被预设为核心 Workspace tabs。

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
- 当前菜单不暴露未定义的永久 Delete；未来是否提供以及它的产品合同仍为 **TBD**。
- Projects mode 中每个 Project header 与 owning Project 内的非 Pinned Thread row 提供轻量 reorder handle。handle 默认隐藏，只在 row/header hover、focus-within 或自身 focus 时出现，不占据默认视觉注意力；窄 Sidebar 仍保留完整可点击区域且不得造成 title/action overlap。
- Pointer drag 可以全局重排 Project；Thread drag 只接受同一 owning Project 内的 drop。跨 Project drop 不产生 mutation，也不改变 cwd、selection、Pin、active Turn、menu、disclosure 或 archive semantics。
- 每个 reorder handle 都是可聚焦 button，并以 Arrow Up / Arrow Down 执行等价移动；移动完成或保存失败后，焦点确定性返回同一个被移动对象的 handle。键盘路径与 pointer 路径使用同一 Settings mutation 与 reconciliation 规则。

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
- Conversation stream 中的 Agent Message 不显示重复的 assistant logo/avatar + “ZenX” identity row；Completed Turn 的 **Worked for** disclosure 或 Running Turn 的 **Working** 状态直接成为首条 metadata，正文与 inline Trace / Tool affordance 紧随其后。此规则不影响产品壳/Sidebar 的 ZenX 品牌，也不影响 Thread row 的 Provider logo + model identity。
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
- 运行中有草稿时，**Steer** 是保留当前 Turn 的显式次要动作；稳定 primary action 同时切换为 **Interrupt & Send**，用于中断当前路径并发送草稿。两者不得静默互相降级，也不得隐藏用户选择的是 soft steer 还是 hard steer。
- 状态切换不引发 Composer 几何跳动；按钮保持清晰图标、准确 `aria-label` / tooltip 和适合当前输入方式的 hit target。
- Composer toolbar 只显示一个组合 **Model** 控件，按钮将当前模型与 effort 并列显示（例如 `5.6 Sol High`）；同一可达的键盘菜单分别进入 Model 与 Reasoning 选择，Reasoning 只列当前 `(providerProfileId, modelId)` 在 `model/list` 中明确支持的 effort。已知空能力显示 unavailable；当前模型不在可运行目录或能力未知时显示 Unknown / unavailable，不猜测选项。两项配置都只影响下一次 Turn，运行中的 Turn 保持启动时 selection。
- 模型切换复用 App Server 的原子 Thread settings 更新；当前 effort 被目标支持时保留，否则使用目标模型的 default effort。运行中的 Turn 保持启动时冻结的 selection，变更从下一 Turn 生效。
- 已删除 Provider 或 hidden / Unknown / 不可运行模型的历史 Thread 仍可阅读，但 Composer 在开始或替换 Turn 前明确要求用户选择可运行模型，不自动改写或切换；当前 Turn 的 Steer 仍沿用其冻结 selection。
- 已确认的视觉校准是缩小 primary action 的**可见圆形轮廓**，但不随之大幅缩小内部图标，也不缩小完整交互 hit target。
- Composer 底部 toolbar 整体更贴近容器底边；这是相对位置指导，不锁定截图坐标或像素值。
- 附件、模型、权限与 primary action 共享视觉基线，并按宽度与优先级渐进隐藏。
- 不在 Composer 重复显示 Turn 已经表达的运行时长或状态。
- Approval bar 位于聊天流与 Composer 之间，不塞入 Trace Group 或 Composer toolbar。
- 用户处于实时底部时，新 Item 自动跟随；用户向上阅读后，不改变滚动位置，并显示 **Back to live**。
- Back to live 返回实时底部后才恢复自动跟随。流式 patch 不得丢失 disclosure、焦点或草稿。
- Tool completion 与 Final Message / Turn completion 的到达顺序可能不同；UI 等到可展示终态后再切换完成态投影。

### 4.5 图片草稿与预览

- Composer 的 typed draft 同时保存文字与有序图片引用；可以只发送图片。picker、clipboard paste 与 drop
  均支持一次加入多张 PNG / JPEG / GIF / WebP，顺序与用户选择或系统提供的文件顺序一致。
- picker 与 payload 读取只经 Electron main/preload 的 typed image boundary；renderer 草稿和 canonical journal
  不以 base64 或源文件路径为权威。导入或读取失败在 Composer 附近明确显示并保留现有草稿。
- 每张待发送图片显示紧凑、有稳定占位尺寸和 accessible name 的缩略图；删除一张不得清除文字或其他图片。
  picker、paste、drop 与 thumbnail 更新不得改变既有 Enter / Shift+Enter、组合 Model / Reasoning menu 或 primary action 语义。
- 已选模型明确不支持 image 时，Send / Interrupt & Send 在进入 Provider 前阻断并保留完整草稿。
  Unknown 必须显示为 Unknown，并提供“尝试发送”以及 Settings 中显式 probe / 手动配置的恢复入口；
  Unknown 不得冒充 unsupported。文字草稿的普通发送行为不受影响。
- transcript 从 canonical `user_message` 的 `AttachmentRef` 投影图片；send 后与 resume 后使用同一渲染路径。
  缩略图可用鼠标或键盘打开应用内 modal preview；Escape、关闭按钮和 backdrop 可关闭，关闭后焦点返回触发缩略图。

### 4.6 Settings 与 onboarding

- Settings 是由左下导航进入的 routed page。Settings 顶部动作的最终合同仍为 **TBD**；“不提供 Done”以及“只在 dirty 时显示或强调 Apply & restart”是当前设计实验，不是 durable semantics。
- Settings 明确管理 Archived Threads、Provider/Account 和 Plugins；General 可以承载其他 host-local preferences，但不能改变这些核心分区的所有权。
- Settings → Models & providers 展示所有稳定 Provider profiles，并让用户以明确的
  `Provider display name · model ID` 选择全局 Default model 与 Title model；相同 model ID
  可以属于不同 profile，选择器不能把它们合并。Profile 内的结构化 ModelCatalog 使用可聚焦的
  重复行编辑，不使用单个 textarea。已有 OpenAI-compatible profile 可以通过所选 profile 的
  credential/transport 获取 `/models` ID 与明确 modality metadata，并按完整 ID 用核验目录补全；
  Unknown reasoning、input 与 context 必须原样显示，用户展开模型行后可以显式写入 manual capability override，
  或对已保存的 Unknown model 明确触发一次提示可能计费的极小图片 probe。UI 不从名称猜测能力。
- Known Provider 新增入口只提供当前已有生命周期的 OpenAI subscription 与 local demo；
  custom OpenAI-compatible 入口编辑 display name、Provider name、base URL、API key replacement
  和 model IDs。稳定 profile ID 既不展示也不可编辑；已保存 API key 永不回显，空白表示保留。
- Z05 UI 至多配置一个 OpenAI subscription profile；Account 的登录、登出与手动 code
  始终路由到这个 profile，而不是假定固定 ID。删除它会清理 profile-scoped OAuth credential，
  但不会恢复或改写历史 Thread。
- Provider row 只陈述可证明的配置/认证状态（API key 已保存、subscription 已登录、本地测试），
  不把 credential presence 呈现成 live connectivity。删除当前 Default/Title 所属 profile 时，
  UI 必须收集对应替换选择并通过一次 host mutation 原子提交；其他 profile 正常删除，既有
  Thread 选择保持 ZAS 权威且不由 Settings 自动切换。
- Settings → General 的 Appearance 提供 System / Light / Dark。它是 renderer-local app-profile
  preference，切换立即生效且不触发 host restart；System 实时跟随操作系统。解析后的 Light / Dark
  必须在首屏前写入根文档并驱动同一套语义 token、原生控件 `color-scheme` 与组件实现，不能成为
  Core / Thread / Project 状态或平行主题框架。Light 保留 ZenX 的冷中性层级、紫蓝强调色、密度与
  单色品牌资产，Dark 保持既有视觉稳定。
- restart-required changes 必须在当前 route 明确反馈 pending、success 和 failure；具体使用顶部或内容区动作、动作名称、何时 enabled/emphasized，待 Settings action contract 确认。
- 本地 service state 是弱状态信息：Sidebar 左下 Settings row 的最右侧显示一个不单独可点击的状态点，hover tooltip 与 Settings 的 accessible name 提供具体状态；它不再占用独立文字行，也不得盖过用户可执行设置。主区仍保留 starting、reconnecting 与 error 的阻断说明。
- 未配置 host 的首次启动进入 provider onboarding；Subscription、OpenAI-compatible API 与 local demo 的 credential/configuration 仍遵守 Host/Core 安全边界。
- Settings → Plugins 是已安装插件的统一管理入口。Agent page 不散落插件管理 UI；它必须表达 `installed` / `enabled` / `uninstalled` 生命周期。Bundled plugin 也可卸载并以后重装；卸载默认保留数据，“删除数据”是独立显式动作。
- 插件工具策略只呈现默认 `full_access` 与可选 `ask_unknown`。后者按稳定 tool name 展示 Host-owned approved/denied 结果；未知工具只询问一次。不为现有 capability grants 延续 risk level、scope graph、参数权限矩阵或复杂 grant UX。

## 5. Responsive 与 accessibility guidance

当前已确认范围是：桌面保持 Sidebar + Chat 层级，其他宽度不破版、不遮挡核心内容或产生不可达 controls。准确 breakpoint、导航压缩方式、是否以及如何使用 mobile drawer、scrim 和移动端视觉细化优先级仍为 **TBD**。

### 5.1 Responsive baseline guidance

- 宽屏以 Sidebar + Chat 两栏和可读的正文 / Composer 宽度为基线。
- 中等宽度可以收紧 Sidebar、正文 padding 和低优先级 Composer controls；窄屏可以实验 drawer 或其他导航压缩方案，但这些不是已经确认的精确交互合同。
- Composer 与最后一条消息不能互相遮挡；容器使用可换行文案和受控溢出，避免页面级横向滚动。
- 响应式隐藏不能留下不可见 focus target、改变逻辑 keyboard order，或让隐藏 action 拦截 pointer input。
- 触控目标保持可操作尺寸；`44px × 44px` 可作为 accessibility baseline，而不是已确认的截图几何或最终移动端视觉规格。

### 5.2 Keyboard、focus 与 motion guidance

- disclosure 使用原生 `button` 或等效语义，同步维护 `aria-expanded`；折叠内容使用 `hidden` 或等效语义。
- Enter / Space 可操作 Turn、Trace Group、Item、plugin switch 和 icon action。
- 所有按钮保留清晰 `:focus-visible`；任何 hover-only action 都要有等价的 keyboard path。
- 若采用 drawer、menu 或 dialog，打开后管理焦点；Escape/outside-click 关闭后把焦点返回触发器。
- Icon-only action 必须有可读 `aria-label`，纯装饰图标使用 `aria-hidden="true"`。
- 动画遵守 `prefers-reduced-motion`。
- Projects 或其他可折叠区域必须始终有可恢复入口，不能通过连续折叠留下无法退出的空 Sidebar。
- Directory picker 的 Back、Backspace、根目录和空 selection 状态都必须安全，不得因缺失 focus/ref 崩溃。

## 6. Plugin contribution UI

### 6.1 已确认的 contribution 边界

- 当前 capability registry、typed plugin snapshot 与 sidebar/page projection 只是可运行骨架，不代表 Generic UI Host、Plugin UI SDK、隔离第三方 renderer 或完整 install/uninstall 已实现。Triggers 与 Rooms 当前是两个 bundled capability packages，目标是迁移为同级 Plugin Packages，而不是 ZenX 核心导航。
- 目标 Generic UI Host 支持 sidebar、pages/subroutes、settings、panel、commands/menu 与 namespaced result renderers。第一方 bundled plugin 与隔离运行的第三方 plugin 使用同一逻辑 Plugin UI SDK，不建立两套 contribution 语义。
- 已启用 plugin 可以使用这些受控 surfaces，但不取得核心 DOM、router、Chat、Composer、Thread Item 层级或导航 authority。第三方 UI/runtime 必须隔离；第一方信任边界不同也不允许绕过逻辑 SDK。
- Sidebar 的 Plugin spaces 位于**整个 Projects group 之前**。Plugin contribution 不能插入 Projects header 与 Project/Thread list 之间，也不能把这个 group 拆成两段。
- 人类使用插件页面、settings、panel、command/menu 或普通领域 action 不创建 Turn；只有标为 **Run Agent** 的显式动作才调用 AppServer 并产生普通 canonical Turn。
- Plugin 生命周期只有 `installed`、`enabled`、`uninstalled`。Disable 撤销 active UI/tools 但保留安装；Uninstall 撤销 runtime/UI/tool 注册并默认保留 data。Bundled plugin 也可卸载和重装；删除 data 必须是独立动作。
- Result renderer 只读取既有 `ToolResultItem` 上的可选 structured content；它缺失、disabled 或 uninstalled 时使用 text/JSON fallback。历史模型文本、reasoning、tool call/result 与 title trace 保持原样，不能为 renderer 或能力变化扫描、脱敏或重写。

### 6.2 Experiment / guidance / TBD

以下内容尚未获得最终产品确认，不能作为 durable UI contract：

- manifest、version 与 Provider diagnostics 的准确用户呈现；
- Plugin contributions 的准确数量、label、排序、稳定 key、次级 routes 与冲突处理；
- 禁用/卸载时 in-flight calls 的准确 UI，以及安装、更新、重装的具体 controls 和 action contract；
- `ask_unknown` 首次询问、approved/denied 管理与 restart-required changes 的准确 controls；
- Triggers / Rooms 的准确 page layout、Trigger 类型展示、Room dependency 提示、Source Thread 跳转、Signal simulator 与 error/retry 文案。

Marketplace、签名、dependency solver、risk scoring 与复杂 permission/sandbox 框架明确不在本阶段，不能以 TBD 名义预埋。Architecture 与当前实现可以定义 package、runtime 和 Trigger/Room 数据边界，但这些事实不会自动决定最终 UI。确认前，原型与 issue 中的具体表现只作为实验或工程 guidance。

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

- 正式实现绑定 canonical Item、ZAS events、Host plugin manifests、`full_access` / `ask_unknown` policy、approval、provider config 和 runtime state，不复制 prototype data model，也不把当前 capability grants 当成目标插件权限模型。
- Item streaming、tool status 与 disclosure 更新同一稳定 identity，避免 DOM 重建造成 focus/scroll loss。
- Query、mutation、provider、archive 和 restart failure 都在相关页面明确告知用户；不得建立 UI durable repair state machine。
- Stale async reads 不能覆盖较新 selection；active-Turn gating 不能因切换 Thread 或 summary refresh 丢失。
- Provider credential、subscription、API configuration、workspace config 和 local Pin state 均遵守各自外层 owner，不写入 canonical Items。

### 7.3 验收清单

- [ ] 默认是 active Thread Sidebar + Chat 两栏；Inbox 只由品牌区 icon 切换。
- [ ] Sidebar 无 Active/Archived segmented control；Archived Threads 只在 Settings 管理并可 Unarchive。
- [ ] 产品壳保留正式 ZenX logo/wordmark 位置；Thread Provider logo 不替代产品标识。
- [ ] Add project 可发现、可聚焦，并遵守 canonical Project cwd 规则；New thread 最终 IA 不作为本轮验收合同。
- [ ] canonical cwd aliases 归一为一个 Project，同时保留稳定 display path。
- [ ] Pin 只改变 profile-local Sidebar prominence，不改变 Inbox/runtime/scheduling；不假定独立 Pinned section 或排序。
- [ ] Project 可在 Sidebar 全局拖动排序；Thread 只可在 owning Project 内排序，跨 Project drop 不产生 mutation，也不改变 cwd/Project identity。
- [ ] Sidebar 排序在 host profile 中本地持久化并按 preference list reconcile；新/未知项稳定追加、已移除项忽略，重复并发操作最后一次获胜。
- [ ] Reorder handle 仅在 hover/focus 时出现；Arrow Up/Down 提供等价键盘操作并把焦点恢复到被移动对象，窄宽度下仍可操作。
- [ ] Project/Thread 排序不改变 selection、Pin、active Turn、menus、focus recovery 或 archived semantics。
- [ ] Thread row 只显示 local Provider logo + model name；unknown provider 使用 generic fallback。
- [ ] Horizontal ellipsis 只在 hover、focus-within 或 menu open 时显示；selection 不让它常驻。
- [ ] Thread menu 提供 Rename、Archive/Unarchive、Pin/Unpin；本阶段不伪造未定义的 Delete，但不把未来 Delete 写成永久禁令。
- [ ] Settings 使用左下 navigation row，并管理 Archived Threads、Provider/Account 和 Plugins；顶部 action contract 不作为本轮验收合同。
- [ ] Tool details 位于 chat flow，approval 位于 Composer 上方，没有常驻 Activity rail。
- [ ] Running Turn 始终展开；Completed Turn 默认只显示一次 Final Message并可展开历史。
- [ ] Agent Message 不嵌套在 Trace Group；连续 Thinking/Tool Items 保持顺序并被轻量聚合。
- [ ] Composer 的 Steer、Stop、Interrupt & Send、Send 和 disabled 均语义明确；primary action 切换时几何稳定。
- [ ] Composer primary action 的可见圆更小但图标和 hit target 不随之大幅缩小；底部 toolbar 更靠近容器底边。
- [ ] picker、paste 与 drop 可按稳定顺序加入多张受支持图片；图片-only draft 可发送，单张删除不改变文字或其他图片。
- [ ] unsupported image capability 在 Provider 前精确阻断并保留草稿；Unknown 显示提示且仍可尝试发送；text-only 与既有 pending action 不回归。
- [ ] send / resume 后 transcript 从 canonical AttachmentRef 渲染；preview 可由鼠标/键盘打开，以 Escape/关闭/backdrop 关闭并归还焦点。
- [ ] 离开实时底部后显示 Back to live，streaming 不破坏 scroll、focus、draft 或 disclosure。
- [ ] 不同宽度下无页面级横向滚动或 action/title overlap；不假定最终 breakpoint 或 mobile drawer contract。
- [ ] Enter、Space、Escape、outside-click、focus return 和 reduced motion 行为正确。
- [ ] Plugin contributions 只能出现在 Plugin spaces / controlled pages，不能重排核心导航或拆开 Projects group。
- [ ] Generic UI Host 覆盖 sidebar、pages/subroutes、settings、panel、commands/menu 与 result renderers；第一方和隔离第三方使用同一逻辑 SDK。
- [ ] 普通 plugin UI action 不创建 Turn；只有显式 Run Agent 经 AppServer 创建普通 Turn。
- [ ] Disable 撤销 active UI/routes/tools 并保留安装；Uninstall 对 bundled/third-party 都撤销注册、允许重装且默认保留 data；Delete data 是独立动作。
- [ ] Plugin result renderer 不可用时历史 ToolResult 使用 text/JSON fallback，canonical trace 不被改写。
- [ ] 关闭最后一个窗口后 Host/ZAS 继续服务稳定认证 endpoint；显式 Quit 才停止，且不依赖 OS daemon。
- [ ] Browser console 无由上述交互产生的 warning/error。

## 8. Prototype boundary

静态原型可继续用于视觉回归和讨论，但以下内容不是当前产品事实：

- 静态 Thread、Turn、Trace、Trigger、Room、账户、模型、权限数量和时间文案。
- 固定 plugin 数量、`Plugin spaces` label、contribution count 和演示排序。
- 演示用 `pluginState`、模拟保存/重启延迟、Toast、Signal simulator 和审批文案。
- 合成品牌标记、配色常量、内嵌 SVG 与某次截图的宽度、坐标和 DOM count。

需要调整 durable semantics 时更新本文；只调整视觉校准时也应说明它没有改变状态归属、导航语义或 interaction contract。Git 历史负责保存旧决策，不在仓库中维护第二份当前规则。
