# PRD: App Server And Web UI

## Problem Statement

Zen has an item-first agent kernel, but no product-facing runtime layer. Callers can run `AgentLoop` directly, yet there is no stable thread protocol, no turn lifecycle manager, no approval workflow, and no web UI that can observe the item trace without depending on kernel internals.

The next layer should make Zen usable as an agent product while preserving the original design intent:

```text
The kernel appends Items.
Everything else is a projection, adapter, hook, or policy around that item list.
```

## Goals

- Provide an App Server Module that owns Thread and Turn management around the existing item-first kernel.
- Provide a stable protocol where UI clients see Thread, Turn, Item, and notification facts without learning internal kernel execution details.
- Keep `AgentLoop` free of permission policy logic.
- Add an approval workflow seam where tool execution can pause, emit auditable Items, and resume from an approval decision.
- Provide a Web UI that can start/resume a thread, submit a turn, and render item-stream progress from a fake runtime.
- Keep all behavior testable through public interfaces using fake model and fake tool adapters.

## Non-Goals

- Real OpenAI/Anthropic provider integration.
- Real shell, filesystem, or network tool execution.
- Durable database persistence beyond a replaceable in-memory store interface.
- Authentication, multi-user tenancy, or deployment packaging.
- Terminal UI implementation in this slice.
- Full Codex-compatible protocol parity.

## Solution Overview

The App Server sits outside the kernel. It owns thread identity, turn identity, subscriptions, request routing, and UI-ready notifications. It runs the existing `AgentLoop` with an `ItemList` per thread and emits notifications when Items are appended.

The Web UI talks only to the App Server protocol. It never imports `AgentLoop`, `ContextCompiler`, `ToolRuntime`, or hook internals. Its source of truth is the thread snapshot plus streamed notifications.

Approval is modeled as a ToolRuntime wrapper, not as AgentLoop logic:

```text
AgentLoop
  -> ToolRuntime
      -> PolicyRuntime
          -> allow | deny | needsApproval
      -> ApprovalBroker
      -> Tool Adapter
```

When approval is needed, the runtime appends approval Items, waits for the App Server approval decision, then either executes, denies, or returns a tool error/result Item.

## User Stories

1. As a Web UI user, I want to create a thread and send a message, so that I can inspect the resulting agent item trace.
2. As a Web UI user, I want assistant deltas, completed messages, tool calls, and tool results to appear in order, so that the runtime is understandable while it runs.
3. As an App Server client, I want stable Thread/Turn/Item notifications, so that UI and terminal adapters can be implemented without depending on kernel internals.
4. As a tool runtime author, I want policy and approval behavior outside `AgentLoop`, so that permissions can evolve without changing the loop.
5. As a manager/reviewer, I want behavior tests for protocol, thread lifecycle, approval, and web state projection, so that implementation can proceed through Linear issues safely.

## Behavior Requirements

- `thread/start` creates a new thread with an empty `ItemList`, generated thread ID, and configured fake runtime adapters.
- `thread/read` returns the current thread snapshot, turns, and ordered Items.
- `turn/start` appends user input through the kernel and returns a turn ID immediately or after a deterministic fake turn, depending on the first implementation's execution model.
- The App Server emits ordered notifications for:
  - thread started,
  - turn started,
  - item appended,
  - turn completed,
  - turn failed,
  - approval requested,
  - approval resolved.
- The protocol exposes core Items with a stable envelope and filters out `visibility: "internal"` by default.
- The Web UI renders:
  - thread list or current thread identity,
  - turn composer,
  - ordered item timeline,
  - assistant text deltas and completed assistant messages,
  - tool call/result/error rows,
  - approval request controls when an approval Item is pending.
- Approval decisions are auditable as Items and are also sent as protocol notifications.
- `AgentLoop` remains unaware of thread storage, UI transport, and approval policy.

## Implementation Decisions

- Add an `app-server` module family outside the kernel-facing modules:
  - `AppServerProtocol` defines request, response, notification, and snapshot shapes.
  - `ThreadManager` owns Thread records, ItemLists, Turn records, subscriptions, and fake runtime construction.
  - `AppServer` exposes request methods and subscription APIs over an in-process adapter first.
  - `ApprovalBroker` tracks pending approval requests and resolves decisions.
- Add an approval-capable ToolRuntime Adapter:
  - It wraps another `ToolRuntime`.
  - It asks a `PolicyRuntime` for `allow`, `deny`, or `needsApproval`.
  - It appends approval Items and awaits `ApprovalBroker` decisions when needed.
  - It yields normal `ToolRuntimeEvent` values back to the existing kernel path.
- Keep protocol objects JSON-safe. No functions, class instances, or mutable references cross the protocol seam.
- Keep the Web UI dependency-light. Use static HTML/CSS/TypeScript-compatible JavaScript or minimal browser modules before introducing a frontend framework.
- Add a web state projection module that can be tested without a browser. DOM rendering is an Adapter over that projection.
- Deltas remain progress facts; completed Items remain authoritative.

## Testing Decisions

- Protocol tests assert JSON-safe request/notification shapes and visibility filtering.
- Thread manager tests run fake model/fake tool turns and assert notification order matches Item sequence.
- Approval tests cover allow, deny, needs-approval, decision resolution, and timeout/cancel behavior where implemented.
- Web state tests project notifications into a timeline and assert completed Items override deltas.
- Browser smoke is required once the static Web UI exists; until a dev server is configured, static rendering can be tested through unit-level DOM/state tests.
- Existing gates remain required:
  - `npm run typecheck`
  - `npm test`

## Quality And Standards

- Preserve the item-first model: Thread and Turn are App Server concepts, not competing kernel primitives.
- Prefer deep modules:
  - App Server callers should not manually coordinate ItemList, observers, AgentLoop, subscriptions, and turn state.
  - Web UI callers should not understand raw kernel execution rules.
- Keep meaningful behavior auditable as Items.
- Keep `AgentLoop` readable and stable.
- Do not add pass-through modules unless they protect a real seam with clear future adapters.
- Comments should document lifecycle, ordering, approval, or protocol invariants only when those constraints are not obvious.

## Open Questions

- None blocking for the fake-runtime App Server and Web UI slice.

