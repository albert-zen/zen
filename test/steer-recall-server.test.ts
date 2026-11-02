import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import {
  pendingSteerMessages,
  recoverSteerRecall,
} from "../src/steer-recall.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import type { CanonicalItem } from "../src/item.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";

async function fixture(count = 2) {
  const journal = new InMemoryThreadJournal();
  let modelCalls = 0;
  const makeServer = () =>
    new ZenAppServer({
      journal,
      runtime: new AgentRuntime({
        toolEnvironment: new ToolEnvironment({ runtimes: [] }),
      }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "recall-test",
          adapter: {
            provider: "recall-test",
            async *stream() {
              modelCalls++;
              yield {
                type: "text_delta" as const,
                delta: "unexpected model call",
              };
            },
          },
          modelCatalog: new StaticModelCatalog([
            {
              id: "fake",
              isDefault: true,
              contextWindow: 32768,
              inputModalities: ["text"],
            },
          ]),
        },
      ]),
      threadMetadata: new InMemoryThreadMetadataStore(),
      defaults: {
        cwd: os.tmpdir(),
        providerProfileId: "recall-test",
        modelId: "fake",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
  const thread = await makeServer().startThread();
  for (let index = 0; index < count; index++)
    await journal.append({
      id: `queued-${index}`,
      type: "user_message_queued",
      threadId: thread.id,
      createdAt: "2026-11-02T00:00:00.000Z",
      clientId: `client-${index}`,
      input: [{ type: "text", text: `message ${index}` }],
      deliveryMode: "steer",
      expectedTurnId: "previous-turn",
    });
  // Reload after constructing only synthetic held-input facts.
  const server = makeServer();
  const read = async () => await journal.read(thread.id);
  const messages = pendingSteerMessages(await read());
  const request = {
    recallId: "recall-op",
    targets: messages.map((message) => ({
      queuedItemId: message.id,
      clientId: message.clientId,
      expectedRevision: message.revision,
    })),
  };
  return {
    journal,
    server,
    threadId: thread.id,
    read,
    request,
    modelCalls: () => modelCalls,
  };
}

test("recall commits one batch receipt, preserves source and never starts a Turn", async () => {
  const f = await fixture(300);
  const before = await f.read();
  const result = await f.server.recallSteerMessages(f.threadId, f.request);
  assert.equal(result.status, "recalled");
  assert.equal(result.messages.length, 300);
  const after = await f.read();
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(pendingSteerMessages(after), []);
  assert.equal(f.modelCalls(), 0);
  const again = await f.server.recallSteerMessages(f.threadId, {
    ...f.request,
    targets: [...f.request.targets].reverse(),
  });
  assert.equal(again.status, "already_recalled");
  assert.equal(again.receipt.id, result.receipt.id);
  assert.deepEqual(again.messages, result.messages);
  assert.equal((await f.read()).length, after.length);
  await assert.rejects(
    f.server.recallSteerMessages(f.threadId, {
      ...f.request,
      targets: [f.request.targets[0]!],
    }),
    { code: "idempotency_conflict" },
  );
});

test("stale revision conflicts the whole snapshot without changing any input", async () => {
  const f = await fixture();
  const before = await f.read();
  await assert.rejects(
    f.server.recallSteerMessages(f.threadId, {
      ...f.request,
      targets: f.request.targets.map((target, index) => ({
        ...target,
        expectedRevision: index,
      })),
    }),
    { code: "steer_recall_conflict" },
  );
  assert.deepEqual(await f.read(), before);
});

test("concurrent distinct recalls choose one complete batch", async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled([
    f.server.recallSteerMessages(f.threadId, f.request),
    f.server.recallSteerMessages(f.threadId, {
      ...f.request,
      recallId: "other",
    }),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  const receipts = (await f.read()).filter(
    (item) => item.type === "user_message_steer_recalled",
  );
  assert.equal(receipts.length, 1);
  assert.deepEqual(pendingSteerMessages(await f.read()), []);
});

for (const persisted of [false, true])
  test(`recall failure ${persisted ? "after" : "before"} persistence is read-recoverable, never replayed`, async () => {
    const f = await fixture();
    const append = f.journal.append.bind(f.journal);
    f.journal.append = async (item: CanonicalItem) => {
      if (item.type === "user_message_steer_recalled") {
        if (persisted) await append(item);
        throw new Error("synthetic append outcome unknown");
      }
      await append(item);
    };
    await assert.rejects(
      f.server.recallSteerMessages(f.threadId, f.request),
      /synthetic append outcome unknown/,
    );
    const items = await f.read();
    const snapshot = await f.server.readThread(f.threadId);
    assert.deepEqual(snapshot.items, items);
    const recovered = recoverSteerRecall(items, f.threadId, f.request.recallId);
    assert.equal(recovered !== undefined, persisted);
    assert.equal(pendingSteerMessages(items).length, persisted ? 0 : 2);
    assert.equal(f.modelCalls(), 0);
  });

test("native recall requires initialization and emits the exact control receipt", async () => {
  const f = await fixture();
  const projection = new NativeRecoveryProjection(f.server);
  const messages: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: f.server,
    projection,
    send: (message) => {
      messages.push(message);
    },
  });
  const params = { threadId: f.threadId, ...f.request };
  try {
    await connection.receive({
      id: 1,
      method: "zen/thread/steer/recall",
      params,
    });
    assert(
      messages.some(
        (message) =>
          "id" in message &&
          message.id === 1 &&
          "error" in message &&
          message.error.code === -32600,
      ),
    );
    await connection.receive({ id: 2, method: "zen/initialize", params: {} });
    await connection.receive({
      id: 3,
      method: "zen/thread/steer/recall",
      params,
    });
    assert(
      messages.some(
        (message) =>
          "id" in message &&
          message.id === 3 &&
          "result" in message &&
          (message.result as { status: string }).status === "recalled",
      ),
    );
    assert(
      messages.some(
        (message) =>
          "method" in message &&
          message.method === "zen/thread/event" &&
          JSON.stringify(message).includes("user_message_steer_recalled"),
      ),
    );
  } finally {
    connection.close();
    projection.close();
  }
});

test("one unsupported restore shape rejects the entire batch without mutation", async () => {
  const f = await fixture();
  await f.journal.append({
    id: "edited",
    type: "user_message_queue_edited",
    threadId: f.threadId,
    createdAt: "2026-11-02T00:00:00.000Z",
    queuedItemId: "queued-1",
    clientId: "client-1",
    editId: "edit",
    revision: 1,
    input: [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ],
  });
  const before = await f.read();
  await assert.rejects(
    f.server.recallSteerMessages(f.threadId, {
      ...f.request,
      targets: f.request.targets.map((target, index) => ({
        ...target,
        expectedRevision: index,
      })),
    }),
    { code: "steer_recall_unsupported_input" },
  );
  assert.deepEqual(await f.read(), before);
});
