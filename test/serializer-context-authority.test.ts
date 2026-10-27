import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { OpenAiResponsesModel } from "../src/model/openai-responses.js";
import { FileTraceStore } from "../src/trace.js";
import { observeModelWithTrace, closeModelTrace } from "../src/trace-model.js";
import type { ModelAdapter, ModelRequest } from "../src/model.js";
const terminal =
  'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.x`;
const request = (): ModelRequest => ({
  model: "synthetic",
  reasoningEffort: "medium",
  maxOutputTokens: 17,
  sessionId: "thread",
  messages: [
    { role: "system", text: "persisted system" },
    { role: "developer", text: "persisted developer" },
    {
      role: "user",
      text: "persisted time:literal",
      userTimestamp: "DO_NOT_SYNTHESIZE",
    },
    {
      role: "assistant",
      toolCalls: [{ callId: "call", name: "tool", arguments: {} }],
    },
    {
      role: "tool",
      callId: "call",
      exitCode: 0,
      text: "Exit code: 0\ncanonical receipt",
    },
  ],
  tools: [],
  signal: new AbortController().signal,
});
async function collect(adapter: ModelAdapter, input = request()) {
  for await (const _event of adapter.stream(input)) {
    /* consume */
  }
}
for (const protocol of ["chat", "subscription", "responses"] as const)
  test(`${protocol} serializes stored semantics only and freezes output limit`, async () => {
    let body: any;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        protocol === "chat"
          ? 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          : terminal,
      );
    };
    const adapter =
      protocol === "chat"
        ? new OpenAiCompatibleModel({
            baseUrl: "https://synthetic.invalid/v1",
            apiKey: "synthetic",
            fetch,
          })
        : protocol === "subscription"
          ? new OpenAiSubscriptionModel({
              instructions: "UNMATERIALIZED",
              acquireAccessLease: async () => ({ accessToken: token }),
              fetch,
            })
          : new OpenAiResponsesModel({
              baseUrl: "https://synthetic.invalid/v1",
              apiKey: "synthetic",
              defaultParams: { instructions: "UNMATERIALIZED" },
              fetch,
            });
    await collect(adapter);
    const encoded = JSON.stringify(body);
    assert(!encoded.includes("DO_NOT_SYNTHESIZE"));
    assert(!encoded.includes("UNMATERIALIZED"));
    assert.equal(encoded.match(/Exit code: 0/g)?.length, 1);
    if (protocol === "chat") {
      assert.deepEqual(body.messages.slice(0, 2), [
        { role: "system", content: "persisted system" },
        { role: "developer", content: "persisted developer" },
      ]);
      assert.equal(body.max_tokens, 17);
    } else {
      assert.equal(body.max_output_tokens, 17);
      if (protocol === "subscription") {
        assert.equal(body.instructions, "persisted system");
        assert.deepEqual(body.input[0], {
          role: "developer",
          content: [{ type: "input_text", text: "persisted developer" }],
        });
      } else {
        assert.equal(body.instructions, "");
        assert.deepEqual(body.input.slice(0, 2), [
          {
            role: "system",
            content: [{ type: "input_text", text: "persisted system" }],
          },
          {
            role: "developer",
            content: [{ type: "input_text", text: "persisted developer" }],
          },
        ]);
      }
    }
  });
test("public Responses uses real always-on serializer capture, blocked dispatch and owned raw tail", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "responses-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = new FileTraceStore(directory);
  let tail!: ReadableStreamDefaultController<Uint8Array>;
  let body = "";
  const adapter = observeModelWithTrace(
    new OpenAiResponsesModel({
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-secret",
      fetch: async (_url, init) => {
        body = String(init?.body);
        return new Response(
          new ReadableStream({
            start(controller) {
              tail = controller;
              controller.enqueue(Buffer.from(terminal));
            },
          }),
        );
      },
    }),
    trace,
  );
  let ended!: () => void;
  const eof = new Promise<void>((resolve) => (ended = resolve));
  await collect(adapter, {
    ...request(),
    onTransport(event) {
      if (event.type === "response_end") ended();
    },
  });
  let records = (await trace.read("thread")).records;
  const prepared = records.find((record) => record.type === "model_request")!;
  assert.equal(
    Buffer.from(
      await trace.readArtifact(prepared.artifacts[0]!.ref),
    ).toString(),
    body,
  );
  assert(records.some((record) => record.type === "model_sample_finished"));
  assert(!records.some((record) => record.type === "model_response_end"));
  tail.enqueue(Buffer.from("raw tail password=not-redacted"));
  tail.close();
  await eof;
  await closeModelTrace(trace);
  records = (await new FileTraceStore(directory).read("thread")).records;
  const chunks = records.filter(
    (record) => record.type === "model_response_chunk",
  );
  assert.equal(
    Buffer.concat(
      await Promise.all(
        chunks.map((record) => trace.readArtifact(record.artifacts[0]!.ref)),
      ),
    ).toString(),
    terminal + "raw tail password=not-redacted",
  );
  assert(
    records.some(
      (record) =>
        record.type === "model_response_end" &&
        (record.data as { completeness: string }).completeness === "complete",
    ),
  );
  let dispatched = 0,
    allowed = true;
  const blocked = observeModelWithTrace(
    new OpenAiResponsesModel({
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-secret",
      fetch: async () => {
        dispatched++;
        return new Response(terminal);
      },
    }),
    trace,
  );
  await assert.rejects(
    collect(blocked, {
      ...request(),
      assertDispatchAllowed() {
        if (!allowed) throw new Error("revoked");
      },
      onTransport(event) {
        if (event.type === "request") allowed = false;
      },
    }),
    /revok/,
  );
  assert.equal(dispatched, 0);
  assert(
    (await trace.read("thread")).records.some(
      (record) => record.type === "model_dispatch_blocked",
    ),
  );
});
