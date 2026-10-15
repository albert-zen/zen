import assert from "node:assert/strict";
import test from "node:test";
import { ModelRequestDebugStore } from "../apps/cli/src/model-request-debug.js";
import type { ModelAdapter, ModelRequest } from "../src/model.js";
const request = (): ModelRequest => ({
  model: "synthetic-model",
  reasoningEffort: null,
  messages: [{ role: "user", text: "synthetic prompt" }],
  tools: [],
  signal: new AbortController().signal,
  sessionId: "thread-1",
  debugContext: {
    threadId: "thread-1",
    purpose: "turn",
    turnId: "turn-1",
    sampleId: "sample-1",
    contextBoundaryItemId: "item-1",
    sampleAttempt: 1,
  },
});
test("capture is opt-in, exact dispatch body is immutable, disabling clears and fences late callbacks", async () => {
  const store = new ModelRequestDebugStore();
  let late: ModelRequest["onRequest"];
  const model: ModelAdapter = {
    provider: "synthetic",
    requestPayloadFormat: "chat-completions",
    async *stream(req) {
      late = req.onRequest;
      req.onRequest?.({
        format: "chat-completions",
        body: '{"messages":[{"role":"user","content":"final"}]}',
        originalBytes: 48,
        redacted: false,
        transportAttempt: 1,
        provider: "synthetic",
        model: req.model,
      });
      yield { type: "text_delta", delta: "ok" };
    },
  };
  const observed = store.observe(model);
  for await (const _event of observed.stream(request())) {
    /* consume */
  }
  assert.equal(store.control({ action: "status" }).retainedCount, 0);
  assert.equal(late, undefined);
  store.control({ action: "setEnabled", enabled: true });
  for await (const _event of observed.stream(request())) {
    /* consume */
  }
  const records = store.control({
    action: "list",
    threadId: "thread-1",
  }).records!;
  assert.equal(records.length, 1);
  assert.equal(records[0]!.sampleId, "sample-1");
  assert.match(
    store.control({ action: "read", id: records[0]!.id }).page!.text,
    /final/,
  );
  const old = late as ModelRequest["onRequest"];
  store.control({ action: "setEnabled", enabled: false });
  store.control({ action: "setEnabled", enabled: true });
  old?.({
    format: "chat-completions",
    body: "{}",
    originalBytes: 2,
    redacted: false,
    transportAttempt: 2,
    provider: "synthetic",
    model: "synthetic",
  });
  assert.equal(store.control({ action: "status" }).retainedCount, 0);
});

import { observeRequestBody } from "../src/model/request-observation.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { png1x1 } from "./fixtures.js";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";

async function consume(adapter: ModelAdapter, input = request()) {
  for await (const _event of adapter.stream(input)) {
    /* consume */
  }
}
function payloadAdapter(body: string): ModelAdapter {
  return {
    provider: "synthetic",
    requestPayloadFormat: "chat-completions",
    async *stream(req) {
      observeRequestBody(req, body, "chat-completions", "synthetic", 1);
      yield { type: "text_delta", delta: "ok" };
    },
  };
}
function readAll(
  store: ModelRequestDebugStore,
  id: string,
  view: "payload" | "messages" | "tools" | "configuration" = "payload",
) {
  let text = "",
    offset = 0;
  for (;;) {
    const page = store.control({ action: "read", id, offset, view }).page!;
    text += page.text;
    if (page.nextOffset === null) return text;
    offset = page.nextOffset;
  }
}
function doneChat() {
  return new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"synthetic response"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
}
function subscriptionToken(account: string) {
  return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.synthetic-signature`;
}

test("whole-record eviction, complete pagination, search and explicit oversized truncation", async () => {
  const store = new ModelRequestDebugStore({
    maxRecords: 2,
    maxBytes: 200,
    maxRecordBytes: 160,
    pageCharacters: 7,
  });
  store.control({ action: "setEnabled", enabled: true });
  const body = JSON.stringify({
    messages: [{ role: "user", content: "中🙂".repeat(8) }],
    tools: [],
  });
  await consume(store.observe(payloadAdapter(body)));
  const first = store.control({ action: "list", threadId: "thread-1" })
    .records![0]!;
  assert.equal(first.truncated, false);
  assert.equal(readAll(store, first.id), body);
  assert.equal(
    store.control({ action: "list", threadId: "thread-1", query: "中🙂" })
      .records!.length,
    1,
  );
  assert.equal(
    store.control({ action: "list", threadId: "other" }).records!.length,
    0,
  );
  assert.deepEqual(
    JSON.parse(readAll(store, first.id, "messages")),
    JSON.parse(body).messages,
  );
  assert.equal(readAll(store, first.id, "tools"), "[]");
  await consume(store.observe(payloadAdapter('{"messages":["second"]}')));
  await consume(store.observe(payloadAdapter('{"messages":["third"]}')));
  assert.equal(store.control({ action: "status" }).evictedCount, 1);
  assert.throws(() => readAll(store, first.id), /expired/);
  await consume(
    store.observe(
      payloadAdapter(JSON.stringify({ messages: ["🙂".repeat(500)] })),
    ),
  );
  const large = store.control({ action: "list", threadId: "thread-1" })
    .records![0]!;
  assert.equal(large.truncated, true);
  assert(large.originalBytes > large.retainedBytes);
  assert(large.retainedBytes <= 160);
  assert(!readAll(store, large.id).includes("�"));
  assert.throws(() => readAll(store, large.id, "messages"), /truncated/);
  assert(store.control({ action: "status" }).retainedBytes <= 200);
});

test("redaction precedes a size boundary and removes known secrets from body, keys and metadata", async () => {
  const store = new ModelRequestDebugStore({
    maxBytes: 120,
    maxRecordBytes: 120,
  });
  store.control({ action: "setEnabled", enabled: true });
  const secret = 'synthetic-key-"secret"';
  const body = JSON.stringify({
    messages: [{ content: "prefix " + "x".repeat(55) + secret + " suffix" }],
    [secret]: secret,
    api_key: "different-synthetic-key",
  });
  const adapter: ModelAdapter = {
    provider: secret,
    requestPayloadFormat: "chat-completions",
    async *stream(req) {
      observeRequestBody(req, body, "chat-completions", secret, 1, [secret]);
      yield { type: "text_delta", delta: "ok" };
    },
  };
  await consume(store.observe(adapter), { ...request(), model: secret });
  const entry = store.control({ action: "list", threadId: "thread-1" })
    .records![0]!;
  assert.equal(entry.redacted, true);
  assert.equal(entry.truncated, true);
  const dump = JSON.stringify(entry) + readAll(store, entry.id);
  assert(!dump.includes("synthetic-key"));
  assert(!dump.includes("different-synthetic-key"));
  assert.equal(entry.originalBytes, Buffer.byteLength(body));
});

test("clear fences in-flight capture, disable avoids serialization, unsupported adapters are never exact", async () => {
  const store = new ModelRequestDebugStore();
  let observe: ModelRequest["onRequest"];
  const adapter: ModelAdapter = {
    provider: "synthetic",
    async *stream(req) {
      observe = req.onRequest;
      yield { type: "text_delta", delta: "ok" };
    },
  };
  store.control({ action: "setEnabled", enabled: true });
  await consume(store.observe(adapter));
  const entry = store.control({ action: "list", threadId: "thread-1" })
    .records![0]!;
  assert.equal(entry.format, "model-input");
  assert.equal(entry.transportAttempt, 0);
  store.control({ action: "clear" });
  (observe as ModelRequest["onRequest"])?.({
    format: "responses",
    body: "{}",
    originalBytes: 2,
    redacted: false,
    transportAttempt: 1,
    provider: "synthetic",
    model: "synthetic",
  });
  assert.equal(store.control({ action: "status" }).retainedCount, 0);
  store.control({ action: "setEnabled", enabled: false });
  const input = request();
  Object.defineProperty(input, "messages", {
    get() {
      throw new Error("debug serialization must not happen");
    },
  });
  await consume(store.observe(adapter), input);
  assert.equal(observe, undefined);
});

test("Chat Completions captures the exact final body including image bytes and provider settings, every HTTP attempt", async () => {
  const store = new ModelRequestDebugStore();
  store.control({ action: "setEnabled", enabled: true });
  const attachments = new InMemoryAttachmentStore();
  const attachment = await attachments.importBytes(png1x1());
  const bodies: string[] = [];
  let attempts = 0;
  const adapter = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/never-capture-url/v1",
    apiKey: "synthetic-key",
    defaultParams: { temperature: 0.35 },
    attachments,
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      // Capture must already exist before fetch, not after a successful response.
      assert.equal(
        store.control({ action: "status" }).retainedCount,
        bodies.length,
      );
      if (++attempts === 1)
        return new Response("retry", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      return doneChat();
    },
  });
  await consume(store.observe(adapter), {
    ...request(),
    messages: [
      {
        role: "user",
        content: [
          { type: "image", attachment },
          { type: "text", text: "synthetic visual prompt" },
        ],
      },
    ],
    tools: [
      {
        name: "synthetic_tool",
        description: "synthetic tool",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  const entries = store
    .control({ action: "list", threadId: "thread-1" })
    .records!.reverse();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((x) => x.transportAttempt),
    [1, 2],
  );
  for (const [index, entry] of entries.entries()) {
    assert.equal(readAll(store, entry.id), bodies[index]);
    assert.equal(entry.redacted, false);
    const body = JSON.parse(bodies[index]!);
    assert.equal(body.temperature, 0.35);
    assert(
      body.messages[0].content[0].image_url.url.startsWith(
        "data:image/png;base64,",
      ),
    );
    assert.equal(body.tools[0].function.name, "synthetic_tool");
  }
  assert(!JSON.stringify(entries).includes("synthetic-key"));
  assert(!readAll(store, entries[0]!.id).includes("never-capture-url"));
});

test("Responses capture includes injected instructions and configuration and fences observer failures", async () => {
  const observations: string[] = [];
  const bodies: string[] = [];
  const adapter = new OpenAiSubscriptionModel({
    instructions: "synthetic system instructions",
    acquireAccessLease: async () => ({
      accessToken: subscriptionToken("synthetic-account"),
    }),
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const input = {
    ...request(),
    reasoningEffort: "medium",
    onRequest: (event: import("../src/model.js").ModelRequestObservation) => {
      observations.push(event.body);
      throw new Error("observer is broken");
    },
  };
  await consume(adapter, input);
  assert.deepEqual(observations, bodies);
  assert.equal(
    JSON.parse(bodies[0]!).instructions,
    "synthetic system instructions",
  );
  assert.equal(JSON.parse(bodies[0]!).reasoning.effort, "medium");
  assert.equal(JSON.parse(bodies[0]!).store, false);
  assert(!bodies[0]!.includes("synthetic-account"));
});

test("Host wiring is opt-in and disabling does not touch canonical history", async () => {
  const journal = new InMemoryThreadJournal();
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: "/tmp/synthetic-debug-host",
    model: "fake",
    provider: { type: "fake" },
    toolPresentation: "direct",
    approvalPolicy: "never",
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, "synthetic first")
    ).done;
    assert.equal(
      host.modelRequestDebug.control({ action: "status" }).retainedCount,
      0,
    );
    host.modelRequestDebug.control({ action: "setEnabled", enabled: true });
    await (
      await host.startTurn(thread.id, "synthetic second")
    ).done;
    const entries = host.modelRequestDebug.control({
      action: "list",
      threadId: thread.id,
    }).records!;
    assert.equal(entries.length, 1);
    const before = await journal.read(thread.id);
    assert(before.some((item) => item.id === entries[0]!.sampleId));
    assert(
      before.some((item) => item.id === entries[0]!.contextBoundaryItemId),
    );
    assert.equal(entries[0]!.purpose, "turn");
    host.modelRequestDebug.control({ action: "setEnabled", enabled: false });
    assert.deepEqual(await journal.read(thread.id), before);
  } finally {
    await host.closeHostResources();
  }
});

import { ZenAppServer } from "../src/app-server.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
function debugServer(
  model: ModelAdapter,
  store: ModelRequestDebugStore,
  agenticEnabled = false,
) {
  return new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
      sampleRetry: { maxAttempts: 3, baseDelayMs: 0 },
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: store.observe(model),
        modelCatalog: new StaticModelCatalog([
          { id: "synthetic-model", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "synthetic-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    contextCompaction: { agenticEnabled },
  });
}

test("Runtime sample retries have distinct sample identities and updated final request bodies", async () => {
  const store = new ModelRequestDebugStore();
  store.control({ action: "setEnabled", enabled: true });
  let calls = 0;
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: "synthetic-key",
    fetch: async () =>
      ++calls === 1
        ? new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"incomplete synthetic"},"finish_reason":null}]}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          )
        : doneChat(),
  });
  const server = debugServer(model, store);
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "synthetic user")
  ).done;
  const entries = store
    .control({ action: "list", threadId: thread.id })
    .records!.reverse();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((x) => x.sampleAttempt),
    [1, 2],
  );
  assert.deepEqual(
    entries.map((x) => x.transportAttempt),
    [1, 1],
  );
  assert.notEqual(entries[0]!.sampleId, entries[1]!.sampleId);
  assert.equal(entries[0]!.turnId, entries[1]!.turnId);
  assert(!readAll(store, entries[1]!.id).includes("incomplete synthetic"));
  const items = (await server.readThread(thread.id)).items;
  for (const entry of entries)
    assert(items.some((item) => item.id === entry.contextBoundaryItemId));
});

test("steer accepted during dispatch changes only the next captured sample", async () => {
  const store = new ModelRequestDebugStore();
  store.control({ action: "setEnabled", enabled: true });
  const entered = deferredVoid(),
    resume = deferredVoid();
  let calls = 0;
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: "synthetic-key",
    fetch: async () => {
      if (++calls === 1) {
        entered.resolve();
        await resume.promise;
      }
      return doneChat();
    },
  });
  const server = debugServer(model, store);
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "synthetic original");
  await entered.promise;
  await server.steerTurn(thread.id, turn.id, "synthetic correction");
  resume.resolve();
  await turn.done;
  const entries = store
    .control({ action: "list", threadId: thread.id })
    .records!.reverse();
  assert.equal(entries.length, 2);
  assert(!readAll(store, entries[0]!.id).includes("synthetic correction"));
  assert(readAll(store, entries[1]!.id).includes("synthetic correction"));
  assert.notEqual(
    entries[0]!.contextBoundaryItemId,
    entries[1]!.contextBoundaryItemId,
  );
});

test("generated compaction requests are distinguished without changing their provider cache hints", async () => {
  const store = new ModelRequestDebugStore();
  store.control({ action: "setEnabled", enabled: true });
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: "synthetic-key",
    fetch: async () => doneChat(),
  });
  const server = debugServer(model, store);
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "synthetic before compaction")
  ).done;
  await server.compactThread(thread.id, {
    includeOriginalReference: false,
    retention: { mode: "selected-items", recentTurnCount: 0 },
  });
  await (
    await server.startTurn(thread.id, "synthetic after compaction")
  ).done;
  const entries = store
    .control({ action: "list", threadId: thread.id })
    .records!.reverse();
  assert.equal(entries.length, 3);
  assert.equal(entries[1]!.purpose, "compaction");
  assert.equal(entries[1]!.turnId, null);
  assert.equal(entries[2]!.purpose, "turn");
  assert(
    !readAll(store, entries[2]!.id).includes("synthetic before compaction"),
  );
  assert(readAll(store, entries[2]!.id).includes("synthetic response"));
  assert(readAll(store, entries[2]!.id).includes("synthetic after compaction"));
});

test("agentic compaction capture follows the actual new projection", async () => {
  const store = new ModelRequestDebugStore();
  store.control({ action: "setEnabled", enabled: true });
  let calls = 0;
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: "synthetic-key",
    fetch: async () =>
      ++calls === 1
        ? new Response(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "synthetic-compact", function: { name: "compact_context", arguments: JSON.stringify({ text: "synthetic compacted context", includeOriginalReference: false }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : doneChat(),
  });
  const server = debugServer(model, store, true);
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "synthetic original context")
  ).done;
  const entries = store
    .control({ action: "list", threadId: thread.id })
    .records!.reverse();
  assert.equal(entries.length, 2);
  assert(readAll(store, entries[0]!.id).includes("synthetic original context"));
  assert(
    !readAll(store, entries[1]!.id).includes("synthetic original context"),
  );
  assert(
    readAll(store, entries[1]!.id).includes("synthetic compacted context"),
  );
  assert.notEqual(
    entries[0]!.contextBoundaryItemId,
    entries[1]!.contextBoundaryItemId,
  );
});

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("callbacks from a finished or failed sample cannot append obsolete captures", async () => {
  const store = new ModelRequestDebugStore();
  store.control({ action: "setEnabled", enabled: true });
  let callback: ModelRequest["onRequest"];
  const adapter: ModelAdapter = {
    provider: "synthetic",
    requestPayloadFormat: "chat-completions",
    async *stream(input) {
      callback = input.onRequest;
      yield { type: "text_delta", delta: "complete" };
    },
  };
  await consume(store.observe(adapter));
  (callback as ModelRequest["onRequest"])?.({
    format: "chat-completions",
    body: "{}",
    originalBytes: 2,
    redacted: false,
    transportAttempt: 1,
    provider: "synthetic",
    model: "synthetic",
  });
  assert.equal(store.control({ action: "status" }).retainedCount, 0);
});
