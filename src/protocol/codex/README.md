# Codex App Server protocol boundary

Zen 的唯一 wire protocol 是 **codex-cli 0.146.0** App Server message
protocol 的固定子集。升级 Codex 版本必须重新生成 schema、审查映射并更新本文件；
这里不使用“兼容最新版”。

## 当前子集

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

Zen extension：

- `turn/replace`

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
- `item/commandExecution/outputDelta`
- `item/completed`
- `serverRequest/resolved`
- `turn/completed`
- `error`

Server request：`item/commandExecution/requestApproval`。

其他方法返回 JSON-RPC `-32601`。当前只接受 `danger-full-access` sandbox；
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
Thread，也不覆盖 Zen 的 Agent 行为。实时 token usage 暂不投影，避免发送
不完整的 0.146.0 类型。

`model/list` 的 `supportedReasoningEfforts`、`defaultReasoningEffort` 与
`inputModalities` 直接来自结构化 catalog，不再硬编码。固定 0.146.0 schema 要求
这些字段存在，因此含 Unknown capability 的条目不能被诚实表示时，整个请求明确
失败并要求 host manual override，不使用缺省值或 Zen 私有字段；context window 与
catalog source 在本切片仍是 host data，不扩展固定 wire schema。ID-only
`GET /models` discovery 不会按名称补写这些字段。

`thread/settings/update` 与 `turn/start` 在既有 `model` / `effort` 字段内提交同一
selection change，不增加 Zen 私有字段或第二种协议。协议 adapter 解码后只把
稳定 `providerProfileId / modelId` 与可选的显式 effort 交给 Core；省略 effort 时
Core 在目标支持当前值时保留它，否则使用目标 model 默认值，再形成 canonical
selection。活跃 Turn 保留启动时 selection，更新只影响下一 Turn。

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
连接，并可由宿主注入 bearer token 保护握手。二者承载完全相同的消息协议；
`bridge.ts` 为 T3 这类只会启动 stdio 子进程的接入端原样桥接中央 WebSocket，
不解析消息或创建本地 runtime。transport credential 不进入 Thread 或 journal；
token 文件在 POSIX 上不得允许 group/world 读取。T3 0.0.31 自动追加的两项
MCP `-c` 配置由 CLI remote bridge 启动边界验证后忽略，不进入 wire protocol
或 Core；其中 URL 必须是无凭证的 `http` `/mcp` endpoint。remote bridge 除
`--remote`、可选的 `--auth-token-file` 和这两项配置外，不接受宿主或 runtime
选项；这些配置属于中央 App Server。T3 MCP tools 尚未实现。Unix socket 与
非本机监听尚未实现。

## Soft steer

`turn/steer` 对齐 Codex 0.146.0 的 same-Turn 行为。请求必须包含
`threadId`、作为 fencing token 的 `expectedTurnId`，以及非空 `input`；Zen
当前只接受 `[{ type: "text", text: string }]`，可选
`clientUserMessageId` 用于可靠重试。成功返回 `{ turnId }`，其中 id 必须仍是
同一个 active Turn，不产生新的 `turn/started`。无 active Turn、fence 过期、
目标已经终态或不可表示的 input 都明确失败。

接受成功前，输入已经作为 canonical `user_message` 写入 journal。相同
`clientUserMessageId`、Turn 与内容的重试返回原成功且不重复追加；冲突复用失败。
steer 不取消当前 model stream、tool 或 approval，也不处理 approval。若它在
一次模型响应期间到达，Runtime 会完成该响应及其工具结果，然后在下一次 sampling
前按 journal 中的 steer FIFO 顺序注入；因此原本可能结束的响应也会继续下一轮。

## Hard steer：Zen `turn/replace` extension

Codex 0.146.0 没有原子的 Interrupt & send 方法。Zen 因此增加明确的
`turn/replace` 扩展；它不是标准 `turn/steer` mode，也不扩大 Codex 兼容声明。
请求必须包含 `threadId`、`expectedTurnId`、text-only `input` 与非空
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

## 兼容范围

仓库测试覆盖 Zen CLI 的一轮会话、streaming、command approval、interrupt、
resume、双连接事件投影，以及 T3 Code 0.0.31 使用的 `account/read`、
`skills/list`、`model/list` bootstrap 和 full-access 配置投影。其他 sandbox
模式未实现；在真实 T3 Code 完成一轮会话与一次工具执行前，不宣称完整兼容。
原版 `codex --remote` TUI 0.146.0 还要求 `config/*`、`hooks/list` 等方法，
当前仍不兼容。

本机 schema oracle：

```sh
codex --version
codex app-server generate-ts --out /tmp/codex-app-server-types
codex app-server generate-json-schema --out /tmp/codex-app-server-schema
```
