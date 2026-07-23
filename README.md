# Zen

Zen is an item-first agent kernel and a local multi-agent Project/Thread control plane.

The core design keeps `ItemList` as the source of truth. The agent loop appends
items, and product layers such as the Agent App Server, Web UI, durable store,
model provider adapter, and shell runtime project from that item history.

For ChatGPT/Codex subscription access, Zen uses a Pi-backed, inference-only
OAuth adapter to the Codex Responses transport. Zen itself remains the harness:
its AgentLoop, Item history, context compiler, tool runtimes, approvals,
scheduler, and Project/Thread/Turn persistence execute every Turn. The provider
prefers its own WebSocket transport with HTTP fallback; Zen clients continue to
use the separate local HTTP/SSE App Server transport.

Zen owns its ChatGPT OAuth credential independently and never imports or
rotates another application's auth file. Provider WebSocket sessions use a
stable, globally unique identity derived from the Zen Project and its
project-scoped Thread id; canonical context and replay still come only from
Zen Items.

## Status

Zen currently includes:

- item-first kernel primitives and `AgentLoop`
- OpenAI-compatible model provider support
- shell-first local `ToolRuntime`
- durable local thread store
- project-scoped Agent App request/notification protocol
- local HTTP/SSE Agent App transport
- static Web UI client
- Project/Thread coordination with durable local journals, policy limits, and agent thread tools
- thin Electron host for the same HTTP/SSE App Server protocol
- QQ-backed IMZen gateway over the same Project/Thread protocol
- interrupt, retry, and thread resume flows
- repeatable dogfood acceptance scenario

## Quick Start

Install dependencies:

```powershell
npm ci
```

Run the Web product with its trusted same-origin proxy:

```powershell
npm run web
```

The product is a control plane for multi-agent work: create a Project, create
parent/child Threads, send objectives, observe Item-derived activity, then
handoff, cancel, archive, or wait on coordinated work. It intentionally has no
terminal, editor, file tree, diff viewer, or source-control workbench.

Agent executors receive explicit `thread.create`, `thread.list`, `thread.read`,
`thread.send`, `thread.wait`, `thread.cancel`, `thread.archive`, and
`thread.handoff` tools. Project policy bounds depth, concurrency, messages,
and retained idempotency facts; UI input never grants executor authority.

## Desktop Development

Build the local Electron desktop application:

```powershell
npm run zenx:build
```

Run the built desktop application locally:

```powershell
npm run zenx:dev
```

For an ordinary direct launch, the desktop main process starts a private
project-scoped Agent App HTTP/SSE transport on loopback. When both
`ZEN_APP_SERVER_URL` and `ZEN_APP_SERVER_CAPABILITY` select a trusted loopback
server, ZenX instead runs in external mode: it creates no production
composition or private Agent App transport and its same-origin static host
proxies the supplied shared server. The renderer only uses Agent App
`/request` and `/events`; the capability remains in the main-process proxy.
Electron exposes only directory selection and a bounded native-notification
bridge to the Web UI.

Create an unsigned unpacked Windows artifact with:

```powershell
npm run zenx:pack
```

`npm run zenx:dist` creates the default x64 NSIS artifact. These are
development artifacts and are unsigned; publishing is explicitly disabled, so
release signing and updates are not configured in this wave.

## IMZen QQ Gateway

IMZen is an independent client of an already-running Zen App Server. It never
creates a Project from QQ and never calls the model/provider runtime directly.
Create the target Project in ZenX first, then start the standalone App Server
with a provided capability and give IMZen the same URL and capability:

```powershell
$env:ZEN_APP_SERVER_URL = "http://127.0.0.1:3000"
$env:ZEN_APP_SERVER_CAPABILITY = "<same capability used by the App Server>"
$env:IMZEN_PROJECT_ROOT = "D:\path\to\existing\project"
$env:IMZEN_QQ_SECRET_FILE = "D:\private\qqbotSecret.json"
npm run imzen:start
```

The external credential file has this shape and is never copied into the
repository or IMZen state:

```json
{
  "appid": 123456789,
  "appsecret": "..."
}
```

Set `IMZEN_ALLOWED_USER_IDS` to a comma-separated QQ open-id allowlist. Without
an allowlist, the first startup prints a one-time `/pair <code>` command;
ordinary messages remain unauthorized until that exact command is received.
QQ conversations bind to durable Zen Threads, and pending replies resume after
an IMZen restart with stable App Server and QQ idempotency keys. `/threads`
lists Threads in the configured Project, `/bind <threadId>` validates and binds
an existing Thread, and `/new [objective]` creates and binds a new Thread.

On Windows, the managed live command builds the server and clients, starts
exactly one standalone loopback App Server, registers this repository as a
Project through that App Server, and starts IMZen and ZenX with the same URL and
capability. It records only verified process identities (never the capability
or QQ credential) under the application data directory:

```powershell
npm run imzen:live -- start -SecretFile "D:\private\qqbotSecret.json"
npm run imzen:live -- status
npm run imzen:live -- stop
```

Repeated `start` calls reuse the registered process set instead of accumulating
Node or Electron processes. `stop` verifies PID, creation time, executable, and
command line, then requests graceful shutdown for IMZen and ZenX before the App
Server. It force-stops only a still-running, verified owned tree after the
bounded graceful wait expires. The v3 live descriptor records three per-run
shutdown marker paths and process identities, never the capability or QQ
credential.

Local project metadata and coordination journals live under one canonical OS
application data/state boundary shared by the CLI, Web host, ZenX, and other
desktop hosts. `ZEN_APP_DATA_ROOT` may override that boundary only with an
absolute path. Production state never defaults to the repository. The browser
renderer receives no App Server capability and uses only same-origin `/request`
and `/events` routes.

The Web browser only calls same-origin `/request` and `/events` routes. The
Node/Vite process creates and injects the App Server capability; browser code
never receives it. Direct browser-to-App-Server URLs and cross-origin access
are not supported.

Run checks:

```powershell
npm run check
```

`npm run check` runs Prettier, ESLint, core and Web typechecks, serialized Vitest
tests, production and acceptance builds, the Web build, separate
kernel/product/presentation coverage gates, and Playwright browser workflows.
Each coverage group requires at least 85% statements, functions, and lines,
plus 80% branches.

Install the Playwright Chromium browser once before the browser gate:

```powershell
npx playwright install chromium
```

The canonical `origin` is `https://github.com/albert-zen/zen.git`. Agent workers
push scoped `codex/<linear-id>-<topic>` branches, open GitHub pull requests, and
hand off only after required checks and recorded review evidence are complete.

Run the dogfood acceptance scenario:

```powershell
npm run dogfood:alb-94
```

## Secure App Server Transport

Every standalone HTTP request and SSE connection requires an unguessable
capability. Choose exactly one standalone startup mode.

Generated one-time handoff mode creates a unique owned artifact in an existing
caller-selected directory:

```powershell
$handoffDirectory = Join-Path $env:TEMP "zen-app-server-handoff"
New-Item -ItemType Directory -Force $handoffDirectory | Out-Null
$env:ZEN_APP_SERVER_CAPABILITY_DIR = $handoffDirectory
Remove-Item Env:ZEN_APP_SERVER_CAPABILITY -ErrorAction SilentlyContinue
npm run app-server
```

The CLI prints the published artifact path after its complete contents are
flushed. A Node client claims that path once. For the standalone Vite proxy,
set the printed path in another shell:

```powershell
$env:ZEN_APP_SERVER_CAPABILITY_HANDOFF = "<printed artifact path>"
Remove-Item Env:ZEN_APP_SERVER_CAPABILITY -ErrorAction SilentlyContinue
npm run web:dev
```

Vite atomically claims and deletes the handoff before serving browser traffic.
The handoff reader is available to trusted Node hosts as the
`consumeAppServerClientHandoff` export from `@zen/framework/node`; it is not a
browser API or a retired projectless client session.

Provided capability mode uses the same secret in the standalone server and a
trusted Node client or standalone Vite process:

```powershell
$env:ZEN_APP_SERVER_CAPABILITY = (node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))").Trim()
Remove-Item Env:ZEN_APP_SERVER_CAPABILITY_DIR -ErrorAction SilentlyContinue
npm run app-server
```

In another shell, give the same `ZEN_APP_SERVER_CAPABILITY` to a trusted Node
client. A standalone Vite proxy also accepts that variable, with
`ZEN_APP_SERVER_URL` selecting the App Server target, and injects the secret
server-side.

Do not configure both a provided capability and a handoff mode. Capabilities
are intentionally absent from routine CLI and proxy logs.

Bindings default to `127.0.0.1`. Non-loopback exposure requires both an
explicit host and opt-in:

```powershell
$env:ZEN_APP_SERVER_HOST = "0.0.0.0"
$env:ZEN_APP_SERVER_ALLOW_REMOTE = "1"

$env:ZEN_WEB_HOST = "0.0.0.0"
$env:ZEN_WEB_ALLOW_REMOTE = "1"
```

## Architecture

The npm workspace is split by runtime ownership:

- `packages/framework`: `@zen/framework` kernel, product, presentation, and Node adapters
- `apps/cli`: `@zen/cli` App Server and Web development executables
- `apps/web`: `@zen/web` React application
- `apps/zenx`: `@zen/zenx` Electron desktop host
- `apps/imzen`: `@zen/imzen` QQ gateway client

Start with:

- `docs/architecture.md`
- `docs/architecture/monorepo.md`
- `docs/prd/imzen.md`
- `docs/design-intent.md`
- `docs/prd/coding-agent-productization.md`
- `docs/implementation/alb-94-dogfood-acceptance.md`

## License

MIT
