# Usable Agent Interface Evidence

Date: 2026-05-28

## Scope

This slice makes Zen usable from a terminal with a minimal TUI-first product
path. It now uses the OpenClaw model configuration at
`C:\Users\two-one\.openclaw\openclaw.json`, persists local threads, and exposes
basic workspace tools. It does not implement permission approval or a network
transport server.

The implemented path is:

```text
TUI Adapter
  -> AgentInteractionSession
  -> AppServerClient
  -> OpenClaw model provider + local tools
  -> ThreadManager
  -> AgentLoop
  -> ItemList
```

## Reference Notes

Codex reference:

- TUI keeps a chat surface that consumes app/protocol events.
- History rendering and bottom-pane input are separate concerns.
- UI does not directly own core execution.

Pi reference:

- `AgentSession` is the deep Module that concentrates lifecycle, event
  subscription, session switching, and mode-independent behavior.
- Interactive, print, and RPC modes are adapters over the session Module.

Zen applies the same direction by adding `AgentInteractionSession` as the shared
product Module for TUI now and Web/transport later.

## Implemented Modules

- `src/agent-interaction-session.ts`
  - Starts threads.
  - Submits turns.
  - Subscribes to App Server notifications.
  - Maintains projected timeline state.
- `src/demo-runtime.ts`
  - Creates a demo App Server with normal assistant response and fake tool
    cycle.
- `src/terminal-transcript.ts`
  - Renders timeline rows into terminal transcript lines.
- `src/tui.ts`
  - Provides a line-oriented TUI with `/help`, `/status`, `/new`, `/exit`, and
    message submission.
- `src/cli.ts`
  - CLI entry point for the TUI.
- `src/openclaw-config.ts`
  - Loads provider, base URL, API key, model ID, and model params from the local
    OpenClaw config.
- `src/openai-compatible-model-gateway.ts`
  - Calls OpenAI-compatible chat completions with streaming deltas and tool
    calls.
- `src/local-tool-runtime.ts`
  - Provides `read_file`, `write_file`, `list_files`, `search_files`, and
    `shell`.
- `src/thread-store.ts`
  - Persists thread snapshots under the local Zen thread directory and supports
    resume on startup.

## Run Path

```text
npm run tui
```

Supported commands:

```text
/help
/status
/new
/exit
/quit
```

## Smoke Transcript

Command:

```text
@'
hello tui
please use tool
/status
/exit
'@ | npm run tui
```

Observed output:

```text
Zen Agent TUI
Type /help for commands.
Started thread-1 (idle)
zen> You: hello tui
Zen: Zen demo response: hello tui
zen> You: please use tool
Zen: I will call the demo lookup tool.
Tool call demo.lookup: {"query":"please use tool"}
Tool result demo.lookup: lookup({"query":"please use tool"})
Zen: Demo tool returned: lookup({"query":"please use tool"})
zen> thread: thread-1 | status: idle | turns: 2 | items: 27
zen>
```

Real OpenClaw smoke:

```text
@'
Reply with exactly: ZEN_READY
/status
/exit
'@ | npm run tui
```

Observed output:

```text
Zen Agent TUI
Type /help for commands.
Started thread-1 (idle)
zen> You: Reply with exactly: ZEN_READY
Zen: ZEN_READY
thread: thread-1 | status: idle | turns: 5 | items: 56
```

## Verification

```text
npm run typecheck
  passed

npm test
  passed: 20 files, 84 tests

npm run build
  passed

non-interactive npm run tui smoke
  passed

OpenClaw model smoke
  passed with configured DashScope-compatible provider
```

## Productization Gaps

Next wave:

- Approval long-running interaction.
- Real transport between UI clients and App Server.
- Web UI switch from browser-local fake adapter to App Server client.
- Full-screen TUI rendering if line-oriented TUI becomes insufficient.
- Better sandbox/permission profiles for local tools.
