import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSnapshot } from "../src/app-server.js";
import {
  ToolEnvironment,
  type ToolInvocation,
  type ToolRuntime,
  type ToolTaskOptions,
  type ToolTaskPolicy,
} from "../src/tool.js";
import type { RemoteToolDispatch } from "../src/protocol/native/remote-host.js";
import { FleetToolGateway } from "../src/protocol/native/remote-tools.js";
import {
  makeRemoteToolAdmissionId,
  type RemoteToolExecuteRequest,
} from "../src/protocol/native/remote-tool-wire.js";

const target: ThreadSnapshot = {
  id: "target",
  cwd: "/target/work",
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  archived: false,
  items: [],
  turns: [],
  providerProfileId: "p",
  modelId: "m",
  reasoningEffort: null,
  model: "m",
  provider: "p",
};
const binding = {
  version: 1 as const,
  hostId: "host",
  processEpoch: "epoch",
  sourceThreadId: "caller",
  workspaceId: "workspace",
  targetThreadId: target.id,
};
const mappedTiming = {
  yieldTimeMs: "domain_yield",
  timeoutMs: "domain_timeout",
};
interface FixtureOptions {
  taskPolicy?: ToolTaskPolicy;
  taskOptions?: ToolTaskOptions;
  arguments?: Record<string, unknown>;
  outer?: { yieldTimeMs: number; timeoutMs: number };
  execute?: ToolRuntime["execute"];
}
async function fixture(options: FixtureOptions = {}) {
  let calls = 0;
  let dispatches = 0;
  let observed: ToolInvocation | undefined;
  const runtime: ToolRuntime = {
    name: "ordinary",
    remoteExecution: "text-json",
    enforcesSandbox: true,
    specification: {
      name: "ordinary",
      description: "ordinary text tool",
      inputSchema: {
        type: "object",
        properties: { domain_yield: {}, domain_timeout: {} },
        additionalProperties: false,
      },
    },
    ...(options.taskPolicy === undefined
      ? {}
      : { taskPolicy: options.taskPolicy }),
    async execute(invocation) {
      calls++;
      observed = invocation;
      return options.execute === undefined
        ? { output: "done", exitCode: 0 }
        : await options.execute(invocation);
    },
  };
  const tools = new ToolEnvironment({
    runtimes: [runtime],
    ...(options.taskOptions === undefined
      ? {}
      : { taskOptions: options.taskOptions }),
  });
  const gateway = new FleetToolGateway({ tools, ...binding });
  const catalog = await gateway.catalog(binding, async () => target, "peer");
  const now = Date.now();
  const request: RemoteToolExecuteRequest = {
    ...binding,
    admissionId: makeRemoteToolAdmissionId(now, now + 60_000, "timing"),
    createdAtMs: now,
    expiresAtMs: now + 60_000,
    name: runtime.name,
    toolGeneration: catalog.tools.find(
      (entry) => entry.definition.name === runtime.name,
    )!.generation,
    arguments: options.arguments ?? {},
    yieldTimeMs: options.outer?.yieldTimeMs ?? 1000,
    timeoutMs: options.outer?.timeoutMs ?? 10_000,
    maxOutputBytes: 1024,
  };
  // Static in-memory Thread context; public Host admission has separate tests.
  const dispatch: RemoteToolDispatch = {
    beginAdmission: () => ({ release() {} }),
    async dispatch(_expected, launch) {
      dispatches++;
      return { result: launch() };
    },
  };
  return {
    tools,
    gateway,
    request,
    get observed() {
      return observed;
    },
    get calls() {
      return calls;
    },
    get dispatches() {
      return dispatches;
    },
    execute: () =>
      gateway.execute(
        request,
        async () => target,
        new AbortController().signal,
        "peer",
        dispatch,
      ),
    async close() {
      await gateway.close();
      await tools.close();
    },
  };
}

test("omitted domain timing preserves the target runtime policy instead of wire defaults", async () => {
  const f = await fixture({
    taskPolicy: {
      yieldTimeMs: 2,
      timeoutMs: 15,
      timingArguments: mappedTiming,
    },
  });
  try {
    assert.equal((await f.execute()).status, "completed");
    assert.equal(f.observed?.task?.yieldTimeMs, 2);
    assert.equal(f.observed?.task?.timeoutMs, 15);
    assert.equal(f.calls, 1);
  } finally {
    await f.close();
  }
});

for (const entry of [
  {
    name: "unmapped runtime policy survives a longer outer budget",
    options: { taskPolicy: { yieldTimeMs: 2, timeoutMs: 15 } },
    expected: { yieldTimeMs: 2, timeoutMs: 15 },
  },
  {
    name: "configured manager defaults survive omitted domain timing",
    options: {
      taskOptions: { yieldTimeMs: 3, timeoutMs: 20 },
      taskPolicy: { timingArguments: mappedTiming },
    },
    expected: { yieldTimeMs: 3, timeoutMs: 20 },
  },
  {
    name: "runtime policy takes precedence over manager defaults",
    options: {
      taskOptions: { yieldTimeMs: 3, timeoutMs: 20 },
      taskPolicy: { yieldTimeMs: 4, timeoutMs: 30 },
    },
    expected: { yieldTimeMs: 4, timeoutMs: 30 },
  },
  {
    name: "declared domain timing takes precedence over policy and manager defaults",
    options: {
      taskOptions: { yieldTimeMs: 3, timeoutMs: 20 },
      taskPolicy: {
        yieldTimeMs: 2,
        timeoutMs: 15,
        timingArguments: mappedTiming,
      },
      arguments: { domain_yield: 4, domain_timeout: 30 },
    },
    expected: { yieldTimeMs: 4, timeoutMs: 30 },
  },
  {
    name: "a shorter explicit outer budget narrows declared domain timing",
    options: {
      taskPolicy: { timingArguments: mappedTiming },
      arguments: { domain_yield: 4, domain_timeout: 30 },
      outer: { yieldTimeMs: 1, timeoutMs: 5 },
    },
    expected: { yieldTimeMs: 1, timeoutMs: 5 },
  },
  {
    name: "a shorter explicit outer budget narrows runtime policy",
    options: {
      taskPolicy: { yieldTimeMs: 2, timeoutMs: 15 },
      outer: { yieldTimeMs: 1, timeoutMs: 5 },
    },
    expected: { yieldTimeMs: 1, timeoutMs: 5 },
  },
  {
    name: "omitted fields independently fall back without becoming zero or undefined",
    options: {
      taskOptions: { yieldTimeMs: 3, timeoutMs: 20 },
      taskPolicy: { timeoutMs: 15, timingArguments: mappedTiming },
      arguments: { domain_yield: 4 },
    },
    expected: { yieldTimeMs: 4, timeoutMs: 15 },
  },
  {
    name: "built-in manager defaults are narrowed by remote ceilings",
    options: { outer: { yieldTimeMs: 30_000, timeoutMs: 120_000 } },
    expected: { yieldTimeMs: 10_000, timeoutMs: 120_000 },
  },
  {
    name: "valid large runtime defaults are capped instead of rejected",
    options: {
      taskPolicy: { yieldTimeMs: 180_000, timeoutMs: 86_400_000 },
      outer: { yieldTimeMs: 30_000, timeoutMs: 120_000 },
    },
    expected: { yieldTimeMs: 30_000, timeoutMs: 120_000 },
  },
  {
    name: "valid large configured manager defaults are capped instead of rejected",
    options: {
      taskOptions: { yieldTimeMs: 180_000, timeoutMs: 86_400_000 },
      outer: { yieldTimeMs: 30_000, timeoutMs: 120_000 },
    },
    expected: { yieldTimeMs: 30_000, timeoutMs: 120_000 },
  },
  {
    name: "valid domain timing can override invalid unused runtime defaults",
    options: {
      taskPolicy: {
        yieldTimeMs: Infinity,
        timeoutMs: Infinity,
        timingArguments: mappedTiming,
      },
      arguments: { domain_yield: 4, domain_timeout: 30 },
    },
    expected: { yieldTimeMs: 4, timeoutMs: 30 },
  },
] satisfies {
  name: string;
  options: FixtureOptions;
  expected: { yieldTimeMs: number; timeoutMs: number };
}[]) {
  test(`remote timing: ${entry.name}`, async () => {
    const f = await fixture(entry.options);
    try {
      assert.equal((await f.execute()).status, "completed");
      assert.deepEqual(
        {
          yieldTimeMs: f.observed?.task?.yieldTimeMs,
          timeoutMs: f.observed?.task?.timeoutMs,
        },
        entry.expected,
      );
      assert.deepEqual(f.observed?.arguments, f.request.arguments);
      assert.equal(f.calls, 1);
      assert.equal(f.dispatches, 1);
    } finally {
      await f.close();
    }
  });
}

test("effective invalid runtime timings reject before dispatch without finite coercion", async (t) => {
  for (const field of ["yieldTimeMs", "timeoutMs"] as const) {
    const coreMax = field === "yieldTimeMs" ? 180_000 : 86_400_000;
    for (const value of [0, -1, Infinity, NaN, 1.5, coreMax + 1]) {
      await t.test(`${field}=${value}`, async () => {
        const f = await fixture({ taskPolicy: { [field]: value } });
        try {
          await assert.rejects(f.execute(), { code: "invalid_request" });
          assert.equal(f.calls, 0);
          assert.equal(f.dispatches, 0);
          assert.equal(f.tools.taskManager.activeTaskCount, 0);
        } finally {
          await f.close();
        }
      });
    }
  }
});

test("explicit domain timing outside remote support rejects even with smaller outer bounds", async (t) => {
  for (const field of ["domain_yield", "domain_timeout"] as const) {
    const remoteMax = field === "domain_yield" ? 30_000 : 120_000;
    for (const value of [
      0,
      -1,
      Infinity,
      NaN,
      1.5,
      remoteMax + 1,
      "15",
      null,
    ]) {
      await t.test(`${field}=${value}`, async () => {
        const f = await fixture({
          taskPolicy: { timingArguments: mappedTiming },
          arguments: { [field]: value },
          outer: { yieldTimeMs: 1, timeoutMs: 1 },
        });
        try {
          await assert.rejects(f.execute(), { code: "invalid_request" });
          assert.equal(f.calls, 0);
          assert.equal(f.dispatches, 0);
          assert.equal(f.tools.taskManager.activeTaskCount, 0);
        } finally {
          await f.close();
        }
      });
    }
  }
});

test("outer timing cannot convert invalid zero, infinite or missing values into target defaults", async (t) => {
  for (const field of ["yieldTimeMs", "timeoutMs"] as const) {
    for (const value of [0, Infinity, undefined]) {
      await t.test(`${field}=${value}`, async () => {
        const f = await fixture({
          taskPolicy: { yieldTimeMs: 2, timeoutMs: 15 },
        });
        Object.assign(f.request, { [field]: value });
        try {
          await assert.rejects(f.execute(), { code: "invalid_request" });
          assert.equal(f.calls, 0);
          assert.equal(f.dispatches, 0);
        } finally {
          await f.close();
        }
      });
    }
  }
});

test("the target's shorter execution deadline remains active after the remote yield", async () => {
  const f = await fixture({
    taskPolicy: {
      yieldTimeMs: 2,
      timeoutMs: 15,
      cancellation: "confirmed-on-settle",
    },
    execute: async (invocation) =>
      await new Promise((_resolve, reject) => {
        invocation.signal.addEventListener(
          "abort",
          () => reject(invocation.signal.reason),
          { once: true },
        );
      }),
  });
  try {
    const first = await f.execute();
    const last = await f.gateway.wait(
      {
        ...binding,
        admissionId: first.admissionId,
        taskId: first.taskId,
        ackCursor: first.cursor,
        yieldTimeMs: 1000,
        maxOutputBytes: 1024,
      },
      async () => target,
      new AbortController().signal,
      "peer",
    );
    assert.equal(last.status, "timed_out");
    assert.equal(f.observed?.signal.aborted, true);
    assert.equal(f.observed?.task?.timeoutMs, 15);
    assert.equal(f.calls, 1);
  } finally {
    await f.close();
  }
});
