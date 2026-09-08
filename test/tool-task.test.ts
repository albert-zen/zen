import assert from "node:assert/strict";
import test from "node:test";
import { ToolEnvironment, type ToolRuntime } from "../src/tool.js";
const invocation = (name: string, args: Record<string, unknown> = {}) => ({
  callId: "a",
  name,
  arguments: args,
  cwd: process.cwd(),
  threadId: "a",
  signal: new AbortController().signal,
});
test("ordinary slow tool yields and unified wait returns its result", async () => {
  const tool: ToolRuntime = {
    name: "slow",
    specification: {
      name: "slow",
      description: "slow",
      inputSchema: { type: "object" },
    },
    async execute() {
      await new Promise((r) => setTimeout(r, 40));
      return { output: "finished", exitCode: 0 };
    },
  };
  const env = new ToolEnvironment({
    runtimes: [tool],
    taskOptions: { yieldTimeMs: 5 },
  });
  const prepared = env.prepare(invocation("slow"));
  const first = await env.execute(prepared);
  assert.match(first.output, /task_id:/);
  assert.equal(first.contentType, "application/vnd.zen.tool-task+json");
  const taskId = (first.structuredContent as { task_id: string }).task_id;
  const last = await env.waitRuntime.execute(
    invocation("wait", { task_id: taskId, yield_time_ms: 100 }),
  );
  assert.match(last.output, /finished/);
  assert.equal(
    (last.structuredContent as { status: string }).status,
    "completed",
  );
  await env.close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function tool(
  name: string,
  execute: ToolRuntime["execute"],
  taskPolicy?: ToolRuntime["taskPolicy"],
): ToolRuntime {
  return {
    name,
    specification: { name, description: name, inputSchema: { type: "object" } },
    execute,
    ...(taskPolicy === undefined ? {} : { taskPolicy }),
  };
}
function data(result: { structuredContent?: unknown }): {
  task_id: string;
  status: string;
  exit_code: number | null;
} {
  return result.structuredContent as {
    task_id: string;
    status: string;
    exit_code: number | null;
  };
}
const done = { output: "done", exitCode: 0 };
test("unconfirmed cancellation retains resource and bundle lease until real completion", async () => {
  const pending = deferred<typeof done>();
  let released = 0;
  const body = tool("browser", async () => await pending.promise);
  const env = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 1, shutdownWaitMs: 5 },
    bundles: [
      {
        identity: { kind: "external", id: "browser" },
        tools: [body],
        retainPreparedInvocation() {
          return () => {
            released++;
          };
        },
      },
    ],
  });
  try {
    const started = await env.execute(env.prepare(invocation("browser")));
    const cancelled = await env.waitRuntime.execute(
      invocation("wait", {
        task_id: data(started).task_id,
        terminate: true,
        yield_time_ms: 1,
      }),
    );
    assert.equal(data(cancelled).status, "cancellation_unconfirmed");
    assert.equal(data(cancelled).exit_code, null);
    assert.equal(released, 0);
    await assert.rejects(
      env.execute(env.prepare(invocation("browser"))),
      /resource is busy/,
    );
    assert.equal(released, 1); // Only the rejected new prepared call released.
    pending.resolve(done);
    const completed = await env.waitRuntime.execute(
      invocation("wait", {
        task_id: data(started).task_id,
        yield_time_ms: 100,
      }),
    );
    assert.equal(data(completed).status, "completed");
    assert.equal(released, 2);
  } finally {
    pending.resolve(done);
    await env.close();
  }
});
test("abort rejection is not cancellation confirmation and cannot unlock a resource", async () => {
  const body = tool(
    "remote",
    async (call) =>
      await new Promise((_r, reject) =>
        call.signal.addEventListener("abort", () =>
          reject(new Error("stopped waiting")),
        ),
      ),
  );
  const env = new ToolEnvironment({
    runtimes: [body],
    taskOptions: { yieldTimeMs: 1, shutdownWaitMs: 5 },
  });
  const started = await env.execute(env.prepare(invocation("remote")));
  const cancelled = await env.waitRuntime.execute(
    invocation("wait", {
      task_id: data(started).task_id,
      terminate: true,
      yield_time_ms: 5,
    }),
  );
  assert.equal(data(cancelled).status, "cancellation_unconfirmed");
  await assert.rejects(
    env.execute(env.prepare(invocation("remote"))),
    /resource is busy/,
  );
  await env.close();
});
test("confirmed cancellation reports deadline separately from yielding", async () => {
  const body = tool(
    "cooperative",
    async (call) =>
      await new Promise((resolve) =>
        call.signal.addEventListener("abort", () =>
          resolve({ output: "partial", exitCode: 130 }),
        ),
      ),
    { cancellation: "confirmed-on-settle" },
  );
  const env = new ToolEnvironment({
    runtimes: [body],
    taskOptions: { yieldTimeMs: 1, timeoutMs: 15 },
  });
  try {
    const start = await env.execute(env.prepare(invocation("cooperative")));
    assert.equal(data(start).status, "running");
    const end = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 100 }),
    );
    assert.equal(data(end).status, "timed_out");
    assert.equal(end.exitCode, 124);
    assert.match(end.output, /partial/);
  } finally {
    await env.close();
  }
});
test("incremental output does not replay, and final model content remains available", async () => {
  const pending = deferred<typeof done>();
  let write!: (text: string) => void;
  const body = tool("image", async (call) => {
    write = call.taskContext!.onOutput;
    write("one");
    await pending.promise;
    return {
      output: "three",
      exitCode: 0,
      contentType: "application/json",
      structuredContent: { answer: 42 },
      modelContent: [{ type: "text", text: "image content seam" }],
    };
  });
  const env = new ToolEnvironment({
    runtimes: [body],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const start = await env.execute(env.prepare(invocation("image")));
    assert.match(start.output, /one/);
    write("two");
    const next = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id }),
    );
    assert.match(next.output, /two/);
    assert.doesNotMatch(next.output, /one/);
    pending.resolve(done);
    const final = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 100 }),
    );
    assert.match(final.output, /three/);
    assert.doesNotMatch(final.output, /two/);
    assert.deepEqual(final.modelContent, [
      { type: "text", text: "image content seam" },
    ]);
    assert.equal(
      (final.structuredContent as { result: { answer: number } }).result.answer,
      42,
    );
  } finally {
    pending.resolve(done);
    await env.close();
  }
});
test("thread ownership and running body capacity survive yield; wait bypasses both admission and capacity", async () => {
  const pending = deferred<typeof done>();
  const body = tool("slow", async () => await pending.promise, {
    resourceScope: "independent",
  });
  const env = new ToolEnvironment({
    runtimes: [body],
    taskOptions: { yieldTimeMs: 1, maxRunningTasks: 1, shutdownWaitMs: 5 },
  });
  try {
    const start = await env.execute(env.prepare(invocation("slow")));
    await assert.rejects(
      env.execute(env.prepare(invocation("slow"))),
      /capacity/,
    );
    await assert.rejects(
      env.waitRuntime.execute({
        ...invocation("wait", { task_id: data(start).task_id }),
        threadId: "other",
      }),
      /not found/,
    );
    const prepared = env.prepare(
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 1 }),
    );
    assert.equal(await env.admitInherited(prepared), "accept");
    assert.equal(data(await env.execute(prepared)).status, "running");
    pending.resolve(done);
  } finally {
    pending.resolve(done);
    await env.close();
  }
});
test("close is bounded for an uncancellable task and disposes retained resources", async () => {
  let released = 0;
  const body = tool("forever", async () => await new Promise(() => {}));
  const env = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 1, shutdownWaitMs: 5 },
    bundles: [
      {
        identity: { kind: "external", id: "forever" },
        tools: [body],
        retainPreparedInvocation() {
          return () => {
            released++;
          };
        },
      },
    ],
  });
  await env.execute(env.prepare(invocation("forever")));
  const before = Date.now();
  await env.close();
  assert(Date.now() - before < 200);
  assert.equal(released, 1);
  await assert.rejects(
    env.execute(env.prepare(invocation("forever"))),
    /closed/,
  );
});
test("fast result and failure retain their exact semantics", async () => {
  const expected = {
    output: "plain",
    exitCode: 7,
    contentType: "application/json",
    structuredContent: { a: 1 },
  };
  const env = new ToolEnvironment({
    runtimes: [
      tool("quick", async () => expected),
      tool("throws", async () => {
        throw new Error("original failure");
      }),
    ],
  });
  assert.deepEqual(
    await env.execute(env.prepare(invocation("quick"))),
    expected,
  );
  await assert.rejects(
    env.execute(env.prepare(invocation("throws"))),
    /original failure/,
  );
  await env.close();
});

test("concurrent waits never duplicate a terminal result", async () => {
  const pending = deferred<typeof done>();
  const env = new ToolEnvironment({
    runtimes: [tool("slow", async () => await pending.promise)],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const start = await env.execute(env.prepare(invocation("slow")));
    const first = env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 100 }),
    );
    const duplicate = env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 100 }),
    );
    const rejected = assert.rejects(duplicate, /already being observed/);
    pending.resolve(done);
    await rejected;
    assert.equal(data(await first).status, "completed");
  } finally {
    pending.resolve(done);
    await env.close();
  }
});

test("wait name cannot be replaced or removed by a tool bundle", async () => {
  const env = new ToolEnvironment();
  assert.throws(
    () => env.registerRuntime(tool("wait", async () => done)),
    /reserved/,
  );
  assert.throws(
    () =>
      env.stageBundle(
        { identity: { kind: "builtin", id: "wait" }, tools: [] },
        { replaceCurrent: true },
      ),
    /reserved/,
  );
  assert.equal(env.unregisterBundle({ kind: "builtin", id: "wait" }), false);
  await env.close();
});

test("authoritative nonzero completion after cancellation releases its resource", async () => {
  const pending = deferred<typeof done>();
  const env = new ToolEnvironment({
    runtimes: [tool("remote", async () => await pending.promise)],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const start = await env.execute(env.prepare(invocation("remote")));
    await env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, terminate: true }),
    );
    pending.resolve({ output: "remote failure", exitCode: 7 });
    const final = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 100 }),
    );
    assert.equal(data(final).status, "failed");
    assert.equal(final.exitCode, 7);
    assert.match(final.output, /remote failure/);
    assert.equal(
      (await env.execute(env.prepare(invocation("remote")))).exitCode,
      7,
    );
  } finally {
    pending.resolve(done);
    await env.close();
  }
});
test("fast streaming rejection preserves preceding output", async () => {
  const env = new ToolEnvironment({
    runtimes: [
      tool("broken", async (call) => {
        call.taskContext!.onOutput("before failure");
        throw new Error("specific failure");
      }),
    ],
  });
  try {
    const result = await env.execute(env.prepare(invocation("broken")));
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /before failure/);
    assert.match(result.output, /specific failure/);
  } finally {
    await env.close();
  }
});
test("wait envelope preserves a valid result at the original JSON byte limit", async () => {
  const pending = deferred<typeof done>();
  const payload = { value: "x".repeat(1024 * 1024 - 12) };
  assert.equal(Buffer.byteLength(JSON.stringify(payload)), 1024 * 1024);
  const env = new ToolEnvironment({
    runtimes: [
      tool("large", async () => {
        await pending.promise;
        return {
          output: "large",
          exitCode: 0,
          contentType: "application/json",
          structuredContent: payload,
        };
      }),
    ],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const start = await env.execute(env.prepare(invocation("large")));
    pending.resolve(done);
    const last = await env.execute(
      env.prepare(
        invocation("wait", {
          task_id: data(start).task_id,
          yield_time_ms: 100,
        }),
      ),
    );
    assert.deepEqual(
      (last.structuredContent as { result: unknown }).result,
      payload,
    );
  } finally {
    pending.resolve(done);
    await env.close();
  }
});
test("an unconfirmed local cancellation failure is reported once", async () => {
  const body = tool(
    "remote",
    async (call) =>
      await new Promise((_r, reject) =>
        call.signal.addEventListener("abort", () =>
          reject(new Error("transport stopped waiting")),
        ),
      ),
  );
  const env = new ToolEnvironment({
    runtimes: [body],
    taskOptions: { yieldTimeMs: 1, shutdownWaitMs: 1 },
  });
  try {
    const start = await env.execute(env.prepare(invocation("remote")));
    await env.waitRuntime.execute(
      invocation("wait", {
        task_id: data(start).task_id,
        terminate: true,
        yield_time_ms: 1,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const diagnostic = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 1 }),
    );
    assert.equal(data(diagnostic).status, "cancellation_unconfirmed");
    assert.match(diagnostic.output, /transport stopped waiting/);
    const next = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 1 }),
    );
    assert.doesNotMatch(next.output, /transport stopped waiting/);
  } finally {
    await env.close();
  }
});

test("concurrent cancellation stays reachable while one wait owns output", async () => {
  const body = tool(
    "cooperative",
    async (call) =>
      await new Promise((resolve) =>
        call.signal.addEventListener("abort", () =>
          resolve({ output: "stopped", exitCode: 130 }),
        ),
      ),
    { cancellation: "confirmed-on-settle" },
  );
  const env = new ToolEnvironment({
    runtimes: [body],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const start = await env.execute(env.prepare(invocation("cooperative")));
    const observing = env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 100 }),
    );
    const cancellation = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(start).task_id, terminate: true }),
    );
    assert.match(cancellation.output, /existing wait owns/);
    assert.doesNotMatch(cancellation.output, /stopped/);
    const final = await observing;
    assert.equal(data(final).status, "cancelled");
    assert.match(final.output, /stopped/);
  } finally {
    await env.close();
  }
});
test("non-shell timing controls are declared by policy and capabilities are exposed", async () => {
  const pending = deferred<typeof done>();
  const body = tool("build", async () => await pending.promise, {
    resourceScope: "independent",
    timingArguments: { yieldTimeMs: "return_after", timeoutMs: "deadline" },
  });
  const env = new ToolEnvironment({ runtimes: [body] });
  try {
    const result = await env.execute(
      env.prepare(invocation("build", { return_after: 1, deadline: 99 })),
    );
    assert.equal(data(result).status, "running");
    assert.match(result.output, /timeout_ms: 99/);
    assert.match(result.output, /cancellation: best_effort/);
    assert.match(result.output, /resource_scope: independent/);
    assert.match(result.output, /lifetime: host_instance/);
  } finally {
    pending.resolve(done);
    await env.close();
  }
});
