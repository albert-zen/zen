import assert from "node:assert/strict";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../src/model.js";
import { decodeCanonicalItem, type CanonicalItem } from "../src/item.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { Thread } from "../src/thread.js";

const selection = {
  providerProfileId: "synthetic",
  modelId: "synthetic",
  reasoningEffort: "medium",
};
function fixture(
  adapter: ModelAdapter,
  journal = new InMemoryThreadJournal(),
  attachments = new InMemoryAttachmentStore(),
) {
  return {
    journal,
    server: new ZenAppServer({
      runtime: new AgentRuntime({
        toolEnvironment: new ToolEnvironment({ bundles: [] }),
      }),
      journal,
      attachments,
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "synthetic",
          adapter,
          modelCatalog: new StaticModelCatalog([
            { id: "synthetic", isDefault: true, contextWindow: 32768 },
          ]),
        },
      ]),
      threadMetadata: new InMemoryThreadMetadataStore(),
      defaults: {
        ...selection,
        cwd: "/tmp",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    }),
  };
}
const plain: ModelAdapter = {
  provider: "synthetic",
  async *stream() {
    yield { type: "text_delta", delta: "synthetic result" };
  },
};

test("title operation derives input from canonical user, commits before dispatch, and adds no Turn/chat prompt", async () => {
  const requests: ModelRequest[] = [];
  const journal = new InMemoryThreadJournal();
  const adapter: ModelAdapter = {
    provider: "synthetic",
    contextInstructions: "synthetic static",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(request);
      if (request.debugContext?.purpose === "operation") {
        assert(
          f.server
            .activitySnapshot()
            .rootOperations.some(
              (operation) =>
                operation.kind === "provider" &&
                operation.label === "model-operation/title",
            ),
        );
        const items = await journal.read(request.debugContext.threadId);
        const content = items
          .filter((item) => item.type === "context_message")
          .flatMap((item) => item.content)
          .filter((part) => part.type === "text")
          .map((part) => part.text);
        const message = request.messages[0];
        assert(message?.role === "user" && "text" in message);
        assert(content.includes(message.text));
        assert(content.includes(request.instructions!));
        assert.equal(message.text, "Title this: first canonical request");
      }
      yield { type: "text_delta", delta: "synthetic result" };
    },
  };
  const f = fixture(adapter, journal);
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "first canonical request")
  ).done;
  const before = await f.server.readThread(thread.id);
  const source = before.items.find((item) => item.type === "user_message")!;
  const beforeMessages = compileModelMessages(before.items);
  const result = await f.server.runModelOperation({
    kind: "title",
    threadId: thread.id,
    sourceItemId: source.id,
    selection,
    titleTemplate: "Title this: {{request}}",
  });
  assert.equal(result.status, "completed");
  assert.equal(
    result.content?.[0]?.type === "text" && result.content[0].text,
    "synthetic result",
  );
  const after = await f.server.readThread(thread.id);
  assert.equal(after.turns.length, before.turns.length);
  assert.deepEqual(after.items.slice(0, before.items.length), before.items);
  assert.deepEqual(compileModelMessages(after.items), beforeMessages);
  assert.equal(requests.length, 2);
  assert.equal(
    after.items.filter((item) => item.type === "model_operation_completed")
      .length,
    1,
  );
  assert.equal((await f.server.listThreadSummaries()).length, 1);
});

test("image probe has one-token request, native attachment and debug-visible operation history, not ordinary chat", async () => {
  let captured: ModelRequest | undefined;
  const f = fixture({
    provider: "synthetic",
    async *stream(request) {
      captured = request;
      yield { type: "text_delta", delta: "OK" };
    },
  });
  const result = await f.server.runModelOperation({
    kind: "image-capability-probe",
    selection,
  });
  assert.equal(result.probeOutcome, "supported");
  assert.equal(captured?.maxOutputTokens, 1);
  assert.equal(captured?.debugContext?.purpose, "operation");
  const message = captured?.messages[0];
  assert(message?.role === "user" && "content" in message);
  assert.deepEqual(
    message.content.map((part) => part.type),
    ["text", "image"],
  );
  assert.equal((await f.server.listThreads()).length, 0);
  assert.equal((await f.server.listThreadSummaries()).length, 0);
  const visible = await f.server.listThreadSummaries({
    includeOperations: true,
  });
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.purpose, "image-capability-probe");
  const snapshot = await f.server.readThread(result.threadId);
  assert.equal(snapshot.turns.length, 0);
  assert.equal(
    snapshot.items.filter((item) => item.type === "model_operation").length,
    1,
  );
  assert.equal(
    snapshot.items.filter((item) => item.type === "model_operation_completed")
      .length,
    1,
  );
  assert.deepEqual(compileModelMessages(snapshot.items), []);
  await assert.rejects(
    f.server.startTurn(result.threadId, "cannot become a chat"),
    /cannot accept conversation/,
  );
  const reloaded = fixture(plain, f.journal);
  assert.deepEqual(
    (await reloaded.server.readThread(result.threadId)).items,
    snapshot.items,
  );
  assert.equal(
    (await reloaded.server.listThreadSummaries({ includeOperations: true }))
      .length,
    1,
  );
});

test("auxiliary source, public purpose spoof, and duplicate terminal are rejected", async () => {
  const f = fixture(plain);
  const thread = await f.server.startThread();
  await assert.rejects(
    f.server.startThread({ purpose: "image-capability-probe" } as never),
    /Host-only/,
  );
  await assert.rejects(
    f.server.runModelOperation({
      kind: "title",
      threadId: thread.id,
      sourceItemId: thread.items[0]!.id,
      selection,
    }),
    /human message/,
  );
  const result = await f.server.runModelOperation({
    kind: "image-capability-probe",
    selection,
  });
  const snapshot = await f.server.readThread(result.threadId);
  const replay = new Thread(snapshot.id, snapshot.items);
  const terminal = snapshot.items.find(
    (item) => item.type === "model_operation_completed",
  )!;
  assert.throws(
    () => replay.append({ ...terminal, id: "duplicate-terminal" }),
    /terminal result/,
  );
  assert.throws(
    () => decodeCanonicalItem({ ...terminal, status: "other" }),
    /unsupported/,
  );
});

test("auxiliary cancellation preserves observed partial model text, records one terminal and never retries", async () => {
  const controller = new AbortController();
  let calls = 0;
  const f = fixture({
    provider: "synthetic",
    async *stream() {
      calls++;
      yield { type: "text_delta", delta: "partial model text" };
      controller.abort(new Error("synthetic cancellation"));
      throw controller.signal.reason;
    },
  });
  const result = await f.server.runModelOperation(
    { kind: "image-capability-probe", selection },
    controller.signal,
  );
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 1);
  const items = (await f.server.readThread(result.threadId)).items;
  const terminal = items.find(
    (item) => item.type === "model_operation_completed",
  );
  assert(terminal?.type === "model_operation_completed");
  assert.equal(terminal.incomplete, true);
  assert.equal(
    terminal.content?.[0]?.type === "text" && terminal.content[0].text,
    "partial model text",
  );
  assert.match(terminal.error!, /cancelled/);
  const restarted = fixture(plain, f.journal);
  await restarted.server.readThread(result.threadId);
  assert.equal(calls, 1);
});

test("auxiliary context append failure is zero-dispatch and does not write a fake terminal", async () => {
  class Rejecting extends InMemoryThreadJournal {
    override async append(item: CanonicalItem) {
      if (item.type === "context_message")
        throw new Error("unknown auxiliary append");
      await super.append(item);
    }
  }
  let calls = 0;
  const f = fixture(
    {
      provider: "synthetic",
      async *stream() {
        calls++;
        yield { type: "text_delta", delta: "never" };
      },
    },
    new Rejecting(),
  );
  await assert.rejects(
    f.server.runModelOperation({ kind: "image-capability-probe", selection }),
    /unknown auxiliary append/,
  );
  assert.equal(calls, 0);
  const [id] = await f.journal.listThreadIds();
  assert(id);
  assert.equal(
    (await f.journal.read(id)).some(
      (item) => item.type === "model_operation_completed",
    ),
    false,
  );
});

test("title after terminal preserves later compaction in fork, remapping only structural references", async () => {
  const f = fixture(plain);
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "canonical source")
  ).done;
  const source = (await f.server.readThread(thread.id)).items.find(
    (item) => item.type === "user_message",
  )!;
  await f.server.runModelOperation({
    kind: "title",
    threadId: thread.id,
    sourceItemId: source.id,
    selection,
  });
  await f.server.compactThread(thread.id);
  const before = await f.server.readThread(thread.id);
  const fork = await f.server.forkThread({
    sourceThreadId: thread.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  assert(fork.items.some((item) => item.type === "context_compaction"));
  const operation = fork.items.find((item) => item.type === "model_operation");
  assert(operation?.type === "model_operation");
  assert.notEqual(operation.sourceItemIds[0], source.id);
  assert(
    fork.items.some(
      (item) =>
        item.id === operation.sourceItemIds[0] && item.type === "user_message",
    ),
  );
  assert(
    fork.items.some(
      (item) =>
        item.type === "model_operation_completed" &&
        item.operationItemId === operation.id,
    ),
  );
  const originalContexts = before.items
    .filter((item) => item.type === "context_message")
    .map((item) => item.content);
  assert.deepEqual(
    fork.items
      .filter((item) => item.type === "context_message")
      .map((item) => item.content),
    originalContexts,
  );
  assert.deepEqual((await f.server.readThread(thread.id)).items, before.items);
  const auxiliaryTexts = fork.items
    .filter(
      (item): item is Extract<CanonicalItem, { type: "context_message" }> =>
        item.type === "context_message" && item.purpose === "auxiliary-title",
    )
    .flatMap((item) => item.content)
    .flatMap((part) => (part.type === "text" ? [part.text] : []));
  assert(auxiliaryTexts.length > 0);
  const chatTexts = compileModelMessages(fork.items).flatMap((message) =>
    "content" in message
      ? message.content.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        )
      : "text" in message && typeof message.text === "string"
        ? [message.text]
        : [],
  );
  for (const text of auxiliaryTexts)
    assert.equal(
      chatTexts.includes(text),
      false,
      "auxiliary title input must never enter ordinary chat",
    );
});

test("probe errors only classify an explicit supported-status image rejection as unsupported", async () => {
  for (const [status, explicit, expected] of [
    [400, true, "unsupported"],
    [400, false, "inconclusive"],
    [401, true, "inconclusive"],
    [403, true, "inconclusive"],
    [429, true, "inconclusive"],
    [500, true, "inconclusive"],
  ] as const) {
    const f = fixture({
      provider: "synthetic",
      async *stream(): AsyncIterable<ModelEvent> {
        throw Object.assign(new Error("synthetic response"), {
          kind: "http",
          status,
          explicitlyRejectsImageInput: explicit,
        });
      },
    });
    const result = await f.server.runModelOperation({
      kind: "image-capability-probe",
      selection,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.probeOutcome, expected);
    const items = (await f.server.readThread(result.threadId)).items;
    const terminalIndex = items.findIndex(
      (item) => item.type === "model_operation_completed",
    );
    const terminal = items[terminalIndex];
    assert(terminal?.type === "model_operation_completed");
    assert.throws(
      () =>
        new Thread(result.threadId, items.slice(0, terminalIndex)).append({
          ...terminal,
          content: [{ type: "text", text: "partial" }],
        }),
      /incomplete provenance/,
    );
    assert.throws(
      () =>
        new Thread(result.threadId, items.slice(0, terminalIndex)).append({
          ...terminal,
          status: "cancelled",
          probeOutcome: "supported",
        }),
      /successful completion/,
    );
  }
});

for (const protocol of ["chat", "responses"] as const)
  test(`${protocol}: probe real serializer transmits only committed text and native media with a one-token output limit`, async () => {
    const journal = new InMemoryThreadJournal();
    const attachments = new InMemoryAttachmentStore();
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const [threadId] = await journal.listThreadIds();
      assert(threadId);
      const items = await journal.read(threadId);
      const committed = items
        .filter((item) => item.type === "context_message")
        .flatMap((item) => item.content);
      const wire = (body.messages ?? body.input) as Array<{
        content?: string | Array<{ text?: string }>;
      }>;
      const texts = wire.flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : (message.content ?? []).flatMap((part) =>
              part.text === undefined ? [] : [part.text],
            ),
      );
      if (typeof body.instructions === "string" && body.instructions)
        texts.push(body.instructions);
      for (const text of texts)
        assert(
          committed.some((part) => part.type === "text" && part.text === text),
          `uncommitted text ${text}`,
        );
      assert(committed.some((part) => part.type === "image"));
      assert(JSON.stringify(wire).includes("data:image/png;base64,"));
      assert.equal(
        body[protocol === "chat" ? "max_tokens" : "max_output_tokens"],
        1,
      );
      return new Response(
        protocol === "chat"
          ? 'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          : 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const adapter =
      protocol === "chat"
        ? new OpenAiCompatibleModel({
            baseUrl: "https://synthetic.invalid/v1",
            apiKey: "synthetic",
            fetch: fetcher,
            attachments,
          })
        : new OpenAiSubscriptionModel({
            acquireAccessLease: async () => ({
              accessToken: `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic`,
            }),
            instructions: "synthetic operation instructions",
            fetch: fetcher,
            attachments,
          });
    const f = fixture(adapter, journal, attachments);
    const result = await f.server.runModelOperation({
      kind: "image-capability-probe",
      selection,
    });
    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
  });

test("borrowed draft execution preserves selection and the same journal without publishing a provider", async () => {
  const f = fixture(plain);
  let calls = 0;
  const draftSelection = {
    providerProfileId: "unapplied-draft",
    modelId: "draft",
    reasoningEffort: null,
  };
  const model = new StaticModelCatalog([
    {
      id: "draft",
      isDefault: true,
      contextWindow: null,
      supportedReasoningEfforts: null,
      defaultReasoningEffort: null,
    },
  ]).get("draft")!;
  const adapter: ModelAdapter = {
    provider: "draft",
    async *stream(request) {
      calls++;
      assert.equal(request.model, "draft");
      const items = await f.journal.read(request.debugContext!.threadId);
      assert(
        items.some(
          (item) =>
            item.type === "model_operation" &&
            item.selection.providerProfileId === "unapplied-draft",
        ),
      );
      assert(
        items.some(
          (item) =>
            item.type === "context_message" &&
            item.content.some((part) => part.type === "image"),
        ),
      );
      yield { type: "text_delta", delta: "OK" };
    },
  };
  const execution = { adapter, model, selection: draftSelection };
  await assert.rejects(
    f.server.runModelOperation(
      { kind: "image-capability-probe", selection: draftSelection },
      undefined,
      { ...execution, model: { ...model, id: "different-model" } },
    ),
    /does not match/,
  );
  await assert.rejects(
    f.server.runModelOperation(
      {
        kind: "image-capability-probe",
        selection: { ...draftSelection, reasoningEffort: "high" },
      },
      undefined,
      {
        ...execution,
        selection: { ...draftSelection, reasoningEffort: "high" },
      },
    ),
    /metadata reasoning default/,
  );
  await assert.rejects(
    f.server.runModelOperation(
      {
        kind: "title",
        threadId: "not-admitted",
        sourceItemId: "not-admitted",
        selection: draftSelection,
      },
      undefined,
      execution,
    ),
    /known supported model capabilities/,
  );

  await assert.rejects(
    f.server.runModelOperation(
      { kind: "image-capability-probe", selection },
      undefined,
      execution,
    ),
    /does not match/,
  );
  assert.equal(calls, 0);
  const result = await f.server.runModelOperation(
    { kind: "image-capability-probe", selection: draftSelection },
    undefined,
    execution,
  );
  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
  assert.equal(f.server.activitySnapshot().rootOperations.length, 0);
  await assert.rejects(
    f.server.runModelOperation({
      kind: "image-capability-probe",
      selection: draftSelection,
    }),
    /Provider profile is not available/,
  );
});
