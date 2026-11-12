import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AppServerManager } from "../src/main/app-server-manager.js";
import type { ModelRequestDebugSummary } from "../../cli/src/model-request-debug-types.js";
function managerFor(directory: string) {
  return new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(directory, "runtime", "token"),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10000,
  });
}
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10000;
  while (true) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error("Synthetic Host turn did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test("real owned Host IPC reads always-on evidence after complete child restart with no capture toggle", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "zenx-trace-ipc-restart-"),
  );
  let manager = managerFor(directory);
  try {
    await manager.start();
    const started = await manager.request("thread/start", { cwd: directory });
    const threadId = started.thread.id;
    await manager.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Synthetic restart evidence" }],
    });
    await waitFor(async () => {
      const snapshot = await manager.request("zen/thread/resume", { threadId });
      return snapshot.thread.turns.length &&
        snapshot.thread.turns.every((t) => t.status !== "inProgress")
        ? snapshot
        : undefined;
    });
    const index = await manager.modelRequestDebug({ action: "list", threadId });
    const record = index.records?.find(
      (r) => r.type === "model_input",
    ) as ModelRequestDebugSummary;
    assert(
      record,
      "Fake adapter produces honest adapter input, not fabricated HTTP",
    );
    const artifact = (
      await manager.modelRequestDebug({
        action: "read",
        threadId,
        id: record.id,
        view: "artifact",
      })
    ).page!;
    assert.equal(artifact.availability, "available");
    assert.match(artifact.text, /Synthetic restart evidence/u);
    const wire = (
      await manager.modelRequestDebug({
        action: "read",
        threadId,
        id: record.id,
        view: "payload",
      })
    ).page!;
    assert.equal(wire.availability, "unavailable");
    const live = await manager.request("zen/thread/resume", { threadId });
    assert(
      live.thread.itemList?.some(
        (item) =>
          item.role === "user" &&
          item.kind === "message" &&
          item.content.text.includes("Synthetic restart evidence"),
      ),
    );
    const oldPid = manager.processId;
    await manager.stop();
    manager = managerFor(directory);
    await manager.start();
    assert.notEqual(manager.processId, oldPid);
    const cold = (
      await manager.modelRequestDebug({
        action: "read",
        threadId,
        id: record.id,
        view: "artifact",
      })
    ).page!;
    assert.equal(cold.record.id, record.id);
    assert.equal(cold.text, artifact.text);
    assert.notEqual(cold.record.sampleOutcome, "unknown");
    assert.equal(cold.record.dispatch, "not-applicable");
    assert.deepEqual(
      (await manager.request("zen/thread/resume", { threadId })).thread
        .itemList,
      live.thread.itemList,
    );
    assert.equal(
      (
        await manager.modelRequestDebug({
          action: "read",
          threadId,
          id: record.id,
          view: "payload",
        })
      ).page!.availability,
      "unavailable",
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
