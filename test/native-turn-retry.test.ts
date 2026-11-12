import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { decodeCanonicalItem, type CanonicalItem } from "../src/item.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelEvent } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ApprovalHandler,
} from "../src/tool.js";

function createServer(
  options: {
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
    journal: options.journal ?? new InMemoryThreadJournal(),
    attachments: options.attachments ?? new InMemoryAttachmentStore(),
    runtime:
      options.runtime ??
      new AgentRuntime({
        sampleRetry: { maxAttempts: 1 },
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

function failingModel(): ModelAdapter {
  return {
    provider: "native-admission",
    async *stream(): AsyncIterable<ModelEvent> {
      throw new Error("synthetic terminal failure");
    },
  };
}
async function failed(server: ZenAppServer) {
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "original instruction");
  await turn.done.catch(() => {});
  return { thread, turn };
}
for (const language of ["zh-CN", "en"] as const)
  test(`retry appends localized continuation ${language} and preserves history`, async () => {
    const server = createServer({ model: failingModel() });
    const { thread, turn } = await failed(server);
    const before = (await server.readThread(thread.id)).items;
    const retry = await server.retryTurn(thread.id, turn.id, language, {
      clientId: "manual-1",
    });
    await retry.done.catch(() => {});
    const after = (await server.readThread(thread.id)).items;
    assert.deepEqual(after.slice(0, before.length), before);
    const message = after.find(
      (item) => item.type === "user_message" && item.clientId === "manual-1",
    );
    assert.equal(message?.type, "user_message");
    assert.equal(
      JSON.stringify(message).includes(language === "zh-CN" ? "继续" : "Go on"),
      true,
    );
    const start = after.find(
      (item) => item.type === "turn_started" && item.turnId === retry.id,
    );
    assert.equal(
      start?.type === "turn_started" ? start.retryOfTurnId : undefined,
      turn.id,
    );
    const duplicate = await server.retryTurn(thread.id, turn.id, language, {
      clientId: "manual-1",
    });
    assert.equal(duplicate.id, retry.id);
    assert.equal(
      (await server.readThread(thread.id)).items.length,
      after.length,
    );
    await assert.rejects(
      server.retryTurn(thread.id, turn.id, language === "en" ? "zh-CN" : "en", {
        clientId: "manual-1",
      }),
      { code: "idempotency_conflict" },
    );
  });
test("retry identity survives cold reload and rejects a different predecessor", async () => {
  const journal = new InMemoryThreadJournal();
  const server = createServer({ journal, model: failingModel() });
  const { thread, turn } = await failed(server);
  const retry = await server.retryTurn(thread.id, turn.id, "en", {
    clientId: "manual",
  });
  await retry.done.catch(() => {});
  const cold = createServer({ journal, model: failingModel() });
  const duplicate = await cold.retryTurn(thread.id, turn.id, "en", {
    clientId: "manual",
  });
  assert.equal(duplicate.id, retry.id);
  await assert.rejects(
    cold.retryTurn(thread.id, retry.id, "en", { clientId: "manual" }),
    { code: "idempotency_conflict" },
  );
});
test("concurrent duplicate clicks admit once; different identities fence stale targets", async () => {
  const server = createServer({ model: failingModel() });
  const { thread, turn } = await failed(server);
  const results = await Promise.all(
    [1, 2].map(() =>
      server.retryTurn(thread.id, turn.id, "en", { clientId: "same" }),
    ),
  );
  assert.equal(results[0]!.id, results[1]!.id);
  await results[0]!.done.catch(() => {});
  await assert.rejects(
    server.retryTurn(thread.id, turn.id, "en", { clientId: "different" }),
    { code: "retry_target_changed" },
  );
  assert.equal(
    (await server.readThread(thread.id)).items.filter(
      (i) => i.type === "user_message" && i.clientId === "same",
    ).length,
    1,
  );
});
test("normal same-text messages cannot masquerade as manual retry identities", async () => {
  const server = createServer({ model: failingModel() });
  const { thread, turn } = await failed(server);
  const normal = await server.startTurn(thread.id, "Go on", {
    clientId: "normal",
  });
  await normal.done.catch(() => {});
  await assert.rejects(
    server.retryTurn(thread.id, turn.id, "en", { clientId: "normal" }),
    { code: "idempotency_conflict" },
  );
});
test("completed or absent terminal targets are rejected", async () => {
  const server = createServer();
  const thread = await server.startThread();
  await assert.rejects(
    server.retryTurn(thread.id, "missing", "en", { clientId: "first" }),
    { code: "retry_target_changed" },
  );
  const turn = await server.startTurn(thread.id, "done");
  await turn.done;
  await assert.rejects(
    server.retryTurn(thread.id, turn.id, "en", { clientId: "second" }),
    { code: "retry_target_changed" },
  );
});
test("native retry validates its dedicated strict contract", async () => {
  const server = createServer({ model: failingModel() });
  const { thread, turn } = await failed(server);
  const client = connect(server);
  try {
    await client.rpc("zen/initialize", {});
    for (const extra of [
      { language: "fr" },
      { input: "replay" },
      { expectedTurnId: "" },
    ]) {
      const response = await client.rpc("zen/turn/retry", {
        threadId: thread.id,
        expectedTurnId: turn.id,
        clientUserMessageId: "rpc",
        language: "en",
        ...extra,
      });
      assert.equal("error" in response, true);
    }
    const response = await client.rpc("zen/turn/retry", {
      threadId: thread.id,
      expectedTurnId: turn.id,
      clientUserMessageId: "rpc",
      language: "en",
    });
    assert.equal("result" in response, true, JSON.stringify(response));
  } finally {
    client.close();
  }
});
test("cold orphan live Turn cannot retry an earlier failure", async () => {
  const journal = new InMemoryThreadJournal();
  const server = createServer({ journal, model: failingModel() });
  const { thread, turn } = await failed(server);
  await journal.append({
    id: "orphan-start",
    turnId: "orphan",
    threadId: thread.id,
    createdAt: new Date().toISOString(),
    type: "turn_started",
  });
  const cold = createServer({ journal, model: failingModel() });
  await assert.rejects(
    cold.retryTurn(thread.id, turn.id, "en", { clientId: "cold" }),
    { code: "retry_target_changed" },
  );
  await assert.rejects(
    cold.retryTurn(thread.id, "orphan", "en", { clientId: "cold" }),
    { code: "retry_target_changed" },
  );
});
test("forked history cannot authorize inherited retry identities or terminal targets", async () => {
  const server = createServer({ model: failingModel() });
  const { thread, turn } = await failed(server);
  const retry = await server.retryTurn(thread.id, turn.id, "en", {
    clientId: "source-retry",
  });
  await retry.done.catch(() => {});
  const fork = await server.createChildThread({
    parentThreadId: thread.id,
    mode: "side-chat",
  });
  await assert.rejects(
    server.retryTurn(fork.id, turn.id, "en", { clientId: "source-retry" }),
    { code: "idempotency_conflict" },
  );
  await assert.rejects(
    server.retryTurn(fork.id, retry.id, "en", { clientId: "new" }),
    { code: "retry_target_changed" },
  );
});
test("canonical stopped Turn permits explicit continuation only", async () => {
  const journal = new InMemoryThreadJournal();
  const server = createServer({ journal });
  const thread = await server.startThread();
  const common = {
    threadId: thread.id,
    turnId: "stopped",
    createdAt: new Date().toISOString(),
  };
  await journal.append({ ...common, id: "start", type: "turn_started" });
  await journal.append({
    ...common,
    id: "stop",
    type: "turn_aborted",
    reason: "User stopped",
  });
  const cold = createServer({ journal });
  const before = (await cold.readThread(thread.id)).items;
  assert.equal(before.filter((i) => i.type === "turn_started").length, 1);
  const retry = await cold.retryTurn(thread.id, "stopped", "en", {
    clientId: "explicit",
  });
  await retry.done;
  assert.equal(
    (await cold.readThread(thread.id)).items.filter(
      (i) => i.type === "turn_started",
    ).length,
    2,
  );
});
test("archive prevents new retry but does not hide existing receipt", async () => {
  const server = createServer({ model: failingModel() });
  const { thread, turn } = await failed(server);
  const retry = await server.retryTurn(thread.id, turn.id, "en", {
    clientId: "receipt",
  });
  await retry.done.catch(() => {});
  await server.setThreadArchived(thread.id, true);
  assert.equal(
    (await server.retryTurn(thread.id, turn.id, "en", { clientId: "receipt" }))
      .id,
    retry.id,
  );
  await assert.rejects(
    server.retryTurn(thread.id, retry.id, "en", { clientId: "new" }),
    { code: "operation_forbidden" },
  );
});
test("pending queued input fences manual continuation", async () => {
  const journal = new InMemoryThreadJournal();
  const server = createServer({ journal, model: failingModel() });
  const { thread, turn } = await failed(server);
  await journal.append({
    id: "queued",
    threadId: thread.id,
    createdAt: new Date().toISOString(),
    type: "user_message_queued",
    clientId: "queued-client",
    input: [{ type: "text", text: "pending" }],
  });
  const cold = createServer({ journal, model: failingModel() });
  await assert.rejects(
    cold.retryTurn(thread.id, turn.id, "en", { clientId: "manual" }),
    { code: "queue_pending" },
  );
});
test("retry provenance is optional and schema validated", () => {
  const base = {
    id: "start",
    threadId: "thread",
    turnId: "turn",
    createdAt: new Date().toISOString(),
    type: "turn_started",
  };
  assert.equal(decodeCanonicalItem(base).type, "turn_started");
  assert.equal(
    decodeCanonicalItem({ ...base, retryOfTurnId: "failed" }).type,
    "turn_started",
  );
  for (const retryOfTurnId of ["", 42, null])
    assert.throws(() => decodeCanonicalItem({ ...base, retryOfTurnId }));
});
for (const persisted of [false, true])
  test(`retry admission uncertainty (${persisted}) never automatically replays`, async () => {
    class UncertainJournal extends InMemoryThreadJournal {
      override async append(item: CanonicalItem) {
        if (item.type === "user_message" && item.clientId === "uncertain") {
          if (persisted) await super.append(item);
          throw new Error("private journal detail");
        }
        await super.append(item);
      }
    }
    const journal = new UncertainJournal();
    const server = createServer({ journal, model: failingModel() });
    const { thread, turn } = await failed(server);
    const client = connect(server);
    try {
      await client.rpc("zen/initialize");
      const response = await client.rpc("zen/turn/retry", {
        threadId: thread.id,
        expectedTurnId: turn.id,
        clientUserMessageId: "uncertain",
        language: "en",
      });
      assert("error" in response);
      assert.equal(
        (response.error.data as { zenCode: string }).zenCode,
        "admission_outcome_unknown",
      );
      assert.equal(response.error.message.includes("private"), false);
      const before = await journal.read(thread.id);
      await client.rpc("zen/thread/read", { threadId: thread.id });
      assert.deepEqual(await journal.read(thread.id), before);
      assert.equal(
        before.filter(
          (i) => i.type === "user_message" && i.clientId === "uncertain",
        ).length,
        persisted ? 1 : 0,
      );
    } finally {
      client.close();
    }
  });
test("gated live retry coalesces its receipt and rejects competing manual identities", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let samples = 0;
  const server = createServer({
    model: {
      provider: "gated",
      async *stream(): AsyncIterable<ModelEvent> {
        if (++samples === 1) throw new Error("initial failure");
        await gate;
        yield { type: "text_delta", delta: "continued" };
      },
    },
  });
  const { thread, turn } = await failed(server);
  const retry = await server.retryTurn(thread.id, turn.id, "en", {
    clientId: "first",
  });
  try {
    assert.equal(
      (await server.retryTurn(thread.id, turn.id, "en", { clientId: "first" }))
        .id,
      retry.id,
    );
    await assert.rejects(
      server.retryTurn(thread.id, turn.id, "en", { clientId: "second" }),
      { code: "retry_target_changed" },
    );
    await assert.rejects(
      server.retryTurn(thread.id, turn.id, "zh-CN", { clientId: "first" }),
      { code: "idempotency_conflict" },
    );
  } finally {
    release();
    await retry.done;
  }
  assert.equal(samples, 2);
});
