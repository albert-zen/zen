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
test("no Trace retains synchronous executor launch; durable result files use ordinary shell reads", async (t) => {
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
  assert(receipt.resultFile);
  const shell = new ShellToolRuntime();
  const read = await shell.execute({
    ...invocation("shell"),
    // Synthetic owned artifact read: exercise the real shell, not OS containment.
    // CI need not install bwrap; production sandbox policy is unchanged.
    sandbox: "danger-full-access",
    arguments: { command: `cat ${JSON.stringify(receipt.resultFile.path)}` },
  });
  assert.equal(JSON.parse(read.output).output, "password token literal");
  assert.equal(receipt.resultFile.previewTruncated, false);
  assert.equal(receipt.resultFile.sourceTruncated, false);
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
  const cold = new FileTraceStore(directory);
  const observed = (await cold.read("thread")).records.find(
    (r) => r.type === "tool_result_observed",
  )!;
  assert.deepEqual(
    Buffer.from(await bytes(cold, observed, "media_0")),
    Buffer.from(media),
  );
  const chunk = (await cold.read("thread")).records.find(
    (r) => r.type === "tool_output_chunk",
  )!;
  assert.deepEqual(
    Buffer.from(await bytes(cold, chunk, "tool_output")),
    Buffer.from([0, 255, 1, 2, 3]),
  );
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

test("Environment binds one Trace owner without special reader plumbing", async (t) => {
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
  const prepared = env.prepare(invocation());
  assert.equal("modelTraceInspectionTool" in prepared.invocation, false);
  env.discard(prepared);
});

test("raw returned value is snapshotted before awaiting pending output persistence", async (t) => {
  const { trace } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = true;
  const writer: RuntimeTrace = {
    async record(event) {
      if (held && event.type === "tool_output_chunk") {
        held = false;
        await gate;
      }
      return trace.record(event);
    },
  };
  const sink = createToolTraceCapture(writer, {
    threadId: "thread",
    callId: "call",
  });
  const pending = sink.write("stdout", "pending");
  const raw = {
    output: "at return",
    exitCode: 0,
    contentType: "fixture/value",
    structuredContent: { value: "original" },
  };
  const result = sink.recordResult(raw, "returned");
  raw.output = "mutated later";
  raw.structuredContent.value = "changed";
  release();
  await pending;
  await result;
  const observed = (await trace.read("thread")).records.find(
    (record) => record.type === "tool_result_observed",
  )!;
  assert.equal(
    deserialize(await bytes(trace, observed, "raw_result")).output,
    "at return",
  );
  assert.equal(
    JSON.parse(
      Buffer.from(await bytes(trace, observed, "result_json")).toString(),
    ).structuredContent.value,
    "original",
  );
});

test("local readable result files distinguish upstream truncation, capture loss and unavailable storage", async (t) => {
  const { trace } = await fixture(t);
  const sink = createToolTraceCapture(
    trace,
    { threadId: "thread", callId: "received" },
    { maxPendingBytes: 1 },
  );
  await sink.write("stdout", "not retained");
  const raw = {
    output: "received bytes only",
    exitCode: 0,
    sourceTruncated: true,
  };
  const receipt = await sink.recordResult(raw, "remote-received");
  assert.equal(receipt.durability, "degraded");
  assert(receipt.resultFile);
  assert.equal(receipt.resultFile.sourceTruncated, true);
  assert.equal(receipt.resultFile.captureComplete, false);
  const read = await new ShellToolRuntime().execute({
    ...invocation("shell"),
    // Synthetic owned artifact read: exercise the real shell, not OS containment.
    // CI need not install bwrap; production sandbox policy is unchanged.
    sandbox: "danger-full-access",
    arguments: { command: `cat ${JSON.stringify(receipt.resultFile.path)}` },
  });
  assert.deepEqual(JSON.parse(read.output), raw);
  const failed = createToolTraceCapture(
    {
      record: async () => ({
        durability: "degraded",
        error: "synthetic disk full",
      }),
    },
    { threadId: "thread", callId: "failed" },
  );
  assert.equal(
    (await failed.recordResult(raw, "received")).resultFile,
    undefined,
  );
});

test("non-JSON returned values have a shell-readable inspection view without claiming lossless JSON", async (t) => {
  const { trace } = await fixture(t);
  const sink = createToolTraceCapture(trace, {
    threadId: "thread",
    callId: "circular",
  });
  const raw: Record<string, unknown> = {
    output: "original",
    exitCode: 0,
    count: 123n,
  };
  raw.self = raw;
  const receipt = await sink.recordResult(raw, "returned");
  assert(receipt.resultFile);
  assert.equal(receipt.resultFile.mediaType, "text/plain");
  const read = await new ShellToolRuntime().execute({
    ...invocation("shell"),
    // Synthetic owned artifact read: exercise the real shell, not OS containment.
    // CI need not install bwrap; production sandbox policy is unchanged.
    sandbox: "danger-full-access",
    arguments: { command: `cat ${JSON.stringify(receipt.resultFile.path)}` },
  });
  assert.match(read.output, /123n/);
  assert.match(read.output, /Circular/);
});
