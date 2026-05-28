# Usable Agent Interface Evidence

Date: 2026-05-28

## Scope

This slice makes Zen usable from a terminal with a minimal TUI-first product
path. It does not implement permission approval, durable resume, real transport,
or a real model provider.

The implemented path is:

```text
TUI Adapter
  -> AgentInteractionSession
  -> AppServerClient
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

## Verification

```text
npm run typecheck
  passed

npm test
  passed: 17 files, 80 tests

npm run build
  passed

non-interactive npm run tui smoke
  passed
```

## Productization Gaps

Next wave:

- Durable thread store and resume.
- Real transport between UI clients and App Server.
- Real model provider adapter.
- Real tool runtime adapters.
- Approval long-running interaction.
- Web UI switch from browser-local fake adapter to App Server client.
- Full-screen TUI rendering if line-oriented TUI becomes insufficient.
