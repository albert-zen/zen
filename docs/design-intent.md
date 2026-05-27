# Zen Design Intent

## Intent

Zen should be a small, readable agent kernel built around one primitive: `Item`.

The design should make the agent's behavior easy to explain:

```text
The agent runs a loop.
The loop keeps appending items.
Those items are the source of truth.
Everything else is a projection, adapter, hook, or policy.
```

## What We Are Optimizing For

### Clarity

The system should be explainable without walking through many interacting abstractions.

The core question should always be:

```text
What item was appended, and why?
```

### Traceability

The item list should explain what happened:

- user input
- model request
- model output
- tool call
- tool result
- hook intervention
- run and turn boundaries
- errors and stop reasons

Trace should not be a separate afterthought. Trace is a view over the item list.

### Extensibility

Customization should happen through explicit hook points.

Hooks should be broad enough to support:

- context preprocessing
- prompt injection
- model request customization
- tool approval or routing
- tool result transformation
- trace export
- logging
- metrics

But hooks should not be allowed to mutate hidden kernel state directly.

### Replaceability

Concrete systems should be replaceable:

- model providers
- tool implementations
- sandbox implementations
- persistence adapters
- UI adapters
- trace exporters

The kernel should remain stable when these change.

## What The Kernel Is

The kernel is:

- `Item`
- `InMemoryItemList`
- `AgentLoop`
- `ContextCompiler`
- hook execution at defined points
- interfaces for model and tool execution

The kernel is not:

- a terminal UI
- a database
- a logger
- a sandbox
- a permission system
- a plugin marketplace
- a remote app protocol
- a full coding-agent product

Those systems can exist outside the kernel.

## Item As The Only Primitive

`Item` should be the only primitive because it gives the system one source of truth.

Run, turn, iteration, trace, message, tool call, and tool result are all representable as item types.

This avoids parallel state systems such as:

```text
messages[]
events[]
trace[]
history[]
logs[]
```

Instead:

```text
items[]
  -> model context
  -> trace view
  -> UI view
  -> persistence adapter
  -> evaluation data
```

## In-Memory First

The first kernel should maintain an in-memory item list.

This keeps the core simple and testable:

```ts
const items = new InMemoryItemList();
await agent.run(input, { items });
```

Persistence should be possible, but it should not define the kernel.

Persistence can be added through an adapter that observes appended items:

```text
onItemAppended(item)
  -> save item to JSONL / SQLite / remote trace service
```

On resume, an outer runtime can load persisted items and seed a new `InMemoryItemList`.

## Hook Philosophy

Hooks are part of the design, but they must not make behavior invisible.

Preferred rule:

```text
If a hook changes meaningful behavior, that change should be represented by an item.
```

Examples:

- A hook blocks a tool call: append `tool.blocked`.
- A hook adds context: append or annotate a context-related item.
- A hook rewrites a tool result: append a transformation item or produce a replacement result item.
- A hook changes model options: append `model.options.changed` if it matters for traceability.

This keeps custom behavior debuggable.

## Run And Turn

`Run` and `Turn` are useful names, but they should not become competing primitives.

They should be represented through item types and IDs:

```text
run.started
turn.started
turn.finished
run.finished
```

Items inside a run or turn can carry:

```ts
runId
turnId
```

This keeps lifecycle structure without creating another state system.

## Boundaries

### Inside The Kernel

- item envelope
- item append semantics
- current in-memory item list
- context compilation
- agent loop
- hook points
- model/tool interfaces

### Outside The Kernel

- concrete model providers
- concrete tools
- shell/file/network permissions
- sandboxing
- approval UI
- persistent storage
- terminal UI
- web UI
- remote protocols
- plugin discovery and installation

## Why Rebuild

A rewrite is justified if the current implementation makes the core idea harder to see.

The desired architecture should be readable from the smallest path:

```text
create item list
append user item
run loop
compile context
call model
append model item
execute tool
append tool result item
stop
```

If the implementation requires understanding many abstractions before this path is visible, it has drifted from the design intent.

## Non-Goals For The First Kernel

- Full coding-agent product behavior.
- Complex branch and fork semantics.
- Durable database schema.
- MCP or plugin marketplace.
- Built-in sandbox policy.
- Advanced terminal UI.
- Multi-client app-server protocol.

These can be layered later if the item-first kernel is correct.

## Success Criteria

The first kernel is successful if:

1. A reader can understand the loop in one file.
2. Every meaningful fact appears as an item.
3. Model context is compiled from items.
4. Trace is derived from items.
5. Hooks have explicit names and return shapes.
6. Persistence can be added without changing the loop.
7. A test can run the full agent with only `InMemoryItemList`, a fake model, and fake tools.
