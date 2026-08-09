import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppServerManager } from "../src/main/app-server-manager.js";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";

test("timer expiry creates one explicit App Server turn and auditable history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-trigger-"));
  const manager = managerFor(directory);
  try {
    await manager.start();
    const thread = (await manager.request("thread/start", {})).thread;
    const triggers = new ZenXTriggerService(
      manager,
      new ZenXTriggerStore(path.join(directory, "triggers.json")),
    );
    await triggers.start();
    await triggers.create({
      threadId: thread.id,
      kind: "timer",
      label: "Heartbeat",
      prompt: "Inspect the release and report only risks.",
      runAt: Date.now() + 40,
    });
    const completed = await snapshotWhen(
      triggers,
      (snapshot) => snapshot.history[0]?.status === "completed",
    );
    const entry = completed.history[0];
    assert.equal(entry?.kind, "timer");
    assert.equal(entry?.error, null);
    const read = await manager.request("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    const wakeup = read.thread.turns
      .flatMap((turn) => turn.items)
      .find(
        (item) =>
          item.type === "userMessage" &&
          item.clientId === entry?.clientUserMessageId,
      );
    assert.equal(wakeup?.type, "userMessage");
    if (wakeup?.type === "userMessage")
      assert.match(
        wakeup.content[0]?.text ?? "",
        /\[ZenX trigger wakeup\].*Injected prompt/su,
      );
    triggers.stop();
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("thread events, Room mentions, and signals route only through target Threads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-routing-"));
  const manager = managerFor(directory);
  try {
    await manager.start();
    const source = (await manager.request("thread/start", {})).thread;
    const target = (await manager.request("thread/start", {})).thread;
    const triggers = new ZenXTriggerService(
      manager,
      new ZenXTriggerStore(path.join(directory, "triggers.json")),
    );
    await triggers.start();
    const room = await triggers.createRoom({
      name: "release",
      members: [{ name: "Monitor", threadId: target.id }],
    });
    await triggers.create({
      threadId: target.id,
      kind: "thread",
      label: "Review source",
      prompt: "Review the completed turn.",
      watchedThreadId: source.id,
    });
    await triggers.create({
      threadId: target.id,
      kind: "roomMention",
      label: "Answer Room",
      prompt: "Answer the Room question.",
      roomId: room.id,
      mention: "Monitor",
    });
    await triggers.create({
      threadId: target.id,
      kind: "signal",
      label: "Deploy signal",
      prompt: "Inspect the deploy signal.",
      signalName: "deploy",
    });
    await manager.request("turn/start", {
      threadId: source.id,
      input: [{ type: "text", text: "source work" }],
    });
    await snapshotWhen(triggers, (snapshot) =>
      snapshot.history.some(
        (entry) => entry.kind === "thread" && entry.status === "completed",
      ),
    );
    await triggers.postRoomMessage(room.id, "You", "@Monitor status?");
    await snapshotWhen(triggers, (snapshot) =>
      snapshot.history.some(
        (entry) => entry.kind === "roomMention" && entry.status === "completed",
      ),
    );
    await triggers.signal("deploy", "production completed");
    const final = await snapshotWhen(triggers, (snapshot) =>
      snapshot.history.some(
        (entry) => entry.kind === "signal" && entry.status === "completed",
      ),
    );
    assert(
      final.rooms[0]?.messages.some(
        (message) =>
          message.kind === "agent" && message.originThreadId === target.id,
      ),
    );
    const targetRead = await manager.request("thread/read", {
      threadId: target.id,
      includeTurns: true,
    });
    assert.equal(targetRead.thread.turns.length, 3);
    triggers.stop();
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function managerFor(directory: string): AppServerManager {
  return new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "token"),
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
}

async function snapshotWhen(
  service: ZenXTriggerService,
  predicate: (snapshot: ReturnType<ZenXTriggerService["snapshot"]>) => boolean,
) {
  const current = service.snapshot();
  if (predicate(current)) return current;
  return await new Promise<ReturnType<ZenXTriggerService["snapshot"]>>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        dispose();
        reject(new Error("Timed out waiting for trigger"));
      }, 10_000);
      const dispose = service.onChange((snapshot) => {
        if (predicate(snapshot)) {
          clearTimeout(timeout);
          dispose();
          resolve(snapshot);
        }
      });
    },
  );
}
