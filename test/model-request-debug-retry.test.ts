import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { InMemoryTraceStore } from "../src/trace.js";
import { observeModelWithTrace, closeModelTrace } from "../src/trace-model.js";
import { ModelRequestDebugStore } from "../apps/cli/src/model-request-debug.js";
import type { ModelAdapter, ModelRequest } from "../src/model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { fetchModelResponse } from "../src/model/request-retry.js";

function token(account: string, version = "one") {
  return `header.${Buffer.from(JSON.stringify({ version, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}
function request(attempt = 1): ModelRequest {
  return {
    model: "synthetic-model",
    reasoningEffort: "medium",
    messages: [{ role: "user", text: "synthetic prompt" }],
    tools: [],
    signal: new AbortController().signal,
    ...(attempt > 1 ? { isSamplingRetry: true as const } : {}),
    debugContext: {
      threadId: "thread-seam",
      purpose: "turn",
      turnId: "turn-seam",
      sampleId: `sample-${attempt}`,
      contextBoundaryItemId: "item-seam",
      sampleAttempt: attempt,
    },
  };
}
async function consume(adapter: ModelAdapter, input: ModelRequest) {
  for await (const _event of adapter.stream(input)) {
    // Consume the real adapter stream.
  }
}

test("capture preserves subscription 8+2+2 dispatch budget and identities across auth rotation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  const trace = new InMemoryTraceStore();
  const store = new ModelRequestDebugStore(trace);
  const oldToken = token("same-account", "old");
  const newToken = token("same-account", "new");
  const statuses = [503, 503, 503, 401, 503, 503, 503, 200, 401, 200, 401, 200];
  const authorizations: string[] = [];
  const bodies: string[] = [];
  let renewals = 0;
  const adapter = observeModelWithTrace(
    new OpenAiSubscriptionModel({
      acquireAccessLease: async () => ({ accessToken: oldToken }),
      renewAccessLease: async (rejected) => {
        assert.equal(rejected, oldToken);
        renewals++;
        return { accessToken: newToken };
      },
      fetch: async (_url, init) => {
        assert(bodies.length < statuses.length, "dispatch budget exceeded");
        bodies.push(String(init?.body));
        authorizations.push(new Headers(init?.headers).get("authorization")!);
        const captures = (
          await store.control({
            action: "list",
            threadId: "thread-seam",
          })
        ).records!;
        assert.equal(
          captures.length,
          bodies.length,
          "capture must precede each HTTP dispatch",
        );
        const latest = captures[0]!;
        const payload = (
          await store.control({
            action: "read",
            threadId: latest.threadId,
            id: latest.id,
          })
        ).page!.text;
        assert(
          payload.includes(oldToken),
          "user body is preserved exactly, not broadly credential-redacted",
        );
        assert(!JSON.stringify(latest).includes(oldToken));
        assert(!JSON.stringify(latest).includes(newToken));
        const wire = (await trace.read("thread-seam")).records.find(
          (r) => r.id === latest.id,
        )!;
        assert.deepEqual(
          (wire.data as { omittedHeaders: string[] }).omittedHeaders,
          ["authorization"],
        );
        assert(!JSON.stringify(wire.data).includes(oldToken));
        assert.equal(
          latest.requestBytes,
          Buffer.byteLength(String(init?.body)),
        );
        const status = statuses[bodies.length - 1]!;
        return status === 200
          ? new Response("data: {}\n\n") // A real premature stream failure starts the next sample.
          : new Response(null, { status });
      },
    }),
    trace,
  );
  let finished = false;
  const samples = (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await assert.rejects(
        consume(adapter, {
          ...request(attempt),
          messages: [
            { role: "user", text: `credential echoed in prompt: ${oldToken}` },
          ],
        }),
        (error: unknown) =>
          (error as { retryable?: boolean }).retryable === true,
      );
    }
  })().finally(() => {
    finished = true;
  });
  while (!finished) {
    t.mock.timers.tick(10_000);
    await setImmediate();
  }
  await samples;
  await closeModelTrace(trace);
  const records = (
    await store.control({ action: "list", threadId: "thread-seam" })
  ).records!.reverse();
  assert.equal(records.length, 12);
  assert.equal(new Set(records.map((entry) => entry.id)).size, 12);
  assert.deepEqual(
    records.map((entry) => entry.transportAttempt),
    [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 1, 2],
  );
  assert.deepEqual(
    records.map((entry) => entry.sampleId),
    [
      ...Array<string>(8).fill("sample-1"),
      "sample-2",
      "sample-2",
      "sample-3",
      "sample-3",
    ],
  );
  assert.deepEqual(
    records.map((entry) => entry.sampleAttempt),
    [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3],
  );
  assert.equal(renewals, 3);
  assert.deepEqual(authorizations, [
    ...Array<string>(4).fill(`Bearer ${oldToken}`),
    ...Array<string>(4).fill(`Bearer ${newToken}`),
    `Bearer ${oldToken}`,
    `Bearer ${newToken}`,
    `Bearer ${oldToken}`,
    `Bearer ${newToken}`,
  ]);
  assert.equal(
    new Set(bodies).size,
    1,
    "observation must not mutate the submitted body",
  );
});

test("capture does not re-enable admission retries for sampling replays", async (t) => {
  for (const provider of ["chat", "subscription"] as const) {
    for (const failure of ["http", "transport"] as const) {
      await t.test(`${provider} ${failure}`, async () => {
        const trace = new InMemoryTraceStore();
        const store = new ModelRequestDebugStore(trace);
        let calls = 0;
        const fetch: typeof globalThis.fetch = async () => {
          calls++;
          if (failure === "transport") throw new TypeError("fetch failed");
          return new Response(null, { status: 503 });
        };
        const model =
          provider === "chat"
            ? new OpenAiCompatibleModel({
                baseUrl: "https://provider.test/v1",
                apiKey: "synthetic-key",
                fetch,
              })
            : new OpenAiSubscriptionModel({
                acquireAccessLease: async () => ({
                  accessToken: token("account"),
                }),
                fetch,
              });
        await assert.rejects(
          consume(observeModelWithTrace(model, trace), request(2)),
        );
        assert.equal(calls, 1);
        await closeModelTrace(trace);
        const records = (
          await store.control({
            action: "list",
            threadId: "thread-seam",
          })
        ).records!;
        assert.equal(records.length, 1);
        assert.equal(records[0]!.sampleAttempt, 2);
        assert.equal(records[0]!.transportAttempt, 1);
      });
    }
  }
});

test("admission wait budget includes exactly 120 seconds but never exceeds it", async () => {
  for (const cooldown of ["60", "60.001"]) {
    const waits: number[] = [];
    let calls = 0;
    const result = await fetchModelResponse(
      async () => {
        calls++;
        return new Response(null, {
          status: 429,
          headers: { "retry-after": cooldown },
        });
      },
      new AbortController().signal,
      {
        random: () => 0,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    assert.equal(result.status, 429);
    assert.deepEqual(waits, cooldown === "60" ? [60_000, 60_000] : [60_001]);
    assert.equal(calls, cooldown === "60" ? 3 : 2);
    assert(waits.reduce((sum, ms) => sum + ms, 0) <= 120_000);
  }
});
