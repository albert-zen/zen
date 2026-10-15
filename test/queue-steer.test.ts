import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenAppServer, type QueuedSteerTarget } from "../src/app-server.js";
import {
  InMemoryAttachmentStore,
  type AttachmentStore,
} from "../src/attachment.js";
import {
  pendingQueuedMessages,
  type PendingQueuedUserMessage,
} from "../src/input-queue.js";
import {
  textFromUserInput,
  type CanonicalItem,
  type UserInput,
} from "../src/item.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { type ModelAdapter, type ModelEvent } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { type JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import { AgentRuntime, type RunTurnOptions } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import { png1x1 } from "./fixtures.js";

const text = (value: string): UserInput => [{ type: "text", text: value }];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function createServer(options: {
  journal: ThreadJournal;
  attachments?: AttachmentStore;
  runtime?: AgentRuntime;
  model?: ModelAdapter;
  images?: boolean;
}) {
  const model = options.model ?? {
    provider: "queue-edit",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", delta: "done" };
    },
  };
  return new ZenAppServer({
    journal: options.journal,
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
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "fake",
            isDefault: true,
            contextWindow: 32768,
            inputModalities:
              options.images === false ? ["text"] : ["text", "image"],
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}
async function paused(
  inputs: readonly UserInput[] = [text("alpha"), text("beta")],
  options: Partial<Parameters<typeof createServer>[0]> = {},
) {
  const journal = options.journal ?? new InMemoryThreadJournal();
  const thread = await createServer({ ...options, journal }).startThread();
  for (const [index, input] of inputs.entries())
    await journal.append({
      id: `queued-${index}`,
      threadId: thread.id,
      type: "user_message_queued",
      createdAt: "2026-10-12T00:00:00.000Z",
      clientId: `client-${index}`,
      input,
      deliveryMode: "batch-next",
    });
  const server = createServer({ ...options, journal });
  const read = async () => await server.readThread(thread.id);
  return {
    journal,
    server,
    threadId: thread.id,
    read,
    queued: pendingQueuedMessages((await read()).items),
  };
}
function steerTarget(item: PendingQueuedUserMessage): QueuedSteerTarget {
  return {
    queuedItemId: item.id,
    clientId: item.clientId,
    expectedRevision: item.revision,
  };
}
test("send-now atomically admits the selected queued identity and exact retries do not duplicate", async () => {
  const queue = await paused();
  const target = steerTarget(queue.queued[1]!);
  const results = await Promise.all([
    queue.server.steerQueuedMessage(queue.threadId, target),
    queue.server.steerQueuedMessage(queue.threadId, target),
  ]);
  const snapshot = await queue.read();
  const delivered = snapshot.items.filter(
    (item) => item.type === "user_message" && item.clientId === target.clientId,
  );
  assert.equal(delivered.length, 1);
  assert.equal(results[0]!.turnId, results[1]!.turnId);
  assert.equal(
    snapshot.items.filter(
      (item) => item.type === "user_message_queue_cancelled",
    ).length,
    0,
  );
  assert.deepEqual(
    snapshot.items.find((item) => item.id === target.queuedItemId),
    queue.queued[1] &&
      (({ revision, ...original }) => original)(queue.queued[1]),
  );
});

async function runningQueue(
  options: Partial<Parameters<typeof createServer>[0]> = {},
) {
  const sampled = deferred();
  const release = deferred();
  let samples = 0;
  const model: ModelAdapter = {
    provider: "queue-steer",
    async *stream() {
      if (samples++ === 0) {
        sampled.resolve();
        await release.promise;
      }
      yield { type: "text_delta", delta: "done" };
    },
  };
  const journal = options.journal ?? new InMemoryThreadJournal();
  const server = createServer({ ...options, journal, model });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "initial");
  await sampled.promise;
  return {
    journal,
    server,
    threadId: thread.id,
    turn,
    release,
    read: () => server.readThread(thread.id),
  };
}

test("active promotion preserves edited images, original timestamp and client identity at a safe point", async () => {
  const attachments = new InMemoryAttachmentStore();
  const q = await runningQueue({ attachments });
  try {
    const image = await q.server.importImageBytes(png1x1());
    await q.server.queueMessage(q.threadId, text("original"), "queued-user");
    let queued = pendingQueuedMessages((await q.read()).items)[0]!;
    const original = (await q.read()).items.find(
      (item) => item.id === queued.id,
    );
    const content: UserInput = [
      ...text("edited"),
      { type: "image", attachment: image },
    ];
    await q.server.editQueuedMessage(
      q.threadId,
      { ...steerTarget(queued), editId: "edit-before-steer" },
      content,
    );
    queued = pendingQueuedMessages((await q.read()).items)[0]!;
    const result = await q.server.steerQueuedMessage(
      q.threadId,
      steerTarget(queued),
    );
    assert.equal(result.status, "steered");
    assert.equal(result.turnId, q.turn.id);
    const after = await q.read();
    assert.equal(pendingQueuedMessages(after.items).length, 0);
    assert.deepEqual(
      after.items.find((item) => item.id === queued.id),
      original,
    );
    const delivered = after.items.find(
      (item) =>
        item.type === "user_message" && item.clientId === queued.clientId,
    );
    assert(delivered?.type === "user_message");
    assert.deepEqual(delivered.content, content);
    assert.ok(delivered.deliveryAfter);
    assert(
      !after.items.some((item) => item.type === "user_message_queue_cancelled"),
    );
  } finally {
    q.release.resolve();
    await q.turn.done;
  }
});

for (const source of ["thread", "host"] as const)
  test(`${source} queue promotion preserves remote sender or Host provenance`, async () => {
    const journal = new InMemoryThreadJournal();
    const base = createServer({ journal });
    const thread = await base.startThread();
    const original:
      | import("../src/item.js").QueuedThreadMessageItem
      | import("../src/item.js").QueuedHostMessageItem =
      source === "thread"
        ? {
            id: "queued-origin",
            threadId: thread.id,
            type: "thread_message_queued",
            clientId: "origin-client",
            createdAt: "2026-10-10T01:02:03.000Z",
            messageType: "follow_up",
            deliveryMode: "batch-next",
            input: text("from another thread"),
            sender: {
              threadId: "remote-thread",
              threadName: "Synthetic planner",
              toolCallId: "tool",
              callId: "call",
              turnId: "turn",
              deviceId: "remote-device",
            },
          }
        : {
            id: "queued-origin",
            threadId: thread.id,
            type: "host_message_queued",
            sender: "host",
            clientId: "origin-client",
            createdAt: "2026-10-10T01:02:03.000Z",
            source: "trigger",
            sourceId: "synthetic-trigger",
            text: "Scheduled update",
            input: text("Scheduled update"),
            intent: "queue",
            deliveryMode: "batch-next",
          };
    await journal.append(original);
    const server = createServer({ journal });
    const result = await server.steerQueuedMessage(thread.id, {
      queuedItemId: original.id,
      clientId: original.clientId,
      expectedRevision: 0,
    });
    const snapshot = await server.readThread(thread.id);
    const delivered = snapshot.items.find(
      (item) =>
        (item.type === "thread_message" || item.type === "host_message") &&
        item.clientId === original.clientId,
    );
    assert.ok(delivered);
    assert.equal(result.status, "started");
    assert.deepEqual(
      snapshot.items.find((item) => item.id === original.id),
      original,
    );
    if (source === "thread") {
      assert(
        delivered.type === "thread_message" &&
          original.type === "thread_message_queued",
      );
      assert.deepEqual(delivered.sender, original.sender);
      assert.deepEqual(delivered.content, original.input);
    } else {
      assert(
        delivered.type === "host_message" &&
          original.type === "host_message_queued",
      );
      assert.equal(delivered.source, original.source);
      assert.equal(delivered.sourceId, original.sourceId);
    }
  });

test("promotion races final response and normal draining without loss or duplicate", async () => {
  for (let index = 0; index < 12; index++) {
    const q = await runningQueue();
    await q.server.queueMessage(q.threadId, "queued", "race");
    const queued = pendingQueuedMessages((await q.read()).items)[0]!;
    q.release.resolve();
    const results = await Promise.all([
      q.server.steerQueuedMessage(q.threadId, steerTarget(queued)),
      q.server.steerQueuedMessage(q.threadId, steerTarget(queued)),
      q.server.resumeQueue(q.threadId),
    ]);
    await q.turn.done;
    const after = await q.read();
    assert.equal(
      after.items.filter(
        (item) => item.type === "user_message" && item.clientId === "race",
      ).length,
      1,
    );
    assert.equal(results[0]!.turnId, results[1]!.turnId);
  }
});

test("cancel-first and edit-first reject promotion rather than revive or send unseen input", async () => {
  const q = await paused();
  await q.server.cancelQueuedMessages(q.threadId, [steerTarget(q.queued[0]!)]);
  await assert.rejects(
    q.server.steerQueuedMessage(q.threadId, steerTarget(q.queued[0]!)),
    { code: "queue_cancelled" },
  );
  await q.server.editQueuedMessage(
    q.threadId,
    { ...steerTarget(q.queued[1]!), editId: "revision" },
    text("new revision"),
  );
  await assert.rejects(
    q.server.steerQueuedMessage(q.threadId, steerTarget(q.queued[1]!)),
    { code: "queue_revision_conflict" },
  );
  assert.equal((await q.read()).turns.length, 0);
});

test("in-progress initial admission is awaited outside the lock and the same identity starts once", async () => {
  const entered = deferred(),
    release = deferred();
  const runtime = new (class extends AgentRuntime {
    override async runTurn(options: RunTurnOptions) {
      entered.resolve();
      await release.promise;
      await super.runTurn(options);
    }
  })({ toolEnvironment: new ToolEnvironment({ runtimes: [] }) });
  const q = await paused([text("reserved")], { runtime });
  const resumed = q.server.resumeQueue(q.threadId);
  await entered.promise;
  const promoted = q.server.steerQueuedMessage(
    q.threadId,
    steerTarget(q.queued[0]!),
  );
  let settled = false;
  void promoted.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release.resolve();
  const [, result] = await Promise.all([resumed, promoted]);
  assert.equal(result.status, "already_started");
  assert.equal(
    (await q.read()).items.filter((item) => item.type === "user_message")
      .length,
    1,
  );
});

test("canonical promotion receipt survives JSONL reload and does not send again", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "queue-steer-"));
  try {
    const journal = new JsonlThreadJournal(directory);
    const q = await paused([text("saved")], { journal });
    const first = await q.server.steerQueuedMessage(
      q.threadId,
      steerTarget(q.queued[0]!),
    );
    const restored = createServer({
      journal: new JsonlThreadJournal(directory),
    });
    const second = await restored.steerQueuedMessage(
      q.threadId,
      steerTarget(q.queued[0]!),
    );
    assert.equal(second.status, "already_started");
    assert.equal(first.turnId, second.turnId);
    assert.equal(
      (await restored.readThread(q.threadId)).items.filter(
        (item) => item.type === "user_message",
      ).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("image validation failure leaves the original queue available without cancellation", async () => {
  const store = new InMemoryAttachmentStore();
  const ref = await store.importBytes(png1x1());
  const q = await paused([[{ type: "image", attachment: ref }]], {
    attachments: new InMemoryAttachmentStore(),
  });
  await assert.rejects(
    q.server.steerQueuedMessage(q.threadId, steerTarget(q.queued[0]!)),
    { code: "attachment_missing" },
  );
  assert.deepEqual(pendingQueuedMessages((await q.read()).items), q.queued);
  assert.equal((await q.read()).turns.length, 0);
});

test("native queue steer validates initialization and identity and publishes canonical delivery", async () => {
  const q = await paused([text("native")]);
  const projection = new NativeRecoveryProjection(q.server, {
    processEpoch: "queue-steer",
  });
  const messages: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: q.server,
    projection,
    send: (message) => {
      messages.push(message);
    },
  });
  const params = { threadId: q.threadId, ...steerTarget(q.queued[0]!) };
  try {
    await connection.receive({
      id: 1,
      method: "zen/thread/queue/steer",
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
      method: "zen/thread/queue/steer",
      params: { ...params, expectedRevision: -1 },
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
      method: "zen/thread/queue/steer",
      params,
    });
    assert(
      messages.some(
        (message) =>
          "id" in message &&
          message.id === 4 &&
          "result" in message &&
          (message.result as { status: string }).status === "started",
      ),
    );
    assert(
      messages.some(
        (message) =>
          "method" in message &&
          message.method === "zen/thread/event" &&
          JSON.stringify(message).includes('"type":"user_message"'),
      ),
    );
    await connection.receive({
      id: 5,
      method: "zen/thread/queue/steer",
      params,
    });
    assert(
      messages.some(
        (message) =>
          "id" in message &&
          message.id === 5 &&
          "result" in message &&
          (message.result as { status: string }).status === "already_started",
      ),
    );
  } finally {
    connection.close();
    projection.close();
  }
});

test("promotion-first excludes a later edit and cancel while image validation holds the mutation fence", async () => {
  const attachments = new InMemoryAttachmentStore();
  const q = await runningQueue({ attachments });
  const entered = deferred(),
    release = deferred();
  try {
    const ref = await q.server.importImageBytes(png1x1());
    await q.server.queueMessage(
      q.threadId,
      [{ type: "image", attachment: ref }],
      "image-race",
    );
    const queued = pendingQueuedMessages((await q.read()).items)[0]!;
    const read = attachments.read.bind(attachments);
    let block = true;
    attachments.read = async (ref) => {
      if (block) {
        block = false;
        entered.resolve();
        await release.promise;
      }
      return read(ref);
    };
    const promoted = q.server.steerQueuedMessage(
      q.threadId,
      steerTarget(queued),
    );
    await entered.promise;
    const edit = q.server.editQueuedMessage(
      q.threadId,
      { ...steerTarget(queued), editId: "late" },
      text("late"),
    );
    const cancelled = q.server.cancelQueuedMessages(q.threadId, [
      steerTarget(queued),
    ]);
    release.resolve();
    assert.equal((await promoted).status, "steered");
    await assert.rejects(edit, { code: "queue_already_started" });
    assert.equal((await cancelled)[0]!.status, "already_started");
    assert.equal(
      (await q.read()).items.filter(
        (item) =>
          item.type === "user_message" && item.clientId === queued.clientId,
      ).length,
      1,
    );
  } finally {
    release.resolve();
    q.release.resolve();
    await q.turn.done;
  }
});

test("RemoteHost omitted mode steers independently and explicit remote follow-up can be promoted with authenticated provenance", async () => {
  const { RemoteHostAccess } =
    await import("../src/protocol/native/remote-host.js");
  const q = await runningQueue();
  const remote = new RemoteHostAccess({
    appServer: q.server,
    hostId: "receiver",
    access: "control",
    workspaces: () => [
      { id: "workspace", cwd: os.tmpdir(), label: "Synthetic" },
    ],
  });
  try {
    const paired = await remote.pair({
      hostId: "receiver",
      deviceId: "peer",
      code: remote.createPairingCode(),
    });
    const base = {
      workspaceId: "workspace",
      threadId: q.threadId,
      sender: {
        threadId: "remote-thread",
        toolCallId: "remote-tool",
        callId: "remote-call",
      },
    };
    const guidance = await remote.send("peer", paired.token, {
      ...base,
      clientId: "remote-default",
      text: "normal message",
    });
    assert.equal(guidance.turnId, q.turn.id);
    assert.equal(guidance.queued, false);
    const queued = await remote.send("peer", paired.token, {
      ...base,
      sender: { ...base.sender, toolCallId: "remote-follow-up" },
      clientId: "remote-queued",
      text: "explicitly later",
      messageType: "follow_up",
    });
    assert.equal(queued.queued, true);
    const pending = pendingQueuedMessages((await q.read()).items)[0]!;
    const result = await q.server.steerQueuedMessage(
      q.threadId,
      steerTarget(pending),
    );
    assert.equal(result.status, "steered");
    const delivered = (await q.read()).items.find(
      (item) =>
        item.type === "thread_message" && item.clientId === "remote-queued",
    );
    assert(delivered?.type === "thread_message");
    assert.equal(delivered.sender.deviceId, "peer");
    assert.equal(delivered.sender.threadId, base.sender.threadId);
    assert.equal(delivered.messageType, "follow_up");
    assert.equal(delivered.mode, "steer");
    assert.equal(delivered.turnId, q.turn.id);
    assert.equal(pendingQueuedMessages((await q.read()).items).length, 0);
  } finally {
    remote.close();
    q.release.resolve();
    await q.turn.done;
  }
});

test("promotion during interrupted image validation starts once after the predecessor settles", async () => {
  const attachments = new InMemoryAttachmentStore();
  const q = await runningQueue({ attachments });
  const entered = deferred();
  const release = deferred();
  try {
    const ref = await q.server.importImageBytes(png1x1());
    await q.server.queueMessage(
      q.threadId,
      [{ type: "image", attachment: ref }],
      "interrupted-image",
    );
    const queued = pendingQueuedMessages((await q.read()).items)[0]!;
    const original = (await q.read()).items.find(
      (item) => item.id === queued.id,
    );
    const read = attachments.read.bind(attachments);
    let block = true;
    attachments.read = async (attachment) => {
      if (block) {
        block = false;
        entered.resolve();
        await release.promise;
      }
      return read(attachment);
    };
    const promoted = q.server.steerQueuedMessage(
      q.threadId,
      steerTarget(queued),
    );
    await entered.promise;
    const interrupted = q.server.interruptTurn(q.threadId, q.turn.id);
    q.release.resolve();
    release.resolve();
    await interrupted;
    const result = await promoted;
    assert.notEqual(result.turnId, q.turn.id);
    const snapshot = await q.read();
    const delivered = snapshot.items.filter(
      (item) =>
        item.type === "user_message" && item.clientId === queued.clientId,
    );
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.turnId, result.turnId);
    assert.deepEqual(
      snapshot.items.find((item) => item.id === queued.id),
      original,
    );
    assert.equal(pendingQueuedMessages(snapshot.items).length, 0);
  } finally {
    q.release.resolve();
    release.resolve();
    await q.turn.done;
  }
});

test("active Host promotion preserves source and leaves explicitly queued siblings untouched", async () => {
  const q = await runningQueue();
  try {
    await q.server.wakeTurn(
      q.threadId,
      {
        clientId: "host-selected",
        text: "Selected Host update",
        source: "trigger",
        sourceId: "synthetic-trigger",
      },
      { mode: "queue" },
    );
    await q.server.queueMessage(
      q.threadId,
      "Explicit follow-up",
      "human-sibling",
      { deliveryMode: "batch-next" },
    );
    const before = await q.read();
    const queued = pendingQueuedMessages(before.items);
    const host = queued.find((item) => item.clientId === "host-selected")!;
    const sibling = queued.find((item) => item.clientId === "human-sibling")!;
    const result = await q.server.steerQueuedMessage(
      q.threadId,
      steerTarget(host),
    );
    assert.equal(result.status, "steered");
    const after = await q.read();
    const delivered = after.items.find(
      (item) => item.type === "host_message" && item.clientId === host.clientId,
    );
    assert(delivered?.type === "host_message");
    assert.equal(delivered.sender, "host");
    assert.equal(delivered.source, "trigger");
    assert.equal(delivered.sourceId, "synthetic-trigger");
    assert.equal(delivered.text, "Selected Host update");
    assert.equal(delivered.turnId, q.turn.id);
    assert.equal(delivered.mode, "steer");
    assert.deepEqual(pendingQueuedMessages(after.items), [sibling]);
    assert.equal(
      after.items.filter(
        (item) =>
          item.type === "user_message" && item.clientId === host.clientId,
      ).length,
      0,
    );
  } finally {
    q.release.resolve();
    await q.turn.done;
  }
});
