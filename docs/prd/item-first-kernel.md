# PRD: Item-First Agent Kernel

## Problem Statement

Zen needs a first implementation target for its item-first agent kernel. The current design intent is clear: the agent should be explainable as a loop that appends `Item` records, and every meaningful runtime fact should be derived from those items. The missing piece is a product and engineering specification precise enough to guide implementation without drifting into a full coding-agent product.

The most important unresolved design pressure is how to represent streaming deltas. The kernel needs real-time UI and trace support, but model context, persistence, and resume behavior must not depend on reconstructing authoritative state from transient stream fragments.

## Goals

- Define the minimal item-first kernel that can run one agent turn with fake model and fake tool implementations.
- Define a stable `Item` envelope that supports traceability, causality, turn/run grouping, and streaming updates.
- Support streaming deltas as first-class appended facts while keeping completed items authoritative.
- Keep model providers, tool implementations, persistence, UI, permissions, and sandboxing outside the kernel.
- Make hooks explicit and auditable through item production rather than hidden state mutation.
- Provide enough test requirements for later issue slicing and TDD implementation.

## Non-Goals

- Full coding-agent product behavior.
- Durable database schema.
- Built-in terminal UI or web UI.
- Built-in sandbox, permission, or approval product.
- MCP/plugin marketplace support.
- Multi-agent orchestration.
- Branch/fork semantics beyond envelope fields that do not block future support.
- Provider-specific API modeling beyond a minimal `ModelGateway` interface.

## Solution Overview

Build a small TypeScript kernel centered on an append-only `ItemList`. A caller creates an in-memory item list, appends user input through the agent runtime, and the agent loop repeatedly:

1. Appends lifecycle/user items.
2. Compiles completed items into model context.
3. Calls a provider-neutral model gateway.
4. Appends assistant message start/delta/completed items.
5. Executes requested tools through a provider-neutral tool runtime.
6. Appends tool call, output delta, result, and error items.
7. Stops when no further tool calls or continuation work remains.

Streaming deltas are appended for real-time consumers and optional trace export. Completed items remain the authority for context compilation, resume, and default persistence.

## User Stories

1. As a kernel reader, I want to understand the full agent loop from one small path, so that I can reason about behavior without learning product adapters first.
2. As a kernel integrator, I want all meaningful runtime facts represented as items, so that trace, UI, persistence, and evaluation can be projections over one source of truth.
3. As a model adapter author, I want a provider-neutral boundary, so that swapping OpenAI, Anthropic, or a fake model does not change the agent loop.
4. As a tool adapter author, I want tool execution to return items, so that tool progress, result, and failure are visible in the trace.
5. As a hook author, I want explicit hook points with constrained return shapes, so that custom behavior is powerful but still debuggable.
6. As a test author, I want the whole kernel runnable with fake model and fake tools, so that behavior can be verified without network or sandbox dependencies.

## Behavior Requirements

- The kernel must expose an append-only `ItemList` abstraction with an in-memory implementation.
- Every appended item must have a stable ID, type, creation time, run ID, turn ID, sequence number, and payload.
- The item envelope must support optional `parentId`, `causeId`, `targetId`, `visibility`, and `meta` fields.
- `seq` must be monotonically increasing within an item list and must define replay order when timestamps are equal or unreliable.
- User input must be represented as a completed item, not only as model context.
- Assistant streaming must produce delta items when the model emits deltas.
- Assistant completion must produce a completed item that contains the authoritative final text/content.
- Tool execution must represent start, optional output deltas, completed result, and error outcomes as items.
- Context compilation must default to completed semantic items only, not raw deltas.
- Trace export may include deltas, lifecycle items, and hook items.
- Persistence adapters must be able to observe appended items without changing the agent loop.
- Default persistence guidance must allow skipping high-volume delta items while preserving completed items.
- Hooks must not mutate hidden kernel state directly.
- If a hook changes meaningful behavior, the change must be visible as an item or as an explicit returned replacement/block decision that the loop converts into an item.

## Implementation Decisions

### Item Envelope

Use this envelope as the initial contract:

```ts
type Item = {
  id: string;
  type: string;
  createdAtMs: number;
  seq: number;
  runId: string;
  turnId: string;
  parentId?: string;
  causeId?: string;
  targetId?: string;
  visibility?: "model" | "trace" | "ui" | "internal";
  payload: unknown;
  meta?: Record<string, unknown>;
};
```

Keep domain fields such as `role`, `content`, `toolName`, `arguments`, `usage`, and `stopReason` inside typed payloads rather than the generic envelope.

### Initial Item Types

The first kernel should support at least:

- `run.started`
- `run.completed`
- `turn.started`
- `turn.completed`
- `user.message.completed`
- `model.request.started`
- `model.request.completed`
- `assistant.message.started`
- `assistant.message.delta`
- `assistant.message.completed`
- `tool.call.started`
- `tool.output.delta`
- `tool.result.completed`
- `tool.error`
- `hook.effect`
- `error`

### Delta Policy

Support deltas, but do not make them authoritative.

- Delta items must reference their logical item through `targetId`.
- Delta payloads should include `delta` and a content index when multiple content parts are possible.
- Completed items may differ from concatenated deltas when providers rewrite, redact, normalize, or summarize output.
- Context compilation must consume completed items by default.
- Persistence adapters may drop delta items in normal mode and keep them in debug or extended mode.

### Context Compiler

`ContextCompiler` turns `Item[]` into `ModelContext`. It must:

- Select model-visible completed items.
- Ignore trace-only lifecycle items by default.
- Ignore raw deltas by default.
- Preserve provider-neutral content parts needed by the model gateway.
- Be testable without a model provider.

### Model Gateway

`ModelGateway` hides provider APIs:

```ts
interface ModelGateway {
  generate(context: ModelContext, options: ModelOptions): AsyncIterable<ModelEvent>;
}
```

`ModelEvent` may include text deltas, tool call deltas, completed assistant output, usage, errors, and stop reasons. The agent loop converts these events into items.

### Tool Runtime

`ToolRuntime` hides concrete tools and policy wrappers:

```ts
interface ToolRuntime {
  execute(call: ToolCallPayload, context: ToolExecutionContext): AsyncIterable<Item | ToolRuntimeEvent>;
}
```

The agent loop remains responsible for ensuring emitted tool facts are appended as items with correct IDs, causality, and turn/run metadata.

### Hooks

Initial hook points:

- `onItemAppending`
- `onItemAppended`
- `beforeContextCompile`
- `afterContextCompile`
- `beforeModelRequest`
- `onModelEvent`
- `beforeToolCall`
- `afterToolResult`
- `onRunFinished`

Hooks may observe, return items, transform context at defined points, or return explicit block/replace decisions. Hooks must not directly mutate the item list.

### Persistence Boundary

Persistence is an adapter, not the kernel storage model. The first implementation may include only an observer interface:

```ts
interface ItemObserver {
  onItemAppended(item: Item): void | Promise<void>;
}
```

Future persistence can save selected items to JSONL, SQLite, or remote trace services and seed a new `InMemoryItemList` on resume.

## Testing Decisions

- Use TDD for the first kernel implementation.
- Unit test `InMemoryItemList` append order, immutability expectations, and `seq` assignment.
- Unit test `ContextCompiler` with completed messages, tool results, lifecycle items, and deltas to prove only model-visible completed items are used by default.
- Unit test model event conversion into `assistant.message.started`, `assistant.message.delta`, and `assistant.message.completed`.
- Unit test tool execution conversion into start, output delta, result, and error items.
- Unit test hooks cannot mutate item list directly and that hook effects become visible items.
- Integration test a full run with fake model and fake tools.
- Integration test a streamed assistant response where deltas are emitted but the completed item remains authoritative.
- Integration test a tool call loop where a model emits a tool call, the tool returns a result, and the model produces a final answer.
- No browser/e2e tests are required until a UI exists.

## Quality And Standards

- The core agent loop must be readable from one primary implementation path.
- The kernel must depend on interfaces, not concrete provider, tool, persistence, sandbox, or UI implementations.
- The item list remains the source of truth; avoid parallel `messages[]`, `events[]`, `trace[]`, or `logs[]` as competing kernel state.
- Any projection, including model context and trace, must be reproducible from items.
- New abstractions must prove leverage by simplifying the core loop or isolating replaceable adapters.
- The first implementation should optimize clarity over feature completeness.

## Open Questions

- Should `runId` and `turnId` be required on every item, or should run-level items allow missing `turnId`?
- Should generated IDs use UUID, ULID, or an injected ID generator for deterministic tests?
- Should default persistence include lifecycle items such as `run.started` and `turn.started`, or only semantic completed items?
- Should `visibility` be a single value or a set of audiences?
- Should branch/fork support wait entirely, or should `parentId` semantics be formalized in the first version?
- Should hook replacement decisions preserve the original item as blocked/replaced trace evidence by default?

## Readiness For Issue DAG

This PRD is ready for `prd-to-issues-dag` once the open ID and `turnId` questions are resolved or accepted as issue-level decisions.
