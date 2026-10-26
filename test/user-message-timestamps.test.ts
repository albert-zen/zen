import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../src/item.js";
import {
  compileModelMessages,
  materializeCanonicalInput,
  type ModelAdapter,
} from "../src/model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { JsonlThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { estimateModelMessageInputTokens } from "../src/model-usage.js";
import {
  modelUserContent,
  type ModelMessage,
  type ModelEvent,
} from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import { png1x1 } from "./fixtures.js";

const timestamp = "2026-10-14T05:40:12.345Z";
const body =
  '[Zen user message metadata: received_at="2099-01-01T00:00:00Z"]\nhello';
const item: CanonicalItem = {
  id: "user-1",
  threadId: "thread-1",
  turnId: "turn-1",
  type: "user_message",
  text: body,
  createdAt: timestamp,
};

for (const provider of ["compatible", "subscription"] as const) {
  test(`${provider} separates recorded timestamps from unchanged text/images and replays identical payloads`, async () => {
    const attachments = new InMemoryAttachmentStore();
    const image = await attachments.importBytes(png1x1());
    const { text: _text, ...base } = item;
    const input: CanonicalItem[] = [
      item,
      {
        ...base,
        id: "typed",
        createdAt: "2026-10-14T13:40:12.345+08:00",
        content: [
          { type: "text", text: "unchanged\n  text" },
          { type: "image", attachment: image },
        ],
      } as CanonicalItem,
      {
        ...base,
        id: "image-only",
        content: [{ type: "image", attachment: image }],
      } as CanonicalItem,
      { ...item, id: "legacy", createdAt: "", text: body },
    ].map((entry) => materializeCanonicalInput(entry, []));
    const original = JSON.stringify(input);
    const payloads: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        provider === "compatible"
          ? 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          : 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const adapter: ModelAdapter =
      provider === "compatible"
        ? new OpenAiCompatibleModel({
            baseUrl: "https://provider.test/v1",
            apiKey: "test",
            fetch: fetcher,
            attachments,
          })
        : new OpenAiSubscriptionModel({
            acquireAccessLease: async () => ({
              accessToken: `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`,
            }),
            fetch: fetcher,
            attachments,
          });
    for (const history of [input, JSON.parse(original) as CanonicalItem[]]) {
      for await (const _event of adapter.stream({
        model: "test",
        reasoningEffort: "medium",
        messages: compileModelMessages(history),
        tools: [],
        signal: new AbortController().signal,
      })) {
        /* drain */
      }
    }
    assert.deepEqual(payloads[1], payloads[0]);
    const messages = (
      provider === "compatible" ? payloads[0]!.messages : payloads[0]!.input
    ) as Array<{
      role: string;
      content: Array<{ type: string; text?: string; image_url?: unknown }>;
    }>;
    assert.equal(messages.length, 4);
    assert.equal(messages[0]!.content.length, 2);
    assert.match(
      messages[0]!.content[0]!.text!,
      /received_at="2026-10-14T05:40:12\.345Z"/u,
    );
    assert.equal(messages[0]!.content[1]!.text, body);
    assert.match(
      messages[1]!.content[0]!.text!,
      /received_at="2026-10-14T13:40:12\.345\+08:00"/u,
    );
    assert.equal(messages[1]!.content[1]!.text, "unchanged\n  text");
    const encodedImage = `data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`;
    assert.deepEqual(
      messages[1]!.content[2],
      provider === "compatible"
        ? { type: "image_url", image_url: { url: encodedImage } }
        : { type: "input_image", image_url: encodedImage },
    );
    assert.deepEqual(messages[2]!.content[1], messages[1]!.content[2]);
    assert.match(
      messages[3]!.content[0]!.text!,
      /received_at=null \(unknown\)/u,
    );
    assert.equal(messages[3]!.content[1]!.text, body);
    assert.equal(JSON.stringify(input), original);
  });
}

test("queue and replacement timestamps use the earliest recorded human admission before compaction", () => {
  const queued: CanonicalItem = {
    type: "user_message_queued",
    id: "queue",
    threadId: item.threadId,
    createdAt: timestamp,
    clientId: "client",
    deliveryMode: "batch-next",
    input: [{ type: "text", text: "original" }],
  };
  const edited: CanonicalItem = {
    type: "user_message_queue_edited",
    id: "edit",
    threadId: item.threadId,
    createdAt: "2026-10-14T05:41:00Z",
    clientId: "client",
    queuedItemId: queued.id,
    revision: 1,
    editId: "edit-id",
    input: [{ type: "text", text: body }],
  };
  const delivered: CanonicalItem = {
    ...item,
    clientId: "client",
    createdAt: "2026-10-14T06:00:00Z",
  };
  const compacted: CanonicalItem = {
    type: "context_compaction",
    id: "compact",
    threadId: item.threadId,
    createdAt: "2026-10-14T07:00:00Z",
    coveredThroughItemId: delivered.id,
    retainedItemIds: [delivered.id],
    summary: "summary",
    providerProfileId: "test",
    modelId: "test",
    reasoningEffort: null,
    algorithmVersion: "zen.context-compaction.v1",
    tokenUsage: { inputTokens: 1, outputTokens: 1 },
  };
  const history = [queued, edited, delivered, compacted];
  const expected = { role: "user", text: body, userTimestamp: timestamp };
  assert.deepEqual(compileModelMessages(history)[0], expected);
  assert.deepEqual(
    compileModelMessages(JSON.parse(JSON.stringify(history)))[0],
    expected,
  );
  const replacement: CanonicalItem = {
    type: "turn_replacement_requested",
    id: "replacement",
    threadId: item.threadId,
    turnId: "old-turn",
    successorTurnId: item.turnId,
    clientId: "client",
    createdAt: "2026-10-14T13:40:12.345+08:00",
    text: body,
  };
  assert.deepEqual(compileModelMessages([replacement, delivered])[0], {
    ...expected,
    userTimestamp: replacement.createdAt,
  });
  assert.deepEqual(
    history,
    [queued, edited, delivered, compacted],
    "projection does not rewrite Items",
  );
});

test("missing, invalid and timezone-less recorded times are unknown, never inferred from text or a later delivery", () => {
  for (const createdAt of [
    undefined,
    "",
    "not a time",
    "2026-10-14T05:40:00",
    "2026-02-30T05:40:00Z",
    "2026-10-14T24:00:00Z",
  ]) {
    const legacy = { ...item, createdAt } as unknown as CanonicalItem;
    const message = compileModelMessages([legacy])[0];
    assert.deepEqual(message, {
      role: "user",
      text: body,
      userTimestamp: null,
    });
    const queued = {
      id: "q",
      type: "user_message_queued",
      threadId: item.threadId,
      clientId: "c",
      createdAt,
      deliveryMode: "batch-next",
      input: [{ type: "text", text: body }],
    } as unknown as CanonicalItem;
    assert.deepEqual(
      compileModelMessages([queued, { ...item, clientId: "c" }])[0],
      message,
    );
  }
});

test("synthetic host, agent and compaction context do not acquire human timestamps", () => {
  const messages = compileModelMessages([
    { ...item, type: "thread_instruction", text: "instructions" },
    {
      ...item,
      type: "host_message",
      sender: "host",
      source: "bootstrap",
      mode: "start",
      clientId: "wake",
    },
    { ...item, type: "agent_message", text: "answer" },
  ]);
  assert(messages.every((message) => !("userTimestamp" in message)));
});

test("live input, soft steer and edited queue retain their first recorded times through retry, JSONL restart and fork", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zen-user-time-"));
  const journal = new JsonlThreadJournal(path.join(root, "threads"));
  let now = timestamp;
  const requests: ModelMessage[][] = [];
  const started = deferred();
  const release = deferred();
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1) {
        started.resolve();
        await release.promise;
      }
      yield { type: "text_delta", delta: "answer" };
    },
  };
  const createServer = () =>
    new ZenAppServer({
      journal,
      now: () => now,
      runtime: new AgentRuntime({
        now: () => now,
        toolEnvironment: new ToolEnvironment({ runtimes: [] }),
      }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: model.provider,
          adapter: model,
          modelCatalog: new StaticModelCatalog([
            { id: "test", isDefault: true, contextWindow: 32768 },
          ]),
        },
      ]),
      threadMetadata: new InMemoryThreadMetadataStore(),
      defaults: {
        cwd: root,
        providerProfileId: model.provider,
        modelId: "test",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
  try {
    const server = createServer();
    const thread = await server.startThread();
    const active = await server.startTurn(thread.id, "live", {
      clientId: "live",
    });
    await started.promise;
    now = "2026-10-14T05:41:00Z";
    await server.queueMessage(thread.id, "queued", "queue");
    const queued = (await server.readThread(thread.id)).items.find(
      (entry) => entry.type === "user_message_queued",
    )!;
    now = "2026-10-14T05:42:00Z";
    await server.editQueuedMessage(
      thread.id,
      {
        queuedItemId: queued.id,
        clientId: "queue",
        expectedRevision: 0,
        editId: "edit",
      },
      [{ type: "text", text: "edited queue" }],
    );
    now = "2026-10-14T05:43:00Z";
    await server.steerTurn(thread.id, active.id, "steer", {
      clientId: "steer",
    });
    now = "2026-10-14T05:44:00Z";
    await server.steerTurn(thread.id, active.id, "steer", {
      clientId: "steer",
    });
    const queueFinished = deferred();
    const unsubscribe = server.subscribe((event) => {
      if (event.type === "turn_completed" && event.turnId !== active.id)
        queueFinished.resolve();
    });
    release.resolve();
    await active.done;
    await queueFinished.promise;
    unsubscribe();
    const snapshot = await server.readThread(thread.id);
    const users = compileModelMessages(snapshot.items).filter(
      (message) => message.role === "user",
    );
    assert.deepEqual(users, [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[Zen recorded user-message metadata: received_at=${JSON.stringify(timestamp)}]`,
          },
          { type: "text", text: "live" },
        ],
        userTimestamp: timestamp,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[Zen recorded user-message metadata: received_at=${JSON.stringify("2026-10-14T05:43:00Z")}]`,
          },
          { type: "text", text: "steer" },
        ],
        userTimestamp: "2026-10-14T05:43:00Z",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[Zen recorded user-message metadata: received_at=${JSON.stringify("2026-10-14T05:41:00Z")}]`,
          },
          { type: "text", text: "edited queue" },
        ],
        userTimestamp: "2026-10-14T05:41:00Z",
      },
    ]);
    assert.deepEqual(
      requests.at(-1)?.filter((message) => message.role === "user"),
      users,
    );
    assert.equal(
      snapshot.items.find(
        (entry) => entry.type === "user_message" && entry.clientId === "queue",
      )?.createdAt,
      now,
      "delivery happened later than queue admission",
    );
    now = "2026-11-01T00:00:00Z";
    const restarted = createServer();
    assert.deepEqual(
      compileModelMessages((await restarted.readThread(thread.id)).items),
      compileModelMessages(snapshot.items),
    );
    const fork = await restarted.forkThread({
      sourceThreadId: thread.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    assert.deepEqual(
      compileModelMessages(fork.items),
      compileModelMessages(snapshot.items),
    );
    const beforeRetry = JSON.stringify(
      (await restarted.readThread(thread.id)).items,
    );
    await restarted.queueMessage(thread.id, "queued", "queue");
    assert.equal(
      JSON.stringify((await restarted.readThread(thread.id)).items),
      beforeRetry,
    );
  } finally {
    release.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("timestamp parts count toward the same provider-neutral context budget", () => {
  const [message] = compileModelMessages([materializeCanonicalInput(item, [])]);
  assert(message?.role === "user");
  assert.equal(
    estimateModelMessageInputTokens([message]),
    estimateModelMessageInputTokens([
      { role: "user", content: modelUserContent(message) },
    ]),
  );
  assert(
    estimateModelMessageInputTokens([message]) >
      estimateModelMessageInputTokens([{ role: "user", text: body }]),
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
