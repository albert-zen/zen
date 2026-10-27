import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileTraceStore } from "../src/trace.js";
import { observeModelWithTrace, closeModelTrace } from "../src/trace-model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiResponsesModel } from "../src/model/openai-responses.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { fetchObservedModelResponse } from "../src/model/request-observation.js";
import type { ModelRequest } from "../src/model.js";
import type { ToolMediaTransportSummary } from "../src/model/transport-types.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { png1x1 } from "./fixtures.js";
import { ModelRequestDebugStore } from "../apps/cli/src/model-request-debug.js";
import { sanitizeToolMediaTransportSummary } from "../src/model/tool-media-transport.js";
const zero = {
  nativeToolContent: 0,
  compatibilitySupplement: 0,
  unknownTarget: 0,
  undeclaredMedia: 0,
  nativeSupportUnverified: 0,
  conflictingEvidence: 0,
};
const endpoint = "https://synthetic.invalid/v1/chat/completions";
const support = {
  protocol: "chat-completions" as const,
  endpoint,
  model: "synthetic",
  media: ["image" as const],
  evidence: "synthetic fixture only",
  reviewedOn: "2026-10-27",
};
const complete =
  'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\ndata: [DONE]\n\n';
const chatComplete =
  'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
for (const mode of [
  "native",
  "unknown",
  "undeclared",
  "conflict",
  "subscription",
  "public-responses",
] as const) {
  test(`actual ${mode} media decision survives cold durable inspection without changing wire or semantics`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "zen-media-trace-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const trace = new FileTraceStore(directory);
    const attachments = new InMemoryAttachmentStore();
    const attachment = await attachments.importBytes(png1x1());
    const request: ModelRequest = {
      model: "synthetic",
      reasoningEffort: "medium",
      tools: [],
      signal: new AbortController().signal,
      debugContext: {
        threadId: "thread",
        turnId: "turn",
        sampleId: "sample",
        purpose: "turn",
        sampleAttempt: 1,
        contextBoundaryItemId: "synthetic-context",
      },
      messages: [
        { role: "user", text: "original human input" },
        {
          role: "assistant",
          toolCalls: [
            { callId: "a", name: "fixture", arguments: {} },
            { callId: "b", name: "fixture", arguments: {} },
          ],
        },
        {
          role: "tool",
          callId: "a",
          text: "image receipt",
          exitCode: 0,
          modelContent: [
            { type: "image", attachment },
            { type: "image", attachment },
          ],
        },
        { role: "tool", callId: "b", text: "other receipt", exitCode: 0 },
      ],
    };
    const original = structuredClone(request.messages);
    let body = "",
      calls = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls++;
      body = String(init?.body);
      return new Response(
        mode === "subscription" || mode === "public-responses"
          ? complete
          : chatComplete,
      );
    };
    const adapter =
      mode === "subscription"
        ? new OpenAiSubscriptionModel({
            acquireAccessLease: async () => ({
              accessToken: `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`,
            }),
            attachments,
            fetch,
          })
        : mode === "public-responses"
          ? new OpenAiResponsesModel({
              baseUrl: "https://synthetic.invalid/v1",
              apiKey: "synthetic-key",
              attachments,
              fetch,
            })
          : new OpenAiCompatibleModel({
              baseUrl: "https://synthetic.invalid/v1",
              apiKey: "synthetic-key",
              attachments,
              fetch,
              toolMediaCapabilities:
                mode === "unknown"
                  ? []
                  : [
                      {
                        ...support,
                        media: mode === "undeclared" ? [] : support.media,
                      },
                    ],
              toolMediaEvidenceConflicts: mode === "conflict" ? [support] : [],
            });
    const model = observeModelWithTrace(adapter, trace);
    for await (const _event of model.stream(request)) {
      /* production pipeline */
    }
    await closeModelTrace(trace);
    await trace.flush();
    const cold = new FileTraceStore(directory);
    const reader = new ModelRequestDebugStore(cold);
    const summary = (
      await reader.control({ action: "list", threadId: "thread" })
    ).records![0]!;
    const expected =
      mode === "public-responses"
        ? undefined
        : {
            ...zero,
            ...(mode === "native"
              ? { nativeToolContent: 1 }
              : { compatibilitySupplement: 1 }),
            ...(mode === "unknown" ? { unknownTarget: 1 } : {}),
            ...(mode === "undeclared" ? { undeclaredMedia: 1 } : {}),
            ...(mode === "conflict" ? { conflictingEvidence: 1 } : {}),
            ...(mode === "subscription" ? { nativeSupportUnverified: 1 } : {}),
          };
    assert.deepEqual(
      summary.toolMediaTransport,
      expected,
      "counts refer to tool results, not two image parts",
    );
    assert.deepEqual(
      (await cold.read("thread")).records.find(
        (r) => r.type === "model_request",
      )!.data &&
        (
          (await cold.read("thread")).records.find(
            (r) => r.type === "model_request",
          )!.data as { toolMediaTransport?: unknown }
        ).toolMediaTransport,
      expected,
    );
    assert.equal(
      (
        await reader.control({
          action: "read",
          threadId: "thread",
          id: summary.id,
          view: "payload",
        })
      ).page!.text,
      body,
    );
    assert.equal(calls, 1, "inspection never dispatches or probes");
    assert.deepEqual(request.messages, original);
    assert.doesNotMatch(
      body,
      /toolMediaTransport|conflictingEvidence|reviewedOn|synthetic fixture only/,
    );
    const wire = JSON.parse(body);
    if (mode === "native") {
      assert.deepEqual(
        wire.messages.map((m: any) => m.role),
        ["user", "assistant", "tool", "tool"],
      );
      assert.equal(wire.messages[2].content.length, 3);
      assert.equal(wire.messages[2].tool_call_id, "a");
    } else if (mode === "public-responses") {
      const output = wire.input.find(
        (x: any) => x.type === "function_call_output" && x.call_id === "a",
      );
      assert.equal(
        output.output.filter((x: any) => x.type === "input_image").length,
        2,
      );
      assert.equal(
        wire.input.filter((x: any) => x.role === "user").length,
        1,
        "Responses is independently native",
      );
    } else if (mode === "subscription") {
      assert.equal(
        wire.input.find((x: any) => x.type === "function_call_output").output,
        "image receipt",
      );
      assert.equal(wire.input.filter((x: any) => x.role === "user").length, 2);
    } else {
      assert.deepEqual(
        wire.messages.map((m: any) => m.role),
        ["user", "assistant", "tool", "tool", "user"],
      );
      assert.equal(wire.messages[4].content.length, 2);
    }
  });
}
test("capture freezes and allowlists bounded counts; legacy absence remains absent", async () => {
  const supplied = {
    ...zero,
    nativeToolContent: 2_000_000,
    compatibilitySupplement: -1,
    unknownTarget: Number.NaN,
    undeclaredMedia: 1.5,
    nativeSupportUnverified: 2,
    endpoint: "must-not-be-captured",
    evidence: "must-not-be-captured",
  };
  const expected = {
    ...zero,
    nativeToolContent: 1_000_000,
    nativeSupportUnverified: 2,
  };
  assert.deepEqual(sanitizeToolMediaTransportSummary(supplied), expected);
  assert.equal(sanitizeToolMediaTransportSummary(undefined), undefined);
  let captured: unknown,
    dispatched = 0;
  await fetchObservedModelResponse({
    request: {
      model: "synthetic",
      reasoningEffort: null,
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      onRequest: () => {
        supplied.nativeToolContent = 7;
      },
      onTransport: async (event) => {
        if (event.type === "request") captured = event.toolMediaTransport;
      },
    },
    fetch: async () => {
      dispatched++;
      return new Response(null);
    },
    url: endpoint,
    init: { method: "POST", body: "{}" },
    format: "chat-completions",
    provider: "synthetic",
    transportAttempt: 1,
    toolMediaTransport: supplied as ToolMediaTransportSummary,
  });
  assert.deepEqual(captured, expected);
  assert.equal(dispatched, 1);
  assert.doesNotMatch(
    JSON.stringify(captured),
    /must-not-be-captured|endpoint|evidence/,
  );
});
