import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AppServerError,
  ZenAppServer,
  type ThreadSnapshot,
  type DeletedThreadSummary,
  type DeleteThreadResult,
} from "../src/app-server.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import {
  InMemoryThreadMetadataStore,
  JsonlThreadMetadataStore,
  type ThreadMetadataStore,
} from "../src/thread-metadata.js";
import {
  InMemoryThreadSummaryProjection,
  JsonThreadSummaryProjection,
  type ThreadSummaryProjection,
} from "../src/thread-summary.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { CodexConnection } from "../src/protocol/codex/connection.js";
import { AgentRuntime } from "../src/runtime.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  FakeModel,
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
} from "../src/model.js";
import { ToolEnvironment } from "../src/tool.js";
import { Thread } from "../src/thread.js";
import { decodeCanonicalItem, type CanonicalItem } from "../src/item.js";

function fixture(
  options: {
    journal?: ThreadJournal;
    metadata?: ThreadMetadataStore;
    summaries?: ThreadSummaryProjection;
    model?: ModelAdapter;
    tools?: ToolEnvironment;
    cwd?: string;
  } = {},
) {
  const journal = options.journal ?? new InMemoryThreadJournal();
  const metadata = options.metadata ?? new InMemoryThreadMetadataStore();
  const tools = options.tools ?? new ToolEnvironment({ runtimes: [] });
  const model = options.model ?? new FakeModel();
  const app = new ZenAppServer({
    journal,
    threadMetadata: metadata,
    threadSummaryProjection:
      options.summaries ?? new InMemoryThreadSummaryProjection(),
    runtime: new AgentRuntime({ toolEnvironment: tools }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fake", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: options.cwd ?? os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const projection = new NativeRecoveryProjection(app);
  const messages: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: app,
    projection,
    send: (message) => {
      messages.push(message);
    },
  });
  let id = 0;
  async function receive(method: string, params: unknown = {}) {
    const requestId = ++id;
    await connection.receive({ id: requestId, method, params });
    const response = messages.find(
      (message) => "id" in message && message.id === requestId,
    );
    assert(
      response && ("result" in response || "error" in response),
      JSON.stringify(response),
    );
    return response;
  }
  async function request<T = unknown>(
    method: string,
    params: unknown = {},
  ): Promise<T> {
    const response = await receive(method, params);
    assert("result" in response, JSON.stringify(response));
    return response.result as T;
  }
  return {
    app,
    journal,
    metadata,
    tools,
    projection,
    connection,
    messages,
    receive,
    request,
    async close() {
      connection.close();
      projection.close();
      await tools.close();
    },
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof AppServerError && error.code === expected;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function archive(f: ReturnType<typeof fixture>) {
  const thread = await f.app.startThread();
  await f.app.setThreadArchived(thread.id, true);
  return thread;
}
async function deleteRequest(
  f: ReturnType<typeof fixture>,
  thread: ThreadSnapshot,
) {
  return await f.request<DeleteThreadResult>("zen/thread/delete", {
    threadId: thread.id,
    expectedLastItemId: thread.items.at(-1)!.id,
  });
}

test("native deletion preserves files and children, survives restart, and restores to Archived", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-deletion-"));
  const journalDirectory = path.join(directory, "journals");
  const workspaceFile = path.join(directory, "project.txt");
  const attachment = path.join(directory, "shared-attachment.bin");
  const metadataFile = path.join(directory, "metadata.jsonl");
  const summariesFile = path.join(directory, "summaries.json");
  await writeFile(workspaceFile, "user workspace");
  await writeFile(attachment, "shared attachment");
  let f = fixture({
    journal: new JsonlThreadJournal(journalDirectory),
    metadata: new JsonlThreadMetadataStore(metadataFile),
    summaries: new JsonThreadSummaryProjection(summariesFile),
    cwd: directory,
  });
  try {
    await f.request("zen/initialize");
    let thread = await f.app.startThread();
    await (
      await f.app.startTurn(thread.id, "preserved history")
    ).done;
    await f.app.setThreadName(thread.id, "Restore me");
    thread = await f.app.setThreadArchived(thread.id, true);
    const child = await f.app.createChildThread({
      parentThreadId: thread.id,
      mode: "fresh",
    });
    const journalFile = path.join(journalDirectory, `${thread.id}.jsonl`);
    const before = await readFile(journalFile, "utf8");
    const modelMessages = compileModelMessages(thread.items);
    const deletion = await deleteRequest(f, thread);
    assert.equal(
      (await f.app.listThreadSummaries({ archived: true })).length,
      0,
    );
    assert.equal((await f.app.readThread(child.id)).parentThreadId, thread.id);
    assert.deepEqual(await f.app.listThreads({ archived: true }), []);
    await assert.rejects(f.app.readThread(thread.id), code("thread_deleted"));
    assert((await readFile(journalFile, "utf8")).startsWith(before));
    assert.equal(await readFile(workspaceFile, "utf8"), "user workspace");
    assert.equal(await readFile(attachment, "utf8"), "shared attachment");
    const deleted = await f.request<{ data: DeletedThreadSummary[] }>(
      "zen/thread/deleted/list",
    );
    assert.deepEqual(
      deleted.data.map((entry) => ({ ...entry, deletedAt: "date" })),
      [
        {
          threadId: thread.id,
          deletionItemId: deletion.deletionItemId,
          deletedAt: "date",
          name: "Restore me",
          cwd: directory,
        },
      ],
    );
    assert(
      f.messages.some(
        (message) =>
          "method" in message && message.method === "zen/thread/event",
      ),
    );
    await f.close();
    f = fixture({
      journal: new JsonlThreadJournal(journalDirectory),
      metadata: new JsonlThreadMetadataStore(metadataFile),
      summaries: new JsonThreadSummaryProjection(summariesFile),
      cwd: directory,
    });
    await f.request("zen/initialize");
    assert.deepEqual(await f.app.listThreadSummaries({ archived: true }), []);
    await assert.rejects(f.app.readThread(thread.id), code("thread_deleted"));
    const restored = await f.request<{ thread: ThreadSnapshot }>(
      "zen/thread/restore",
      deletion,
    );
    assert.equal(restored.thread.archived, true);
    assert.equal(restored.thread.name, "Restore me");
    assert.deepEqual(
      compileModelMessages(restored.thread.items),
      modelMessages,
    );
    assert.equal(
      (await f.app.listThreadSummaries({ archived: true }))[0]?.lastItemId,
      restored.thread.items.at(-1)?.id,
    );
    assert.deepEqual(await f.request("zen/thread/deleted/list"), { data: [] });
    await f.app.setThreadPermissions(thread.id, "read-only");
    const fork = await f.app.forkThread({
      sourceThreadId: thread.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    assert.equal(fork.sandbox, "read-only");
    assert.equal(
      new Thread(fork.id, fork.items.map(decodeCanonicalItem)).deletion,
      undefined,
    );
    const copy = await f.app.createChildThread({
      parentThreadId: thread.id,
      mode: "side-chat",
    });
    assert.equal(
      new Thread(copy.id, copy.items.map(decodeCanonicalItem)).deletion,
      undefined,
    );
    assert.equal((await f.app.readThread(child.id)).parentThreadId, thread.id);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("delete and restore retries are exact and cannot affect a later lifecycle", async () => {
  const f = fixture();
  try {
    await f.request("zen/initialize");
    const thread = await archive(f);
    const first = await deleteRequest(f, thread);
    assert.deepEqual(await deleteRequest(f, thread), first);
    assert.equal(
      (await f.journal.read(thread.id)).filter(
        (item) => item.type === "thread_deleted",
      ).length,
      1,
    );
    await f.request("zen/thread/restore", first);
    await f.request("zen/thread/restore", first);
    await assert.rejects(
      f.app.deleteThread(thread.id, thread.items.at(-1)!.id),
      code("stale_thread"),
    );
    const restored = await f.app.readThread(thread.id);
    const second = await deleteRequest(f, restored);
    assert.notEqual(first.deletionItemId, second.deletionItemId);
    await assert.rejects(
      f.app.restoreThread(thread.id, first.deletionItemId),
      code("stale_thread"),
    );
    await assert.rejects(f.app.readThread(thread.id), code("thread_deleted"));
  } finally {
    await f.close();
  }
});

test("all ordinary public read and mutation boundaries reject a deleted Thread", async () => {
  const f = fixture();
  try {
    await f.request("zen/initialize");
    const thread = await archive(f);
    await deleteRequest(f, thread);
    const before = await f.journal.read(thread.id);
    const operations = [
      () => f.app.readThread(thread.id),
      () => f.app.startTurn(thread.id, "blocked"),
      () => f.app.queueMessage(thread.id, "blocked", "queue"),
      () => f.app.resumeQueue(thread.id),
      () => f.app.steerTurn(thread.id, "old", "blocked"),
      () =>
        f.app.replaceTurn(thread.id, "old", "blocked", { clientId: "replace" }),
      () => f.app.updateThreadSettings(thread.id, { model: "fake" }),
      () => f.app.setThreadPermissions(thread.id, "read-only"),
      () => f.app.setThreadName(thread.id, "blocked"),
      () => f.app.setThreadArchived(thread.id, false),
      () => f.app.setThreadArchived(thread.id, true),
      () =>
        f.app.createChildThread({ parentThreadId: thread.id, mode: "fresh" }),
      () =>
        f.app.forkThread({
          sourceThreadId: thread.id,
          through: { type: "latest-complete" },
          workspace: { type: "same-directory" },
        }),
      () => f.app.compactThread(thread.id),
      () =>
        f.app.cancelQueuedMessages(thread.id, [
          { queuedItemId: "queued", clientId: "client" },
        ]),
      () =>
        f.app.editQueuedMessage(
          thread.id,
          {
            queuedItemId: "queued",
            clientId: "client",
            expectedRevision: 0,
            editId: "edit",
          },
          [{ type: "text", text: "blocked" }],
        ),
      () =>
        f.app.dispatchHostTool(thread, async () =>
          assert.fail("must not launch"),
        ),
    ];
    for (const operation of operations)
      await assert.rejects(operation(), code("thread_deleted"));
    for (const method of ["zen/thread/read", "zen/thread/resume"]) {
      assert("error" in (await f.receive(method, { threadId: thread.id })));
    }
    const casMessages: JsonRpcMessage[] = [];
    const cas = new CodexConnection({
      appServer: f.app,
      zenHome: os.tmpdir(),
      send: (message) => {
        casMessages.push(message);
      },
    });
    try {
      await cas.receive({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "test", version: "1" } },
      });
      await cas.receive({
        id: 2,
        method: "thread/read",
        params: { threadId: thread.id },
      });
      assert(
        casMessages.some(
          (message) =>
            "id" in message && message.id === 2 && "error" in message,
        ),
      );
    } finally {
      cas.close();
    }
    assert.deepEqual(await f.journal.read(thread.id), before);
    assert.deepEqual(await f.app.listThreads(), []);
    assert.deepEqual(await f.app.listThreads({ archived: true }), []);
  } finally {
    await f.close();
  }
});

test("delete rejects unarchived, malformed, missing and active targets without mutation", async () => {
  const release = deferred();
  const model: ModelAdapter = {
    provider: "slow",
    async *stream(): AsyncIterable<ModelEvent> {
      await release.promise;
      yield { type: "text_delta", delta: "done" };
    },
  };
  const f = fixture({ model });
  try {
    const uninitialized = await f.receive("zen/thread/deleted/list");
    assert("error" in uninitialized && uninitialized.error.code === -32600);
    await f.request("zen/initialize");
    const thread = await f.app.startThread();
    await assert.rejects(
      f.app.deleteThread(thread.id, thread.items.at(-1)!.id),
      code("thread_not_archived"),
    );
    await assert.rejects(
      f.app.deleteThread("missing", "item"),
      code("thread_not_found"),
    );
    assert(
      "error" in
        (await f.receive("zen/thread/delete", { threadId: thread.id })),
    );
    assert(
      "error" in
        (await f.receive("zen/thread/restore", {
          threadId: thread.id,
          deletionItemId: " ",
        })),
    );
    assert(
      "error" in
        (await f.receive("zen/thread/deleted/list", { includeItems: true })),
    );
    await f.app.setThreadArchived(thread.id, true);
    const turn = await f.app.startTurn(thread.id, "active archived turn");
    const active = await f.app.readThread(thread.id);
    await assert.rejects(
      f.app.deleteThread(thread.id, active.items.at(-1)!.id),
      code("thread_busy"),
    );
    release.resolve();
    await turn.done;
    await deleteRequest(f, await f.app.readThread(thread.id));
  } finally {
    release.resolve();
    await f.close();
  }
});

test("pending canonical replacements block deletion after a Host restart", async () => {
  const journal = new InMemoryThreadJournal();
  const metadata = new InMemoryThreadMetadataStore();
  let f = fixture({ journal, metadata });
  try {
    const thread = await archive(f);
    const pending: CanonicalItem = {
      type: "turn_replacement_requested",
      id: "pending",
      threadId: thread.id,
      createdAt: new Date().toISOString(),
      turnId: "old",
      successorTurnId: "next",
      clientId: "replace",
      text: "pending",
    };
    await journal.append(pending);
    await f.close();
    f = fixture({ journal, metadata });
    await assert.rejects(
      f.app.deleteThread(thread.id, pending.id),
      code("thread_busy"),
    );
    assert.equal((await journal.read(thread.id)).at(-1)?.id, pending.id);
  } finally {
    await f.close();
  }
});

test("unfinished tool bodies block deletion even when there is no active Turn", async () => {
  const entered = deferred(),
    release = deferred();
  const tools = new ToolEnvironment({
    runtimes: [
      {
        name: "slow",
        specification: {
          name: "slow",
          description: "slow",
          inputSchema: { type: "object" },
        },
        async execute() {
          entered.resolve();
          await release.promise;
          return { output: "done", exitCode: 0 };
        },
      },
    ],
  });
  const f = fixture({ tools });
  try {
    const thread = await f.app.startThread();
    const prepared = tools.prepare({
      callId: "test",
      name: "slow",
      arguments: {},
      cwd: thread.cwd,
      threadId: thread.id,
      signal: new AbortController().signal,
      task: { waitForCompletion: true },
    });
    const launched = await f.app.dispatchHostTool(thread, () =>
      tools.execute(prepared),
    );
    await entered.promise;
    await f.app.setThreadArchived(thread.id, true);
    await assert.rejects(
      f.app.deleteThread(thread.id, thread.items.at(-1)!.id),
      code("thread_busy"),
    );
    release.resolve();
    await launched.result;
    await f.app.deleteThread(thread.id, thread.items.at(-1)!.id);
  } finally {
    release.resolve();
    await f.close();
  }
});

for (const committed of [false, true]) {
  test(`failed delete append never claims success (committed=${String(committed)})`, async () => {
    const backing = new InMemoryThreadJournal();
    let fail = true;
    const journal: ThreadJournal = {
      read: (id) => backing.read(id),
      listThreadIds: () => backing.listThreadIds(),
      async append(item) {
        if (item.type === "thread_deleted" && fail) {
          fail = false;
          if (committed) await backing.append(item);
          throw new Error("fixture I/O failed");
        }
        await backing.append(item);
      },
    };
    const f = fixture({ journal });
    try {
      await f.request("zen/initialize");
      const thread = await archive(f);
      assert(
        "error" in
          (await f.receive("zen/thread/delete", {
            threadId: thread.id,
            expectedLastItemId: thread.items.at(-1)!.id,
          })),
      );
      assert.equal(
        f.messages.filter(
          (message) =>
            "method" in message && message.method === "zen/thread/event",
        ).length,
        0,
      );
      assert.equal(
        (await f.app.listThreadSummaries({ archived: true })).length,
        committed ? 0 : 1,
      );
      if (committed)
        await assert.rejects(
          f.app.readThread(thread.id),
          code("thread_deleted"),
        );
      else assert.equal((await f.app.readThread(thread.id)).archived, true);
      await deleteRequest(f, thread);
      assert.equal(
        (await backing.read(thread.id)).filter(
          (item) => item.type === "thread_deleted",
        ).length,
        1,
      );
    } finally {
      await f.close();
    }
  });
}

test("metadata read failures cannot expose or execute deleted history, and failed restoration stays deleted", async () => {
  const backing = new InMemoryThreadMetadataStore();
  let failRead = false,
    failWrite = false;
  const metadata: ThreadMetadataStore = {
    async read(id) {
      if (failRead) throw new Error("fixture metadata offline");
      return await backing.read(id);
    },
    setName: (id, name) => backing.setName(id, name),
    async setArchived(id, archived) {
      if (failWrite) throw new Error("fixture metadata write failed");
      return await backing.setArchived(id, archived);
    },
  };
  const journal = new InMemoryThreadJournal();
  let f = fixture({ journal, metadata });
  try {
    const thread = await archive(f);
    const deletion = await f.app.deleteThread(
      thread.id,
      thread.items.at(-1)!.id,
    );
    failRead = true;
    await f.close();
    f = fixture({ journal, metadata });
    await assert.rejects(f.app.readThread(thread.id), code("thread_deleted"));
    await assert.rejects(
      f.app.startTurn(thread.id, "must not run"),
      code("thread_deleted"),
    );
    assert.deepEqual(await f.app.listThreadSummaries({ archived: true }), []);
    assert.deepEqual(await f.app.listThreads(), []);
    assert.equal(
      (await f.app.listDeletedThreads())[0]?.deletionItemId,
      deletion.deletionItemId,
    );
    failRead = false;
    failWrite = true;
    await assert.rejects(
      f.app.restoreThread(thread.id, deletion.deletionItemId),
      /metadata write failed/,
    );
    await assert.rejects(f.app.readThread(thread.id), code("thread_deleted"));
    assert.equal(
      (await journal.read(thread.id)).at(-1)?.type,
      "thread_deleted",
    );
  } finally {
    await f.close();
  }
});

test("delete and send are serialized under the same mutation fence", async () => {
  const backing = new InMemoryThreadJournal();
  const entered = deferred(),
    release = deferred();
  const journal: ThreadJournal = {
    read: (id) => backing.read(id),
    listThreadIds: () => backing.listThreadIds(),
    async append(item) {
      if (item.type === "thread_deleted") {
        entered.resolve();
        await release.promise;
      }
      await backing.append(item);
    },
  };
  const f = fixture({ journal });
  try {
    const thread = await archive(f);
    const deletion = f.app.deleteThread(thread.id, thread.items.at(-1)!.id);
    await entered.promise;
    const send = f.app.startTurn(thread.id, "must not append");
    const rejected = assert.rejects(send, code("thread_deleted"));
    release.resolve();
    await deletion;
    await rejected;
    assert.equal(
      (await backing.read(thread.id)).some(
        (item) => item.type === "turn_started",
      ),
      false,
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

test("a deletion during native resume cannot return an older readable snapshot", async () => {
  const f = fixture();
  const captured = deferred(),
    release = deferred();
  try {
    await f.request("zen/initialize");
    const thread = await archive(f);
    const resume = f.projection.resume.bind(f.projection);
    f.projection.resume = async (id) => {
      const snapshot = await resume(id);
      captured.resolve();
      await release.promise;
      return snapshot;
    };
    const pending = f.receive("zen/thread/resume", { threadId: thread.id });
    await captured.promise;
    await f.app.deleteThread(thread.id, thread.items.at(-1)!.id);
    release.resolve();
    const result = await pending;
    assert("error" in result);
    assert.match(result.error.message, /deleted during resume/);
    const events = f.messages.filter(
      (message) => "method" in message && message.method === "zen/thread/event",
    );
    assert.equal(events.length, 1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("corrupt journal deletion fails without changing the original fixture bytes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-delete-corrupt-"),
  );
  const filename = path.join(directory, "corrupt.jsonl");
  const bytes = '{"type":"thread_metadata",invalid}\n';
  await writeFile(filename, bytes);
  const metadata = new InMemoryThreadMetadataStore();
  await metadata.setArchived("corrupt", true);
  const f = fixture({ journal: new JsonlThreadJournal(directory), metadata });
  try {
    await f.request("zen/initialize");
    assert(
      "error" in
        (await f.receive("zen/thread/delete", {
          threadId: "corrupt",
          expectedLastItemId: "unknown",
        })),
    );
    assert.equal(await readFile(filename, "utf8"), bytes);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical replay validates lifecycle controls and forbids appending to deleted Threads", () => {
  const metadata: CanonicalItem = {
    type: "thread_metadata",
    id: "metadata",
    threadId: "t",
    createdAt: new Date().toISOString(),
    cwd: os.tmpdir(),
    model: "fake",
    provider: "fake",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  };
  const deletion: CanonicalItem = {
    type: "thread_deleted",
    id: "deletion",
    threadId: "t",
    createdAt: metadata.createdAt,
  };
  const restoration: CanonicalItem = {
    type: "thread_restored",
    id: "restoration",
    threadId: "t",
    createdAt: metadata.createdAt,
    deletionItemId: "deletion",
  };
  assert.throws(
    () => decodeCanonicalItem({ ...deletion, turnId: "invalid" }),
    /turnId/,
  );
  assert.throws(
    () => decodeCanonicalItem({ ...restoration, deletionItemId: "" }),
    /deletionItemId/,
  );
  const thread = new Thread("t", [metadata, deletion]);
  assert.throws(() => thread.append({ ...metadata, id: "new" }), /deleted/);
  assert.throws(
    () => thread.append({ ...restoration, deletionItemId: "stale" }),
    /current deletion/,
  );
  thread.append(restoration);
  assert.equal(thread.deletion, undefined);
  assert.equal(
    new Thread("t", thread.items.map(decodeCanonicalItem)).deletion,
    undefined,
  );
});
