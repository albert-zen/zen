# Zen Architecture

## System Goal

Zen is an item-first agent kernel.

The goal is not to build a feature-heavy agent runtime first. The goal is to define a small, understandable kernel where every meaningful runtime fact is represented as an `Item`, and the agent loop only appends new items.

Everything else is a view, adapter, hook, or policy around that item list.

## Core Principle

`Item` is the only primitive.

The kernel maintains an in-memory item list for the current agent instance:

```text
InMemoryItemList
  -> Item[]
```

That same list serves two purposes:

1. It compiles into model context.
2. It records the trace of what the agent did.

This avoids maintaining separate systems for messages, trace, events, history, and debug logs.

## Minimal Runtime Model

```text
User input
  -> append user item
  -> compile Item[] into model context
  -> request model output
  -> append assistant/model items
  -> execute requested tools
  -> append tool result items
  -> repeat until stop
```

The kernel should be understandable as a loop:

```ts
for await (const step of agentLoop(input, itemList)) {
  itemList.append(step.item);
}
```

The actual implementation does not need to expose this exact API, but the mental model should remain this simple.

## Core Modules

### Item

`Item` is the atomic record of agent state.

The base envelope should be small and stable:

```ts
type Item = {
  id: string;
  type: string;
  createdAt: number;

  runId?: string;
  turnId?: string;
  parentId?: string;
  causeId?: string;

  payload: unknown;
  meta?: Record<string, unknown>;
};
```

The kernel should not require a large class hierarchy. Most meaning should come from `type`, `payload`, and conventions around predefined item types.

### InMemoryItemList

`InMemoryItemList` is the current runtime state for one agent instance.

Minimal interface:

```ts
interface ItemList {
  append(item: Item): void;
  getItems(): readonly Item[];
}
```

Default implementation:

```ts
class InMemoryItemList implements ItemList {
  private items: Item[] = [];

  append(item: Item): void {
    this.items.push(item);
  }

  getItems(): readonly Item[] {
    return [...this.items];
  }
}
```

The name should avoid `Log`, `Store`, or `Repository` because those imply persistence. Persistence is an outer adapter.

### AgentLoop

`AgentLoop` is responsible for producing items.

It should:

- Accept input and current item list.
- Compile context from items.
- Call the model gateway.
- Detect tool calls.
- Ask the tool runtime to execute tools.
- Append resulting items.
- Stop when the stop condition is met.

It should not:

- Know terminal UI details.
- Know file/database persistence details.
- Know concrete sandbox implementations.
- Own product-specific slash commands.
- Own remote protocol concerns.

### ContextCompiler

`ContextCompiler` turns `Item[]` into the model-facing context.

```text
Item[]
  -> ContextCompiler
  -> ModelContext
```

This is a first-class boundary. Model context is a projection of items, not the source of truth.

Hooks may participate in context compilation, but they should do so through explicit hook points.

### ModelGateway

`ModelGateway` is the model boundary.

It should hide provider-specific APIs from the loop:

```ts
interface ModelGateway {
  generate(context: ModelContext, options: ModelOptions): AsyncIterable<ModelEvent>;
}
```

The kernel should not depend directly on OpenAI, Anthropic, or any other provider SDK.

### ToolRuntime

`ToolRuntime` is the tool execution boundary.

It should expose tools to the loop in a provider-neutral way:

```ts
interface ToolRuntime {
  execute(call: ToolCallItem, context: ToolExecutionContext): Promise<Item[]>;
}
```

Tool execution can produce one or more items, such as:

- `tool.call.started`
- `tool.output.delta`
- `tool.result`
- `tool.error`

Permissions, sandboxing, approvals, and environment isolation should wrap `ToolRuntime` from outside the kernel.

### HookRuntime

Hooks attach to explicit runtime points.

Hooks should be powerful enough to customize behavior, but constrained enough that the item list remains explainable.

Recommended rule:

- Hooks can observe items.
- Hooks can return new items.
- Hooks can transform context at defined points.
- Hooks can block or replace tool execution through explicit results.
- Hooks should not mutate the item list directly.

## Predefined Concepts

`run`, `turn`, and `iteration` are useful concepts, but they should not become separate primitive state systems.

They can be represented as items and item metadata:

```text
run.started
turn.started
user.message
model.request
assistant.message.delta
assistant.message
tool.call
tool.result
turn.finished
run.finished
```

This keeps the system queryable and replayable without creating parallel abstractions.

## Hook Points

Initial hook points:

| Hook                   | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `onItemAppending`      | Observe or validate an item before it is appended                        |
| `onItemAppended`       | Observe an appended item for trace, UI, metrics, or persistence adapters |
| `beforeContextCompile` | Add or suppress items before context compilation                         |
| `afterContextCompile`  | Inspect or transform compiled model context                              |
| `beforeModelRequest`   | Modify model request options or append diagnostic items                  |
| `onModelEvent`         | Convert streaming model events into items                                |
| `beforeToolCall`       | Approve, block, rewrite, or route a tool call                            |
| `afterToolResult`      | Inspect or transform tool result items                                   |
| `onRunFinished`        | Emit summary, metrics, or external trace output                          |

The exact names can change, but the boundary should stay explicit.

## Persistence Boundary

Persistence is not the kernel's storage model.

The kernel owns:

- `Item`
- `ItemList`
- append semantics
- context compilation from items

The outer layer owns:

- JSONL files
- SQLite or database storage
- remote trace uploads
- encryption
- indexing
- retention
- replay tooling

Recommended adapter shape:

```ts
interface PersistentItemStore {
  save(item: Item): Promise<void>;
  load(sessionId: string): Promise<Item[]>;
}
```

Persistence can subscribe to `onItemAppended` and save items without changing the kernel.

For a future resume flow, the outer runtime can load persisted items and seed a new `InMemoryItemList`.

## System Map

## Workspace Packages And Entry Points

The npm workspace separates reusable framework behavior from executable and UI
applications. The framework package root is kernel-only; product and edge
integrations use named subpaths rather than physical source imports.

```text
@zen/framework              -> packages/framework/src/kernel/index.ts
@zen/framework/product      -> packages/framework/src/product/index.ts
@zen/framework/node         -> packages/framework/src/adapters/node/index.ts
@zen/framework/presentation -> packages/framework/src/presentation/index.ts
@zen/cli                    -> apps/cli/src/{app-server-cli,web-dev-cli}.ts
@zen/web                    -> apps/web/src/main.tsx
@zen/zenx                   -> apps/zenx/src/main.ts
```

```text
kernel <- product <- adapters/node <- cli
   ^        ^               ^
   |        +--- presentation <- web
   +----------------------------- zenx
```

- `kernel` contains ItemList/retention, AgentLoop, context/hooks, neutral
  model/tool contracts, conversion helpers, and abort-aware iteration only.
- `product` owns thread/AppServer/approval behavior, demo runtime, prompt, and
  the ThreadJournal port and replay/error contracts.
- `adapters/node` owns filesystem journaling, shell/provider/configuration,
  HTTP/proxy transport, and Node process composition.
- `presentation` owns the interaction projection and browser transport/client.
- `apps/cli` owns executable startup while reusing Node adapter composition.
- `apps/web` owns the React application and its Vite build output.
- `apps/zenx` owns the Electron host and assembled desktop package output.

All production hosts resolve durable state through
`@zen/framework/node`'s `resolveAgentAppDataRoot()`. This keeps CLI, Web, and
desktop surfaces on the same OS state boundary and the same absolute
`ZEN_APP_DATA_ROOT` override.

The dogfood executable remains a cross-cutting `acceptance/` artifact built by
`tsconfig.acceptance.json`; it is deliberately excluded from framework
declarations.

```text
CLI / SDK / UI
  -> AgentRuntime
      -> InMemoryItemList
      -> AgentLoop
          -> HookRuntime
          -> ContextCompiler
          -> ModelGateway
          -> ToolRuntime
              -> Policy / Sandbox / Approval wrappers
      -> optional adapters
          -> PersistentItemStore
          -> TraceExporter
          -> Logger
```

Dependency direction should point inward:

```text
adapters depend on kernel
kernel does not depend on adapters
```

## Design Tests

The design should pass these tests:

1. If trace exporters are deleted, the agent still runs from `Item[]`.
2. If persistence is deleted, the agent still runs in memory.
3. If UI is deleted, the agent still runs through SDK or tests.
4. If a model provider is replaced, the agent loop does not change.
5. If a tool sandbox is replaced, the agent loop does not change.
6. If `Run` and `Turn` classes are deleted, run and turn facts can still be represented by items.

## Open Decisions

- Exact base `Item` envelope fields.
- Whether `runId` and `turnId` are required or optional.
- Whether streaming deltas are stored as first-class items or compacted into final items by default.
- Whether hooks can replace items or only append follow-up items.
- Minimal query API for `ItemList`, if any.
- Whether branch/fork support belongs in the first kernel iteration or a later layer.
