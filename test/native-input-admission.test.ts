import type { RuntimeTrace, TraceEvent } from "../src/trace.js";
import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import {
  ZenAppServer,
  type AppServerEvent,
  type ThreadSnapshot,
} from "../src/app-server.js";
import {
  AttachmentStoreError,
  InMemoryAttachmentStore,
  MAX_IMAGE_BYTES,
} from "../src/attachment.js";
import { pendingQueuedMessages } from "../src/input-queue.js";
import { type CanonicalItem, type UserInput } from "../src/item.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { type ModelAdapter, type ModelEvent } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { type JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import {
  MAX_NATIVE_INPUT_IMAGE_BYTES,
  prepareNativeInput,
} from "../src/protocol/native/input.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import { type NativeTurnSendResult } from "../src/protocol/native/wire.js";
import { AgentRuntime, type RunTurnOptions } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ApprovalHandler,
} from "../src/tool.js";
import { png1x1 } from "./fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Admission waited for execution")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const text = (value: string): UserInput => [{ type: "text", text: value }];
const image = () => ({
  type: "image_bytes",
  mediaType: "image/png",
  dataBase64: Buffer.from(png1x1()).toString("base64"),
});
function createServer(
  options: {
    trace?: RuntimeTrace;
    journal?: InMemoryThreadJournal;
    attachments?: InMemoryAttachmentStore;
    runtime?: AgentRuntime;
    model?: ModelAdapter;
    approvalPolicy?: "always" | "never";
  } = {},
) {
  const model = options.model ?? {
    provider: "native-admission",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", delta: "done" };
    },
  };
  return new ZenAppServer({
    ...(options.trace === undefined
      ? {}
      : {
          auxiliaryModel: {
            trace: options.trace,
            itemListStore: { create: async () => {} },
          },
        }),
    journal: options.journal ?? new InMemoryThreadJournal(),
    attachments: options.attachments ?? new InMemoryAttachmentStore(),
    runtime:
      options.runtime ??
      new AgentRuntime({
        toolEnvironment: new ToolEnvironment({
          runtimes: [new ShellToolRuntime()],
        }),
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
            inputModalities: ["text", "image"],
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
      approvalPolicy: options.approvalPolicy ?? "never",
    },
  });
}
function connect(server: ZenAppServer, requestApproval?: ApprovalHandler) {
  const projection = new NativeRecoveryProjection(server);
  const messages: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: server,
    projection,
    send: (message) => {
      messages.push(message);
    },
    ...(requestApproval === undefined ? {} : { requestApproval }),
  });
  let id = 0;
  return {
    messages,
    connection,
    projection,
    async rpc(method: string, params: unknown = {}) {
      const requestId = ++id;
      await connection.receive({ id: requestId, method, params });
      const reply = messages.find(
        (message) => "id" in message && message.id === requestId,
      );
      assert(reply && ("result" in reply || "error" in reply));
      return reply;
    },
    close() {
      connection.close();
      projection.close();
    },
  };
}
function result<T>(reply: JsonRpcMessage): T {
  assert("result" in reply, JSON.stringify(reply));
  return reply.result as T;
}
function code(reply: JsonRpcMessage) {
  assert("error" in reply, JSON.stringify(reply));
  return (reply.error.data as { zenCode?: string } | undefined)?.zenCode;
}
function event(server: ZenAppServer, type: AppServerEvent["type"]) {
  const gate = deferred();
  const remove = server.subscribe((value) => {
    if (value.type === type) {
      remove();
      gate.resolve();
    }
  });
  return gate.promise;
}
function send(
  threadId: string,
  clientId: string,
  input: readonly unknown[] = text(clientId),
  mode = "queue",
) {
  return { threadId, clientUserMessageId: clientId, input, mode };
}

test("native advertises additive capabilities and preserves legacy start result", async () => {
  const server = createServer();
  const client = connect(server);
  try {
    const init = result<{ processEpoch: string; capabilities: string[] }>(
      await client.rpc("zen/initialize"),
    );
    assert.equal(typeof init.processEpoch, "string");
    assert.deepEqual(init.capabilities, [
      "queued-input-admission-v1",
      "inline-image-input-v1",
    ]);
    const thread = await server.startThread();
    const finished = event(server, "turn_completed");
    const started = result<NativeTurnSendResult>(
      await client.rpc(
        "zen/turn/send",
        send(thread.id, "legacy", text("legacy"), "start"),
      ),
    );
    assert.deepEqual(Object.keys(started), ["turnId"]);
    assert(started.turnId);
    await bounded(finished);
    assert.equal(
      code(
        await client.rpc(
          "zen/turn/send",
          send(thread.id, "legacy", text("legacy")),
        ),
      ),
      "idempotency_conflict",
    );
    const readOnly = new NativeConnection({
      projection: client.projection,
      send: (message) => {
        client.messages.push(message);
      },
    });
    await readOnly.receive({ id: "read-only", method: "zen/initialize" });
    assert.deepEqual(
      result<{ capabilities: string[] }>(client.messages.at(-1)!).capabilities,
      [],
    );
    readOnly.close();
  } finally {
    client.close();
  }
});

for (const mode of ["queue", "batch-next"]) {
  test(`native ${mode} returns durable queued receipt while idle runtime startup is held`, async () => {
    const entered = deferred();
    const release = deferred();
    const runtime = new (class extends AgentRuntime {
      override async runTurn(options: RunTurnOptions) {
        entered.resolve();
        await release.promise;
        await super.runTurn(options);
      }
    })({ toolEnvironment: new ToolEnvironment({ runtimes: [] }) });
    const server = createServer({ runtime });
    const client = connect(server);
    const thread = await server.startThread();
    const finished = event(server, "turn_completed");
    try {
      await client.rpc("zen/initialize");
      const receipt = result<NativeTurnSendResult>(
        await bounded(
          client.rpc(
            "zen/turn/send",
            send(thread.id, "queued", text("hello"), mode),
          ),
        ),
      ).admission!;
      assert.equal(receipt.state, "queued");
      assert.equal(receipt.clientId, "queued");
      assert(receipt.queuedItemId);
      await bounded(entered.promise);
      const before = await server.readThread(thread.id);
      assert.equal(
        before.items.some((item) => item.type === "user_message"),
        false,
      );
      assert.equal(
        before.items.find((item) => item.type === "user_message_queued")?.id,
        receipt.queuedItemId,
      );
      assert.deepEqual(
        result<NativeTurnSendResult>(
          await bounded(
            client.rpc(
              "zen/turn/send",
              send(thread.id, "queued", text("hello"), mode),
            ),
          ),
        ).admission,
        receipt,
      );
      release.resolve();
      await bounded(finished);
      const originalTurn = (await server.readThread(thread.id)).items.find(
        (item) => item.type === "user_message" && item.clientId === "queued",
      );
      assert(originalTurn?.type === "user_message");
      // A later unrelated Turn must never be mistaken for this input's Turn.
      await (
        await server.startTurn(thread.id, "unrelated")
      ).done;
      assert.deepEqual(
        result<NativeTurnSendResult>(
          await client.rpc(
            "zen/turn/send",
            send(thread.id, "queued", text("hello"), mode),
          ),
        ).admission,
        { ...receipt, state: "admitted", turnId: originalTurn.turnId },
      );
    } finally {
      release.resolve();
      client.close();
    }
  });
}

test("native busy queue acknowledges without steering the current Turn and cancellation stays terminal", async () => {
  const entered = deferred();
  const release = deferred();
  let samples = 0;
  const server = createServer({
    model: {
      provider: "busy",
      async *stream(): AsyncIterable<ModelEvent> {
        samples++;
        entered.resolve();
        await release.promise;
        yield { type: "text_delta", delta: "done" };
      },
    },
  });
  const client = connect(server);
  const thread = await server.startThread();
  const active = await server.startTurn(thread.id, "active");
  await entered.promise;
  try {
    await client.rpc("zen/initialize");
    const params = send(thread.id, "pending");
    const receipt = result<NativeTurnSendResult>(
      await bounded(client.rpc("zen/turn/send-unarchived", params)),
    ).admission!;
    assert.equal(receipt.state, "queued");
    assert.equal(
      (await server.readThread(thread.id)).items.filter(
        (item) => item.type === "user_message",
      ).length,
      1,
    );
    assert.equal(
      code(
        await client.rpc("zen/turn/send", {
          ...params,
          input: text("changed"),
        }),
      ),
      "idempotency_conflict",
    );
    assert.equal(
      code(
        await client.rpc("zen/turn/send", { ...params, mode: "batch-next" }),
      ),
      "idempotency_conflict",
    );
    const cancelled = result<{ results: { status: string }[] }>(
      await client.rpc("zen/thread/queue/cancel", {
        threadId: thread.id,
        items: [
          { clientId: receipt.clientId, queuedItemId: receipt.queuedItemId },
        ],
      }),
    );
    assert.equal(cancelled.results[0]?.status, "cancelled");
    assert.equal(
      code(await client.rpc("zen/turn/send", params)),
      "queue_id_cancelled",
    );
    release.resolve();
    await active.done;
    assert.equal(samples, 1);
  } finally {
    release.resolve();
    client.close();
  }
});

test("inline queue ack precedes held preflight; failure is live and both native and Core duplicates never Resume", async () => {
  const entered = deferred();
  const release = deferred();
  const attachments = new InMemoryAttachmentStore();
  const read = attachments.read.bind(attachments);
  let reads = 0;
  let fail = true;
  let samples = 0;
  attachments.read = async (ref) => {
    if (++reads === 2) {
      entered.resolve();
      await release.promise;
      if (fail)
        throw new AttachmentStoreError(
          "attachment_missing",
          "private failure details",
        );
    }
    return read(ref);
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({
    journal,
    attachments,
    model: {
      provider: "preflight",
      async *stream(): AsyncIterable<ModelEvent> {
        samples++;
        yield { type: "text_delta", delta: "done" };
      },
    },
  });
  const client = connect(server);
  const thread = await server.startThread();
  try {
    await client.rpc("zen/initialize");
    const failed = event(server, "queue_failed");
    const receipt = result<NativeTurnSendResult>(
      await bounded(
        client.rpc("zen/turn/send", send(thread.id, "image", [image()])),
      ),
    ).admission!;
    await bounded(entered.promise);
    assert.equal(samples, 0);
    release.resolve();
    await bounded(failed);
    assert.equal(
      JSON.stringify(client.messages).includes("private failure details"),
      false,
    );
    const canonical = (await server.readThread(thread.id)).items.find(
      (item) => item.type === "user_message_queued",
    );
    assert(canonical?.type === "user_message_queued");
    const before = (await server.readThread(thread.id)).items;
    assert.deepEqual(
      await server.queueMessage(thread.id, canonical.input, "image"),
      receipt,
    );
    assert.deepEqual(
      result<NativeTurnSendResult>(
        await client.rpc("zen/turn/send", send(thread.id, "image", [image()])),
      ).admission,
      receipt,
    );
    assert.deepEqual((await server.readThread(thread.id)).items, before);
    assert.equal(samples, 0);
    // A new Host epoch recovers pending authority, without replaying failure or starting it.
    const restarted = createServer({ journal, attachments });
    const recovered = connect(restarted);
    try {
      const recovery = result<{ thread: ThreadSnapshot; events: unknown[] }>(
        await recovered.rpc("zen/thread/resume", { threadId: thread.id }),
      );
      assert.equal(
        pendingQueuedMessages(recovery.thread.items)[0]?.id,
        receipt.queuedItemId,
      );
      assert.deepEqual(recovery.events, []);
    } finally {
      recovered.close();
    }
    fail = false;
    const finished = event(server, "turn_completed");
    await server.resumeQueue(thread.id);
    await bounded(finished);
    assert.equal(samples, 1);
  } finally {
    release.resolve();
    client.close();
  }
});

test("native queue passes the existing approval handler and does not wait on approval", async () => {
  const asked = deferred();
  const release = deferred();
  let samples = 0;
  const server = createServer({
    approvalPolicy: "always",
    model: {
      provider: "approval",
      async *stream(): AsyncIterable<ModelEvent> {
        if (++samples === 1)
          yield {
            type: "tool_call",
            callId: "approval-call",
            name: "shell",
            arguments: { command: "must-not-execute" },
          };
        else yield { type: "text_delta", delta: "done" };
      },
    },
  });
  const client = connect(server, async () => {
    asked.resolve();
    await release.promise;
    return "decline";
  });
  const thread = await server.startThread();
  try {
    await client.rpc("zen/initialize");
    const finished = event(server, "turn_completed");
    const receipt = result<NativeTurnSendResult>(
      await bounded(client.rpc("zen/turn/send", send(thread.id, "approval"))),
    ).admission!;
    assert.equal(receipt.state, "queued");
    await bounded(asked.promise);
    const retry = result<NativeTurnSendResult>(
      await bounded(client.rpc("zen/turn/send", send(thread.id, "approval"))),
    ).admission!;
    assert.equal(retry.state, "admitted");
    assert.equal(retry.queuedItemId, receipt.queuedItemId);
    release.resolve();
    await bounded(finished);
    const tool = (await server.readThread(thread.id)).items.find(
      (item) => item.type === "tool_result",
    );
    assert(tool?.type === "tool_result");
    assert.equal(tool.executionStatus, "declined");
  } finally {
    release.resolve();
    client.close();
  }
});

for (const persisted of [false, true]) {
  test(`queue append unknown (${persisted ? "written" : "not written"}) remains unknown; read-only recovery never resends`, async () => {
    class UncertainJournal extends InMemoryThreadJournal {
      override async append(item: CanonicalItem) {
        if (item.type === "user_message_queued") {
          if (persisted) await super.append(item);
          throw new Error("secret append detail");
        }
        await super.append(item);
      }
    }
    const journal = new UncertainJournal();
    const server = createServer({ journal });
    const client = connect(server);
    const thread = await server.startThread();
    try {
      await client.rpc("zen/initialize");
      const reply = await client.rpc(
        "zen/turn/send",
        send(thread.id, "unknown"),
      );
      assert("error" in reply);
      assert.equal(reply.error.code, -32603);
      assert.equal(code(reply), "admission_outcome_unknown");
      assert.match(reply.error.message, /unconfirmed/);
      assert(!reply.error.message.includes("secret"));
      const before = await journal.read(thread.id);
      const read = result<{ thread: ThreadSnapshot }>(
        await client.rpc("zen/thread/read", { threadId: thread.id }),
      );
      assert.equal(
        pendingQueuedMessages(read.thread.items).length,
        persisted ? 1 : 0,
      );
      assert.equal(
        read.thread.items.some((item) => item.type === "user_message"),
        false,
      );
      assert.deepEqual(await journal.read(thread.id), before);
      if (persisted)
        assert.equal(
          result<NativeTurnSendResult>(
            await client.rpc("zen/turn/send", send(thread.id, "unknown")),
          ).admission?.state,
          "queued",
        );
    } finally {
      client.close();
    }
  });
}

test("inline images normalize to stable canonical identity and reject changed bytes without queue mutation", async () => {
  const journal = new InMemoryThreadJournal();
  const server = createServer({ journal });
  const thread = await server.startThread();
  const native = image();
  const ref = await server.importImageBytes(png1x1(), "image/png");
  await journal.append({
    id: "original-queue",
    type: "user_message_queued",
    threadId: thread.id,
    createdAt: new Date().toISOString(),
    clientId: "bytes",
    input: [{ type: "image", attachment: ref }],
  });
  const restarted = createServer({
    journal,
    attachments: new InMemoryAttachmentStore(),
  });
  const client = connect(restarted);
  try {
    await client.rpc("zen/initialize");
    for (const dataBase64 of [
      native.dataBase64,
      native.dataBase64.replace(/=+$/u, ""),
    ]) {
      assert.deepEqual(
        result<NativeTurnSendResult>(
          await client.rpc(
            "zen/turn/send",
            send(thread.id, "bytes", [{ ...native, dataBase64 }]),
          ),
        ).admission,
        { state: "queued", queuedItemId: "original-queue", clientId: "bytes" },
      );
    }
    const different = {
      type: "image_bytes",
      mediaType: "image/gif",
      dataBase64: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    };
    assert.equal(
      code(
        await client.rpc(
          "zen/turn/send",
          send(thread.id, "bytes", [different]),
        ),
      ),
      "idempotency_conflict",
    );
    assert.equal(
      (await journal.read(thread.id)).filter(
        (item) => item.type === "user_message_queued",
      ).length,
      1,
    );
  } finally {
    client.close();
  }
});

test("inline input validation is atomic for queue admission and bounds images before decode/import", async () => {
  const attachments = new InMemoryAttachmentStore();
  let imports = 0;
  const imported = attachments.importBytes.bind(attachments);
  attachments.importBytes = async (...args) => {
    imports++;
    return imported(...args);
  };
  const server = createServer({ attachments });
  const client = connect(server);
  const thread = await server.startThread();
  const valid = image();
  try {
    await client.rpc("zen/initialize");
    const before = (await server.readThread(thread.id)).items;
    const cases: { input: unknown[]; error?: string; noImport?: boolean }[] = [
      {
        input: [{ ...valid, dataBase64: "not base64!" }],
        error: "attachment_invalid",
        noImport: true,
      },
      {
        input: [{ ...valid, dataBase64: "Zh==" }],
        error: "attachment_invalid",
        noImport: true,
      },
      {
        input: [{ ...valid, mediaType: "image/jpeg" }],
        error: "attachment_mime_mismatch",
      },
      {
        input: [{ ...valid, mediaType: "image/svg+xml" }],
        error: "invalid_input",
        noImport: true,
      },
      {
        input: [{ ...valid, path: "/tmp/private.png" }],
        error: "invalid_input",
        noImport: true,
      },
      {
        input: [{ type: "localImage", path: "/tmp/private.png" }],
        noImport: true,
      },
      {
        input: [
          {
            ...valid,
            dataBase64: Buffer.from("not an image").toString("base64"),
          },
        ],
        error: "attachment_invalid",
      },
      {
        input: [valid, { ...valid, dataBase64: "%%%" }],
        error: "attachment_invalid",
      },
      {
        input: [
          valid,
          { type: "text", text: "forged", skillSource: { kind: "catalog" } },
        ],
        error: "invalid_input",
        noImport: true,
      },
      {
        input: [
          {
            ...valid,
            dataBase64: "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1),
          },
        ],
        error: "attachment_too_large",
        noImport: true,
      },
      {
        input: Array.from({ length: 17 }, () => valid),
        error: "attachment_too_large",
        noImport: true,
      },
      {
        input: [
          {
            ...valid,
            dataBase64: "A".repeat(
              Math.ceil((MAX_NATIVE_INPUT_IMAGE_BYTES / 2 + 3) / 3) * 4,
            ),
          },
          {
            ...valid,
            dataBase64: "A".repeat(
              Math.ceil((MAX_NATIVE_INPUT_IMAGE_BYTES / 2 + 3) / 3) * 4,
            ),
          },
        ],
        error: "attachment_too_large",
        noImport: true,
      },
    ];
    for (const [index, candidate] of cases.entries()) {
      const initial = imports;
      const reply = await client.rpc(
        "zen/turn/send",
        send(thread.id, `bad-${index}`, candidate.input),
      );
      assert("error" in reply, String(index));
      if (candidate.error)
        assert.equal(code(reply), candidate.error, String(index));
      if (candidate.noImport) assert.equal(imports, initial, String(index));
      assert.deepEqual((await server.readThread(thread.id)).items, before);
    }
    // A successful import preceding a later invalid part leaves only existing content storage.
    assert.deepEqual(
      await server.importImageBytes(png1x1()),
      await imported(png1x1()),
    );
  } finally {
    client.close();
  }
});

test("inline envelope budgets count only image bytes and retain canonical-only compatibility", async () => {
  const attachments = new InMemoryAttachmentStore();
  const server = createServer({ attachments });
  const attachment = await server.importImageBytes(png1x1());
  const canonical = { type: "image", attachment };
  assert.equal(
    (
      await prepareNativeInput(
        Array.from({ length: 17 }, () => canonical),
        server,
      )
    ).length,
    17,
  );
  await assert.rejects(
    prepareNativeInput(
      [...Array.from({ length: 16 }, () => canonical), image()],
      server,
    ),
    { code: "attachment_too_large" },
  );
  const oversized = {
    type: "image",
    attachment: { ...attachment, byteLength: MAX_IMAGE_BYTES },
  };
  await assert.rejects(
    prepareNativeInput([image(), oversized, oversized], server),
    { code: "attachment_too_large" },
  );
  // This new image budget does not introduce an unrelated text-byte restriction.
  const largeText = "t".repeat(MAX_NATIVE_INPUT_IMAGE_BYTES + 1);
  assert.equal(
    (await prepareNativeInput([...text(largeText), image()], server)).length,
    2,
  );
});

test("inline validation retains canonical dimension and pixel limits", async () => {
  const server = createServer();
  const client = connect(server);
  const thread = await server.startThread();
  try {
    await client.rpc("zen/initialize");
    for (const [width, height] of [
      [16385, 1],
      [10000, 5000],
    ]) {
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      gif.writeUInt16LE(width!, 6);
      gif.writeUInt16LE(height!, 8);
      assert.equal(
        code(
          await client.rpc(
            "zen/turn/send",
            send(thread.id, `dimensions-${width}`, [
              {
                type: "image_bytes",
                mediaType: "image/gif",
                dataBase64: gif.toString("base64"),
              },
            ]),
          ),
        ),
        "attachment_dimensions_exceeded",
      );
    }
    assert.equal(
      (await server.readThread(thread.id)).items.some(
        (item) => item.type === "user_message_queued",
      ),
      false,
    );
  } finally {
    client.close();
  }
});

test("inline bytes cannot admit an uninitialized, missing, archived or deleted target", async () => {
  const journal = new InMemoryThreadJournal();
  const attachments = new InMemoryAttachmentStore();
  const server = createServer({ journal, attachments });
  const client = connect(server);
  let imports = 0;
  const importBytes = attachments.importBytes.bind(attachments);
  attachments.importBytes = async (...args) => {
    imports++;
    return importBytes(...args);
  };
  try {
    const thread = await server.startThread();
    const before = await journal.read(thread.id);
    const denied = await client.rpc(
      "zen/turn/send",
      send(thread.id, "not-initialized", [image()]),
    );
    assert("error" in denied);
    assert.equal(denied.error.code, -32600);
    assert.equal(imports, 0);
    await client.rpc("zen/initialize");
    assert.equal(
      code(
        await client.rpc(
          "zen/turn/send",
          send("missing", "missing", [image()]),
        ),
      ),
      "thread_not_found",
    );
    await server.setThreadArchived(thread.id, true);
    assert.equal(
      code(
        await client.rpc(
          "zen/turn/send-unarchived",
          send(thread.id, "archived", [image()]),
        ),
      ),
      "operation_forbidden",
    );
    assert.deepEqual(await journal.read(thread.id), before);
    await server.deleteThread(thread.id, before.at(-1)!.id);
    const deleted = await journal.read(thread.id);
    assert.equal(
      code(
        await client.rpc(
          "zen/turn/send",
          send(thread.id, "deleted", [image()]),
        ),
      ),
      "thread_deleted",
    );
    assert.deepEqual(await journal.read(thread.id), deleted);
    assert.deepEqual(await journal.read("missing"), []);
    assert(imports > 0); // Imported orphan bytes do not imply queue admission.
  } finally {
    client.close();
  }
});

test("client activation, independent Host receipt and rejected admission are Trace-only facts", async () => {
  const observations: TraceEvent[] = [];
  const trace: RuntimeTrace = {
    async record(event) {
      observations.push(event);
      return {
        durability: "durable",
        recordId: String(observations.length),
        sequence: observations.length,
        sync: "file",
      };
    },
  };
  const server = createServer({ trace });
  const client = connect(server);
  try {
    result(await client.rpc("zen/initialize"));
    const thread = await server.startThread();
    const clientObservation = {
      requestId: "synthetic-click",
      action: "send",
      clock: {
        domain: "renderer-synthetic",
        monotonicNs: "1",
        wallTime: "2099-01-01T00:00:00.000Z",
      },
    };
    result(
      await client.rpc("zen/trace/client-activation", {
        observation: clientObservation,
      }),
    );
    assert.equal(observations[0]?.threadId, "ui-activations");
    const reply = await client.rpc("zen/turn/send", {
      threadId: thread.id,
      clientUserMessageId: "synthetic-client",
      input: [],
      clientObservation,
    });
    assert("error" in reply);
    const received = observations.find(
      (e) => e.type === "client_request_received",
    )!;
    const facts = received.data as {
      clientObservation: unknown;
      hostReceived: { domain: string; wallTime: string };
      requestId: string;
    };
    assert.deepEqual(facts.clientObservation, clientObservation);
    assert.notEqual(facts.hostReceived.domain, clientObservation.clock.domain);
    assert.notEqual(
      facts.hostReceived.wallTime,
      clientObservation.clock.wallTime,
    );
    const finished = observations.find(
      (e) => e.type === "client_request_finished",
    )!.data as { requestId: string; outcome: string };
    assert.equal(finished.requestId, facts.requestId);
    assert.equal(finished.outcome, "rejected");
    assert(!observations.some((e) => e.type.startsWith("model_")));
    assert.equal(
      (await server.readThread(thread.id)).items.filter(
        (e) => e.type === "user_message",
      ).length,
      0,
    );
  } finally {
    client.close();
  }
});

test("malformed optional client clocks cannot change admission; failed activation capture is explicit", async () => {
  const observations: TraceEvent[] = [];
  const trace: RuntimeTrace = {
    async record(event) {
      observations.push(event);
      return { durability: "degraded", error: "synthetic disk failure" };
    },
  };
  const server = createServer({ trace });
  const client = connect(server);
  const original = console.error;
  console.error = () => {};
  try {
    result(await client.rpc("zen/initialize"));
    const thread = await server.startThread();
    const activation = result<{ observed: boolean }>(
      await client.rpc("zen/trace/client-activation", {
        observation: {
          requestId: "click",
          action: "send",
          clock: {
            domain: "renderer",
            monotonicNs: "1",
            wallTime: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    assert.equal(activation.observed, false);
    const finished = event(server, "turn_completed");
    const admission = result<NativeTurnSendResult>(
      await client.rpc("zen/turn/send", {
        ...send(thread.id, "malformed-clock", text("synthetic"), "start"),
        clientObservation: { clock: { monotonicNs: "not a clock" } },
      }),
    );
    assert(admission.turnId);
    await finished;
    const received = observations.find(
      (e) => e.type === "client_request_received",
    )!.data as Record<string, unknown>;
    assert.equal(received.clientObservationStatus, "invalid");
    assert.equal(received.clientObservation, undefined);
    assert.equal(
      (await server.readThread(thread.id)).items.filter(
        (e) => e.type === "user_message",
      ).length,
      1,
    );
  } finally {
    console.error = original;
    client.close();
  }
});

test("queued and cancelled input receipts create no pretend sample or execution completion", async () => {
  const observations: TraceEvent[] = [];
  const gate = deferred();
  const entered = deferred();
  let calls = 0;
  const server = createServer({
    trace: {
      async record(event) {
        observations.push(event);
        return {
          durability: "durable",
          recordId: String(observations.length),
          sequence: observations.length,
          sync: "file",
        };
      },
    },
    model: {
      provider: "synthetic-queue",
      async *stream() {
        calls++;
        entered.resolve();
        await gate.promise;
        yield { type: "text_delta", delta: "done" };
      },
    },
  });
  const client = connect(server);
  try {
    result(await client.rpc("zen/initialize"));
    const thread = await server.startThread();
    const active = await server.startTurn(thread.id, text("active"));
    await entered.promise;
    const queued = result<NativeTurnSendResult>(
      await client.rpc(
        "zen/turn/send",
        send(thread.id, "queued-observed", text("queued"), "queue"),
      ),
    );
    assert.equal(queued.admission?.state, "queued");
    result(
      await client.rpc("zen/thread/queue/cancel", {
        threadId: thread.id,
        items: [
          {
            clientId: "queued-observed",
            queuedItemId: queued.admission!.queuedItemId,
          },
        ],
      }),
    );
    assert.equal(calls, 1);
    const receipts = observations
      .filter((e) => e.type === "client_request_finished")
      .map(
        (e) => e.data as { outcome: string; result: Record<string, unknown> },
      );
    assert.equal(receipts.length, 2);
    assert(receipts.every((e) => e.outcome === "accepted"));
    assert.equal(
      (receipts[0]!.result.admission as { state: string }).state,
      "queued",
    );
    assert.equal(
      (receipts[1]!.result.results as Array<{ status: string }>)[0]!.status,
      "cancelled",
    );
    gate.resolve();
    await active.done;
    assert.equal(calls, 1);
  } finally {
    gate.resolve();
    client.close();
  }
});
