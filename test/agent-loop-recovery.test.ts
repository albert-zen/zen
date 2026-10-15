import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import {
  boundedCompactionBoundary,
  normalizeContextCompactionConfig,
} from "../src/context-compaction.js";
import { estimateModelMessageInputTokens } from "../src/model-usage.js";
import { readThreadHistory } from "../src/thread-history.js";
import { Thread } from "../src/thread.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { png1x1 } from "./fixtures.js";
import { ZenAppServer } from "../src/app-server.js";
import { decodeCanonicalItem, type CanonicalItem } from "../src/item.js";
import { compileModelMessages } from "../src/model.js";
import { projectTurn } from "../src/protocol/codex/mapper.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime, type RunTurnOptions } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import type { ModelAdapter, ModelRequest } from "../src/model.js";
import { testToolBundle, testToolRuntime } from "./tool-fixtures.js";

function fixture(
  stream: ModelAdapter["stream"],
  attachments?: InMemoryAttachmentStore,
  afterToolsError?: Error,
  journal = new InMemoryThreadJournal(),
) {
  const requests: ModelRequest[] = [];
  let writes = 0;
  const waits: number[] = [];
  const model: ModelAdapter = {
    provider: "synthetic",
    async *stream(request) {
      requests.push(request);
      yield* stream(request);
    },
  };
  class ObservedRuntime extends AgentRuntime {
    override async runTurn(options: RunTurnOptions) {
      return super.runTurn({
        ...options,
        afterToolBatch: async (usage) => {
          if (afterToolsError !== undefined) {
            const error = afterToolsError;
            afterToolsError = undefined;
            throw error;
          }
          await options.afterToolBatch?.(usage);
        },
      });
    }
  }
  const runtime = new ObservedRuntime({
    toolEnvironment: new ToolEnvironment({
      bundles: [
        testToolBundle({ kind: "builtin", id: "synthetic" }, [
          testToolRuntime({
            name: "write_once",
            execute: async () => {
              writes++;
              return { output: "actual write receipt", exitCode: 0 };
            },
          }),
          ...(attachments === undefined
            ? []
            : [
                testToolRuntime({
                  name: "read_resource",
                  execute: async () => ({
                    output: "Read authorized local resource",
                    exitCode: 0,
                    modelContent: [
                      {
                        type: "image",
                        attachment: await attachments.importBytes(
                          png1x1(),
                          "image/png",
                        ),
                      },
                    ],
                  }),
                }),
              ]),
        ]),
      ],
    }),
    sampleRetry: {
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
    },
  });
  const server = new ZenAppServer({
    runtime,
    ...(attachments === undefined ? {} : { attachments }),
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "synthetic",
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "synthetic",
            isDefault: true,
            contextWindow: 32768,
            inputModalities: ["text", "image"],
          },
        ]),
      },
    ]),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: "synthetic",
      modelId: "synthetic",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  return { server, requests, waits, journal, writes: () => writes };
}

test("unexpected sample error is canonical feedback to the same Turn, never a duplicate user message", async () => {
  let calls = 0;
  const f = fixture(async function* (request) {
    if (++calls === 1) throw new Error("unexpected parser failure");
    assert.match(
      JSON.stringify(request.messages),
      /Host recovery|untrusted diagnostic/iu,
    );
    assert.equal(request.isSamplingRetry, true);
    yield { type: "text_delta", delta: "Recovered using the diagnostic" };
  });
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "complete the task")
  ).done;
  const result = await f.server.readThread(thread.id);
  assert.equal(calls, 2);
  assert.equal(result.turns[0]?.status, "completed");
  assert.equal(
    result.items.filter((item) => item.type === "turn_started").length,
    1,
  );
  assert.equal(
    result.items.filter((item) => item.type === "user_message").length,
    1,
  );
  assert.equal(
    result.items.filter((item) => item.type === "failure").length,
    1,
  );
});

test("provider rejecting a media request receives an explicit text diagnostic while canonical media stays intact", async () => {
  const attachments = new InMemoryAttachmentStore();
  const ref = await attachments.importBytes(png1x1(), "image/png");
  const bodies: Record<string, unknown>[] = [];
  const adapter = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: "synthetic-private-key",
    attachments,
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const serialized = JSON.stringify(bodies.at(-1));
      if (serialized.includes('"type":"image_url"') && bodies.length < 3)
        return new Response(
          JSON.stringify({
            error: {
              code: "InvalidParameter",
              param: "messages[0].content[2].image_url.url",
              message:
                "invalid image URL synthetic-private-key https://secret.example/?token=private",
            },
          }),
          { status: 400 },
        );
      if (bodies.length === 2) {
        assert.match(serialized, /Provider identity: InvalidParameter/u);
        assert.match(
          serialized,
          /Rejected parameter: messages\[0\].content\[2\].image_url.url/u,
        );
        assert.match(serialized, /not read its contents/u);
      }
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"Please provide an accessible replacement image"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch,
  });
  const f = fixture(adapter.stream.bind(adapter), attachments);
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, [
      { type: "text", text: "inspect this" },
      { type: "image", attachment: ref },
    ])
  ).done;
  const result = await f.server.readThread(thread.id);
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[0]), /image_url/u);
  assert.doesNotMatch(
    JSON.stringify(bodies[1]),
    /"type":"image_url"|synthetic-private-key|secret.example|token=private/u,
  );
  assert.match(JSON.stringify(bodies[1]), /not.*read|not been read/iu);
  assert.match(JSON.stringify(bodies[1]), /not proven damaged/iu);
  assert.match(
    JSON.stringify(bodies[1]),
    /Provider identity: InvalidParameter/u,
  );
  assert.match(
    JSON.stringify(bodies[1]),
    /Rejected parameter: messages\[0\].content\[2\].image_url.url/u,
  );
  const original = result.items.find((item) => item.type === "user_message");
  assert.equal(
    original?.type === "user_message" && original.content?.[1]?.type,
    "image",
  );
  assert.deepEqual(
    Buffer.from(await attachments.read(ref)),
    Buffer.from(png1x1()),
  );
  assert.equal(result.turns[0]?.status, "completed");
  await (
    await f.server.startTurn(thread.id, [
      { type: "image", attachment: ref },
      { type: "text", text: "new supplied occurrence" },
    ])
  ).done;
  assert.equal(bodies.length, 3);
  assert.equal(
    (JSON.stringify(bodies[2]).match(/"type":"image_url"/gu) ?? []).length,
    1,
  );
});

test("a completed mutation is never replayed when the next sample unexpectedly fails", async () => {
  let count = 0;
  const f = fixture(async function* (request) {
    count++;
    if (count === 1) {
      yield {
        type: "tool_call",
        callId: "write-1",
        name: "write_once",
        arguments: {},
      };
      return;
    }
    if (count === 2) throw new Error("unexpected parser failure");
    assert.match(JSON.stringify(request.messages), /actual write receipt/u);
    assert.match(JSON.stringify(request.messages), /diagnostic is untrusted/u);
    yield { type: "text_delta", delta: "Done" };
  });
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "write once")
  ).done;
  assert.equal(f.writes(), 1);
  assert.equal(count, 3);
  assert.equal(
    (await f.server.readThread(thread.id)).turns[0]?.status,
    "completed",
  );
});

test("settled post-tool error continues at sampling with admission retries disabled", async () => {
  let calls = 0;
  const f = fixture(
    async function* (request) {
      if (++calls === 1) {
        yield {
          type: "tool_call",
          callId: "write",
          name: "write_once",
          arguments: {},
        };
        return;
      }
      assert.equal(request.isSamplingRetry, true);
      assert.match(JSON.stringify(request.messages), /actual write receipt/u);
      yield { type: "text_delta", delta: "completed after repair" };
    },
    undefined,
    new Error("unexpected post-tool processing failure"),
  );
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "write once")
  ).done;
  const result = await f.server.readThread(thread.id);
  assert.equal(f.writes(), 1);
  assert.equal(calls, 2);
  assert.equal(result.turns[0]?.status, "completed");
  assert.equal(
    result.items.find((item) => item.type === "failure")?.type,
    "failure",
  );
});

test("each Turn has at most three recovery samples across successful tool rounds", async () => {
  let calls = 0;
  const f = fixture(async function* () {
    calls++;
    if (calls % 2 === 1) throw new Error("unexpected parser failure");
    yield {
      type: "tool_call",
      callId: `write-${calls}`,
      name: "write_once",
      arguments: {},
    };
  });
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "bounded work")
  ).done;
  const result = await f.server.readThread(thread.id);
  assert.equal(calls, 7);
  assert.equal(f.writes(), 3);
  assert.equal(
    result.items.filter(
      (item) => item.type === "failure" && item.recovery !== undefined,
    ).length,
    3,
  );
  assert.equal(result.turns[0]?.status, "failed");
});

test("a newly reacquired tool media occurrence enters the same Turn while the failed one stays explicit", async () => {
  let calls = 0;
  const attachments = new InMemoryAttachmentStore();
  const f = fixture(async function* (request) {
    calls++;
    if (calls === 1 || calls === 3) {
      if (calls === 3) {
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /"type":"image"/u,
        );
        assert.match(JSON.stringify(request.messages), /Unavailable image/u);
      }
      yield {
        type: "tool_call",
        callId: `read-${calls}`,
        name: "read_resource",
        arguments: {},
      };
      return;
    }
    if (calls === 2)
      throw Object.assign(new Error("invalid image URL"), { status: 400 });
    assert.equal(
      (JSON.stringify(request.messages).match(/"type":"image"/gu) ?? []).length,
      1,
    );
    yield {
      type: "text_delta",
      delta: "The replacement resource was available",
    };
  }, attachments);
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "inspect the authorized resource")
  ).done;
  const result = await f.server.readThread(thread.id);
  assert.equal(calls, 4);
  assert.equal(
    result.turns[0]?.status,
    "completed",
    JSON.stringify(result.items),
  );
  const repair = result.items.find(
    (item) => item.type === "failure" && item.recovery !== undefined,
  );
  assert.ok(repair?.type === "failure" && repair.recovery);
  assert.equal(repair.recovery.withheldMedia.length, 1);
  const original = result.items.find(
    (item) => item.id === repair.recovery!.withheldMedia[0]!.itemId,
  );
  assert.equal(
    original?.type === "tool_result" && original.modelContent?.[0]?.type,
    "image",
  );
  assert.equal(projectTurn(result.turns[0]!).error, null);
  const replay = result.items.map((item) =>
    decodeCanonicalItem(JSON.parse(JSON.stringify(item))),
  );
  assert.deepEqual(
    compileModelMessages(replay),
    compileModelMessages(result.items),
  );
  assert.throws(
    () =>
      decodeCanonicalItem({
        ...repair,
        recovery: { ...repair.recovery!, attempt: 4 },
      }),
    /recovery.attempt/u,
  );
});

test("CAS reports recoverable errors with willRetry and clears final error after recovery", async () => {
  const { CodexConnection } =
    await import("../src/protocol/codex/connection.js");
  let calls = 0;
  const f = fixture(async function* () {
    if (++calls === 1) throw new Error("unexpected parser failure");
    yield { type: "text_delta", delta: "recovered" };
  });
  const notifications: unknown[] = [];
  let completed!: () => void;
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const connection = new CodexConnection({
    appServer: f.server,
    zenHome: os.tmpdir(),
    send: (message) => {
      if ("method" in message) {
        notifications.push(message);
        if (message.method === "turn/completed") completed();
      }
    },
  });
  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    const thread = await f.server.startThread();
    await connection.receive({
      id: 2,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [{ type: "text", text: "complete this" }],
      },
    });
    await done;
    const errors = notifications.filter(
      (
        message,
      ): message is { method: string; params: { willRetry: boolean } } =>
        (message as { method?: string }).method === "error",
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.params.willRetry, true);
    const completion = notifications.find(
      (message) => (message as { method?: string }).method === "turn/completed",
    ) as { params: { turn: { status: string; error: unknown } } };
    assert.equal(completion.params.turn.status, "completed");
    assert.equal(completion.params.turn.error, null);
  } finally {
    connection.close();
  }
});

test("unknown recovery-journal append outcome stops before any repair sample", async () => {
  const writes: CanonicalItem[] = [];
  class UncertainJournal extends InMemoryThreadJournal {
    override async append(item: CanonicalItem) {
      writes.push(item);
      await super.append(item);
      if (item.type === "failure" && item.recovery !== undefined)
        throw new Error("recovery append outcome unknown");
    }
  }
  let calls = 0;
  const f = fixture(
    async function* () {
      calls++;
      throw new Error("unexpected parse failure");
    },
    undefined,
    undefined,
    new UncertainJournal(),
  );
  const thread = await f.server.startThread();
  await assert.rejects(
    (await f.server.startTurn(thread.id, "do work")).done,
    /recovery append outcome unknown/u,
  );
  assert.equal(calls, 1);
  assert.equal(writes.at(-1)?.type, "failure");
  assert.equal(
    writes.some((item) => item.type === "turn_completed"),
    false,
  );
});

const subscriptionTestToken = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.signature`;
for (const kind of ["cooldown", "policy-code", "policy-type"] as const) {
  test(`subscription HTTP ${kind} never crosses the recovery fence`, async () => {
    let calls = 0;
    const adapter = new OpenAiSubscriptionModel({
      acquireAccessLease: async () => ({ accessToken: subscriptionTestToken }),
      fetch: (async () => {
        calls++;
        return kind === "cooldown"
          ? new Response("", {
              status: 429,
              headers: { "retry-after": "3600" },
            })
          : new Response(
              JSON.stringify({
                error: {
                  [kind === "policy-code" ? "code" : "type"]:
                    "content_policy_violation",
                  message: "blocked",
                },
              }),
              { status: 400 },
            );
      }) as typeof fetch,
    });
    const f = fixture(adapter.stream.bind(adapter));
    const thread = await f.server.startThread();
    await (
      await f.server.startTurn(thread.id, "request")
    ).done;
    const result = await f.server.readThread(thread.id);
    assert.equal(calls, 1);
    assert.deepEqual(f.waits, []);
    assert.equal(
      result.items.filter((item) => item.type === "failure" && item.recovery)
        .length,
      0,
    );
  });
}

test("network recovery preserves healthy media in the repair request and later Turns", async () => {
  const attachments = new InMemoryAttachmentStore();
  const ref = await attachments.importBytes(png1x1(), "image/png");
  let calls = 0;
  const f = fixture(async function* () {
    if (++calls === 1) throw new Error("network unavailable");
    yield { type: "text_delta", delta: "seen" };
  }, attachments);
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, [{ type: "image", attachment: ref }])
  ).done;
  await (
    await f.server.startTurn(thread.id, "describe the earlier image")
  ).done;
  assert.deepEqual(
    f.requests.map(
      (request) =>
        (JSON.stringify(request.messages).match(/"type":"image"/gu) ?? [])
          .length,
    ),
    [1, 1, 1],
  );
});

for (const attempt of [2, 3]) {
  for (const plain of [false, true]) {
    test(`AbortError on sample ${attempt} (${plain ? "Error" : "DOMException"}) stays interrupted without a failed terminal`, async () => {
      let calls = 0;
      const f = fixture(async function* () {
        if (++calls < attempt) throw new Error("network unavailable");
        throw plain
          ? Object.assign(new Error("provider lease aborted"), {
              name: "AbortError",
            })
          : new DOMException("provider lease aborted", "AbortError");
        yield { type: "text_delta", delta: "unreachable" };
      });
      const thread = await f.server.startThread();
      await (
        await f.server.startTurn(thread.id, "request")
      ).done;
      const result = await f.server.readThread(thread.id);
      assert.equal(calls, attempt);
      assert.equal(result.turns[0]?.status, "interrupted");
      assert.equal(result.items.at(-1)?.type, "turn_aborted");
      assert.equal(
        result.items.filter((item) => item.type === "failure" && !item.recovery)
          .length,
        0,
      );
      assert.equal(projectTurn(result.turns[0]!).status, "interrupted");
    });
  }
}

test("recovered history forks at latest/exact and into side chat with local references and reloadable journals", async () => {
  let calls = 0;
  const f = fixture(async function* () {
    if (++calls === 1) throw new Error("network unavailable");
    yield { type: "text_delta", delta: "done" };
  });
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "request")
  ).done;
  const original = await f.server.readThread(thread.id);
  const message = original.items.find((item) => item.type === "agent_message")!;
  const recovery = original.items.find(
    (item) => item.type === "failure" && item.recovery,
  );
  assert(recovery?.type === "failure" && recovery.recovery);
  const copies = [
    await f.server.forkThread({
      sourceThreadId: thread.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    }),
    await f.server.forkThread({
      sourceThreadId: thread.id,
      through: { type: "item", itemId: message.id },
      workspace: { type: "same-directory" },
    }),
    await f.server.createChildThread({
      parentThreadId: thread.id,
      mode: "side-chat",
    }),
  ];
  for (const copy of copies) {
    const record = copy.items.find(
      (item) => item.type === "failure" && item.recovery,
    );
    assert(record?.type === "failure" && record.recovery);
    assert.notEqual(
      record.recovery.contextBoundaryItemId,
      recovery.recovery.contextBoundaryItemId,
    );
    assert(
      copy.items.some(
        (item) => item.id === record.recovery!.contextBoundaryItemId,
      ),
    );
    assert.notEqual(record.recovery.sampleId, recovery.recovery.sampleId);
    const loaded = new Thread(
      copy.id,
      (await f.journal.read(copy.id)).map((item) =>
        decodeCanonicalItem(JSON.parse(JSON.stringify(item))),
      ),
    );
    assert.deepEqual(
      compileModelMessages(loaded.items),
      compileModelMessages(copy.items),
    );
    const publicHistory = readThreadHistory(copy, {
      granularity: "item",
      itemId: record.id,
      maxTurns: 10,
      maxItemsPerTurn: 50,
    });
    const publicRecord = JSON.parse(String(publicHistory.content));
    assert.deepEqual(publicRecord.recovery, record.recovery);
    assert.match(publicRecord.message, /transport/);
  }
});

test("budget compaction can evict recovery prompt tokens while recent-item retention still counts conversation items", async () => {
  let calls = 0;
  const f = fixture(async function* () {
    if (++calls === 1) throw new Error("network unavailable");
    yield { type: "text_delta", delta: "done" };
  });
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "request")
  ).done;
  const result = await f.server.readThread(thread.id);
  const plan = boundedCompactionBoundary(result.items, {
    retainedTokenBudget: 100,
    retention: normalizeContextCompactionConfig({
      retention: { mode: "budget" },
    }).retention,
    estimateRetainedTokens: (items) =>
      estimateModelMessageInputTokens(compileModelMessages(items)),
  });
  assert(plan);
  const retained = result.items.filter((item) =>
    plan.retainedItemIds.includes(item.id),
  );
  assert(
    estimateModelMessageInputTokens(compileModelMessages(retained)) <= 100,
  );
  assert(!retained.some((item) => item.type === "failure" && item.recovery));
});

for (const transport of ["compatible", "subscription"] as const) {
  for (const streamed of [false, true]) {
    test(`${transport} ${streamed ? "SSE" : "HTTP"} encoded media parameter withholds only the rejected occurrence, including after fork`, async () => {
      const attachments = new InMemoryAttachmentStore();
      const ref = await attachments.importBytes(png1x1(), "image/png");
      const bodies: Record<string, unknown>[] = [];
      const root = transport === "compatible" ? "messages" : "input";
      const mediaType =
        transport === "compatible" ? "image_url" : "input_image";
      const success = () =>
        new Response(
          transport === "compatible"
            ? 'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
            : 'data: {"type":"response.output_text.delta","delta":"done"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      const syntheticFetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (bodies.length === 2) {
          const entries = body[root] as { content?: { type: string }[] }[];
          const messageIndex = entries.findLastIndex((entry) =>
            entry.content?.some((part) => part.type === mediaType),
          );
          const partIndex = entries[messageIndex]!.content!.findIndex(
            (part) => part.type === mediaType,
          );
          const error = {
            code: "invalid_image_url",
            param: `${root}[${messageIndex}].content[${partIndex}].image_url`,
            message: "invalid image URL https://secret.invalid/?token=private",
          };
          return streamed
            ? new Response(
                `data: ${JSON.stringify(transport === "compatible" ? { error } : { type: "response.failed", response: { error } })}\n\n`,
              )
            : new Response(JSON.stringify({ error }), { status: 400 });
        }
        return success();
      }) as typeof fetch;
      const adapter =
        transport === "compatible"
          ? new OpenAiCompatibleModel({
              baseUrl: "https://provider.test/v1",
              apiKey: "synthetic-private-key",
              attachments,
              fetch: syntheticFetch,
            })
          : new OpenAiSubscriptionModel({
              acquireAccessLease: async () => ({
                accessToken: subscriptionTestToken,
              }),
              attachments,
              fetch: syntheticFetch,
            });
      const f = fixture(adapter.stream.bind(adapter), attachments);
      const thread = await f.server.startThread();
      await (
        await f.server.startTurn(thread.id, [
          { type: "image", attachment: ref },
        ])
      ).done;
      await (
        await f.server.startTurn(thread.id, [
          { type: "image", attachment: ref },
        ])
      ).done;
      await (
        await f.server.startTurn(
          thread.id,
          "refer to the healthy earlier image",
        )
      ).done;
      assert.deepEqual(
        bodies.map(
          (body) =>
            (
              JSON.stringify(body).match(
                new RegExp(`"type":"${mediaType}"`, "gu"),
              ) ?? []
            ).length,
        ),
        [1, 2, 1, 1],
      );
      const source = await f.server.readThread(thread.id);
      const repair = source.items.find(
        (item) => item.type === "failure" && item.recovery,
      );
      assert(repair?.type === "failure" && repair.recovery);
      assert.equal(repair.recovery.mediaScope, "exact");
      assert.equal(repair.recovery.withheldMedia.length, 1);
      assert.equal(
        repair.recovery.withheldMedia[0]?.itemId,
        source.items.filter((item) => item.type === "user_message")[1]?.id,
      );
      assert.doesNotMatch(
        JSON.stringify(repair),
        /secret.invalid|token=private|synthetic-private-key/,
      );
      const fork = await f.server.forkThread({
        sourceThreadId: thread.id,
        through: { type: "latest-complete" },
        workspace: { type: "same-directory" },
      });
      const copied = fork.items.find(
        (item) => item.type === "failure" && item.recovery,
      );
      assert(copied?.type === "failure" && copied.recovery);
      assert.notEqual(
        copied.recovery.withheldMedia[0]?.itemId,
        repair.recovery.withheldMedia[0]?.itemId,
      );
      new Thread(
        fork.id,
        fork.items.map((item) =>
          decodeCanonicalItem(JSON.parse(JSON.stringify(item))),
        ),
      );
      await (
        await f.server.startTurn(fork.id, "describe healthy image")
      ).done;
      assert.equal(
        (
          JSON.stringify(bodies.at(-1)).match(
            new RegExp(`"type":"${mediaType}"`, "gu"),
          ) ?? []
        ).length,
        1,
      );
    });
  }
}

test("unattributed media rejection is an explicit diagnostic probe only until its Turn ends", async () => {
  const attachments = new InMemoryAttachmentStore();
  const ref = await attachments.importBytes(png1x1(), "image/png");
  let calls = 0;
  const f = fixture(async function* (request) {
    if (++calls === 1) throw new Error("invalid image URL");
    if (calls === 2) {
      assert.match(JSON.stringify(request.messages), /not proven damaged/);
      assert.match(
        JSON.stringify(request.messages),
        /expires when that Turn ends/,
      );
    }
    yield {
      type: "text_delta",
      delta: "Please provide the accessible resource",
    };
  }, attachments);
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, [{ type: "image", attachment: ref }])
  ).done;
  const first = await f.server.readThread(thread.id);
  const repair = first.items.find(
    (item) => item.type === "failure" && item.recovery,
  );
  assert(repair?.type === "failure" && repair.recovery);
  assert.equal(repair.recovery.mediaScope, "diagnostic_turn");
  assert.equal(repair.recovery.withheldMedia.length, 1);
  await (
    await f.server.startTurn(thread.id, "retry the original image")
  ).done;
  assert.deepEqual(
    f.requests.map(
      (request) =>
        (JSON.stringify(request.messages).match(/"type":"image"/gu) ?? [])
          .length,
    ),
    [1, 0, 1],
  );
});

test("recovery side-chat remaps completed-tool progress without reexecuting it", async () => {
  let calls = 0;
  const f = fixture(async function* () {
    if (++calls === 1) {
      yield {
        type: "tool_call",
        callId: "write",
        name: "write_once",
        arguments: {},
      };
      return;
    }
    if (calls === 2) throw new Error("network unavailable");
    yield { type: "text_delta", delta: "done" };
  });
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "write once")
  ).done;
  const original = await f.server.readThread(thread.id);
  const old = original.items.find(
    (item) => item.type === "failure" && item.recovery,
  );
  assert(old?.type === "failure" && old.recovery?.progressItemId);
  const copy = await f.server.createChildThread({
    parentThreadId: thread.id,
    mode: "side-chat",
  });
  const repair = copy.items.find(
    (item) => item.type === "failure" && item.recovery,
  );
  assert(repair?.type === "failure" && repair.recovery?.progressItemId);
  assert.notEqual(repair.recovery.progressItemId, old.recovery.progressItemId);
  assert(
    copy.items.some(
      (item) =>
        item.id === repair.recovery!.progressItemId &&
        item.type === "tool_result",
    ),
  );
  assert.equal(f.writes(), 1);
});

test("subscription streaming policy type also fences recovery", async () => {
  let calls = 0;
  const adapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: subscriptionTestToken }),
    fetch: async () => {
      calls++;
      return new Response(
        'data: {"type":"response.failed","response":{"error":{"type":"content_policy_violation","message":"blocked"}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const f = fixture(adapter.stream.bind(adapter));
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "request")
  ).done;
  assert.equal(calls, 1);
  assert.deepEqual(f.waits, []);
});

test("oversized subscription HTTP diagnostics stop safely without dropping a possible policy identity", async () => {
  let calls = 0;
  const adapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: subscriptionTestToken }),
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: {
            code: "content_policy_violation",
            message: "synthetic-private-key ".repeat(2000),
          },
        }),
        { status: 400 },
      );
    },
  });
  const f = fixture(adapter.stream.bind(adapter));
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "request")
  ).done;
  assert.equal(calls, 1);
  assert.deepEqual(f.waits, []);
  assert.doesNotMatch(
    JSON.stringify((await f.server.readThread(thread.id)).items),
    /synthetic-private-key/,
  );
});

for (const transport of ["compatible", "subscription"] as const) {
  for (const ending of [
    "shorten",
    "repeat",
    "abort",
    "stop",
    "filter",
  ] as const) {
    test(`${transport} output limit ${ending} uses bounded public draft feedback without running truncated tools`, async () => {
      const bodies: Record<string, unknown>[] = [];
      let interrupted: Promise<void> | undefined;
      const secret =
        transport === "compatible"
          ? "synthetic-private-key"
          : subscriptionTestToken;
      const publicDraft =
        "DRAFT_PLAN: inspect the actual receipt, then give a concise answer. " +
        secret +
        " https://secret.invalid/?token=private " +
        "unfinished detail ".repeat(180);
      const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      const syntheticFetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (bodies.length > 1) {
          const input = JSON.stringify(
            transport === "compatible" ? body.messages : body.input,
          );
          assert.match(input, /single response.*output.token limit/iu);
          assert.match(input, /shorter answer|smaller steps/iu);
          assert.match(input, /truncated tool calls.*not executed/iu);
          assert.match(input, /DRAFT_PLAN/);
          assert.match(input, /unfinished.*untrusted|untrusted.*unfinished/iu);
          assert(!input.includes(secret));
          assert.doesNotMatch(
            input,
            /secret.invalid|PRIVATE_REASONING|TRUNCATED_ARGUMENT/,
          );
          if (ending === "stop") {
            const active = (await f.server.readThread(thread.id)).turns.at(-1)!;
            interrupted = f.server.interruptTurn(thread.id, active.id);
          }
          if (ending === "abort" || ending === "stop")
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(
                    new DOMException("provider lease aborted", "AbortError"),
                  );
                },
              }),
            );
          if (ending === "shorten")
            return new Response(
              transport === "compatible"
                ? event({
                    choices: [
                      {
                        index: 0,
                        delta: { content: "Concise completed answer" },
                        finish_reason: "stop",
                      },
                    ],
                  }) + "data: [DONE]\n\n"
                : event({
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                      type: "message",
                      id: "msg_complete",
                      role: "assistant",
                      content: [],
                    },
                  }) +
                    event({
                      type: "response.output_text.delta",
                      output_index: 0,
                      delta: "Concise completed answer",
                    }) +
                    event({
                      type: "response.completed",
                      response: { status: "completed", output: [] },
                    }),
            );
        }
        return new Response(
          transport === "compatible"
            ? event({
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: publicDraft,
                      reasoning_content: "PRIVATE_REASONING",
                      tool_calls: [
                        {
                          index: 0,
                          id: "truncated",
                          type: "function",
                          function: {
                            name: "write_once",
                            arguments: '{"TRUNCATED_ARGUMENT":',
                          },
                        },
                      ],
                    },
                    finish_reason:
                      ending === "filter" ? "content_filter" : "length",
                  },
                ],
              }) + "data: [DONE]\n\n"
            : event({
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "message",
                  id: "msg_partial",
                  role: "assistant",
                  content: [],
                },
              }) +
                event({
                  type: "response.output_text.delta",
                  output_index: 0,
                  delta: publicDraft,
                }) +
                event({
                  type: "response.output_item.added",
                  output_index: 1,
                  item: {
                    type: "function_call",
                    id: "fc_partial",
                    call_id: "truncated",
                    name: "write_once",
                    arguments: "",
                  },
                }) +
                event({
                  type: "response.function_call_arguments.delta",
                  output_index: 1,
                  delta: '{"TRUNCATED_ARGUMENT":',
                }) +
                event({
                  type: "response.output_item.added",
                  output_index: 2,
                  item: { type: "reasoning", id: "rs_partial", summary: [] },
                }) +
                event({
                  type: "response.output_item.done",
                  output_index: 2,
                  item: {
                    type: "reasoning",
                    id: "rs_partial",
                    encrypted_content: "PRIVATE_REASONING_OPAQUE",
                    summary: [
                      {
                        type: "summary_text",
                        text: "PRIVATE_REASONING_SUMMARY",
                      },
                    ],
                  },
                }) +
                event({
                  type: "response.incomplete",
                  response: {
                    status: "incomplete",
                    incomplete_details: {
                      reason:
                        ending === "filter"
                          ? "content_filter"
                          : "max_output_tokens",
                    },
                    usage: { input_tokens: 12, output_tokens: 9 },
                  },
                }),
        );
      }) as typeof fetch;
      const adapter =
        transport === "compatible"
          ? new OpenAiCompatibleModel({
              baseUrl: "https://provider.test/v1",
              apiKey: secret,
              fetch: syntheticFetch,
            })
          : new OpenAiSubscriptionModel({
              acquireAccessLease: async () => ({ accessToken: secret }),
              fetch: syntheticFetch,
            });
      const f = fixture(adapter.stream.bind(adapter));
      const thread = await f.server.startThread();
      await (
        await f.server.startTurn(thread.id, "complete the task concisely")
      ).done;
      await interrupted;
      const result = await f.server.readThread(thread.id);
      assert.equal(f.writes(), 0);
      assert.equal(
        result.items.filter((item) => item.type === "tool_call").length,
        0,
      );
      assert.equal(
        bodies.length,
        ending === "filter" ? 1 : ending === "repeat" ? 3 : 2,
      );
      assert.equal(
        result.turns[0]?.status,
        ending === "shorten"
          ? "completed"
          : ending === "abort" || ending === "stop"
            ? "interrupted"
            : "failed",
      );
      const repairs = result.items.filter(
        (item) => item.type === "failure" && item.recovery,
      );
      assert.equal(
        repairs.length,
        ending === "filter" ? 0 : ending === "repeat" ? 2 : 1,
      );
      for (const repair of repairs) {
        assert(repair.type === "failure" && repair.recovery);
        assert.match(repair.message, /output.token limit/);
        assert(!JSON.stringify(repair).includes(secret));
        assert.equal(repair.recovery.outputLimit, true);
        assert(
          repair.recovery.publicPartial &&
            repair.recovery.publicPartial.length <= 2048,
        );
        assert.throws(
          () =>
            decodeCanonicalItem({
              ...repair,
              recovery: {
                ...repair.recovery!,
                publicPartial: "x".repeat(2049),
              },
            }),
          /public partial/,
        );
        assert.throws(
          () =>
            decodeCanonicalItem({
              ...repair,
              recovery: { ...repair.recovery!, outputLimit: undefined },
            }),
          /public partial/,
        );
        const invalid = result.items.map((item) =>
          item.id === repair.id
            ? {
                ...repair,
                recovery: {
                  ...repair.recovery!,
                  sampleId: repair.recovery!.contextBoundaryItemId,
                },
              }
            : item,
        );
        assert.throws(
          () => new Thread(result.id, invalid),
          /failed sample public incomplete/,
        );
      }
      if (ending === "shorten") {
        assert(
          result.items.some(
            (item) =>
              item.type === "agent_message" &&
              !item.incomplete &&
              item.text === "Concise completed answer",
          ),
        );
        const copy = await f.server.forkThread({
          sourceThreadId: thread.id,
          through: { type: "latest-complete" },
          workspace: { type: "same-directory" },
        });
        new Thread(
          copy.id,
          (await f.journal.read(copy.id)).map((item) =>
            decodeCanonicalItem(item),
          ),
        );
        const messages = compileModelMessages(copy.items);
        assert.match(JSON.stringify(messages), /DRAFT_PLAN/);
        assert.doesNotMatch(
          JSON.stringify(messages),
          /PRIVATE_REASONING|secret.invalid/,
        );
        const plan = boundedCompactionBoundary(copy.items, {
          retainedTokenBudget: 100,
          retention: normalizeContextCompactionConfig({
            retention: { mode: "budget" },
          }).retention,
          estimateRetainedTokens: (items) =>
            estimateModelMessageInputTokens(compileModelMessages(items)),
        });
        assert(plan);
      }
    });
  }
}

test("a structured non-media identity cannot let incidental error prose withhold healthy media", async () => {
  const attachments = new InMemoryAttachmentStore();
  const ref = await attachments.importBytes(png1x1(), "image/png");
  let calls = 0;
  const f = fixture(async function* () {
    if (++calls === 1)
      throw Object.assign(new Error("invalid image URL"), {
        recoveryDetails: { type: "authentication_error" },
      });
    yield { type: "text_delta", delta: "done" };
  }, attachments);
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, [{ type: "image", attachment: ref }])
  ).done;
  assert.deepEqual(
    f.requests.map(
      (request) =>
        (JSON.stringify(request.messages).match(/"type":"image"/gu) ?? [])
          .length,
    ),
    [1, 1],
  );
});
