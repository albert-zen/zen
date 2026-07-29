# Codex App Server protocol boundary

Zen 的唯一 wire protocol 是 **codex-cli 0.146.0** App Server message
protocol 的固定子集。升级 Codex 版本必须重新生成 schema、审查映射并更新本文件；
这里不使用“兼容最新版”。

## 当前子集

Client requests：

- `initialize`
- `thread/start`
- `thread/resume`
- `thread/read`
- `thread/list`
- `thread/unsubscribe`
- `turn/start`
- `turn/interrupt`

Client notification：`initialized`。

Server notifications：

- `thread/started`
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
approval 只接受 `on-request` 与 `never`，二者是不同维度。实时 token usage 暂不
投影，避免发送不完整的 0.146.0 类型。

## Transport

`stdio.ts` 实现每行一个 JSON-RPC message 的 stdio transport；
`websocket.ts` 实现无鉴权的 loopback-only `ws://` transport。二者承载完全相同
的消息协议。Unix socket 与非本机监听尚未实现。

## 兼容范围

仓库测试覆盖 Zen CLI 的一轮会话、streaming、command approval、interrupt、
resume 与双连接事件投影。原版 `codex --remote` TUI 0.146.0 还要求
`account/read`、`model/list`、`config/*`、`hooks/list` 等 bootstrap 方法；
Zen 没有伪造这些响应，因此当前不宣称兼容原版 TUI。

本机 schema oracle：

```sh
codex --version
codex app-server generate-ts --out /tmp/codex-app-server-types
codex app-server generate-json-schema --out /tmp/codex-app-server-schema
```
