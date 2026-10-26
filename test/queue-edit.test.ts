import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenAppServer, type QueuedEditTarget } from "../src/app-server.js";
import {
  InMemoryAttachmentStore,
  type AttachmentStore,
} from "../src/attachment.js";
import {
  pendingQueuedMessages,
  type PendingQueuedUserMessage,
} from "../src/input-queue.js";
import {
  decodeCanonicalItem,
  originalUserInput,
  textFromUserInput,
  type CanonicalItem,
  type QueuedUserMessageEditedItem,
  type UserInput,
} from "../src/item.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
} from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { CodexConnection } from "../src/protocol/codex/connection.js";
import { projectThread } from "../src/protocol/codex/mapper.js";
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
function editTarget(
  item: PendingQueuedUserMessage,
  editId = "edit-1",
): QueuedEditTarget {
  return {
    queuedItemId: item.id,
    clientId: item.clientId,
    expectedRevision: item.revision,
    editId,
  };
}
function finished(server: ZenAppServer) {
  const done = deferred();
  const unsubscribe = server.subscribe((event) => {
    if (event.type === "turn_completed") {
      unsubscribe();
      done.resolve();
    }
  });
  return done.promise;
}

test("queued edits append latest text/images at the original identity and FIFO position without resuming", async () => {
  const attachments = new InMemoryAttachmentStore();
  const queue = await paused(undefined, { attachments });
  const image = await queue.server.importImageBytes(png1x1());
  const original = (await queue.read()).items;
  const input: UserInput = [
    ...text("edited beta"),
    { type: "image", attachment: image },
  ];
  const result = await queue.server.editQueuedMessage(
    queue.threadId,
    editTarget(queue.queued[1]!),
    input,
  );
  assert.equal(result.status, "edited");
  assert.equal(result.revision, 1);
  let current = pendingQueuedMessages((await queue.read()).items);
  assert.deepEqual(
    current.map(({ id, clientId, createdAt, deliveryMode }) => ({
      id,
      clientId,
      createdAt,
      deliveryMode,
    })),
    queue.queued.map(({ id, clientId, createdAt, deliveryMode }) => ({
      id,
      clientId,
      createdAt,
      deliveryMode,
    })),
  );
  assert.deepEqual(current[1]!.input, input);
  assert.deepEqual(
    (await queue.read()).items.slice(0, original.length),
    original,
  );
  assert.equal((await queue.read()).turns.length, 0);
  const snapshot = await queue.read();
  assert.equal(
    projectThread(snapshot, { includeTurns: true }).queuedMessages?.[1]?.text,
    "edited beta",
  );
  assert.equal(
    projectThread(snapshot, { includeTurns: true }).queuedMessages?.[1]
      ?.imageCount,
    1,
  );
  assert(
    !compileModelMessages(snapshot.items).some((message) =>
      JSON.stringify(message).includes("edited beta"),
    ),
  );
  await queue.server.editQueuedMessage(
    queue.threadId,
    editTarget(current[1]!, "edit-2"),
    [{ type: "image", attachment: image }],
  );
  current = pendingQueuedMessages((await queue.read()).items);
  assert.deepEqual(current[1]!.input, [{ type: "image", attachment: image }]);
  const done = finished(queue.server);
  await queue.server.resumeQueue(queue.threadId);
  await done;
  const delivered = (await queue.read()).items.filter(
    (item) => item.type === "user_message",
  );
  assert.deepEqual(
    delivered.map((item) => item.clientId),
    ["client-0", "client-1"],
  );
  assert.deepEqual(originalUserInput(delivered[1]!), [
    { type: "image", attachment: image },
  ]);
});

test("two edits with the same base revision are serialized and retries bind every request field", async () => {
  const queue = await paused();
  const target = editTarget(queue.queued[0]!);
  const outcomes = await Promise.allSettled([
    queue.server.editQueuedMessage(queue.threadId, target, text("winner")),
    queue.server.editQueuedMessage(
      queue.threadId,
      { ...target, editId: "competitor" },
      text("loser"),
    ),
  ]);
  assert.equal(outcomes[0]!.status, "fulfilled");
  assert.equal(outcomes[1]!.status, "rejected");
  if (outcomes[1]!.status === "rejected")
    assert.equal(outcomes[1]!.reason.code, "queue_revision_conflict");
  const first = await queue.server.editQueuedMessage(
    queue.threadId,
    target,
    text("winner"),
  );
  assert.equal(first.status, "already_edited");
  for (const altered of [
    { ...target, queuedItemId: queue.queued[1]!.id },
    { ...target, clientId: "wrong" },
    { ...target, expectedRevision: 1 },
  ]) {
    await assert.rejects(
      queue.server.editQueuedMessage(queue.threadId, altered, text("winner")),
      { code: "idempotency_conflict" },
    );
  }
  await assert.rejects(
    queue.server.editQueuedMessage(queue.threadId, target, text("different")),
    { code: "idempotency_conflict" },
  );
  const current = pendingQueuedMessages((await queue.read()).items)[0]!;
  await queue.server.editQueuedMessage(
    queue.threadId,
    editTarget(current, "later"),
    text("latest"),
  );
  await queue.server.cancelQueuedMessages(queue.threadId, [target]);
  assert.deepEqual(
    await queue.server.editQueuedMessage(
      queue.threadId,
      target,
      text("winner"),
    ),
    first,
  );
  assert.equal(pendingQueuedMessages((await queue.read()).items).length, 1);
  assert.equal(
    (await queue.read()).items.filter(
      (item) => item.type === "user_message_queue_edited",
    ).length,
    2,
  );
});

test("cancel and edit arbitrate in the same mutation boundary in either order", async () => {
  const queue = await paused();
  const first = editTarget(queue.queued[0]!);
  const second = editTarget(queue.queued[1]!, "second");
  const cancelledFirst = queue.server.cancelQueuedMessages(queue.threadId, [
    first,
  ]);
  const editAfterCancel = queue.server.editQueuedMessage(
    queue.threadId,
    first,
    text("must not revive"),
  );
  await cancelledFirst;
  await assert.rejects(editAfterCancel, { code: "queue_cancelled" });
  const editedFirst = queue.server.editQueuedMessage(
    queue.threadId,
    second,
    text("saved before cancel"),
  );
  const cancelAfterEdit = queue.server.cancelQueuedMessages(queue.threadId, [
    second,
  ]);
  assert.equal((await editedFirst).status, "edited");
  assert.equal((await cancelAfterEdit)[0]!.status, "cancelled");
  assert.deepEqual(pendingQueuedMessages((await queue.read()).items), []);
  assert.equal(
    (await queue.read()).items.filter(
      (item) => item.type === "user_message_queue_edited",
    ).length,
    1,
  );
});

test("invalid or unavailable media and unsupported provenance/audio preserve the original queue", async () => {
  const queue = await paused();
  const before = (await queue.read()).items;
  const target = editTarget(queue.queued[0]!);
  const image = await queue.server.importImageBytes(png1x1());
  await assert.rejects(
    queue.server.editQueuedMessage(queue.threadId, target, [
      { type: "image", attachment: { ...image, sha256: "0".repeat(64) } },
    ]),
    { code: "attachment_missing" },
  );
  await assert.rejects(
    queue.server.editQueuedMessage(queue.threadId, target, []),
    { code: "invalid_input" },
  );
  await assert.rejects(
    queue.server.editQueuedMessage(
      queue.threadId,
      { ...target, clientId: "wrong" },
      text("x"),
    ),
    { code: "queue_not_found" },
  );
  await assert.rejects(
    queue.server.editQueuedMessage(
      queue.threadId,
      { ...target, expectedRevision: -1 },
      text("x"),
    ),
    { code: "invalid_request" },
  );
  const audio: UserInput = [
    {
      type: "audio",
      attachment: {
        type: "attachment",
        sha256: "a".repeat(64),
        mediaType: "audio/wav",
        byteLength: 1,
      },
    },
  ];
  const skill: UserInput = [
    {
      type: "text",
      text: "Host snapshot",
      skillSource: { kind: "catalog", sha256: "a".repeat(64) },
    },
  ];
  for (const input of [audio, skill]) {
    await assert.rejects(
      queue.server.editQueuedMessage(queue.threadId, target, input),
      { code: "queue_edit_unsupported_input" },
    );
    const opaque = await paused([input]);
    await assert.rejects(
      opaque.server.editQueuedMessage(
        opaque.threadId,
        editTarget(opaque.queued[0]!),
        text("replace opaque"),
      ),
      { code: "queue_edit_unsupported_input" },
    );
  }
  assert.deepEqual((await queue.read()).items, before);
});

test("JSONL reload retains edit revisions; original enqueue retry is read-only until explicit Resume", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-queue-edit-"));
  try {
    const journal = new JsonlThreadJournal(directory);
    const queue = await paused(undefined, { journal });
    const target = editTarget(queue.queued[0]!);
    const initial = await readFile(
      path.join(directory, `${queue.threadId}.jsonl`),
      "utf8",
    );
    await queue.server.editQueuedMessage(
      queue.threadId,
      target,
      text("latest alpha"),
    );
    assert(
      (
        await readFile(path.join(directory, `${queue.threadId}.jsonl`), "utf8")
      ).startsWith(initial),
    );
    const restored = createServer({
      journal: new JsonlThreadJournal(directory),
    });
    assert.equal(
      pendingQueuedMessages(
        (await restored.readThread(queue.threadId)).items,
      )[0]!.revision,
      1,
    );
    assert.equal(
      (
        await restored.editQueuedMessage(
          queue.threadId,
          target,
          text("latest alpha"),
        )
      ).status,
      "already_edited",
    );
    await assert.rejects(
      restored.startTurn(queue.threadId, "alpha", { clientId: "client-0" }),
      { code: "idempotency_conflict" },
    );
    const beforeRetry = (await restored.readThread(queue.threadId)).items;
    const receipt = await restored.queueMessage(
      queue.threadId,
      "alpha",
      "client-0",
      {
        deliveryMode: "batch-next",
      },
    );
    assert.deepEqual(receipt, {
      state: "queued",
      clientId: "client-0",
      queuedItemId: target.queuedItemId,
    });
    assert.deepEqual(
      (await restored.readThread(queue.threadId)).items,
      beforeRetry,
    );
    const done = finished(restored);
    await restored.resumeQueue(queue.threadId);
    await done;
    const after = await restored.readThread(queue.threadId);
    const consumed = after.items.find(
      (item) => item.type === "user_message" && item.clientId === "client-0",
    );
    assert(consumed?.type === "user_message");
    assert.deepEqual(
      await restored.queueMessage(queue.threadId, "alpha", "client-0", {
        deliveryMode: "batch-next",
      }),
      {
        ...receipt,
        state: "admitted",
        turnId: consumed.turnId,
      },
    );
    await assert.rejects(
      restored.queueMessage(queue.threadId, "latest alpha", "client-0", {
        deliveryMode: "batch-next",
      }),
      { code: "idempotency_conflict" },
    );
    assert.deepEqual(
      after.items
        .filter((item) => item.type === "user_message")
        .map((item) => textFromUserInput(originalUserInput(item))),
      ["latest alpha", "beta"],
    );
    assert.equal(
      (
        await restored.editQueuedMessage(
          queue.threadId,
          target,
          text("latest alpha"),
        )
      ).status,
      "already_edited",
    );
    await assert.rejects(
      restored.editQueuedMessage(
        queue.threadId,
        { ...target, editId: "after-delivery", expectedRevision: 1 },
        text("too late"),
      ),
      { code: "queue_already_started" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const editedIndex of [0, 1])
  for (const rejectOldRead of [false, true])
    test(`batch member ${editedIndex} edit while second image preflight ${rejectOldRead ? "fails" : "succeeds"} recaptures every revision`, async () => {
      const attachments = new InMemoryAttachmentStore();
      const originalRead = attachments.read.bind(attachments);
      const enteredRead = deferred();
      const releaseRead = deferred();
      let block = false;
      attachments.read = async (ref) => {
        if (block) {
          block = false;
          enteredRead.resolve();
          await releaseRead.promise;
          if (rejectOldRead)
            throw new Error("stale image failure must not reach UI");
        }
        return await originalRead(ref);
      };
      const helper = createServer({
        journal: new InMemoryThreadJournal(),
        attachments,
      });
      const image = await helper.importImageBytes(png1x1());
      const queue = await paused(
        [text("first"), [{ type: "image", attachment: image }]],
        { attachments },
      );
      let failures = 0;
      queue.server.subscribe((event) => {
        if (event.type === "queue_failed") failures++;
      });
      const done = finished(queue.server);
      block = true;
      const resume = queue.server.resumeQueue(queue.threadId);
      await enteredRead.promise;
      await queue.server.editQueuedMessage(
        queue.threadId,
        editTarget(queue.queued[editedIndex]!),
        text("latest member"),
      );
      releaseRead.resolve();
      await resume;
      await done;
      const after = await queue.read();
      assert.deepEqual(
        after.items
          .filter((item) => item.type === "user_message")
          .map((item) => textFromUserInput(originalUserInput(item))),
        editedIndex === 0 ? ["latest member", ""] : ["first", "latest member"],
      );
      assert.equal(failures, 0);
      assert.equal(
        after.items.filter((item) => item.type === "turn_started").length,
        1,
      );
    });

test("a launch reservation rejects edits before the first user message is committed", async () => {
  const entered = deferred();
  const release = deferred();
  const runtime = new (class extends AgentRuntime {
    override async runTurn(options: RunTurnOptions): Promise<void> {
      entered.resolve();
      await release.promise;
      await super.runTurn(options);
    }
  })({ toolEnvironment: new ToolEnvironment({ runtimes: [] }) });
  const queue = await paused(undefined, { runtime });
  const done = finished(queue.server);
  const resume = queue.server.resumeQueue(queue.threadId);
  await entered.promise;
  assert.equal(
    (await queue.read()).items.some((item) => item.type === "user_message"),
    false,
  );
  await assert.rejects(
    queue.server.editQueuedMessage(
      queue.threadId,
      editTarget(queue.queued[0]!),
      text("too late"),
    ),
    { code: "queue_already_started" },
  );
  release.resolve();
  await resume;
  await done;
});

test("projection only applies same-thread identity and consecutive revisions, never resurrecting terminal input", () => {
  const base = { threadId: "thread", createdAt: "2026-10-12T00:00:00.000Z" };
  const queued: CanonicalItem = {
    ...base,
    id: "queue",
    type: "user_message_queued",
    clientId: "client",
    input: text("original"),
    deliveryMode: "batch-next",
  };
  const edit: QueuedUserMessageEditedItem = {
    ...base,
    id: "edit",
    type: "user_message_queue_edited",
    queuedItemId: queued.id,
    clientId: queued.clientId,
    editId: "operation",
    revision: 1,
    input: text("first edit"),
  };
  const items: CanonicalItem[] = [
    queued,
    { ...edit, id: "foreign-thread", threadId: "other" },
    { ...edit, id: "foreign-client", clientId: "other" },
    { ...edit, id: "skipped-revision", revision: 2 },
    edit,
    { ...edit, id: "old-revision" },
    { ...edit, id: "next", revision: 2, input: text("second edit") },
  ];
  assert.deepEqual(pendingQueuedMessages(items), [
    { ...queued, revision: 2, input: text("second edit") },
  ]);
  items.push(
    {
      ...base,
      id: "cancel",
      type: "user_message_queue_cancelled",
      queuedItemId: queued.id,
      clientId: queued.clientId,
    },
    { ...edit, id: "after-cancel", revision: 3 },
  );
  assert.deepEqual(pendingQueuedMessages(items), []);
  assert.deepEqual(decodeCanonicalItem(edit), edit);
  for (const revision of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => decodeCanonicalItem({ ...edit, revision }));
  assert.throws(() => decodeCanonicalItem({ ...edit, turnId: "turn" }));
});

test("native edit is initialized, validated, canonically notified and absent from CAS commands", async () => {
  const queue = await paused();
  const projection = new NativeRecoveryProjection(queue.server, {
    processEpoch: "edit-test",
  });
  const messages: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: queue.server,
    projection,
    send: (message) => {
      messages.push(message);
    },
  });
  const params = {
    threadId: queue.threadId,
    ...editTarget(queue.queued[0]!),
    input: text("native edited"),
  };
  try {
    await connection.receive({
      id: 1,
      method: "zen/thread/queue/edit",
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
      method: "zen/thread/queue/edit",
      params,
    });
    assert(
      messages.some(
        (message) =>
          "id" in message &&
          message.id === 3 &&
          "result" in message &&
          (message.result as { status: string }).status === "edited",
      ),
    );
    assert(
      messages.some(
        (message) =>
          "method" in message &&
          message.method === "zen/thread/event" &&
          JSON.stringify(message).includes("user_message_queue_edited"),
      ),
    );
    await connection.receive({
      id: 4,
      method: "zen/thread/queue/edit",
      params: { ...params, editId: "invalid", expectedRevision: "0" },
    });
    assert(
      messages.some(
        (message) =>
          "id" in message &&
          message.id === 4 &&
          "error" in message &&
          message.error.code === -32602,
      ),
    );
    const casMessages: JsonRpcMessage[] = [];
    const cas = new CodexConnection({
      appServer: queue.server,
      zenHome: os.tmpdir(),
      send: (message) => {
        casMessages.push(message);
      },
    });
    try {
      await cas.receive({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "test", version: "1" },
          capabilities: null,
        },
      });
      await cas.receive({ method: "initialized" });
      await cas.receive({ id: 2, method: "turn/queue/edit", params });
      assert(
        casMessages.some(
          (message) =>
            "id" in message &&
            message.id === 2 &&
            "error" in message &&
            message.error.code === -32601,
        ),
      );
    } finally {
      cas.close();
    }
  } finally {
    connection.close();
    projection.close();
  }
});

for (const persisted of [false, true])
  test(`journal edit rejection ${persisted ? "after" : "before"} persistence recovers only from canonical history`, async () => {
    const journal = new InMemoryThreadJournal();
    const queue = await paused(undefined, { journal });
    const append = journal.append.bind(journal);
    let fail = true;
    journal.append = async (item) => {
      if (item.type === "user_message_queue_edited" && fail) {
        fail = false;
        if (persisted) await append(item);
        throw new Error("simulated acknowledgement loss");
      }
      await append(item);
    };
    const target = editTarget(queue.queued[0]!);
    await assert.rejects(
      queue.server.editQueuedMessage(
        queue.threadId,
        target,
        text("saved once"),
      ),
      /acknowledgement loss/u,
    );
    const state = pendingQueuedMessages((await queue.read()).items)[0]!;
    assert.equal(state.revision, persisted ? 1 : 0);
    assert.deepEqual(
      state.input,
      persisted ? text("saved once") : text("alpha"),
    );
    assert.equal(
      (
        await queue.server.editQueuedMessage(
          queue.threadId,
          target,
          text("saved once"),
        )
      ).status,
      persisted ? "already_edited" : "edited",
    );
    assert.equal(
      (await queue.read()).items.filter(
        (item) => item.type === "user_message_queue_edited",
      ).length,
      1,
    );
  });

test("fork and side-chat remap edited queue anchors without inheriting pending execution", async () => {
  const queue = await paused();
  await queue.server.editQueuedMessage(
    queue.threadId,
    editTarget(queue.queued[0]!),
    text("fork latest"),
  );
  const side = await queue.server.createChildThread({
    parentThreadId: queue.threadId,
    mode: "side-chat",
  });
  const sideOriginal = side.items.find(
    (item) =>
      item.type === "user_message_queued" && item.clientId === "client-0",
  );
  const sideEdit = side.items.find(
    (item) => item.type === "user_message_queue_edited",
  );
  assert(sideOriginal?.type === "user_message_queued");
  assert(sideEdit?.type === "user_message_queue_edited");
  assert.notEqual(sideOriginal.id, queue.queued[0]!.id);
  assert.equal(sideEdit.queuedItemId, sideOriginal.id);
  assert.deepEqual(pendingQueuedMessages(side.items), []);
  const done = finished(queue.server);
  await queue.server.resumeQueue(queue.threadId);
  await done;
  const copy = await queue.server.forkThread({
    sourceThreadId: queue.threadId,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  const copiedOriginal = copy.items.find(
    (item) =>
      item.type === "user_message_queued" && item.clientId === "client-0",
  );
  const copiedEdit = copy.items.find(
    (item) => item.type === "user_message_queue_edited",
  );
  assert(copiedOriginal?.type === "user_message_queued");
  assert(copiedEdit?.type === "user_message_queue_edited");
  assert.equal(copiedEdit.queuedItemId, copiedOriginal.id);
  assert.notEqual(copiedEdit.queuedItemId, queue.queued[0]!.id);
  assert.deepEqual(pendingQueuedMessages(copy.items), []);
});

test("an edit holding the mutation lock forces an already-preflighted resume to admit the new revision", async () => {
  const attachments = new InMemoryAttachmentStore();
  const originalRead = attachments.read.bind(attachments);
  const readingEdit = deferred();
  const releaseEdit = deferred();
  let block = false;
  attachments.read = async (ref) => {
    if (block) {
      block = false;
      readingEdit.resolve();
      await releaseEdit.promise;
    }
    return await originalRead(ref);
  };
  const queue = await paused(undefined, { attachments });
  const image = await queue.server.importImageBytes(png1x1());
  const requested: UserInput = [
    ...text("edited before admission"),
    { type: "image", attachment: image },
  ];
  block = true;
  const edit = queue.server.editQueuedMessage(
    queue.threadId,
    editTarget(queue.queued[0]!),
    requested,
  );
  await readingEdit.promise;
  const attempted = deferred();
  queue.server.subscribe((event) => {
    if (event.type === "queue_admission_started") attempted.resolve();
  });
  const done = finished(queue.server);
  const resume = queue.server.resumeQueue(queue.threadId);
  await attempted.promise;
  // Let preflight's microtasks finish while edit owns the launch mutation fence.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await queue.read()).turns.length, 0);
  releaseEdit.resolve();
  await edit;
  await resume;
  await done;
  const user = (await queue.read()).items.find(
    (item) => item.type === "user_message" && item.clientId === "client-0",
  );
  assert(user?.type === "user_message");
  assert.deepEqual(originalUserInput(user), requested);
  assert.deepEqual(user.contentAuthority?.hostTextPartIndices, [0]);
});
