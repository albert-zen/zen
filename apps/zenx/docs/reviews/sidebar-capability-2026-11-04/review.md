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

### F0 先纠正我自己：Room 侧栏共享是已定决策，不是待定问题

本评审第一版把“Room 的 `open`/`fullscreen`/`selectedTab` 与 `tabs` 存在同一条状态”
当成需要决策的设计问题，并建议拆成 per-viewer。这是错的：
`ui-ux.md` 早已写明“Thread / Room 辅助侧栏的开合、全屏、标签顺序与选择由同一个
main-process revision/CAS presentation store … Room 使用相同工作区界面”。
房间的侧栏就是这个房间的，对该房间所有成员是同一份共享状态，**不按观看者拆分**。
同类地，“人添加的标签/组件 agent 能不能删”也不是待定问题：agent 与人操作同一份状态，
删除是正常能力，不需要按作者加只读保护。

我最初把它当开放问题，是因为只读了实现和工具文案，没有先查 durable 产品决策文档。
以下是仍然成立的发现；第一版里“拆成 per-viewer”“按作者给人写的内容加只读保护”
这类建议已全部撤回。

### F1 真正的缺口是 agent 不知道自己在改共享状态

`model-sidebar-facade.ts` 原先把 `open`/`fullscreen`/`selectedTab` 与 `tabs` 的写法
当成普通 patch 描述，唯一承诺是“不抢占前台/不切焦点”。“不抢焦点”说的是不打断人的输入，
并不等于“只影响自己”——agent 读到这句话，很容易以为自己在调整自己的视图，
于是为了“把某个面板显示出来”而改掉整个房间的当前选中项。

这是**文案缺口，不是语义缺口**。已在本 PR 修：`sidebar_read` 与 `sidebar_update` 的
模型侧描述现在都写明“侧栏属于其 owner，Room 的侧栏是该 Room 的共享状态，所有成员都会看到
你对 open/fullscreen/selectedTab 和标签列表的改动；`tabs` 是整表替换，替换前先重读并保留
要留下的描述符”。`ui-ux.md` 也补了一条把这条语义与“不按作者区分读写权限”固定下来。

### F2 `tabs` 整表替换的提示偏弱（已随 F1 修文案，不改行为）

替换语义本身是合理的（Room 的列表就是这一份），问题是原文案只说 "preserve tabs you want to
keep"，没有说明“你看到的是当前全部描述符、替换等于房间的现状”。已并入 F1 的描述修正，
不再单独提改动建议。

### F3 `reset` 的实际效果是“隐藏”，不是“删除”，但返回里没有区别

`reset` 把未出现在默认布局里的组件改成 `visible: false` 并留在数组尾部
（`information-layout.ts:291-314`）。这是合理实现（可恢复），但 agent 的读模型里只能看到
`visible: false` 的实例，无法区分“我删掉的”和“被 reset 隐藏的”。建议在 read 的实例投影里
加一个 `hiddenByReset`/`origin` 事实，否则 agent 会反复 add 已存在的组件（Board 尤其明显：
`add` 会受到 `Duplicate Board document placement` 拒绝，`information-layout.ts:286-289`）。

### F4 `authorizedScopes` 静默截断到 101

`sidebar-tool-scope.ts:68`：`choices.slice(0, 101)`。房间数超过 100 时，agent 看到的
授权 scope 列表被悄悄截断，且没有 `truncated` 标记。仓库里其他有界列表（browser observation、
trigger 列表等）都会显式标注截断，这里不一致。建议加 `scopeTruncated: true`。

### F5 非问题，但值得写进文档：默认 scope 可能直接落在共享 Room

当调用者是某个 Room 的唯一 dedicated assistant 时，不带 scope 默认操作该 Room
（`sidebar-tool-scope.ts:56-59`）。read 会返回 `defaultReason`，update 又必须带 read 的
snapshot，所以链路是可解释的；但这个默认值意味着“agent 第一次写就写进了共享房间”。
建议：在 `ui-ux.md` 的侧栏章节把这条默认值与 F1 的展示态问题一起写明，
避免以后被当成实现细节改掉。

### F6 插件面板：agent 能开，但不能代表插件执行

`plugin` tab 只是 `pluginId + panelId` 的引用（`thread-sidebar-state.ts:17`），
工具文案承诺 "No provider content/action or foreground change occurs"。
这一条与实现一致：打开面板不触发 provider 调用，真正的渲染在 renderer 侧
`bundled-automation-ui.tsx` 里按可见性加载。这个边界是对的，建议在 review 清单里保留为
不可回退项（避免以后为了方便让 agent 触发插件动作）。

## 4. 结论与后续

- 语义层没有需要改的地方：Room 侧栏是房间自己的共享状态（`ui-ux.md` 已定），
  agent 与人操作同一份状态，删除人加的标签/组件是正常能力，不需要按作者加只读保护。
  能力面（scope、CAS、资源绑定、组件编辑权）经逐条核对也是自洽的。
- 真正的缺口是**告知**：agent 原先拿不到“我在改共享状态”这一事实，容易把
  “不抢焦点”误读成“只影响自己”。本 PR 已修模型侧与 Host 侧描述，并把语义写进 `ui-ux.md`。
- 仍然成立的小问题：F3（`reset` 的效果是隐藏，读模型里与删除不可区分，会让 agent
  重复 add 已存在的组件）、F4（`authorizedScopes` 静默截断到 101，缺 `truncated` 标记）。
  这两个都不涉及共享语义，可以随时单独修。
- F5（默认 scope 落在共享 Room）与 F6（插件面板不触发 provider 执行）已写进文档作为固定事实，
  避免以后被当成实现细节改掉。
