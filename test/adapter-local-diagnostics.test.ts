import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelAdapter, ModelRequest } from "../src/model.js";
import { ModelRequestDebugStore } from "../apps/cli/src/model-request-debug.js";
import { FileTraceStore } from "../src/trace.js";
import { observeModelWithTrace, closeModelTrace } from "../src/trace-model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiResponsesModel } from "../src/model/openai-responses.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";

// Synthetic credentials and bodies only. No network or user data.
const key = "synthetic-auth-key";
const adapters: [string, (fetch: typeof globalThis.fetch) => ModelAdapter][] = [
  [
    "compatible",
    (fetch) =>
      new OpenAiCompatibleModel({
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: key,
        fetch,
      }),
  ],
  [
    "responses",
    (fetch) =>
      new OpenAiResponsesModel({
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: key,
        fetch,
      }),
  ],
  [
    "subscription",
    (fetch) =>
      new OpenAiSubscriptionModel({
        acquireAccessLease: async () => ({
          accessToken: `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.signature`,
        }),
        fetch,
      }),
  ],
];
function request(): ModelRequest {
  return {
    model: "synthetic",
    reasoningEffort: "low",
    messages: [{ role: "user", text: "synthetic question" }],
    tools: [],
    signal: new AbortController().signal,
    sessionId: "synthetic-thread",
    isSamplingRetry: true,
  };
}
async function drain(model: ModelAdapter) {
  for await (const _event of model.stream(request())) {
    /* consume */
  }
}
for (const [name, create] of adapters) {
  test(`${name}: original transport stack and nested cause survive restart independently of model error summary`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-adapter-evidence-"));
    try {
      const trace = new FileTraceStore(root);
      const cause = Object.assign(
        new Error("synthetic TLS certificate reason"),
        { code: "SYNTHETIC_TLS", ownerField: "password=ordinary-owner-text" },
      );
      const failure = new TypeError("synthetic fetch failed", { cause });
      let calls = 0;
      const model = observeModelWithTrace(
        create(async () => {
          calls++;
          throw failure;
        }),
        trace,
      );
      await assert.rejects(drain(model), /before receiving a response/);
      assert.equal(calls, 1);
      await closeModelTrace(trace);
      await trace.flush();
      const reader = new FileTraceStore(root);
      const events = (await reader.read("synthetic-thread")).records;
      const transport = events.find(
        (event) => event.type === "model_transport_error",
      );
      assert(transport);
      const { error } = transport.data as {
        error: { message: string; stack: string; details: string };
      };
      assert.equal(error.message, failure.message);
      assert.equal(error.stack, failure.stack);
      assert.match(error.details, /synthetic TLS certificate reason/);
      assert.match(error.details, /SYNTHETIC_TLS/);
      assert.match(error.details, /password=ordinary-owner-text/);
      const localReader = new ModelRequestDebugStore(reader);
      const record = (
        await localReader.control({
          action: "list",
          threadId: "synthetic-thread",
        })
      ).records![0]!;
      const page = (
        await localReader.control({
          action: "read",
          threadId: "synthetic-thread",
          id: record.id,
          view: "timeline",
        })
      ).page!;
      assert.match(page.text, /synthetic TLS certificate reason/);
      assert.match(page.text, /password=ordinary-owner-text/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test(`${name}: bounded HTTP model diagnostic does not truncate or clean owner response artifact`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-adapter-evidence-"));
    try {
      const trace = new FileTraceStore(root);
      const body = JSON.stringify({
        error: {
          message: `synthetic owner text ${key} ${"x".repeat(24000)} END-OWNER-EVIDENCE`,
          code: "synthetic_invalid_parameter",
        },
      });
      const bytes = Buffer.from(body);
      let offset = 0;
      const model = observeModelWithTrace(
        create(
          async () =>
            new Response(
              new ReadableStream({
                pull(controller) {
                  if (offset === bytes.length) controller.close();
                  else {
                    const end = Math.min(offset + 1024, bytes.length);
                    controller.enqueue(bytes.subarray(offset, end));
                    offset = end;
                  }
                },
              }),
              { status: 400 },
            ),
        ),
        trace,
      );
      await assert.rejects(drain(model));
      await closeModelTrace(trace);
      await trace.flush();
      const reader = new FileTraceStore(root);
      const events = (await reader.read("synthetic-thread")).records;
      const chunks = [];
      for (const event of events.filter(
        (event) => event.type === "model_response_chunk",
      )) {
        chunks.push(
          Buffer.from(await reader.readArtifact(event.artifacts[0]!.ref)),
        );
      }
      assert.equal(Buffer.concat(chunks).toString(), body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
