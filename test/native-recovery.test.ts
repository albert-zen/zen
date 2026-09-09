import assert from "node:assert/strict";
import test from "node:test";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import { serveCodexWebSocket } from "../src/protocol/codex/websocket.js";
import { WebSocket } from "ws";

test("native recovery returns one epoch, a thread watermark, and projected active deltas", async () => {
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: "/tmp/unused-native-recovery",
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
  });
  const recovery = new NativeRecoveryProjection(host, {
    processEpoch: "epoch-a",
  });
  try {
    const thread = await host.startThread();
    const completed = host.startTurn(thread.id, "stream this");
    const first = await recovery.resume(thread.id);
    const handle = await completed;
    await handle.done;
    const second = await recovery.resume(thread.id);

    assert.equal(first.processEpoch, "epoch-a");
    assert.equal(second.processEpoch, first.processEpoch);
    assert(second.watermark >= first.watermark);
    assert.equal(second.thread.turns[0]?.status, "completed");
    assert(second.events.every((event) => event.watermark <= second.watermark));
    assert.deepEqual(
      second.events.map(({ watermark }) => watermark),
      [...second.events.map(({ watermark }) => watermark)].sort(
        (a, b) => a - b,
      ),
    );
  } finally {
    recovery.close();
    await host.closeProviderTransport();
  }
});

test("native resume replies before replaying only events newer than its watermark", async () => {
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: "/tmp/unused-native-recovery-wire",
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
  });
  const thread = await host.startThread();
  const server = await serveCodexWebSocket({
    appServer: host,
    zenHome: "/tmp/unused-native-recovery-wire-home",
    listen: "ws://127.0.0.1:0",
    processEpoch: "wire-epoch",
  });
  const socket = new WebSocket(server.url);
  const messages: Array<Record<string, unknown>> = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        id: 1,
        method: "zen/thread/resume",
        params: { threadId: thread.id },
      }),
    );
    await waitFor(() => messages.some((message) => message.id === 1));
    const response = messages.find((message) => message.id === 1)!;
    const result = response.result as {
      processEpoch: string;
      watermark: number;
    };
    assert.equal(result.processEpoch, "wire-epoch");

    const handle = await host.startTurn(thread.id, "after resume");
    await handle.done;
    await waitFor(() =>
      messages.some((message) => message.method === "zen/thread/event"),
    );
    const events = messages
      .filter((message) => message.method === "zen/thread/event")
      .map(
        (message) =>
          message.params as { processEpoch: string; watermark: number },
      );
    assert(events.every((event) => event.processEpoch === result.processEpoch));
    assert(events.every((event) => event.watermark > result.watermark));
  } finally {
    socket.close();
    await server.close();
    await host.closeProviderTransport();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for wire event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("native recovery starts a new watermark namespace for a new process epoch", async () => {
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: "/tmp/unused-native-recovery-epoch",
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
  });
  const first = new NativeRecoveryProjection(host, { processEpoch: "epoch-a" });
  first.close();
  const second = new NativeRecoveryProjection(host, {
    processEpoch: "epoch-b",
  });
  try {
    const thread = await host.startThread();
    const snapshot = await second.resume(thread.id);
    assert.equal(snapshot.processEpoch, "epoch-b");
    assert.equal(snapshot.watermark, 1);
  } finally {
    second.close();
    await host.closeProviderTransport();
  }
});
