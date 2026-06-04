# PRD: Coding Agent Productization

## Problem Statement

Zen has an item-first kernel, an in-process App Server, a real OpenAI-compatible
model adapter, a local shell tool, durable thread snapshots, and a component
TUI. It is usable as a prototype, but it is not yet a reliable day-to-day
coding agent replacement.

The productization gap is not more tool names. The first real coding-agent
runtime should be shell-first: one reliable PowerShell tool that can inspect
files, search with `rg`, edit files, run tests, and expose enough execution
state for the UI and agent to recover from failures.

## Goals

- Make the shell-first coding loop reliable enough for real repo work.
- Keep `ItemList` as the source of truth for model, tool, UI, persistence, and
  review evidence.
- Improve the TUI into a high-frequency workbench for shell activity, queued
  input, failed turns, retry, and thread resume.
- Harden durable thread storage so crashes and interrupted turns can be
  recovered predictably.
- Add a real App Server transport so TUI/Web clients can consume the same
  Thread/Turn/Item protocol without importing runtime internals.
- Add an end-to-end dogfood acceptance scenario proving Zen can perform a small
  coding task through the real model and shell runtime.

## Non-Goals

- Reintroducing separate read/write/search tools.
- Building a permission or approval system in the kernel loop.
- Multi-user authentication, hosted deployment, or workspace isolation.
- Full Codex/Pi feature parity in one wave.
- Replacing the item-first architecture with a second UI state source.

## Current Baseline

- `LocalToolRuntime` exposes only `shell`.
- Shell results include `exitCode`, `stdout`, and `stderr`, but output is not
  streamed while the command runs.
- TUI renders shell calls distinctly, supports slash commands, queue display,
  interrupt, and basic resume.
- `FileThreadStore` persists thread snapshots and can resume saved threads, but
  lacks schema versioning, atomicity guarantees, crash repair policy, history
  search, and richer thread selection.
- App Server is an in-process client API, not a real long-running transport.

## Product Direction

The minimum viable replacement path is:

```text
Terminal/Web UI
  -> App Server client/transport
  -> Thread/Turn/Item protocol
  -> ThreadManager
  -> AgentLoop
  -> OpenAI-compatible ModelGateway
  -> shell-first ToolRuntime
  -> ItemList
```

The shell tool is the only local workspace capability in this phase. Any future
tool must justify itself by improving reliability or safety beyond what shell
can do, not by duplicating basic filesystem operations.

## Behavior Requirements

- A shell command starts, streams observable output deltas, completes with exit
  evidence, and can be interrupted without leaving the turn permanently stuck.
- TUI shows shell command, running state, stdout/stderr, exit code, failures,
  and retry affordances as workbench rows rather than raw JSON.
- TUI can show queued input and failed turn recovery state without corrupting
  the transcript.
- Thread persistence has a versioned file format, atomic writes, corruption
  handling, and startup repair for in-progress turns from a prior process.
- A user can browse and resume prior threads by meaningful metadata rather than
  only raw ids.
- App Server has a real transport with ordered notifications and a client
  adapter that keeps UI code protocol-only.
- A final dogfood scenario demonstrates a real model using shell to inspect the
  repo, make a small code change, run validation, and leave reviewable evidence.

## Testing Decisions

- Use TDD with vertical behavior slices.
- Prefer public-interface tests:
  - `LocalToolRuntime` behavior through `ToolRuntime`.
  - App Server behavior through `AppServerClient`.
  - TUI behavior through virtual terminal tests.
  - Store behavior through `ThreadStore`.
  - Transport behavior through a client/server adapter test.
- Required gates for implementation issues:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`

## Quality And Review

- Preserve `ItemList` as the source of truth.
- Keep product adapters outside the kernel.
- Prefer deep modules over shallow helper sprawl.
- Comments must explain non-obvious lifecycle, persistence, provider, or
  concurrency decisions.
- Each worker issue must leave a `## Codex Worker Note` with evidence.
- Each reviewer pass must leave a `## Codex Review Note`.

## Open Questions

- None blocking for this productization wave. Permission and approval policy is
  intentionally deferred.
