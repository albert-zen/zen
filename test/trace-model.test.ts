import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileTraceStore, type RuntimeTrace } from "../src/trace.js";
import {
  observeModelWithTrace,
  closeModelTrace,
  recordModelTransport,
} from "../src/trace-model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import type { ModelRequest } from "../src/model.js";
const request = (): ModelRequest => ({
  model: "synthetic",
  reasoningEffort: "high",
  maxOutputTokens: 64,
  messages: [{ role: "user", text: '{"password":"keep-secretlike-text"}' }],
  tools: [],
  signal: new AbortController().signal,
  sessionId: "thread",
  debugContext: {
    threadId: "thread",
    turnId: "turn",
    sampleId: "sample",
    purpose: "turn",
    contextBoundaryItemId: "input",
    sampleAttempt: 1,
    configuration: {
      cwd: "synthetic",
      sandbox: "read-only",
      approvalPolicy: "always",
    },
    selectedItemIds: ["input"],
  },
});
const raw =
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"exposed only","content":"password=synthetic-key"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
test("always-on real serializer writes exact input before dispatch and raw bytes remain readable after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-model-"));
  try {
    const trace = new FileTraceStore(root);
    let body = "";
    const adapter = new OpenAiCompatibleModel({
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-key",
      defaultParams: { password: "not-auth", token: "keep" },
      fetch: async (_url, init) => {
        body = String(init?.body);
        const record = (
          await new FileTraceStore(root).read("thread")
        ).records.find((r) => r.type === "model_request")!;
        assert.equal(
          Buffer.from(
            await trace.readArtifact(record.artifacts[0]!.ref),
          ).toString(),
          body,
        );
        return new Response(raw);
      },
    });
    const model = observeModelWithTrace(adapter, trace);
    assert.equal(observeModelWithTrace(model, trace), model);
    assert.equal(observeModelWithTrace(adapter, trace), model);
    const events = [];
    for await (const event of model.stream(request())) events.push(event);
    await closeModelTrace(trace);
    await trace.flush();
    const reader = new FileTraceStore(root),
      read = await reader.read("thread");
    assert.equal(read.completeness, "complete");
    assert.equal(
      read.records.filter((r) => r.type === "model_request").length,
      1,
    );
    assert.equal(
      read.records.filter((r) => r.type === "model_request_dispatched").length,
      1,
    );
    assert.equal(
      read.records.filter((r) => r.type === "model_input").length,
      0,
    );
    const record = read.records.find((r) => r.type === "model_request")!;
    assert.deepEqual((record.data as any).omittedHeaders, ["authorization"]);
    assert.match(body, /not-auth/u);
    assert.ok(!JSON.stringify(record.data).includes("synthetic-key"));
    const chunks = await Promise.all(
      read.records
        .filter((r) => r.type === "model_response_chunk")
        .map((r) => reader.readArtifact(r.artifacts[0]!.ref)),
    );
    assert.equal(Buffer.concat(chunks).toString(), raw);
    assert.ok(
      events.some(
        (e) => e.type === "text_delta" && e.delta.includes("synthetic-key"),
      ),
    );
    const start = read.records.find((r) => r.type === "model_sample_started")!,
      end = read.records.find((r) => r.type === "model_sample_finished")!;
    assert.equal((start.data as any).maxOutputTokens, 64);
    assert.deepEqual((start.data as any).selectedItemIds, ["input"]);
    assert.equal((end.data as any).outcome, "completed");
    assert.match((end.data as any).elapsedNs, /^[0-9]+$/u);
    assert.equal(end.clock.domain, start.clock.domain);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Host shutdown owns post-terminal tail without blocking model completion or pretending EOF", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-tail-"));
  try {
    const trace = new FileTraceStore(root);
    let cancelled = false;
    const model = observeModelWithTrace(
      new OpenAiCompatibleModel({
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: "synthetic",
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from(raw));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      }),
      trace,
    );
    for await (const _event of model.stream(request())) {
    }
    const before = await trace.read("thread");
    assert.equal(
      (
        before.records.find((r) => r.type === "model_sample_finished")
          ?.data as any
      ).outcome,
      "completed",
    );
    assert.ok(
      before.records.some((r) => r.type === "model_response_drain_started"),
    );
    assert.equal(
      before.records.some((r) => r.type === "model_response_end"),
      false,
    );
    await closeModelTrace(trace);
    assert.equal(cancelled, true);
    const after = await new FileTraceStore(root).read("thread");
    const end = after.records.find((r) => r.type === "model_response_end");
    assert.equal((end?.data as any).completeness, "interrupted");
    assert.equal((end?.data as any).reason, "host_shutdown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("raw partial stream error remains evidence with a failed sample", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-error-"));
  try {
    const trace = new FileTraceStore(root);
    let pulls = 0;
    const partial = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
    const model = observeModelWithTrace(
      new OpenAiCompatibleModel({
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: "synthetic",
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (pulls++ === 0) controller.enqueue(Buffer.from(partial));
                else controller.error(new Error("synthetic read failure"));
              },
            }),
          ),
      }),
      trace,
    );
    await assert.rejects(async () => {
      for await (const _event of model.stream(request())) {
      }
    });
    const records = (await trace.read("thread")).records;
    assert.ok(records.some((r) => r.type === "model_transport_error"));
    assert.equal(
      (records.find((r) => r.type === "model_sample_finished")?.data as any)
        .outcome,
      "failed",
    );
    assert.equal(
      (records.find((r) => r.type === "model_response_end")?.data as any)
        .completeness,
      "interrupted",
    );
    assert.equal(
      Buffer.from(
        await trace.readArtifact(
          records.find((r) => r.type === "model_response_chunk")!.artifacts[0]!
            .ref,
        ),
      ).toString(),
      partial,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("capture failure warnings are bounded per continuous writer episode, not fewer attempted records", async () => {
  const original = console.error;
  const warnings: unknown[] = [];
  console.error = (...args) => {
    warnings.push(args);
  };
  let healthy = false,
    count = 0;
  const trace: RuntimeTrace = {
    record: async () => {
      count++;
      return healthy
        ? {
            durability: "durable",
            recordId: "synthetic",
            sequence: count,
            sync: "file",
          }
        : { durability: "degraded", error: `different ${count}` };
    },
  };
  const event = {
    type: "response_end" as const,
    captureLayer: "fetch-response-body" as const,
    transportAttempt: 1,
    completeness: "complete" as const,
    bytes: 0,
    chunks: 0,
    offset: 0,
  };
  try {
    for (let i = 0; i < 100; i++)
      await recordModelTransport(trace, { threadId: "thread" }, event);
    assert.equal(warnings.length, 1);
    healthy = true;
    await recordModelTransport(trace, { threadId: "thread" }, event);
    healthy = false;
    await recordModelTransport(trace, { threadId: "thread" }, event);
    assert.equal(warnings.length, 2);
    assert.equal(count, 102);
  } finally {
    console.error = original;
  }
});

test("first content observations are nonempty exposed events with exact transport attempt", async () => {
  const records: import("../src/trace.js").TraceEvent[] = [];
  const trace: RuntimeTrace = {
    async record(event) {
      records.push(event);
      return {
        durability: "durable",
        recordId: String(records.length),
        sequence: records.length,
        sync: "file",
      };
    },
  };
  const model = observeModelWithTrace(
    {
      provider: "synthetic",
      async *stream(input) {
        await input.onTransport?.({
          type: "request_dispatched",
          captureLayer: "fetch-invocation",
          transportAttempt: 2,
        });
        yield { type: "text_delta", delta: "" };
        yield {
          type: "reasoning_content_delta",
          reasoningId: "reason",
          delta: "exposed",
        };
        yield {
          type: "reasoning_summary_delta",
          reasoningId: "reason",
          delta: "summary",
        };
        yield { type: "text_delta", delta: "visible" };
        yield {
          type: "reasoning",
          reasoningContent: "opaque continuation",
          contentVisibility: "opaque",
        };
      },
    },
    trace,
  );
  for await (const _event of model.stream(request())) {
    /* consume synthetic adapter */
  }
  const observed = records
    .filter((r) => r.type === "model_event")
    .map((r) => r.data as Record<string, unknown>);
  assert(observed.every((r) => r.transportAttempt === 2));
  assert.deepEqual(
    observed.map((r) => [r.exposedText, r.exposedReasoning, r.exposedSummary]),
    [
      [false, false, false],
      [false, true, false],
      [false, false, true],
      [true, false, false],
      [false, false, false],
    ],
  );
});
