# Zen

本地优先的个人 agent 运行框架：一个 append-only ItemList 驱动的极简
Agent Runtime，加一个按 Thread 路由的统一 App Server。CLI、桌面、Web、IM
都是平级接入端。

Zen Core 没有 Project、Coordinator、Scheduler 或第二套状态机。API Key、
Provider 账户和 workspace 配置由宿主持有，不进入 Thread。

## 当前可用

- append-only canonical Item 与每 Thread 一个 JSONL journal
- FakeModel、OpenAI-compatible 与 ChatGPT subscription model adapters
- shell tool、command item 审批、Turn interrupt
- codex-cli 0.146.0 App Server 协议子集（JSONL stdio / loopback WebSocket）
- `run`、`chat`、`threads`、`app-server` 薄 CLI
- 独立 IMZen（QQ / Telegram / Feishu / Weixin channel adapters）

## 快速验证

需要 Node.js 22+、Python 3.13+ 与 `uv`：

```sh
npm install
npm run check
npm run build
node dist/apps/cli/src/cli.js run "hello"
node dist/apps/cli/src/cli.js run --approve "!shell printf tool-ok"
```

启动一个可被其他接入端连接的 App Server：

```sh
umask 077
mkdir -p ~/.config/zen
openssl rand -hex 32 > ~/.config/zen/app-server.token
node dist/apps/cli/src/cli.js app-server \
  --listen ws://127.0.0.1:4500 \
  --auth-token-file ~/.config/zen/app-server.token
node dist/apps/cli/src/cli.js run \
  --remote ws://127.0.0.1:4500 \
  --auth-token-file ~/.config/zen/app-server.token \
  "hello remotely"
```

T3 Code 固定以 stdio 启动 `${binary} app-server`。把 binary 指向 `zen`，并把
launch args 设为 `--remote ws://127.0.0.1:4500 --auth-token-file <path>`，
Zen CLI 就只做 JSONL stdio ↔ WebSocket 薄桥；Thread 与模型执行仍全部属于上面的
中央 Zen App Server，不会为每个 T3 session 创建本地 runtime。T3 0.0.31
自动追加的 loopback `mcp_servers.t3-code` 两项 `-c` 配置只在这个 remote
bridge 模式下被精确识别并忽略；Zen 当前不宣称提供 T3 MCP tools。

真实模型使用 `--provider openai-compatible`、`--model`、`--base-url` 与
`--api-key-env`。指定的 key 只由宿主读取，不进入协议、Thread 或 shell tool
环境，并从工具输出中脱敏。当前 `danger-full-access` 仍不是安全沙箱；完整参数见
`node dist/apps/cli/src/cli.js help`。

CLI 与 App Server 默认使用 Full Access：`sandbox=danger-full-access` 且
`approvalPolicy=never`。需要逐项确认命令时显式传
`--approval always`。Full Access 没有安全隔离，只应在受信任的本机和接入端使用。

ChatGPT Plus / Pro subscription 使用 Zen 自己的宿主 profile，不读取或覆盖
Codex CLI 的 rotating credential：

```sh
node dist/apps/cli/src/cli.js auth login
node dist/apps/cli/src/cli.js run --provider openai-subscription "hello"
node dist/apps/cli/src/cli.js app-server --provider openai-subscription
```

IMZen 的配置与运行方法见 [apps/imzen/README.md](apps/imzen/README.md)。

## 文档

- [VISION.md](VISION.md) — 北极星与目标
- [ARCHITECTURE.md](ARCHITECTURE.md) — 不变量、核心概念、协议、adapter 边界
- [LESSONS.md](LESSONS.md) — 非目标与 zen-legacy 的教训
- [PRODUCTS.md](PRODUCTS.md) — 各接入端的定位与里程碑
- [SALVAGE.md](SALVAGE.md) — 从 zen-legacy 移植的清单
- [src/protocol/codex/README.md](src/protocol/codex/README.md) — 固定协议版本与精确子集

前身仓库见 [zen-legacy](https://github.com/albert-zen/zen-legacy)（tag `legacy-2026-07`）。
