import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import { ZenXProtocolClient } from "../src/protocol-client/index.js";
import { ZenAppServer } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { ToolEnvironment } from "../../../src/tool.js";
import { NativeConnection } from "../../../src/protocol/native/connection.js";
import {
  NativeRecoveryProjection,
  type NativeProjectedThreadEvent,
  type NativeThreadRecoverySnapshot,
} from "../../../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../../../src/protocol/codex/wire.js";
import {
  createConversationReadStore,
  unreadThreadIds,
} from "../src/renderer/src/conversation-read-state.js";
import { createThreadEndNotificationObserver } from "../src/renderer/src/thread-end-notifications.js";
import {
  applyNativeThreadEvent,
  projectNativeRecovery,
} from "../src/renderer/src/thread-view-state.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function store() {
  const values = new Map<string, string>();
  return createConversationReadStore(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    200,
  );
}

function fixture(
  entered: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
) {
  const now = () => new Date(150).toISOString();
  return new ZenAppServer({
    now,
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({
      now,
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "fixture",
        modelCatalog: new StaticModelCatalog([
          { id: "fixture", isDefault: true, contextWindow: 32768 },
        ]),
        adapter: {
          provider: "fixture",
          async *stream() {
            entered.resolve();
            await release.promise;
          },
        },
      },
    ]),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "fixture",
      modelId: "fixture",
      reasoningEffort: "medium",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
  });
}

test("NativeConnection transfers a live end through the resume barrier without relighting cold history", async () => {
  const entered = deferred();
  const release = deferred();
  const server = fixture(entered, release);
  const projection = new NativeRecoveryProjection(server);
  const messages: JsonRpcMessage[] = [];
  const notifications: NativeProjectedThreadEvent[] = [];
  const readStore = store();
  const response = (id: string) => {
    const message = messages.find((entry) => "id" in entry && entry.id === id);
    assert(message && "result" in message);
    return message.result;
  };
  const connection = new NativeConnection({
    appServer: server,
    projection,
    send(message) {
      messages.push(message);
      if ("method" in message && message.method === "zen/thread/event") {
        const event = message.params as NativeProjectedThreadEvent;
        notifications.push(event);
        observer.observe(event);
      }
    },
  });
  const observer = createThreadEndNotificationObserver(readStore, async () => {
    await connection.receive({
      id: "initialize",
      method: "zen/initialize",
      params: {},
    });
    return response("initialize") as { processEpoch: string };
  });
  try {
    await observer.connect();
    const thread = await server.startThread();
    await connection.receive({
      id: "initial",
      method: "zen/thread/resume",
      params: { threadId: thread.id },
    });
    const turn = await server.startTurn(thread.id, "Synthetic empty execution");
    await entered.promise;
    assert(
      notifications.some(
        ({ event }) =>
          event.type === "item_completed" && event.item.type === "turn_started",
      ),
    );
    const reading = deferred();
    const unblockRead = deferred();
    const originalRead = server.readThread.bind(server);
    server.readThread = async (id) => {
      reading.resolve();
      await unblockRead.promise;
      return originalRead(id);
    };
    const resume = connection.receive({
      id: "overlap",
      method: "zen/thread/resume",
      params: { threadId: thread.id },
    });
    await reading.promise;
    release.resolve();
    await turn.done;
    unblockRead.resolve();
    await resume;
    server.readThread = originalRead;
    const snapshot = response("overlap") as NativeThreadRecoverySnapshot;
    const ends = snapshot.events.filter(
      ({ event }) =>
        event.type === "item_completed" && event.item.type === "turn_completed",
    );
    assert.equal(ends.length, 1);
    assert.equal(
      notifications.filter(
        ({ event }) =>
          event.type === "item_completed" &&
          event.item.type === "turn_completed",
      ).length,
      0,
    );
    const summaries = await server.listThreadSummaries();
    assert.equal(unreadThreadIds(summaries, readStore.getSnapshot()).size, 0);
    observer.recover(thread.id, snapshot);
    assert.equal(
      unreadThreadIds(summaries, readStore.getSnapshot()).size,
      1,
      "live barrier end must survive wall-clock rollback",
    );
    const summary = summaries[0]!;
    assert(summary.status === "idle" && summary.lastTurnEnd);
    const end = summary.lastTurnEnd;
    assert.equal(
      readStore.getSnapshot().pendingThreadEnds[thread.id]?.id,
      end.id,
    );
    assert.equal(
      readStore.getSnapshot().pendingThreadEnds[thread.id]?.position,
      0,
    );
    readStore.advance("threads", thread.id, {
      ...end,
      createdAt: Date.parse(end.createdAt),
    });
    observer.recover(thread.id, snapshot);
    assert.equal(
      unreadThreadIds(summaries, readStore.getSnapshot()).size,
      0,
      "duplicate barrier response cannot revive a read end",
    );

    const coldStore = store();
    const cold = createThreadEndNotificationObserver(coldStore, async () => ({
      processEpoch: projection.processEpoch,
    }));
    await cold.connect();
    await connection.receive({
      id: "cold",
      method: "zen/thread/resume",
      params: { threadId: thread.id },
    });
    const history = response("cold") as NativeThreadRecoverySnapshot;
    assert(history.thread.items.some((item) => item.id === end.id));
    assert.deepEqual(history.events, []);
    cold.recover(thread.id, history);
    assert.deepEqual(coldStore.getSnapshot().pendingThreadEnds, {});
    assert.equal(unreadThreadIds(summaries, coldStore.getSnapshot()).size, 0);
    cold.disconnect();
  } finally {
    release.resolve();
    observer.disconnect();
    connection.close();
    projection.close();
  }
});

for (const retireAtReady of [false, true])
  test(
    `real automatic reconnect transfers overlap ends with a ${retireAtReady ? "retired" : "pending"} epoch handshake`,
    { timeout: 10_000 },
    async () => {
      const entered = deferred();
      const release = deferred();
      const server = fixture(entered, release);
      let endpoint = await serveCodexWebSocket({
        appServer: server,
        zenHome: path.join(os.tmpdir(), "zenx-unread-test"),
        listen: "ws://127.0.0.1:0",
      });
      const port = new URL(endpoint.url).port;
      const client = await ZenXProtocolClient.connect({
        url: endpoint.url,
        clientInfo: { name: "unread-test", version: "1", title: "Unread test" },
        reconnect: { maxAttempts: 20, minDelayMs: 20, maxDelayMs: 50 },
      });
      const readStore = store();
      const verified = deferred();
      let holdHandshake = false;
      const observer = createThreadEndNotificationObserver(
        readStore,
        async () => {
          const result = await client.request("zen/initialize", {});
          if (holdHandshake) await verified.promise;
          return result;
        },
      );
      let connected: Promise<void> = observer.connect();
      await connected;
      let ready = deferred();
      const sequence: string[] = [];
      const ends: NativeProjectedThreadEvent[] = [];
      let view: ReturnType<typeof projectNativeRecovery> | undefined;
      client.onStatus((status) => {
        if (status.type === "resubscribed")
          view = projectNativeRecovery(status.recovery);
        if (status.type === "ready") {
          sequence.push("ready");
          connected = observer.connect();
          ready.resolve();
          if (retireAtReady) client.close();
        } else if (status.type === "reconnecting" || status.type === "closed")
          observer.disconnect();
      });
      client.onNotification("zen/thread/event", (event) => {
        observer.observe(event);
        if (view !== undefined)
          view = applyNativeThreadEvent(view, event.event);
        if (
          event.event.type === "item_completed" &&
          event.event.item.type === "turn_completed"
        ) {
          sequence.push("end");
          ends.push(event);
        }
      });
      const unblockRead = deferred();
      try {
        const thread = await server.startThread();
        await client.request("zen/thread/resume", { threadId: thread.id });
        const turn = await server.startTurn(
          thread.id,
          "Synthetic reconnect execution",
        );
        await entered.promise;
        await endpoint.close();
        const reading = deferred();
        const originalRead = server.readThread.bind(server);
        server.readThread = async (id) => {
          reading.resolve();
          await unblockRead.promise;
          return originalRead(id);
        };
        holdHandshake = true;
        endpoint = await serveCodexWebSocket({
          appServer: server,
          zenHome: path.join(os.tmpdir(), "zenx-unread-test"),
          listen: `ws://127.0.0.1:${port}`,
        });
        await reading.promise;
        release.resolve();
        await turn.done;
        unblockRead.resolve();
        await ready.promise;
        await new Promise((resolve) => setTimeout(resolve, 20));
        server.readThread = originalRead;
        if (retireAtReady) {
          assert.equal(
            ends.length,
            0,
            "retired socket cannot deliver buffered overlap events",
          );
          assert.deepEqual(readStore.getSnapshot().pendingThreadEnds, {});
          return;
        }
        assert.equal(
          ends.length,
          1,
          "resubscribe overlap must reach the existing native event channel",
        );
        assert.deepEqual(sequence, ["ready", "end"]);
        assert.deepEqual(
          readStore.getSnapshot().pendingThreadEnds,
          {},
          "unverified epoch is buffered rather than accepted",
        );
        verified.resolve();
        await connected;
        const summaries = await server.listThreadSummaries();
        assert.equal(
          unreadThreadIds(summaries, readStore.getSnapshot()).size,
          1,
        );
        const summary = summaries[0]!;
        assert(summary.status === "idle" && summary.lastTurnEnd);
        const end = summary.lastTurnEnd;
        assert.equal(
          view?.canonicalItems?.filter((item) => item.id === end.id).length,
          1,
          "snapshot plus transferred notification cannot duplicate the canonical end",
        );
        assert.equal(
          readStore.getSnapshot().pendingThreadEnds[thread.id]?.id,
          end.id,
        );
        readStore.advance("threads", thread.id, {
          ...end,
          createdAt: Date.parse(end.createdAt),
        });
        observer.observe(ends[0]!);
        assert.equal(
          unreadThreadIds(summaries, readStore.getSnapshot()).size,
          0,
        );

        ready = deferred();
        await endpoint.close();
        endpoint = await serveCodexWebSocket({
          appServer: server,
          zenHome: path.join(os.tmpdir(), "zenx-unread-test"),
          listen: `ws://127.0.0.1:${port}`,
        });
        await ready.promise;
        await connected;
        assert.equal(
          ends.length,
          1,
          "cold reconnect cannot re-emit canonical history",
        );
        assert.deepEqual(readStore.getSnapshot().pendingThreadEnds, {});
      } finally {
        release.resolve();
        unblockRead.resolve();
        verified.resolve();
        observer.disconnect();
        client.close();
        await endpoint.close();
      }
    },
  );
