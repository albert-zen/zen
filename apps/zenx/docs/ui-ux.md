# ZenX UI/UX decisions

更新日期：2026-10-05

New thread 打开临时本地编辑页；选择或添加 Project 不创建 Thread，第一条有效 Send 才配置所选 Project 或分配无项目目录、创建真实 Thread，并在 Sidebar、usage 等辅助元数据独立刷新时立即启动 Turn。全局入口使用最近 Project，Project 内入口使用该精确 Project；失败以明确、可恢复且不遮盖会话的通知呈现。

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
- ZenX 是围绕同一个 ZAS 构建的 Electron 产品。Electron main 托管并组合本机 ZAS host 与 Plugin Host；desktop-only host profile 仍由宿主持有，Trigger / Room 状态则由各自 Plugin Package 的 namespaced storage/service 持有，renderer 只经 Generic UI Host SDK 消费其 contribution，不存在产品专用 Trigger / Room IPC。
- 目标 ZenX Host 同时拥有并列的 ZAS/AppServer 与 Plugin Host 服务。Plugin Host 负责插件生命周期、UI/tool 注册与 Runtime 路由，但不拥有 Agent、Thread、Turn 或 transcript；人类直接操作插件 UI 不创建 Turn，只有显式 **Run Agent** 才调用 AppServer。
- ZenX Host 通过稳定的私有 descriptor 暴露唯一 ZAS 的带认证 loopback endpoint。关闭最后一个窗口只关闭 UI，不停止 ZenX Host、active Turn 或外部连接；activation 重建窗口，显式 Quit 在 macOS、Windows、Linux 都撤销发现入口并停止 Host / ZAS。本阶段仍不做 OS daemon。
- Renderer、native IPC 与外层产品功能不复制 ZAS 的 Agent、Thread、Turn、transcript 或 scheduler authority。Codex App Server（CAS）compatibility mapping / claim 只覆盖 ZAS 中固定 0.146.0 可表达且已验收的子集；当前共用 endpoint/shape 不使 CAS 成为 ZenX 产品读取路径或产品模型权威。
- 持久日志是事实与恢复真相源，当前权限、队列等只是日志投影/缓存；关键 queue/config/control 变更未持久成功不得 ACK。ItemList 仅承载模型语义上下文；Trace 记录真实输入、输出、工具及运行观察，流式显示不能成为第二份可编辑历史。
- Thread 列表产品数据来自 ZAS native `ThreadSummary` / `CurrentMetadata` read model，经 Electron main/preload typed IPC 投影。
- Thread 的名称与归档由 ZAS 产品元数据负责；当前前台 Thread 选择、disclosure、草稿和打开的菜单属于 renderer-local UI 状态。Thread / Room 辅助侧栏的开合、全屏、标签顺序与选择由同一个 main-process revision/CAS presentation store 从已提交 Trace 事实恢复，JSON 仅作缓存；它不是会话历史。后台更新只改变所属工作区，不抢占当前前台、焦点或读取文件/打开网页。Room 使用相同工作区界面，资源标签保留原 member Thread 归属，成员移除后不可借用其他成员执行。PAW 默认 Room 来自 trusted runtime 专属绑定，不与私有 Thread 侧栏双向同步。
- 人类开合/全屏侧栏立即反映本地操作，不等待 Trace fsync 或 JSON 缓存写入。此临时视觉状态不是持久成功回执，不增加 revision，不授予资源/权限；后台 Host 继续原有 CAS 和 durable Trace 提交，失败清除预览并显示实际错误。连续操作保留最新视觉意图，其他工作区的状态变化不能抢占当前视图。
- Archive 是当前已定义的可逆生命周期操作。本阶段 ZenX 不直接删除 journal，也不伪造 App Server 尚未定义的 Delete；永久 Delete 的 ownership、恢复、附件与历史语义仍为 **TBD**，这里不是永久产品禁令。
- Pin 是 profile-local ZenX 产品状态。Pinned Thread IDs 不进入 canonical Items、不跨设备同步，也不改变 runtime priority、scheduling priority 或 Inbox ordering；Pin 只允许改变本地 Sidebar prominence。Pin 不改变 Thread 的 owning Project，也不清除其 Project 内排序偏好。Projects Sidebar 使用独立 Pinned section，其展示顺序就是 profile-local `pinnedThreadIds` 列表顺序：新 Pin 前置，用户可以在 Pinned section 内用拖拽或 Alt+方向键交换相邻行来调整顺序；排序只置换 `pinnedThreadIds`，不写入 Thread 的 Project 内排序偏好，也不是 canonical fact。
- Project 与 Thread 的 Sidebar 顺序是 Settings-owned host-profile local preference，不是 canonical Item/journal fact，也不跨设备同步。Project 使用 canonical Project key 排序；Thread 顺序按 owning Project 分区保存，排序操作不能改变 cwd、Project identity 或把 Thread 移到另一 Project。
- 持久化顺序是 preference list：仍存在的已知 ID 按记录顺序出现；未知或新出现的 Project/Thread 按当前稳定投影顺序追加；已移除的 ID 被忽略，并可在后续用户排序写入时自然修剪。Settings mutation 按用户操作调用顺序串行化，最后一次操作获胜。

### 2.2 Project 身份与 cwd

- Project 是 ZenX 基于 host-profile workspace 与 Thread cwd 派生的产品投影，不是 Core/runtime 对象，也不是 repository aggregate。
- 配置的 Project 与普通外部 Thread 继续使用 **one canonical cwd = one Project**；Host 明确分配并在 profile 记录的无项目目录归入“无项目”会话组，不逐个注册成 Project。显式把该精确 cwd 添加为 Project 时，以配置为准。symlink/junction aliases 指向同一 filesystem cwd 时必须归一为一个 Project identity，同时保留稳定、可理解的用户 display path。
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
    ├── Trace sequence（singleton 直接显示；连续 2+ 为 Trace Group）
    │   ├── Thinking Item
    │   ├── Tool Call Item
    │   └── ...
    ├── Agent Message Item
    └── Final Message Item
```

- Turn 是一段按顺序追加的 Items，不是独立时间线数据库。
- Agent Message 是 Turn 内一级 Item，不能嵌入 Thinking/Tool 容器。
- Trace sequence 是可丢弃的 UI projection：连续序列只有一个 Thinking / Tool Call Item 时直接显示该 Item，达到两个或更多时才显示 Trace Group；它不需要成为 Core 或协议实体。
- Thinking 与 Tool Call 在 sequence 内仍是独立 Item，保留 canonical 顺序和稳定 ID。
- Tool details 位于聊天流中对应 Trace Item 的 disclosure；不迁移到第二份执行 transcript 或常驻 Activity rail。
- 审批是 active Turn 的瞬态交互，显示在 Composer 上方；最终执行或拒绝仍由 canonical tool result 表达。
- `run_code` 审批必须显示完整 code 与 cwd，并准确说明批准单位是稳定、与 shell 权限等同的
  `run_code` capability，而不是某一代码片段或 hostile-code sandbox。长 code/path 在卡片内换行或
  局部滚动；响应成功后键盘焦点返回 Composer，错误时保留可操作卡片。

### 2.4 Provider 与模型身份

- Thread row 以完整标题为第一层，第二层仅显示运行或待审批状态；Provider/model 降为标题 tooltip，当前生成配置仍在 Composer 中可见。
- 预设 Provider 使用随 ZenX 分发的本地正式品牌 asset；未知 Provider 使用克制的 generic fallback。
- Thread row 不显示 Provider 文本、内部 `modelProvider`、API/订阅标签或 Fake 品牌。
- Provider 类型、账户、订阅状态、API key 和 endpoint 配置只在 Settings / onboarding 中出现，不进入 Thread 或 canonical Items。
- Default model 影响新 Thread；已有 Thread 的当前模型以 ZAS Thread settings 为权威。Title model 与 Thread ModelCatalog 分离。

### 2.5 Fleet 就绪与人工配对

- Fleet 是任意 Agent 可发现的普通插件能力；PAW 只消费相同工具，预设不拥有设备、权限或特殊连接流程。默认安装保留用户显式 Disable / Uninstall 与既有工具权限。
- Setup 的只读就绪检查只报告已知设备和当前准备条件，不扫描网络、不创建信任；不同网络之间必须已经有可达的可信 HTTPS 路径或已配置 relay。
- 人工邀请只为已启用 Host 的既有 endpoint 创建五分钟单用配对码。接收端先核对 Host ID / endpoint，默认 Read Only、shell 关闭；明确确认后才配对并另行检查可达性。已配对与检查成功是分别呈现的事实。
- Fleet Settings 以机器列表为主入口：一个 Connect machine 打开有焦点约束的连接对话框，先选邀请 / 既有 SSH / 手动 HTTPS 配对，再显示对应字段。配置 ID 和机器用途属于按需详情；空 ID 由当前机器名称派生唯一的 profile-local 标识，不改变远端 Host identity。已有设备的编辑 / 移除位于行内操作菜单，本机监听、证书、relay 与客户端授权在 Hosting & access disclosure 中。展开或切换连接方式不创建连接或扩张授权。
- 新连接的普通字段仅在当前 Fleet 页面的 renderer 内保留，切换方式或取消后重开可继续填写；编辑既有机器的 Cancel 丢弃未保存修改。邀请、配对码、信任确认不进入这些保留字段。手动配对提交即清除代码，失败仍保留普通字段和就近错误，需要新的代码才能重试；重复提交只产生一次请求。
- 邀请和配对码只存在于人工界面的易失交互与用户明确选择的复制动作中；不进入模型发现、保存的草稿或公共配置。取消、过期、离开页面或提交尝试清除输入；隐藏已发出的邀请不伪装成撤销远端授权。

## 3. Product shell 与导航

### Sidebar navigation sections

全局新建会话入口保留在固定顶部，紧随其后的插件入口共同构成操作区；主滚动区保留现有滚动方式，先显示插件入口，再进入展示区，依次为独立置顶、既有 PAW / Room 导航、项目、最近。置顶不能出现在插件入口上方，也不嵌在项目标题之下。置顶标题复用项目、最近、PAW 和 Room 标题的字号、字重与颜色，不单独加粗。置顶、项目、最近分别可折叠并保留本地展开偏好。项目内既有展开与排序保持不变，不引入自定义分区对象。无项目会话只在最近与可选置顶中导航，不在项目区增加“无项目”伪文件夹；其工作目录与会话详情不变。

最近按现有 ThreadSummary 的 updatedAt 降序展示所有当前可见未归档会话（包含项目会话与无项目会话，子 Agent 仍遵循显式可见偏好）；它是同一会话的导航投影，不复制 Thread。首批显示 30 条，用户可连续展开更多。重复出现在置顶/项目/最近的行使用独立无障碍 ID；平台数字快捷键按可见顺序对同一 Thread 去重。

最近标题旁的新建动作明确打开无项目草稿，不继承最近项目、不要求选目录；第一条有效 Send 才分配工作目录并创建真实 Thread。全局与项目内新建入口保持已有选择语义。折叠或打开导航不创建会话、不发模型请求。

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
- 已确认的 Sidebar anchors 是品牌区与 Inbox、Projects/active Threads，以及左下 Settings。插件功能入口与内建功能平级，位于完整的 Projects group 之前，不能插入 Projects header 与 Project/Thread list 之间。
- **Settings** 是左下常规导航 row，不是浮动齿轮 tile。
- 插件只能使用受控导航 contribution slot；它们不能重排、隐藏或覆写 Inbox、New thread、Projects/Threads 或 Settings。

New thread 保留独立 row，插件入口紧随其后且位于置顶等展示区之前；全局入口与 Project 内入口的选择和创建语义保持不变。

### 3.3 Project 与 Thread 创建

- Projects 标题旁提供 icon-only **Add project**，具备 tooltip、accessible name、focus state 和完整 hit target。
- Add project 使用 ZenX 只读 directory picker；Thread 创建最终必须解析为明确的 cwd，并消费同一个 canonical Project projection。
- Project 内入口把被点击 Project 作为唯一作用域；全局入口使用仍有效的 last-used Project，否则显示“无项目”选择。用户也可在同一个选择器显式选择“无项目”；首条有效 Send 时由目标 Host 在其 ~/.zenx/workspaces/YYYY-MM-DD/首条请求安全短名称（独立于 Core 的 ~/.zen；显式 ZENX_DATA_DIR 隔离环境将其限定在该隔离根的 workspaces 下） 分配独立持久目录，碰撞时创建唯一目录，不复用旧目录、不自动初始化 Git。目录创建或 profile 记录失败时明确失败，不派发 Thread 创建。既有 Documents/ZenX 目录及登记保持原处，不自动搬迁；改标题不改目录名，归档不删除目录。不以 process.cwd() 或默认 Project 隐式替代。
- 点击入口、切换 Project 或目录确认只更新非持久本地 draft；第一条有效 Send 才配置 Project、创建 Thread，并立即启动 Turn，不等待 summaries / Project projection。失败必须不遮盖当前页面，并提供恢复 draft 的直接重试路径。
- Agent 入口直接打开同一个 welcome draft，不显示单独的未选择 Thread 页面。welcome 中央 Project 控件可以在首发前切换和搜索 Project；候选列表有视口内最大高度并只在列表内部滚动。Composer 旁的 Project chip 与机器切换使用同一交互体验：可点击打开同一个带搜索、键盘导航与 Add project 的 Project popover，不是只读展示。
- welcome draft 的未发送输入按 Project（含独立的“无项目”选项）分别保留在 renderer-local 状态（与 Thread Composer 草稿同一层级，不持久化、不进入 journal/profile）：切到 Thread 或其它页面再回到某个 Project 的 New thread 时恢复该 Project 的未发送文本与图片；不同 Project 各自保留互不覆盖；首发成功创建 Thread 后该 Project 的保留内容即被消费。首发前的 Project 切换因此是在两个 Project 的 draft 之间交换，而不是把文本跟随过去。welcome 保持紧凑并相对主内容列视觉居中，不使用通用 compose 装饰图标。

### 3.4 原生应用菜单与按需面板

- Packaged Windows/Linux 不安装 Electron 默认 application menu；macOS 只保留系统合规的 application、edit 和 window roles。原生菜单不得引入第二套产品导航。
- 桌面窗口使用与产品壳连续的 integrated title bar，并把产品行、会话行与原生窗口控件分成明确的命中区域：macOS 顶行左侧为 traffic lights 留出空间并紧接 Sidebar 展开 / 收起入口，右侧直接承载 Thread 标题、cwd 与 Thread actions；ZenX mark / wordmark 与 Inbox 共同位于其下方的 Sidebar 产品行，因此左侧原生控件不会把右侧会话行整体下压。Windows / Linux 在顶行左侧显示 ZenX 品牌与 Inbox，并保留独立的 Sidebar 展开 / 收起按钮；右侧顶行只留给原生 minimize / maximize-restore / close 和拖动区域。所有宽度下，会话标题、主操作区与右栏 Tab 都从第二行开始，左侧 Sidebar 保持原有起点，不随主区再下移。展开时左侧顶行与整列 Sidebar 使用同一 Sidebar surface，右侧会话标题栏与 Workspace 使用同一 main surface；唯一的 1px 语义竖分割线从窗口顶部贯穿到底，右侧标题栏底线必须精确从该竖线开始，不使用圆角或 card 式壳层过渡。系统窗口控制仍由 Electron/OS 持有，产品按钮与 Thread 标题控件均是 no-drag，剩余表面才是 drag region。Sidebar 收起后 Chat 使用完整内容宽度，标题栏保留可恢复 Sidebar 的明确入口；该偏好只属于本机产品壳，不进入 Thread 或 canonical Items。
- 不提供常驻右侧 Activity rail。Tool details 留在聊天流内；Workspace/Artifact 使用按需面板。
- Thread header 只保留一个按需工作区 icon entry；上下文与 cache telemetry 位于 Composer。不显示 Search 或 Archive 控件，也不使用常驻 “Workspace” 文本按钮、空 overflow 或装饰性状态控件。归档能力继续位于 Thread 管理菜单与 Settings。
- 右侧工作区只有一个并排容器和一个顶部入口，不再叠加旧 Workspace 模态抽屉。顶层只显示实际内容 Tab（文件名、浏览器页面、Computer 或插件注册的视图），加号选择新内容类型；不再先按 Browser / Files 分类再选择二级内容。插件贡献进入加号选择器，打开后按自身 surface 展示；Trigger 与 Room 不硬编码为核心 tabs。关闭和展开始终避开原生标题栏控件。Markdown 使用连续可编辑的实时预览：光标进入或触及格式节点时局部露出源码，离开后恢复渲染，自动保存，不提供常规 Edit / Preview / Save 按钮；失败与磁盘冲突在文件内处理，不覆盖未保存输入。
- 工作区 Tab 的自动 reveal（选择、重排或可见宽度变化）按完整标签的 leading edge 对齐，保留 active Tab 的图标、标题和关闭入口；末端只补足对齐所需的尾部空间。窄栏可缩短标签文字，不固定最小 Tab 宽度。原生水平滚动仍可自由停在标签中段；不为本修新增导航按钮、强制 wheel 吸附或持久化滚动状态，键盘切换不让浏览器再次改写 reveal 位置。 不可见的末端布局 spacer 不参与视觉过渡，包括 reduced-motion；新增内容菜单能放下时保持居中，超高时从可滚动顶部开始，首末项的键盘焦点必须可见。

## 4. Interaction 与 state rules

### 4.1 Thread row 与管理菜单

- 结束提示从本线程实际开始执行后产生的 canonical 终态 ID 推导，复制/fork/导入的历史闭合不算新结束；已读先后采用稳定的终态序号，不受系统时钟回拨影响。不能用中间 Agent 文字、兼容 phase、流式 delta 或 updatedAt 代替。新运行会抑制旧提示而不标记已读；仅在前台有焦点、已结束 Turn 的真实尾部进入阅读范围后清除。选择/hover、隐藏子线程、后台 tab、未聚焦窗口和断线后的临时 interrupted 投影不构成确认。已明确观测到的当前连接实时终态保存一份去重的待查看身份，跨 reload 保留且不被安装时间基线或时钟回拨吞掉；native resume 屏障转交的当前 epoch 重叠事件同样算实时观测，自动重连在 ready 后转交且握手未完成时暂存；恢复旧快照本身不产生这种观测。若结束完全发生在离线期间、恢复无重叠事件且从未建立终态已读游标，时间又回拨到安装基线之前，则保守静默，不能从未知冷历史猜测新结束。缺少新 summary 字段的旧服务保持静默。升级旧消息游标时只初始化一次 Thread 终态基线，旧历史不重新亮点（因此升级前真正未查看的旧结束也不会补提醒）；Room 消息计数与游标保持原语义。

- Thread 标题用满除真实状态以外的可用宽度。仅有活跃的 Trigger 时用时钟表示，运行用明确 spinner；时钟位于 spinner 左侧，最新执行已结束但尚未查看用独立的小点（正常完成、失败、确认中断均可，空回复与纯工具结束也可；仍运行、等待工具/审批、停止未确认时不亮）。详细密度不在模型名旁重复显示 Working 文字；运行图标保留可访问的 Running 标签，审批文字仍可见。reduced-motion 使用静态进度图形与可读状态。管理三点只在 hover / keyboard focus / 菜单打开时显示，渐变表面覆盖标题尾部，不永久空留操作栏；无 hover 的触屏保留可见的 44px 操作入口。 时钟、进度与三点使用相同 16px 图形画布和等距槽位；尾部遮罩覆盖会话行整高，左缘圆弧配柔和渐变、右缘沿行圆角，不露出上沿文字。
- Hover / row keyboard focus 打开右侧非模态详情；不抢焦点，浮层可跨间隙进入并点击，Arrow Right 进入完整名称，Escape 关闭并还焦点。完整名称按钮直接进入原有 Thread rename；触屏三点内提供同样完整信息。详情显示已知 Project、机器、最近 canonical 消息时间以及活跃 Trigger 的最早有效未来时间和活跃数量；过期、读取失败或缺失投影明确不可用，不从 updatedAt 推断消息时间，不从 timer interval 私算下次运行。只有事件型 Trigger 显示符合条件时触发，不虚构时间；无活跃 Trigger（包括全部暂停、已完成或插件禁用）时隐藏时钟与下次触发行。用户可见名称统一为英文 Trigger / Triggers、中文触发器，保留既有协议与存储标识。
- Thread 与 PAW/Room 名称保持各自对象身份。改名使用原有权威命令，Enter 保存、IME Enter 不提交、Escape 取消；保存中防重复、失败保留草稿并显示错误，晚到回执不能关闭新编辑器、改变新选择或抢走焦点。

- Thread management menu 存在于每个 Thread row，触发器使用正常重量的 horizontal ellipsis。
- ellipsis 默认视觉隐藏，只在 row hover、keyboard focus/focus-within 或菜单打开时显示。选中 row 本身不让它常驻。
- 隐藏状态不得拦截 pointer input；显示状态保留完整 hit target、accessible name、tooltip 和 focus ring。
- 菜单按当前生命周期提供 Rename、Archive/Unarchive、Pin/Unpin。
- Archive 在 active Turn 期间禁用。Thread 切换后也必须先恢复权威 running state，不能因本地选择变化短暂放开 Archive。
- Sidebar 只有 active Threads，因此 Unarchive 的 row 位于 Settings → Archived Threads；它可以复用同一管理模式。
- Escape 只在菜单或弹层确实打开时关闭并归还焦点，不得在无菜单时抢走当前焦点。
- 按住平台切换修饰键（macOS Cmd，其它平台 Ctrl）时，线程快捷键提示独占行尾空间；标题为该提示预留宽度，运行、Trigger、未读状态和 hover/focus 操作区整体左移，不能与提示重叠。松开修饰键或窗口失焦后恢复普通布局。
- Thread title、ellipsis 与状态在紧凑宽度下不得重叠。异步 summary/read 结果必须有 freshness fence，旧结果不能覆盖较新的 Thread 选择。
- 当前菜单不暴露未定义的永久 Delete；未来是否提供以及它的产品合同仍为 **TBD**。
- Projects mode 中 Project 标题与 owning Project 内的非 Pinned Thread row 可直接拖动；标题按钮显式启用 native draggable，行内动作按钮不启动排序。
- Project 按标题上下半区判断 before/after，插入线画在整个 Project group 的前/后边界；展开的线程数量不影响标题命中。Thread 按自身行的上下半区判断，插入线画在对应行边界。两层复用主题 accent 的亮线，线程排序期间列表位置保持稳定，松手后才保存顺序；离开目标、取消或结束拖动立即清除提示。
- Project 在相同置顶状态的项目间排序；跨置顶分区不显示可投放提示、不产生 mutation。Thread 只接受同一 owning Project 内的 drop，不改变 cwd、selection、Pin、active Turn、menu、disclosure 或 archive semantics。
- 拖动项目时暂时隐藏其子列表，保持组件实例与保存的展开偏好，结束或取消后恢复；标题的 aria-expanded 同步临时视觉状态。拖动线程不折叠 Project。
- 拖动来源变淡，项目预览保留文件夹图标；线程预览复用原行的标题与当前状态样式，不添加线程图标，保留来源行尺寸及鼠标抓取坐标，避免拖起时跳到光标右侧；长标题省略。指针靠近 Sidebar 滚动区上/下边缘时按接近程度连续滚动，移回中央或移出区域停止。drop、dragend、Escape、失焦与卸载统一释放临时状态和滚动动画。
- 当前不新增菜单上移/下移（用户明确低优先级）；保留既有键盘排序。
- 聚焦 Project 标题或 Thread row 后可用 Alt+Arrow Up / Alt+Arrow Down 等价移动；完成或保存失败后，焦点返回同一对象。键盘与 pointer 路径使用同一 Settings mutation 与 reconciliation 规则。

### 4.2 Turn 状态与 disclosure

| Turn 状态             | 默认展示                   | Turn 级交互      | Agent Message                                           |
| --------------------- | -------------------------- | ---------------- | ------------------------------------------------------- |
| Running / incomplete  | 完整展开历史               | 不允许整体收起   | 显示全部中间消息                                        |
| Completed，默认       | 只显示 Final Message       | 可主动展开       | 隐藏中间消息，只保留 Final                              |
| Completed，用户已展开 | 历史 Items + Final Message | 可再次收起       | 中间消息恢复，Final 仍只出现一次                        |
| Interrupted / failed  | 默认收起历史并显示终止结果 | 可展开或再次收起 | 隐藏所有中间消息，保留明确的 interrupted/error fallback |

- Running Turn 不渲染可操作的 Turn collapse；运行状态文案只表达当前工作。
- Turn 完成后进入默认收起，但后续刷新不得反复覆盖用户已做出的 disclosure 选择。
- 如果完成后没有 Final Message，显示明确 fallback，不留下空 Turn。Interrupted / failed 没有实际 Final 时不得把最后一条中间 Agent Message 提升为 Final；显式收起后仅保留用户输入与终止状态，展开可恢复完整历史。运行转终态时仍保护已存在的文本选择或历史控件焦点，不覆盖用户的 disclosure 选择。
- Final Message 是完成结果，不能与中间 Agent Message 重复渲染。
- Thread 顶部与每个 Turn metadata 使用一行弱化、紧凑的 usage 摘要展示 input/output tokens
  与 cache hit rate；Thread 顶部还展示当前模型上下文占比。它只消费 Host 从 canonical ItemList
  和 host ModelCatalog 派生的 typed projection；当前产品不需要为此新增 ZAS method 或 notification。
  cache rate 是仅对报告 cache 明细的 response 做 token-weighted 聚合；有 usage 但 Provider 未报告
  cache 时显示 **Cache unknown**，不得显示 `0%`。context window 缺失时显示 Unknown；compaction
  使最新 Provider usage 代表旧上下文后，可以用当前模型消息的轻量估算恢复占比，但必须标记 estimated。
- usage 展示不包含费率、货币、成本、预算、图表或 pricing 配置；reasoning output tokens 即使
  Provider 报告也只属于 canonical usage 明细，不要求在当前紧凑摘要中展开。

Trace sequence projection 按 Item 顺序生成：

1. 遇到 Thinking 或 Tool Call，开始或继续当前 trace sequence。
2. 遇到 Agent Message、Final Message、approval 或其他独立 Item，结束当前 trace sequence。
3. 不按工具类型、状态或时间重新排序。
4. 流式追加只更新最后一个仍可合并的组，避免重建整个 Turn。

只有一个 Item 的 trace sequence 直接显示该 Thinking / Tool Call row；连续达到两个或更多 Items 时才显示 Trace Group。sequence identity 取首个 Item 的稳定 identity，因此流式追加只更新现有 sequence，不重挂载 disclosure 或丢失键盘焦点。singleton 升级为 group 时继承用户当前的展开或收起状态；用户在 Turn 运行期间显式展开或收起后，后续 streaming patch 不得覆盖该选择。

用户显式选择的 Turn、Trace Group 与 Tool row 展开/收起状态按精确 Thread / Turn / Item 身份保留；切换会话、进入 Settings 或 loading 重挂载后返回仍沿用该选择。它们仅存在于本次 renderer 内存，不写入历史或 Host 配置，也不常驻隐藏会话 DOM。

Trace Group 默认收起，主标题用中英文本地确定性模板显示自然动作摘要，不调用模型、不采用“动作 ×N”清单。摘要最多突出两个动作：上下文压缩边界优先，其余按最近出现顺序，等待/执行包装降级；省略动作保留总数提示。重复命令/消息可自然计数，图片等观察不推断资源数量。只有已确认完成的动作使用完成时态；完整调用数与原始顺序仍可展开查看。主标题显示动作集合摘要；调用总数与 Item 数量降为可访问详情，保留 disclosure icon。展开后，每个 Thinking / Tool Call row 仍默认收起；row 使用一致的密度、字号、间距和 disclosure 行为，以图标、标签和状态区分。组关闭后可以把组内 Items 恢复为收起，但该行为必须稳定、可预测。Turn 进入 completed / interrupted / failed 终态时统一折叠其中间 trace；用户随后展开完成态 Turn 时可以再次操作这些 disclosure。

Tool row 展示 Agent 工具调用自身的生命周期，不是返回结果所描述的 Terminal / 后台进程生命周期。只在当前 Turn 中调用尚未返回时显示 spinner / 活动动效；收到工具回执即为已完成，包括 yield 后进程仍运行、等待、取消或错误的回执。成功动作可用自然完成时态，错误回执只表示调用已完成，不伪造动作成功；原始错误、输出、退出码和结构化结果保留在详情。Turn 已结束但调用没有回执时，保留结果未知的事实，不以 Turn 终态伪造工具完成。后续 wait 回执不能改写先前调用的状态。聊天流不展示进程取消/待确认计数、通用后台仍运行警告或会隐式重跑 Agent 的 Retry；实际进程状态只属于独立任务/Terminal 产品状态。状态更新同一个稳定 Item，不创建重复 row；长 payload 在摘要截断，在详情内换行或局部滚动。

`run_code` outer command 与 nested `tools.*` command 仍属于同一 trace sequence。展开后，UI
只根据 ZAS protocol projection 携带的 canonical `callId / parentCallId` 缩进实际 child；不得从
显示文本、时间或本地缓存猜测层级。outer 详情展示完整 code，切回 direct 后旧 hierarchy 仍从
ItemList replay，Renderer 不保存另一份 transcript authority。

### 4.3 Message 与 Trace 视觉层级

以下是 visual guidance，不是协议或状态要求：

- 用户消息使用右对齐气泡；Agent Message 左侧自然排版，不使用气泡或重复头像轨道。
- Conversation stream 中的 Agent Message 不显示重复的 assistant logo/avatar + “ZenX” identity row；Completed Turn 的 **Worked for** disclosure 或 Running Turn 的状态/时长成为首条 metadata，正文与 inline Trace / Tool affordance 紧随其后；当前 trace 已表达真实运行/思考时，顶部不再重复泛化状态文字，但保留可访问状态和时长，审批、停止与等待仍明确可见。此规则不影响产品壳/Sidebar 的 ZenX 品牌，也不影响 Thread row 的 Provider logo + model identity。
- Agent Message 与 Trace Group 位于 Turn 的同一一级流中，不制造错误缩进。
- 正文优先可读宽度、行高和段落节奏；Trace 比正文更小、更弱。
- Trace Group 保持轻量，不使用厚边框或每一步一个大卡片。
- Thinking 与 Tool row 采用一致的紧凑视觉；完成色保持克制，避免大量成功状态争夺注意力。
- 代码块属于相邻 Agent Message 内容，可以有容器，但不能被误认为 Tool Call。

### 4.4 Composer、审批与 live following

- Composer 的普通输入与含引用的 inline editor 共享受控高度：短内容自然收缩，超过上限后只在编辑区内部滚动，正文与引用不覆盖底部工具栏。长内容滚动后全选删除必须恢复与短内容清空相同的空输入高度；撤销/重做仍保留准确原文与引用身份。此合同须在 production CSP 下验证，不能只验宽松开发页面。
- Composer 的文字输入焦点由现有中性圆角外框表达；首次插入引用切换到 inline editor 后、删除最后一个引用后与再次聚焦时均不叠加内部矩形 outline。引用按钮及其他控件保留各自的键盘焦点指示，forced-colors 下保留可见外框；不改变草稿、undo、发送或 Thread 状态语义。

Composer 保持一个位置、几何和命中区域稳定的 primary action，只改变语义：

| Run 状态 | Draft     | Primary action     |
| -------- | --------- | ------------------ |
| Running  | Empty     | Stop               |
| Running  | Non-empty | 当前配置的发送方式 |
| Idle     | Non-empty | Send               |
| Idle     | Empty     | Send disabled      |

- 不拆成常驻 Stop、Steer 和 Send 三个按钮。
- 运行中有草稿时，primary action 与 Enter 使用 Composer 自己的发送偏好：Steer now 保留当前 Turn 并追加指导；Next turn 将排队消息一起交给下一轮；Each turn 让每条排队消息各自占用一轮；Interrupt & Send 中断当前路径后开始新轮。偏好未另行选择时沿用既有 soft steer 默认；UI 不改变已排队消息的分组或交付语义。
- 普通消息的缺省投递均为 soft steer；Composer、每个 Trigger、assistant Room、IM 与 Agent 入口的配置独立，不继承 Composer 的 queue/interrupt 选择。Composer 的普通发送交给 native Core 在接纳时选 active steer / idle start，状态竞态不把普通输入静默改成下一轮 queue。
- Trigger/Room 输入以独立 Host 来源展示，不呈现成人类消息；来源的精确 ID 放详情。Host 与 Agent 排队输入可取消，不提供仅人类输入支持的 Edit；人类 queue 的编辑能力保持。
- 第一层只显示既有 primary orb，不新增常驻展开按钮。orb 位于 Composer 最右侧，与右下圆角保持既有关系；hover 与 keyboard focus 打开同一个主题化非模态面板。primary 点击始终直接发送或中断，面板顶部只出现一次当前动作与后果说明，运行中其他动作只显示真实 modifier-Enter shortcut，不发明 modifier-click 或新的发送行为。
- primary orb 保持 44px hit target 与既有较小可见圆。触摸点击直接执行当前 Send / Stop，不拦截为展开，也不添加常驻触摸选项按钮。面板内所有动作的 hit target 至少 44px 高。
- 面板不冒充 tooltip 或纯 ARIA menu：它包含可聚焦的命令与已有全局偏好 Select，使用 nonmodal dialog。Arrow Up/Down 从 orb 进入面板，Tab 按普通控件顺序导航；primary disabled 时同一命中区域保留键盘可达性以编辑偏好。Escape 关闭并把面板拥有的焦点还给 orb（disabled 时为同位置的焦点区），普通 hover/focus 不抢焦点。真实 hover bridge 与短离开延迟覆盖 pointer gap；在面板内聚焦后保持可用，outside interaction 或 Escape 可关闭。Turn/context 变化丢弃旧动作，保留草稿；持续 hover 可以显示新的当前动作，但不得保留或执行旧 Turn 的动作。
- Running 且无内容时 primary 保持红色 Stop / interrupt；纯空白文字按 Empty 处理。沿用既有 draft 判定：附件也是内容，因此只有附件时仍为发送动作，不能为了显示 Stop 丢弃附件。
- Default while running 只在面板 footer 中编辑，复用共享 Select、主题、键盘与失败反馈；选择偏好从不发送消息，保存失败保留权威旧值，晚到回复不能覆盖更新的 Settings notification。
- 状态切换不引发 Composer 几何跳动；按钮保持清晰图标、准确 `aria-label` / tooltip 和适合当前输入方式的 hit target。
- Composer toolbar 只显示一个组合 **Model** 控件，按钮将当前模型与 effort 并列显示（例如 `5.6 Sol High`）；同一可达的键盘菜单分别进入 Model 与 Reasoning 选择，Reasoning 只列当前 `(providerProfileId, modelId)` 在 `model/list` 中明确支持的 effort。没有已配置 reasoning 控制的纯文本模型显示 **Text only**，并保持可运行；当前模型不在可运行目录时才显示 Unknown / unavailable，且不根据名称猜测选项。两项配置都只影响下一次 Turn，运行中的 Turn 保持启动时 selection。
- 模型切换复用 App Server 的原子 Thread settings 更新；当前 effort 被目标支持时保留，否则使用目标模型的 default effort。运行中的 Turn 保持启动时冻结的 selection，变更从下一 Turn 生效。
- 已删除 Provider 或 hidden / Unknown / 不可运行模型的历史 Thread 仍可阅读，但 Composer 在开始或替换 Turn 前明确要求用户选择可运行模型，不自动改写或切换；当前 Turn 的 Steer 仍沿用其冻结 selection。
- 已确认的视觉校准是缩小 primary action 的**可见圆形轮廓**，但不随之大幅缩小内部图标，也不缩小完整交互 hit target。
- Composer 底部 toolbar 整体更贴近容器底边；这是相对位置指导，不锁定截图坐标或像素值。
- 附件、模型、权限与 primary action 共享视觉基线，并按宽度与优先级渐进隐藏。
- 不在 Composer 重复显示 Turn 已经表达的运行时长或状态。
- Approval bar 位于聊天流与 Composer 之间，不塞入 Trace Group 或 Composer toolbar。
- 用户处于实时底部时，新 Item 自动跟随；用户向上阅读后，不改变滚动位置，并显示 **Back to live**。
- 手动上翻、键盘阅读、展开/聚焦 transcript 或选择文字后暂停跟随，即使仍在底部附近也不自动重启。空闲会话的 ResizeObserver、Composer 高度、窗口宽度与焦点变化不吸附到底部；切换线程或页面后按精确 Thread 恢复上次阅读位置。
- Back to live 返回实时底部后才恢复自动跟随。流式 patch 不得丢失 disclosure、焦点或草稿。
- Composer（含审批条与上下文行）是浮在满高 transcript 滚动区底部的 overlay：transcript 滚动条贯穿右侧从上到下，列表底部保留与 bottom zone 等高的虚拟留白，Back to live 悬浮在 bottom zone 正上方并随其高度上移。所有可滚动表面使用统一的细滚动条。这是布局与视觉校准，不改变 live following 的交互合同。
- Tool completion 与 Final Message / Turn completion 的到达顺序可能不同；UI 等到可展示终态后再切换完成态投影。

### 4.5 图片草稿与预览

- Composer 的 typed draft 同时保存文字与有序图片引用；可以只发送图片。picker、clipboard paste 与 drop
  均支持一次加入多张 PNG / JPEG / GIF / WebP，顺序与用户选择或系统提供的文件顺序一致。
- picker 与 payload 读取只经 Electron main/preload 的 typed image boundary；renderer 草稿和 canonical journal
  不以 base64 或源文件路径为权威。导入或读取失败在 Composer 附近明确显示并保留现有草稿。
- 每张待发送图片显示紧凑、有稳定占位尺寸和 accessible name 的缩略图；删除一张不得清除文字或其他图片。
  picker、paste、drop 与 thumbnail 更新不得改变既有 Enter / Shift+Enter、组合 Model / Reasoning menu 或 primary action 语义。
  删除控件是贴在缩略图右上角的小圆形 badge（约 18px 可见圆；web pointer 为 24px hit target，touch/narrow 为 44px），不覆盖缩略图主体，也不沿用大号圆形按钮样式。
- 已选模型明确不支持 image 时，Send / Interrupt & Send 在进入 Provider 前阻断并保留完整草稿。
  Unknown 必须显示为 Unknown，并提供“尝试发送”以及 Settings 中显式 probe / 手动配置的恢复入口；
  Unknown 不得冒充 unsupported。文字草稿的普通发送行为不受影响。
- transcript 从 canonical `user_message` 的 `AttachmentRef` 投影图片；send 后与 resume 后使用同一渲染路径。
  缩略图可用鼠标或键盘打开应用内 modal preview；Escape、关闭按钮和 backdrop 可关闭，关闭后焦点返回触发缩略图。
  Transcript 附件渲染为文字气泡上方的独立紧凑缩略图行（右对齐、可换行），不被包进气泡边框内；只有存在文字时才渲染文字气泡。这是视觉校准，不改变 `AttachmentRef` 权威与投影路径。
  附件 payload 读取按 `AttachmentRef` 身份（mediaType + sha256）复用 object URL：流式重渲染、projection 刷新与 disclosure 折叠重建不重新读取、不闪回 loading 占位；未挂载 URL 只保留最近 32 个并在驱逐时释放，renderer 退出时全部释放，读取失败不缓存且后续挂载重试。

### 4.6 Settings 与 onboarding

- Settings 是由左下导航进入的 routed page。Host 设置使用独立底部 Apply 保存栏，未保存草稿跨页保留；即时外观设置在本页说明，重启仅按真实 configuration 状态提示。
- Settings 明确管理 Archived Threads、Provider/Account 和 Plugins；General 可以承载其他 host-local preferences，但不能改变这些核心分区的所有权。
- Context compaction prompt 是可选的 host-local preference；省略时使用 Core 默认。它只影响未来
  compaction summary 生成，不重写历史 Thread，也不进入 canonical ItemList。
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
- Provider 保存被拒绝时，错误显示在当前表单保存按钮旁并保留输入；仍属于本次提交的焦点才移至错误并最小滚动，切页或新的焦点意图不得被迟到回复打断。凭证错误只显示已证实的固定阶段与本地恢复建议，不回显密钥或原生错误，不提供明文存储降级。
- Account 额度卡按当前 ZenX 登录账户的真实订阅接口窗口显示剩余/已用及本地重置时间，按返回时长命名；缺失窗口与空分组不渲染，窗口内未知值不补0。进入账户页或登录成功后查询，可显式刷新；失败清空旧值，退出或切换账户使迟到响应失效，不混入 API 余额。
- Settings 的二态开关复用 plugin-switch，Agentic compaction、RTK、前台控制与外观开关保持同一命中区、焦点与禁用样式。共享 Select/Combobox 保留键盘和选择语义，使用统一主题浮层、箭头与留白，字段说明在对应控件下方。
- Z05 UI 至多配置一个 OpenAI subscription profile；Account 的登录、登出与手动 code
  始终路由到这个 profile，而不是假定固定 ID。删除它会清理 profile-scoped OAuth credential，
  但不会恢复或改写历史 Thread。
- Provider row 只陈述可证明的配置/认证状态（API key 已保存、subscription 已登录、本地测试），
  不把 credential presence 呈现成 live connectivity。删除当前 Default/Title 所属 profile 时，
  UI 必须收集对应替换选择并通过一次 host mutation 原子提交；其他 profile 正常删除，既有
  Thread 选择保持 ZAS 权威且不由 Settings 自动切换。
- Settings → Appearance 是独立分区，提供 System / Light / Dark，并让 Light 与 Dark 分别记住
  Graphite、Cobalt、Ember 三套 Zen 内置 preset；accent 提供 Azure、Iris、Jade，contrast 提供
  Standard / High，标题栏、品牌区和 Sidebar 统一使用实色背景，不提供透明开关或原生毛玻璃。它是 renderer-local
  app-profile preference，所有改动立即生效、持久化且不触发 host restart；System 实时跟随操作系统，
  Reset 恢复 System、Graphite、Azure、Standard 与 opaque Sidebar。解析后的模式、当前 preset 和控制值
  必须在首屏前写入根文档，并经同一套语义 token 同时驱动 shell、Sidebar、内容区、紧凑 live preview、
  原生控件 `color-scheme` 与基础组件，不能成为 Core / Thread / Project 状态、设置壳或平行主题框架。
  Graphite 保留 v0 的冷中性基线；Cobalt 与 Ember 通过语义角色提供可辨的冷蓝/暖中性方向，单色品牌
  资产、信息密度和键盘/focus 行为保持一致。
- 主题 token 命名、平台表面、第三方边界、静态 guard 与渐进迁移方式见
  [`themes.md`](./themes.md)。本文仍是 durable product authority；实现文档不得扩张产品语义。
- restart-required changes 必须在当前 route 明确反馈 pending、success 和 failure；具体使用顶部或内容区动作、动作名称、何时 enabled/emphasized，待 Settings action contract 确认。
- 本地 service state 是弱状态信息：Sidebar 左下 Settings row 的最右侧显示一个不单独可点击的状态点，hover tooltip 与 Settings 的 accessible name 提供具体状态；它不再占用独立文字行，也不得盖过用户可执行设置。主区仍保留 starting、reconnecting 与 error 的阻断说明。
- 未配置 host 的首次启动进入 provider onboarding；Subscription、OpenAI-compatible API 与 local demo 的 credential/configuration 仍遵守 Host/Core 安全边界。
- Settings → Plugins / Marketplace 是唯一的插件浏览与管理入口。Agent page 不散落插件管理 UI；五个永久内置条目、外部目录条目与已安装非目录 package 在同一紧凑 inventory 中合并去重，Installed 只是筛选。一个低调的 search/filter rail 是页面的主要结构；npm/Git/tarball/local-copy/dev-link 收进 **Install from source…** 高级入口。每个 inventory row 表达来源、`installed` / `enabled` / `uninstalled` / provider unavailable 状态并原位提供 Enable/Disable、Install/Update、Uninstall/Reinstall 和独立 Delete data。Bundled plugin 也可卸载并以后重装；卸载默认保留数据，破坏性操作使用有焦点的二次确认，外部目录错误与本地生命周期错误各自留在当前面板且不隐藏仍可管理的插件。
- 插件工具策略只呈现默认 `full_access` 与可选 `ask_unknown`。后者按稳定 tool name 展示 Host-owned approved/denied 结果；未知工具只询问一次。不提供 risk level、scope graph、参数权限矩阵或额外 package grant UX。

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

- IMZenX 的本机进程状态与渠道协议连接状态分别显示：只有 SDK 确认渠道 ready 才显示“QQ 已连接”；连接中、重连中、未连接、失败和状态暂不可用保持明确文字。状态更新中断或进程退出时不保留旧的已连接指示。运行后初始“确认连接”变为明确的“重新连接”，成功的前置检查不继续提示用户确认初次连接。渠道已连接不代表真实消息收发已验收。

- 当前 Plugin Package v2、Host Catalog、Runtime Supervisor、Host SDK storage migration、Generic UI Host 与完整 Settings 生命周期入口已经实现；五个第一方 package 与本地 process package 使用同一 lifecycle/runtime/discovery API，没有 legacy capability 控制区。
- 目标 Generic UI Host 支持 sidebar、pages/subroutes、settings、panel、commands/menu 与 namespaced result renderers。第一方 bundled plugin 与隔离运行的第三方 plugin 使用同一逻辑 Plugin UI SDK，不建立两套 contribution 语义。
- 已启用 plugin 可以使用这些受控 surfaces，但不取得核心 DOM、router、Chat、Composer、Thread Item 层级或导航 authority。第三方 UI/runtime 必须隔离；第一方信任边界不同也不允许绕过逻辑 SDK。
- Sidebar 的 Plugin spaces 位于**整个 Projects group 之前**。Plugin contribution 不能插入 Projects header 与 Project/Thread list 之间，也不能把这个 group 拆成两段。
- 人类使用插件页面、settings、panel、command/menu 或普通领域 action 不创建 Turn；只有标为 **Run Agent** 的显式动作才调用 AppServer 并产生普通 canonical Turn。
- Plugin 生命周期只有 `installed`、`enabled`、`uninstalled`。Disable 撤销 active UI/tools 但保留安装；Uninstall 撤销 runtime/UI/tool 注册并默认保留 data。Bundled plugin 也可卸载和重装；删除 data 必须是独立动作。
- 工具调用摘要遵循第 4.2 节的调用生命周期：实际回执到达即为调用已完成，不能把回执里的进程状态用作调用状态，不汇总工具失败、取消或 Shell 非零计数。原始输出、stderr、退出码与结构化结果保留在调用详情中；无回执保留未知事实。此为展示层选择，不改模型、canonical 结果或安全行为，也不根据 stderr 有无判断成败。
- Result renderer 只读取既有 `ToolResultItem` 上的可选 structured content；它缺失、disabled 或 uninstalled 时使用 text/JSON fallback。历史模型文本、reasoning、tool call/result 与 title trace 保持原样，不能为 renderer 或能力变化扫描、脱敏或重写。

### 6.2 Experiment / guidance / TBD

以下内容尚未获得最终产品确认，不能作为 durable UI contract：

- manifest、version 与 Provider diagnostics 的准确用户呈现；
- Plugin contributions 的准确数量、label、排序、稳定 key、次级 routes 与冲突处理；
- 禁用/卸载时 in-flight calls 的准确 UI，以及安装、更新、重装的具体 controls 和 action contract；
- `ask_unknown` 首次询问、approved/denied 管理与 restart-required changes 的准确 controls；
- Triggers / Rooms 的准确 page layout、Trigger 类型展示、Room dependency 提示、Source Thread 跳转、Signal simulator 与 error/retry 文案。

Marketplace 的统一 inventory 已确认并实现；外部 publishing/reviews/payments/accounts backend、签名、dependency solver、risk scoring 与复杂 permission/sandbox 框架明确不在本阶段，不能以 TBD 名义预埋。Architecture 与当前实现可以定义 package、runtime 和 Trigger/Room 数据边界，但这些事实不会自动决定其他尚未确认的 UI。确认前，原型与 issue 中的具体表现只作为实验或工程 guidance。

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

- 正式实现绑定 canonical Item、ZAS events、Host plugin manifests、`full_access` / `ask_unknown` policy、approval、provider config 和 runtime state，不复制 prototype data model，也不建立第二套插件权限模型。
- Item streaming、tool status 与 disclosure 更新同一稳定 identity，避免 DOM 重建造成 focus/scroll loss。
- Query、mutation、provider、archive 和 restart failure 都在相关页面明确告知用户；不得建立 UI durable repair state machine。
- Stale async reads 不能覆盖较新 selection；active-Turn gating 不能因切换 Thread 或 summary refresh 丢失。
- Provider credential、subscription、API configuration、workspace config 和 local Pin state 均遵守各自外层 owner，不写入 canonical Items。

### 7.3 验收清单

- [ ] 默认是 active Thread Sidebar + Chat 两栏；Inbox 只由品牌区 icon 切换。
- [ ] Sidebar 无 Active/Archived segmented control；Archived Threads 只在 Settings 管理并可 Unarchive。
- [ ] New thread 与其下方的插件入口构成操作区，随后才是置顶、PAW / Room、项目、最近展示区；置顶标题与其他区标题同样式、不单独加粗，折叠和重新打开后顺序不变。
- [ ] 产品壳保留正式 ZenX logo/wordmark 位置；Thread Provider logo 不替代产品标识。
- [ ] Add project 可发现、可聚焦并遵守 canonical cwd；New thread 在首次有效 Send 前不创建 Thread，且全局/Project 内入口遵守各自已确认的选择语义。
- [ ] canonical cwd aliases 归一为一个 Project，同时保留稳定 display path。
- [ ] Pin 只改变 profile-local Sidebar prominence，不改变 Inbox/runtime/scheduling；Pinned section 的拖拽与 Alt+方向键排序只置换 `pinnedThreadIds`，持久于 host profile，且不影响 Thread 在 owning Project 内的排序。
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
- [ ] Thread/Turn usage 从 canonical ItemList 的 host-local projection 派生；Thread 顶部 context
      占比同时读取 host ModelCatalog 的 context window；cache/window 缺失显示 Unknown，已报告样本按
      token-weighted rate 聚合，压缩后估算标记 estimated，且不出现成本 UI。
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

插件导航不再增加 Plugin Spaces 折叠层；所有可用入口共用与主导航一致的行、焦点和当前页面标记，较长列表在其导航区滚动。

## Thread 辅助右栏

- Thread 顶栏只有一个工作区入口；文件、Terminal、共享浏览器页面、Computer 与已注册插件 panel 都是平级内容 Tab。加号提供类型选择，不增加 Browser / Files 分类层或旧 Workspace 抽屉；即使 Browser 插件未启用，文件与人工内置浏览器仍可用。
- 默认 Browser 工具与用户共用内置真实页面，页面直接作为顶层 Tab。外部 provider 的每个目标在同一 tab strip 中以“外部 · 只读”页面展示，固定其 backend/connection/session/observer 身份；CDP 展示观察画面，isolated Playwright 展示最近一次 inspect 截图。不再单设 Agent Browser / Attached browser 入口。观察面隐藏时停止订阅，不通过展示触发 inspect 或改变模型 observationId。Computer 按明确窗口目标持续观察，隐藏或 provider 停用、替换后停止；不支持该能力时明确显示状态。
- 内置 Browser 仅在对应 Tab 图标上标记精确页面的 Agent 检查或已派发操作，不增加顶部活动文字行或动态边缘；可访问名称与 tooltip 区分检查和操作。权限开关只表示后续 Agent 操作是否获准，不把它当作正在执行的证据。人类已接管与已派发操作仍未结束的安全提示保留在现有权限开关的 tooltip 与可访问描述中，不新增文字行或改变原生页面几何；操作真实结算后才撤除图标活动标记。外部 Browser 与 Computer 只读观察不自动选择、打开或切换目标；Computer 面板的活动只来自人类已选的当前 Host 精确目标与未结算调用，未选择目标不能声称该窗口闲置。后台指定窗口、前台操作、等待人类和未知模式分别说明，截图流失败不等于调用结束，旧工具历史不能推断当前活动。
- 内置浏览器的空白页（精确 `about:blank`）跟随 App 明确的浅/深外观，而不是系统外观；仅空白文档设置背景与 color-scheme，实际网站保留自身样式与系统媒体查询，不通过全局 nativeTheme 或覆盖层伪装。导航到外站前后的异步外观更新不得污染外站。
- Browser 与 Computer 的 Agent 指针是短时的语义动作位置提示，系统鼠标和键盘焦点不用于制作动效。Browser 的共享页面、独立 Electron 和连接 Chrome 展示已执行 click/type/select 的目标；macOS bundled Computer 在有准确窗口几何的实时预览中展示 press/set_value 目标。无几何、过期、窗口尺寸变化或切换目标时不画猜测位置；Playwright、Windows 与 Peekaboo 尚不提供轨迹。减少动态效果时保留静态目标提示，取消移动效果；轨迹不拦截输入，也不是操作完成的权威凭据。全局桌面输入仍走现有显式前台接管设置，不能承诺任意原生应用完全后台运行。
- macOS 同行标题栏的 traffic lights 与左侧栏开关拥有独立、共享的 leading 安全区；右栏展开、左侧栏收起或布局动画不能让工作区 Tab、滚动轨道和拖动命中区侵入。安全区约束整个 Tab 容器，不依赖首个 Tab 的名称或顺序；窄屏仍沿用独立标题行。
- 宽窗口可以调整右栏宽度或展开；窄窗口打开右栏时使用工作区全宽，关闭返回聊天。Tab 支持左右方向键、Home/End；Escape 还原展开或关闭右栏。
- 显式展开工作区时，最左侧固定增加「主聊天 · 当前会话名称」Tab；展开本身保持当前网页、文件、子会话或选择器，不自动跳转主聊天。点击主聊天仅显示原有已挂载的主 Thread / Room 会话，保持草稿、选择与阅读状态，不创建第二份历史、Thread 或运行时。Room 的主聊天指原 Room 会话，不指其资源成员 Thread。该 Tab 不可关闭或排序，不进入持久资源描述符；普通分栏不重复显示它。还原分栏显示原主聊天和先前选中的资源，再次展开仍保留该资源；显式资源导航优先于本地主聊天选择，后台状态更新不得夺走它。 从主聊天按 Escape 还原时，若窄栏布局随即隐藏主聊天，键盘焦点回到仍选中的资源 Tab（无选中资源则回到加号）；桌面分栏中仍可见的输入焦点保持原处，不抢占较新的焦点或导航。
- Computer 后台应用键盘活动明确显示“向指定应用的当前焦点输入；应用内焦点可能变化”，不称为指定窗口/控件输入，不在旧窗口画指针或恢复截图新鲜度。它使用独立本机应用键盘权限，旧前台接管和窗口点击语义不变。
- 文件选择器从当前 Thread 的 cwd 浏览现有 UTF-8 文本，上限 1 MiB；目录最多显示 2,000 项并提示截断，不显示符号链接，拒绝解析时位于 cwd 外的路径。路径检查界定普通浏览范围，不构成防御本机进程并发替换文件树的 OS 沙箱。每个文件直接占一个顶层 Tab，Markdown 使用连续编辑与光标附近语法展开，其他文本直接编辑；自动保存，无常规 Edit / Preview / Save 按钮，Ctrl/Cmd+S 可立即提交待保存内容。保留 BOM 与未修改区域的混合换行。保存前校验读取版本，冲突保留草稿并可查看磁盘版本；不提供无提示强制覆盖。保存使用临时文件替换，并串行化 Host 内同一路径的保存，外部编辑采用乐观检查而非跨进程文件锁。草稿跨面板和 Thread 切换保留在窗口内；关闭文件先完成保存，失败保留文件和输入；丢弃冲突草稿重新读磁盘需要明确操作，窗口关闭仍有未保存内容时提示。文件不自动监视，也不缓存为会话历史。
- 文件选择器提供按需展开的文件树，以及覆盖当前 Thread 精确 cwd 的文件名/相对路径搜索；搜索不会退化成当前已展开目录的过滤。文件名是主标签，搜索结果的父路径单独显示，完整路径保留在 tooltip 和文件头。方向键导航树、左右展开/折叠，Enter 打开，Escape 清除搜索；输入法组合期间不提交。返回、切换 Thread、更新查询和刷新后，旧读取不能回填。显式“打开输入的路径”保留已知相对路径入口，仍经同一 Host 校验。
- 目录沿用每次 2,000 项限制，树最多显示 2,000 行；搜索沿用 80 结果、10,000 扫描项、32 层与 500 ms 检查预算，并明确提示部分结果；它不保证文件系统调用的硬超时。搜索跳过依赖目录、Git 元数据和符号链接，不建立索引或读取文件内容。清除搜索恢复已展开目录；刷新只重新读取根目录、可见的已展开目录和当前搜索，不重置展开、查询、当前文件、键盘位置或编辑草稿；折叠目录再次展开时读取最新列表。读取失败保留仍可操作的上次列表并明确标注未更新、实际错误与重试入口，不将失败伪装成空目录。
- 非 Markdown 文本使用带行号的轻量 CodeMirror 编辑器；JavaScript/TypeScript/JSX/TSX、JSON、CSS、HTML/SVG 与 Go 使用 CodeMirror 语言解析器，未知语言保留纯文本。超过 100,000 字符时关闭解析并提示，1 MiB 的读写上限不变。源码始终作为文本，不执行 HTML/脚本；磁盘冲突预览只读。编辑与撤销保留 BOM 和未修改区域的混合换行，磁盘替换清空旧撤销历史。
- 文件 Tab 旁保留同一份 Renderer 文件导航；切换文件或暂时收起导航不重置目录展开和搜索。选中的文件自动展开祖先并以当前文件样式标记。宽右栏采用目录/编辑器并排布局；小于 500px 的右栏上下排列。分隔条可拖动，或聚焦后用对应方向键、Home/End 调整目录大小，并限制范围以保留编辑空间；宽窄布局分别保留窗口内的调整值。文件夹开关固定在文件工作区内容区最左侧，宽栏并排、窄栏上下以及目录开合时都保持同一锚点，不跟随编辑器路径行移动；保留 tooltip、可访问名称、`aria-expanded` 和焦点。打开时使用更明显的中性实色选中背景，不使用特殊 accent。编辑器填满剩余高度，由内部滚动区访问长文件与长行，不用固定视口减值计算文件高度。导航不是新的顶层 Files 分类，不替代每个文件原有的内容 Tab。
- 文件内部查找独立于文件名搜索：文件头查找按钮或 Ctrl/Cmd+F 打开当前编辑器内的 Find，字面文本匹配显示高亮和计数，Enter/Shift+Enter 或上/下按钮导航，Esc 关闭并返回编辑器。查找不会修改源文本、触发保存、重置撤销或原有选择；导航匹配时才移动选择。Markdown 查找期间暂时展示源文本，确保隐藏的标记和链接地址也可定位，关闭后恢复连续预览。IME 组合输入期间不把 Enter/Esc 当成导航/关闭。查找状态只在当前文件视图内保留。
- 文件树操作合并为一行：最左侧固定目录开关，随后文件搜索、折叠文件夹，刷新文件列表放在最右端；文件导航缩到 140px 等不足一行的宽度时，搜索独占下一行，保证输入与清除按钮不被挤到零宽或遮挡其他操作，目录开关保持原锚点；折叠使用专门的上下内收箭头而非上下文压缩图标。可访问名称与 hover tooltip 明确区分含义；刷新仅重读目录/搜索结果，不覆盖编辑草稿。折叠仅关闭已展开目录，不递归遍历或展开整个工作区。此行参照 [T3 FileBrowserPanel](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/files/FileBrowserPanel.tsx) 的紧凑操作排列；目前没有文件系统监听，因而保留真实手动刷新；不得以定时调用会读取 Thread 历史的既有 IPC 冒充轻量实时更新。
- 视觉参照在本轮补充实际查看的 [T3 Code 官方完整应用截图](https://t3.codes/_astro/app-desktop.BOCg1ktw.webp)（[官网](https://t3.codes/)）：会话与右侧代码表面平级并排、紧凑路径/操作行、无浮动卡片外壳。文件导航沿用 ZenX 的辅助侧栏、图标和颜色 token；这是设计借鉴，不是 T3 完整界面复刻。验收截图使用真实 Sidebar、ThreadView、AuxiliaryPanel 与合成数据，不能冒充运行中的真实项目。
- 参考官方源码与文档：[Codex file search](https://github.com/openai/codex/tree/main/codex-rs/file-search) 的工作区文件发现与路径匹配，[T3 Code file tree](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/ChangedFilesTree.tsx) 的目录缩进/折叠，以及 [T3 Code file preview](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md#attached-files) 的带语法高亮预览。采用这些交互方向，不导入其权限范围或状态模型。
- 插件 `contributions.panels` 按 order 排列在加号选择器中，打开后与文件、浏览器并列。内容继续使用 Generic UI Host：可信模块或隔离 iframe，不在聊天底部重复挂载；context 包含当前 threadId。插件卸载或停用后移除其 tab。
- 插件通过 Host SDK `ui.panels.open({ panelId, threadId })` 请求展示自己声明的 panel。请求只改变易失 UI 选择，不切换当前 Thread，不创建 Turn；给后台 Thread 的请求在用户选择该 Thread 时展示。没有窗口或 panel 不可用时明确报错；成功表示已分发给窗口，不代表用户已看到或确认内容。
- Browser 的共享标签使用真实 Chromium WebContentsView 支持输入地址、点击、输入、滚动、前进/后退和刷新；同一 Thread 的 Browser 工具与用户挂载并操作精确相同的 target，登录状态保存在独立的 ZenX 持久 profile。外部 CDP provider 通过同一 tab strip 的外部只读 tab 显示其原页面，不把同 URL 的新页面冒充接管。Ctrl/Cmd+L 聚焦地址栏。
- Browser 地址框与外部只读 tab 的当前页面 URL 框内部最右侧常显“在外部浏览器打开当前页面”外链箭头，使用系统默认浏览器；地址输入保留 Enter 导航，不再并排放置含义易混淆的 Go 箭头。只打开当前已选页面的实际 HTTP(S) URL（保留 query/hash），不使用地址栏未提交草稿；外部只读 tab 由 Host 按当前订阅的精确目标读取并打开，工具摘要仍保持脱敏。空页面、加载中、连接失效或切换尚未得到新页面时禁用。图标沿用共享样式并具有 tooltip、可访问名称与键盘焦点；窄窗和触屏按钮至少 44px，URL 框与工具栏随之增高。
- 共享网页没有 Node 或 ZenX preload，外部导航限 HTTP(S)；设备、位置、通知等权限默认拒绝。关闭标签释放页面；关闭窗口、隐藏面板或切换 Thread 时只移除 native view，Host 继续持有页面供同一 Thread 的 Agent 使用。当前最多20个共享标签，不提供书签、扩展或完整历史管理。
- Terminal 打开当前真实 Thread 的本机 Shell 会话管理首页，显示同一 ToolTaskManager 中 Agent 命令与人工交互终端的稳定 task ID、来源、cwd 和实际状态；不跨 Thread 聚合同目录进程，不建立第二套执行注册表。远端 Fleet 会话不映射成本机会话，不静默降级。
- New terminal 是明确的人工执行操作，在 Thread 的 canonical cwd 创建真实 PTY；仅在既有 Full Access 且 Shell 未被拒绝时可用，归档或受限策略不被自动修改。启动本机交互 Shell 可能读取其正常 startup files。人工拥有输入，Agent 通过同一 Shell 系统的 shell_sessions / wait 观察，不向人工终端交错输入；Agent 取消等待不会终止人工终端。
- 打开、隐藏、关闭 Terminal view 或返回会话列表都不停止进程。Stop process 是独立确认动作，显示请求取消、取消未确认或已停止的真实结果；进程树覆盖取决于平台，不猜测存活子进程。输出只作为不可信终端数据渲染，不解释为 HTML、权限或 Agent 指令。
- Terminal 面板占满工作区 Tab 的可用宽高，标题由 Tab 提供，不再重复大标题。会话选择、状态、新建与停止集中在紧凑工具栏；cwd 单行截断，完整命令、来源与 ID 按需展开。终端自身使用剩余空间，随可见容器宽高重新 fit 并发送有界 PTY 尺寸；隐藏或零尺寸时不测量。输入归属和关闭不停止提示持续可见，详情展开、新建与停止确认不改变原来的会话生命周期。粗指针设备保留至少 44px 控件命中区域。普通失败会话用中性“已结束”展示，退出码与终端原始输出仍可查，超时、停止和观察未知继续显示具体事实。
- 终端保留有界 scrollback，截断明确提示；隐藏时暂停观察，保留当前位置，Jump to latest 才恢复底部。人工终端由 Shell 退出、显式 Stop 或 Host 退出结束，不继承 Agent 命令的执行期限；现有 Agent deadline 与共享容量控制不变，不自动恢复进程。会话 ID 与详细资源限制位于按需详情，不占据主要列表；关闭面板会继续运行的提示保持可见。已完成会话短时保留只读；详情见 [Shell 运行时与安全边界](../../../docs/shared-shell.md)。
- 当前范围不含新建/删除/重命名文件及异步 Inbox 回答回流。

## 7. Shared controls and readable context

- `ui/controls.tsx` 以 Radix 的 Select/Popover/Dialog 为基础。短枚举用 `Select(value, onValueChange, option children)`；长目录用带搜索的 `Combobox`；动作使用 `ActionMenu`，页面切换保留 Tabs。值选择与动作语义分开。浮层使用 portal、视口避让和可取消的入退场；Esc/确认返回触发点，外部点击不抢回焦点。
- 正文 14px、字段和导航 13px、辅助文字 12px；32px 常规控件、28px 紧凑控件，粗指针至少 44px。沿用现有 graphite/cobalt/ember、accent 与高对比 tokens，标题/正文用本机 Segoe UI Variable Display/Text，代码用 Cascadia Code/Consolas，不下载字体。
- 插件与内建功能入口平级，长插件导航在自身区域滚动。会话标题与可操作状态优先，模型元信息按需查看。右栏的平级内容 tabs 不改变实例/草稿/执行生命周期；新建页解释每种内容的用途。
- 设置保存栏与滚动内容分区；任意设置页存在未保存 Host 草稿时都保留保存入口。离开设置再返回保留草稿；异步保存不覆盖保存开始后继续编辑的值。Appearance 仍即时生效，Host 设置显式 Apply；错误保留草稿并允许重试。Uninstall 位于更多动作，保留数据；永久数据删除在同一菜单的独立危险分区，禁用前不可用，并有独立确认。
- 共用 motion tokens 为反馈 100ms、进入 150ms、退出 100ms、布局 200ms；动画不控制业务提交。含 Electron 原生 Browser view 的右栏不单独平移 DOM 占位，以免与真实页面 bounds 脱节。菜单/对话框交由 primitive 的 presence 管理卸载，details 使用可反向的内在高度过渡；reduced motion 取消位移和动画，保留状态反馈。
- 每次压缩只从 canonical compaction 派生一条完成行：压缩状态、发起者与唯一展开入口，不再附加第二行“查看原始历史”。展开后以并列、键盘可切换的“保留的上下文 / 原始历史 / 诊断信息”视图组织内容，不叠加同义 disclosure。“保留的上下文”默认呈现可选取和复制的 Markdown 摘要、摘要字符数与“完整输入占用未知”，并说明保留原始 Items 数量、时点与后续增长；字符不是 tokens。“原始历史”保留准确范围、分页与完整原始条目读取；“诊断信息”独立呈现真实 Core 消息投影、逻辑引用与 canonical 压缩记录。历史消息条数、摘要字符数、摘要调用 tokenUsage 均不冒充完整模型输入；未记录的完整输入占用不展示为 0 或伪造节省比例。
- `test/fixtures/controls-visual.html` 提供共享控件、禁用、长目录、对话框与长中文压缩摘要的开发展示面；不是产品导航入口。

## Room 与 Thread 的共享输入体验

- Room 复用 Thread 的输入容器、自适应文本区、发送按钮视觉与候选列表。Room 仍经插件 SDK 保存消息和消费投递回执；共享外观不提供 Thread 专属的中断、停止、权限或模型控制。
- 普通 Room 输入 `@` 弹出可搜索的成员候选；上下方向键选择、Enter/Tab 确认、Escape 关闭，选择不会同时发送消息，中文输入法确认与长按 Enter 不触发重复提交。成员选择保留 literal `@name` 及前后文本，与 Host 的 mention 匹配规则一致。Always On Assistant 不要求 `@`，新消息仍在现有下一周期 steering 路径接入。
- Thread 的文件、线程、工作流和 Room 的成员候选共享 viewport-anchored portal 呈现，避开 Composer 底部滚动容器的裁剪；候选保持编辑器焦点，窗口变化后重新定位，不复制数据或执行语义。
- Room 的次级导航沿用平面行与中性选中态，正文与输入框沿同一阅读列对齐。用户消息使用右侧轻量气泡，Agent 消息保持自然排版和可辨认的作者；消息原文不做删改。时刻简写可通过 title 查看完整日期，来源 Thread/Turn 与消息 ID 只在消息 More 菜单的技术详情中保留，不常驻显示。
- Room 的设置与未确定投递状态保持可见且可操作。触发器卡片的完整指令默认折叠，展开后可读；这些都是呈现调整，不改变 Trigger 配置、运行、恢复或授权。
- Room 的标题与重命名、工作区、设置操作共享应用外壳中的同一标题行，正文上方不再另起操作栏；保留原生窗口控件和拖动区域边界。自动回复未启用时，只在现有设置入口显示轻量状态提示，具体成员数量和配置入口收进会话设置，不额外占用常驻状态栏或标题空间。“未启用”不擅自区分未配置、暂停或 Host 全局关闭。展开和查看设置不启用 Trigger，也不重放消息。投递失败和结果待确认仍独立可见、可操作。
- Room 向上滚动到历史边缘时自动分批读取，保留当前可见消息的位置；首次打开不自动扫全量历史，读取失败停止并提供明确重试。迟到响应不改变新的房间，实时消息和分页使用消息 ID 对齐。界面只展示 Host 当前保留的历史（现有上限 256 条），到达边界不冒充永久完整档案。
- Room 消息头只显示一个发送者名称和时间，不叠加 Agent、成员、Thread、PAW 或来源未知标签。优先保留消息记录的有效作者名；通用 Agent 名仅可由记录的来源 Thread 匹配真实成员或明确的会话名称，没有来源时使用中性的“未知成员”，不从正文 @提及反推作者。点击名字按需展示来源会话和当前关联 PAW 的导航，关联关系不改写历史身份；原始 message/thread/turn/operation IDs 只在 More 菜单的技术详情中出现。
- Room/PAW 消息下不常驻成功投递、已读或技术详情底栏；成功发送只追加正文并清理已确认草稿。真实失败和投递不确定状态继续在现有可操作状态区显式显示，不因简化消息而隐藏或伪装成功。
- Room 的本人消息姓名和时间与消息右沿对齐，动作组位于其左侧；其他成员的姓名和时间保持左对齐、动作组位于右侧。动作预留空间不能把本人消息头推离右沿。Room 的 Reply、React、More 使用消息上方的轻量动作组，桌面 hover 或 keyboard focus 时显示，浮层打开期间保持可见。触摸或无 hover 时保留可见的 More 入口并能执行同样动作；不让每条消息常驻一排大按钮。已有 reactions 在正文下显示为 emoji 与数量的可切换 pill，没有 reaction 时不留空行。选择 Reply 后 Composer 保持输入焦点和清楚的作者/摘录引用，选择 reaction 不发送消息或启动 Turn。
- Linux 与 Windows 的工作区入口避让原生最小化、最大化和关闭按钮，不能将打开面板的点击交给原生关闭区域。

- Room 的自动回复设置按明确成员导航到现有 Room mention Trigger 编辑器；路由参数只表达临时 UI 意图，成员和目标从最新 Host Room / Thread 投影验证，显式 Save 才写入定义，不修改权限、不重放旧消息。Cancel / Back 返回原 Room，不把离开表单当作取消已提交的 Host 请求。Member conversation 选项以标题和短工作区 / 可区分短 ID 呈现，完整身份仍可搜索、查看并由无障碍名称读取。
- Room 发起的自动回复设置以只读摘要显示精确 Room、成员与执行 Thread，只要求填写名称和回复指令并显式保存；不在这个固定目标流程显示类型切换或新建 Thread 控件。成员名中的 `|` 属于名字本身，不能被条件串的分隔符截断。通用触发器编辑器保留原有完整选择能力。

本轮视觉和交互校准参考 [DeepSeek Harness 的输入候选组件](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-input-trigger)、[T3 Code 的 ComposerCommandMenu](https://github.com/pingdotgg/t3code/blob/5cc99e1c23980d7995a13c47f969b47cb68ed1be/apps/web/src/components/chat/ComposerCommandMenu.tsx) 与 [Linear 的 UI refresh](https://linear.app/changelog/2026-03-12-ui-refresh)。这些是参考材料，不替代本文的产品语义，也不引入它们的运行模型或样式框架。

### PAW and Room conversation workspaces

The primary left navigation exposes named PAW assistants and Rooms directly, below plugin entries and as peer sections alongside the existing project/Thread organization. Opening one selects an IM-style conversation without a second conversation rail. Creation remains explicit; personal naming happens in the conversation or later settings; PAW (P-A-W) is the reusable preset name. Product labels and new preset defaults use PAW; existing user-chosen Room/member names, saved annotations, protocol identifiers and routes stay unchanged.

PAW and Rooms use the same disclosure heading and add-button treatment as Projects. Each section remembers its own expansion across navigation and restarts; collapsing does not hide its add action. Background navigation refreshes retain published rows and empty states. Only a real Rooms admission change retires that projection; unrelated plugin catalog notifications must not clear it or move Projects.

First use presents a small PAW welcome in the empty sidebar section, with Set up and Later. Later only hides that welcome locally; Set up and the section's add action remain available. Existing PAWs keep their names and never get recreated or forcibly enrolled. Creation lives inline in the conversation surface, with no naming wizard, modal overlay or focus trap. It reviews the working Project, model, permissions and required plugin readiness. Missing Projects use the existing picker/settings API; failures offer inline retry/settings. “Create and say hello” explicitly starts a Host bootstrap event through the owned Trigger and an existing durable operation receipt. It never posts a visible or hidden human message. The real Agent welcomes the user and asks for a name; the renderer never fabricates an assistant message. The user may skip naming and work immediately. Closing or navigating away before submission creates nothing; uncertain Thread creation retains existing inspection/binding guidance and never blindly retries.

A created PAW opens even if introduction delivery fails. Existing prepared-operation recovery handles interruption/restart; no mount effect automatically starts a turn. The initial introduction uses a distinct bootstrap operation with one deterministic valid receipt suffix within that Room's existing operation epoch. Its wakeup ID identifies Trigger history, never an invented message ID. Status and failures remain visible while the Agent's actual post becomes the first conversation message. Unknown outcomes retain that receipt; only a confirmed cancelled operation plus a new explicit Start introduction click creates a fresh receipt. Confirmed Room creation opens the conversation before any list refresh settles. Ordinary navigation does not cancel the accepted greeting; explicit Later/Close before admission does. Loading an existing PAW never initiates onboarding. Model naming reuses zenx_rooms_rename through the Host invocation boundary: only the exact bound Thread can rename a PAW; shared-Thread PAWs require an unambiguous active source Room. Forged arguments, forks, side chats and other workspace Threads gain no identity authority. Trusted UI management and ordinary Room management retain their existing scope. Settings group the displayed name, working conversation/directory and notebook links; existing AGENTS.md remains a workspace file under existing permissions, never copied into a parallel Host identity record.

Every PAW/Room row has a visible More button. Right-click and Shift+F10/Context Menu open the same keyboard-operable menu: rename, existing conversation settings, and the PAW workspace. A PAW rename updates its Room display name, bound speaker name and owned mention configuration in the existing atomic store; it does not rename the working Thread or rewrite past messages. Settings retain explicit Pause/Resume and existing confirmed deletion, without disabled member-management actions that cannot apply to a PAW. A title bar omits a subtitle only when it exactly duplicates its title.

Reference decisions (official documentation checked 2026-10-12): [OpenClaw bootstrapping](https://docs.openclaw.ai/start/bootstrapping) and its [BOOTSTRAP.md template](https://docs.openclaw.ai/reference/templates/BOOTSTRAP) make identity a short first conversation rather than a gate; work takes priority and agreed identity is saved through an existing configuration command. Adopt the conversational naming and success-before-confirmation pattern. Do not import its file seeding/deletion, avatar generation, provider discovery or daemon installation. Zen Core already reads repository-root AGENTS.md for a new Thread's first message (`src/workspace-instructions.ts`); preserve that boundary. [Letta memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks) document tool-mediated self-editing with read-only blocks and per-block semantics. Adopt explicit tool-based updates, not Letta's persistence model: Zen's displayed identity stays in the bound Room/member/owned mention, while work files and the existing notebook keep their own authority.

Creating PAW defaults to a new idle working Thread in a configured Project, with the current Host model and permissions previewed before the explicit Create action. The Host creation itself creates no Turn; the explicit “Create and say hello” UI action then admits a Host-origin bootstrap wakeup. The working Thread records a canonical host_message and no fabricated user_message. Binding an existing available Thread is a separate, explicit alternative. Cancel before submission creates nothing; dismissing an already submitted form does not undo accepted Host work or replace a newer navigation. Confirmed creation remains confirmed if the subsequent list refresh fails. An uncertain Thread start or preset-save failure is visible with inspection/binding guidance, and the same setup operation cannot silently start another Thread.

The existing right workspace shell is shared. Room-owned tabs expose Overview, Matters, Memory, Triggers and Threads. Matters and memory are assistant-maintained notebook annotations, with exact references to execution Threads and Triggers. They do not act as a second scheduler or an execution ledger. A plan such as “waiting for review” is visibly distinct from a live Thread status. Remote references show their full device/workspace identity and do not silently open a local Thread with the same ID.

Files, Browser, Computer and Thread plugin tabs require a real Room member Thread. The PAW Overview displays its exact working Thread title with inline rename through the existing Host title authority; this never renames the PAW or its speaker. Direct working-Thread navigation retains title editing while the Thread-list projection catches up after successful recovery. A PAW can use its single bound Thread; shared Rooms ask the user to select a member, with the resource context visible above the tabs. Room navigation and tab selection stay separate from canonical execution identity. Existing file drafts remain owned by the shared workspace draft store.

New PAW setup discloses an hourly heartbeat and model-quota use before Create. It commits one ordinary timer with the Room and message Trigger without immediately running the model. Existing PAWs retain their saved definitions and offer Add hourly heartbeat in management; repeated clicks reuse the existing preset without changing its prompt, cadence or paused state. A deleted timer stays deleted after reload. Management opens the existing Triggers tab for editing, pausing and deleting; message-wakeup pause is labeled separately. Overview shows actual recurring timer definitions, including cadence and paused state. The Triggers tab shows the assistant's existing Triggers and their instructions, and opens the existing Trigger controls for configuration. Reading any of these views does not start a Turn or install a timer. Missing plugins and unavailable sources must be visible rather than treated as a successful empty state.

## 2026-10-02：持续适用的 UI 修改与验收原则

本节记录已确认的产品方向，之后所有 UI 改动均须对照；它与本文前面的权威规则共同生效，不另建平行规范。

- 从完整用户流程审视界面。先枚举页面、设置分区、插件页面、弹窗和关键状态，再实际逐页打开；不得把类型检查、单页截图或通过的组件测试表述为全产品体验验收。
- 复用已有成熟组件与交互。Room、Thread、side chat 共享正常 Composer、浮层式 @ 提示和右侧工作区；不为插件复制一套低完成度输入框、选择器或导航。
- 设计参考应能说明具体借鉴了什么：信息层级、密度、颜色、侧栏、输入框、Tab 或消息布局。没有源码、公开设计材料或实际产品观察的依据时，不声称某设计来自 DeepSeek Harness、T3 Code 或其他产品。
- 所有 Tab 的选中态使用表面深浅与文字对比，不用强调色底线。保留键盘焦点环、可访问名称与选中语义；选中与焦点是两件事。
- Windows / Linux 的原生窗口操作独占最上方一行。除左侧 Sidebar 外，主页面标题与右侧工作区操作全部位于其下方，宽窄屏都不得与系统窗口按钮重叠。原生操作行统一使用 Sidebar 顶部的 surface token，与下方主标题/内容形成可见的深浅分区；浅色、深色和配色主题同步生效。
- 图标按钮必须有准确的 tooltip 与可访问名称。关闭 Tab、关闭右栏、展开右栏、全屏打开子会话是不同动作；新建 Tab 的加号只打开内容类型选择器，不隐式创建线程。每个操作的作用对象与用途必须从所在侧栏或全屏布局中清楚可见；不是禁止叉号或加号，而是不能让它们脱离被遮挡的 Tab 名称，像无归属的顶栏按钮。
- 会话滚动、消息列和 Composer 必须在各自分栏的边界内；长标题、多个子线程、错误提示与窄屏不能挤出隐式 Grid 列或让输入框漂浮到另一会话上。Checkbox 等基础控件遵循共享样式与标签布局。
- Subagents 的常规入口为右侧工作区加号菜单中的 Subagents Tab。Tab 内显示当前会话的子线程，选择后在右栏阅读/对话；不在主标题下重复铺设 Subagents 行或快捷标签。
- 每个 Subagent / Side chat Thread 的左侧栏显隐独立保存到本机 Host profile，默认隐藏；Subagents 树每一行提供始终可见、可键盘/触控操作的“在侧栏显示”开关，显示/隐藏只影响该 Thread，不递归改变后代。隐藏后仍可从 Subagents 树访问，已打开的独立标签保持不变。
- 显隐与 Pin/Unpin 完全独立：显示不会自动置顶，隐藏不会取消置顶；隐藏的已置顶子线程不进入 Pinned 列表，再次显示才恢复既有置顶位置。普通线程与独立 Fork 仍默认显示。旧全局 showSubagents 开关移除，既有 localStorage 值不迁移为逐线程显示授权。
- Subagents Tab 提供 New side chat：点击新建时固定父会话的完整上下文边界并打开 renderer-local 草稿；首次有效 Send 才以该边界创建 fork 子线程并发送。未发送就关闭不创建真实 Thread，不进入子会话列表、Sidebar 或持久工作区。草稿在本次 renderer 内按创建入口的 Thread/Room 工作区和精确父会话独立保留，导航与切换不串归属；模型与 effort 选择只属于该草稿。 草稿立即显示固定边界的父会话只读记录，不伪装为空白新会话；父会话仍在执行的部分只呈现静态快照，不显示旁聊正在执行。读取、创建子线程与发送消息各阶段均有可访问的进度提示；创建和发送期间不能重复提交，失败保留原输入。创建后的上下文末尾追加明确的 side-chat 身份与等待用户请求的指令，不继承可执行待办队列，也不改变父会话执行。创建已确认而发送失败时，同一草稿重用 child ID 和发送幂等键，不重复创建。主动深入交互时可以全屏打开真实子线程。
- 全屏子线程在现有 top bar 中使用可返回祖先的路径式面包屑标识位置；不另占标题栏下方一行。普通根会话不显示空面包屑。
- 验收至少检查浅色/深色、桌面/窄屏、长文本、空状态/错误状态、键盘与焦点、打开/关闭/切换后的草稿和上下文归属。修复前后截图绑定实际构建版本；未实际查看的页面必须明确列为未验。
- 产品改动在 PR 分支交付，不直接修改主线；独立 Review 和实际操作证据共同支持结论，不能相互替代。

PAW 导航使用与共享图标相同描边风格的对话气泡，表达一对一交流；普通 Rooms 保留多人图标。它不使用代表 Thread trace 的三行图标，也不通过图标暗示额外自主性。

### 2026-10-04: PAW conversation clarity

Normal PAW chat keeps only compact, named rename/workspace/settings controls. Do not put model-cycle, quota or background implementation descriptions under its input. Paused delivery and failures remain explicit; Pause/Resume lives in conversation settings. Rename edits the display name only and preserves the Room identity and bound working Thread; Cancel/Escape leaves the name unchanged. PAW/Rooms appear after plugin entries and at the same section hierarchy as Projects, using neutral selected surfaces and spacing instead of extra truncated separators.

Native scrollbars retain their geometry and scrolling behavior. Their track is transparent against each surface; the thumb uses the theme's muted text color while scrolling, keyboard/focus interaction or edge/drag activity is occurring, and becomes transparent at rest. Forced-colors uses native colors. Do not hide overflow to simulate autohide, and do not count Linux/mock evidence as native Windows/macOS validation.

### 2026-10-08: Room IM presentation references

The message hierarchy and actions use these specific public patterns: Slack's
[compact message display](https://slack.com/help/articles/213893898-Change-how-messages-are-displayed)
keeps sender identity without requiring avatars; Discord exposes
[Reply on hover and through More](https://support.discord.com/hc/en-us/articles/360057382374-Replies-FAQ)
and supports [keyboard access to message actions](https://support.discord.com/hc/en-us/articles/1500000056121-Keyboard-Navigation-FAQ).
[Teams reactions](https://support.microsoft.com/en-us/teams/chat/like-or-react-to-messages-in-microsoft-teams)
appear beneath messages, and Discord's
[reaction toggle](https://support.discord.com/hc/en-us/articles/12102061808663-Reactions-and-Super-Reactions-FAQ)
removes one's selected reaction on a second click. These inform presentation,
not ZenX execution or identity authority. Merging the Room status and action row
is the user's explicit ZenX decision, not a claim about those products.

### Agent activity, approval review and pending messages

Agent activity is a disposable projection of native turn items. Consecutive tool/reasoning items stay in stable disclosures; assistant/user messages remain chronological boundaries and final replies stay outside process folds. Counts describe calls, not promised successful work. Historical task receipts remain inspectable evidence, not current process state or transcript process counters. The separate composer-adjacent background-command row reads exact-owner native Shell sessions independently of call and Turn disposition; only those current observations supply its running count. Newer local sidebar choices retire pending Terminal jumps, while the jump's own Host receipt does not count as a new choice.

Turn-level metadata remains before history throughout running and completion. Its duration is explicitly labelled “Working for …” while active and “Worked for …” after normal completion; both are localized as “已工作 …”, not bare digits. Existing duplicate-status suppression, input arguments, item order and disclosure behavior are unchanged. Running states share one unboxed row; terminal diagnostics use a panel rather than a status capsule.

Only actual running/model activity has a left-to-right text highlight. Waiting, approval, stop-request intent, unconfirmed cancellation and terminal outcomes stay static. Reduced motion and forced colors retain readable static labels. Selected transcript text pauses automatic following; an explicit Back to live resumes it. Terminal folding does not interrupt selected or focused inspection.

Approvals stay composer-adjacent and name their real once-only or remembered capability scope. A bounded inline preview has a user-opened full-request dialog containing complete code, cwd and arguments. Opening or dismissing review never decides a request; both surfaces share one pending lock and preserve errors. Focus restoration respects the exact request and newer user interaction.

Queued messages form a compact composer-aligned pending-send shelf. Text, real image thumbnails and attachment counts remain visible; genuine truncation has a selectable full-text disclosure. Exact ID/client-ID order is canonical; cancellation or resume acknowledgement does not remove rows. Editing uses the native exact-target expected-revision command and append-only edit fact, retaining original queue position and delivery mode; there is no reorder or implicit retry. Native delivery errors stay on their exact message; a distinct resume transport error belongs beside Continue. Approval + queue + error + draft must preserve reachable decisions, one 44px queue-action lane and Composer in narrow windows.

Queued thumbnails read only validated AttachmentRefs from the exact same-thread pending input. Show a compact first set with an actionable full-gallery disclosure; missing references or failed reads remain explicit and retryable without blocking Edit/Cancel. Opening a full image uses the existing viewer and stops being visible when its exact queue owner disappears or the selected thread changes.

Queue editing owns an independent local text/image draft, preserving image order and the main Composer draft. Cancel/X discards unsent edits without changing native input; failure, revision conflict, admission races and navigation/loading preserve the draft and its request identity. An App-owned memory-only cache survives viewport remounts. Save never starts the queue: the canonical edit updates the row, and an authoritative receipt may close the editor while its draft/receipt stays cached until the exact edit fact is observed. Unsupported Host skill/audio or non-round-trippable input is not silently flattened. Editor, gallery and simultaneous approval/queue/error states keep complete text context and reachable 44px decisions in a 390×600 viewport.

### Foreground computer activity

Background-safe/isolated providers remain the first choice; no operation may silently escalate to global input. For the explicitly enabled, admitted foreground Computer tools, the Host shows a subtle display-edge glow plus a compact top-center “{Agent} is using your computer” status and Stop action before the existing one-second cancellation window and before native input. The indicator is notice, never permission; disabled foreground control, rejected grants and invalid requests do not display it or dispatch input.

The status also names the admitted action kind and its truthful target scope, the current foreground app; it never displays typed content or claims a bounded window for global input. This text and edge remain visible for the actual foreground owner lifetime, including stop-request intent until provider/native settlement. Background-targeted Computer work appears in its exact-window panel instead of activating the desktop indicator.

The Agent name comes from an unambiguous existing local Room member binding, otherwise “ZenX Agent”. Global input has no bounded monitor target, so all currently connected displays are marked. Edge windows are pointer-transparent; status windows are small, non-activating and excluded from application-window routing. Stop cancels only displayed local calls and interrupts only a verified canonical call’s exact still-running Turn. Concurrent calls retain the indicator until each provider settles; cancellation intent says “Stopping computer use…” and never pretends input has already stopped. Failures to display the indicator fail closed, and renderer/window loss cancels active input.

Display addition/removal/geometry changes synchronously cancel current foreground admission and running calls before repaint; old display acknowledgements cannot authorize input on the changed topology. Native helper abort/timeout means termination was requested: the indicator keeps its owner and stopping state until process close confirms settlement. Stop messages retain their exact displayed owners across concurrent render updates; retired owners cannot be replaced by newer calls. The macOS status window explicitly accepts the first mouse click while inactive. Native acceptance must check one physical Stop click with a different application frontmost; a renderer-targeted CDP click does not prove that behavior.

During a live foreground Computer operation, the Host registers global Escape only for that activity lifetime. The status says “Press Esc to stop” / “按 Esc 停止操作” only after registration succeeds; an occupied or unavailable shortcut instead directs the user to Stop. Escape uses the same exact live-owner cancellation and canonical Turn interruption as Stop, keeps the stopping indicator until native settlement, and is unregistered when the final owner settles or the Host closes. Background work and idle usage do not capture Escape. Existing PAW names and the “ZenX Agent” fallback remain unchanged.

The actual HTML renderer is also used by `test/fixtures/foreground-activity-visual.html`. Reduced motion removes animations; forced colors retain readable status and borders. Browser preview verifies presentation only. Native focus, physical pointer pass-through, fullscreen behavior and monitor changes need their own OS evidence. This slice covers explicit foreground tools, not every possible side effect of a provider currently declared background-safe; provider-specific activation must be fixed at its real admission/dispatch boundary, not hidden by a late glow.

The Computer access review reads the Host's current desktop-session projection as active, locked, suspended or unknown. Missing or uncertain observation stays unknown, never active. On macOS, the native provider may inspect and use actual targeted AX controls while locked; app support varies and native failures remain failures. Session changes invalidate prior observations. On macOS 14+, a provider declaring native window input may also capture a freshly verified exact window and attempt a separately authorized background left click while locked, without desktop foreground or pointer takeover; application-internal focus may change. The explanation follows the selected provider's access list and never implies that an installed plugin granted OS or action permission. Generic desktop-preview readiness remains unknown while locked; a particular native window is verified per request, not by that preview check. Foreground control requires local unlock, and other providers retain their own admission. Session changes stop live previews and fence late frames; unlock alone cannot revive a prior preview. System sleep requires local resume. Display power is not observable from these session events: display off is neither proof of lock nor proof of sleep. The operation-scoped app-suspension blocker prevents idle system sleep only during admitted Computer work; it does not keep the display lit or override manual sleep. The review is read-only and refreshes through existing readiness reads; it does not unlock, wake, grant permission or start a Turn. Synthetic previews certify only rendered states; native focus, Stop, window geometry, input release and application effects require separate macOS evidence.

Peekaboo targeted press/value changes are not certified focus-isolated and therefore use the same explicit foreground permission and indicator admission as other foreground actions. No automatic background-to-foreground fallback is permitted. Native AX retains its separate targeted semantic contract; application-created dialogs/focus changes are not a guarantee of isolation. A successful tool dispatch and its optional visual pointer do not establish application effect. External-provider cancellation/timeout/output overflow shows stopping until actual child/pipe close, including failed kill requests; never shorten that lifecycle to make the indicator disappear.

### 2026-10-14: Per-tab Browser permission

A single compact permission switch sits at the far right of the existing address toolbar, with the stable label “允许 Agent 操作此标签页” / “Allow Agent to operate this tab”. It indicates permission, never who is currently operating or whether the Agent is running. The user can always browse and sign in manually. Off blocks new Agent mutations on the exact tab; on only allows them again, retaining existing fresh-observation and unknown-outcome fences. Neither state starts a task, resumes a conversation or replays an action. The toolbar has no separate completion/continue action or persistent status row. Login and confirmation requests remain in the conversation.

Reuse the shared switch visual and native hover title; the stable accessible label, checked state and description convey the same permission and complete rules. Already-dispatched and uncertain-action warnings are included without changing the native page bounds. The external-open arrow remains a separate action inside the URL field.

### Original history after compaction

Each compaction has one collapsed event and one disclosure. Its Original history peer view mounts the inline reader on demand, pages the existing public journal projection at the exact canonical cutoff, and offers explicit full-Item chunk reads. The logical locator and canonical record belong to the Diagnostics peer view, not another nested disclosure. Disabled or legacy references show an explicit unavailable explanation without a lookup action; unavailable targets and failures remain visible with an explicit retry. Closing, switching views, changing compaction or navigating away discards pending display results without changing the journal or current conversation.

### Message-level Fork

Only the terminal Agent response exposes Copy and Fork in its hover/focus action row. Intermediate commentary, tool-adjacent replies, and in-progress responses never expose this action row, even when their canonical Items are durable. The existing terminal-response selection remains authoritative (the final completed reply, or the last non-empty reply on a failed/interrupted Turn). Fork appears directly after Copy when that response has a durable canonical Item. The action binds the source Thread and exact canonical Agent Item ID; streaming-only messages cannot be fork boundaries. It uses the native Core fork with the inclusive prefix, never later Items, historical tool replay or an automatic new Turn. The original Thread is unchanged. Pending activation immediately replaces the Fork icon with a spinner; its tooltip and accessible name say that this thread is being forked/copied, and the disabled button prevents duplicate clicks until copying and navigation finish. Pending repeated clicks share one request across viewport remounts; errors retain the source context and exact local details. An uncertain creation reply triggers only a read-only summary refresh so an already-created copy can be found; it never automatically repeats creation or guesses a destination. Creation currently has no protocol idempotency key, so an explicit retry is not claimed safe after an unknown outcome. Forking a genuinely completed final response retains its observed completion and keeps the exact final text outside the collapsed process; the cut before the completion receipt must not invent cancellation or live background ownership. Success opens the new Thread unless newer navigation or a newer fork action superseded that intent. Touch/no-hover actions remain visible with 44px targets and keyboard focus is explicit. The thread-level action uses the same Fork icon and localized Fork label while retaining its latest-complete-Turn boundary and the same working directory. Shared Fork artwork stays within the 16×16 icon viewBox, including all three endpoint strokes.

### Compact activity context

Settled multi-tool disclosures lead with at most two known action kinds and an exact remainder of other operations, plus the actual names of unknown tools. Counts describe calls per action, never unique files, success, or work inferred from arbitrary shell/code text. The total call count remains available to assistive technology; duplicate category counts are omitted. Group headers show at most two distinct existing capability glyphs in first-seen order, not a generic list icon. A content-sized decorative slot uses 16px for one glyph and at most 32px for two, so the label remains 8px from the visible glyph set; unknown tools retain the existing presentation fallback, and reasoning-only groups retain their reasoning glyph. Canonical chronological members and stable disclosures are unchanged. Active groups name the observed current operation in the same single-line row; an unresolved wait invocation receives the same activity cue as running work. A returned wait is settled even when its receipt reports that the observed target task is still running; that target lifetime remains represented on the originating operation, not on historical wait calls. A running/thinking trace removes only the duplicate visual Turn-level generic status, retaining the metadata row height, elapsed time and accessible status. Model-only continuation, approval, stopping and waiting remain visible. Cancellation counts remain explicit; generic failure and nonzero-result counts are omitted, and call counts never imply success. The same left-to-right activity cue applies to the visible capability/reasoning icon strokes and their adjacent singleton or expanded tool/reasoning titles only while the Turn is active and the observed item is genuinely running or its wait invocation is unresolved; approval and terminal invocation states remain static. Reduced-motion and forced-colors preferences retain readable static text. Sidebar running status uses the existing accessible status icon at a calmer 1.8-second rotation, without a duplicate Working label beside the model; approval text remains visible.

### 2026-10-14: Codex conversation import in Settings

Codex conversation import is available in Settings → General under Import conversations. The active-thread Sidebar has no import action. The existing preview, validation, import and open-retry dialog remains unchanged; cancelling returns to Settings and a successful import opens the imported Thread.

### 2026-10-14: Message source navigation

Delivered and queued Thread messages expose a compact source action using the canonical sender identity; local Trigger messages open the exact current Trigger definition. Names and message-body text never select a target. Source actions only read and navigate: they do not send, fork, execute a Trigger or change queued input. Local Thread opening validates its exact identity and availability first; archived, missing or denied targets have visible feedback. Remote sources without a verified return route remain visibly unavailable and never fall back to a same-ID local Thread. Main and side conversations retain their existing navigation roles, and a side-source action preserves the main Composer draft. Newer source clicks, navigation, hidden queue rows and explicit Trigger editor actions retire older pending selection intents. Source controls retain full-name tooltips, keyboard activation and visible focus; model provenance and tool-addressable IDs remain unchanged.

### 2026-10-14: Opt-in Thread debug mode

Normal Agent and side conversations have no permanent Conversation / Debug navigation row. Debug mode is an off-by-default switch in the last row of the existing Sidebar Thread actions menu; selecting it opens that exact Thread in the main Agent viewport. The same panel stays open and anchored, with its toggle and keyboard focus in place so a second click exits debug mode. Ordinary Thread navigation exits debug mode, and side conversations remain normal conversations (expand to the main view to inspect them). The mode is transient renderer navigation state, never a profile preference or canonical Item. Debug mode retains Items and the existing local-only Actual requests tab, with an explicit Exit debug mode action in the same toolbar. Exiting restores the normal conversation layout and Composer focus. Opening the mode only reads the always-on durable Trace; it does not enable capture, start sampling or alter any execution/permission state. Legacy opt-in capture records remain historical evidence only.

### 2026-10-14: Compact request inspection

Items remains the default canonical-history view. Actual requests is a separate,
local-owned Host observation surface. Its embedded UI has one capture controls
row, without repeating the debugger title or a permanent privacy footer. The
critical device-wide/private-content, RAM-only, close-keeps-capturing and
disable-clears disclosure is visible before capture can be enabled; full scope
and retention remain available from the privacy control. Navigation, section
selection and closing debug mode never enable or disable capture implicitly.

The request inspector uses the width of its actual container, including when a
workspace is open or the page is zoomed. Above 720px it shows a 240px request index
alongside detail. At 720px or below it shows the list or the selected detail, with
Back restoring the same search, selection, list scroll and keyboard focus. It
never reserves a horizontal request-card strip above a narrow payload. Compact
section and Tree/Raw controls use quiet selected backgrounds, without underlines.

The detail has one vertical scrolling owner. Ordinary Tree strings wrap; Raw
preserves the exact retained page text and can scroll horizontally inside the
code block. Identity, dispatch caveats, byte counts and source-attachment metadata
are available on demand. Projection, truncation and redaction are independent
visible flags, so simultaneous anomalies are never collapsed into one status.

### 2026-10-15: Workspace launcher rows

Subagents and Triggers use the same horizontal launcher surface and title/description hierarchy as Terminal, File and Browser, with concise localized descriptions and their distinct icons. Subagents keeps its independent quick-create action as a small circular plus inside the same row; the primary row opens the existing list, while the plus opens a local side-chat draft without creating a Thread or starting a Turn. Touch/coarse-pointer use retains a 44px action target.

### 2026-10-15: Multiple side conversation tabs

A Thread or Room workspace can keep several side conversations open at once. Each tab is identified by its target Thread ID, independently of its title or category; opening an existing target selects that tab, and opening another target preserves its siblings. Closing a tab changes only that workspace's tab order and selection, without closing or archiving the Thread. Main navigation retains each workspace's open tabs and selected target, while the existing App-owned draft and reading caches retain each Thread's local state. File and Browser tabs retain their existing path/tab-ID identity; a plugin's manager panel remains one contribution rather than becoming a generic multi-instance runtime.

### 2026-10-27: Workspace tab order and selector consistency

Thread and Room workspace tabs reorder directly by dragging their labels, with a small movement threshold and before/after insertion feedback; close buttons do not start a drag. There is no separate reorder-only ellipsis or two-step move menu. Alt+Left/Right on a focused tab provides equivalent keyboard ordering, exposed by its accessible description and shortcuts. Narrow rails retain horizontal scrolling and Home/End/arrow selection; holding a dragged tab at either rail edge continuously scrolls to offscreen tabs. Only release inside the rail commits order. Pointer cancellation, lost capture, Escape, blur, workspace changes and unmount discard the pending move and clear feedback/scrolling. A completed drag never activates a different tab or its close action. Reordering keeps the current selection, content instances, file drafts and exact resource ownership. Real tab order uses the existing Host presentation revision/CAS store. Local side-chat drafts participate in the visible order but are never persisted as Thread/tab descriptors. Existing whole-leading-tab reveal behavior remains in effect after a completed reorder.

The New Thread Composer's machine and Project controls share the same quiet trigger surface, sizing, hover/open treatment and keyboard focus ring. Both retain their existing accessible labels and menus; the machine trigger has no disclosure arrow.

### 2026-10-15: Stable Thread menu editing and compact Items

The Thread information title and Rename action edit the title inline in their
existing panel. Metadata and action rows stay in place; no replacement popover or
modal opens. Enter saves, Escape cancels only the edit, and successful save or
cancel returns focus to the initiating title/action without closing the panel.
Outside interaction or navigation dismisses the panel and retires its draft; a
late save receipt cannot close a newer editor or reclaim focus moved elsewhere.
Failures retain the draft and show an explicit local error.

Items remains the default debugger tab in canonical order. Tool call arguments,
tool result content and tool images start collapsed and mount only after an
explicit disclosure. Exact Item JSON and the existing full-content controls stay
available; debug mode does not add conversation copy/fork actions.

### 2026-10-15: Consistent interface icon semantics

Triggers use the existing clock artwork throughout navigation, workspace tabs and launchers, Marketplace, and delivered or queued message sources. The public plugin icon key `trigger` remains supported as an alias of `clock`, so plugin contributions cannot reintroduce a different Trigger glyph. Settings → Plugins uses the existing plug. Thread message source actions use the existing conversation bubble, including remote/unavailable sources, while trace/list controls retain their own icons. File tabs use the file icon and the file-tree visibility toggle uses the folder icon; neither uses context-compaction artwork. These changes reuse the existing icon sizes, strokes, containers and localized labels, without altering source navigation, Trigger execution or file disclosure behavior.

### 2026-10-15: Side chat creation settings

The Subagents panel keeps one-click inherited side-chat drafting and offers a compact model-settings action beside it. Model and reasoning overrides are local to that parent's creation form, use the current Host catalog, and apply atomically before the child becomes visible. Omitted values retain native inheritance/default semantics; a model change clears a stale effort choice. Opening fixes the parent context boundary in renderer memory; first valid Send atomically creates the configured child before delivery. Closing an unsent draft leaves no Thread. The workspace launcher plus remains the inherited one-click drafting action.

### Browser and Computer observation: human-owned navigation (2026-10-29)

Workspace Agent tools use the existing ordinary Browser tab and its exact WebContents/profile. Agent actions, inspections, target discovery, frames and completion never open the workspace, select or reorder tabs, change the human's observation target, transfer focus or activate the OS. There is no Follow Agent mode or control. Human tab selection, opening, closing and navigation remain explicit; an initially unselected view offers its existing chooser rather than selecting a newly discovered target.

External connected pages and Computer windows/applications are read-only observations. Their target pickers require an explicit human choice and retain that exact identity across activity on other targets; no selection means catalog-only, not the Agent's latest target. A selected target may update its own observed frames and metadata naturally without changing the selected target. Stale, disconnected or retired targets remain unavailable rather than substituting another page/window. Closing an external peer tab only dismisses the view, never closes the real browser page. Exact observer/backend/connection and owner/generation fences remain authoritative; matching URLs or titles do not merge identities. Explicit external opening remains a separate human action with current-target validation. Observation never creates a Turn, dispatches input or changes model context. Read-only observation UI does not disable Agent Browser or Computer tools: those continue through their existing exact-target permission and ownership checks, including hidden targets, without opening or selecting the human view.

The built-in Browser tab glyph has a small neutral activity mark only while its exact-owner tab has actual Agent action or inspection operations in flight, with localized operating/inspection accessible name and tooltip. Loading, permission-ready idle, human activity and settled unknown outcomes do not mean Agent active. An unsettled dispatched action stays marked after human takeover until actual settlement. The indicator never selects, opens, focuses, scrolls or reorders the workspace, and is static under reduced motion and forced colors. No decorative activity row or pulsing address border duplicates the tab icon. Static human-control and dispatched-action-finishing notices, permission details, errors, cancellation and unknown-outcome feedback remain separate and truthful; observation and UI dismissal never replay an operation.

Native same-page/login-state and compositor validation remains distinct from synthetic renderer evidence.

### 2026-10-15: Machine picker and generation throughput

The Run on machine picker has room for device names independently of its compact trigger and remains within the viewport. Final-message telemetry and context usage retain authoritative token counts, cache and context information, but do not show output TPS. Canonical usage has per-response output counts, including reported reasoning tokens and tool-argument generation, but no matching sample start/first-token/end timing. Turn duration includes tool execution and inter-sample waits and must not be used as a generation-rate denominator. Neither text/character counts nor transient message boundaries supply the missing measurement. This applies to live completion, failed/interrupted output and restored history. “Working for” / “Worked for” remains elapsed Turn time, not model speed. Any future TPS must pair authoritative per-sample counts with the same generation interval, explicitly disclose TTFT/reasoning inclusion, exclude tool execution and inter-sample waits, and omit unmatched or partial data.

### Verified remote message sources

Remote source actions read the canonical receiving message's explicit return binding and open a read-only, bounded source dialog naming the exact Host, workspace and Thread. They preserve local main/side selection and Composer drafts. Nested source navigation stays on that pinned Host/workspace; unbound cross-host sources remain unavailable. Trigger source settings are read on the viewed Host by exact Trigger and owner Thread IDs, never the local Trigger editor. Removed, revoked, changed and offline sources keep explicit errors; close, newer navigation and newer source actions retire old results. The dialog keeps keyboard/focus handling and reachable 44px controls at narrow widths.

### 2026-10-20: Process styling correction

The process header stays before history through completion. The work-duration label is explicit rather than bare digits; its exact wording and icon treatment are specified below. Header state still uses the existing phase, approval, stopping, recovery and compact inputs. Tool/reasoning grouping, chronology, raw details, focus protection and default folding are unchanged.

The presentation reference is T3 Code's [shared icon/text overlay](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/MessagesTimeline.tsx#L3479-L3489) and [activity sweep](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/index.css#L540-L610), checked 2026-10-20: a clipped decorative copy, 4.5rem band, 2.2s steps(30), offscreen/hidden pause, and static reduced-motion/forced-colors fallback. ZenX adapts this into the existing ActivityText component, preserving its activity inputs and readable base content. Icons and text share one sweep rather than independently flashing. The icon-to-label gap is 6px; a one-icon group no longer reserves a phantom second-icon column. Existing ZenX capability naming and icon mapping are retained rather than importing T3's execution/group model.

### Work-duration header reference correction (2026-10-20)

The normal turn header follows T3 Code commit
[`90c3f835`](https://github.com/pingdotgg/t3code/blob/90c3f8350d777f09c7afdf643db63bf8135161e6/apps/web/src/components/chat/MessagesTimeline.tsx#L3610-L3639):
`Working for …` during a turn, `Worked for …` after normal completion, both
localized as `已工作 …`. There is no leading activity glyph in this header in
any active phase. Phase feedback remains accessible, and actual activity labels
remain on their original rows. Do not combine a top waiting/thinking prefix with
a separate total-duration label. The completed header retains the existing fold
control as a trailing right/down chevron, consistent with T3's
[TurnFoldTimelineRow](https://github.com/pingdotgg/t3code/blob/90c3f8350d777f09c7afdf643db63bf8135161e6/apps/web/src/components/chat/MessagesTimeline.tsx#L2635-L2654).
Error/retry actions and exceptional terminal feedback remain separate and intact. Live recovery keeps its visible retry/attempt feedback alongside, not inside, the work-duration label. Missing timing inputs use Working/Worked without an invented duration.
Runtime phase calculations, chronology, grouping and fold behavior do not change.

### Activity sweep contrast correction (2026-10-20)

Pinned reference: T3 Code `90c3f8350d777f09c7afdf643db63bf8135161e6`, `MessagesTimeline.tsx` (`ActivityShimmerOverlay`, `LiveActivityRow`, `LiveActivityContent`), `WorkLog.tsx`, `index.css`, and `packages/shared/src/themePalettes.ts`. T3's shared overlay traverses the icon and full activity label, not the row background or trailing controls. Its normal active tool-label path also uses `live-tool-shine`; not every T3 row uses the shared overlay.

ZenX already matched the 4.5rem alpha mask, 2.2s steps(30), and cancelling translation geometry. The mismatch was base contrast: group text/icons inherited secondary text, and tool-category prefixes had their own secondary override. Active base icon, category and full label now consistently use muted text; the decorative copy remains foreground. Inactive rows, counts/status/chevrons, duration header, runtime predicates, order, grouping and disclosure are unchanged.

At normal contrast, T3 default light base/crest are #71717b/#27272a (3.09:1 luminance ratio); dark #818181/#f5f5f5 (3.57:1). ZenX retains its own accessible palette: light #616878/#1c2029 (2.92:1, previously 2.12:1 for group text), dark #898c96/#f0f1f3 (2.97:1, previously 1.79:1). These are solid-color base-to-crest ratios, not an assertion that anti-aliased motion has been visually accepted. The browser capture checks the actual computed icon, full-label and overlay colors as well as separate sweep phases. This is contrast-role parity, not pixel-identical T3 typography or a whole-row pulse.

## Selected-message Copy / Quote and unified references (2026-10-21 draft)

Select text inside a single canonical Agent message to reveal Copy, Quote and Add to side chat. Copy only changes the clipboard; Quote inserts an exact reference at the remembered Composer selection and focuses the same Composer. Neither starts a Turn or sends. Add to side chat uses the same structured message reference, preserving its exact excerpt and source identity without exposing protocol IDs. It appends to the selected side conversation (or the only available side conversation); multiple unselected targets require an explicit chooser. With no target it opens the existing renderer-local side-chat draft, not a native Thread. Existing draft text, images and references remain intact, repeated exact references are deduplicated, and the destination Composer receives focus without sending. Navigation during source loading keeps the draft in its original workspace without stealing focus; a closed chooser target is not silently replaced. Cross-message/control selections are rejected; IME Enter never quotes or sends.

All existing reference types share one compact inline ReferenceToken, interleaved with prose inside the Composer, sent user bubble and queued-message editor. File, Thread/sub-agent and message/selection references preserve their exact text positions; a repeated reference can appear in several places. The same token opens full exact text and source identity, with removal only in editable drafts. Long labels have a bounded width and truncation; the non-shrinking remove button remains at the right edge. Images remain canonical image attachments rather than being silently converted into file pointers.

The existing CodeMirror engine provides atomic token cursor/deletion, undo/redo and IME handling. First insertion transfers the preceding plain draft for undo; new Thread identities reset the editor session. Clipboard copying expands genuine tokens into readable reference strings; pasting external plain text never creates a reference identity. Source popovers preserve the selection. File/Thread tokens are pointers, not included source contents; message excerpts preserve exact whitespace. Navigation uses existing source handling and reports unavailable sources explicitly, without guessed substitutes or automatic content reads.

Production InputMessage reads canonical text parts. The v3 model-facing string preserves readable prose, with an inline typed reference marker at each token. A strict client-bound header and reversible marker/backslash escaping permit exact parsing without hiding malformed, unknown, unbound or noncanonical input. The model receives this ordinary text string, not a new Provider object. Legacy v1/v2 remains readable; those versions have no text-position data, so their original ordered references are shown after their prose, never assigned invented earlier positions. Sent referenced messages keep one Markdown parse, including formatting that spans a reference and code fences; no raw HTML is enabled. Host-added canonical text parts remain visible. Copy-message copies raw input; submission, queue identity, revision, retry and acceptance ownership are unchanged. Presentation binding is not cryptographic provenance.

The synthetic full-context preview exercises selection → quote → interleaved editing → explicit send → projected native userMessage with no Provider call. A separate no-network capture passes the same input through real native admission, runtime and Provider request construction and persists only the actual user-message text, not system or tool prompts. Real-browser keyboard, pointer, narrow/touch-emulated layout, pending queue edits and long-token geometry are required before visual acceptance or merge. Physical touch and OS clipboard permission checks are not claimed by desktop emulation.

### 2026-10-20: Thread title authority over wakeup first messages

A Thread's own name is the single source of its displayed title, whether it comes from staged automatic naming or from the user's explicit rename. The first-message preview is used only while that Thread has no name at all — including a machine Room/Trigger wakeup envelope when that is the first message, which is therefore shown as the provisional title exactly like any other first message. No wakeup-derived stand-in ever replaces a name, in the sidebar, the conversation title bar, the PAW workspace, the Composer Thread reference picker or anywhere else; the short disclosure label is reserved for a legacy name that is itself an unmodified raw wakeup prompt. Thread rename inputs start from the Thread's exact current name, so submitting an untouched editor can never rewrite that name; a Thread with nothing but machine or placeholder text offers no name to save.

### Streaming activity excerpt and DSH sweep (2026-10-21)

Active collapsed groups and item rows show actual public item content: `Thinking` / `思考中` followed by a latest-text excerpt of at most 240 Unicode characters of exposed reasoning text (falling back to the provider summary, then the plain localized label), or the complete `item.command` with its existing tool category. Omitted reasoning context is marked with a leading ellipsis; a partial leading Latin word is skipped without splitting Unicode characters. Whitespace is collapsed for the reasoning excerpt only; full reasoning and command remain in their original disclosures. The preview is one line, at most 72ch and bounded by the row; an overflowing excerpt fades over its final 48px without fading short text. Streaming updates do not reset group membership, order, disclosure state, observed task state or the top work-duration header.

The sweep belongs only to the chronologically latest process sequence in the running Turn, whether a single Thinking / Tool row or a grouped sequence. A newer sequence takes ownership immediately across assistant-message boundaries, even before its tool result exists. Earlier background tasks keep their actual status and counters but do not sweep. The latest header also carries the Turn-level sweep during model-only continuation after its tools have settled; tooltip and accessible text explicitly describe the Agent still working, not the tools still executing. Expanded nested rows do not duplicate that sweep. Pending approval, stopping and terminal Turns are static; no synthetic reasoning/history Item is inserted to create an indicator.

The exact animation reference is DeepSeek Harness [`639ed015`, TextShimmer.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-primitives/src/TextShimmer.module.css): a width-relative 105° mask with transparent 0%, black 40–60%, transparent 100%; 1.5s `steps(48, end)`, 0.3s initial delay, −100% to +100% travel during the first 66.6667% and a hold for the remaining cycle. The counter-transform keeps icon strokes, prefix and excerpt aligned under one sweep. The separate excerpt fade follows [`ReasoningRow.module.css`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-chat/src/client/chat/ReasoningRow.module.css). This supersedes the earlier fixed 4.5rem T3 band, not the accepted T3-style top header. Existing ZenX muted base/foreground crest tokens, hidden/offscreen pause and static reduced-motion/forced-colors fallbacks remain.

### 2026-10-20: Bundled What's New

A compact release-notes icon sits at the right of Settings in the same Sidebar footer row, replacing the decorative service-status dot without adding row height. Settings and What's New / 更新内容 are sibling buttons with independent pointer and keyboard targets; the notes icon has a localized tooltip and accessible name. Service runtime behavior, Settings status text and non-ready Sidebar feedback remain unchanged. It opens a compact, date-grouped dialog of changes included in this build, not an updater or a promise of unmerged features. Notes ship locally with stable release and item IDs independent of the package version. Opening is always explicit; there is no startup modal, unread badge, read-state persistence, network request or new permission. The shared Dialog owns focus trapping, Escape, outside dismissal and focus restoration. Notes scroll inside the dialog, with the close control always visible; repeated opening never navigates away from the current conversation or changes its draft.

### External file opening

The file location toolbar has an external-open icon using the shared keyboard-accessible action menu. Reveal in Finder / File Explorer / file manager is distinct from opening the disk file in its default application, VS Code, Cursor, a text editor, or a custom application. Fixed known installations are detected without launching them; a native application picker configures an application path in the existing host profile. No shell command, argument template, credential or access setting is accepted. Missing applications remain explicitly unavailable until configured; the compact menu lists them in application management rather than as disabled opening actions. Unsaved, saving and conflicting files must be saved/resolved before an external editor can open their disk version; revealing the location remains available. Opening errors stay in the file pane; application-selection errors stay in the management dialog. This operation belongs only to the local desktop Host; remote Fleet files are not mapped to local paths.

#### Selected design: compact external-open menu B

The user selected compact option B on 2026-10-25, retaining the flat menu in PR #465 only as historical comparison. Frequent opening actions stay in the shared action menu: reveal, default open, and available applications. A single Manage applications entry opens the existing shared Dialog for the bounded, infrequent path-selection task; it does not turn other settings or ordinary opening into modal workflows. Four named application sections expose full paths through keyboard-operable details. Native picker selection and explicit custom removal retain immediate host-profile persistence, explained in the dialog; Close and Escape dismiss presentation, not undo earlier choices. Pending actions remain guarded across close/reopen, errors stay visible beside configuration, and file/thread changes retire presentation and late replies. No new Host routing, launch, permission or persistence semantics are introduced. The icon-refined implementation remains a draft until matching browser evidence and review; selecting the design does not itself merge this PR.

External-open compact menu keeps readable action labels alongside uniform 16px decorative icons from the shared registry: file manager, default opening, app identity, and a settings gear for management. The same app marks appear in the management dialog; unknown custom applications use the shared generic fallback. Icons are bundled locally, not fetched or extracted from native apps.

### Context pressure details

上下文圆圈 hover/click 默认只展示彩色分段占用条、系统/工具/插件/对话四个短标签及数值；颜色与文字一一对应，不依赖颜色独自传达含义。分项之和等于估算总数，剩余窗口保留底色。面板仅展示产品的单一统计，不显示说明段落、估算详情或第二个历史值；缓存项写全“线程缓存命中率”。工具项包含已披露插件 SDK；插件项是注入消息，不重复计算。当前沿用字符启发式而非 tokenizer，对中文等内容可能明显偏差；媒体和协议开销也不是精确计费，不能把估算称为准确值。不展示不存在的 MCP 分类，不因 hover/click 向外发送历史或草稿进行网络计数。

### Message file-path links

Message Markdown may render clear local paths as keyboard-focusable links. Activation opens the existing right-side file viewer for the Thread's runtime Host workspace, not the browser client's machine, an external app, or an executable. Rendering does not probe files; unavailable, outside-workspace and permission-denied targets retain the existing explicit error flow. UNC/network authority links are not supported.

Unquoted automatic paths require a directory and file extension; paths containing spaces must be quoted or inline-code delimited. Extensionless automatic paths additionally require an absolute path or an explicit `./` or `../` prefix (for example, `./docs/README`); a quoted bare relative `docs/README` remains inert. Fenced code, ordinary standalone filenames and ambiguous prose are not auto-linked. Existing explicit Markdown links remain supported. Windows drive paths and local file URLs use the same Host containment checks. Conventional `#L12`, `#L12C4`, `:12` or `:12:4` suffixes on file paths open the underlying file; this does not claim exact-line scrolling. Percent-encoded filename punctuation remains literal. Canonical content and copy text are unchanged.

A closed top-level `text` or `plaintext` fenced block containing exactly one whitespace-free local path offers a separate **Open file** header action alongside Copy. Code remains literal and copy remains unchanged; incomplete, multiline, command-like, reference-bearing and other-language blocks have no file action. Activation uses the same current-Thread Host workspace reader, never execution or an external app.

### Unconfirmed provider shutdown

If bootstrap join or Host cleanup cannot confirm completion within its reporting
deadline, Quit remains blocked. Show the existing standard localized error dialog
once for that shutdown attempt sequence; retain any existing stopping indicator
and do not silently force termination or report a successful exit. Repeated Quit
only observes the same pending cleanup, never restarts stop/input. Late completion
does not automatically quit; the user may explicitly choose Quit again.

### Packaged editor style security

File/source editors and the inline composer share the current renderer document's
trusted style nonce for CodeMirror runtime styles. Packaged acceptance uses the
actual renderer CSP, not a permissive preview policy; missing/incorrect nonce
styles remain blocked. Fixing layout or focus must never broadly permit inline
styles or scripts, and editor scrolling stays inside its bounded pane.

### 持久 Trace 与模型上下文调试

- 调试器是常开本机持久 Trace 的只读消费端，不拥有 capture、开关、清空或重放能力。关闭面板与重启不能删除记录；没有捕获的 actual transport 必须不可用，不能由 ItemList 反推伪造。
- 普通会话渲染语义内容与日志派生的产品状态，ItemList 只呈现精确 role/content/provenance，不混入 runtime/control 日志。来源不是角色：Host 包裹的用户选择仍是 user 数据，不升级为 developer 指令；时间/引用可友好呈现但保留精确模型文本。
- Model sample outcome、HTTP dispatch evidence、raw response EOF 是三个独立观察。模型已完成而 HTTP tail 未完，显示回复已完成且捕获未知；HTTP EOF 也不能遮蔽模型解析失败/取消。无终态的冷历史显示 unknown，不能假装仍在运行。
- request_body 是准备字节；只有 model_request_dispatched 证明开始调用 fetch（不是提供方已接收）。blocked 显示未派发；不能把早先重试的 EOF/耗时用在当前尝试。整体 sample 耗时与逐 attempt 耗时分开，跨单调时钟域不能相减。
- 所选详情显示同次读取的状态及字节；索引轮询不能悄悄用新状态覆盖旧详情。Thread 切换、作用域、查询、关闭、重复打开和重叠异步请求都有 freshness fence。窄面板 list/detail 分层，Back 返回同一行键盘焦点。
- 当前 UI settings 与 frozen sample configuration 显式分开；改变当前模型/权限不会改变已捕获请求。内部 ID/headers/metadata 按需披露，不倒灌普通消息或模型上下文。
- 本机原始内容仅省略认证 headers 的 API Key，不 broadly redact body；导出清理另行处理。元数据索引不声称已验证所有 artifacts，逐次读取校验原始 hash/length；部分/损坏/缺失显示未知与原因，同时保留已知事实。
- Trace IPC 仅允许 owned ZenX window 的 main frame、精确 renderer URL，拒绝 webview/subframe/foreign window/origin。All local 范围明示含辅助 title/probe，不能为了日志制造假用户消息或隐藏 chat Thread。
- UI 验收必须使用生产组件、合成数据、精确 source/bundle SHA 的真实截图与原始 lifecycle receipt。JSDOM、HTML bundle 和未运行 CI 不等于视觉通过；未完成截图不能合并。

发送时间线保留 UI handler 在任何异步准备前取得的 renderer-reported activation，
与 Host 实际收到请求的时刻分开。UI/tool 入口不等于已验证的“真人操作”。
新建 Thread 前的点击只是一条本机 Trace 观察，不制造空 Thread、用户消息或模型请求。
独立观察无法送达或写入失败须显式报告；没有 Host 收件/采样记录只能显示未观测。

Trace「时间线与事件」显示准备/语义落盘/编译、实际 Fetch、首次收到响应字节、
公开推理/摘要/文本、sample 结束与 raw EOF；不把空 delta、opaque continuation 当作
已收到公开推理，不推测隐藏思考或 token 生成时间。缺失阶段显示未观测/未知，
编译失败仍可独立查看，不伪造已发出的模型请求；重试只能用自身 attempt 的事实。

### Sidebar log-derived state

Sidebar 的已提交 patch/state 日志是恢复真相源；当前 map / JSON 只是可重建缓存，
保留既有 Thread/Room scope、CAS revision、tab 与资源权限。未确认日志持久成功时
不能 ACK 或通知成功；下一次读取先核对日志，不凭旧缓存重试。旧 JSON 仅一次显式
legacy import，导入时间不是历史点击时间。UI/tool 来源由可信入口固定，不等同于
真人操作；这些产品事实不进入模型 ItemList。缓存写失败不撤销已经持久的事实。

App-current-focus keyboard permission explains that the selected app’s own windows may reorder behind the current foreground app while foreign windows, global foreground and hardware pointer stay stable; it grants no exact-window guarantee and does not relax the separate exact-window click contract.

### 本机错误透明度

本机操作错误必须说明已知阶段与结果：明确未提交的失败不得伪装成“结果不确定”；只有缺乏提交证据的传输等异常才显示未知，禁止自动重放。用户可展开查看本机原始可用错误详情，按纯文本换行/滚动展示，不执行其中的 HTML；不能以保护隐私为由隐藏用户自己的错误证据。认证请求头中的 API Key 省略与对外导出清洗仍在各自边界处理。压缩已提交后仅界面刷新失败时，保留“已压缩”事实并展示刷新错误，不引导重复压缩。

Provider 保存错误的稳定摘要不替代本机诊断：编辑器中的失败与关闭编辑器后的已提交警告，都须保留默认收起的纯文本详情；IPC 未知结果不推断成失败或自动重试。Host 的 settings.jsonl 仅增加异常详情投影，不记录表单/API Key 输入，单条详情最多 32 Ki 字符并明确标记截断；现有滚动日志是有限诊断，不冒充完整 Trace。

图片加载失败保持简短摘要，但队列缩略图及预览必须提供默认折叠的本机错误详情；详情为纯文本，不写回模型内容。预览里的详情摘要与正文可由 Tab 到达，Escape 与关闭后焦点恢复不变。重试仍是明确用户动作，不因展开详情重发模型/工具请求。

### Interactive information board

Information contributions use the existing top-right Board button to toggle a popup; the popup has no duplicate icon/title, pin or close header. The open button uses only a deeper neutral surface background, never an accent color or highlight; its accessible pressed/expanded state tracks visibility. The information host has no separate pin mode and does not read or write the obsolete renderer pin preference. Information contributions are not Browser/File resource tabs and do not replace the Composer. The Board plugin provides questions, forms, metrics, notes, progress and shortcuts as convenience templates alongside arbitrary isolated HTML/CSS/JS. Agents define event behavior: local UI/navigation, explicitly assembled model messages, permission-gated non-model execution, or conditional combinations. Each model-delivery action names the owning Thread or Room member and reports admission, not completion. User fields survive hide/show, owner changes and document updates; stale revisions fail explicitly, without silent overwrites or retries. Background updates never open the board, change the selected conversation or move focus. Popup Escape returns to its trigger, outside dismissal remains available, and the same popup stays usable at narrow widths. Closing and reopening through the Board button preserves user fields without sending or navigating.

### Send admission feedback (2026-10-28)

Auxiliary title staging must not block input admission. Its own receipt or failure
updates naming feedback independently; sending still uses exactly one normal
AppServer request and never adds a model call or automatic retry. The submitted
draft remains recoverable until an admission reply or the exact canonical client
identity confirms acceptance; later edits cannot be cleared by an old reply.

A live `turn_started` can precede durable initial input. An empty running Turn
therefore shows **Preparing**, without elapsed agent-work time or an invented
user bubble. Once admitted input (or actual runtime content on a restored view)
is present, the existing canonical start timestamp supplies the total duration.
When native compaction feedback is pending and the Turn still contains only
input, show **Preparing for** that same elapsed duration; once the observation
settles or runtime output arrives, retain the same clock rather than resetting
it. Without a preparation observation, do not infer a precise model phase.
An active Turn continues its existing duration while a steer is pending. No
canonical timestamps, Trace observations or runtime ordering are rewritten to
make the interface appear faster.

### Tool result destination actions

跨线程发送与创建/修改触发器的工具记录提供独立于详情展开的目标动作。发送动作只通过工具结果与既有 canonical ref 身份打开目标 Thread 的确切已送达消息，并暂停自动跟随、滚动和聚焦该消息；排队回执只通过 canonical client 身份关联其实际送达 Item。触发器动作复用已注册插件 Tab，打开精确 definition，而非按名称搜索。缺失、排队、已归档、远端路径不可用或插件缺失必须如实说明，不选择相似对象、不重放工具、不在查看时执行或保存触发器。

### Current background commands

A compact disclosure above the Composer reads the existing local Shell session list for the exact current Thread, independently of Agent Turn completion. It displays the actual number of native-observed running Agent commands; queued, starting, foreground-exited/output-collecting, stop-requested and stop-unconfirmed tasks are separate facts, never guessed running or stopped from historical tool receipts. The expanded list retains each command and current observation and opens its exact Terminal session in the existing owning Thread/Room sidebar. Reading or navigation never starts a Turn, creates a terminal, retries an Agent or inherits a source Thread's live tasks after fork. The list refreshes while mounted, including after the Turn ends; read failure removes stale running counts and offers explicit Refresh with original local error details. Finished/expired tasks cease contributing to the running count; retained output and exit status remain available in Terminal.

### Context compaction trigger transparency

自动与显式生成压缩的原生实时观察复用现有 composer 压缩状态：开始显示发起者和触发原因，
包括下一轮接纳前等待；成功只来自已提交 canonical 选择，失败/取消与提交未知明确区分并保留
可展开本机错误与阈值证据。非活跃/新建 side chat 的精确 child Thread 亦接收反馈，不能提前假称
输入已接纳或 agent 已开始工作。失联使 pending 观察变成未知，不自动重试；重新读到同一唯一
committed Item 或开始时 canonical 前缀之后新提交的匹配压缩才消除此未决反馈；旧的同 boundary 压缩不能抹掉新的进行中或失败。显式请求身份独立于状态对象，只有同一请求且未编辑的原草稿可清空。既有设置清楚说明 agentic 开关不关闭宿主
自动压缩，以及完成后、发送前、活动工具轮之间的不同条件；不新增开关或修改阈值策略。

### Legacy quote presentation

The exact leading legacy `[Message quote; ...]` transport is rendered through the same inline reference component as current quoted messages, retaining exact selected text and source navigation. Real line breaks appear in the expanded excerpt; source IDs belong in the explicit source details, not the message bubble or plain-text clipboard. Malformed or embedded illustrative text stays literal. New structured sends retain provenance independently of readable clipboard text.

Copying or cutting a capsule between main and side-chat composers preserves its exact source and selected text through structured clipboard metadata; external plain-text applications receive readable text with real line breaks and no injected source IDs. Pasting into a plain or rich Composer preserves surrounding draft text and existing capsules, positions the caret after the inserted content, and never sends automatically. Cut/paste participates in native editor undo/redo; malformed or mismatched clipboard metadata falls back to ordinary text rather than guessing a source.

### Experiment / TBD: pending steer 全部撤回到输入框（2026-11-02）

**设计提案，未实施、未通过完整 App 验收，不覆盖本文已生效规则。**
普通消息发送性能修复独立进行，不以本功能为前置条件。

#### 范围与入口

初版只覆盖当前私有 Thread 的人类 steer：Host 已持久接纳，但尚未由下一次
模型输入准备过程 claim 的消息。“全部”是点击时的精确快照，不包含后来到达的
消息、其他 Thread、Host/Agent 输入或明确选择 Next turn / Each turn 的队列。
Side chat 必须使用自身精确 Thread，只有实现验证归属和权限后才能纳入；不承诺
Room 或跨作者撤回，也不根据消息正文推断作者。

工具执行或压缩期间仍可接纳普通消息为 pending steer。撤回不停止 Turn、
不中断工具或压缩、不跳过完成边界、不删除已进入模型上下文的内容。

Composer 上方的待处理区域显示“等待进入模型 · N 条”和“全部撤回到输入框”；
单条时使用“撤回到输入框”。采用清楚的文字按钮，不以停止或删除图标替代含义。
内容、图片和引用继续可见，真正被截断的内容可展开。

状态区分接纳中、等待进入模型、正在撤回、已进入模型输入、撤回结果尚未确认、
已撤回。只有权威 pending 状态可撤回；不能根据没有首 token、正在工具调用或
没有 provider dispatch 记录推断。已撤回与已恢复到输入框是两个事实。

#### 原子批次

请求包含精确 Thread、唯一操作 ID，以及快照中所有消息的 ID、client ID 和
revision。服务端在 admission / model-input claim 共用的 Thread mutation fence
内校验全批来源、权限、状态和版本。任一目标已 claim、已变化或不合法，整批不执行；
不能以逐条 Cancel 或多个请求模拟原子撤回。

全批符合时提交一个持久批次控制事实，持久成功后才能 ACK。点击后新到达的消息
不纳入快照。冲突显示“消息状态已变化，本次没有撤回。请查看仍在等待的消息。”
刷新状态后由用户再次明确操作，不自动扩大目标或重试。

**拟议生命周期：保留已有投递策略，不自动启动新 Turn。**
正常完成检查发现绑定当前 Turn 的 pending steer 时，继续同一个 Turn 的处理循环，
不是创建新 Turn。Stop、执行错误或进程崩溃后，未 claim 的消息保留为 held，
不自动运行、恢复或调度任何 Turn。它们仍可全部撤回，界面明确显示：
“这些消息尚未进入模型；再次发送/继续时会一并提交，可先全部撤回”。

下一次由用户独立明确授权的发送、继续、Retry 或 Replace 接纳，才按原始接纳顺序
携带这些 held 消息，位于该次新输入之前；具体入口仍遵循已有权限和投递策略。
这不是自动重试、自动新建 Turn，也不是将 steer 转换为 follow-up。绑定已终止
Turn 的 pending 状态不可用于复活该 Turn。普通 next-turn 队列选择及 queue_pending
检查必须区分 held steer，避免把合法显式 Retry 错挡为尚有普通队列。

上述为兼容既有策略的设计决定，尚未实现。claim / recall / 正常完成 / Stop /
error / crash / 下一次显式接纳的全部竞态及顺序须通过原生验收。

#### 合并回输入框

仅在权威成功回执确认后恢复。按原始接纳顺序合并各条正文，以两个换行隔开；
不注入编号、时间、来源 ID 或其他元数据。现有草稿完整保留在最后，中间以空行
分隔。使用最新草稿的原子 reducer 合并，不用点击时旧快照覆盖之后的输入。

图片按原消息顺序及每条内部顺序恢复，再保留现有草稿图片；相同图片不擅自去重。
保留 AttachmentRef，给草稿元素分配唯一身份；撤回投影的移除不能释放仍被回执
或草稿引用的附件。多条消息下次成为一条消息，图片使用现有 Composer 图片区，
不宣称原来的多模态逐消息分段完全不变。

文件、Thread、选中文本等引用保留结构、位置及来源。每条先以自己的原 client ID
解码引用，再合并结构化草稿；下一次显式发送使用新的 client ID 编码。禁止拼接
序列化引用头，禁止把图片转换为文件指针。不能无损转换的技能、音频等输入明确
说明阻碍；不能先撤回再丢弃，也不能把部分恢复伪装成全部成功。

普通成功无需确认弹窗，不自动发送。仅发起操作的仍存活窗口可以自动合并。
Composer 正在提交、目标 Thread 已切换或无法安全合并时，保留恢复卡片：
“已撤回 N 条，内容已保留。恢复到输入框”。不自动导航、不抢焦点、不改写未决
submission。用户明确恢复时仍以最新草稿进行非覆盖合并。

#### 失败、未知与崩溃恢复

明确未提交的失败保留待处理消息及草稿，展示原因和可展开的本机原始错误详情。
传输异常显示“撤回结果尚未确认”，保留操作 ID 和目标快照，通过只读查询确认
精确回执。“检查结果”不是重放；没有证据不自动取消、不恢复文本、不重新发送。

不全局锁住 Composer，不等待压缩结束。新的普通消息可独立发送，使用独立身份，
不加入旧撤回快照；仅禁止对相同未决批次重复操作。

持久 RecallReceipt / 批次控制事实通过原始输入及已提交编辑事实保留可恢复的
结构化内容，不新增一份可编辑历史。**不因此把普通 Composer 草稿改为 Host
持久存储，不承诺跨窗口自动插入 exactly-once。**

其他窗口更新撤回状态，但不自动插入自己的草稿。窗口关闭、崩溃或重启后，
从精确回执提供用户明确操作的恢复卡片。如果可能已经恢复过，明示
“再次恢复会追加到当前草稿”，由用户决定，绝不自动追加或发送。
一次内存合并不能成为永久交付证据，不能据此丢弃原始恢复依据及附件引用。

旧版本已经提交为模型语义 user_message 的 steer 不获得追溯撤回能力，
不能仅凭未发现 dispatch 就从 ItemList 移除。

#### 可访问性与验收

使用共享按钮、本地化、焦点和错误组件；完整中英文及数量文案，键盘可达，
至少 44px 操作目标，状态不只依赖颜色。仍在原 Composer 的成功恢复可返回输入焦点；
用户已导航或正在其他区域编辑则不抢焦点。不新增发送/撤销快捷键。
390 × 600 窄窗口中批准请求、待处理内容、错误和 Composer 均须可达。

完整真实 App 验收至少覆盖：

- 长对话普通发送及时反馈；工具/压缩期间 pending steer 可见，撤回不终止工作。
- claim 赢得竞态则全批不执行；任一 revision 变化或权限失效同样全批失败。
- 点击后新到消息不被旧快照包含；目标 Turn 结束行为符合明确的既有策略。
- 空草稿、已有草稿、请求期间输入、正在提交、切换 Thread 均不丢失内容。
- 多正文、重复图片、结构化引用及特殊字符正确合并；不支持输入不被扁平化。
- 明确失败、响应丢失、重复查询不重复撤回、插入或自动发送。
- 发起窗口关闭/崩溃后可明确恢复；其他窗口不自动插入。
- 撤回输入不进入后续模型请求；已 claim 输入不能撤回；ItemList 不改写。
- 中英文、键盘、窄窗、深浅色完整页面截图绑定精确源码与 bundle SHA。

未运行的测试标明未验证；单组件测试、示意图及未运行 CI 不是完整 E2E 通过。

#### 已查阅依据（固定源码）

- [普通 steer 当前直接提交 user_message](https://github.com/albert-zen/zen/blob/6aa0a5055530eeb018cc41a3ce486603756c06bb/src/app-server.ts#L4441)。
- [现有队列取消逐条提交](https://github.com/albert-zen/zen/blob/6aa0a5055530eeb018cc41a3ce486603756c06bb/src/app-server.ts#L2740)，不可直接冒充原子批次恢复。
- [已有草稿、图片及客户端绑定引用转换](https://github.com/albert-zen/zen/blob/6aa0a5055530eeb018cc41a3ce486603756c06bb/apps/zenx/src/renderer/src/queue-edit-draft.ts)。
- [已有精确编辑回执的未知结果查询](https://github.com/albert-zen/zen/blob/6aa0a5055530eeb018cc41a3ce486603756c06bb/apps/zenx/src/renderer/src/queue-edit-request.ts)。
- [T3 Code 待处理消息 UI](https://github.com/pingdotgg/t3code/blob/5cc99e1c23980d7995a13c47f969b47cb68ed1be/apps/web/src/components/chat/MessagesTimeline.tsx#L1780-L1870)
  区分 queued / sending，提供 “Cancel and return to the composer”。仅借鉴状态与
  操作文案，不以此证明它或本提案具有原子批次、跨窗口恢复或后端竞态安全。

本提案的初期后端草稿只将有稳定 client ID 的 native 人类普通发送及显式 steer
接到 Core staged admission。旧 Core/CAS steerTurn 保留立即模型语义兼容行为，
不显示可撤回承诺。后端草稿及其单测不代表输入框恢复、完整 App 或安装版本已验收。
