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

Run the local App Server:

```powershell
npm run app-server
```

Run checks:

```powershell
npm run typecheck
npm test
npm run build
```

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

## Architecture

Start with:

- `docs/architecture.md`
- `docs/design-intent.md`
- `docs/prd/coding-agent-productization.md`
- `docs/implementation/alb-94-dogfood-acceptance.md`

## License

MIT
