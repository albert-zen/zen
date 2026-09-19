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

test("opt-in resource wait creates caller-owned tasks and dispatches conflicts FIFO", async () => {
  const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
  const started: string[] = [];
  const browser: ToolRuntime = {
    name: "browser",
    specification: {
      name: "browser",
      description: "browser",
      inputSchema: { type: "object" },
    },
    taskPolicy: { resourceQueue: "fifo" },
    resourceClaims: () => [{ key: "browser:session:a", access: "exclusive" }],
    async execute(call) {
      const label = String(call.arguments.label);
      started.push(label);
      await releases[Number(label) - 1]!.promise;
      return { output: label, exitCode: 0 };
    },
  };
  const env = new ToolEnvironment({
    runtimes: [browser],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const first = await env.execute(
      env.prepare(invocation("browser", { label: "1" })),
    );
    const second = await env.execute(
      env.prepare(invocation("browser", { label: "2" })),
    );
    const third = await env.execute(
      env.prepare(invocation("browser", { label: "3" })),
    );
    assert.deepEqual(started, ["1"]);
    assert.equal(data(second).status, "queued");
    assert.equal(data(third).status, "queued");
    assert.equal(
      (second.structuredContent as { resource_scope: string }).resource_scope,
      "claims",
    );

    releases[0]!.resolve();
    await env.waitRuntime.execute(
      invocation("wait", { task_id: data(first).task_id, yield_time_ms: 100 }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["1", "2"]);

    releases[1]!.resolve();
    await env.waitRuntime.execute(
      invocation("wait", { task_id: data(second).task_id, yield_time_ms: 100 }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["1", "2", "3"]);
    releases[2]!.resolve();
  } finally {
    for (const release of releases) release.resolve();
    await env.close();
  }
});

test("exclusive waiters block later conflicting shared work without blocking unrelated resources", async () => {
  const releasePage = deferred<void>();
  const releaseClose = deferred<void>();
  const started: string[] = [];
  const browser: ToolRuntime = {
    name: "browser",
    specification: {
      name: "browser",
      description: "browser",
      inputSchema: { type: "object" },
    },
    taskPolicy: { resourceQueue: "fifo", resourceScope: "runtime" },
    resourceClaims(call) {
      const operation = String(call.arguments.operation);
      if (operation === "close-a")
        return [{ key: "session:a", access: "exclusive" }];
      if (operation === "list-a")
        return [{ key: "session:a", access: "shared" }];
      const session = operation.endsWith("a") ? "a" : "b";
      return [
        { key: `session:${session}`, access: "shared" },
        { key: `page:${session}:1`, access: "exclusive" },
      ];
    },
    async execute(call) {
      const operation = String(call.arguments.operation);
      started.push(operation);
      if (operation === "page-a") await releasePage.promise;
      if (operation === "close-a") await releaseClose.promise;
      return { output: operation, exitCode: 0 };
    },
  };
  const env = new ToolEnvironment({
    runtimes: [browser],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const pageA = await env.execute(
      env.prepare(invocation("browser", { operation: "page-a" })),
    );
    const closeA = await env.execute(
      env.prepare(invocation("browser", { operation: "close-a" })),
    );
    const listA = await env.execute(
      env.prepare(invocation("browser", { operation: "list-a" })),
    );
    const pageB = await env.execute(
      env.prepare(invocation("browser", { operation: "page-b" })),
    );
    assert.equal(pageB.output, "page-b");
    assert.deepEqual(started, ["page-a", "page-b"]);
    assert.equal(data(closeA).status, "queued");
    assert.equal(data(listA).status, "queued");

    releasePage.resolve();
    await env.waitRuntime.execute(
      invocation("wait", { task_id: data(pageA).task_id, yield_time_ms: 100 }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["page-a", "page-b", "close-a"]);

    releaseClose.resolve();
    await env.waitRuntime.execute(
      invocation("wait", { task_id: data(closeA).task_id, yield_time_ms: 100 }),
    );
    const listed = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(listA).task_id, yield_time_ms: 100 }),
    );
    assert.equal(data(listed).status, "completed");
    assert.deepEqual(started, ["page-a", "page-b", "close-a", "list-a"]);
  } finally {
    releasePage.resolve();
    releaseClose.resolve();
    await env.close();
  }
});

test("queued cancellation stays thread-owned and never dispatches the body", async () => {
  const release = deferred<void>();
  const started: string[] = [];
  const browser: ToolRuntime = {
    ...tool("browser", async (call) => {
      started.push(String(call.arguments.label));
      await release.promise;
      return done;
    }),
    taskPolicy: { resourceQueue: "fifo" },
    resourceClaims: () => [{ key: "session:a", access: "exclusive" }],
  };
  const env = new ToolEnvironment({
    runtimes: [browser],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const holder = await env.execute(
      env.prepare(invocation("browser", { label: "holder" })),
    );
    const queued = await env.execute(
      env.prepare(invocation("browser", { label: "cancelled" })),
    );
    assert.equal(data(queued).status, "queued");
    await assert.rejects(
      env.waitRuntime.execute({
        ...invocation("wait", { task_id: data(queued).task_id }),
        threadId: "other-thread",
      }),
      /not found for this thread/u,
    );
    const cancelled = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(queued).task_id, terminate: true }),
    );
    assert.equal(data(cancelled).status, "cancelled");
    assert.deepEqual(started, ["holder"]);

    release.resolve();
    await env.waitRuntime.execute(
      invocation("wait", { task_id: data(holder).task_id, yield_time_ms: 100 }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["holder"]);
  } finally {
    release.resolve();
    await env.close();
  }
});

test("queued execution timeout settles without dispatching and frees its lease", async () => {
  const release = deferred<void>();
  const started: string[] = [];
  let leases = 0;
  const browser: ToolRuntime = {
    ...tool("browser", async (call) => {
      started.push(String(call.arguments.label));
      await release.promise;
      return done;
    }),
    taskPolicy: { resourceQueue: "fifo" },
    resourceClaims: () => [{ key: "session:a", access: "exclusive" }],
  };
  const env = new ToolEnvironment({
    bundles: [
      {
        identity: { kind: "external", id: "browser" },
        tools: [browser],
        retainPreparedInvocation() {
          leases++;
          return () => {
            leases--;
          };
        },
      },
    ],
    taskOptions: { yieldTimeMs: 1, timeoutMs: 1_000 },
  });
  try {
    const holder = await env.execute(
      env.prepare(invocation("browser", { label: "holder" })),
    );
    const queued = await env.execute(
      env.prepare({
        ...invocation("browser", { label: "timed-out" }),
        task: { timeoutMs: 10 },
      }),
    );
    const timedOut = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(queued).task_id, yield_time_ms: 100 }),
    );
    assert.equal(data(timedOut).status, "timed_out");
    assert.equal(timedOut.exitCode, 124);
    assert.deepEqual(started, ["holder"]);
    assert.equal(leases, 1);

    release.resolve();
    await env.waitRuntime.execute(
      invocation("wait", { task_id: data(holder).task_id, yield_time_ms: 100 }),
    );
    assert.equal(leases, 0);
  } finally {
    release.resolve();
    await env.close();
  }
});

test("unconfirmed cancellation keeps dynamic claims fenced until real completion", async () => {
  const firstResult = deferred<typeof done>();
  const releaseSecond = deferred<void>();
  const started: string[] = [];
  const browser: ToolRuntime = {
    ...tool("browser", async (call) => {
      const label = String(call.arguments.label);
      started.push(label);
      if (label === "first") return await firstResult.promise;
      await releaseSecond.promise;
      return done;
    }),
    taskPolicy: { resourceQueue: "fifo" },
    resourceClaims: () => [{ key: "page:a", access: "exclusive" }],
  };
  const env = new ToolEnvironment({
    runtimes: [browser],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const first = await env.execute(
      env.prepare(invocation("browser", { label: "first" })),
    );
    const second = await env.execute(
      env.prepare(invocation("browser", { label: "second" })),
    );
    const cancelling = await env.waitRuntime.execute(
      invocation("wait", {
        task_id: data(first).task_id,
        terminate: true,
        yield_time_ms: 1,
      }),
    );
    assert.equal(data(cancelling).status, "cancellation_unconfirmed");
    const stillQueued = await env.waitRuntime.execute(
      invocation("wait", {
        task_id: data(second).task_id,
        yield_time_ms: 2,
      }),
    );
    assert.equal(data(stillQueued).status, "queued");
    assert.deepEqual(started, ["first"]);

    firstResult.resolve(done);
    await env.waitRuntime.execute(
      invocation("wait", { task_id: data(first).task_id, yield_time_ms: 100 }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["first", "second"]);
    releaseSecond.resolve();
  } finally {
    firstResult.resolve(done);
    releaseSecond.resolve();
    await env.close();
  }
});

test("opt-in tasks wait for execution capacity while existing tools still reject", async () => {
  const release = deferred<void>();
  const started: string[] = [];
  const queued = tool(
    "queued",
    async (call) => {
      started.push(String(call.arguments.label));
      if (call.arguments.label === "first") await release.promise;
      return done;
    },
    { resourceQueue: "fifo", resourceScope: "independent" },
  );
  const rejecting = tool("rejecting", async () => done, {
    resourceScope: "independent",
  });
  const env = new ToolEnvironment({
    runtimes: [queued, rejecting],
    taskOptions: { yieldTimeMs: 1, maxRunningTasks: 1 },
  });
  try {
    const first = await env.execute(
      env.prepare(invocation("queued", { label: "first" })),
    );
    const second = await env.execute(
      env.prepare(invocation("queued", { label: "second" })),
    );
    assert.equal(data(second).status, "queued");
    await assert.rejects(
      env.execute(env.prepare(invocation("rejecting"))),
      /capacity/u,
    );
    release.resolve();
    await env.waitRuntime.execute(
      invocation("wait", { task_id: data(first).task_id, yield_time_ms: 100 }),
    );
    const completed = await env.waitRuntime.execute(
      invocation("wait", { task_id: data(second).task_id, yield_time_ms: 100 }),
    );
    assert.equal(data(completed).status, "completed");
    assert.deepEqual(started, ["first", "second"]);
  } finally {
    release.resolve();
    await env.close();
  }
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
      invocation("wait", { task_id: data(start).task_id, yield_time_ms: 1 }),
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
test("wait returns on completion or expiry instead of waking for new output", async () => {
  const pending = deferred<typeof done>();
  let write!: (text: string) => void;
  const body = tool("progress", async (call) => {
    write = call.taskContext!.onOutput;
    await pending.promise;
    return done;
  });
  const env = new ToolEnvironment({
    runtimes: [body],
    taskOptions: { yieldTimeMs: 1 },
  });
  try {
    const start = await env.execute(env.prepare(invocation("progress")));
    const waiting = env.waitRuntime.execute(
      invocation("wait", {
        task_id: data(start).task_id,
        yield_time_ms: 30,
      }),
    );
    write("new log");
    const early = await Promise.race([
      waiting.then(() => "returned"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 5)),
    ]);
    assert.equal(early, "pending");
    const expired = await waiting;
    assert.equal(data(expired).status, "running");
    assert.match(expired.output, /new log/u);
    pending.resolve(done);
    const completed = await env.waitRuntime.execute(
      invocation("wait", {
        task_id: data(start).task_id,
        yield_time_ms: 180000,
      }),
    );
    assert.equal(data(completed).status, "completed");
  } finally {
    pending.resolve(done);
    await env.close();
  }
});

test("tool and wait yield controls accept at most 180 seconds", async () => {
  const body = tool("fast", async () => done, {
    timingArguments: { yieldTimeMs: "yield_time_ms" },
  });
  const env = new ToolEnvironment({ runtimes: [body] });
  try {
    const result = await env.execute(
      env.prepare(invocation("fast", { yield_time_ms: 180000 })),
    );
    assert.equal(result.output, "done");
    await assert.rejects(
      env.execute(env.prepare(invocation("fast", { yield_time_ms: 180001 }))),
      /1 to 180000/u,
    );
    assert.equal(
      (
        env.waitRuntime.specification.inputSchema as {
          properties: { yield_time_ms: { maximum: number } };
        }
      ).properties.yield_time_ms.maximum,
      180000,
    );
  } finally {
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
