import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEvent, ModelRequest } from "../src/model.js";
import type {
  ModelTransportHooks,
  ModelTransportObservation,
} from "../src/model/transport-types.js";
import {
  fetchObservedModelResponse,
  observeRequestBody,
  ModelDispatchRevokedError,
  MODEL_RESPONSE_TERMINAL,
  setModelTransportCaptureOwner,
  closeModelTransportCaptures,
} from "../src/model/request-observation.js";
import { fetchModelResponse } from "../src/model/request-retry.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";

function input(
  events: ModelTransportObservation[],
  overrides: Partial<ModelRequest & ModelTransportHooks> = {},
): ModelRequest & ModelTransportHooks {
  return {
    model: "synthetic-model",
    reasoningEffort: "low",
    messages: [{ role: "user", text: "password token remain text" }],
    tools: [],
    signal: new AbortController().signal,
    onTransport: async (event) => {
      events.push(event);
    },
    ...overrides,
  };
}
function stream(parts: readonly Uint8Array[], status = 200): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const part = parts[index++];
          if (part === undefined) controller.close();
          else controller.enqueue(part);
        },
      },
      { highWaterMark: 0 },
    ),
    { status, headers: { "x-token": "ordinary-response-header" } },
  );
}
function captured(events: ModelTransportObservation[], attempt = 1): Buffer {
  return Buffer.concat(
    events.flatMap((event) =>
      event.type === "response_chunk" && event.transportAttempt === attempt
        ? [event.bytes]
        : [],
    ),
  );
}
function observed(
  request: ModelRequest & ModelTransportHooks,
  fetch: typeof globalThis.fetch,
  init: RequestInit = { method: "POST", body: "{}" },
  transportAttempt = 1,
) {
  return fetchObservedModelResponse({
    request,
    fetch,
    init,
    transportAttempt,
    url: "https://synthetic.invalid/v1?token=ordinary",
    provider: "synthetic",
    format: "chat-completions",
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function collect(events: AsyncIterable<ModelEvent>) {
  const result: ModelEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
const terminalChat =
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const terminalResponses =
  'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
const token = (account: string) =>
  `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;

test("serialized string is captured verbatim and the same immutable value reaches fetch; only auth header values are omitted", async () => {
  const events: ModelTransportObservation[] = [];
  const body =
    '{ "password": "synthetic-key", "token": "synthetic-key", "text": "你" }';
  const original: RequestInit = {
    method: "POST",
    body,
    headers: {
      authorization: "Bearer synthetic-key",
      "x-api-key": "synthetic-other",
      "x-token": "ordinary-header",
    },
  };
  let legacy = "";
  const response = await observed(
    input(events, {
      onRequest: async (event) => {
        await Promise.resolve();
        legacy = event.body;
        assert.equal(event.redacted, false);
      },
      onTransport: async (event) => {
        events.push(event);
        if (event.type === "request") {
          original.body = "mutated";
          original.method = "DELETE";
        }
      },
    }),
    async (_url, init) => {
      assert.equal(legacy, body);
      assert.equal(init?.body, body);
      assert.equal(init?.method, "POST");
      const request = events.find((event) => event.type === "request")!;
      assert.equal(request.type, "request");
      if (request.type === "request") {
        assert.equal(Buffer.from(request.body!).toString(), body);
        assert.deepEqual(request.omittedHeaders, [
          "authorization",
          "x-api-key",
        ]);
        assert.deepEqual(request.headers, [["x-token", "ordinary-header"]]);
      }
      return stream([
        Uint8Array.from([0xff, 0x00, 0xe4]),
        Uint8Array.from([0xbd, 0xa0]),
      ]);
    },
    original,
  );
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.from([0xff, 0x00, 0xe4, 0xbd, 0xa0]),
  );
  assert.equal(captured(events).length, 5);
  assert.deepEqual(
    events
      .filter((event) => event.type === "response_chunk")
      .map((event) => event.offset),
    [0, 3],
  );
  assert(
    events.some(
      (event) =>
        event.type === "request_dispatched" &&
        event.captureLayer === "fetch-invocation",
    ),
  );
});

test("legacy body observer no longer redacts body fields or known secret values", async () => {
  const body = '{"api_key":"synthetic-value","password":"synthetic-value"}';
  let actual = "";
  await observeRequestBody(
    input([], {
      onRequest: (event) => {
        actual = event.body;
      },
    }),
    body,
    "responses",
    "synthetic",
    1,
    ["synthetic-value"],
  );
  assert.equal(actual, body);
});

test("nonstring body is not consumed or re-encoded and capture explicitly reports unavailable", async () => {
  const events: ModelTransportObservation[] = [];
  const form = new FormData();
  form.append("password", "synthetic-body");
  const response = await observed(
    input(events, {
      onRequest: () => {
        throw new Error("No alternate string body may be created");
      },
    }),
    async (_url, init) => {
      assert.equal(init?.body, form);
      assert.equal(new Headers(init?.headers).get("content-type"), null);
      return stream([]);
    },
    { body: form, method: "POST" },
  );
  await response.text();
  const request = events.find((event) => event.type === "request")!;
  assert.equal(request.type, "request");
  if (request.type === "request") {
    assert.equal(request.body, undefined);
    assert.equal(request.completeness, "unavailable");
  }
  assert(
    events.some(
      (event) =>
        event.type === "capture_gap" &&
        event.reason === "unsupported_body_type",
    ),
  );
});

test("guard blocks before capture and cannot be retried even when its underlying error looks transient", async () => {
  const events: ModelTransportObservation[] = [];
  let fetches = 0,
    attempts = 0;
  const request = input(events, {
    assertDispatchAllowed: () => {
      throw Object.assign(new Error("synthetic rejection"), {
        code: "ECONNRESET",
      });
    },
  });
  await assert.rejects(
    fetchModelResponse(
      () => {
        attempts++;
        return observed(request, async () => {
          fetches++;
          return stream([]);
        });
      },
      request.signal,
      { sleep: async () => undefined },
    ),
    (error) => {
      assert(error instanceof ModelDispatchRevokedError);
      assert.equal(error.modelRecoveryBlocked, true);
      assert.equal(error.retryable, false);
      assert.equal(error.preparedRequestCaptured, false);
      return true;
    },
  );
  assert.equal(attempts, 1);
  assert.equal(fetches, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ["dispatch_blocked"],
  );
});

test("revocation while capture is awaited records prepared input without claiming dispatch", async () => {
  const events: ModelTransportObservation[] = [];
  let allowed = true,
    fetches = 0;
  const request = input(events, {
    assertDispatchAllowed: () => {
      if (!allowed) throw new ModelDispatchRevokedError("account_changed");
    },
    onTransport: async (event) => {
      events.push(event);
      if (event.type === "request") {
        await Promise.resolve();
        allowed = false;
      }
    },
  });
  await assert.rejects(
    observed(request, async () => {
      fetches++;
      return stream([]);
    }),
    (error) =>
      error instanceof ModelDispatchRevokedError &&
      error.reason === "account_changed" &&
      error.preparedRequestCaptured,
  );
  assert.equal(fetches, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ["request", "dispatch_blocked"],
  );
});

test("there is no asynchronous boundary between the final live guard and actual fetch invocation", async () => {
  const events: ModelTransportObservation[] = [];
  let checks = 0,
    allowed = true;
  const request = input(events, {
    assertDispatchAllowed: () => {
      assert.equal(allowed, true);
      if (++checks === 2)
        queueMicrotask(() => {
          allowed = false;
        });
    },
  });
  const response = await observed(request, async () => {
    assert.equal(checks, 2);
    assert.equal(allowed, true);
    return stream([]);
  });
  await response.text();
  assert.equal(allowed, false);
});

test("each admission retry rechecks live authorization before capturing another request", async () => {
  const events: ModelTransportObservation[] = [];
  let allowed = true,
    attempts = 0,
    fetches = 0;
  const request = input(events, {
    assertDispatchAllowed: () => {
      if (!allowed) throw new ModelDispatchRevokedError("provider_revoked");
    },
  });
  await assert.rejects(
    fetchModelResponse(
      () =>
        observed(
          request,
          async () => {
            fetches++;
            return stream([Buffer.from("full retry body")], 429);
          },
          { body: "{}" },
          ++attempts,
        ),
      request.signal,
      {
        sleep: async () => {
          allowed = false;
        },
        random: () => 0,
      },
    ),
    ModelDispatchRevokedError,
  );
  assert.equal(fetches, 1);
  assert.equal(attempts, 2);
  assert.equal(captured(events).toString(), "full retry body");
  assert.equal(events.filter((event) => event.type === "request").length, 1);
});

test("raw response reads apply disk backpressure before parser access without tee or prefetch", async () => {
  const events: ModelTransportObservation[] = [];
  const entered = deferred(),
    release = deferred();
  let pulls = 0;
  const response = await observed(
    input(events, {
      onTransport: async (event) => {
        events.push(event);
        if (event.type === "response_chunk" && event.index === 1) {
          entered.resolve();
          await release.promise;
        }
      },
    }),
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (++pulls <= 2) controller.enqueue(Buffer.from(String(pulls)));
              else controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  const reading = response.text();
  await entered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pulls, 1);
  release.resolve();
  assert.equal(await reading, "12");
  assert.equal(captured(events).toString(), "12");
});

test("fetch rejection is handled immediately even while dispatch-marker persistence is delayed", async () => {
  const events: ModelTransportObservation[] = [];
  const failure = new TypeError("synthetic fetch failure");
  await assert.rejects(
    observed(
      input(events, {
        onTransport: async (event) => {
          events.push(event);
          if (event.type === "request_dispatched")
            await new Promise<void>((resolve) => setImmediate(resolve));
        },
      }),
      async () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(events.at(-1)?.type, "transport_error");
});

test("partial body errors retain captured bytes and an honest interrupted offset", async () => {
  const events: ModelTransportObservation[] = [];
  let pulls = 0;
  const response = await observed(
    input(events),
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (++pulls === 1) controller.enqueue(Buffer.from("partial"));
              else controller.error(new Error("synthetic body error"));
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  await assert.rejects(response.text(), /synthetic body error/);
  assert.equal(captured(events).toString(), "partial");
  const end = events.at(-1)!;
  assert.equal(end.type, "response_end");
  if (end.type === "response_end") {
    assert.equal(end.completeness, "interrupted");
    assert.equal(end.offset, 7);
  }
});

test("real Chat serializer completes inference at terminal marker but captures a finite transport tail", async () => {
  const events: ModelTransportObservation[] = [];
  const ended = deferred();
  let sent = "";
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://synthetic.invalid/v1",
    apiKey: "synthetic-key",
    defaultParams: { temperature: 0.3 },
    fetch: async (_url, init) => {
      sent = String(init?.body);
      return stream([
        Buffer.from(terminalChat),
        Buffer.from("finite raw tail"),
      ]);
    },
  });
  const output = await collect(
    model.stream(
      input(events, {
        onTransport: async (event) => {
          events.push(event);
          if (event.type === "response_end") ended.resolve();
        },
      }),
    ),
  );
  assert(
    output.some((event) => event.type === "text_delta" && event.delta === "ok"),
  );
  await ended.promise;
  assert.equal(captured(events).toString(), terminalChat + "finite raw tail");
  const request = events.find((event) => event.type === "request")!;
  if (request.type === "request")
    assert.equal(Buffer.from(request.body!).toString(), sent);
});

test("real subscription records every 401 renewal body and preserves revocation without a second fetch", async () => {
  const events: ModelTransportObservation[] = [];
  let allowed = true,
    fetches = 0;
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: token("old") }),
    renewAccessLease: async () => {
      allowed = false;
      return { accessToken: token("new") };
    },
    fetch: async () => {
      fetches++;
      return stream([Buffer.from("raw password token failure")], 401);
    },
  });
  await assert.rejects(
    collect(
      model.stream(
        input(events, {
          assertDispatchAllowed: () => {
            if (!allowed)
              throw new ModelDispatchRevokedError("auth_session_changed");
          },
        }),
      ),
    ),
    (error) =>
      error instanceof ModelDispatchRevokedError &&
      error.reason === "auth_session_changed",
  );
  assert.equal(fetches, 1);
  assert.equal(captured(events).toString(), "raw password token failure");
  assert.equal(
    events.filter((event) => event.type === "request_dispatched").length,
    1,
  );
});

test("real subscription serializer captures successful response bytes without modifying the body", async () => {
  const events: ModelTransportObservation[] = [];
  let sent = "";
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: token("synthetic") }),
    fetch: async (_url, init) => {
      sent = String(init?.body);
      return stream([Buffer.from(terminalResponses)]);
    },
  });
  await collect(model.stream(input(events)));
  const request = events.find((event) => event.type === "request")!;
  if (request.type === "request") {
    assert.equal(Buffer.from(request.body!).toString(), sent);
    assert(request.omittedHeaders.includes("authorization"));
  }
  assert.equal(captured(events).toString(), terminalResponses);
});

test(
  "background capture shutdown is owner-scoped, idempotent, and records host interruption",
  { timeout: 2000 },
  async () => {
    const owners = [{}, {}],
      all: ModelTransportObservation[][] = [[], []];
    for (const [index, owner] of owners.entries()) {
      const observer = async (event: ModelTransportObservation) => {
        all[index]!.push(event);
      };
      setModelTransportCaptureOwner(observer, owner);
      let pulled = false;
      const response = await observed(
        input(all[index]!, { onTransport: observer }),
        async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (!pulled) {
                    pulled = true;
                    controller.enqueue(Buffer.from("prefix"));
                  }
                },
              },
              { highWaterMark: 0 },
            ),
          ),
      );
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel(MODEL_RESPONSE_TERMINAL);
      reader.releaseLock();
    }
    await closeModelTransportCaptures(owners[0]!);
    const end = all[0]!.at(-1)!;
    assert.equal(end.type, "response_end");
    if (end.type === "response_end") {
      assert.equal(end.completeness, "interrupted");
      assert.equal(end.reason, "host_shutdown");
      assert.equal(end.offset, 6);
    }
    assert(!all[1]!.some((event) => event.type === "response_end"));
    await closeModelTransportCaptures(owners[1]!);
    const counts = all.map((events) => events.length);
    await closeModelTransportCaptures(owners[0]!);
    await closeModelTransportCaptures(owners[1]!);
    assert.deepEqual(
      all.map((events) => events.length),
      counts,
    );
  },
);

test("observer failures do not change inference and nonterminal cancellation is never EOF", async () => {
  const events: ModelTransportObservation[] = [];
  const response = await observed(
    input(events, {
      onTransport: async (event) => {
        events.push(event);
        if (event.type === "response_chunk")
          throw new Error("synthetic disk failure");
      },
    }),
    async () => stream([Buffer.from("seen"), Buffer.from("unread")]),
  );
  const reader = response.body!.getReader();
  assert.equal(Buffer.from((await reader.read()).value!).toString(), "seen");
  await reader.cancel();
  reader.releaseLock();
  const end = events.at(-1)!;
  assert.equal(end.type, "response_end");
  if (end.type === "response_end") {
    assert.equal(end.completeness, "interrupted");
    assert.equal(end.offset, 4);
  }
});

test("subscription same-account refresh keeps initial and current live guards and exact repeated body", async () => {
  const events: ModelTransportObservation[] = [];
  const bodies: string[] = [];
  let initialChecks = 0,
    renewedChecks = 0;
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({
      accessToken: token("same-account"),
      assertDispatchAllowed() {
        initialChecks++;
      },
    }),
    renewAccessLease: async () => ({
      accessToken: token("same-account").replace(
        "signature",
        "renewed-signature",
      ),
      assertDispatchAllowed() {
        renewedChecks++;
      },
    }),
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? stream([Buffer.from("full 401 body")], 401)
        : stream([Buffer.from(terminalResponses)]);
    },
  });
  await collect(model.stream(input(events)));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(initialChecks, 4);
  assert.equal(renewedChecks, 2);
  assert.equal(captured(events, 1).toString(), "full 401 body");
  assert.equal(captured(events, 2).toString(), terminalResponses);
});

test("renewal cannot replace an invalidated initial auth-session guard", async () => {
  const events: ModelTransportObservation[] = [];
  let active = true,
    fetches = 0;
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({
      accessToken: token("same-account"),
      assertDispatchAllowed() {
        if (!active) throw new Error("synthetic logout and login");
      },
    }),
    renewAccessLease: async () => {
      active = false;
      return { accessToken: token("same-account"), assertDispatchAllowed() {} };
    },
    fetch: async () => {
      fetches++;
      return stream([], 401);
    },
  });
  await assert.rejects(
    collect(model.stream(input(events))),
    (error) =>
      error instanceof ModelDispatchRevokedError &&
      error.reason === "auth_session_changed",
  );
  assert.equal(fetches, 1);
  assert.equal(events.filter((event) => event.type === "request").length, 1);
});

test("401 renewal cannot silently switch the account even without optional lease guards", async () => {
  const events: ModelTransportObservation[] = [];
  let fetches = 0;
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: token("first-account") }),
    renewAccessLease: async () => ({ accessToken: token("different-account") }),
    fetch: async () => {
      fetches++;
      return stream([], 401);
    },
  });
  await assert.rejects(
    collect(model.stream(input(events))),
    (error) =>
      error instanceof ModelDispatchRevokedError &&
      error.reason === "account_changed",
  );
  assert.equal(fetches, 1);
});

test("renewed lease is checked again after capture and before the actual fetch", async () => {
  const events: ModelTransportObservation[] = [];
  let renewedActive = true,
    fetches = 0;
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: token("same-account") }),
    renewAccessLease: async () => ({
      accessToken: token("same-account"),
      assertDispatchAllowed() {
        if (!renewedActive)
          throw new Error("synthetic auth removed during capture");
      },
    }),
    fetch: async () => {
      fetches++;
      return stream([], 401);
    },
  });
  await assert.rejects(
    collect(
      model.stream(
        input(events, {
          onTransport: async (event) => {
            events.push(event);
            if (event.type === "request" && event.transportAttempt === 2)
              renewedActive = false;
          },
        }),
      ),
    ),
    (error) =>
      error instanceof ModelDispatchRevokedError &&
      error.reason === "auth_session_changed" &&
      error.preparedRequestCaptured,
  );
  assert.equal(fetches, 1);
});

test("a later lease revocation does not abort the already-dispatched response", async () => {
  const events: ModelTransportObservation[] = [];
  let active = true;
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({
      accessToken: token("same-account"),
      assertDispatchAllowed() {
        if (!active) throw new Error("synthetic revoked after dispatch");
      },
    }),
    fetch: async () => {
      active = false;
      return stream([Buffer.from(terminalResponses)]);
    },
  });
  const output = await collect(model.stream(input(events)));
  assert(output.some((event) => event.type === "usage"));
  assert.equal(captured(events).toString(), terminalResponses);
  assert(!events.some((event) => event.type === "dispatch_blocked"));
});

test(
  "abort interrupts an error-body drain and reports the actual captured byte offset",
  { timeout: 2000 },
  async () => {
    const events: ModelTransportObservation[] = [];
    const abort = new AbortController();
    const started = deferred();
    const response = await observed(
      input(events, { signal: abort.signal }),
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                started.resolve();
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 401 },
        ),
      { body: "{}", signal: abort.signal },
    );
    const draining = response.body!.cancel();
    await started.promise;
    abort.abort();
    await draining;
    const end = events.at(-1)!;
    assert.equal(end.type, "response_end");
    if (end.type === "response_end") {
      assert.equal(end.completeness, "interrupted");
      assert.equal(end.reason, "request_aborted");
      assert.equal(end.offset, 0);
    }
  },
);

test("an asynchronous dispatch guard fails closed rather than leaving a stale awaited decision", async () => {
  let fetches = 0;
  await assert.rejects(
    observed(
      input([], { assertDispatchAllowed: async () => undefined }),
      async () => {
        fetches++;
        return stream([]);
      },
    ),
    ModelDispatchRevokedError,
  );
  assert.equal(fetches, 0);
});

test("renewal reusing a mutable lease cannot replace the original auth-session closure", async () => {
  let initialActive = true,
    fetches = 0;
  const lease = {
    accessToken: token("same-account"),
    assertDispatchAllowed() {
      if (!initialActive) throw new Error("original session ended");
    },
  };
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => lease,
    renewAccessLease: async () => {
      initialActive = false;
      lease.assertDispatchAllowed = () => undefined;
      return lease;
    },
    fetch: async () => {
      fetches++;
      return stream([], 401);
    },
  });
  await assert.rejects(
    collect(model.stream(input([]))),
    (error) =>
      error instanceof ModelDispatchRevokedError &&
      error.reason === "auth_session_changed",
  );
  assert.equal(fetches, 1);
});

test("a new current guard on a reused lease is checked in addition to the original closure", async () => {
  let fetches = 0;
  const lease = {
    accessToken: token("same-account"),
    assertDispatchAllowed() {},
  };
  const model = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => lease,
    renewAccessLease: async () => {
      lease.assertDispatchAllowed = () => {
        throw new Error("current lease is no longer valid");
      };
      return lease;
    },
    fetch: async () => {
      fetches++;
      return stream([], 401);
    },
  });
  await assert.rejects(
    collect(model.stream(input([]))),
    (error) =>
      error instanceof ModelDispatchRevokedError &&
      error.reason === "auth_session_changed",
  );
  assert.equal(fetches, 1);
});

test("request identity metadata is frozen before an awaited observer can mutate request.model", async () => {
  const events: ModelTransportObservation[] = [];
  let legacyModel = "";
  const request = input(events, {
    onRequest: async (event) => {
      legacyModel = event.model;
      request.model = "mutated-during-observation";
      await Promise.resolve();
    },
  });
  const body = JSON.stringify({ model: request.model });
  const response = await observed(
    request,
    async (_url, init) => {
      assert.equal(init?.body, body);
      return stream([]);
    },
    { body },
  );
  await response.text();
  assert.equal(legacyModel, "synthetic-model");
  const observedRequest = events.find((event) => event.type === "request")!;
  if (observedRequest.type === "request")
    assert.equal(observedRequest.model, "synthetic-model");
});
