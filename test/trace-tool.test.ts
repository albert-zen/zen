import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deserialize } from "node:v8";
import {
  FileTraceStore,
  type TraceRecord,
  type RuntimeTrace,
} from "../src/trace.js";
import {
  createToolTraceCapture,
  readKnownToolResult,
  TraceReadToolRuntime,
} from "../src/trace-tool.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  normalizeToolExecutionResult,
  type ToolInvocation,
} from "../src/tool.js";
import { ToolOutputSpool } from "../src/tool-output-spool.js";
import {
  attachModelReferenceBindings,
  trustedModelReferenceBindings,
} from "../src/model-references.js";
import { testToolRuntime } from "./tool-fixtures.js";
const invocation = (name = "test"): ToolInvocation => ({
  name,
  callId: "call",
  canonicalToolCallId: "item",
  threadId: "thread",
  cwd: process.cwd(),
  arguments: {},
  signal: new AbortController().signal,
  outputAudience: "program",
});
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-tool-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, trace: new FileTraceStore(directory) };
}
async function bytes(trace: FileTraceStore, record: TraceRecord, name: string) {
  const artifact = record.artifacts.find((entry) => entry.name === name);
  assert(artifact);
  return await trace.readArtifact(artifact.ref);
}
test("full returned value precedes normalization failure; accepted-only recovery never replays unknown or imported results", async (t) => {
  const { trace, directory } = await fixture(t);
  const huge = "密码token\u0000".repeat(100000);
  const raw = {
    output: huge,
    exitCode: 0,
    contentType: "fixture/value",
    structuredContent: { large: "x".repeat(1024 * 1024 + 10) },
  };
  const env = new ToolEnvironment({
    trace,
    runtimes: [testToolRuntime({ name: "test", execute: async () => raw })],
  });
  t.after(() => env.close());
  await assert.rejects(env.execute(env.prepare(invocation())), /byte limit/);
  const records = (await trace.read("thread")).records;
  const observed = records.find(
    (record) => record.type === "tool_result_observed",
  );
  assert(observed);
  assert.deepEqual(
    deserialize(await bytes(trace, observed, "raw_result")),
    raw,
  );
  assert.equal(
    await readKnownToolResult(trace, "thread", "call", "item"),
    undefined,
  );
  const capture = createToolTraceCapture(trace, {
    threadId: "thread",
    callId: "call",
    toolCallItemId: "item",
  });
  await capture.recordAcceptedResult({ output: "accepted exact", exitCode: 7 });
  assert.deepEqual(
    await readKnownToolResult(
      new FileTraceStore(directory),
      "thread",
      "call",
      "item",
    ),
    { output: "accepted exact", exitCode: 7 },
  );
  assert.equal(
    await readKnownToolResult(trace, "thread", "call", "other"),
    undefined,
  );
  await trace.importRecords(
    "fork",
    (await trace.read("thread")).records,
    trace,
  );
  assert.equal(
    await readKnownToolResult(trace, "fork", "call", "item"),
    undefined,
  );
});
test("real shell captures binary pipes before small model spool and survives spool shutdown", async (t) => {
  const { trace, directory } = await fixture(t);
  const spool = new ToolOutputSpool({ previewBytes: 16, maxCaptureBytes: 32 });
  const shell = new ShellToolRuntime({
    toolOutputSpool: spool,
    maxOutputBytes: 32,
  });
  const env = new ToolEnvironment({
    trace,
    toolOutputSpool: spool,
    runtimes: [shell],
  });
  const value = {
    ...invocation("shell"),
    outputAudience: "model" as const,
    arguments: {
      command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.from([255,0,226,130,172]));process.stdout.write("A".repeat(200000));process.stderr.write("stderr")'`,
    },
    task: { waitForCompletion: true },
  };
  try {
    const result = await env.execute(env.prepare(value));
    assert(result.output.length < 200000);
  } finally {
    await env.close();
    await spool.close();
  }
  const cold = new FileTraceStore(directory);
  const records = (await cold.read("thread")).records;
  const chunks = records.filter(
    (record) =>
      record.type === "tool_output_chunk" &&
      (record.data as { source: string }).source === "stdout",
  );
  const actual = Buffer.concat(
    await Promise.all(
      chunks.map((record) => bytes(cold, record, "tool_output")),
    ),
  );
  assert.deepEqual(
    actual,
    Buffer.concat([
      Buffer.from([255, 0, 226, 130, 172]),
      Buffer.from("A".repeat(200000)),
    ]),
  );
  assert(
    records.some(
      (record) =>
        record.type === "tool_output_end" &&
        (record.data as { source: string; completeness: string }).source ===
          "stdout" &&
        (record.data as { completeness: string }).completeness === "complete",
    ),
  );
});
test("pending budget and disk failure produce explicit byte range gaps without blocking tool effects", async (t) => {
  const { trace } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const delayed: RuntimeTrace = {
    async record(event) {
      if (first) {
        first = false;
        await gate;
      }
      return trace.record(event);
    },
  };
  const sink = createToolTraceCapture(
    delayed,
    { threadId: "thread", callId: "call" },
    { maxPendingBytes: 4 },
  );
  const firstWrite = sink.write("stdout", "1234");
  await sink.write("stdout", "5678");
  release();
  await firstWrite;
  await sink.end("stdout", true);
  const records = (await trace.read("thread")).records;
  const gap = records.find((record) => record.type === "tool_output_gap");
  assert(gap);
  assert.equal((gap.data as { offset: number }).offset, 4);
  assert.equal((gap.data as { endOffset: number }).endOffset, 8);
  assert.equal(
    (
      records.find((record) => record.type === "tool_output_end")!.data as {
        completeness: string;
      }
    ).completeness,
    "incomplete",
  );
  assert.equal(
    (await sink.recordResult({ output: "bounded", exitCode: 0 }, "returned"))
      .durability,
    "degraded",
  );
});
test("reference brand survives Task normalization and rejects forged or modified payloads", async (t) => {
  const binding = {
    ref: "r1",
    ownerThreadId: "thread",
    namespace: "fixture",
    kind: "thing",
    value: "raw-id",
  };
  assert.throws(
    () =>
      normalizeToolExecutionResult(
        { output: "", exitCode: 0, referenceBindings: [binding] },
        { kind: "builtin", id: "fixture" },
      ),
    /Untrusted/,
  );
  const raw = attachModelReferenceBindings({ output: "yes", exitCode: 0 }, [
    binding,
  ]);
  const env = new ToolEnvironment({
    runtimes: [testToolRuntime({ name: "test", execute: async () => raw })],
  });
  t.after(() => env.close());
  const result = await env.execute(env.prepare(invocation()));
  assert.deepEqual(trustedModelReferenceBindings(result), [binding]);
  raw.referenceBindings[0]!.value = "forged";
  assert.throws(
    () => normalizeToolExecutionResult(raw, { kind: "builtin", id: "fixture" }),
    /Untrusted/,
  );
});
test("no Trace retains synchronous executor launch; durable trace_read only resolves own immutable evidence", async (t) => {
  let launched = false;
  const env = new ToolEnvironment({
    runtimes: [
      testToolRuntime({
        name: "test",
        execute: async () => {
          launched = true;
          return { output: "ok", exitCode: 0 };
        },
      }),
    ],
  });
  const result = env.execute(env.prepare(invocation()));
  assert.equal(launched, true);
  await result;
  await env.close();
  const { trace, directory } = await fixture(t);
  const sink = createToolTraceCapture(trace, {
    threadId: "thread",
    callId: "call",
    toolCallItemId: "item",
  });
  const receipt = await sink.recordResult(
    { output: "password token literal", exitCode: 0 },
    "returned",
  );
  assert.equal(receipt.durability, "durable");
  if (receipt.durability !== "durable") return;
  const reader = new TraceReadToolRuntime(new FileTraceStore(directory));
  const request = {
    ...invocation("trace_read"),
    arguments: { ref: "r1", offset: 0, limit: 5 },
    modelReferences: [
      {
        ref: "r1",
        ownerThreadId: "thread",
        namespace: "trace",
        kind: "tool-result",
        value: { locator: receipt.locator, tool: "trace_read" },
      },
    ],
  };
  const page = JSON.parse((await reader.execute(request)).output);
  assert.equal(Buffer.from(page.data, "base64").toString(), '{"out');
  assert.equal(page.eof, false);
  await assert.rejects(
    reader.execute({ ...request, threadId: "other" }),
    /Unknown/,
  );
  await assert.rejects(
    reader.execute({ ...request, arguments: { ref: "r1", limit: 100000 } }),
    /range/,
  );
});

test("retained media and exact source pages outlive original attachment store; incomplete capture makes no durable locator claim", async (t) => {
  const { trace, directory } = await fixture(t);
  const { InMemoryAttachmentStore } = await import("../src/attachment.js");
  const { png1x1 } = await import("./fixtures.js");
  let attachments: InstanceType<typeof InMemoryAttachmentStore> | undefined =
    new InMemoryAttachmentStore();
  const media = png1x1(),
    attachment = await attachments.importBytes(media, "image/png");
  const sink = createToolTraceCapture(
    trace,
    { threadId: "thread", callId: "call", toolCallItemId: "item" },
    { attachments },
  );
  await sink.write("stdout", Buffer.from([0, 255, 1, 2, 3]));
  await sink.end("stdout", true);
  const receipt = await sink.recordResult(
    {
      output: "preview",
      exitCode: 0,
      modelContent: [{ type: "image", attachment }],
    },
    "result",
  );
  assert.equal(receipt.durability, "durable");
  if (receipt.durability !== "durable") return;
  attachments = undefined;
  const cold = new FileTraceStore(directory),
    reader = new TraceReadToolRuntime(cold);
  const request: ToolInvocation = {
    ...invocation("trace_read"),
    modelReferences: [
      {
        ref: "r1",
        ownerThreadId: "thread",
        namespace: "trace",
        kind: "tool-result",
        value: { locator: receipt.locator, tool: "trace_read" },
      },
    ],
    arguments: { ref: "r1", source: "stdout", offset: 1, limit: 3 },
  };
  const page = JSON.parse((await reader.execute(request)).output);
  assert.deepEqual(
    Buffer.from(page.pages[0].data, "base64"),
    Buffer.from([255, 1, 2]),
  );
  const read = JSON.parse(
    (
      await reader.execute({
        ...request,
        arguments: { ref: "r1", artifact: "media_0", limit: 65536 },
      })
    ).output,
  );
  assert.deepEqual(Buffer.from(read.data, "base64"), Buffer.from(media));
  const missing = createToolTraceCapture(trace, {
    threadId: "thread",
    callId: "missing",
  });
  assert.equal(
    (
      await missing.recordResult(
        {
          output: "",
          exitCode: 0,
          modelContent: [{ type: "image", attachment }],
        },
        "result",
      )
    ).durability,
    "degraded",
  );
});
test("disk failure during stream is explicit and accepted-result recovery refuses corrupted artifacts", async (t) => {
  const { trace, directory } = await fixture(t);
  let fail = true;
  const writer: RuntimeTrace = {
    async record(event) {
      if (fail && event.type === "tool_output_chunk")
        return { durability: "degraded", error: "synthetic disk full" };
      return trace.record(event);
    },
  };
  const sink = createToolTraceCapture(writer, {
    threadId: "thread",
    callId: "call",
    toolCallItemId: "item",
  });
  await sink.write("stdout", "raw lost");
  fail = false;
  await sink.end("stdout", true);
  assert(
    (await trace.read("thread")).records.some(
      (record) =>
        record.type === "tool_output_gap" &&
        (record.data as { reason: string }).reason === "synthetic disk full",
    ),
  );
  await sink.recordAcceptedResult({ output: "known", exitCode: 0 });
  const record = (await trace.read("thread")).records.find(
    (record) => record.type === "tool_result_accepted",
  )!;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(directory, "artifacts", record.artifacts[0]!.ref.sha256),
    "corrupt",
  );
  assert.equal(
    await readKnownToolResult(trace, "thread", "call", "item"),
    undefined,
  );
});

test("Environment binds one Trace owner and advertises only its real registered reader", async (t) => {
  const { trace } = await fixture(t);
  const env = new ToolEnvironment({
    runtimes: [
      testToolRuntime({
        name: "test",
        execute: async () => ({ output: "ok", exitCode: 0 }),
      }),
    ],
  });
  t.after(() => env.close());
  env.bindTrace(trace);
  env.bindTrace(trace);
  assert.throws(
    () => env.bindTrace({ record: (event) => trace.record(event) }),
    /different Trace owner/,
  );
  const before = env.prepare({
    ...invocation(),
    modelTraceInspectionTool: "trace_read",
  });
  assert.equal(before.invocation.modelTraceInspectionTool, undefined);
  env.discard(before);
  env.registerRuntime(new TraceReadToolRuntime(trace));
  const after = env.prepare(invocation());
  assert.equal(after.invocation.modelTraceInspectionTool, "trace_read");
  env.discard(after);
});
