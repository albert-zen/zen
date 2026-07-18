# Zen

Zen is an item-first agent kernel and local coding-agent runtime.

The core design keeps `ItemList` as the source of truth. The agent loop appends
items, and product layers such as the App Server, TUI, Web UI, durable store,
model provider adapter, and shell runtime project from that item history.

## Status

Zen currently includes:

- item-first kernel primitives and `AgentLoop`
- OpenAI-compatible model provider support
- shell-first local `ToolRuntime`
- durable local thread store
- App Server request/notification protocol
- local HTTP/SSE App Server transport
- terminal UI
- static Web UI client
- interrupt, retry, and thread resume flows
- repeatable dogfood acceptance scenario

## Quick Start

Install dependencies:

```powershell
npm ci
```

Run the TUI:

```powershell
npm run tui
```

Run the Web product with its trusted same-origin proxy:

```powershell
npm run web
```

## Desktop Development

Build the local Electron desktop application:

```powershell
npm run desktop:build
```

Run the built desktop application locally:

```powershell
npm run desktop:dev
```

The desktop main process starts the project-scoped Agent App HTTP/SSE transport
on loopback and serves `web-dist` from a same-origin static host. The renderer
only uses Agent App `/request` and `/events`; the transport capability remains
in the main-process proxy. Electron exposes only directory selection and a
bounded native-notification bridge to the Web UI.

Create an unsigned unpacked Windows artifact with:

```powershell
npm run desktop:pack
```

`npm run desktop:dist` creates the default x64 NSIS artifact. These are
development artifacts and are unsigned; release signing and updates are not
configured in this wave.

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

The configured `origin` is a local workspace path. This program uses local
branches and local review; no GitHub PR/check handoff is part of this workflow
yet.

Run the dogfood acceptance scenario:

```powershell
npm run dogfood:alb-94
```

## Model Provider Configuration

By default Zen reads provider config from:

```text
C:\Users\<user>\.zen\model-provider.json
```

The same values can be supplied by environment variables:

```powershell
$env:ZEN_MODEL_BASE_URL="https://provider.example/v1"
$env:ZEN_MODEL_API_KEY="..."
$env:ZEN_MODEL="model-id"
$env:ZEN_MODEL_PARAMS='{"temperature":0}'
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
A custom Node client can instead pass the result of
`consumeAppServerClientHandoff(path)` from `dist/app-server-config.js` to
`HttpAppServerClient`.

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

Start with:

- `docs/architecture.md`
- `docs/design-intent.md`
- `docs/prd/coding-agent-productization.md`
- `docs/implementation/alb-94-dogfood-acceptance.md`

## License

MIT
