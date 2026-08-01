import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppServerManager } from "../src/main/app-server-manager.js";
import type { Thread } from "../src/protocol-client/index.js";
import { applyThreadViewNotification } from "../src/renderer/src/thread-view-state.js";

test("projects a streamed tool turn from the hosted App Server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-view-"));
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const started = await manager.request("thread/start", {});
    let projected: Thread = started.thread;
    const complete = deferred<void>();
    const dispose = manager.onNotification((method, params) => {
      projected = applyThreadViewNotification(projected, method, params);
      if (method === "turn/completed") complete.resolve();
    });

    await manager.request("turn/start", {
      threadId: projected.id,
      input: [{ type: "text", text: "!shell printf zenx-stream" }],
    });
    await within(complete.promise);
    dispose();

    const currentTurn = projected.turns.at(-1);
    assert.equal(currentTurn?.status, "completed");
    const command = currentTurn?.items.find(
      (item) => item.type === "commandExecution",
    );
    assert.equal(command?.status, "completed");
    assert.equal(command?.aggregatedOutput, "zenx-stream");
    assert(
      currentTurn?.items.some(
        (item) => item.type === "agentMessage" && item.text.length > 0,
      ),
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds = 10_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for turn/completed")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
