# Usable Agent Interface Evidence

Date: 2026-05-29

## Scope

This slice makes Zen usable from a terminal with a TUI-first product path. It
uses Zen's own OpenAI-compatible model provider configuration, persists local
threads, and exposes basic workspace tools. It does not implement permission approval or a network
transport server.

The implemented path is:

```text
TTY TUI Adapter or non-interactive line adapter
  -> AgentInteractionSession
  -> AppServerClient
  -> configured model provider + local tools
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
- `src/tui-engine.ts`
  - Provides a small component tree, raw terminal adapter, editor component,
    synchronized output, cursor marker handling, and line-diff rendering.
- `src/zen-tui-app.ts`
  - Binds `AgentInteractionSession` snapshots to the component TUI and supports
    live transcript rerendering plus `/help`, `/status`, `/resume`,
    `/interrupt`, `/tools`, `/new`, and `/exit`.
- `src/tui.ts`
  - Selects the component TUI for interactive TTYs and preserves the
    line-oriented adapter for pipes and smoke automation.
- `src/cli.ts`
  - CLI entry point for the TUI.
- `src/model-provider-config.ts`
  - Loads provider, base URL, API key, model ID, and model params from Zen's
    provider config or `ZEN_*` environment variables.
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
/resume
/resume <number-or-thread-id>
/interrupt
/tools
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

Real model provider smoke:

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
  passed: 22 files, 92 tests

npm run build
  passed

non-interactive npm run tui smoke
  passed

component TUI virtual-terminal tests
  passed, including trace filtering, queued input, interrupt, and resume choices

model provider smoke
  passed with configured DashScope-compatible provider
```

## Productization Gaps

Next wave:

- Approval long-running interaction.
- Real transport between UI clients and App Server.
- Web UI switch from browser-local fake adapter to App Server client.
- Richer TUI controls beyond slash-driven flows: keyboard-native resume picker,
  true overlay menus, and scrollback navigation.
- Better sandbox/permission profiles for local tools.
