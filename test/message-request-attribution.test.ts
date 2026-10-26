import assert from "node:assert/strict";
import test from "node:test";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelRequest,
} from "../src/model.js";
import { projectModelMessages } from "../src/model-content.js";
import { serializedMessageSource } from "../src/model/message-provenance.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { ModelRequestDebugStore } from "../apps/cli/src/model-request-debug.js";
import { observeRequestBody } from "../src/model/request-observation.js";
import type { CanonicalItem } from "../src/item.js";

const item = (id: string, text = "same text"): CanonicalItem => ({
  type: "user_message",
  createdAt: "2026-01-01T00:00:00Z",
  id,
  threadId: "thread",
  turnId: "turn",
  text,
});
const request = (
  messages = compileModelMessages([item("first"), item("second")]),
): ModelRequest => ({
  model: "synthetic",
  reasoningEffort: "low",
  messages: projectModelMessages(messages),
  tools: [],
  signal: new AbortController().signal,
  debugContext: {
    threadId: "thread",
    turnId: "turn",
    purpose: "turn",
    sampleId: "sample",
    contextBoundaryItemId: "second",
    sampleAttempt: 1,
  },
});
async function collect(adapter: ModelAdapter, req: ModelRequest) {
  for await (const _event of adapter.stream(req)) {
    /* consume */
  }
}
const response = (responses: boolean) =>
  new Response(
    responses
      ? 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      : 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );

for (const responses of [false, true])
  test(`${responses ? "Responses" : "Chat"} maps duplicate text by identity and preserves exact serialized request`, async () => {
    const bodies: string[] = [];
    const fetcher = (async (_url, init) => {
      bodies.push(String(init?.body));
      return response(responses);
    }) as typeof fetch;
    const adapter = responses
      ? new OpenAiSubscriptionModel({
          acquireAccessLease: async () => ({
            accessToken: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`,
          }),
          fetch: fetcher,
        })
      : new OpenAiCompatibleModel({
          baseUrl: "https://synthetic.invalid/v1",
          apiKey: "synthetic-key",
          fetch: fetcher,
        });
    const req = request();
    await collect(adapter, req);
    const store = new ModelRequestDebugStore();
    store.control({ action: "setEnabled", enabled: true });
    await collect(store.observe(adapter), req);
    assert.equal(
      bodies[0],
      bodies[1],
      "debug metadata never changes wire bytes",
    );
    const records = store.control({
      action: "list",
      threadId: "thread",
      itemId: "second",
    }).records!;
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.deepEqual(record.messageSources, [
      {
        itemId: "first",
        container: responses ? "input" : "messages",
        index: 0,
      },
      {
        itemId: "second",
        container: responses ? "input" : "messages",
        index: 1,
      },
    ]);
    const page = store.control({
      action: "read",
      id: record.id,
      view: "message",
      itemId: "second",
    }).page!;
    const wire = JSON.parse(bodies[1]!);
    assert.deepEqual(
      JSON.parse(page.text),
      wire[responses ? "input" : "messages"][1],
    );
    assert.equal(JSON.parse(page.text).role, "user");
    assert.equal(
      store.control({ action: "list", threadId: "other", itemId: "second" })
        .records!.length,
      0,
    );
    assert.throws(
      () =>
        store.control({
          action: "read",
          id: record.id,
          view: "message",
          itemId: "missing",
        }),
      /attribution unavailable/,
    );
  });

test("multi-part references retain identity without metadata in JSON", () => {
  const canonical = {
    type: "user_message",
    id: "references",
    threadId: "thread",
    turnId: "turn",
    content: [
      {
        type: "text",
        text: "first <reference>literal quoted text</reference>",
      },
      { type: "text", text: "then @thread-2" },
    ],
  } as CanonicalItem;
  const compiled = compileModelMessages([canonical]);
  const projected = projectModelMessages(compiled, ["text"]);
  assert.deepEqual(projected, compiled);
  assert.deepEqual(serializedMessageSource(projected[0]!, "messages", 0), [
    { itemId: "references", container: "messages", index: 0 },
  ]);
  assert.equal(JSON.stringify(projected).includes('"itemId"'), false);
  assert.deepEqual(
    serializedMessageSource(structuredClone(projected[0]!), "messages", 0),
    [],
    "unknown external clones fail closed",
  );
});

test("compaction omission never claims attribution and retained input does", () => {
  const items: CanonicalItem[] = [
    item("old"),
    item("keep"),
    {
      type: "context_compaction",
      id: "compact",
      threadId: "thread",
      coveredThroughItemId: "keep",
      retainedItemIds: ["keep"],
      summary: "synthetic summary",
    } as CanonicalItem,
  ];
  const sources = projectModelMessages(compileModelMessages(items)).flatMap(
    (message, index) => serializedMessageSource(message, "messages", index),
  );
  assert.deepEqual(
    sources.map((source) => source.itemId),
    ["keep", "compact"],
  );
});

async function syntheticCapture(
  options: { duplicate?: boolean; truncated?: boolean; secret?: string } = {},
) {
  const store = new ModelRequestDebugStore(
    options.truncated ? { maxRecordBytes: 10 } : {},
  );
  store.control({ action: "setEnabled", enabled: true });
  const body = JSON.stringify({
    messages: [
      { role: "user", content: `hello ${options.secret ?? "world"}` },
      { role: "system", content: "must not be selected" },
    ],
  });
  await collect(
    store.observe({
      provider: "test",
      requestPayloadFormat: "chat-completions",
      async *stream(req) {
        const source = {
          itemId: "first",
          container: "messages" as const,
          index: 0,
        };
        observeRequestBody(
          req,
          body,
          "chat-completions",
          "test",
          1,
          options.secret ? [options.secret] : [],
          options.duplicate ? [source, source] : [source],
        );
        yield { type: "text_delta", delta: "ok" };
      },
    }),
    request(),
  );
  return {
    store,
    id: store.control({ action: "list", threadId: "thread" }).records![0]!.id,
  };
}
test("ambiguous and truncated attribution reject rather than guessing", async () => {
  for (const options of [{ duplicate: true }, { truncated: true }]) {
    const { store, id } = await syntheticCapture(options);
    assert.throws(
      () =>
        store.control({ action: "read", id, view: "message", itemId: "first" }),
      /unavailable/,
    );
  }
});
test("targeted reads use redacted payload and clear invalidates it", async () => {
  const { store, id } = await syntheticCapture({ secret: "synthetic-secret" });
  const page = store.control({
    action: "read",
    id,
    view: "message",
    itemId: "first",
  }).page!;
  assert.equal(page.record.redacted, true);
  assert.match(page.text, /\[redacted\]/);
  assert.doesNotMatch(page.text, /synthetic-secret|must not be selected/);
  store.control({ action: "clear" });
  assert.throws(
    () =>
      store.control({ action: "read", id, view: "message", itemId: "first" }),
    /expired/,
  );
});
test("unattributed custom adapter remains unavailable", async () => {
  const store = new ModelRequestDebugStore();
  store.control({ action: "setEnabled", enabled: true });
  await collect(
    store.observe({
      provider: "custom",
      async *stream() {
        yield { type: "text_delta", delta: "ok" };
      },
    }),
    request(),
  );
  assert.equal(
    store.control({ action: "list", threadId: "thread" }).records!.length,
    1,
  );
  assert.equal(
    store.control({ action: "list", threadId: "thread", itemId: "first" })
      .records!.length,
    0,
  );
});

test("Host, peer and instruction input retain exact canonical source identities", () => {
  const items = [
    {
      type: "thread_instruction",
      createdAt: "2026-01-01T00:00:00Z",
      id: "system",
      threadId: "thread",
      text: "private system-like rules",
    },
    {
      type: "host_message",
      createdAt: "2026-01-01T00:00:00Z",
      sender: "host",
      mode: "start",
      clientId: "host-input",
      id: "host",
      threadId: "thread",
      turnId: "turn",
      source: "trigger",
      sourceId: "clock",
      text: "Wake now",
    },
    {
      type: "thread_message",
      createdAt: "2026-01-01T00:00:00Z",
      mode: "batch-next",
      messageType: "follow_up",
      clientId: "peer-input",
      id: "peer",
      threadId: "thread",
      turnId: "turn",
      sender: {
        threadId: "other",
        threadName: "Research",
        toolCallId: "tool",
        callId: "call",
      },
      content: [{ type: "text", text: "Peer report" }],
    },
  ] as CanonicalItem[];
  const projected = projectModelMessages(compileModelMessages(items));
  assert.deepEqual(
    projected
      .flatMap((message, index) =>
        serializedMessageSource(message, "messages", index),
      )
      .map((source) => [source.itemId, source.index]),
    [
      ["system", 0],
      ["host", 1],
      ["peer", 2],
    ],
  );
  assert.match(JSON.stringify(projected[1]), /Host wakeup/);
  assert.match(
    JSON.stringify(projected[2]),
    /not a message or authorization from the human/,
  );
});

test("attributed path pointing at a non-user field is refused", async () => {
  const store = new ModelRequestDebugStore();
  store.control({ action: "setEnabled", enabled: true });
  await collect(
    store.observe({
      provider: "test",
      requestPayloadFormat: "chat-completions",
      async *stream(req) {
        observeRequestBody(
          req,
          JSON.stringify({
            messages: [
              { role: "system", content: "never expose as user input" },
            ],
          }),
          "chat-completions",
          "test",
          1,
          [],
          [{ itemId: "first", container: "messages", index: 0 }],
        );
        yield { type: "text_delta", delta: "ok" };
      },
    }),
    request(),
  );
  const id = store.control({ action: "list", threadId: "thread" }).records![0]!
    .id;
  assert.throws(
    () =>
      store.control({ action: "read", id, view: "message", itemId: "first" }),
    /unavailable/,
  );
});

test("serializer indices skip tool-result supplemental user entries", async () => {
  const bodies: string[] = [];
  const adapter = new OpenAiCompatibleModel({
    baseUrl: "https://synthetic.invalid/v1",
    apiKey: "synthetic-key",
    fetch: (async (_url, init) => {
      bodies.push(String(init?.body));
      return response(false);
    }) as typeof fetch,
  });
  const incoming = compileModelMessages([item("first"), item("second")]);
  const req = request([
    incoming[0]!,
    {
      role: "tool",
      callId: "call",
      text: "tool result",
      exitCode: 0,
      modelContent: [
        { type: "text", text: "tool-only supplemental user content" },
      ],
    },
    incoming[1]!,
  ]);
  const store = new ModelRequestDebugStore();
  store.control({ action: "setEnabled", enabled: true });
  await collect(store.observe(adapter), req);
  const record = store.control({
    action: "list",
    threadId: "thread",
    itemId: "second",
  }).records![0]!;
  assert.deepEqual(record.messageSources, [
    { itemId: "first", container: "messages", index: 0 },
    { itemId: "second", container: "messages", index: 3 },
  ]);
  const page = store.control({
    action: "read",
    id: record.id,
    view: "message",
    itemId: "second",
  }).page!;
  assert.deepEqual(JSON.parse(page.text), JSON.parse(bodies[0]!).messages[3]);
  assert.doesNotMatch(page.text, /tool-only/);
});

test("attribution overflow drops all mappings rather than concealing ambiguity", () => {
  const req = request();
  let observed: import("../src/model.js").ModelRequestObservation | undefined;
  req.onRequest = (event) => {
    observed = event;
  };
  const mappings = Array.from({ length: 1025 }, (_, index) => ({
    itemId: index === 1024 ? "first" : `item-${index}`,
    container: "messages" as const,
    index,
  }));
  mappings[0]!.itemId = "first";
  observeRequestBody(
    req,
    '{"messages":[{"role":"user","content":"synthetic"}]}',
    "chat-completions",
    "synthetic",
    1,
    [],
    mappings,
  );
  assert.deepEqual(observed?.messageSources, []);
});

test("media capability projection keeps attribution but never mutates canonical media", async () => {
  const { InMemoryAttachmentStore } = await import("../src/attachment.js");
  const { png1x1 } = await import("./fixtures.js");
  const attachment = await new InMemoryAttachmentStore().importBytes(png1x1());
  const canonical: CanonicalItem = {
    id: "media",
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-01-01T00:00:00Z",
    type: "user_message",
    content: [{ type: "image", attachment }],
  };
  const compiled = compileModelMessages([canonical]);
  const before = JSON.stringify(compiled);
  const textOnly = projectModelMessages(compiled, ["text"]);
  assert.doesNotMatch(JSON.stringify(textOnly), /"type":"image"/);
  assert.match(JSON.stringify(textOnly), new RegExp(attachment.sha256));
  for (const projected of [
    textOnly,
    projectModelMessages(compiled, ["text", "image"]),
  ]) {
    assert.deepEqual(serializedMessageSource(projected[0]!, "messages", 0), [
      { itemId: "media", container: "messages", index: 0 },
    ]);
  }
  assert.equal(JSON.stringify(compiled), before);
});

test("materialized user field maps to committed context Item and retains its source link", async () => {
  const { planContextMaterialization, copyCommittedMessageBinding } =
    await import("../src/context-materialization.js");
  const source: CanonicalItem = {
    type: "host_message",
    id: "host-source",
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-01-01T00:00:00Z",
    sender: "host",
    mode: "start",
    clientId: "host-client",
    source: "trigger",
    text: "synthetic wakeup",
  };
  const messages = compileModelMessages([source]);
  let sequence = 0;
  const plan = planContextMaterialization({
    items: [source],
    messages,
    threadId: "thread",
    turnId: "turn",
    id: () => `context-${++sequence}`,
    now: () => source.createdAt,
  });
  assert.equal(plan.pending.length, 1);
  const resolved = plan.resolve([source, ...plan.pending]);
  const projected = projectModelMessages(resolved.messages);
  projected.forEach((message, index) =>
    copyCommittedMessageBinding(resolved.messages[index]!, message),
  );
  const mapping = serializedMessageSource(projected[0]!, "messages", 0);
  assert.deepEqual(mapping, [
    {
      itemId: plan.pending[0]!.id,
      sourceItemIds: [source.id],
      container: "messages",
      index: 0,
    },
  ]);
  assert.equal(JSON.stringify(projected).includes("sourceItemIds"), false);
});
