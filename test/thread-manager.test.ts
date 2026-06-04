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
      "turn/started",
      ...snapshot.items.map(() => "item/appended"),
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
    expect(
      snapshot.items.find((item) => item.type === "tool.error")?.payload
    ).toEqual(expect.objectContaining({ message: "fake tool canceled" }));
    expect(events.at(-1)).toEqual({
      type: "turn/completed",
      threadId: thread.id,
      turn
    });
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
