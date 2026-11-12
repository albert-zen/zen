import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ZenAppServer } from "../../../src/app-server.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { ToolEnvironment } from "../../../src/tool.js";
import type { ModelAdapter, ModelEvent } from "../../../src/model.js";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import { ZenXProtocolClient } from "../src/protocol-client/index.js";
import {
  ZenXTriggerService,
  type ZenXTriggerAppServerPort,
} from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function within<T>(p: Promise<T>) {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>(
      (_, reject) =>
        (t = setTimeout(() => reject(new Error("Test timeout")), 3000)),
    ),
  ]).finally(() => clearTimeout(t));
}

for (const reconnect of [
  "none",
  "before-completion",
  "after-completion",
  "failed-read",
] as const)
  test(`real protocol: bootstrap and later human completion remain observable${reconnect === "none" ? "" : ` across reconnect ${reconnect}`}`, async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "zen-review-native-wakeup-"),
    );
    const release = deferred();
    const nextRelease = deferred();
    let samples = 0;
    let failCompletionRead = false;
    const adapter: ModelAdapter = {
      provider: "review",
      async *stream(): AsyncIterable<ModelEvent> {
        await (samples++ === 0 ? release.promise : nextRelease.promise);
        yield { type: "text_delta", delta: "Model-generated welcome" };
      },
    };
    const appServer = new ZenAppServer({
      journal: new InMemoryThreadJournal(),
      threadMetadata: new InMemoryThreadMetadataStore(),
      runtime: new AgentRuntime({
        toolEnvironment: new ToolEnvironment({ runtimes: [] }),
      }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "review",
          adapter,
          modelCatalog: new StaticModelCatalog([
            { id: "fake", isDefault: true, contextWindow: 32768 },
          ]),
        },
      ]),
      defaults: {
        cwd: dir,
        providerProfileId: "review",
        modelId: "fake",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    let socketServer = await serveCodexWebSocket({
      appServer,
      zenHome: dir,
      listen: "ws://127.0.0.1:0",
    });
    const client = await ZenXProtocolClient.connect({
      url: socketServer.url,
      clientInfo: {
        name: "bootstrap-test",
        title: "Bootstrap test",
        version: "1",
      },
      reconnect: { maxAttempts: 30, minDelayMs: 5, maxDelayMs: 20 },
    });
    const nativeComplete = deferred();
    client.onNotification("zen/thread/event", (event) => {
      if (event.event.type === "turn_completed") nativeComplete.resolve();
    });
    const port: ZenXTriggerAppServerPort = {
      request: (method, params) => client.request(method, params),
      onReconnect: (listener) =>
        client.onStatus((status) => {
          if (status.type === "ready" && status.reconnected) listener();
        }),
      onNotification(listener) {
        const disposes = (
          ["item/completed", "turn/completed", "zen/thread/event"] as const
        ).map((method) =>
          client.onNotification(method, (params) => {
            listener(method, params);
          }),
        );
        return () => disposes.forEach((d) => d());
      },
      readThread: (threadId) => {
        if (failCompletionRead)
          return Promise.reject(
            new Error("Scripted completion read unavailable"),
          );
        return client.request("thread/read", { threadId, includeTurns: true });
      },
    };
    const service = new ZenXTriggerService(
      port,
      new ZenXTriggerStore(path.join(dir, "state.json")),
    );
    try {
      await service.start();
      const { thread } = await client.request("thread/start", {
        cwd: dir,
        model: "fake",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      const room = await service.createAssistantRoom({
        name: "New PAW",
        members: [{ name: "New PAW", threadId: thread.id }],
      });
      const operationId = `${room.operationEpoch}:${randomUUID()}`;
      await service.prepareAssistantIntroduction(room.id, operationId, "en");
      await service.startAssistantIntroduction(room.id, operationId);
      assert.equal(service.snapshot().history[0]!.status, "running");
      if (
        reconnect === "before-completion" ||
        reconnect === "after-completion"
      ) {
        const ready = deferred();
        const unsubscribe = client.onStatus((status) => {
          if (status.type === "ready" && status.reconnected) ready.resolve();
        });
        const url = socketServer.url;
        await socketServer.close();
        if (reconnect === "after-completion") {
          const terminal = deferred();
          const dispose = appServer.subscribe((event) => {
            if (event.type === "turn_completed") terminal.resolve();
          });
          release.resolve();
          await within(terminal.promise);
          dispose();
        }
        socketServer = await serveCodexWebSocket({
          appServer,
          zenHome: dir,
          listen: url,
        });
        await within(ready.promise);
        unsubscribe();
      }
      failCompletionRead = reconnect === "failed-read";
      const expectedStatus = "completed";
      const completed = waitHistory(
        service,
        () => service.snapshot().history[0]?.status === expectedStatus,
      );
      release.resolve();
      if (reconnect !== "after-completion")
        await within(nativeComplete.promise);
      await within(completed);
      const read = await client.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      });
      assert.equal(read.thread.turns[0]!.status, "completed");
      assert.equal(
        (await appServer.readThread(thread.id)).items.filter(
          (i) => i.type === "host_message",
        ).length,
        1,
      );
      assert.equal(
        (await appServer.readThread(thread.id)).items.filter(
          (i) => i.type === "user_message",
        ).length,
        0,
      );
      assert.equal(
        service.snapshot().history[0]!.status,
        expectedStatus,
        "Canonical bootstrap completed, but TriggerService did not reconcile its terminal observation",
      );
      if (failCompletionRead)
        assert.equal(
          service.snapshot().history[0]!.error,
          null,
          "Buffered canonical source and terminal facts remain valid when optional compatibility history fails",
        );
      failCompletionRead = false;
      await service.postRoomMessage(
        room.id,
        "You",
        "Skip naming and help me work",
      );
      assert.equal(service.snapshot().history[0]!.status, "running");
      const nextCompleted = waitHistory(
        service,
        () =>
          service.snapshot().history.length === 2 &&
          service.snapshot().history[0]?.status === "completed",
      );
      nextRelease.resolve();
      await within(nextCompleted);
      assert.equal(service.snapshot().rooms[0]!.messages.length, 1);
      assert.equal(service.snapshot().rooms[0]!.messages[0]!.kind, "human");
      const final = await appServer.readThread(thread.id);
      const hostInputs = final.items.filter(
        (item) => item.type === "host_message",
      );
      assert.deepEqual(
        hostInputs.map((item) => item.source),
        ["bootstrap", "room"],
      );
      assert.equal(hostInputs[1]!.sourceId, room.id);
      assert.equal(
        final.items.filter((item) => item.type === "user_message").length,
        0,
        "A human-authored Room post retains its Room provenance in the working Thread",
      );
    } finally {
      release.resolve();
      nextRelease.resolve();
      await service.stop();
      client.close();
      await socketServer.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

function waitHistory(
  service: ZenXTriggerService,
  done: () => boolean,
): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const dispose = service.onChange(() => {
      if (done()) {
        dispose();
        resolve();
      }
    });
  });
}
