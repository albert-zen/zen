import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import {
  normalizeContextCompactionConfig,
  boundedCompactionBoundary,
} from "../src/context-compaction.js";
import { decodeCanonicalItem, type CanonicalItem } from "../src/item.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
} from "../src/model.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { projectModelUsage } from "../src/model-usage.js";
import {
  OpenAiCompatibleModel,
  OpenAiCompatibleModelError,
} from "../src/model/openai-compatible.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime, type RunTurnOptions } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment, type ToolExecutionResult } from "../src/tool.js";
import { testToolBundle, testToolRuntime } from "./tool-fixtures.js";

function fixture(
  model: ModelAdapter,
  options: {
    sampleRetry?: NonNullable<
      ConstructorParameters<typeof AgentRuntime>[0]["sampleRetry"]
    >;
    journal?: ThreadJournal;
    execute?: () => Promise<ToolExecutionResult>;
  } = {},
) {
  const waits: number[] = [];
  const preparedIds: string[] = [];
  let executions = 0;
  class ObservedRuntime extends AgentRuntime {
    override async runTurn(options: RunTurnOptions): Promise<void> {
      return super.runTurn({
        ...options,
        prepareModelSample: async (id) => {
          preparedIds.push(id);
          return options.prepareModelSample(id);
        },
      });
    }
  }
  const runtime = new ObservedRuntime({
    toolEnvironment: new ToolEnvironment({
      bundles: [
        testToolBundle({ kind: "external", id: "synthetic" }, [
          testToolRuntime({
            name: "fixture_write",
            execute: async () => {
              executions++;
              return options.execute?.() ?? { output: "written", exitCode: 0 };
            },
          }),
        ]),
      ],
    }),
    sampleRetry: {
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
      ...options.sampleRetry,
    },
  });
  const server = new ZenAppServer({
    runtime,
    journal: options.journal ?? new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "synthetic", isDefault: true, contextWindow: 32_768 },
        ]),
      },
    ]),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "synthetic",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  return {
    server,
    runtime,
    waits,
    preparedIds,
    executions: () => executions,
    async run() {
      const thread = await server.startThread();
      await (
        await server.startTurn(thread.id, "request")
      ).done;
      return server.readThread(thread.id);
    },
  };
}

function sse(...payloads: unknown[]): Response {
  return new Response(
    payloads
      .map(
        (payload) =>
          `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function choice(delta: Record<string, unknown>, finish: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}
function call(index: number, id: string, args = "{}", name = "fixture_write") {
  return { index, id, function: { name, arguments: args } };
}
function partialFailure(): Response {
  return sse(
    choice(
      {
        content: "failed text",
        reasoning_content: "failed reasoning",
        tool_calls: [call(0, "never-execute"), call(1, "bad", '{"broken":')],
      },
      "tool_calls",
    ),
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    "[DONE]",
  );
}
function compatible(respond: (attempt: number) => Response) {
  const requests: Record<string, unknown>[] = [];
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: "synthetic-key",
    fetch: (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return respond(requests.length);
    }) as typeof fetch,
  });
  return { model, requests };
}
function retryError() {
  return new OpenAiCompatibleModelError(
    "protocol",
    "synthetic malformed sample",
    { retryable: true },
  );
}
function synthetic(stream: ModelAdapter["stream"]): ModelAdapter {
  return {
    provider: "synthetic",
    stream,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("malformed parallel tools retry before any dispatch, preserve incomplete trace and per-attempt usage", async () => {
  const { model, requests } = compatible((attempt) =>
    attempt === 1
      ? partialFailure()
      : attempt === 2
        ? sse(
            choice({ tool_calls: [call(0, "execute-once")] }, "tool_calls"),
            "[DONE]",
          )
        : sse(
            choice({ content: "final" }, "stop"),
            { choices: [], usage: { prompt_tokens: 20, completion_tokens: 7 } },
            "[DONE]",
          ),
  );
  const f = fixture(model);
  const result = await f.run();
  assert.equal(result.turns[0]?.status, "completed");
  assert.equal(f.executions(), 1);
  assert.deepEqual(f.waits, [1000]);
  assert.equal(requests.length, 3);
  assert.equal(new Set(f.preparedIds).size, 3);
  assert.deepEqual(
    result.items
      .filter((item) => item.type === "tool_call")
      .map((item) => item.callId),
    ["execute-once"],
  );
  assert.deepEqual(
    result.items
      .filter((item) => item.type === "agent_message")
      .map((item) => [item.text, item.incomplete]),
    [
      ["failed text", true],
      ["final", undefined],
    ],
  );
  const reasoning = result.items.find((item) => item.type === "reasoning");
  assert.equal(reasoning?.reasoningContent, "failed reasoning");
  assert.equal(reasoning?.incomplete, true);
  for (const request of requests.slice(1)) {
    const replay = JSON.stringify(request.messages);
    assert.doesNotMatch(
      replay,
      /failed text|failed reasoning|never-execute|"bad"/u,
    );
  }
  const usages = result.items.filter((item) => item.type === "model_usage");
  assert.deepEqual(
    usages.map((item) => [
      item.modelResponseId,
      item.inputTokens,
      item.outputTokens,
    ]),
    [
      [f.preparedIds[0], 10, 5],
      [f.preparedIds[2], 20, 7],
    ],
  );
  assert.deepEqual(projectModelUsage(result.items).thread, {
    responseCount: 2,
    inputTokens: 30,
    outputTokens: 12,
  });
  assert.equal(
    result.items.some((item) => item.type === "failure"),
    false,
  );
});

test("default three samples exhaust explicitly with separate incomplete trace and unknown usage", async () => {
  const { model, requests } = compatible(() =>
    sse(
      choice(
        {
          content: "partial",
          tool_calls: [
            { index: 0, id: "missing-name", function: { arguments: "" } },
          ],
        },
        "tool_calls",
      ),
      "[DONE]",
    ),
  );
  const f = fixture(model);
  const result = await f.run();
  assert.equal(requests.length, 3);
  assert.deepEqual(f.waits, [1000, 2000]);
  assert.equal(f.executions(), 0);
  assert.equal(result.turns[0]?.status, "failed");
  assert.equal(
    result.items.filter((item) => item.type === "failure").length,
    1,
  );
  assert.match(
    result.items.find((item) => item.type === "failure")!.message,
    /incomplete tool call/u,
  );
  assert.equal(
    result.items.filter((item) => item.type === "model_usage").length,
    0,
  );
  assert.deepEqual(
    result.items
      .filter((item) => item.type === "agent_message")
      .map((item) => item.id),
    f.preparedIds,
  );
  assert.ok(
    result.items
      .filter((item) => item.type === "agent_message")
      .every((item) => item.incomplete),
  );
  assert.doesNotMatch(
    JSON.stringify(compileModelMessages(result.items)),
    /partial|missing-name/u,
  );
});

test("sampling retries do not nest HTTP admission retries", async () => {
  const { model, requests } = compatible((attempt) =>
    attempt === 1
      ? partialFailure()
      : new Response("unavailable", { status: 503 }),
  );
  const f = fixture(model);
  const result = await f.run();
  assert.equal(requests.length, 2);
  assert.deepEqual(f.waits, [1000]);
  assert.equal(result.turns[0]?.status, "failed");
  assert.match(
    result.items.find((item) => item.type === "failure")!.message,
    /HTTP 503/u,
  );
});

test("auth, admission exhaustion, terminal reasons, provider errors and unavailable tools are not sampling retries", async (t) => {
  for (const [name, response] of [
    ["authentication", () => new Response(null, { status: 401 })],
    [
      "cooldown",
      () =>
        new Response(null, { status: 429, headers: { "retry-after": "600" } }),
    ],
    ["length", () => sse(choice({ content: "truncated" }, "length"), "[DONE]")],
    ["content filter", () => sse(choice({}, "content_filter"), "[DONE]")],
    ["provider error", () => sse({ error: { code: "invalid_api_key" } })],
    [
      "context overflow",
      () => sse({ error: { code: "context_length_exceeded" } }),
    ],
    [
      "unavailable tool",
      () =>
        sse(
          choice(
            { tool_calls: [call(0, "bad", "{}", "unavailable")] },
            "tool_calls",
          ),
          "[DONE]",
        ),
    ],
    [
      "invalid usage",
      () =>
        sse({
          choices: [],
          usage: { prompt_tokens: -1, completion_tokens: 1 },
        }),
    ],
  ] as const) {
    await t.test(name, async () => {
      const { model, requests } = compatible(response);
      const f = fixture(model);
      const result = await f.run();
      assert.equal(requests.length, 1);
      assert.deepEqual(f.waits, []);
      assert.equal(f.executions(), 0);
      assert.equal(result.turns[0]?.status, "failed");
    });
  }
});

test("provider-internal 400s replay at the sampling layer without nesting admission retries", async (t) => {
  // DashScope marks transient internal validator faults as 400 InternalError.*;
  // the request itself is fine and replays cleanly.
  await t.test("self-reported internal 400 retries", async () => {
    const { model, requests } = compatible((attempt) =>
      attempt === 1
        ? new Response(
            JSON.stringify({
              error: {
                message:
                  "<400> InternalError.Algo.InvalidParameter: The provided URL does not appear to be valid.",
              },
            }),
            { status: 400 },
          )
        : sse(choice({ content: "recovered" }, "stop"), "[DONE]"),
    );
    const f = fixture(model);
    const result = await f.run();
    assert.equal(requests.length, 2);
    assert.equal(result.turns[0]?.status, "completed");
  });

  await t.test("plain 400 stays terminal", async () => {
    const { model, requests } = compatible(
      () =>
        new Response(
          JSON.stringify({ error: { message: "bad request shape" } }),
          { status: 400 },
        ),
    );
    const f = fixture(model);
    const result = await f.run();
    assert.equal(requests.length, 1);
    assert.deepEqual(f.waits, []);
    assert.equal(result.turns[0]?.status, "failed");
  });
});

test("known midstream transport failures retry; unknown read errors do not", async (t) => {
  for (const [error, expected] of [
    [new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }), 2],
    [new TypeError("timeout", { cause: { code: "UND_ERR_BODY_TIMEOUT" } }), 2],
    [new Error("unknown reader failure"), 1],
    [new DOMException("aborted", "AbortError"), 1],
  ] as const) {
    await t.test(error.message, async () => {
      const { model, requests } = compatible((attempt) =>
        attempt > 1
          ? sse(choice({ content: "ok" }, "stop"), "[DONE]")
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(error);
                },
              }),
            ),
      );
      const f = fixture(model);
      const result = await f.run();
      assert.equal(requests.length, expected);
      assert.equal(f.executions(), 0);
      assert.equal(
        result.turns[0]?.status,
        expected === 2
          ? "completed"
          : error.name === "AbortError"
            ? "interrupted"
            : "failed",
      );
    });
  }
});

test("fresh preparation admits late steering during backoff exactly once", async () => {
  const sleeping = deferred();
  const resume = deferred();
  const { model, requests } = compatible((attempt) =>
    attempt === 1
      ? partialFailure()
      : sse(choice({ content: "done" }, "stop"), "[DONE]"),
  );
  const f = fixture(model, {
    sampleRetry: {
      sleep: async () => {
        sleeping.resolve();
        await resume.promise;
      },
    },
  });
  const thread = await f.server.startThread();
  const turn = await f.server.startTurn(thread.id, "initial");
  await sleeping.promise;
  const during = await f.server.readThread(thread.id);
  assert.equal(during.turns[0]?.status, "inProgress");
  assert.equal(
    during.items.find((item) => item.type === "agent_message")?.incomplete,
    true,
  );
  await f.server.steerTurn(thread.id, turn.id, "late steer", {
    clientId: "steer-once",
  });
  resume.resolve();
  await turn.done;
  const after = await f.server.readThread(thread.id);
  assert.match(JSON.stringify(requests[1]?.messages), /late steer/u);
  assert.doesNotMatch(
    JSON.stringify(requests[1]?.messages),
    /failed text|failed reasoning/u,
  );
  assert.equal(
    after.items.filter(
      (item) => item.type === "user_message" && item.clientId === "steer-once",
    ).length,
    1,
  );
  assert.equal(requests.length, 2);
  assert.notEqual(f.preparedIds[0], f.preparedIds[1]);
});

test("interrupt during backoff preserves trace and prevents another attempt", async () => {
  const sleeping = deferred();
  const { model, requests } = compatible(() => partialFailure());
  const f = fixture(model, {
    sampleRetry: {
      sleep: async (_ms, signal) => {
        sleeping.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    },
  });
  const thread = await f.server.startThread();
  const turn = await f.server.startTurn(thread.id, "initial");
  await sleeping.promise;
  await f.server.interruptTurn(thread.id, turn.id);
  await turn.done;
  const after = await f.server.readThread(thread.id);
  assert.equal(requests.length, 1);
  assert.equal(after.turns[0]?.status, "interrupted");
  assert.equal(after.items.filter((item) => item.type === "failure").length, 0);
  assert.equal(
    after.items.filter((item) => item.type === "model_usage").length,
    1,
  );
  assert.equal(f.executions(), 0);
});

test("cancellation after partial text and reasoning never dispatches even when adapter yields a tool", async () => {
  const ready = deferred();
  const resume = deferred();
  let attempts = 0;
  const model = synthetic(async function* (request): AsyncIterable<ModelEvent> {
    attempts++;
    yield { type: "text_delta", delta: "interrupted text" };
    yield {
      type: "reasoning_content_delta",
      reasoningId: "r",
      delta: "interrupted reasoning",
    };
    yield { type: "usage", inputTokens: 5, outputTokens: 3 };
    ready.resolve();
    await resume.promise;
    yield {
      type: "tool_call",
      callId: "never",
      name: "fixture_write",
      arguments: {},
    };
    request.signal.throwIfAborted();
  });
  const f = fixture(model);
  const thread = await f.server.startThread();
  const turn = await f.server.startTurn(thread.id, "initial");
  await ready.promise;
  const interrupted = f.server.interruptTurn(thread.id, turn.id);
  resume.resolve();
  await interrupted;
  await turn.done;
  const after = await f.server.readThread(thread.id);
  assert.equal(attempts, 1);
  assert.equal(f.executions(), 0);
  assert.equal(after.turns[0]?.status, "interrupted");
  assert.equal(
    after.items.find((item) => item.type === "agent_message")?.incomplete,
    true,
  );
  assert.equal(
    after.items.find((item) => item.type === "reasoning")?.incomplete,
    true,
  );
  assert.equal(
    after.items.filter((item) => item.type === "model_usage").length,
    1,
  );
});

test("opaque completed reasoning stays opaque when a later stream fragment fails", async () => {
  let attempts = 0;
  const model = synthetic(async function* (): AsyncIterable<ModelEvent> {
    if (++attempts === 1) {
      yield {
        type: "reasoning",
        reasoningId: "opaque",
        reasoningContent: "opaque-provider-data",
        summary: "public summary",
        contentVisibility: "opaque",
        providerItemId: "provider-id",
      };
      yield {
        type: "reasoning_content_delta",
        reasoningId: "public",
        delta: "partial public",
      };
      throw retryError();
    }
    yield { type: "text_delta", delta: "ok" };
  });
  const f = fixture(model);
  const result = await f.run();
  const reasoning = result.items.filter((item) => item.type === "reasoning");
  assert.equal(reasoning[0]?.contentVisibility, "opaque");
  assert.equal(reasoning[0]?.providerItemId, "provider-id");
  assert.equal(reasoning[0]?.reasoningContent, "opaque-provider-data");
  assert.ok(reasoning.every((item) => item.incomplete));
  assert.doesNotMatch(
    JSON.stringify(compileModelMessages(result.items)),
    /opaque-provider-data|public summary|partial public/u,
  );
});

test("failed tool execution is settled once and never retried by sampling recovery", async () => {
  let attempts = 0;
  const model = synthetic(async function* (): AsyncIterable<ModelEvent> {
    if (++attempts === 1)
      yield {
        type: "tool_call",
        callId: "only",
        name: "fixture_write",
        arguments: {},
      };
    else yield { type: "text_delta", delta: "tool failed" };
  });
  const f = fixture(model, {
    execute: async () => {
      throw retryError();
    },
  });
  const result = await f.run();
  assert.equal(attempts, 2); // one tool response, then the ordinary continuation
  assert.equal(f.executions(), 1);
  assert.deepEqual(f.waits, []);
  assert.equal(
    result.items.filter((item) => item.type === "tool_result").length,
    1,
  );
  assert.equal(
    result.items.find((item) => item.type === "tool_result")?.executionStatus,
    "failed",
  );
});

test("unknown journal write outcome terminates without retry or extra canonical writes", async () => {
  let attempts = 0;
  const model = synthetic(async function* (): AsyncIterable<ModelEvent> {
    attempts++;
    yield { type: "text_delta", delta: "partial" };
    yield { type: "usage", inputTokens: 5, outputTokens: 1 };
    throw retryError();
  });
  const writes: string[] = [];
  class FailingJournal extends InMemoryThreadJournal {
    override async append(item: CanonicalItem) {
      writes.push(item.type);
      if (item.type === "agent_message")
        throw new Error("write outcome unknown");
      return super.append(item);
    }
  }
  const f = fixture(model, { journal: new FailingJournal() });
  const thread = await f.server.startThread();
  const turn = await f.server.startTurn(thread.id, "initial");
  await assert.rejects(turn.done, /write outcome unknown/u);
  assert.equal(attempts, 1);
  assert.equal(writes.at(-1), "agent_message");
  assert.deepEqual(f.waits, []);
});

test("incomplete traces replay from journal but never reenter model or compaction retention", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-sample-retry-"));
  try {
    const { model } = compatible((attempt) =>
      attempt === 1
        ? partialFailure()
        : sse(choice({ content: "done" }, "stop"), "[DONE]"),
    );
    const f = fixture(model, { journal: new JsonlThreadJournal(directory) });
    const result = await f.run();
    const reloaded = await fixture(model, {
      journal: new JsonlThreadJournal(directory),
    }).server.readThread(result.id);
    assert.deepEqual(reloaded.items, result.items);
    assert.doesNotMatch(
      JSON.stringify(
        compileModelMessages(reloaded.items, {
          providerProfileId: model.provider,
          modelId: "synthetic",
          reasoningEffort: "medium",
        }),
      ),
      /failed text|failed reasoning/u,
    );
    const partial = reloaded.items.find(
      (item) => item.type === "agent_message" && item.incomplete,
    )!;
    assert.equal(decodeCanonicalItem(partial).id, partial.id);
    assert.throws(
      () => decodeCanonicalItem({ ...partial, incomplete: false }),
      /incomplete must be true/u,
    );
    const plan = boundedCompactionBoundary(reloaded.items, {
      retainedTokenBudget: 1000,
      estimateRetainedTokens: (items) => items.length,
      retention: normalizeContextCompactionConfig({
        retention: { mode: "recent-items", recentItemCount: 2 },
      }).retention,
    });
    assert.ok(!plan!.retainedItemIds.includes(partial.id));
    const user = reloaded.items.find((item) => item.type === "user_message")!;
    assert.ok(plan!.retainedItemIds.includes(user.id));
    assert.equal(
      compileModelMessages(
        reloaded.items.filter((item) =>
          plan!.retainedItemIds.includes(item.id),
        ),
      ).length,
      2,
    );
    assert.throws(
      () =>
        boundedCompactionBoundary(reloaded.items, {
          retainedTokenBudget: 1000,
          estimateRetainedTokens: (items) => items.length,
          retention: normalizeContextCompactionConfig({
            retention: { mode: "selected-items", itemIds: [partial.id] },
          }).retention,
        }),
      /not eligible/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "three sample attempts share at most six HTTP requests, with admission retries only first",
  { timeout: 20_000 },
  async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const { model, requests } = compatible((attempt) =>
        attempt <= 3
          ? new Response(null, { status: 503 })
          : attempt <= 5
            ? partialFailure()
            : sse(choice({ content: "final" }, "stop"), "[DONE]"),
      );
      const f = fixture(model);
      const result = await f.run();
      assert.equal(requests.length, 6);
      assert.equal(f.preparedIds.length, 3);
      assert.equal(result.turns[0]?.status, "completed");
      assert.equal(f.executions(), 0);
      assert.deepEqual(f.waits, [1000, 2000]);
    } finally {
      Math.random = originalRandom;
    }
  },
);

test("sample retry can be disabled and rejects invalid bounds", async () => {
  const { model, requests } = compatible(() => partialFailure());
  const f = fixture(model, { sampleRetry: { maxAttempts: 1 } });
  const result = await f.run();
  assert.equal(requests.length, 1);
  assert.deepEqual(f.waits, []);
  assert.equal(result.turns[0]?.status, "failed");
  for (const maxAttempts of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(
      () => fixture(model, { sampleRetry: { maxAttempts } }),
      /positive safe integer/u,
    );
  }
});
