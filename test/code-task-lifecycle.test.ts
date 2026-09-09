import assert from "node:assert/strict";
import test from "node:test";
import { ToolEnvironment, type CompositeToolRuntime } from "../src/tool.js";

const invocation = (name: string, args: Record<string, unknown> = {}) => ({
  callId: name,
  name,
  arguments: args,
  cwd: process.cwd(),
  threadId: "thread",
  signal: new AbortController().signal,
});

test("program-side awaits get the real child result instead of a running receipt", async (t) => {
  const env = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 1 },
    runtimes: [
      {
        name: "child",
        specification: { name: "child", description: "child", inputSchema: {} },
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { output: "actual-final", exitCode: 7 };
        },
      },
    ],
  });
  t.after(() => env.close());
  const result = await env.execute(
    env.prepare({ ...invocation("child"), task: { waitForCompletion: true } }),
  );
  assert.deepEqual(result, { output: "actual-final", exitCode: 7 });
  assert.equal(env.taskManager.activeTaskCount, 0);
});

test("explicit program yield flushes output without completing the runner", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const code: CompositeToolRuntime = {
    name: "run_code",
    specification: { name: "run_code", description: "code", inputSchema: {} },
    async execute() {
      throw new Error("wrong entry");
    },
    async executeComposite(call) {
      call.taskContext?.onOutput("ready");
      call.taskContext?.requestYield?.();
      await gate;
      return { output: "finished", exitCode: 0 };
    },
  };
  const env = new ToolEnvironment({
    runtimes: [code],
    taskOptions: { yieldTimeMs: 1000 },
  });
  t.after(() => env.close());
  const first = await env.execute(env.prepare(invocation("run_code")), {
    invoke: async () => ({ output: "", exitCode: 0 }),
  });
  assert.match(first.output, /ready/);
  assert.equal(
    (first.structuredContent as { status: string }).status,
    "running",
  );
  release();
  const final = await env.waitRuntime.execute(
    invocation("wait", {
      task_id: (first.structuredContent as { task_id: string }).task_id,
    }),
  );
  assert.match(final.output, /finished/);
});

test("a composite uses the same incremental wait lifecycle as an ordinary tool", async (t) => {
  const code: CompositeToolRuntime = {
    name: "run_code",
    specification: {
      name: "run_code",
      description: "code",
      inputSchema: { type: "object" },
    },
    taskPolicy: {
      resourceScope: "independent",
      cancellation: "confirmed-on-settle",
    },
    async execute() {
      throw new Error("composite entry required");
    },
    async executeComposite(call) {
      call.taskContext?.onOutput("before\n");
      await new Promise((resolve) => setTimeout(resolve, 40));
      call.taskContext?.onOutput("after\n");
      return { output: "", exitCode: 0 };
    },
  };
  const env = new ToolEnvironment({
    runtimes: [code],
    taskOptions: { yieldTimeMs: 1 },
  });
  t.after(() => env.close());
  const first = await env.execute(env.prepare(invocation("run_code")), {
    invoke: async () => {
      throw new Error("unused");
    },
  });
  assert.equal(
    (first.structuredContent as { status: string }).status,
    "running",
  );
  assert.match(first.output, /before/);
  const final = await env.waitRuntime.execute(
    invocation("wait", {
      task_id: (first.structuredContent as { task_id: string }).task_id,
      yield_time_ms: 200,
    }),
  );
  assert.match(final.output, /after/);
  assert.doesNotMatch(final.output, /before/);
  assert.equal(
    (final.structuredContent as { status: string }).status,
    "completed",
  );
});
