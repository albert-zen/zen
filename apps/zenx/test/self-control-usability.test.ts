import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ZenAppServer } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import type { ModelAdapter } from "../../../src/model.js";
import { ToolEnvironment } from "../../../src/tool.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import { ZenXProtocolClient } from "../src/protocol-client/index.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "../src/main/capabilities/self-control-package.js";

async function fixture(adapter?: ModelAdapter) {
  const app = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ bundles: [] }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "test",
        adapter: adapter ?? {
          provider: "test",
          async *stream() {
            yield {
              type: "text_delta" as const,
              delta: "original".repeat(1000),
            };
          },
        },
        modelCatalog: new StaticModelCatalog([
          {
            id: "test",
            contextWindow: 32768,
            isDefault: true,
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          },
        ]),
      },
    ]),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "test",
      modelId: "test",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const server = await serveCodexWebSocket({
    appServer: app,
    zenHome: process.cwd(),
    listen: "ws://127.0.0.1:0",
  });
  const client = await ZenXProtocolClient.connect({
    url: server.url,
    clientInfo: { name: "test", title: "test", version: "1" },
  });
  const port = new MutableAppServerRequestPort();
  await port.attach(client, process.cwd());
  const control = new ZenXSelfControlCapabilityPackage({ appServer: port });
  return {
    app,
    client,
    control,
    port,
    invoke: async (
      name: string,
      args: Record<string, unknown>,
      callId: string = randomUUID(),
    ) =>
      (await control.invoke(name, {
        name,
        arguments: args,
        callId,
        threadId: "source-thread",
        cwd: process.cwd(),
        signal: new AbortController().signal,
      })) as Record<string, any>,
    close: async () => {
      client.close();
      await server.close();
    },
  };
}

test("self-control accepts readable targets and ambiguous mutations leave both Threads unchanged", async () => {
  const f = await fixture();
  try {
    const a = await f.client.request("thread/start", {});
    const b = await f.client.request("thread/start", {});
    for (const threadId of [a.thread.id, b.thread.id])
      await f.client.request("thread/name/set", { threadId, name: "Review" });
    const result = await f.invoke("zenx_threads_rename", {
      target: "Review",
      name: "Wrong",
    });
    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidates.length, 2);
    for (const threadId of [a.thread.id, b.thread.id])
      assert.equal(
        (await f.client.request("thread/read", { threadId })).thread.name,
        "Review",
      );
    await f.invoke("zenx_threads_rename", {
      target: a.thread.id.slice(0, 12),
      name: "Ready",
    });
    assert.equal(
      (await f.invoke("zenx_threads_status", { target: "Ready" })).threadId,
      a.thread.id,
    );
  } finally {
    await f.close();
  }
});

test("sending needs only a target and text, and retrying the same invocation never creates another message", async () => {
  const f = await fixture();
  try {
    const created = await f.client.request("thread/start", {});
    const args = { target: created.thread.id, text: "First request" };
    const first = await f.invoke("zenx_threads_send", args, "one-call");
    assert.equal(typeof first.clientUserMessageId, "string");
    const again = await f.invoke("zenx_threads_send", args, "one-call");
    assert.equal(again.clientUserMessageId, first.clientUserMessageId);
    assert.equal(again.turnId, first.turnId);
    await assert.rejects(
      f.invoke("zenx_threads_send", { ...args, text: "different" }, "one-call"),
      /different input/,
    );
    const read = await f.app.readThread(created.thread.id);
    assert.equal(read.items.filter((i) => i.type === "user_message").length, 1);
  } finally {
    await f.close();
  }
});

test("original history has stable older pages and complete item continuation bound to its filters", async () => {
  const f = await fixture();
  try {
    const created = await f.client.request("thread/start", {});
    const target = created.thread.id;
    for (const text of ["first", "second", "third"])
      await (
        await f.app.startTurn(target, text)
      ).done;
    const recent = await f.invoke("zenx_threads_read", { target, maxTurns: 1 });
    assert.equal(recent.turns.length, 1);
    assert.equal(typeof recent.nextCursor, "string");
    await (
      await f.app.startTurn(target, "appended after page")
    ).done;
    const older = await f.invoke("zenx_threads_read", {
      target,
      maxTurns: 1,
      cursor: recent.nextCursor,
    });
    assert.notEqual(older.turns[0].turnId, recent.turns[0].turnId);
    await assert.rejects(
      f.invoke("zenx_threads_read", {
        target,
        granularity: "agent_messages",
        cursor: recent.nextCursor,
      }),
      /cursor/,
    );
    const messages = await f.invoke("zenx_threads_read", {
      target,
      granularity: "agent_messages",
      turnId: older.turns[0].turnId,
    });
    assert.equal(messages.items.length, 1);
    const itemId = messages.items[0].itemId;
    let cursor: string | undefined;
    let raw = "";
    do {
      const chunk = await f.invoke("zenx_threads_read", {
        target,
        granularity: "item",
        itemId,
        ...(cursor ? { cursor } : {}),
      });
      raw += chunk.content;
      cursor = chunk.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.equal(JSON.parse(raw).text, "original".repeat(1000));
  } finally {
    await f.close();
  }
});

test("models and reasoning efforts are discoverable and selected through create and configure", async () => {
  const f = await fixture();
  try {
    const catalog = await f.invoke("zenx_models_list", {});
    const model = catalog.models[0].model;
    assert.equal(typeof model, "string");
    assert(
      catalog.models[0].supportedReasoningEfforts.some(
        (entry: { reasoningEffort: string }) =>
          entry.reasoningEffort === "high",
      ),
    );
    const created = await f.invoke("zenx_threads_create", {
      project: process.cwd(),
      model,
      effort: "high",
    });
    assert.equal(created.runtime.reasoningEffort, "high");
    await f.invoke("zenx_threads_configure", {
      target: created.threadId,
      model,
      effort: "low",
    });
    assert.equal(
      (await f.app.readThread(created.threadId)).reasoningEffort,
      "low",
    );
    await assert.rejects(
      f.invoke("zenx_threads_configure", {
        target: created.threadId,
        model,
        effort: "invented",
      }),
    );
    assert.equal(
      (await f.app.readThread(created.threadId)).reasoningEffort,
      "low",
    );
  } finally {
    await f.close();
  }
});

test("filtered Thread lists expose unambiguous short IDs and a filter-bound continuation", async () => {
  const f = await fixture();
  try {
    for (const name of ["Review one", "Review two", "Other"]) {
      const created = await f.client.request("thread/start", {});
      await f.client.request("thread/name/set", {
        threadId: created.thread.id,
        name,
      });
    }
    const first = await f.invoke("zenx_threads_list", {
      query: "Review",
      limit: 1,
    });
    assert.equal(first.threads.length, 1);
    assert.equal(typeof first.threads[0].shortId, "string");
    const second = await f.invoke("zenx_threads_list", {
      query: "Review",
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.notEqual(first.threads[0].threadId, second.threads[0].threadId);
    assert.equal(second.nextCursor, null);
    await assert.rejects(
      f.invoke("zenx_threads_list", {
        query: "Other",
        cursor: first.nextCursor,
      }),
      /cursor/,
    );
  } finally {
    await f.close();
  }
});

test("a replacement cannot act on a new Turn that starts after its state read", async () => {
  const f = await fixture({
    provider: "test",
    async *stream(request) {
      if (!request.signal.aborted)
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      yield { type: "text_delta", delta: "stopped" };
    },
  });
  let current: { id: string; done: Promise<void> } | undefined;
  let target = "";
  try {
    target = (await f.client.request("thread/start", {})).thread.id;
    const first = await f.app.startTurn(target, "old work");
    let raced = false;
    await f.port.attach({
      request: async (method, params) => {
        const result = await f.client.request(method, params);
        if (method === "zen/thread/read" && !raced) {
          raced = true;
          await f.app.interruptTurn(target, first.id);
          await first.done;
          current = await f.app.startTurn(target, "new work");
        }
        return result;
      },
    });
    await assert.rejects(
      f.invoke("zenx_threads_send", {
        target,
        text: "replacement for old work",
        messageType: "replacement",
      }),
      /[Tt]urn|expected/,
    );
    const snapshot = await f.app.readThread(target);
    assert.equal(snapshot.turns.at(-1)?.id, current?.id);
    assert.equal(snapshot.turns.at(-1)?.status, "inProgress");
    assert.equal(
      snapshot.items.filter(
        (item) => item.type === "turn_replacement_requested",
      ).length,
      0,
    );
  } finally {
    if (current) {
      await f.app.interruptTurn(target, current.id);
      await current.done;
    }
    await f.close();
  }
});

test("default send follows the live preference and independent canonical calls remain separate", async () => {
  const f = await fixture({
    provider: "test",
    async *stream(request) {
      if (!request.signal.aborted)
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      yield { type: "text_delta", delta: "stopped" };
    },
  });
  let active: { id: string; done: Promise<void> } | undefined;
  let target = "";
  try {
    target = (await f.client.request("thread/start", {})).thread.id;
    active = await f.app.startTurn(target, "work");
    let preference: "queue" | "soft" | "hard" = "soft";
    const control = new ZenXSelfControlCapabilityPackage({
      appServer: f.port,
      sendPreference: async () => preference,
    });
    const send = async (canonicalToolCallId: string) =>
      (await control.invoke("zenx_threads_send", {
        name: "zenx_threads_send",
        arguments: { target, text: "same text" },
        callId: "provider-reuses-this",
        canonicalToolCallId,
        threadId: "source",
        cwd: process.cwd(),
        signal: new AbortController().signal,
      })) as { mode: string; clientUserMessageId: string };
    const first = await send("canonical-1");
    assert.equal(first.mode, "steer");
    preference = "queue";
    const second = await send("canonical-2");
    assert.equal(second.mode, "queue");
    assert.notEqual(first.clientUserMessageId, second.clientUserMessageId);
    const again = await send("canonical-2");
    assert.equal(again.clientUserMessageId, second.clientUserMessageId);
    const snapshot = await f.app.readThread(target);
    assert.equal(
      snapshot.items.filter((item) => item.type === "user_message_queued")
        .length,
      1,
    );
  } finally {
    if (active) {
      await f.app.interruptTurn(target, active.id);
      await active.done;
    }
    // Interrupting pauses the durable queue; no new wait/queue implementation lives here.
    await f.close();
  }
});
