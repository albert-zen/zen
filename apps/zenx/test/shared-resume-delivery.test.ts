import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createHostedAppServer } from "../../../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import type { NativeProjectedThreadEvent } from "../../../src/protocol/native/recovery.js";
import { ZenXProtocolClient } from "../src/protocol-client/index.js";
import {
  applyNativeThreadEvent,
  projectNativeRecovery,
} from "../src/renderer/src/thread-view-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const options = (url: string) => ({
  url,
  clientInfo: {
    name: "shared-resume-test",
    title: "Shared resume test",
    version: "1",
  },
});
function event(
  watermark: number,
  threadId = "thread",
  processEpoch = "epoch",
): NativeProjectedThreadEvent {
  return {
    threadId,
    processEpoch,
    watermark,
    event: { type: "thread_name_updated", threadId, name: String(watermark) },
  };
}
function recovery(
  events: NativeProjectedThreadEvent[] = [],
  threadId = "thread",
  processEpoch = "epoch",
) {
  return {
    threadId,
    processEpoch,
    thread: { id: threadId },
    watermark: events.at(-1)?.watermark ?? 0,
    events,
  };
}
async function fixture(
  run: (
    client: ZenXProtocolClient,
    wire: {
      next: () => Promise<{ id: number; params: { threadId: string } }>;
      send: (message: unknown) => void;
    },
  ) => Promise<void>,
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  let socket!: WebSocket;
  const requests: { id: number; params: { threadId: string } }[] = [];
  let available = deferred<void>();
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (data) => {
      const request = JSON.parse(data.toString());
      if (request.method === "zen/thread/resume") {
        requests.push(request);
        available.resolve();
      } else if (request.id !== undefined) {
        connected.send(
          JSON.stringify({
            id: request.id,
            result:
              request.method === "zen/initialize"
                ? { processEpoch: "epoch" }
                : {},
          }),
        );
      }
    });
  });
  const client = await ZenXProtocolClient.connect(
    options(`ws://127.0.0.1:${address.port}`),
  );
  try {
    await run(client, {
      next: async () => {
        while (requests.length === 0) await available.promise;
        const request = requests.shift()!;
        if (requests.length === 0) available = deferred<void>();
        return request;
      },
      send: (message) => socket.send(JSON.stringify(message)),
    });
  } finally {
    client.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test(
  "all shared consumers receive overlap before post-watermark frames and promise settlement, without waiting for async consumers",
  { timeout: 5000 },
  async () => {
    await fixture(async (client, wire) => {
      const seen: number[][] = [[], []];
      const end = deferred<void>();
      let request!: Promise<unknown>;
      client.onNotification("zen/thread/event", async (value) => {
        seen[0]!.push(value.watermark);
        await request;
      });
      client.onNotification("zen/thread/event", (value) => {
        seen[1]!.push(value.watermark);
        if (value.watermark === 3) end.resolve();
      });
      request = client.request("zen/thread/resume", { threadId: "thread" });
      const pending = await wire.next();
      const snapshot = recovery([event(1), event(2)]);
      wire.send({ id: pending.id, result: snapshot });
      wire.send({ method: "zen/thread/event", params: event(3) });
      assert.deepEqual(await request, snapshot);
      await end.promise;
      assert.deepEqual(seen, [
        [1, 2, 3],
        [1, 2, 3],
      ]);
      // Retained recovery tails may contain already-delivered live events.
      const again = client.request("zen/thread/resume", { threadId: "thread" });
      wire.send({
        id: (await wire.next()).id,
        result: recovery([event(1), event(2), event(3)]),
      });
      await again;
      assert.deepEqual(seen, [
        [1, 2, 3],
        [1, 2, 3],
      ]);
    });
  },
);

test(
  "same-thread recoveries coalesce; other threads proceed independently; empty overlap emits nothing",
  { timeout: 5000 },
  async () => {
    await fixture(async (client, wire) => {
      const seen: string[] = [];
      client.onNotification("zen/thread/event", (value) => {
        seen.push(value.threadId);
      });
      const first = client.request("zen/thread/resume", { threadId: "thread" });
      const second = client.request("zen/thread/resume", {
        threadId: "thread",
      });
      const other = client.request("zen/thread/resume", { threadId: "other" });
      const a = await wire.next();
      const b = await wire.next();
      assert.equal(a.params.threadId, "thread");
      assert.equal(b.params.threadId, "other");
      wire.send({ id: b.id, result: recovery([event(1, "other")], "other") });
      await other;
      wire.send({ id: a.id, result: recovery() });
      assert.deepEqual(await first, await second);
      assert.deepEqual(seen, ["other"]);
      const next = client.request("zen/thread/resume", { threadId: "thread" });
      wire.send({ id: (await wire.next()).id, result: recovery([event(1)]) });
      await next;
      assert.deepEqual(seen, ["other", "thread"]);
    });
  },
);

test(
  "malformed resume is atomically rejected without partial fanout; failed coalesced callers settle and can retry",
  { timeout: 5000 },
  async () => {
    await fixture(async (client, wire) => {
      const seen: number[] = [];
      client.onNotification("zen/thread/event", (value) => {
        seen.push(value.watermark);
      });
      const invalid = [
        null,
        {},
        recovery([event(1)], "foreign"),
        recovery([event(1, "thread", "old")], "thread", "old"),
        { ...recovery([event(1), event(2)]), watermark: 1 },
        recovery([event(1), event(1)]),
        recovery([event(2), event(1)]),
        recovery([
          event(1),
          {
            ...event(2),
            event: {
              type: "thread_name_updated",
              threadId: "foreign",
              name: "bad",
            },
          },
        ]),
      ];
      for (const result of invalid) {
        const first = client.request("zen/thread/resume", {
          threadId: "thread",
        });
        const second = client.request("zen/thread/resume", {
          threadId: "thread",
        });
        const rejected = Promise.all([
          assert.rejects(first, /Malformed/),
          assert.rejects(second, /Malformed/),
        ]);
        wire.send({ id: (await wire.next()).id, result });
        await rejected;
        assert.deepEqual(seen, []);
      }
      const valid = client.request("zen/thread/resume", { threadId: "thread" });
      wire.send({ id: (await wire.next()).id, result: recovery([event(1)]) });
      await valid;
      assert.deepEqual(seen, [1]);
    });
  },
);

test(
  "closing an outstanding shared recovery rejects every caller without waiting for observers",
  { timeout: 5000 },
  async () => {
    await fixture(async (client, wire) => {
      const first = client.request("zen/thread/resume", { threadId: "thread" });
      const second = client.request("zen/thread/resume", {
        threadId: "thread",
      });
      const rejected = Promise.all([
        assert.rejects(first, /closed/),
        assert.rejects(second, /closed/),
      ]);
      await wire.next();
      client.close();
      await rejected;
    });
  },
);

test(
  "real Host snapshot metadata overlap reaches both existing renderer projections through the real client exactly once",
  { timeout: 10000 },
  async () => {
    const metadata = new InMemoryThreadMetadataStore();
    const host = createHostedAppServer({
      cwd: process.cwd(),
      dataDirectory: "/tmp/unused-shared-resume",
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
      journal: new InMemoryThreadJournal(),
      threadMetadata: metadata,
      toolPresentation: "direct",
    });
    const server = await serveCodexWebSocket({
      appServer: host,
      zenHome: "/tmp/unused-shared-resume",
      listen: "ws://127.0.0.1:0",
    });
    const client = await ZenXProtocolClient.connect(options(server.url));
    const gate = deferred<void>();
    try {
      const thread = await host.startThread();
      const initial = await client.request("zen/thread/resume", {
        threadId: thread.id,
      });
      const views = [
        projectNativeRecovery(initial),
        projectNativeRecovery(initial),
      ];
      const seen: number[][] = [[], []];
      for (let index = 0; index < views.length; index++)
        client.onNotification("zen/thread/event", (value) => {
          if (value.threadId !== thread.id) return;
          seen[index]!.push(value.watermark);
          views[index] = applyNativeThreadEvent(views[index]!, value.event);
        });
      const read = metadata.read.bind(metadata);
      const entered = deferred<void>();
      let armed = true;
      metadata.read = async (id) => {
        if (armed && id === thread.id) {
          armed = false;
          entered.resolve();
          await gate.promise;
        }
        return await read(id);
      };
      const background = client.request("zen/thread/resume", {
        threadId: thread.id,
      });
      await entered.promise;
      await (
        await host.startTurn(thread.id, "visible during background recovery")
      ).done;
      assert.deepEqual(seen, [[], []]);
      gate.resolve();
      const snapshot = await background;
      assert(snapshot.events.length > 0);
      assert.deepEqual(
        seen[0],
        snapshot.events.map((value) => value.watermark),
      );
      assert.deepEqual(seen[1], seen[0]);
      assert.deepEqual(
        views.map((view) => view.turns.length),
        [1, 1],
      );
      assert.equal(projectNativeRecovery(snapshot).turns.length, 1);
      await client.request("zen/thread/resume", { threadId: thread.id });
      assert.equal(new Set(seen[0]).size, seen[0]!.length);
    } finally {
      gate.resolve();
      client.close();
      await server.close();
      await host.closeHostResources();
    }
  },
);

test(
  "stale response must not regress transport delivery cursor",
  { timeout: 5000 },
  async () => {
    await fixture(async (client, wire) => {
      const seen: number[] = [];
      client.onNotification("zen/thread/event", (e) => {
        seen.push(e.watermark);
      });
      const resume = async (snapshot: unknown) => {
        const p = client.request("zen/thread/resume", { threadId: "thread" });
        wire.send({ id: (await wire.next()).id, result: snapshot });
        return p;
      };
      await resume(recovery([event(5)]));
      await resume({ ...recovery(), watermark: 3 });
      await resume(recovery([event(4), event(5)]));
      assert.deepEqual(seen, [5]);
    });
  },
);

test(
  "throwing observer does not prevent healthy observer or RPC resolution",
  { timeout: 5000 },
  async () => {
    await fixture(async (client, wire) => {
      const seen: number[] = [];
      const errors: string[] = [];
      const reported = deferred<void>();
      client.onStatus((s) => {
        if (s.type === "protocolError") {
          errors.push(s.error.message);
          if (errors.length === 2) reported.resolve();
        }
      });
      client.onNotification("zen/thread/event", () => {
        throw Error("observer-only");
      });
      client.onNotification("zen/thread/event", (e) => {
        seen.push(e.watermark);
      });
      const p = client.request("zen/thread/resume", { threadId: "thread" });
      wire.send({
        id: (await wire.next()).id,
        result: recovery([event(1), event(2)]),
      });
      await p;
      await reported.promise;
      assert.deepEqual(seen, [1, 2]);
      assert.deepEqual(errors, ["observer-only", "observer-only"]);
    });
  },
);

test(
  "reconnect resets epoch and seeds dedup cursor before next ordinary resume",
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => server.once("listening", r));
    const address = server.address();
    assert(address && typeof address !== "string");
    let generation = 0;
    let peer!: WebSocket;
    server.on("connection", (socket) => {
      peer = socket;
      generation++;
      socket.on("message", (data) => {
        const req = JSON.parse(data.toString());
        if (req.id === undefined) return;
        socket.send(
          JSON.stringify({
            id: req.id,
            result:
              req.method === "zen/initialize"
                ? { processEpoch: `epoch-${generation}` }
                : req.method === "zen/thread/resume"
                  ? recovery(
                      [
                        event(
                          generation > 1 ? 1 : 5,
                          "thread",
                          `epoch-${generation}`,
                        ),
                      ],
                      "thread",
                      `epoch-${generation}`,
                    )
                  : {},
          }),
        );
      });
    });
    const client = await ZenXProtocolClient.connect({
      ...options(`ws://127.0.0.1:${address.port}`),
      reconnect: { minDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 },
    });
    try {
      await client.request("zen/thread/resume", { threadId: "thread" });
      const seen: number[] = [];
      const ready = deferred<void>();
      client.onNotification("zen/thread/event", (e) => {
        seen.push(e.watermark);
      });
      client.onStatus((s) => {
        if (s.type === "ready" && s.reconnected) ready.resolve();
      });
      peer.terminate();
      await ready.promise;
      await client.request("zen/thread/resume", { threadId: "thread" });
      assert.deepEqual(seen, [1]);
    } finally {
      client.close();
      for (const s of server.clients) s.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

test(
  "synchronous close in first observer fences remaining overlap delivery without changing received response success",
  { timeout: 5000 },
  async () => {
    await fixture(async (client, wire) => {
      const first: number[] = [];
      const second: number[] = [];
      client.onNotification("zen/thread/event", (e) => {
        first.push(e.watermark);
        client.close();
      });
      client.onNotification("zen/thread/event", (e) => {
        second.push(e.watermark);
      });
      const p = client.request("zen/thread/resume", { threadId: "thread" });
      wire.send({
        id: (await wire.next()).id,
        result: recovery([event(1), event(2)]),
      });
      await p;
      assert.deepEqual(first, [1]);
      assert.deepEqual(second, []);
      assert.equal(client.connected, false);
    });
  },
);

test(
  "throwing protocolError observer cannot make listener failure an unhandled rejection",
  { timeout: 5000 },
  async () => {
    await fixture(async (client, wire) => {
      const seen: number[] = [];
      const reported = deferred<void>();
      let reports = 0;
      client.onStatus((s) => {
        if (s.type === "protocolError") {
          if (++reports === 2) reported.resolve();
          throw Error("status failure");
        }
      });
      client.onNotification("zen/thread/event", () => {
        throw Error("notification failure");
      });
      client.onNotification("zen/thread/event", (e) => {
        seen.push(e.watermark);
      });
      const p = client.request("zen/thread/resume", { threadId: "thread" });
      wire.send({
        id: (await wire.next()).id,
        result: recovery([event(1), event(2)]),
      });
      await p;
      await reported.promise;
      assert.deepEqual(seen, [1, 2]);
    });
  },
);

test(
  "real Host: metadata-gated background resume plus another thread and immediate next turn retain ordered exactly-once delivery",
  { timeout: 10000 },
  async () => {
    const metadata = new InMemoryThreadMetadataStore();
    const host = createHostedAppServer({
      cwd: process.cwd(),
      dataDirectory: "/tmp/independent-real-host-resume",
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
      journal: new InMemoryThreadJournal(),
      threadMetadata: metadata,
      toolPresentation: "direct",
    });
    const server = await serveCodexWebSocket({
      appServer: host,
      zenHome: "/tmp/independent-real-host-resume",
      listen: "ws://127.0.0.1:0",
    });
    const client = await ZenXProtocolClient.connect(options(server.url));
    const release = deferred<void>();
    try {
      const a = await host.startThread();
      const b = await host.startThread();
      const initialA = await client.request("zen/thread/resume", {
        threadId: a.id,
      });
      const initialB = await client.request("zen/thread/resume", {
        threadId: b.id,
      });
      const views = new Map([
        [a.id, projectNativeRecovery(initialA)],
        [b.id, projectNativeRecovery(initialB)],
      ]);
      const seen = new Map<string, number[]>([
        [a.id, []],
        [b.id, []],
      ]);
      let background!: Promise<unknown>;
      client.onNotification("zen/thread/event", async (e) => {
        if (e.threadId === a.id) await background;
      });
      client.onNotification("zen/thread/event", (e) => {
        seen.get(e.threadId)!.push(e.watermark);
        views.set(
          e.threadId,
          applyNativeThreadEvent(views.get(e.threadId)!, e.event),
        );
      });
      const original = metadata.read.bind(metadata);
      const entered = deferred<void>();
      let arm = true;
      metadata.read = async (id) => {
        if (id === a.id && arm) {
          arm = false;
          entered.resolve();
          await release.promise;
        }
        return original(id);
      };
      background = client.request("zen/thread/resume", { threadId: a.id });
      await entered.promise;
      await (
        await host.startTurn(a.id, "overlap A")
      ).done;
      await (
        await host.startTurn(b.id, "independent B")
      ).done;
      // Flush B's socket notifications without releasing A's metadata gate.
      await client.request("zen/thread/resume", { threadId: b.id });
      assert.equal(views.get(b.id)!.turns.length, 1);
      assert.equal(views.get(a.id)!.turns.length, 0);
      release.resolve();
      await background;
      await (
        await host.startTurn(a.id, "next A")
      ).done;
      await client.request("zen/thread/resume", { threadId: a.id });
      assert.equal(views.get(a.id)!.turns.length, 2);
      assert.equal(views.get(b.id)!.turns.length, 1);
      for (const marks of seen.values()) {
        assert.equal(marks.length, new Set(marks).size);
        assert.deepEqual(
          marks,
          [...marks].sort((a, b) => a - b),
        );
      }
    } finally {
      release.resolve();
      client.close();
      await server.close();
      await host.closeHostResources();
    }
  },
);
