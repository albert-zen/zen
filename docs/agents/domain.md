# Domain And Architecture Docs

Zen is an item-first agent kernel. Domain language should come from:

- `docs/design-intent.md`
- `docs/architecture.md`

## Core Terms

- `Item`: the atomic appended fact in the agent runtime.
- `ItemList`: the append-only source of truth for one agent instance.
- `AgentLoop`: the loop that compiles context, calls the model, executes tools, and appends resulting items.
- `ContextCompiler`: projection from item history to model-visible context.
- `HookRuntime`: explicit extension points that observe or produce items without mutating hidden kernel state.
- `ModelGateway`: provider-neutral model boundary.
- `ToolRuntime`: provider-neutral tool execution boundary.

## ADRs

Use `docs/adr/` for hard-to-reverse or surprising decisions.

## Architecture Review

Use `improve-codebase-architecture` for deep-module review after implementation exists.
