# Zen

本地优先的个人 agent 运行框架：一个 append-only ItemList 驱动的极简
Agent Runtime，加一个按 Thread 路由的统一 App Server。CLI、桌面、Web、IM
都是平级接入端。

Zen Core 没有 Project、Coordinator、Scheduler 或第二套状态机。API Key、
Provider 账户和 workspace 配置由宿主持有，不进入 Thread。

## 当前可用

- append-only canonical Item 与每 Thread 一个 JSONL journal
- FakeModel、OpenAI-compatible 与 ChatGPT subscription model adapters
- exact-name Tool Runtime registry、shell、`apply_patch` 文件编辑、shell-equivalent `run_code`
  programmatic tool calling、command item 审批与 Turn interrupt
- ZAS 自有的 App Server 协议，以及固定 codex-cli 0.146.0 Codex App Server（CAS）adapter
  （当前共享 JSONL stdio / loopback WebSocket endpoint 与 shape）
- `run`、`chat`、`threads`、`app-server` 薄 CLI
- 独立 IMZen（QQ / Telegram / Feishu / Weixin channel adapters）
- ZenX Plugin Package lifecycle、Host SDK 与 Generic UI Host（sidebar、page/subroute、settings、panel、command/menu；第三方 iframe 隔离）
- `@zenx/plugin-sdk` 的公开 manifest/schema、Host SDK/Runtime/UI 类型、fixture Host 与 `create` / `validate` / 标准 npm `pack` 开发命令
- 既有 tool result 的可选 namespaced structured content，以及缺失插件时仍可读的 JSON/Text fallback renderer

## 快速验证

需要 Node.js 22.13.0+、Python 3.13+ 与 `uv`。该 Node 下限来自
`run_code` 的 builtin erasable TypeScript stripping 合同：

```sh
npm install
npm run check
npm run build
node dist/apps/cli/src/cli.js run "hello"
node dist/apps/cli/src/cli.js run "!shell printf full-access-ok"
node dist/apps/cli/src/cli.js run --approve "!shell printf approved-ok"
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
自动追加的 `mcp_servers.t3-code` 两项 `-c` 配置只在这个 remote bridge 模式下
被精确识别并忽略；除此之外，bridge 只接受 `--remote` 与可选的
`--auth-token-file`。模型、审批、workspace 等宿主配置应在中央 App Server
启动时传入。用 `--models <model-a,model-b>` 声明兼容的字符串 ModelCatalog，并用
`--model <name>` 选择初始模型；T3、Zen CLI 与其他客户端都从同一个 App
Server 读取目录，并在 Turn 之间切换同一 Thread 的模型。Zen 当前不宣称提供
T3 MCP tools。宿主内部使用 Provider-scoped 结构化目录；Unknown capability 与
已知不支持严格区分，固定 `model/list` 不会根据模型名称猜测 reasoning、图片或
context window。

真实模型使用 `--provider openai-compatible`、`--model`、`--base-url` 与
`--api-key-env`。指定的 key 只由宿主读取，不进入协议、Thread 或 shell tool
环境，并从工具输出中脱敏。当前 `danger-full-access` 仍不是安全沙箱；完整参数见
`node dist/apps/cli/src/cli.js help`。

CLI 与 App Server 默认使用 Full Access：`sandbox=danger-full-access` 且
`approvalPolicy=never`。一次性 `run` 的 `--approve` / `--deny` 会自动启用
`--approval always`；`chat` 或 App Server 需要逐项确认命令时则显式传
`--approval always`。Full Access 没有安全隔离，只应在受信任的本机和接入端使用。

CLI 与本地 App Server 默认以 `--tool-presentation both` 同时向模型提供普通
structured tools 和 `run_code({ code, description })`；也可显式选择 `direct` 或
`code`。`run_code` 每次在 fresh Node Worker 中执行 erasable TypeScript，可通过同一
Tool Environment 的 `tools.*` 调用普通工具，只有显式 `text(...)` 成为外层结果。它与
shell 权限等同，不是不可信代码沙箱。显式 `code` 无法初始化 Worker 时 Host 启动失败；
默认 `both` 则明确 warning 并只发布 direct tools。审批按稳定 `run_code` tool name 记忆，
同时展示完整 code。`apply_patch({ patch })` 使用 Codex-style subset：Begin/End Patch、
Add/Update/Move/Delete、`@@` exact context 和可选 End of File；它不宣称支持 Codex 的完整宽松
parser。输入文件必须是 UTF-8，更新统一写回 LF；整包先做精确内容预检，预检失败不写文件，
写盘阶段的 I/O 失败会列出已经完成的前缀。回滚到
`direct` 只改变后续模型入口，不删除 runtime，也不改写已有
outer/child canonical history；旧 Thread 仍可从 ItemList 重放。

ChatGPT Plus / Pro subscription 使用 Zen 自己的宿主 profile，不读取或覆盖
Codex CLI 的 rotating credential：

```sh
node dist/apps/cli/src/cli.js auth login
node dist/apps/cli/src/cli.js run --provider openai-subscription "hello"
node dist/apps/cli/src/cli.js app-server --provider openai-subscription
```

交互式 `zen chat` 中，`/model` 列出宿主公开的模型，`/model <name>` 修改当前
Thread 后续 Turn 使用的模型。活跃 Turn 期间的修改会被 ZAS 拒绝；成功修改会
进入 append-only Thread journal，而 credential 仍留在宿主外部。

IMZen 的配置与运行方法见 [apps/imzen/README.md](apps/imzen/README.md)。
ZenX 插件开发合同与命令见 [packages/zenx-plugin-sdk/README.md](packages/zenx-plugin-sdk/README.md)。

## 文档

- [VISION.md](VISION.md) — 北极星与目标
- [ARCHITECTURE.md](ARCHITECTURE.md) — 不变量、核心概念、协议、adapter 边界
- [LESSONS.md](LESSONS.md) — 非目标与 zen-legacy 的教训
- [PRODUCTS.md](PRODUCTS.md) — 各接入端的定位与里程碑
- [SALVAGE.md](SALVAGE.md) — 从 zen-legacy 移植的清单
- [src/protocol/codex/README.md](src/protocol/codex/README.md) — 固定 CAS adapter 与精确兼容范围

前身仓库见 [zen-legacy](https://github.com/albert-zen/zen-legacy)（tag `legacy-2026-07`）。
