# Ask User Question 与 model-facing MCP：研究结论及实验边界

2026-11-02。状态：拟议合同。Ask 生产代码尚未实现；MCP 只有未连接真实 Host 的独立 fixture，不是已完成集成。

## 结论先行

1. Zen 8a1fda8d 有可拼装问题表单的 Board：`field` + `action` + `submit`，提交最终走普通 user message。但没有专门 Ask User Question 工具、canonical 待答身份、问题级一次性交付或左侧待输入投影。
2. 用户偏好的“异步提问、普通用户消息回答”有真实 Codex 先例。今天公开源码同时有阻塞版 `request_user_input` 和非阻塞版 `request_user_input_async`；后者立即返回 accepted、回答异步进入 user message。它不意味着 Codex 桌面 UI 开源。
3. T3 今日 main 的 MCP 确实覆盖较广应用能力（11 组 toolkit，包括线程、编排、项目等），不是只有浏览器工具。**10 月 1 日本地快照只有三组，这个旧观察不能外推今天**。MCP 是模型侧入口；内部仍有原生 orchestration 与客户端协议，不是把整个产品底座替换成 MCP。
4. 建议 Ask 先保持 Zen 原生语义、资料板独立输入；MCP 作为可撤销薄 adapter 实验，不能反向定义 ZAS/Core，也不迁移到外部 harness 做会话权威。

## 1. 实际截图/录屏与源码证据

### T3 Ask 专属视觉参考

- [issue 9873](https://github.com/pingdotgg/t3code/issues/9873) 的[原始截图](https://github.com/user-attachments/assets/f2f4d1c5-b125-4812-a98b-02511eb1a8e6)：实际显示完整问题、两项选择、1/2、自由输入、Next。该历史 issue 没有给安装版 exact commit，不能冒称今日效果。
- [issue 25434](https://github.com/pingdotgg/t3code/issues/25434) 的[27 秒真实录屏](https://github.com/user-attachments/assets/71e35405-e6a8-4b96-8d50-fb4c5d9d5c88)：已检查录屏的 1 秒和 13 秒状态。记录针对发布 0.1.2，2026-10-26，问题 Blue/Green、自由输入、Submit；左侧仍是 Working，而非 asking 胶囊。
- 对照 issue 指向的实际源码 [useComposerSend.ts:468](https://github.com/pingdotgg/t3code/blob/cc93cc564b052a9dcf73323783e7b60506cda5e0/apps/web/src/components/chat/useComposerSend.ts#L468-L474) 与 [559](https://github.com/pingdotgg/t3code/blob/cc93cc564b052a9dcf73323783e7b60506cda5e0/apps/web/src/components/chat/useComposerSend.ts#L559-L568)，源码显示：pending question 的提交分支先 return，后面才是 queue edit，证明两个输入模式竞争。该 source commit 与已安装 build 不被假定为同一对象。
- 今日 [ComposerPendingUserInputPanel.tsx](https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx#L90-L150) 源码包含含每 request identity、单选推进、自由回答和显式 dismiss；可参考问题结构与输入边界，不照搬主 composer 耦合。
- 整体 [T3 官方图](https://t3.codes/_astro/app-desktop.BHuzLVLF.webp) 已检查，它只证明整体右侧面板布局，不证明 Ask 特定交互。

**视觉证据边界**：T3 Ask 选择/自由输入/提交已有真实状态参考；尚未复现与今日源码精确同版本的完整交互。公开缺陷截图/录屏不证明缺陷在当前版本仍然存在。

### Codex：公开 runtime ≠ 桌面 UI

- [Codex desktop issue 33739](https://github.com/openai/codex/issues/33739) 的[实际问题卡截图](https://github.com/user-attachments/assets/96f368c9-5a77-47a9-94f6-7b5cddd09e22)（macOS 26.715.21425）显示 2/3、Recommended、选项描述、自由回答入口、Skip；描述被省略号截断。这提醒问题选项应完整可读，不能让用户依据被截断的文本作决定。
- [Windows desktop issue 57130](https://github.com/openai/codex/issues/57130) 的[实际左侧胶囊截图](https://github.com/user-attachments/assets/160f5950-ada5-4b45-8226-83d0bdf7568f) 显示绿色 “Eingabe erforderlich”（需要输入）；报告 About 版本 26.1016.51333，另列未经核对的 Windows package 版本，二者不可混同。截图只证明胶囊像素，不证明报告者所述并发工作状态。
- 已检查以上两张公开参考的实际像素。剩余缺口是：Codex desktop UI 源码不公开，截图不是今日 UI 的 exact-version 验收；不能声称完成桌面实现级复刻。仓库不收录这些截图。
- [官方维护者答复](https://github.com/openai/codex/discussions/16538) 明确桌面 UI 不开源，桌面/IDE 建于 CLI app-server；因此 CLI/TUI/API 只能作为语义证据，不能冒充桌面 UI 源码。
- 今日 Codex commit `3026a8e54e0f48c4d8074cd700f35b0697abc329`：
  - [request_user_input_async.rs](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/core/src/tools/handlers/request_user_input_async.rs)：发布有 `questions` 的 Async AgentMessage 并立即返回 accepted。
  - [模型文案](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/prompts/src/model_messages.rs)：明确回答作为新用户消息异步到达、预选不自动发送。
  - [TUI async_questions/state.rs](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/tui/src/bottom_pane/async_questions/state.rs#L14-L54)：以 tool name/message ID/question index 形成 identity；后续 `AnsweredQuestion` 生成回复文本并同步已答 identity。TUI 的计时器/turn 结束清理不自动成为 Zen 产品规则。
  - [阻塞工具](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/core/src/tools/handlers/request_user_input.rs#L78-L104) 另外 await 请求结果，不能把两者混为一谈。
- [官方 app-server 文档](https://learn.chatgpt.com/docs/app-server) 进一步区分 `item/tool/requestUserInput`、MCP elicitation 与生命周期请求。MCP elicitation 不是 Zen 问答必须采用的传输。

## 2. Zen 当前真实链路与缺口

基线 `8a1fda8d94e713bb8a6be3b9ec8019a875dfa895`。

- `apps/zenx/src/main/capabilities/model-board-facade.ts:24-32`：模型得到 field/select/textarea + event submit 模板，`{{field}}` 只插入文本。
- `.../capabilities/board-package.ts:272-357`：进程内按 owner 的 running Map、document/draft revision 校验；submit 每次生成新的 clientId，再调用 Host deliver。
- `apps/zenx/src/main/board-host-service.ts:89-155`：Thread ID/归档/Room membership 校验，`deliverAssistantInput` 使用 `clientUserMessageId` 与普通 text input。
- `apps/zenx/src/main/assistant-preset.ts:39-118`：同一 user-input admission，运行中 steer、空闲 start；只重试明确未准入的竞争，不重试未知 transport outcome。
- `src/tool.ts:93` + `src/runtime.ts:1770`：已存在可信 `canonicalToolCallId`，独立于 provider callId，可复用作问题来源。
- `src/item.ts:506-522`：兼容读投影的 `tool_result` 有 contentType/structuredContent，但这不是新持久格式。`src/item-list-legacy.ts` 不把它们直接写进语义 ItemList；不能仅依赖该 product-rendering 字段恢复问题。
- `src/item.ts:269-292`：普通 user_message 没有问题关联 metadata；`deliveryAfter` 明确说明 steer 可能尚未呈给下一模型 sample。
- 当前 Board 文档与用户草稿属于产品存储，不是 Thread canonical authority。不能把可变 Board revision 当 pending question 状态机。

**缺的不是表单控件，而是 canonical 问题/答复关联和准入合同。**

## 3. Ask 最小原生合同（拟议，非已实现 API）

### 三个既有持久域

- **模型语义 ItemList**：`src/item-list.ts` 的 `ContextItem` 是 writable authority。问题文本、选项、模板属于模型语义，保留在真实 tool-call 内容；成功发布回执必须在模型可见 tool-result 内容中以严格有界的版本化语义 envelope 表达。只有两者与来源身份匹配才构成请求。不能只读旧 `CanonicalItem.structuredContent`，也不向 ItemList 塞 runtime/control 日志。
- **真实观察 Trace**：准入、暂存、消费/撤回、工具 accepted fact 及来源/复制归属，复用现有 durable fact/读取投影。关键控制失败不得 ACK；未知不能视作未执行或已交付。
- **现有产品当前状态**：仅保留既有配置、产品 UI 偏好及可重建缓存；待答列表是语义与控制事实的纯派生读模型，没有问题数据库、第二份可编辑历史或自恢复调度器。
- 首个代码切片仅定义有界 schema 和纯投影合同，不注册模型工具、不修改 durable writer/准入、不宣称 ContextItem/Trace 的实际接线已完成。最终语义 envelope 与模型编译选择必须一起验证；普通文本中的伪造 JSON 不构成已接受问题或用户权限。

### 发布与身份

- 模型专用 `ask_user_question` 接收有界问题数组（每题 authored key/title、可选选项、是否多选）、回答文本模板；自由输入始终可用。限制总字节、题数/选项数、模板变量，只做确定性文本插值，不执行脚本。
- 模型提供的短 key 仅在该 request 内定位题目，不是全局 ID。选项 identity 与 label 分离，重复 key 拒绝。
- request identity 是 **(native ThreadId, runtime canonicalToolCallId)**；不使用题目文字、Board documentId、浏览器本地 UUID 或 provider callId 作为权威。
- 专用工具调用内容保存不可变问题快照；成功的模型可见 result envelope 确认同一 request identity。只有经 native 来源核验的本地 call + 配对成功 semantic result 才激活问题；失败、未知、未完成 call 不激活。直接工具之外的组合调用还必须证明其问题语义确实进入唯一 ItemList，不能因为 Trace 里有嵌套调用就激活。
- 普通 Board put 不创建待答语义，重新 put 不覆盖问题；多个 request 并列，request 中多个题用显式一次提交整批回答。要改变已发布问题，应产生新 request，不默改正在输入的题目。
- 工具立即返回 published，不挂跨重启 Promise；模型可继续独立工作。若工作必须等待答案，结束本轮，下一条普通用户消息再继续。没有隐式定时器/轮询/调度器。

### 回答与一次性交付

- 资料板选择/自由输入只是草稿，默认/推荐项不会自动发送。点击发送先展示/使用明确的回答文本。
- 经过原生 endpoint 的回答最终仍是普通用户角色语义消息；问题关联（request ID、逐题选择/自由文本、answer/cancel outcome）需由原生校验并与该消息绑定，随实际语义提交/控制观察可重建。是否采用现有 submission-bound envelope 或严格语义 provenance 字段，应在 writer/compiler 接线时确认，不能只给 legacy `user_message` 新增持久字段。消息本体是模型可读的人类回答，不伪装 tool_result。
- Host 校验调用者 Thread scope、request 在当前 Thread 真正存在且可答、值属于其不可变 schema、模板展开与 canonical message 一致。**客户端自报 metadata 不是权限，不能回答其他 Thread 或任意历史 ID。**
- AppServer **同一个 Thread mutation 临界区**完成 open 检查、去重和 user-input 准入；所有客户端共用。UI disabled 仅是体验，不承担正确性。
- 同一 clientId/相同内容重试返回原 canonical receipt；同键不同内容明确冲突。另一个客户端抢答：已有有效 pending admission 则返回 pending/existing；已终结则 already-answered，绝不多写一条。
- 超时/断线未知时先按原 identity 查询 canonical 快照；不能新造 ID 自动重发，也不能将失败显示成已回答。确认不存在后由用户显式重试，仍走同一校验入口。
- “一次”承诺是同 request 最多一个有效模型可见 answer，以及同一次 user intent 不重复准入。它不是对外部模型网络推理提供端到端 exactly-once 承诺；历史上下文仍可在后续 sample 重放。

### 暂存 steer 与整批撤回：必须补齐的依赖

- 派生 UI 至少区分 `open` / `answer-pending-delivery` / `answered`；这些是读模型标签，不另存持久状态。
- receipt 仅证明接受；若 user message 仍在可召回的暂存输入集合，问题显示“回答待交付”，保留关联并占住该 request，不能永久 answered。
- 若 canonical 整批撤回发生于模型可见/消费边界之前，该 pending answer 作废，释放占位，同一 request 恢复可答；原 clientId 保持已撤回事实，迟到/重复重试不能复活。
- 用户显式再次发送使用新 clientId、同一 requestId；native helper 判定没有有效 pending/delivered answer 后才接受。
- 已越过不可撤回边界的 answer 不可重新开放；迟到撤回必须由原生拒绝，不在 UI 猜测。
- 具体“可见/已消费/可撤回”完全复用已批准的 canonical 输入投影，不能仅凭 user_message item 存在、receipt、active/idle 判断。召回输入边界尚待整合验证。在该原生边界确定前，不能声称 Ask 具备完整暂存撤回一致性。

### 取消、延迟、恢复、多客户端

- 关闭资料板/X 是隐藏 UI，不取消请求；切线程、重载、客户端断开也不取消。
- 用户明确取消可送一条关联 outcome=cancelled 的普通用户消息；如果它仍待交付并被召回，问题同样恢复，而非制造不可见的终态。
- 普通 final / turn_completed / 后续用户消息不自动消解未答问题；因此支持延迟跨 turn 回答。归档/删除阻止发送并显示 unavailable，不凭时间到期丢问题。
- 首切片不提供模型撤回。未来若支持，不能只异步返回 withdraw tool_result：handler 完成到 result 提交之间可能收到答案。必须与现有 durable control fact 和同一原生 mutation 锁对齐，属于 Trace 控制观察/当前投影，不引入 `question_withdrawn` 这种新的 ItemList 控制 variant 或第四持久域；模型可见的撤回说明另以真实消息语义表达。
- 首切片草稿仅客户端 UI 暂存：切卡保留本地草稿，重载可丢未发送草稿并明确展示；不为跨客户端草稿同步引入另一份会话权威。canonical question/accepted answer 在重载后完整恢复。
- fork/import 的复制历史永远不激活 pending question、不生成新 recency；新线程只接纳 fork boundary 之后自己的本地 ask。同名问题/相同 provider callId 不改变该规则。

## 4. UI 与 Recent 合同

资料板仅消费原生读模型，不持有执行权威。

- 资料板拥有独立问题输入，不复用主 composer 编辑模式；提问到达不覆盖主草稿、引用或排队消息编辑。展示“需要输入（N）”、完整题目、选项、自由输入、发送、显式取消；等待时不抢键盘焦点。
- 每 request 独立草稿、按钮操作绑定明确 Thread/request identity；旧页面迟到回执不得清空新线程/新 request 草稿。
- 侧边栏 `attention=awaiting_user_input` 与 execution active/idle 分离；模型可以仍在做不依赖答案的工作。
- 在 #619 普通排序规则之上：`recentSortAt = max(ordinary recentActivityAt, last accepted local Ask.createdAt)`；提问产生一次抬升，而非长期置顶。失败/重复/普通工具事件不 bump，original question timestamp 重放不变。
- **Pinned 完全手动**：Ask 只提升自动排序列表，绝不改变 pinned 的位置、排序或成员。
- 回答/取消 human receipt 继续遵守 ordinary recency；清除 badge 不回拨已发生的提问时间。复用同一 journal rebuild/incremental reducer + stable ID tie-break，绝不用 updatedAt。

## 5. T3 MCP：核验后的当前事实

当前 `47f2c8d29e981c7723467efe137ee19e91df924e`（2026-11-02 08:18 UTC）：

- [McpHttpServer.ts:1150-1173](https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/McpHttpServer.ts#L1150-L1173) 注册 `/mcp`、protocol 2025-06-18 与 11 组：Preview、Orchestrator、Thread、Attachment、Project、Environment、PreviewControls、Worktree、PullRequests、Device、HTML。
- [orchestrator/tools.ts](https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L223-L305) 真有 thread list/read/send/wait/interrupt 等应用操作，不仅设备工具。
- [thread/tools.ts:127](https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/toolkits/thread/tools.ts#L127-L145) 还暴露 `t3_pending_request` 的 list/read/respond，并明确它不能授权 permission request。
- [McpInvocationContext.ts](https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/McpInvocationContext.ts) 区分 Thread caller 与外部 Client caller；外部 caller 权限不是任意 model 参数。
- [McpToolAccess.ts](https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/McpToolAccess.ts) 强制区分 reads/writes、拒绝 read-only client 写入、检查目标 Thread modes/link origin；Orchestrator 锁内再次检查模式变动。
- [thread/handlers.ts](https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/toolkits/thread/handlers.ts) 转交原有 ThreadManagement/command executor。因此可借鉴“模型协议适配层 + 原生权威”，不是在 MCP 里新造 Thread runtime。

历史 `5cc99e1c23980d7995a13c47f969b47cb68ed1be`（10 月 1 日）的三组结论只属于该历史版本；版本比较不能省略这一差异。

## 6. Zen MCP 实验方向与明确非目标

```
外部 harness（未来）
  → MCP transport / schema adapter
  → Host 授权的 caller scope + 明确工具 allowlist
  → 既有 ZAS native read/admission + capability policy
  → canonical ItemList / 原有产品配置
```

- 不把 ZAS/native lifecycle 全量投成任意 RPC passthrough；挑稳定、小的模型接口。
- 不是“把 Codex 作为 MCP server 跑”与“Zen tools 暴露给 Codex MCP client”的混淆；本实验只研究后者。
- Zen 当前 `src/protocol/codex/README.md:160-172` 的 CAS remote bridge 会验证并忽略 T3 自动附加的两项 MCP `-c` 配置，明确尚未实现 T3 MCP tools。这不等于已有 Zen MCP server。
- 优点：下游 harness 共用稳定模型合同、scope 可统一、同一 native business logic；限制：MCP 不统一 harness turn/steer/cancel/恢复语义，更不会自动把问题答案注入不同 harness。每个 harness 的返程仍需明确 adapter。
- Codex/Claude 的接入方式已有源码/官方证据；Muse Code、Grove 的确切产品与支持协议尚未核实，不能仅凭名称列为已兼容。Anti-Gravity 有 T3 adapter 先例，未在本实验连接。
- 后续真实集成前另审 caller 生命周期/撤销、用户授权范围、数据最小化、tool result boundedness、断线未知 outcome；不导入长期凭证、不开放 listener、不改现有网络权限、不触发真实模型成本。

## 7. 隔离 fixture 与验证范围（不等于真实 MCP 集成）

- fixture 基线：`8a1fda8d`。
- `scripts/experiments/readonly-mcp/fixture.mjs`：无依赖的 MCP-shaped stdio probe；只 initialize/ping/tools list/call，两个固定 synthetic read 工具。
- `fixture.test.mjs`：真实子进程 stdio roundtrip、初始化隔离、工具白名单、scope/Thread 注入拒绝、返回值不污染下次读取、紧凑 Board、不执行 script/HTML、16 KiB 输入上限。
- `README.md` 与 ARCHITECTURE 一句话显式限定它未接 live Host/credential/network/harness；生产启动无引用。
- 验证：7/7 focused tests；Prettier 针对修改文件通过；node --check 两个 JS 文件通过；git diff --check 通过。
- **未跑**：完整 npm check/test（不改 production runtime，也未宣称完整验证）、MCP SDK conformance、多 harness interoperability、UI、真实权限撤销。不接生产路径。
- 回滚：丢弃独立实验分支即可；零配置迁移、零进程驻留、零生产数据改变。

## 8. Ask 集成边界与验收

1. 原生 semantic slice：语义 publication + pure pending projection + Thread-scoped answer binding；先证明双客户端同题同答/异答、重载、failure、不激活复制历史。遵守 ARCHITECTURE 的三个持久域。
2. 单一 native answer admission：复用普通消息并验证 request，绑定暂存/召回原生事实投影；未解决之前不拿 receipt 冒充 delivered。
3. 资料板消费投影：单选/自由输入/显式发送、多请求、长题/窄屏、键盘/屏幕阅读、旧回执不清新草稿；主 composer queue-edit 与 question-answer 互不污染。
4. #619 后续窄改：accepted local Ask 是唯一新增第三类 recency 事件；性能测试证明 tool delta、草稿变化和 pending 状态刷新不刷整列表。
5. 模型撤回如需要，先对齐既有 Trace 控制事实及回答竞争；不从现有工具输出文本猜测。

验收必须包括：双击；跨客户端并发；发送后断线；回执到达前换线程；多问题迟答；用户取消；模型 turn 先结束；模型仍运行时回答；暂存 answer 整批撤回；撤回后旧 clientId 迟到；新 clientId 显式再答；fork/import；归档/删除；跨 Thread 假造元数据；typed result failed/unknown；journal 重建与增量状态完全一致。
