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
- `thread/settings/update`
- `thread/unsubscribe`
- `turn/start`
- `turn/steer`
- `turn/interrupt`

Client notification：`initialized`。

Server notifications：

- `thread/started`
- `thread/name/updated`
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
携带配置时，只有和 Thread metadata 等价的值会被接受；service tier、effort、
plan collaboration mode 等未实现配置返回 `-32602`。T3 总会发送的
`default` collaboration envelope 只作为接入端 UI 元数据接受：其中 model
必须匹配宿主，reasoning effort 必须为默认值；developer instructions 不进入
Thread，也不覆盖 Zen 的 Agent 行为。实时 token usage 暂不投影，避免发送
不完整的 0.146.0 类型。

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
