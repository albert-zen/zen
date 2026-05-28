import { describe, expect, it } from "vitest";

import {
  AppServer,
  type AppServerNotification,
  type ModelGateway
} from "../src/index.js";

describe("AppServer", () => {
  it("dispatches thread/start and thread/read through the public request API", async () => {
    const server = createServer();

    const start = await server.request({ method: "thread/start" });

    expect(start).toEqual({
      method: "thread/start",
      ok: true,
      result: {
        thread: {
          id: "thread-1",
          status: "idle",
          turns: [],
          items: []
        }
      }
    });

    if (!start.ok || start.method !== "thread/start") {
      throw new Error("thread/start failed");
    }
    const thread = start.result.thread;

    await expect(
      server.request({
        method: "thread/read",
        params: { threadId: thread.id }
      })
    ).resolves.toEqual({
      method: "thread/read",
      ok: true,
      result: { thread }
    });
  });

  it("dispatches turn/start and returns ordered notifications to subscribers", async () => {
    const notifications: AppServerNotification[] = [];
    const server = createServer({
      model: {
        async *generate() {
          yield { type: "message.completed", content: "Hello from server" };
        }
      }
    });

    const unsubscribe = server.subscribe((notification) => {
      notifications.push(notification);
    });
    const start = await server.request({ method: "thread/start" });

    if (!start.ok || start.method !== "thread/start") {
      throw new Error("thread/start failed");
    }

    const turn = await server.request({
      method: "turn/start",
      params: {
        threadId: start.result.thread.id,
        input: "Hello"
      }
    });

    unsubscribe();

    expect(turn).toEqual({
      method: "turn/start",
      ok: true,
      result: {
        turn: expect.objectContaining({
          id: "turn-1",
          runId: "run-1",
          status: "completed"
        })
      }
    });
    expect(notifications.map((notification) => notification.type)).toEqual([
      "thread/started",
      "turn/started",
      "item/appended",
      "item/appended",
      "item/appended",
      "item/appended",
      "item/appended",
      "item/appended",
      "item/appended",
      "item/appended",
      "item/appended",
      "turn/completed"
    ]);
    expect(
      notifications
        .filter((notification) => notification.type === "item/appended")
        .map((notification) => notification.item.type)
    ).toEqual([
      "run.started",
      "turn.started",
      "user.message.completed",
      "model.request.started",
      "assistant.message.started",
      "assistant.message.completed",
      "model.request.completed",
      "turn.completed",
      "run.completed"
    ]);
  });

  it("returns typed errors for unknown and invalid requests", async () => {
    const server = createServer();

    await expect(
      server.request({ method: "unknown/method", params: {} })
    ).resolves.toEqual({
      method: "unknown/method",
      ok: false,
      error: {
        code: "UNKNOWN_METHOD",
        message: "Unknown App Server method: unknown/method"
      }
    });
    await expect(
      server.request({
        method: "thread/read",
        params: { threadId: "missing-thread" }
      })
    ).resolves.toEqual({
      method: "thread/read",
      ok: false,
      error: {
        code: "REQUEST_FAILED",
        message: "Unknown thread: missing-thread"
      }
    });
  });
});

function createServer(options: { readonly model?: ModelGateway } = {}): AppServer {
  return new AppServer({
    threadManagerOptions: {
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
              yield { type: "message.completed", content: "default response" };
            }
          } satisfies ModelGateway)
      })
    }
  });
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}
