import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AppServer, FileThreadStore, type ModelGateway } from "../src/index.js";

describe("FileThreadStore", () => {
  it("writes new snapshots with an explicit schema version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zen-threads-"));
    const store = new FileThreadStore({ dir });

    await store.save(threadSnapshot("thread-1"));

    await expect(
      readFile(join(dir, "thread-1.json"), "utf8").then(JSON.parse)
    ).resolves.toEqual({
      schemaVersion: 1,
      thread: expect.objectContaining({ id: "thread-1" })
    });
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: "thread-1" })
    ]);
  });

  it("keeps existing unversioned thread files readable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zen-threads-"));
    const legacyThread = threadSnapshot("legacy-thread");

    await writeFile(
      join(dir, "legacy-thread.json"),
      `${JSON.stringify(legacyThread, null, 2)}\n`,
      "utf8"
    );

    await expect(new FileThreadStore({ dir }).list()).resolves.toEqual([
      legacyThread
    ]);
  });

  it("skips corrupt thread files when listing other threads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zen-threads-"));

    await writeFile(join(dir, "corrupt.json"), "{", "utf8");
    await writeFile(
      join(dir, "valid-thread.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        thread: threadSnapshot("valid-thread")
      })}\n`,
      "utf8"
    );

    await expect(new FileThreadStore({ dir }).list()).resolves.toEqual([
      expect.objectContaining({ id: "valid-thread" })
    ]);
  });

  it("persists App Server threads and reloads them for resume", async () => {
    const store = new FileThreadStore({
      dir: mkdtempSync(join(tmpdir(), "zen-threads-"))
    });
    const first = new AppServer({
      threadStore: store,
      threadManagerOptions: {
        generateThreadId: sequence("thread"),
        generateRunId: sequence("run"),
        generateTurnId: sequence("turn"),
        generateItemId: sequence("item"),
        clock: () => 1000,
        runtimeFactory: () => ({
          model: {
            async *generate() {
              yield { type: "message.completed", content: "persisted" };
            }
          } satisfies ModelGateway
        })
      }
    });
    const start = await first.request({ method: "thread/start" });

    if (!start.ok || start.method !== "thread/start") {
      throw new Error("thread did not start");
    }

    await first.request({
      method: "turn/start",
      params: { threadId: start.result.thread.id, input: "save me" }
    });
    await waitForStore(store);

    const second = new AppServer({
      threadStore: store,
      threadManagerOptions: {
        initialThreads: await store.list(),
        generateRunId: sequence("run"),
        generateTurnId: sequence("turn"),
        generateItemId: sequence("item"),
        clock: () => 2000,
        runtimeFactory: () => ({
          model: {
            async *generate() {
              yield { type: "message.completed", content: "resumed" };
            }
          } satisfies ModelGateway
        })
      }
    });
    const list = await second.request({ method: "thread/list" });

    expect(list).toEqual({
      method: "thread/list",
      ok: true,
      result: {
        threads: [
          expect.objectContaining({
            id: "thread-1",
            items: expect.arrayContaining([
              expect.objectContaining({
                type: "assistant.message.completed",
                payload: { content: "persisted" }
              })
            ])
          })
        ]
      }
    });

    await second.request({
      method: "turn/start",
      params: { threadId: "thread-1", input: "continue" }
    });
    await waitForStoredContent(store, "resumed");
    const [resumed] = await store.list();
    const itemIds = resumed?.items.map((item) => item.id) ?? [];

    expect(new Set(itemIds).size).toBe(itemIds.length);
    expect(resumed?.turns.map((turn) => turn.id)).toEqual(["turn-1", "turn-2"]);
  });
});

async function waitForStore(store: FileThreadStore): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const threads = await store.list();

    if (threads.some((thread) => thread.items.some((item) => item.type === "run.completed"))) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Timed out waiting for store");
}

async function waitForStoredContent(
  store: FileThreadStore,
  content: string
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const threads = await store.list();

    if (
      threads.some((thread) =>
        thread.items.some(
          (item) =>
            item.type === "assistant.message.completed" &&
            typeof item.payload === "object" &&
            item.payload !== null &&
            "content" in item.payload &&
            item.payload.content === content
        )
      )
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Timed out waiting for stored content");
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

function threadSnapshot(id: string) {
  return {
    id,
    status: "idle" as const,
    turns: [],
    items: []
  };
}
