import assert from "node:assert/strict";
import test from "node:test";
import { CodeRuntime } from "../src/code-runtime.js";
import { programToolResult } from "../src/code-runtime-output.js";
import {
  trustedModelReferenceBindings,
  type ModelReferenceBinding,
} from "../src/model-references.js";
import { ToolEnvironment, type ToolExecutionResult } from "../src/tool.js";
import { testToolRuntime } from "./tool-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function invocation(
  name: string,
  source: string,
  args: Record<string, unknown> = {},
  history: readonly ModelReferenceBinding[] = [],
) {
  return {
    name,
    callId: source,
    canonicalToolCallId: source,
    arguments: args,
    modelReferences: history,
    cwd: process.cwd(),
    threadId: "accepted-thread",
    signal: new AbortController().signal,
  };
}

test("consumed task receipts reserve their t number before a later canonical result commit", async () => {
  const releases = [
    deferred<ToolExecutionResult>(),
    deferred<ToolExecutionResult>(),
  ];
  let dispatched = 0;
  const env = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 1 },
    runtimes: [
      testToolRuntime({
        name: "hold",
        executionMode: "parallel_safe",
        execute: async () => releases[dispatched++]!.promise,
      }),
    ],
  });
  try {
    const first = await env.execute(
      env.prepare(invocation("hold", "accepted-first")),
    );
    const binding = trustedModelReferenceBindings(first)![0]!;
    assert.equal(binding.ref, "t1");
    releases[0]!.resolve({
      output: "first exact result",
      exitCode: 0,
      contentType: "fixture/result",
      structuredContent: { task_id: "literal nested task field" },
    });
    const completed = await env.execute(
      env.prepare(
        invocation(
          "wait",
          "accepted-wait",
          { task_id: "t1", yield_time_ms: 100 },
          [binding],
        ),
      ),
    );
    assert.match(completed.output, /first exact result/u);
    const program = await programToolResult(completed);
    assert.equal(
      (program.structuredContent as { task_id: string }).task_id,
      "t1",
    );
    assert.deepEqual(
      (program.structuredContent as { result: unknown }).result,
      { task_id: "literal nested task field" },
    );
    const native = (first.structuredContent as { task_id: string }).task_id;
    assert.throws(
      () => env.taskManager.status("accepted-thread", native),
      /not found/u,
    );
    // Another preparation may hold the pre-commit history snapshot. The manager
    // has already removed the old task, but must not reissue its visible handle.
    const second = await env.execute(
      env.prepare(invocation("hold", "accepted-second", {}, [])),
    );
    assert.equal(trustedModelReferenceBindings(second)![0]!.ref, "t2");
    await assert.rejects(
      env.execute(
        env.prepare(
          invocation(
            "wait",
            "accepted-stale-wait",
            { task_id: "t1", yield_time_ms: 1 },
            [binding],
          ),
        ),
      ),
      /not found/u,
    );
    assert.equal(
      (second.structuredContent as { status: string }).status,
      "running",
    );
    assert.equal(dispatched, 2);
  } finally {
    for (const release of releases)
      release.resolve({ output: "cleanup", exitCode: 0 });
    await env.close();
  }
});

test("actual compiled Worker sees distinct short task fields, never host provenance, and literal stdout stays exact", async () => {
  const releases = [
    deferred<ToolExecutionResult>(),
    deferred<ToolExecutionResult>(),
  ];
  const literal =
    'Literal task_id: 12345678-1234-1234-1234-123456789abc /tmp/unchanged.ts {"ref":"t1"}';
  const env = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 1 },
    runtimes: [
      testToolRuntime({
        name: "hold",
        executionMode: "parallel_safe",
        execute: async (call) => {
          call.taskContext?.onOutput(literal);
          return await releases[Number(call.arguments.index)]!.promise;
        },
      }),
    ],
  });
  const native: ToolExecutionResult[] = [];
  let calls = 0;
  try {
    const output = await new CodeRuntime().execute({
      code: "const results = await Promise.all([tools.hold({index:0}), tools.hold({index:1})]); for (const result of results) text(result);",
      signal: new AbortController().signal,
      nested: {
        async invoke(name, args) {
          const result = await env.execute(
            env.prepare(invocation(name, `accepted-child-${++calls}`, args)),
          );
          native.push(result);
          return result;
        },
      },
    });
    const rows = output.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.structuredContent.task_id).sort(), [
      "t1",
      "t2",
    ]);
    for (const row of rows) {
      assert.equal(row.output, literal);
      assert.equal(row.outputInfo.complete, true);
      assert.equal(row.referenceBindings, undefined);
      assert.match(row.diagnostic, /task_id: t[12]/u);
      assert.doesNotMatch(
        JSON.stringify(row),
        /ownerThreadId|sourceToolCallId|builtin-task|accepted-thread/u,
      );
    }
    assert.equal(
      new Set(
        native.map(
          (result) => (result.structuredContent as { task_id: string }).task_id,
        ),
      ).size,
      2,
    );
    for (const result of native) {
      const binding = trustedModelReferenceBindings(result)![0]!;
      assert.equal(
        (binding.value as { taskId: string }).taskId,
        (result.structuredContent as { task_id: string }).task_id,
      );
      assert.ok(
        !output.text.includes(
          (result.structuredContent as { task_id: string }).task_id,
        ),
      );
    }
  } finally {
    for (const release of releases)
      release.resolve({ output: "cleanup", exitCode: 0 });
    await env.close();
  }
});
