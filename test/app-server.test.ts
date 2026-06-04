import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AppServer,
  type AppServerNotification,
  createOpenClawAppServer,
  FileThreadStore,
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
    await waitForNotification(
      notifications,
      (notification) => notification.type === "turn/completed"
    );

    unsubscribe();

    expect(turn).toEqual({
      method: "turn/start",
      ok: true,
      result: {
        turn: expect.objectContaining({
          id: "turn-1",
          runId: "run-1",
          status: "inProgress"
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

  it("retries a failed turn by appending a new turn with the same user input", async () => {
    let modelCalls = 0;
    const notifications: AppServerNotification[] = [];
    const server = createServer({
      model: {
        async *generate() {
          modelCalls += 1;

          if (modelCalls === 1) {
            yield { type: "error", error: new Error("transient model failure") };
            return;
          }

          yield { type: "message.completed", content: "Recovered response" };
        }
      }
    });
    server.subscribe((notification) => notifications.push(notification));
    const start = await server.request({ method: "thread/start" });

    if (!start.ok || start.method !== "thread/start") {
      throw new Error("thread/start failed");
    }

    await server.request({
      method: "turn/start",
      params: {
        threadId: start.result.thread.id,
        input: "please retry me"
      }
    });
    await waitForNotification(
      notifications,
      (notification) => notification.type === "turn/failed"
    );

    const retry = await server.request({
      method: "turn/retry",
      params: {
        threadId: start.result.thread.id,
        turnId: "turn-1"
      }
    });
    await waitForNotification(
      notifications,
      (notification) =>
        notification.type === "turn/completed" && notification.turn.id === "turn-2"
    );

    expect(retry).toEqual({
      method: "turn/retry",
      ok: true,
      result: {
        turn: expect.objectContaining({
          id: "turn-2",
          runId: "run-2",
          status: "inProgress"
        })
      }
    });

    const read = await server.request({
      method: "thread/read",
      params: { threadId: start.result.thread.id }
    });

    if (!read.ok || read.method !== "thread/read") {
      throw new Error("thread/read failed");
    }

    expect(read.result.thread.turns.map((turn) => turn.status)).toEqual([
      "failed",
      "completed"
    ]);
    expect(
      read.result.thread.items
        .filter((item) => item.type === "user.message.completed")
        .map((item) => item.payload)
    ).toEqual([
      { content: "please retry me" },
      { content: "please retry me" }
    ]);
    expect(read.result.thread.items.map((item) => item.type)).toContain(
      "assistant.message.error"
    );
  });

  it("repairs stale in-progress turns from persisted startup snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zen-startup-repair-"));
    const path = join(dir, "thread-1.json");
    const store = new FileThreadStore({ dir });
    const staleThread = {
      id: "thread-1",
      status: "running" as const,
      turns: [
        {
          id: "turn-1",
          runId: "run-1",
          status: "inProgress" as const,
          itemIds: ["item-1"]
        }
      ],
      items: [
        {
          id: "item-1",
          type: "turn.started",
          createdAtMs: 1000,
          seq: 1,
          runId: "run-1",
          turnId: "turn-1",
          payload: {}
        }
      ]
    };

    await writeFile(
      path,
      `${JSON.stringify({ schemaVersion: 1, thread: staleThread }, null, 2)}\n`,
      "utf8"
    );
    await expect(store.list()).resolves.toEqual([staleThread]);

    const server = await createOpenClawAppServer({
      threadStore: store,
      appServerOptions: {
        threadManagerOptions: {
          generateItemId: sequence("repair-item"),
          clock: () => 2000
        }
      }
    });

    const list = await server.request({ method: "thread/list" });

    expect(list).toEqual({
      method: "thread/list",
      ok: true,
      result: {
        threads: [
          expect.objectContaining({
            id: "thread-1",
            status: "failed",
            turns: [
              expect.objectContaining({
                id: "turn-1",
                status: "failed",
                itemIds: ["item-1", "repair-item-1"],
                error: {
                  code: "TURN_REPAIRED_ON_STARTUP",
                  message:
                    "Turn was still in progress when the previous process stopped"
                }
              })
            ],
            items: [
              expect.objectContaining({ id: "item-1", type: "turn.started" }),
              expect.objectContaining({
                id: "repair-item-1",
                type: "turn.repaired",
                createdAtMs: 2000,
                seq: 2,
                payload: {
                  previousStatus: "inProgress",
                  status: "failed",
                  reason:
                    "Turn was still in progress when the previous process stopped"
                }
              })
            ]
          })
        ]
      }
    });
    await expect(readFile(path, "utf8").then(JSON.parse)).resolves.toEqual({
      schemaVersion: 1,
      thread: expect.objectContaining({
        id: "thread-1",
        status: "failed",
        turns: [
          expect.objectContaining({
            id: "turn-1",
            status: "failed",
            itemIds: ["item-1", "repair-item-1"]
          })
        ],
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "repair-item-1",
            type: "turn.repaired"
          })
        ])
      })
    });
  });
});

async function waitForNotification(
  notifications: readonly AppServerNotification[],
  predicate: (notification: AppServerNotification) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (notifications.some(predicate)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Timed out waiting for notification");
}

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
