import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModelResponse } from "../src/model/request-retry.js";

test("model request backs off on transport and 429, then returns the unconsumed stream", async () => {
  const waits: number[] = [];
  let calls = 0;
  const result = await fetchModelResponse(
    async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      if (calls === 2)
        return new Response("limited", {
          status: 429,
          headers: { "retry-after": "3" },
        });
      return new Response("stream");
    },
    new AbortController().signal,
    {
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.equal(await result.text(), "stream");
  assert.deepEqual(waits, [1000, 3000]);
  assert.equal(calls, 3);
});

test("request retries are finite and permanent HTTP failures are not retried", async () => {
  for (const [status, expected] of [
    [503, 4],
    [401, 1],
    [400, 1],
    [403, 1],
  ] as const) {
    let calls = 0;
    const response = await fetchModelResponse(
      async () => {
        calls++;
        return new Response("error", { status });
      },
      new AbortController().signal,
      { sleep: async () => {} },
    );
    assert.equal(response.status, status);
    assert.equal(calls, expected);
  }
});

test("Retry-After beyond the waiting budget is not shortened", async () => {
  let calls = 0;
  const response = await fetchModelResponse(
    async () => {
      calls++;
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "600" },
      });
    },
    new AbortController().signal,
    { sleep: async () => assert.fail("must not retry early") },
  );
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
});

test("stop interrupts backoff without issuing another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = fetchModelResponse(async () => {
    calls++;
    return new Response(null, { status: 503 });
  }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("a successful response body failure is never replayed", async () => {
  let calls = 0;
  const response = await fetchModelResponse(async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error("broken stream"));
        },
      }),
    );
  }, new AbortController().signal);
  await assert.rejects(response.text(), /broken stream/);
  assert.equal(calls, 1);
});
