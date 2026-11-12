**只读结论：未确认功能性缺陷。** 两项可选补充均为 P3，不影响设置数据完整性修复的优先级。

**范围与证据**

- 检查产品 checkpoint `58df4ea3852e4826d3aa31a931c3383258bc0c47` 对应源码；HEAD `bd27faf…` 的新增内容仅为文档。检查的组件无未提交改动。
- 原图已查看：live-native `02`；pending-readability `02`；agent-information `05/06/08/09`。
- 图片来自较早、带工作区修改的构建，不能冒充 checkpoint 的精确 bundle 验收。未操作原生桌面、未修改文件。

**逐项判断**

1. **Queue promote：已有明确语义与反馈。**
   - `QueuedMessages.tsx:751–777`：运行时/空闲时分别提供 Steer/Send 的完整 aria-label；已有原生 title，运行时说明“下一个安全节点、不打断”。
   - `QueuedMessages.tsx:208–229`：被移除行的所属焦点恢复逻辑。
   - `queued-steer-interaction.test.ts:79–114,297–328` 验证标签切换及焦点恢复；`pending-tray.test.ts:376` 验证同一身份晋升及原子撤回。
   - 图片证实图标可见，不证明 native tooltip 或键盘激活已实测。**无需仅因图标简洁而改语义或增加常驻文字。**

2. **Queue reorder：可访问名称齐全，鼠标解释提示缺失。**
   - `QueuedMessages.tsx:721–748`：原生按钮、明确上下移动 aria-label、首尾边界 disabled；没有 title。
   - `pending-tray.test.ts:292–374`：验证完整身份/revision 顺序快照、等待 canonical 更新、忙碌锁定。
   - 原图中上移 chevron 与 promote 箭头相邻，存在辨认成本，但不能据此认定功能不可发现或键盘不可达。

3. **Source navigation：已有完整原生 title 与可见焦点。**
   - `message-source-navigation.tsx:104–120`：原生按钮、完整 label/title、pending/不可用状态。
   - `styles.css:11555–11585`：hover 下划线、独立 focus-visible 轮廓。
   - `interface-icon-semantics.test.ts:53–106` 验证 EN/ZH 完整 title。
   - `app-project-picker-interaction.test.ts:6496–6642` 覆盖精确来源、不可用反馈、重复点击与较新导航优先。
   - 原图 `05/06` 展示来源入口及目标 child 页面。**完整 tooltip 已存在，但实际 hover/键盘可见呈现仍未实测。建议保留现状。**

4. **Archived Subagents：确认存在完整名称的视觉披露缺口。**
   - 原图 `08` 显示“Archived reviewer · nati…”。
   - `subagents-ui.tsx:515–537` 完整标题在 DOM 内，但 row 没有 title/tooltip；`subagents.css:119–124` 始终单行省略。
   - 相邻 Sidebar switch 的 aria-label 已含完整名称（`subagents-ui.tsx:461–463`），其 title 仅解释显示/隐藏，不能当作名称的视觉提示。
   - `subagents-ui.test.ts:374–430` 已验证 Show archived、状态与精确导航；**没有长名称 hover/focus 披露测试**。

**最多两项可选补充**

1. Archived row 增加完整名称的原生 title。若要求明眼键盘用户也能读全，可让同一 row 在 `:focus-visible` 时临时换行，实测布局后采用。当前不存在共享 Tooltip 组件；不要新增 Tooltip 体系或重复控件。
2. Reorder 按钮的 title 复用现有本地化 aria-label，仅补鼠标悬停解释。保留 promote 的独立 safe-point 提示及所有现有图标语义。

**验证结果与复现缺口**

- 精选 **15 项测试通过，17.6 秒**，涵盖上述 queue/source/lineage 行为；没有运行重型套件。
- 后续原生验证：用现有 pending-readability、agent-information 脚本建立隔离 fixture；分别 hover/Tab 到上下移、promote、来源及长 archived row，记录可见提示、Enter/Space、canonical 更新后的焦点。归档名称补充需在约 340px 信息卡与窄分配下确认不遮挡状态、Sidebar switch 或相邻行。
- 当前仍未验证：这些动作的真实键盘输入、native title 出现、长名称键盘视觉披露、屏幕阅读器实际朗读。

## 已执行证据附录

本附录补充上文的可追溯性，不改变原结论。此文件为只读复核报告及下一轮选择依据；未实施任何建议，不宣称问题已解决。报告保存时没有启动新测试。

### 源码版本与范围

- Repository: `/workspace/scratch/72527d3ea90a/ui-quality-iteration`。
- 产品 checkpoint: `58df4ea3852e4826d3aa31a931c3383258bc0c47`。
- 已读取 HEAD: `bd27fafbb8db9894090d7f0ff88677e7dbb7fbe8`。
- 已执行 `git diff --stat 58df4ea3852e4826d3aa31a931c3383258bc0c47..HEAD`，差异仅为 `docs/ui-quality/` 文档与 QA 复现脚本。
- 已执行针对 `QueuedMessages.tsx`、`subagents-ui.tsx`、`subagents.css`、`message-source-navigation.tsx`、`queued-messages.css` 的 checkpoint-to-working-tree diff，输出为空。
- 源码引用的 renderer 文件均相对于 `apps/zenx/src/renderer/src/`；测试均相对于 `apps/zenx/test/`。
- 已读规则：repository `AGENTS.md`、`apps/zenx/docs/ui-ux.md` 中相关当前 UI/UX 合同、`docs/ui-quality/rubric.md`。未阅读其他评审人的报告。
- 共享控件检查：`apps/zenx/src/renderer/src/ui/controls.tsx` 导出 Select、Popover、ActionMenu、Combobox、Dialog，未导出 Tooltip。renderer 范围搜索未发现 TooltipProvider、role=tooltip 或 react-tooltip。`styles.css:2773–2801` 的 context-usage hover/focus 文本是局部 CSS，不是共享通用 Tooltip。

### 已检查原图完整清单

以下六张均通过 `view_image` 查看原始本地文件；未重画、裁切或修改图片。

1. `/workspace/shared/ui-quality-evidence/pending-readability-captures/02-all-three-queue-controls.png`
2. `/workspace/shared/ui-quality-evidence/agent-information-captures/05-canonical-sender-link.png`
3. `/workspace/shared/ui-quality-evidence/agent-information-captures/08-archived-lineage-visible.png`
4. `/workspace/shared/ui-quality-evidence/live-native-captures/02-pending-tray-lower-queue.jpg`
5. `/workspace/shared/ui-quality-evidence/agent-information-captures/06-source-opens-child.png`
6. `/workspace/shared/ui-quality-evidence/agent-information-captures/09-narrow-allocation-popover.png`

图片绑定边界来自已读取的 capture manifest：

- `live-native-captures/manifest.json` 标注 source commit `aa09f69ebedfa917f6d21cd6568ce1aeeb968b51`、production code commit `00efffddbfd492dbc16f51487eaacf36b5952d88`；原生应用使用隔离的合成 canonical 历史和 QA-only FakeModel/发送延迟注入。
- repository `docs/ui-quality/checkpoints/agent-information-native-manifest.json` 标注 base commit `a7c36125a85f48c0d84b9783e1038893a05b2ff2` 加未提交 fourth-slice 修改，不是精确最终 clean SHA；真实已安装 Subagents plugin、原生历史、合成 FakeModel 数据。
- repository `docs/ui-quality/checkpoints/pending-readability-native-manifest.json` 同样标注 base commit `a7c36125a85f48c0d84b9783e1038893a05b2ff2` 加工作区修改；真实生产组件，但使用合成 canonical 输入和 fixture callbacks，不能证明真实 Host mutation 或 delivery。
- 两份后者 manifest 声明 `.png` 文件名的实际编码为 JPEG，原始字节保留。本次使用原文件查看，不因扩展名推断编码或构建身份。

### 已执行的精选测试命令

执行工作目录为上述 repository。该命令已执行一次；没有新建测试文件，没有运行完整套件。

```sh
node --import tsx --test --test-concurrency=1 --test-name-pattern='move controls submit|Queue promotion enters|steering label distinguishes|canonical removal restores queue focus|panel renders direct and nested|each child has its own accessible|message source reads and opens|message source (archived|deleted|mismatched|denied|remote)|repeated source clicks|message sources use clock' apps/zenx/test/pending-tray.test.ts apps/zenx/test/queued-steer-interaction.test.ts apps/zenx/test/subagents-ui.test.ts apps/zenx/test/app-project-picker-interaction.test.ts apps/zenx/test/interface-icon-semantics.test.ts
```

已返回的精确测试名称及结果：

1. PASS — `message source reads and opens its exact canonical thread without sending, forking or following body URLs`
2. PASS — `message source archived gives visible feedback and never opens a fallback thread`
3. PASS — `message source deleted gives visible feedback and never opens a fallback thread`
4. PASS — `message source mismatched gives visible feedback and never opens a fallback thread`
5. PASS — `message source denied gives visible feedback and never opens a fallback thread`
6. PASS — `message source remote gives visible feedback and never opens a fallback thread`
7. PASS — `repeated source clicks share one read and a newer Settings navigation wins over its late reply`
8. PASS — `en: message sources use clock and conversation artwork without changing their names`
9. PASS — `zh-CN: message sources use clock and conversation artwork without changing their names`
10. PASS — `move controls submit an exact native order snapshot and wait for the canonical reorder`
11. PASS — `Queue promotion enters the upper Steer group at the same identity and remains atomically recallable`
12. PASS — `steering label distinguishes active safe-point guidance from an idle send`
13. PASS — `canonical removal restores queue focus without clearing an edited composer draft`
14. PASS — `the panel renders direct and nested descendants and explicitly reveals archived navigation`
15. PASS — `each child has its own accessible Sidebar switch without changing navigation or siblings`

返回汇总：tests 15；suites 0；pass 15；fail 0；cancelled 0；skipped 0；todo 0；duration_ms 17597.773929；process exit code 0。

这些是 Node/JSDOM/组件与应用 harness 检查，不是原生键盘、tooltip、屏幕阅读器或完整视觉验收。未观察到的输入行为仍为 N/O。
