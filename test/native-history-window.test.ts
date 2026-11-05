import assert from "node:assert/strict";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { historyWindowFixture } from "./thread-history-window-fixture.js";

async function fixture(count: number) {
  const journal = new InMemoryThreadJournal();
  await journal.create(historyWindowFixture(count));
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: "/tmp/unused-native-history-window",
    model: "fake",
    models: ["fake"],
    provider: { type: "fake" },
    journal,
    approvalPolicy: "never",
  });
  const recovery = new NativeRecoveryProjection(host);
  return {
    host,
    recovery,
    async close() {
      recovery.close();
      await host.closeProviderTransport();
    },
  };
}

test("production native recovery bounds 256/1200-Turn JSON and preserves full audit compatibility", async () => {
  const bytes: number[] = [];
  for (const count of [256, 1200]) {
    const f = await fixture(count);
    try {
      const resume = await f.recovery.resume("thread", true);
      bytes.push(Buffer.byteLength(JSON.stringify(resume)));
      assert.equal(resume.thread.turns.length, 20);
      assert.equal(resume.thread.itemList, undefined);
      assert.deepEqual(resume.events, []);
      const raw = await f.recovery.read("thread");
      assert.equal(raw.turns.length, count);
      assert.deepEqual(raw.items, historyWindowFixture(count));
      assert(raw.itemList!.length > resume.thread.items.length);
    } finally {
      await f.close();
    }
  }
  assert(
    bytes.every((count) => count < 500 * 1024),
    JSON.stringify(bytes),
  );
  assert(bytes[1]! <= bytes[0]! * 1.25, JSON.stringify(bytes));
  console.log("native history window JSON bytes (256 / 1200)", bytes);
});

test("window recovery keeps a running Turn, live overlap and repeated earlier reads without changing subscriptions", async () => {
  const f = await fixture(45);
  try {
    const baseline = await f.recovery.resume("thread", true);
    const cursor = baseline.thread.history!.before!;
    const prior = await f.recovery.history("thread", { before: cursor });
    const handle = await f.host.startTurn("thread", "new live input");
    const overlapping = await f.recovery.resume("thread", true);
    assert(
      overlapping.thread.turns.some((turn) => turn.id === handle.id) ||
        overlapping.events.some(
          ({ event }) => "turnId" in event && event.turnId === handle.id,
        ),
    );
    await handle.done;
    const again = await f.recovery.history("thread", { before: cursor });
    assert.deepEqual(again.turns, prior.turns);
    const reconnect = new NativeRecoveryProjection(f.host);
    try {
      assert.notEqual(reconnect.processEpoch, baseline.processEpoch);
      const nextEpoch = await reconnect.resume("thread", true);
      assert.equal(nextEpoch.thread.turns.at(-1)?.status, "completed");
      assert.deepEqual(
        (await reconnect.history("thread", { before: cursor })).turns,
        prior.turns,
      );
    } finally {
      reconnect.close();
    }
  } finally {
    await f.close();
  }
});

test("native window/history wire uses explicit methods; malformed cursor fails and original read remains full", async () => {
  const f = await fixture(45);
  const messages: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    projection: f.recovery,
    appServer: f.host,
    send: (message) => messages.push(message),
    isInitialized: () => true,
  });
  try {
    await connection.receive({
      id: 1,
      method: "zen/thread/resume-window",
      params: { threadId: "thread" },
    });
    const first = messages.find(
      (message) => "id" in message && message.id === 1,
    );
    assert(first && "result" in first);
    const recovery = first.result as Awaited<
      ReturnType<NativeRecoveryProjection["resume"]>
    >;
    assert.equal(recovery.thread.turns.length, 20);
    await connection.receive({
      id: 2,
      method: "zen/thread/history",
      params: { threadId: "thread", before: recovery.thread.history!.before },
    });
    const second = messages.find(
      (message) => "id" in message && message.id === 2,
    );
    assert(second && "result" in second);
    assert.equal(
      (second.result as { thread: { turns: unknown[] } }).thread.turns.length,
      20,
    );
    await connection.receive({
      id: 3,
      method: "zen/thread/history",
      params: { threadId: "thread", before: "bad" },
    });
    assert(
      messages.some(
        (message) => "id" in message && message.id === 3 && "error" in message,
      ),
    );
    await connection.receive({
      id: 4,
      method: "zen/thread/read",
      params: { threadId: "thread" },
    });
    const full = messages.find(
      (message) => "id" in message && message.id === 4,
    );
    assert(full && "result" in full);
    assert.equal(
      (full.result as { thread: { turns: unknown[] } }).thread.turns.length,
      45,
    );
  } finally {
    connection.close();
    await f.close();
  }
});
