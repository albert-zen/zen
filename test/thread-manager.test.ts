import { describe, expect, it } from "vitest";

import {
  ThreadManager,
  type ModelGateway,
  type ThreadManagerEvent,
  type ToolRuntime
} from "../src/thread-manager.js";

describe("ThreadManager", () => {
  it("starts a thread with an empty item snapshot", () => {
    const manager = createManager();

    const thread = manager.startThread();

    expect(thread).toEqual({
      id: "thread-1",
      status: "idle",
      turns: [],
      items: []
    });
  });

  it("runs with the default fake runtime when no runtime factory is provided", async () => {
    const manager = new ThreadManager({
      generateThreadId: sequence("thread"),
      generateRunId: sequence("run"),
      generateTurnId: sequence("turn"),
      generateItemId: sequence("item"),
      clock: () => 1000
    });

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: "Use the default fake runtime"
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn.status).toBe("completed");
    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant.message.completed",
          payload: { content: "Fake response" }
        })
      ])
    );
  });

  it("queues same-thread turns FIFO with one active model execution", async () => {
    const releases = [createDeferred<void>(), createDeferred<void>()];
    const executionOrder: string[] = [];
    let active = 0;
    let maxActive = 0;
    const manager = new ThreadManager({
      generateThreadId: sequence("thread"),
      generateRunId: sequence("run"),
      generateTurnId: sequence("turn"),
      generateItemId: sequence("item"),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate() {
            const release = releases[executionOrder.length];

            if (!release) {
              throw new Error("missing model release gate");
            }

            executionOrder.push(turn.id);
            active += 1;
            maxActive = Math.max(maxActive, active);

            try {
              await release.promise;
              yield { type: "message.completed", content: turn.id };
            } finally {
              active -= 1;
            }
          }
        }
      })
    });
    const thread = manager.startThread();

    const first = manager.startTurn({ threadId: thread.id, input: "first" });
    const second = manager.startTurn({ threadId: thread.id, input: "second" });

    await waitForCondition(() => executionOrder.length >= 1);
    await Promise.resolve();
    await Promise.resolve();
    const orderBeforeFirstCompletes = [...executionOrder];

    releases[0]?.resolve();
    await waitForCondition(() => executionOrder.length === 2);
    releases[1]?.resolve();
    await Promise.all([first, second]);

    expect({ executionOrder, maxActive, orderBeforeFirstCompletes }).toEqual({
      executionOrder: ["turn-1", "turn-2"],
      maxActive: 1,
      orderBeforeFirstCompletes: ["turn-1"]
    });
  });

  it("runs turns from different threads concurrently", async () => {
    const release = createDeferred<void>();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const manager = new ThreadManager({
      generateThreadId: sequence("thread"),
      generateRunId: sequence("run"),
      generateTurnId: sequence("turn"),
      generateItemId: sequence("item"),
      clock: () => 1000,
      runtimeFactory: ({ thread, turn }) => ({
        model: {
          async *generate() {
            started.push(`${thread.id}:${turn.id}`);
            active += 1;
            maxActive = Math.max(maxActive, active);

            try {
              await release.promise;
              yield { type: "message.completed", content: turn.id };
            } finally {
              active -= 1;
            }
          }
        }
      })
    });
    const firstThread = manager.startThread();
    const secondThread = manager.startThread();

    const first = manager.startTurn({
      threadId: firstThread.id,
      input: "first thread"
    });
    const second = manager.startTurn({
      threadId: secondThread.id,
      input: "second thread"
    });

    await waitForCondition(() => started.length === 2);
    release.resolve();
    await Promise.all([first, second]);

    expect({ started, maxActive }).toEqual({
      started: ["thread-1:turn-1", "thread-2:turn-2"],
      maxActive: 2
    });
  });

  it("appends queued lifecycle items before execution", async () => {
    const release = createDeferred<void>();
    const manager = createManager({
      model: {
        async *generate() {
          await release.promise;
          yield { type: "message.completed", content: "done" };
        }
      }
    });
    const thread = manager.startThread();

    const first = manager.enqueueTurn({ threadId: thread.id, input: "first" });
    const second = manager.enqueueTurn({ threadId: thread.id, input: "second" });
    const queued = manager.readThread(thread.id);

    release.resolve();
    await waitForCondition(
      () =>
        manager.readThread(thread.id).turns.every((turn) => turn.status === "completed")
    );

    expect({ first, second, queued }).toEqual({
      first: {
        id: "turn-1",
        runId: "run-1",
        status: "queued",
        itemIds: ["item-1"]
      },
      second: {
        id: "turn-2",
        runId: "run-2",
        status: "queued",
        itemIds: ["item-2"]
      },
      queued: {
        id: "thread-1",
        status: "running",
        turns: [
          {
            id: "turn-1",
            runId: "run-1",
            status: "queued",
            itemIds: ["item-1"]
          },
          {
            id: "turn-2",
            runId: "run-2",
            status: "queued",
            itemIds: ["item-2"]
          }
        ],
        items: [
          expect.objectContaining({ id: "item-1", type: "turn.queued" }),
          expect.objectContaining({ id: "item-2", type: "turn.queued" })
        ]
      }
    });
  });

  it("runs a fake turn and emits item notifications in item sequence order", async () => {
    const events: string[] = [];
    const manager = createManager({
      model: {
        async *generate() {
          yield { type: "text.delta", text: "Hello" };
          yield { type: "message.completed", content: "Hello from fake model" };
        }
      }
    });

    manager.observe((event) => {
      if (event.type === "item/appended") {
        events.push(`${event.item.seq}:${event.item.type}`);
      }
    });

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: "Hello"
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn).toEqual({
      id: "turn-1",
      runId: "run-1",
      status: "completed",
      itemIds: snapshot.items.map((item) => item.id)
    });
    expect(snapshot.status).toBe("idle");
    expect(snapshot.turns).toEqual([turn]);
    expect(snapshot.items.map((item) => item.type)).toEqual([
      "turn.queued",
      "run.started",
      "turn.started",
      "user.message.completed",
      "model.request.started",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed",
      "model.request.completed",
      "turn.completed",
      "run.completed"
    ]);
    expect(events).toEqual(snapshot.items.map((item) => `${item.seq}:${item.type}`));
  });

  it("records a fake tool-call turn with ordered lifecycle notifications", async () => {
    const events: ThreadManagerEvent[] = [];
    let modelCalls = 0;
    const manager = createManager({
      model: {
        async *generate() {
          modelCalls += 1;

          if (modelCalls === 1) {
            yield {
              type: "message.completed",
              content: "Calling fake tool.",
              toolCalls: [{ id: "call-1", name: "fake-tool", input: { value: 1 } }]
            };
            return;
          }

          yield { type: "message.completed", content: "Tool returned." };
        }
      },
      toolRuntime: {
        async *execute(call) {
          expect(call).toEqual({
            id: "call-1",
            name: "fake-tool",
            input: { value: 1 }
          });
          yield { type: "output.delta", delta: "working" };
          yield { type: "result.completed", content: { ok: true } };
        }
      }
    });

    manager.observe((event) => events.push(event));

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: "Use the tool"
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn.status).toBe("completed");
    expect(snapshot.items.map((item) => item.type)).toEqual([
      "turn.queued",
      "run.started",
      "turn.started",
      "user.message.completed",
      "model.request.started",
      "assistant.message.started",
      "assistant.message.completed",
      "model.request.completed",
      "tool.call.started",
      "tool.output.delta",
      "tool.result.completed",
      "model.request.started",
      "assistant.message.started",
      "assistant.message.completed",
      "model.request.completed",
      "turn.completed",
      "run.completed"
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "thread/started",
      "item/appended",
      "item/appended",
      "turn/started",
      ...snapshot.items.slice(2).map(() => "item/appended"),
      "turn/completed"
    ]);
    expect(
      events
        .filter((event) => event.type === "item/appended")
        .map((event) => `${event.item.seq}:${event.item.type}`)
    ).toEqual(snapshot.items.map((item) => `${item.seq}:${item.type}`));
  });

  it("records failed model execution as a failed turn notification", async () => {
    const events: ThreadManagerEvent[] = [];
    const manager = createManager({
      model: {
        async *generate() {
          yield { type: "error", error: new Error("fake model failed") };
        }
      }
    });

    manager.observe((event) => events.push(event));

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: "Fail please"
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn.status).toBe("failed");
    expect(snapshot.status).toBe("failed");
    expect(snapshot.turns).toEqual([turn]);
    expect(snapshot.items.map((item) => item.type)).toContain(
      "assistant.message.error"
    );
    expect(snapshot.items.map((item) => item.type)).toContain("turn.failed");
    expect(snapshot.items.map((item) => item.type)).not.toContain(
      "turn.completed"
    );
    expect(turn.error).toEqual(
      readPayloadProperty(
        snapshot.items.find((item) => item.type === "turn.failed")?.payload,
        "error"
      )
    );
    expect(events.at(-1)).toEqual({
      type: "turn/failed",
      threadId: thread.id,
      turn,
      error: {
        code: "TURN_FAILED",
        message: "fake model failed",
        details: expect.objectContaining({
          message: "fake model failed"
        })
      }
    });
  });

  it("interrupts an active tool execution through the turn abort signal", async () => {
    const events: ThreadManagerEvent[] = [];
    const toolStarted = createDeferred<AbortSignal>();
    const toolAborted = createDeferred<void>();
    const manager = createManager({
      model: {
        async *generate() {
          yield {
            type: "message.completed",
            content: "Calling a long tool.",
            toolCalls: [{ id: "call-1", name: "fake-tool", input: {} }]
          };
        }
      },
      toolRuntime: {
        async *execute(_call, context) {
          if (!context.signal) {
            throw new Error("missing tool abort signal");
          }

          toolStarted.resolve(context.signal);
          context.signal.addEventListener("abort", () => toolAborted.resolve(), {
            once: true
          });
          yield { type: "output.delta", delta: "started" };
          await toolAborted.promise;
          yield { type: "error", error: new Error("fake tool canceled") };
        }
      }
    });

    manager.observe((event) => events.push(event));

    const thread = manager.startThread();
    const turnPromise = manager.startTurn({
      threadId: thread.id,
      input: "Use the tool"
    });
    const signal = await toolStarted.promise;

    expect(signal.aborted).toBe(false);

    const interruptSnapshot = manager.interruptTurn(thread.id);

    expect(interruptSnapshot.status).toBe("inProgress");
    await toolAborted.promise;

    const turn = await turnPromise;
    const snapshot = manager.readThread(thread.id);

    expect(turn.status).toBe("canceled");
    expect(snapshot.status).toBe("idle");
    expect(snapshot.items.map((item) => item.type)).toContain("tool.error");
    expect(snapshot.items.map((item) => item.type)).toContain("turn.canceled");
    expect(snapshot.items.map((item) => item.type)).not.toContain(
      "turn.completed"
    );
    expect(turn.error).toEqual(
      readPayloadProperty(
        snapshot.items.find((item) => item.type === "turn.canceled")?.payload,
        "error"
      )
    );
    expect(
      snapshot.items.find((item) => item.type === "tool.error")?.payload
    ).toEqual(expect.objectContaining({ message: "fake tool canceled" }));
    expect(events.at(-1)).toEqual({
      type: "turn/completed",
      threadId: thread.id,
      turn
    });
  });

  it("interrupts only the active turn and continues the thread queue", async () => {
    const firstStarted = createDeferred<AbortSignal>();
    const secondStarted = createDeferred<void>();
    const manager = new ThreadManager({
      generateThreadId: sequence("thread"),
      generateRunId: sequence("run"),
      generateTurnId: sequence("turn"),
      generateItemId: sequence("item"),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate(_context, _options, signal) {
            if (turn.id === "turn-1") {
              if (!signal) {
                throw new Error("missing model abort signal");
              }

              const aborted = createDeferred<void>();

              firstStarted.resolve(signal);
              signal.addEventListener("abort", () => aborted.resolve(), {
                once: true
              });
              await aborted.promise;
              throw new Error("first model canceled");
            }

            secondStarted.resolve();
            yield { type: "message.completed", content: "second completed" };
          }
        }
      })
    });
    const thread = manager.startThread();
    const first = manager.startTurn({ threadId: thread.id, input: "first" });

    await firstStarted.promise;

    const second = manager.enqueueTurn({
      threadId: thread.id,
      input: "second"
    });
    const interrupted = manager.interruptTurn(thread.id);
    const canceled = await first;

    await secondStarted.promise;
    await waitForCondition(
      () => manager.readThread(thread.id).turns.at(-1)?.status === "completed"
    );

    const snapshot = manager.readThread(thread.id);
    const lifecycle = snapshot.items
      .filter((item) => item.type.startsWith("turn."))
      .map((item) => `${item.turnId}:${item.type}`);

    expect({ interrupted, second, statuses: snapshot.turns.map((turn) => turn.status) }).toEqual({
      interrupted: expect.objectContaining({ id: "turn-1", status: "inProgress" }),
      second: expect.objectContaining({ id: "turn-2", status: "queued" }),
      statuses: ["canceled", "completed"]
    });
    expect(canceled.status).toBe("canceled");
    expect(lifecycle.indexOf("turn-1:turn.canceled")).toBeLessThan(
      lifecycle.indexOf("turn-2:turn.started")
    );
  });

  it("keeps completion authoritative when interrupt races its lifecycle item", async () => {
    const manager = createManager();
    let interrupted: ReturnType<ThreadManager["interruptTurn"]> | undefined;

    manager.observe((event) => {
      if (
        event.type === "item/appended" &&
        event.item.type === "turn.completed"
      ) {
        interrupted = manager.interruptTurn(event.threadId);
      }
    });

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: "complete despite the late interrupt"
    });
    const snapshot = manager.readThread(thread.id);

    expect({ interrupted, turn, status: snapshot.status }).toEqual({
      interrupted: expect.objectContaining({ status: "completed" }),
      turn: expect.objectContaining({ status: "completed" }),
      status: "idle"
    });
    expect(snapshot.items.map((item) => item.type)).not.toContain(
      "turn.canceled"
    );
  });

  it("enqueues retries at the tail with the original user input", async () => {
    const secondRelease = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const executionOrder: string[] = [];
    const manager = new ThreadManager({
      generateThreadId: sequence("thread"),
      generateRunId: sequence("run"),
      generateTurnId: sequence("turn"),
      generateItemId: sequence("item"),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate() {
            executionOrder.push(turn.id);

            if (turn.id === "turn-1") {
              yield { type: "error", error: new Error("retryable") };
              return;
            }

            if (turn.id === "turn-2") {
              secondStarted.resolve();
              await secondRelease.promise;
            }

            yield { type: "message.completed", content: turn.id };
          }
        }
      })
    });
    const thread = manager.startThread();
    const failed = await manager.startTurn({
      threadId: thread.id,
      input: "original input"
    });
    const blocking = manager.startTurn({
      threadId: thread.id,
      input: "blocking input"
    });

    await secondStarted.promise;

    const retry = manager.retryTurn({
      threadId: thread.id,
      turnId: failed.id
    });
    const queued = manager.readThread(thread.id);

    secondRelease.resolve();
    await blocking;
    await waitForCondition(
      () => manager.readThread(thread.id).turns.at(-1)?.status === "completed"
    );

    const snapshot = manager.readThread(thread.id);

    expect({ retry, queuedStatuses: queued.turns.map((turn) => turn.status) }).toEqual({
      retry: expect.objectContaining({ id: "turn-3", status: "queued" }),
      queuedStatuses: ["failed", "inProgress", "queued"]
    });
    expect(executionOrder).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(
      snapshot.items
        .filter((item) => item.type === "user.message.completed")
        .map((item) => item.payload)
    ).toEqual([
      { content: "original input" },
      { content: "blocking input" },
      { content: "original input" }
    ]);
  });

  it("repairs queued and running turns from items while ignoring snapshot lifecycle fields", () => {
    const manager = new ThreadManager({
      generateItemId: sequence("repair-item"),
      clock: () => 2000,
      initialThreads: [
        {
          id: "thread-1",
          status: "idle",
          turns: [],
          items: [
            {
              id: "item-1",
              type: "turn.queued",
              createdAtMs: 1000,
              seq: 1,
              runId: "run-1",
              turnId: "turn-1",
              visibility: "trace",
              payload: { input: "queued input" }
            },
            {
              id: "item-2",
              type: "turn.queued",
              createdAtMs: 1000,
              seq: 2,
              runId: "run-2",
              turnId: "turn-2",
              visibility: "trace",
              payload: { input: "running input" }
            },
            {
              id: "item-3",
              type: "turn.started",
              createdAtMs: 1000,
              seq: 3,
              runId: "run-2",
              turnId: "turn-2",
              visibility: "trace",
              payload: {}
            }
          ]
        }
      ]
    });

    const snapshot = manager.readThread("thread-1");

    expect(snapshot.status).toBe("failed");
    expect(snapshot.turns).toEqual([
      {
        id: "turn-1",
        runId: "run-1",
        status: "failed",
        itemIds: ["item-1", "repair-item-1"],
        error: {
          code: "TURN_REPAIRED_ON_STARTUP",
          message: "Turn was still in progress when the previous process stopped"
        }
      },
      {
        id: "turn-2",
        runId: "run-2",
        status: "failed",
        itemIds: ["item-2", "item-3", "repair-item-2"],
        error: {
          code: "TURN_REPAIRED_ON_STARTUP",
          message: "Turn was still in progress when the previous process stopped"
        }
      }
    ]);
    expect(
      snapshot.items
        .filter((item) => item.type === "turn.repaired")
        .map((item) => readPayloadProperty(item.payload, "previousStatus"))
    ).toEqual(["queued", "inProgress"]);
  });
});

function createManager(
  options: {
    readonly model?: ModelGateway;
    readonly toolRuntime?: ToolRuntime;
  } = {}
): ThreadManager {
  return new ThreadManager({
    generateThreadId: sequence("thread"),
    generateRunId: sequence("run"),
    generateTurnId: sequence("turn"),
    generateItemId: sequence("item"),
    clock: () => 1000,
    runtimeFactory: () => ({
      model:
        options.model ??
        ({
          async *generate() {
            yield { type: "message.completed", content: "default fake response" };
          }
        } satisfies ModelGateway),
      toolRuntime: options.toolRuntime
    })
  });
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("Timed out waiting for condition");
}

function readPayloadProperty(payload: unknown, key: string): unknown {
  if (typeof payload === "object" && payload !== null && key in payload) {
    return payload[key as keyof typeof payload];
  }

  return undefined;
}
