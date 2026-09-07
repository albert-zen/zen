import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModelDiagnosticWriter } from "../apps/cli/src/model-diagnostics.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";

const request = {
  model: "qwen-test",
  reasoningEffort: null,
  messages: [],
  tools: [
    { name: "shell", description: "test", inputSchema: { type: "object" } },
  ],
  signal: new AbortController().signal,
  sessionId: "thread-test",
};
const badStream = () =>
  new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"private answer"}}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":2,"id":{"secret":"private argument"}}]}}]}\n\n',
    { headers: { "x-request-id": "provider-request-123" } },
  );

test("stream protocol failure persists diagnostic metadata without response content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-diagnostic-"));
  try {
    const model = new OpenAiCompatibleModel({
      baseUrl: "https://provider.test/v1",
      apiKey: "private-key",
      fetch: async () => badStream(),
      onStreamFailure: createModelDiagnosticWriter(directory),
    });
    await assert.rejects(async () => {
      for await (const _event of model.stream(request)) {
        /* consume */
      }
    }, /invalid tool call id/u);
    const filename = path.join(directory, "model-stream-errors.jsonl");
    const raw = await readFile(filename, "utf8");
    const record = JSON.parse(raw);
    assert.equal(record.sessionId, "thread-test");
    assert.equal(record.requestId, "provider-request-123");
    assert.equal(record.payloadIndex, 2);
    assert.equal(record.field, "tool_calls.id");
    assert.equal(record.valueType, "object");
    assert.equal(record.toolIndex, 2);
    assert.equal(record.status, 200);
    assert.match(record.diagnosticId, /^[0-9a-f-]{36}$/u);
    assert.doesNotMatch(raw, /private answer|private argument|private-key/u);
    if (process.platform !== "win32")
      assert.equal((await stat(filename)).mode & 0o777, 0o600);

    const write = createModelDiagnosticWriter(directory);
    await writeFile(filename, "x".repeat(5 * 1024 * 1024));
    await Promise.all([write(record), write(record)]);
    assert.equal(
      (await readFile(filename, "utf8")).trim().split("\n").length,
      2,
    );
    assert.equal((await stat(filename + ".1")).size, 5 * 1024 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic sink failure does not replace the original model failure", async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: "private-key",
    fetch: async () => badStream(),
    onStreamFailure: async () => {
      throw new Error("disk unavailable");
    },
  });
  await assert.rejects(async () => {
    for await (const _event of model.stream(request)) {
      /* consume */
    }
  }, /invalid tool call id/u);
});

test("diagnostics cover missing body and malformed stream envelopes", async () => {
  const cases: Array<[Response, string, string]> = [
    [new Response(null), "response.body", "null"],
    [new Response("data: {bad\n\n"), "payload", "string"],
    [new Response('data: {"choices":{}}\n\n'), "choices", "object"],
    [
      new Response('data: {"choices":[{"delta":{"content":7}}]}\n\n'),
      "choices[].delta.content",
      "number",
    ],
    [
      new Response('data: {"choices":[],"usage":false}\n\n'),
      "usage",
      "boolean",
    ],
    [
      new Response('data: {"choices":[{"finish_reason":3}]}\n\n'),
      "choices[].finish_reason",
      "number",
    ],
  ];
  for (const [response, field, valueType] of cases) {
    const records: Array<{ field?: string; valueType?: string }> = [];
    const model = new OpenAiCompatibleModel({
      baseUrl: "https://provider.test/v1",
      apiKey: "private-key",
      fetch: async () => response,
      onStreamFailure: async (event) => {
        records.push(event);
      },
    });
    await assert.rejects(async () => {
      for await (const _event of model.stream(request)) {
        /* consume */
      }
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.field, field);
    assert.equal(records[0]?.valueType, valueType);
  }
});
