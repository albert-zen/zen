# PRD: Usable Agent Interface

## Problem Statement

Zen now has an item-first kernel, an in-process App Server, and a static fake
Web UI. It is still not usable as a day-to-day agent interface because there is
no product runtime entry point that a user can open from a terminal, send
messages to, and inspect as a coherent conversation.

The next product slice should make interaction usable before optimizing for a
full Web transport or permissions system.

## Goals

- Provide a minimal Terminal UI that can start a Zen thread, submit messages,
  and show the resulting item timeline.
- Keep the TUI as an Adapter over App Server protocol, not a caller of kernel
  internals.
- Add a reusable interaction Session Module that owns request/subscription
  coordination and state projection for TUI and future Web clients.
- Preserve the item-first architecture: UI state is projected from protocol
  snapshots and notifications.
- Keep approval and permission policy out of this slice.
- Leave clear product seams for durable thread storage, real transport, and real
  model/tool adapters.

## Non-Goals

- Full-screen terminal rendering with curses/ratatui-style layout.
- Real permission approval routing.
- Multi-user authentication or workspace isolation.
- Full Web client replacement.
- Full Codex/Pi feature parity.
- Shipping a packaged npm release.

## Solution Overview

Use a TUI-first product path:

```text
Terminal User
  -> TUI Adapter
  -> AgentInteractionSession
  -> AppServerClient
  -> ThreadManager
  -> AgentLoop
  -> ItemList
```

`AgentInteractionSession` is the deep Module for product interaction. It hides
thread startup, turn submission, notification subscription, Web UI state
projection, and transcript rendering inputs behind a small interface. A simple
line-oriented TUI can then stay replaceable.

This follows the useful parts of the references:

- Pi: centralize lifecycle and session coordination in an `AgentSession`-like
  Module; keep interactive, print, and RPC modes as adapters.
- Codex: keep the chat surface as an event/protocol consumer; render history and
  input separately from core execution.

## User Stories

1. As a user, I want to run a command and get a prompt, so that I can talk to
   the Zen agent from a terminal.
2. As a user, I want each submitted message to update the conversation timeline,
   so that I can see what the agent did.
3. As a user, I want tool calls and tool results to appear distinctly, so that
   I can understand agent actions.
4. As an implementer, I want the TUI to use App Server protocol only, so that
   Web and transport adapters can share the same interaction logic.
5. As a reviewer, I want behavior tests around the interaction Session Module,
   so that UI behavior is verifiable without terminal automation.

## Behavior Requirements

- `npm run tui` starts a terminal interaction loop.
- On startup, the app starts a thread automatically and prints thread identity.
- A user can type a message and submit it with Enter.
- The TUI shows:
  - user messages,
  - assistant messages,
  - tool calls,
  - tool results,
  - tool errors,
  - approval rows if they exist in protocol state, but it does not request
    permission decisions in this slice.
- Supported commands:
  - `/help`: show local commands.
  - `/status`: show current thread status, turn count, and item count.
  - `/new`: start a new thread.
  - `/exit` or `/quit`: exit cleanly.
- The first runtime may use a demo model/tool adapter, but it must exercise the
  same App Server and Item path as real adapters will use.
- The TUI must not import `AgentLoop`, `ItemList`, `ContextCompiler`, or kernel
  internals directly.

## Implementation Decisions

- Add `AgentInteractionSession` as a product-facing Module over
  `AppServerClient` and `WebUiState`.
- Add a demo runtime factory that can produce normal assistant responses and a
  fake tool cycle.
- Add a transcript renderer that converts timeline rows to stable terminal text.
- Add a Node-based line-oriented TUI adapter using built-in `readline`.
- Add a TypeScript build path and package script for running the TUI.
- Keep durable storage as the next issue after the TUI MVP, unless implementation
  becomes necessary to support `/new` or status behavior.

## Testing Decisions

- Unit-test `AgentInteractionSession` through the public App Server client.
- Unit-test transcript rendering with message, tool, error, and approval rows.
- Unit-test the demo runtime through `AppServer` request/notification behavior.
- Build-check the TUI entry point.
- Required gates:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`

## Quality And Standards

- The interaction Session Module must be deep: deleting it should force thread
  request/subscription/state-projection complexity to spread into every UI
  adapter.
- The TUI adapter should stay thin and replaceable.
- Comments should explain lifecycle or protocol ordering only when non-obvious.
- Public interfaces should use domain terms: Thread, Turn, Item, App Server,
  Timeline, Session.

## Open Questions

- None blocking for a minimal TUI-first product slice.
