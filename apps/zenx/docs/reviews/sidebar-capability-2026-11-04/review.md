# 右侧栏能力设计评审（2026-11-04）

范围：`zenx_self_control_sidebar_read` / `zenx_self_control_sidebar_update` 及其 Host 实现，
以及它们与 Thread/Room 状态、information 组件、插件面板、Thread 可见性的边界。

基线：`origin/main` 3b411e84。本文只记录判断与证据，**不改产品行为**——下面每一条要么需要
产品语义决策（共享/只归人），要么会改变 agent 可见契约，按 `AGENTS.md` 不能由实现方自行拍板。

## 1. 参与评审的实现面

| 层               | 文件                                                                                                   | 作用                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 契约（模型可见） | `apps/zenx/src/main/capabilities/model-sidebar-facade.ts`                                              | 两个工具的 schema、ref 解码、描述文案      |
| 工具实现         | `apps/zenx/src/main/capabilities/self-control-package.ts:585-900`                                      | scope 解析、snapshot CAS、patch 绑定       |
| scope 授权       | `apps/zenx/src/main/sidebar-tool-scope.ts`                                                             | 默认 scope、Room 成员实时校验、资源绑定    |
| 状态机           | `apps/zenx/src/thread-sidebar-state.ts`                                                                | `ThreadSidebarState`、patch 语法、变更来源 |
| 组件布局         | `apps/zenx/src/information-layout.ts`                                                                  | information 组件定义、操作语法、编辑权     |
| 持久化           | `apps/zenx/src/main/thread-sidebar-store.ts`                                                           | revision、原子写                           |
| 人类侧 UI        | `apps/zenx/src/renderer/src/Sidebar.tsx`、`sidebar-thread-information.ts`、`bundled-automation-ui.tsx` | 渲染、临时视觉状态、插件面板               |
| 产品规则         | `apps/zenx/docs/ui-ux.md` §2.1、§2.3                                                                   | durable semantics（本文的判据来源）        |

## 2. 现在实际成立的分层（这一点做得好，先固定下来）

下面几条是我逐条对照实现确认的，不是文档复述：

1. **agent 读的是状态，不是屏幕**。`sidebar read` 返回 persisted state + `revision`，
   工具描述明确写 "This is state, not evidence of screen visibility"
   （`self-control-package.ts:587`）。人类的全屏/临时视觉状态不进入这个读模型
   （`ui-ux.md` §2.1：人类操作立即反映、不等待 durable 提交）——这是正确的边界：
   agent 不应该靠“看起来没人看”来推断可以改。
2. **写操作是 CAS，不是覆盖**。update 必须带 read 返回的 `snapshot`；冲突返回
   `applied:false` 加当前状态，明确要求“重读后再决定”，不自动重试
   （`model-sidebar-facade.ts:108`、`self-control-package.ts:874-900`）。
3. **scope 只在自己的私有 Thread 或当前所属 Room**。`resolveSidebarScope` 用 live
   membership 过滤，越权的 kind/id 直接拒绝；多个 dedicated binding 时强制显式选择
   （`sidebar-tool-scope.ts:22-69`）。
4. **agent 不能把资源改绑到别人身上**。`bindSidebarResources` 只允许原样保留他人的
   `resourceThreadId` 描述符，改动即报错（`sidebar-tool-scope.ts:71-103`）。
5. **组件内容不归 agent**。read 的 `includeInformation` 只给静态组件定义与布局，
   "never provider content or availability"；人看到的 Trigger 事实由 renderer 自己经
   插件快照读取（`renderer/src/sidebar-thread-information.ts:24-57`）。agent 拿不到
   人的数据内容，只拿到“这里有个 triggers 组件”。
6. **别人的组件只能移动**。`bindInformationEdits` 对非 move 操作要求编辑权
   （`information-layout.ts:431-438`）；reset 会先检查所有实例是否可编辑
   （`information-layout.ts:422-430`）。

结论：能力面本身没有“agent 能读人的私有内容”或“agent 能改别人 Thread 的资源绑定”
这类硬问题。下面是我认为仍然不合理的部分。

## 3. 发现

### F1 Room 的“展示态”和“共享状态”是同一条记录（影响面最大）

`ThreadSidebarState` 以 owner 为键（`kind: "thread" | "room"`），`open`、`fullscreen`、
`selectedTab` 与 `tabs` 都存在同一条状态里（`thread-sidebar-state.ts:25-40`）。
Room 只有一条状态，于是 agent 调 `sidebar_update({open/fullscreen/selectedTab})` 改的是
**房间里每个参与者看到的展示**，而工具文案只承诺“不抢占前台/不切焦点”。

这是两种不同性质的事实被压在一个 owner 上：

- `tabs`（有哪些面板）是房间的共享事实；
- `open`/`fullscreen`/`selectedTab`（现在看哪一个）本质是**看的人的选择**，人是可以各自不同的。

建议（需要产品决策）：

- 方案 A（推荐）：把 presentation 三维拆成 per-viewer 状态，agent 写入只影响调用者自己的视图；
  房间共享的只剩 `tabs` 顺序与信息组件布局。
- 方案 B：保持共享，但在工具文案与 `read` 返回里显式标注
  `presentationScope: "room-shared"`，让 agent 知道这一步会改变所有人的视图。

在决策之前，现在的实现既不明确也不安全：agent 很可能为了“把某个面板显示出来”而改掉
一个正在被别人看着的房间视图。

### F2 tab 没有来源归属，agent 的 `tabs` 替换会静默关掉人的面板

`ThreadSidebarTab` 只有资源字段和可选的 `resourceThreadId`（`thread-sidebar-state.ts:15-24`），
没有“谁加的”这一维。`SidebarChangeSource` 只在 `update` 的调用参数上携带来源
（`thread-sidebar-state.ts:52-53`），持久化状态里没有。

后果：`tabs` 是整体替换语义（工具文案要求 "preserve tabs you want to keep"），所以 agent
一次替换就会把**人自己打开的面板**一起丢掉，而且事后无法区分“这是人加的”还是“这是 agent 加的”，
连人类 UI 也无法据此提示“这个面板是我开的、被 agent 关闭了”。

建议（需要产品决策）：

- 在 tab 上持久化 `authoredBy: "human" | "tool"`（来源已有，只是没落盘）；
- 或者：替换时对人写的描述符要求显式 `drop` 标记，否则拒绝并返回需要保留的列表。

我倾向第一条：它同时让 UI 能显示来源，且不需要在写路径上新增拦截。

### F3 Room 级信息组件没有归属，人类放置的组件可被 agent 删除/重置

Room 里 `source: "room"` 的组件 binding 是 `{kind: "owner"}`
（`information-layout.ts:155-176`），而 `canEditInformationWidget` 对 `owner` 一律返回 true
（`information-layout.ts:336-344`）。也就是说：房间共享组件（例如有人放的 Board 位置）
对**每个** agent 都可编辑，包括 `remove` 和 `reset`。

同时错误文案是 "Another member's information instance may only be preserved or moved"
（`information-layout.ts:436-438`），会让人以为房间级组件受保护——实际不受。

建议：room 级组件也要有 `authoredBy`，人放的组件对 agent 只读（允许 move）；文案与实现一致。

### F4 `reset` 的实际效果是“隐藏”，不是“删除”，但返回里没有区别

`reset` 把未出现在默认布局里的组件改成 `visible: false` 并留在数组尾部
（`information-layout.ts:291-314`）。这是合理实现（可恢复），但 agent 的读模型里只能看到
`visible: false` 的实例，无法区分“我删掉的”和“被 reset 隐藏的”。建议在 read 的实例投影里
加一个 `hiddenByReset`/`origin` 事实，否则 agent 会反复 add 已存在的组件（Board 尤其明显：
`add` 会受到 `Duplicate Board document placement` 拒绝，`information-layout.ts:286-289`）。

### F5 `authorizedScopes` 静默截断到 101

`sidebar-tool-scope.ts:68`：`choices.slice(0, 101)`。房间数超过 100 时，agent 看到的
授权 scope 列表被悄悄截断，且没有 `truncated` 标记。仓库里其他有界列表（browser observation、
trigger 列表等）都会显式标注截断，这里不一致。建议加 `scopeTruncated: true`。

### F6 非问题，但值得写进文档：默认 scope 可能直接落在共享 Room

当调用者是某个 Room 的唯一 dedicated assistant 时，不带 scope 默认操作该 Room
（`sidebar-tool-scope.ts:56-59`）。read 会返回 `defaultReason`，update 又必须带 read 的
snapshot，所以链路是可解释的；但这个默认值意味着“agent 第一次写就写进了共享房间”。
建议：在 `ui-ux.md` 的侧栏章节把这条默认值与 F1 的展示态问题一起写明，
避免以后被当成实现细节改掉。

### F7 插件面板：agent 能开，但不能代表插件执行

`plugin` tab 只是 `pluginId + panelId` 的引用（`thread-sidebar-state.ts:17`），
工具文案承诺 "No provider content/action or foreground change occurs"。
这一条与实现一致：打开面板不触发 provider 调用，真正的渲染在 renderer 侧
`bundled-automation-ui.tsx` 里按可见性加载。这个边界是对的，建议在 review 清单里保留为
不可回退项（避免以后为了方便让 agent 触发插件动作）。

## 4. 结论与后续

- 能力面（scope、CAS、资源绑定、组件编辑权）设计是合理的，问题集中在**归属**：
  我们缺“谁写的”这一维（tab、room 级组件、reset 隐藏），于是“只归人的东西”在数据上不存在，
  只能靠文案自律。
- F1 是唯一会直接影响他人的问题（改房间共享展示态），建议优先决策。
- F2/F3/F4 是同一条根因（缺 `authoredBy`），适合一个 PR 一起做。
- F5 是一个独立的小修，可以随时做。

需要用户决策的点：

1. 侧栏 presentation（open/fullscreen/selectedTab）是 per-viewer 还是 room-shared？（F1）
2. 人添加的 tab / room 级组件对 agent 是否只读（只允许 move）？（F2、F3）

在这两个问题有结论之前，我没有改动任何产品行为：任何一处都会改变 agent 可见契约或
人类可见交互，属于必须由用户拍板的范围。
