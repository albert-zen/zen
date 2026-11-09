import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import {
  JsonlThreadJournal,
  InMemoryThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import { pendingNextTurnMessages } from "../src/steer-recall.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime, type RunTurnOptions } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";

import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { png1x1 } from "./fixtures.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function completed(server: ZenAppServer) {
  return new Promise<void>((resolve) => {
    const unsubscribe = server.subscribe((event) => {
      if (
        event.type === "item_completed" &&
        event.item.type === "turn_completed"
      ) {
        unsubscribe();
        resolve();
      }
    });
  });
}
function createServer(
  journal: ThreadJournal,
  options: {
    runtime?: AgentRuntime;
    attachments?: InMemoryAttachmentStore;
  } = {},
) {
  return new ZenAppServer({
    journal,
    ...(options.attachments === undefined
      ? {}
      : { attachments: options.attachments }),
    runtime:
      options.runtime ??
      new AgentRuntime({
        toolEnvironment: new ToolEnvironment({ runtimes: [] }),
      }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "queue-order",
        adapter: {
          provider: "queue-order",
          async *stream() {
            yield { type: "text_delta" as const, delta: "done" };
          },
        },
        modelCatalog: new StaticModelCatalog([
          {
            id: "fake",
            isDefault: true,
            contextWindow: 32768,
            inputModalities: ["text", "image"],
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: "queue-order",
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}
async function fixture(journal: ThreadJournal = new InMemoryThreadJournal()) {
  const thread = await createServer(journal).startThread();
  for (let i = 0; i < 3; i++)
    await journal.append({
      id: `queued-${i}`,
      threadId: thread.id,
      type: "user_message_queued",
      clientId: `client-${i}`,
      createdAt: "2026-11-08T00:00:00.000Z",
      input: [{ type: "text", text: `message ${i}` }],
      deliveryMode: "batch-next",
    });
  const server = createServer(journal);
  const read = () => server.readThread(thread.id);
  const messages = pendingNextTurnMessages((await read()).items);
  const request = {
    reorderId: "order-op",
    expectedTargets: messages.map((item) => ({
      queuedItemId: item.id,
      clientId: item.clientId,
      expectedRevision: item.revision,
    })),
    orderedQueuedItemIds: messages.map((item) => item.id).reverse(),
  };
  return { journal, server, threadId: thread.id, read, messages, request };
}

test("reorder persists one exact receipt, preserves content and identity, and retries do not resume", async () => {
  const f = await fixture();
  const before = await f.read();
  const result = await f.server.reorderQueuedMessages(f.threadId, f.request);
  assert.equal(result.status, "reordered");
  const after = await f.read();
  assert.equal(after.items.length, before.items.length + 1);
  assert.deepEqual(after.items.slice(0, -1), before.items);
  assert.deepEqual(
    pendingNextTurnMessages(after.items),
    [...f.messages].reverse(),
  );
  assert.equal(after.itemList?.length, before.itemList?.length);
  assert.equal(after.turns.length, 0);
  const retry = await f.server.reorderQueuedMessages(f.threadId, f.request);
  assert.equal(retry.status, "already_reordered");
  assert.equal(retry.reorderItemId, result.reorderItemId);
  assert.equal((await f.read()).items.length, after.items.length);
  await assert.rejects(
    f.server.reorderQueuedMessages(f.threadId, {
      ...f.request,
      orderedQueuedItemIds: f.messages.map((item) => item.id),
    }),
    { code: "idempotency_conflict" },
  );
});

test("JSONL reload retains reordered FIFO and the next Turn consumes that order", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-queue-order-"));
  try {
    const f = await fixture(new JsonlThreadJournal(directory));
    const before = await readFile(
      path.join(directory, `${f.threadId}.jsonl`),
      "utf8",
    );
    await f.server.reorderQueuedMessages(f.threadId, f.request);
    assert(
      (
        await readFile(path.join(directory, `${f.threadId}.jsonl`), "utf8")
      ).startsWith(before),
    );
    const restored = createServer(new JsonlThreadJournal(directory));
    assert.deepEqual(
      pendingNextTurnMessages((await restored.readThread(f.threadId)).items),
      [...f.messages].reverse(),
    );
    assert.equal(
      (await restored.reorderQueuedMessages(f.threadId, f.request)).status,
      "already_reordered",
    );
    const done = completed(restored);
    await restored.resumeQueue(f.threadId);
    await done;
    const after = await restored.readThread(f.threadId);
    assert.deepEqual(
      after.items.flatMap((item) =>
        item.type === "user_message" ? [item.clientId] : [],
      ),
      ["client-2", "client-1", "client-0"],
    );
    assert.deepEqual(pendingNextTurnMessages(after.items), []);
    await assert.rejects(
      restored.reorderQueuedMessages(f.threadId, {
        ...f.request,
        reorderId: "after-consumption",
      }),
      { code: "queue_reorder_conflict" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-base concurrent reorders pick one whole order; exact concurrent retries share one receipt", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.server.reorderQueuedMessages(f.threadId, f.request),
    f.server.reorderQueuedMessages(f.threadId, {
      ...f.request,
      reorderId: "other",
      orderedQueuedItemIds: ["queued-1", "queued-0", "queued-2"],
    }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "queue_reorder_conflict",
    ).length,
    1,
  );
  assert.deepEqual(
    pendingNextTurnMessages((await f.read()).items),
    [...f.messages].reverse(),
  );
  const retries = await Promise.all([
    f.server.reorderQueuedMessages(f.threadId, f.request),
    f.server.reorderQueuedMessages(f.threadId, f.request),
  ]);
  assert.equal(retries[0]?.reorderItemId, retries[1]?.reorderItemId);
  assert.equal(
    (await f.read()).items.filter(
      (item) => item.type === "user_message_queue_reordered",
    ).length,
    1,
  );
});

for (const mutation of ["edit", "cancel"] as const)
  test(`${mutation} and reorder reject stale snapshots without partial changes`, async () => {
    const f = await fixture();
    if (mutation === "edit")
      await f.server.editQueuedMessage(
        f.threadId,
        { ...f.request.expectedTargets[1]!, editId: "edit-before" },
        [{ type: "text", text: "latest" }],
      );
    else
      await f.server.cancelQueuedMessages(f.threadId, [
        f.request.expectedTargets[1]!,
      ]);
    const before = await f.read();
    await assert.rejects(
      f.server.reorderQueuedMessages(f.threadId, f.request),
      { code: "queue_reorder_conflict" },
    );
    assert.deepEqual((await f.read()).items, before.items);
  });

test("reorder-first preserves later content editing and cancellation on the same identities", async () => {
  const f = await fixture();
  await f.server.reorderQueuedMessages(f.threadId, f.request);
  await f.server.editQueuedMessage(
    f.threadId,
    { ...f.request.expectedTargets[1]!, editId: "edit-after" },
    [{ type: "text", text: "latest" }],
  );
  await f.server.cancelQueuedMessages(f.threadId, [
    f.request.expectedTargets[0]!,
  ]);
  const current = pendingNextTurnMessages((await f.read()).items);
  assert.deepEqual(
    current.map((item) => item.id),
    ["queued-2", "queued-1"],
  );
  assert.equal(current[1]?.revision, 1);
  assert.deepEqual(current[1]?.input, [{ type: "text", text: "latest" }]);
});

test("a no-op order still creates one durable idempotent receipt without changing input revisions", async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    orderedQueuedItemIds: f.messages.map((item) => item.id),
  };
  const result = await f.server.reorderQueuedMessages(f.threadId, request);
  assert.equal(result.status, "reordered");
  assert.deepEqual(pendingNextTurnMessages((await f.read()).items), f.messages);
  assert.equal(
    (await f.server.reorderQueuedMessages(f.threadId, request)).reorderItemId,
    result.reorderItemId,
  );
});

for (const persisted of [false, true])
  test(`reorder append failure ${persisted ? "after" : "before"} persistence is read-recoverable without auto-replay`, async () => {
    const f = await fixture();
    const append = f.journal.append.bind(f.journal);
    f.journal.append = async (item) => {
      if (item.type === "user_message_queue_reordered") {
        if (persisted) await append(item);
        throw new Error("synthetic unknown reorder");
      }
      await append(item);
    };
    await assert.rejects(
      f.server.reorderQueuedMessages(f.threadId, f.request),
      /synthetic unknown reorder/,
    );
    const after = await f.read();
    assert.deepEqual(
      pendingNextTurnMessages(after.items),
      persisted ? [...f.messages].reverse() : f.messages,
    );
    assert.equal(
      after.items.filter((item) => item.type === "user_message_queue_reordered")
        .length,
      persisted ? 1 : 0,
    );
    assert.equal(after.turns.length, 0);
    if (persisted)
      assert.equal(
        (await f.server.reorderQueuedMessages(f.threadId, f.request)).status,
        "already_reordered",
      );
  });

test("native reorder validates initialization, emits its exact receipt and reports unknown outcomes", async () => {
  const f = await fixture();
  const projection = new NativeRecoveryProjection(f.server, {
    processEpoch: "order-test",
  });
  const messages: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: f.server,
    projection,
    send: (message) => {
      messages.push(message);
    },
  });
  try {
    const params = { threadId: f.threadId, ...f.request };
    await connection.receive({
      id: 1,
      method: "zen/thread/queue/reorder",
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
      method: "zen/thread/queue/reorder",
      params: { ...params, orderedQueuedItemIds: ["queued-0"] },
    });
    assert(
      messages.some(
        (message) =>
          "id" in message &&
          message.id === 3 &&
          "error" in message &&
          message.error.code === -32602,
      ),
    );
    await connection.receive({
      id: 4,
      method: "zen/thread/queue/reorder",
      params,
    });
    assert(
      messages.some(
        (message) =>
          "id" in message &&
          message.id === 4 &&
          "result" in message &&
          (message.result as { status: string }).status === "reordered",
      ),
    );
    assert(
      messages.some(
        (message) =>
          "method" in message &&
          message.method === "zen/thread/event" &&
          JSON.stringify(message).includes("user_message_queue_reordered"),
      ),
    );
    const current = pendingNextTurnMessages((await f.read()).items);
    const next = {
      threadId: f.threadId,
      reorderId: "unknown",
      expectedTargets: current.map((item) => ({
        queuedItemId: item.id,
        clientId: item.clientId,
        expectedRevision: item.revision,
      })),
      orderedQueuedItemIds: current.map((item) => item.id).reverse(),
    };
    f.journal.append = async () => {
      throw new Error("synthetic unknown");
    };
    await connection.receive({
      id: 5,
      method: "zen/thread/queue/reorder",
      params: next,
    });
    assert(
      messages.some(
        (message) =>
          "id" in message &&
          message.id === 5 &&
          "error" in message &&
          message.error.code === -32603,
      ),
    );
    assert.equal(
      (await f.read()).items.filter(
        (item) => item.type === "user_message_queue_reordered",
      ).length,
      1,
    );
  } finally {
    connection.close();
    projection.close();
  }
});

test("launch reservations fence reorder before the first input is canonical", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  const runtime = new (class extends AgentRuntime {
    override async runTurn(options: RunTurnOptions) {
      entered.resolve();
      await release.promise;
      await super.runTurn(options);
    }
  })({ toolEnvironment: new ToolEnvironment({ runtimes: [] }) });
  const server = createServer(f.journal, { runtime });
  const done = completed(server),
    resume = server.resumeQueue(f.threadId);
  await entered.promise;
  try {
    await assert.rejects(server.reorderQueuedMessages(f.threadId, f.request), {
      code: "queue_reorder_conflict",
    });
    assert.equal(
      (await server.readThread(f.threadId)).items.filter(
        (item) => item.type === "user_message",
      ).length,
      0,
    );
  } finally {
    release.resolve();
    await resume;
    await done;
  }
});

test("reorder during image preflight recaptures FIFO instead of admitting the old order", async () => {
  const f = await fixture();
  const attachments = new InMemoryAttachmentStore();
  const image = await attachments.importBytes(png1x1());
  const server = createServer(f.journal, { attachments });
  await server.editQueuedMessage(
    f.threadId,
    { ...f.request.expectedTargets[1]!, editId: "image" },
    [{ type: "image", attachment: image }],
  );
  const current = pendingNextTurnMessages(
    (await server.readThread(f.threadId)).items,
  );
  const request = {
    ...f.request,
    expectedTargets: current.map((item) => ({
      queuedItemId: item.id,
      clientId: item.clientId,
      expectedRevision: item.revision,
    })),
  };
  const entered = deferred(),
    release = deferred(),
    read = attachments.read.bind(attachments);
  let block = true;
  attachments.read = async (ref) => {
    if (block) {
      block = false;
      entered.resolve();
      await release.promise;
    }
    return await read(ref);
  };
  const done = completed(server),
    resume = server.resumeQueue(f.threadId);
  await entered.promise;
  try {
    await server.reorderQueuedMessages(f.threadId, request);
  } finally {
    release.resolve();
    await resume;
    await done;
  }
  assert.deepEqual(
    (await server.readThread(f.threadId)).items.flatMap((item) =>
      item.type === "user_message" ? [item.clientId] : [],
    ),
    ["client-2", "client-1", "client-0"],
  );
});

test("Domain journal restores promotion/order controls without semantic ItemList entries and recalls exact revisions", async () => {
  const { DomainThreadJournal } = await import("../src/domain-journal.js");
  const { FileTraceStore } = await import("../src/trace.js");
  const { pendingSteerMessages } = await import("../src/steer-recall.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-order-domain-"));
  const options = {
    directory: path.join(root, "threads"),
    trace: new FileTraceStore(path.join(root, "trace")),
    metadata: new InMemoryThreadMetadataStore(),
  };
  let journal = new DomainThreadJournal(options);
  try {
    const f = await fixture(journal);
    await f.server.reorderQueuedMessages(f.threadId, f.request);
    await journal.append({
      id: "promoted",
      type: "user_message_queue_promoted",
      threadId: f.threadId,
      createdAt: "2026-11-08T00:00:00.000Z",
      queuedItemId: "queued-1",
      clientId: "client-1",
      expectedRevision: 0,
      expectedTurnId: "old-turn",
    });
    const before = await journal.read(f.threadId);
    assert.deepEqual(await journal.readItemList(f.threadId), []);
    await journal.close();
    journal = new DomainThreadJournal(options);
    assert.deepEqual(await journal.read(f.threadId), before);
    const restored = createServer(journal),
      snapshot = await restored.readThread(f.threadId);
    assert.deepEqual(
      pendingNextTurnMessages(snapshot.items).map((item) => item.id),
      ["queued-2", "queued-0"],
    );
    const steer = pendingSteerMessages(snapshot.items);
    assert.equal(steer[0]?.revision, 1);
    const result = await restored.recallSteerMessages(f.threadId, {
      recallId: "domain-recall",
      targets: steer.map((item) => ({
        queuedItemId: item.id,
        clientId: item.clientId,
        expectedRevision: item.revision,
      })),
    });
    assert.deepEqual(result.messages, steer);
    assert.deepEqual(await journal.readItemList(f.threadId), []);
    await journal.close();
    journal = new DomainThreadJournal(options);
    const cold = createServer(journal);
    assert.deepEqual(
      (
        await cold.recallSteerMessages(f.threadId, {
          recallId: "domain-recall",
          targets: steer.map((item) => ({
            queuedItemId: item.id,
            clientId: item.clientId,
            expectedRevision: item.revision,
          })),
        })
      ).messages,
      steer,
    );
    assert.deepEqual(
      pendingSteerMessages((await cold.readThread(f.threadId)).items),
      [],
    );
  } finally {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fork and side-chat remap control item references while preserving the copied Turn binding and parent order", async () => {
  const { pendingSteerMessages } = await import("../src/steer-recall.js");
  const f = await fixture();
  await f.server.reorderQueuedMessages(f.threadId, f.request);
  const base = { threadId: f.threadId, createdAt: "2026-11-08T00:00:00.000Z" };
  await f.journal.append({
    ...base,
    id: "turn-start",
    type: "turn_started",
    turnId: "original-turn",
  });
  await f.journal.append({
    ...base,
    id: "user",
    type: "user_message",
    turnId: "original-turn",
    text: "initial",
  });
  await f.journal.append({
    ...base,
    id: "promoted",
    type: "user_message_queue_promoted",
    queuedItemId: "queued-1",
    clientId: "client-1",
    expectedRevision: 0,
    expectedTurnId: "original-turn",
  });
  await f.journal.append({
    ...base,
    id: "agent",
    type: "agent_message",
    turnId: "original-turn",
    text: "done",
  });
  await f.journal.append({
    ...base,
    id: "terminal",
    type: "turn_completed",
    turnId: "original-turn",
    status: "completed",
  });
  const server = createServer(f.journal);
  const before = await server.readThread(f.threadId);
  const side = await server.createChildThread({
    parentThreadId: f.threadId,
    mode: "side-chat",
  });
  const fork = await server.forkThread({
    sourceThreadId: f.threadId,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  for (const copy of [side, fork]) {
    const anchors = copy.items.filter(
      (item) => item.type === "user_message_queued",
    );
    const byClient = new Map(anchors.map((item) => [item.clientId, item.id]));
    const order = copy.items.find(
      (item) => item.type === "user_message_queue_reordered",
    );
    assert(order?.type === "user_message_queue_reordered");
    assert.deepEqual(
      order.expectedTargets.map((target) => target.queuedItemId),
      ["client-0", "client-1", "client-2"].map((client) =>
        byClient.get(client),
      ),
    );
    assert.deepEqual(
      order.orderedQueuedItemIds,
      ["client-2", "client-1", "client-0"].map((client) =>
        byClient.get(client),
      ),
    );
    const promoted = copy.items.find(
      (item) => item.type === "user_message_queue_promoted",
    );
    assert(promoted?.type === "user_message_queue_promoted");
    assert.equal(promoted.queuedItemId, byClient.get("client-1"));
    assert.notEqual(promoted.queuedItemId, "queued-1");
    assert.equal(
      promoted.expectedTurnId,
      copy.items.find((item) => item.type === "turn_started")?.turnId,
    );
    if (copy === side) assert.deepEqual(pendingSteerMessages(copy.items), []);
    assert(
      !JSON.stringify(copy.itemList).includes("user_message_queue_promoted"),
    );
    assert(
      !JSON.stringify(copy.itemList).includes("user_message_queue_reordered"),
    );
  }
  assert.deepEqual((await server.readThread(f.threadId)).items, before.items);
  assert.deepEqual(
    pendingNextTurnMessages(before.items).map((item) => item.id),
    ["queued-2", "queued-0"],
  );
});

test("reorder includes User, Agent and Host Queue but excludes pending User Steer", async () => {
  const { pendingSteerMessages } = await import("../src/steer-recall.js");
  const f = await fixture();
  const base = { threadId: f.threadId, createdAt: "2026-11-08T00:00:00.000Z" };
  await f.journal.append({
    ...base,
    id: "agent-queue",
    type: "thread_message_queued",
    clientId: "agent-client",
    messageType: "follow_up",
    sender: {
      threadId: "remote",
      threadName: "Planner",
      toolCallId: "tool",
      callId: "call",
      turnId: "turn",
      deviceId: "device",
    },
    input: [{ type: "text", text: "agent follow up" }],
    deliveryMode: "batch-next",
  });
  await f.journal.append({
    ...base,
    id: "host-queue",
    type: "host_message_queued",
    clientId: "host-client",
    sender: "host",
    source: "trigger",
    sourceId: "trigger",
    text: "host follow up",
    input: [{ type: "text", text: "host follow up" }],
    intent: "queue",
    deliveryMode: "batch-next",
  });
  await f.journal.append({
    ...base,
    id: "held-steer",
    type: "user_message_queued",
    clientId: "held-client",
    input: [{ type: "text", text: "held" }],
    deliveryMode: "steer",
    expectedTurnId: "old-turn",
  });
  const server = createServer(f.journal),
    before = await server.readThread(f.threadId),
    current = pendingNextTurnMessages(before.items);
  const request = {
    reorderId: "mixed",
    expectedTargets: current.map((item) => ({
      queuedItemId: item.id,
      clientId: item.clientId,
      expectedRevision: item.revision,
    })),
    orderedQueuedItemIds: current.map((item) => item.id).reverse(),
  };
  await server.reorderQueuedMessages(f.threadId, request);
  const after = await server.readThread(f.threadId);
  assert.deepEqual(
    pendingNextTurnMessages(after.items),
    [...current].reverse(),
  );
  assert.deepEqual(
    pendingSteerMessages(after.items),
    pendingSteerMessages(before.items),
  );
  assert.deepEqual(after.items.slice(0, -1), before.items);
  const all = [...current, ...pendingSteerMessages(after.items)];
  await assert.rejects(
    server.reorderQueuedMessages(f.threadId, {
      reorderId: "move-steer",
      expectedTargets: all.map((item) => ({
        queuedItemId: item.id,
        clientId: item.clientId,
        expectedRevision: item.revision,
      })),
      orderedQueuedItemIds: all.map((item) => item.id),
    }),
    { code: "queue_reorder_conflict" },
  );
});
