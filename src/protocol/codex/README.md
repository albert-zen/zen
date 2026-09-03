# Codex App Server compatibility adapter

本目录的架构角色是 Codex App Server（CAS）compatibility adapter。ZAS 拥有自己的
原生 App Server 协议与语义；CAS adapter 把其中可表达的部分映射为固定
**codex-cli 0.146.0** shape，Codex 生成 schema 是这层 mapping 的 oracle，不是
ZAS、Core、canonical lifecycle、Host policy 或产品读模型的权威。

当前实现让 ZAS native surface 与 CAS mapped surface 共用一个 endpoint、JSON-RPC
envelope、部分 DTO 和 connection dispatch，因为尚未出现需要两份实现的真实差异。
本文区分的是语义归属，不是要求立即复制 schema；native-only additive surface 可以
明确排除在 CAS claim 外。两侧重叠语义开始需要不同字段、requiredness、validation、
lifecycle 或 error semantics，或 CAS 升级而 ZAS 不跟随时，允许分叉 shared codec。
升级 CAS 基线必须重新生成 schema、审查映射并更新本文件；这里不使用“兼容最新版”。

## 当前 CAS mapped surface

Client requests：

- `initialize`
- `account/read`
- `skills/list`
- `model/list`
- `thread/start`
- `thread/resume`
- `thread/read`
- `thread/list`
- `thread/name/set`
- `thread/archive`
- `thread/unarchive`
- `thread/settings/update`
- `thread/unsubscribe`
- `turn/start`
- `turn/steer`
- `turn/interrupt`

Client notification：`initialized`。

Server notifications：

- `thread/started`
- `thread/name/updated`
- `thread/archived`
- `thread/unarchived`
- `thread/settings/updated`
- `turn/started`
- `item/started`
- `item/agentMessage/delta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/textDelta`
- `item/commandExecution/outputDelta`
- `item/completed`
- `serverRequest/resolved`
- `turn/completed`
- `error`

Server request：`item/commandExecution/requestApproval`。

## 当前共用 endpoint 的 ZAS native surface

- `turn/replace`
- `thread/compact`
- `turn/start`、`turn/steer` 与 `turn/replace` input 的
  `{ type: "attachment", attachment: AttachmentRef }` variant
- `commandExecution` item / approval 上可选的 `contentType`、`structuredContent`、
  `toolName`、`toolArguments`、`callId` 与 `parentCallId`

这些都是 ZAS 产品与 canonical lifecycle 所需的原生方法或字段，不是 Codex
extensions，也不属于 CAS compatibility claim。Codex 0.146.0 无法表达它们时，
只限制 CAS mapping，不能据此删除或改写 ZAS、Core 与 ZenX 能力。

ZAS 的 `commandExecution` native fields 在 completed item 上可选投影 canonical
`contentType` / `structuredContent`，供 ZenX 在既有 Item 投影中选择 result renderer；
字段缺失时字节与语义保持原样，只使用 CAS mapped surface 的客户端可以忽略这些字段。
同一 native projection 也可选投影 `toolName`、`toolArguments`、`callId` 与
`parentCallId`：approval 用前两项准确展示完整 `run_code`，transcript 用后两项从
canonical lineage 派生 outer/child 层级。projection 不新增权威状态；字段缺失的旧
history 仍作为普通 command trace 显示。模型上下文仍只使用 canonical `output` /
`exitCode`。

除上述 ZAS native 与 CAS mapped surface 外，其他方法返回 JSON-RPC `-32601`。
当前只接受 `danger-full-access` sandbox；
approval 只接受 `on-request` 与 `never`，二者是不同维度。resume 与 turn
携带 cwd、sandbox 或 approval 时只接受和 Thread metadata 等价的值；model 与
`turn/start` 的标准 effort 则走同一 canonical selection update。service tier 与 plan collaboration mode 等
未实现配置返回 `-32602`。`model/list` 为每个
`providerProfileId / modelId` 投影稳定 opaque key，
标准 `effort` / `reasoningEffort` 字段表达 catalog 支持的 effort；未知 profile、
model 或 effort 明确失败。单 profile 的既有裸 model id 仅作为入站兼容输入接受，
同名 model 跨 profile 时必须使用 opaque key。T3 总会发送的
`default` collaboration envelope 只作为接入端 UI 元数据接受：其中 model
与 reasoning effort 必须匹配本次原子 selection；developer instructions 不进入
Thread，也不覆盖 Zen 的 Agent 行为。canonical `model_usage` 与实时 token usage
都不投影到 CAS surface，避免发送不完整的 0.146.0 类型；ZenX 只通过 Host-local typed
projection 从同一 ItemList 读取 Turn/Thread usage，不新增协议通知。

canonical `reasoning` Item 只使用 provider-neutral reasoning content、可选 summary、
public/opaque visibility 与 round-trip 必需的可选 Provider item identity。Opaque content
永不进入 Codex Thread Item、通知或 ZenX 展示；public content 始终投影为公开 content，
可选 summary 独立投影为折叠标签。产生它的 Turn selection 必须与目标 profile/model 兼容才进入模型重放。
各 ModelAdapter 独自负责目标 API 的私有 reasoning 请求与响应形态，不把 wire 结构带入 Core。
实时 reasoning 使用标准 Item lifecycle：先发送一个 summary/content 为空的
`item/started`，summary 首次出现时发送一次 index 0 的
`item/reasoning/summaryPartAdded`，随后分别通过 index 0 的 summary/text delta 通知增量，
最后以同一 item id 发送 canonical `item/completed`。这些 delta 只存在于连接与 ZenX
内存状态，不写 journal；subscription 的 opaque content 绝不发 text delta，只有公开 summary
可以流式展示，compatible 的公开 reasoning content 才使用 text delta。失败或中断不会伪造
completed reasoning Item。

`thread/compact` 是 ZAS native method，不是 Codex 0.146.0 方法。它只接受精确的
`{ threadId: string }`，等待 Zen 使用 admission 时冻结的当前 Provider selection
为最新完整 Turn 边界生成、验证并 append canonical context compaction，然后返回
精确的 `{ compactionItemId: string }`。调用者不能指定边界或 retained Item；active /
incomplete Turn、没有新 eligible boundary、generation / abort / validation / journal
失败都明确返回且不隐藏重试。Z11 不发送 compaction progress notification。

当 admitted catalog 的 `contextWindow` 已知时，成功 Turn 在 Provider 实际报告的
最高 `inputTokens` 达到窗口 80% 整数上界后自动走同一生成、验证与 append 路径。
Unknown window、缺失或无效 usage、未成功 Turn 与已覆盖边界不触发；自动失败通过
既有 Turn execution `error`（`willRetry: false`）与失败 completion 明确投影，不增加
wire method、后台 retry 或 compaction progress notification。手动 `thread/compact`
语义不变。

`model/list` 的 `supportedReasoningEfforts`、`defaultReasoningEffort` 与
`inputModalities` 直接来自结构化 catalog，不再硬编码。固定 0.146.0 CAS schema 要求
这些字段存在；非默认的 Unknown 或已知不可运行条目在此 CAS 投影中省略，
不会阻断同目录内可表示、可运行的条目。manual override 补全能力后，该条目自然重新
进入列表。CAS `model/list` 的 default entry 必须可表示且可运行，否则该请求明确失败；
它不使用缺省值或 Zen 私有字段，也不从 ZAS 原生 catalog 删除该模型。context window
与 catalog source 在本切片仍是 host data，不扩展固定 CAS schema。bare-ID
`GET /models` discovery 不会按名称补写这些字段；Provider 明确返回的 modality metadata
与 exact-ID 核验目录可以补全 input capability。Unknown reasoning 也不能被一次
per-Thread explicit effort 绕过。

CAS adapter 用 `thread/settings/update` 与 `turn/start` 的既有 `model` / `effort`
字段映射 ZAS selection change，不为兼容增加私有字段。adapter 解码后只把
稳定 `providerProfileId / modelId` 与可选的显式 effort 交给 Core；省略 effort 时
Core 在目标支持当前值时保留它，否则使用目标 model 默认值，再形成 canonical
selection。活跃 Turn 保留启动时 selection，更新只影响下一 Turn。

该 selection 中冻结的 `reasoningEffort` 是唯一 reasoning-control 权威。Provider adapter
可以按目标合同省略或映射 wire effort，但 OpenAI-compatible `defaultParams` 不能再设置
`reasoning_effort` 或 `thinking_budget` 来覆盖、抑制或替代它；冲突配置在 Host preflight
阶段明确失败。Replay 专用的 `preserve_thinking` / `clear_thinking` 参数不改变这项权威。

`thread/list` 在本目录内把 ZAS 原生 `ThreadSummary` 查询结果映射为固定版本的
Codex Thread DTO；wire DTO 不定义 ZAS 或 ZenX 的产品读取模型。它当前只接受
`archived`、`limit` 与 `cursor`。非终页返回的 opaque
cursor 绑定 archived filter、按 threadId 排序的筛选快照与当前位置，但不绑定 page
limit；续页可以省略或改变 limit。跨筛选器、无效或已过期 cursor 返回 `-32602`，
不得静默重放第一页。终页的 `nextCursor` 为 null。固定子集不支持 `sortKey` /
`sortDirection`，因此不伪造依赖反向排序 watermark 语义的 `backwardsCursor`，该字段
始终为 null，排序参数仍返回 `-32602`。

## Transport

`stdio.ts` 实现每行一个 JSON-RPC message 的 stdio transport；
`websocket.ts` 实现 loopback-only `ws://` transport，拒绝带 `Origin` 的浏览器
连接，并可由宿主注入 bearer token 保护握手。二者当前承载同一个 ZAS endpoint；
`bridge.ts` 为 T3 这类只会启动 stdio 子进程的 CAS 客户端原样桥接中央 WebSocket，
不解析消息或创建本地 runtime。transport credential 不进入 Thread 或 journal；
token 文件在 POSIX 上不得允许 group/world 读取。T3 0.0.31 自动追加的两项
MCP `-c` 配置由 CLI remote bridge 启动边界验证后忽略，不进入 ZAS protocol
或 Core；其中 URL 必须是无凭证的 `http` `/mcp` endpoint。remote bridge 除
`--remote`、可选的 `--auth-token-file` 和这两项配置外，不接受宿主或 runtime
选项；这些配置属于中央 App Server。T3 MCP tools 尚未实现。Unix socket 与
非本机监听尚未实现。

## Soft steer

`turn/start`、`turn/steer` 与 ZAS native `turn/replace` 当前共享同一 input 类型。
CAS 可映射的 variants 是 `text`、`localImage.path` 与 `image.url`；
`attachment.attachment` 是 ZAS native variant，不属于 CAS claim。首版 `image.url`
只接受 base64 data URI；远程 URL 不会在
重放时偷偷重新下载。路径与 data URI 只在 ZAS 导入边界存在，校验后写入
Attachment Store；`attachment` 直接复用已经导入的 immutable `AttachmentRef`，不会
再次读取或导入 payload。Core 只收到 typed `AttachmentRef`。
图片能力明确不支持时请求失败；Unknown 会由客户端明确提示并允许用户尝试发送，Provider
失败仍按普通 Turn failure 可见。Z08 的真实纵向执行以
`turn/start` 为准，steer/replace 保留同一 typed public seam，完整中断/重试体验由
后续切片收口。

ZAS `turn/steer` 的 same-Turn 语义可无损映射到 Codex 0.146.0。请求必须包含
`threadId`、作为 fencing token 的 `expectedTurnId`，以及非空 typed `input`；可选
`clientUserMessageId` 用于可靠重试。成功返回 `{ turnId }`，其中 id 必须仍是
同一个 active Turn，不产生新的 `turn/started`。无 active Turn、fence 过期、
目标已经终态或不可表示的 input 都明确失败。

接受成功前，输入已经作为 canonical `user_message` 写入 journal。相同
`clientUserMessageId`、Turn 与内容的重试返回原成功且不重复追加；冲突复用失败。
steer 不取消当前 model stream、tool 或 approval，也不处理 approval。若它在
一次模型响应期间到达，Runtime 会完成该响应及其工具结果，然后在下一次 sampling
前按 journal 中的 steer FIFO 顺序注入；因此原本可能结束的响应也会继续下一轮。

## Hard steer：ZAS native `turn/replace`

ZAS 原生支持原子的 Interrupt & send；`turn/replace` 不是 Codex 0.146.0
`turn/steer` mode，也不属于 CAS 兼容声明。Codex 缺失该方法不裁剪 ZAS 语义。
请求必须包含 `threadId`、`expectedTurnId`、typed `input` 与非空
`clientUserMessageId`。成功返回 `{ interruptedTurnId, turnId }`。

App Server 在同一 Thread mutation boundary 内验证 active-Turn fence，先写入
canonical `turn_replacement_requested` intent，再中断并等待旧 Turn 的
`turn_aborted` durable，最后用 intent 中保留的 successor id 写入新的
`turn_started` 与 `user_message`。响应只在这些事实全部 durable 后发送；任何
时刻都不会有两个 active Turn。tool 与 pending approval 使用既有 AbortController
路径取消并以既有 canonical 结果收口。

相同 id、旧 Turn 与 input 的重试返回同一个 successor，不重复 abort/start/message；
冲突复用失败。若进程停在旧 Turn 已 abort、successor 尚未 start 的间隙，Zen
不会自动恢复；显式同 key 重试可以从 intent 继续。若 successor 的
`turn_started` 已 durable 而初始 `user_message` 未 durable，则返回
`replacement_incomplete`，不恢复半截执行或发明新 Turn。

## 按客户端验收的互操作范围

兼容声明必须绑定具体客户端、版本与已验收调用面。仓库测试覆盖 Zen CLI 的一轮
会话、streaming、command approval、interrupt、resume 与双连接事件投影；对
T3 Code 0.0.31 只验收了 `account/read`、`skills/list`、`model/list` bootstrap 和
full-access 配置投影。其他 sandbox 模式未实现；在真实 T3 Code 完成一轮会话与
一次工具执行前，不宣称完整兼容。原版 `codex --remote` TUI 0.146.0 还要求
`config/*`、`hooks/list` 等方法，当前仍不兼容。这些互操作缺口不改变 ZAS native
surface 已经支持的产品能力，也不构成修改 Core 的理由。

本机 CAS schema oracle：

```sh
codex --version
codex app-server generate-ts --out /tmp/codex-app-server-types
codex app-server generate-json-schema --out /tmp/codex-app-server-schema
```
