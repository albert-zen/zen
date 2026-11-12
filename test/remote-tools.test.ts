import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSnapshot } from "../src/app-server.js";
import { ToolEnvironment, type ToolRuntime } from "../src/tool.js";
import { FleetToolGateway as TargetFleetToolGateway } from "../src/protocol/native/remote-tools.js";
import {
  RemoteHostError,
  type RemoteToolDispatch,
} from "../src/protocol/native/remote-host.js";
import {
  makeRemoteToolAdmissionId,
  type RemoteToolExecuteRequest,
} from "../src/protocol/native/remote-tool-wire.js";

const signal = () => new AbortController().signal;
// These gateway-unit fixtures have static in-memory contexts, no AppServer or
// mutable Thread authority. Public Host admission is tested separately.
const staticDispatch: RemoteToolDispatch = {
  beginAdmission: () => ({ release() {} }),
  async dispatch(_expected, launch) {
    return { result: launch() };
  },
};
class FleetToolGateway extends TargetFleetToolGateway {
  override execute(
    request: RemoteToolExecuteRequest,
    resolveTarget: () => Promise<ThreadSnapshot>,
    signal: AbortSignal,
    peerId: string,
    dispatch: RemoteToolDispatch = staticDispatch,
  ) {
    return super.execute(request, resolveTarget, signal, peerId, dispatch);
  }
}
const target = (): ThreadSnapshot => ({
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
});
const binding = (hostId = "host", processEpoch = "epoch") => ({
  version: 1 as const,
  hostId,
  processEpoch,
  sourceThreadId: "caller",
  workspaceId: "workspace",
  targetThreadId: "target",
});
function ordinary(execute: ToolRuntime["execute"]): ToolRuntime {
  return {
    name: "ordinary",
    remoteExecution: "text-json",
    enforcesSandbox: true,
    specification: {
      name: "ordinary",
      description: "ordinary text tool",
      inputSchema: {
        type: "object",
        properties: { value: { type: "integer", minimum: 0 } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    execute,
  };
}
async function request(
  gateway: FleetToolGateway,
  admissionId = "call",
): Promise<RemoteToolExecuteRequest> {
  const catalog = await gateway.catalog(
    binding(),
    async () => target(),
    "peer",
  );
  const generation = catalog.tools.find(
    (entry) => entry.definition.name === "ordinary",
  )!.generation;
  const now = Date.now();
  return {
    ...binding(),
    admissionId: makeRemoteToolAdmissionId(now, now + 60_000, admissionId),
    createdAtMs: now,
    expiresAtMs: now + 60_000,
    name: "ordinary",
    toolGeneration: generation,
    arguments: { value: 7 },
    yieldTimeMs: 5,
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  };
}

test("ordinary registered runtime executes in target context once without a target Turn", async () => {
  let calls = 0;
  const snapshot = target();
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async (invocation) => {
        calls++;
        assert.equal(invocation.cwd, snapshot.cwd);
        assert.equal(invocation.threadId, snapshot.id);
        assert.equal(invocation.sandbox, snapshot.sandbox);
        return {
          output: "value:7 /target/result.txt",
          exitCode: 0,
          contentType: "application/json",
          structuredContent: { value: 7, path: "/target/result.txt" },
        };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    const [first, repeat] = await Promise.all([
      gateway.execute(payload, async () => snapshot, signal(), "peer"),
      gateway.execute(payload, async () => snapshot, signal(), "peer"),
    ]);
    assert.deepEqual(first, repeat);
    assert.equal(calls, 1);
    assert.equal(first.status, "completed");
    assert.equal(first.origin.hostId, "host");
    assert.equal(first.paths, "remote-host");
    assert.deepEqual(first.structuredContent, {
      value: 7,
      path: "/target/result.txt",
    });
    assert.equal(snapshot.items.length, 0);
    await assert.rejects(
      gateway.execute(
        { ...payload, arguments: { value: 8 } },
        async () => snapshot,
        signal(),
        "peer",
      ),
      { code: "idempotency_conflict" },
    );
  } finally {
    await tools.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function observation(
  payload: RemoteToolExecuteRequest,
  first: { taskId: string; cursor: string },
  ackCursor?: string,
) {
  return {
    ...binding(payload.hostId, payload.processEpoch),
    admissionId: payload.admissionId,
    taskId: first.taskId,
    yieldTimeMs: 10,
    maxOutputBytes: 1024,
    ...(ackCursor === undefined ? {} : { ackCursor }),
  };
}

test("two target Hosts and process epochs fence otherwise identical task/thread IDs", async () => {
  const toolsA = new ToolEnvironment({
    runtimes: [ordinary(async () => ({ output: "A", exitCode: 0 }))],
  });
  const toolsB = new ToolEnvironment({
    runtimes: [ordinary(async () => ({ output: "B", exitCode: 0 }))],
  });
  const a = new FleetToolGateway({
    tools: toolsA,
    hostId: "host",
    processEpoch: "epoch",
  });
  const b = new FleetToolGateway({
    tools: toolsB,
    hostId: "other-host",
    processEpoch: "other-epoch",
  });
  try {
    const payload = await request(a);
    const first = await a.execute(
      payload,
      async () => target(),
      signal(),
      "peer",
    );
    await assert.rejects(
      b.status(
        {
          ...binding("other-host", "other-epoch"),
          admissionId: payload.admissionId,
          taskId: first.taskId,
        },
        async () => target(),
        "peer",
      ),
      { code: "operation_unknown" },
    );
    await assert.rejects(
      a.status(
        {
          ...binding("host", "new-epoch"),
          admissionId: payload.admissionId,
          taskId: first.taskId,
        },
        async () => target(),
        "peer",
      ),
      { code: "operation_unknown" },
    );
    await assert.rejects(
      a.status(
        {
          ...binding("other-host"),
          admissionId: payload.admissionId,
          taskId: first.taskId,
        },
        async () => target(),
        "peer",
      ),
      { code: "wrong_host" },
    );
    await assert.rejects(
      a.status(
        {
          ...binding(),
          sourceThreadId: "another-caller",
          admissionId: payload.admissionId,
          taskId: first.taskId,
        },
        async () => target(),
        "peer",
      ),
      { code: "operation_unknown" },
    );
    assert.match(first.taskId, /^remote-tool:/);
  } finally {
    await toolsA.close();
    await toolsB.close();
  }
});

test("exact schema, version and opt-in eligibility fail closed before runtime side effects", async () => {
  let calls = 0;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async () => {
        calls++;
        return { output: "done", exitCode: 0 };
      }),
      {
        name: "unsupported",
        remoteExecution: "text-json",
        specification: {
          name: "unsupported",
          description: "unsupported assertion",
          inputSchema: {
            type: "object",
            patternProperties: { "^x": { type: "string" } },
          },
        },
        async execute() {
          calls++;
          return { output: "unsafe", exitCode: 0 };
        },
      },
      {
        name: "local-only",
        specification: {
          name: "local-only",
          description: "not opted in",
          inputSchema: { type: "object" },
        },
        async execute() {
          calls++;
          return { output: "local", exitCode: 0 };
        },
      },
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const catalog = await gateway.catalog(
      binding(),
      async () => target(),
      "peer",
    );
    assert.equal(
      catalog.tools.find((entry) => entry.definition.name === "unsupported")!
        .eligible,
      false,
    );
    assert.match(
      catalog.tools.find((entry) => entry.definition.name === "unsupported")!
        .reason!,
      /unsupported keyword patternProperties/,
    );
    assert.equal(
      catalog.tools.find((entry) => entry.definition.name === "local-only")!
        .eligible,
      false,
    );
    const payload = await request(gateway);
    for (const [index, args] of [
      { value: -1 },
      { value: 1, extra: true },
      { value: "7" },
      {},
    ].entries()) {
      await assert.rejects(
        gateway.execute(
          {
            ...payload,
            admissionId: makeRemoteToolAdmissionId(
              payload.createdAtMs,
              payload.expiresAtMs,
              `invalid-${index}`,
            ),
            arguments: args,
          },
          async () => target(),
          signal(),
          "peer",
        ),
        { code: "invalid_request" },
      );
    }
    await assert.rejects(
      gateway.catalog(
        { ...binding(), version: 2 } as never,
        async () => target(),
        "peer",
      ),
      { code: "unsupported_version" },
    );
    const local = catalog.tools.find(
      (entry) => entry.definition.name === "local-only",
    )!;
    await assert.rejects(
      gateway.execute(
        {
          ...payload,
          admissionId: makeRemoteToolAdmissionId(
            payload.createdAtMs,
            payload.expiresAtMs,
            "local",
          ),
          name: "local-only",
          toolGeneration: local.generation,
          arguments: {},
        },
        async () => target(),
        signal(),
        "peer",
      ),
      { code: "operation_forbidden" },
    );
    assert.equal(calls, 0);
  } finally {
    await tools.close();
  }
});

test("target remembered denial and approval-needed calls cannot be approved by caller", async () => {
  for (const mode of ["denied", "unknown", "unsandboxed"] as const) {
    let calls = 0;
    const runtime = ordinary(async () => {
      calls++;
      return { output: "ran", exitCode: 0 };
    });
    if (mode === "unsandboxed")
      Object.assign(runtime, { enforcesSandbox: false });
    const tools = new ToolEnvironment({
      runtimes: [runtime],
      ...(mode === "denied" ? { deniedTools: new Set(["ordinary"]) } : {}),
    });
    const gateway = new FleetToolGateway({
      tools,
      hostId: "host",
      processEpoch: "epoch",
    });
    const snapshot = {
      ...target(),
      approvalPolicy:
        mode === "unknown" ? ("always" as const) : ("never" as const),
      sandbox:
        mode === "unsandboxed"
          ? ("workspace-write" as const)
          : ("danger-full-access" as const),
    };
    try {
      await assert.rejects(
        gateway.execute(
          await request(gateway),
          async () => snapshot,
          signal(),
          "peer",
        ),
        {
          code: mode === "denied" ? "operation_forbidden" : "approval_required",
        },
      );
      assert.equal(calls, 0);
    } finally {
      await tools.close();
    }
  }
});

test("target settings and exact runtime generation are rechecked immediately before dispatch", async () => {
  let calls = 0;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async () => {
        calls++;
        return { output: "ran", exitCode: 0 };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    let reads = 0;
    await assert.rejects(
      gateway.execute(
        payload,
        async () => ({
          ...target(),
          cwd: ++reads === 1 ? "/target/work" : "/other",
        }),
        signal(),
        "peer",
      ),
      { code: "stale_thread" },
    );
    tools.unregisterBundle({ kind: "builtin", id: "ordinary" });
    tools.registerRuntime(
      ordinary(async () => {
        calls++;
        return { output: "replacement", exitCode: 0 };
      }),
    );
    await assert.rejects(
      gateway.execute(
        {
          ...payload,
          admissionId: makeRemoteToolAdmissionId(
            payload.createdAtMs,
            payload.expiresAtMs,
            "old-generation",
          ),
        },
        async () => target(),
        signal(),
        "peer",
      ),
      { code: "operation_forbidden" },
    );
    assert.equal(calls, 0);
  } finally {
    await tools.close();
  }
});

test("streaming destructive waits replay lost receipts and acknowledgement retries once", async () => {
  const finish = deferred<void>();
  let calls = 0;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async (call) => {
        calls++;
        call.taskContext!.onOutput("first chunk");
        await finish.promise;
        return {
          output: "last chunk",
          exitCode: 0,
          contentType: "application/json",
          structuredContent: { done: true },
        };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    const first = await gateway.execute(
      payload,
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(first.status, "running");
    assert.equal(first.output, "first chunk");
    const replay = await gateway.wait(
      observation(payload, first),
      async () => target(),
      signal(),
      "peer",
    );
    assert.deepEqual(replay, first);
    finish.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const status = await gateway.status(
      { ...binding(), admissionId: payload.admissionId, taskId: first.taskId },
      async () => target(),
      "peer",
    );
    assert.equal(status.status, "completed");
    // Non-destructive status retained the first receipt and undrained final output.
    assert.equal(status.cursor, first.cursor);
    const nextRequest = observation(payload, first, first.cursor);
    const [last, retry] = await Promise.all([
      gateway.wait(nextRequest, async () => target(), signal(), "peer"),
      gateway.wait(nextRequest, async () => target(), signal(), "peer"),
    ]);
    assert.deepEqual(last, retry);
    assert.equal(last.status, "completed");
    assert.equal(last.output, "last chunk");
    assert.deepEqual(last.structuredContent, { done: true });
    assert.equal(calls, 1);
    assert.deepEqual(
      await gateway.wait(nextRequest, async () => target(), signal(), "peer"),
      last,
    );
    assert.deepEqual(
      await gateway.wait(
        observation(payload, last, last.cursor),
        async () => target(),
        signal(),
        "peer",
      ),
      last,
    );
  } finally {
    finish.resolve();
    await tools.close();
  }
});

test("transport disconnect leaves admitted operation running and reconnect observes same admission", async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  let calls = 0;
  let aborted = false;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async (call) => {
        calls++;
        started.resolve();
        call.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await finish.promise;
        return { output: "after reconnect", exitCode: 0 };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = { ...(await request(gateway)), yieldTimeMs: 50 };
    const controller = new AbortController();
    const pending = gateway.execute(
      payload,
      async () => target(),
      controller.signal,
      "peer",
    );
    await started.promise;
    controller.abort(new Error("socket closed"));
    await assert.rejects(pending, /socket closed/);
    assert.equal(aborted, false);
    finish.resolve();
    const result = await gateway.execute(
      payload,
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(result.status, "completed");
    assert.equal(result.output, "after reconnect");
    assert.equal(calls, 1);
    assert.equal(aborted, false);
  } finally {
    finish.resolve();
    await tools.close();
  }
});

test("disconnect during destructive wait preserves the next receipt for the same ack", async () => {
  const finish = deferred<void>();
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async () => {
        await finish.promise;
        return { output: "kept", exitCode: 0 };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    const first = await gateway.execute(
      payload,
      async () => target(),
      signal(),
      "peer",
    );
    const nextRequest = {
      ...observation(payload, first, first.cursor),
      yieldTimeMs: 100,
    };
    const controller = new AbortController();
    const pending = gateway.wait(
      nextRequest,
      async () => target(),
      controller.signal,
      "peer",
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("lost observation"));
    await assert.rejects(pending, /lost observation/);
    finish.resolve();
    const result = await gateway.wait(
      nextRequest,
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(result.status, "completed");
    assert.equal(result.output, "kept");
  } finally {
    finish.resolve();
    await tools.close();
  }
});

test("scope failure before a destructive wait leaves the exact ACK retryable", async () => {
  const finish = deferred<void>();
  let effects = 0;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async (call) => {
        effects++;
        call.taskContext!.onOutput("first");
        await finish.promise;
        return { output: "retained final output", exitCode: 0 };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  const executeWait = tools.waitRuntime.execute.bind(tools.waitRuntime);
  let drains = 0;
  tools.waitRuntime.execute = async (invocation) => {
    drains++;
    return executeWait(invocation);
  };
  try {
    const payload = await request(gateway);
    const first = await gateway.execute(
      payload,
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(first.status, "running");
    const ack = observation(payload, first, first.cursor);
    let reads = 0;
    const resolveTarget = async () => {
      if (++reads === 2) throw new RemoteHostError("scope_refreshing");
      return target();
    };
    await assert.rejects(gateway.wait(ack, resolveTarget, signal(), "peer"), {
      code: "scope_refreshing",
    });
    assert.equal(drains, 0);
    finish.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const [last, replay] = await Promise.all([
      gateway.wait(ack, resolveTarget, signal(), "peer"),
      gateway.wait(ack, resolveTarget, signal(), "peer"),
    ]);
    assert.deepEqual(last, replay);
    assert.equal(last.status, "completed");
    assert.equal(last.output, "retained final output");
    assert.notEqual(last.cursor, first.cursor);
    assert.equal(drains, 1);
    assert.equal(effects, 1);
  } finally {
    finish.resolve();
    await tools.close();
  }
});

test("failure after a destructive wait begins stays unknown and never redrains its ACK", async () => {
  const finish = deferred<void>();
  let effects = 0;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async () => {
        effects++;
        await finish.promise;
        return { output: "consumed final output", exitCode: 0 };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  const executeWait = tools.waitRuntime.execute.bind(tools.waitRuntime);
  let drains = 0;
  tools.waitRuntime.execute = async (invocation) => {
    drains++;
    await executeWait(invocation);
    throw new RemoteHostError("scope_refreshing");
  };
  try {
    const payload = await request(gateway);
    const first = await gateway.execute(
      payload,
      async () => target(),
      signal(),
      "peer",
    );
    finish.resolve();
    const ack = observation(payload, first, first.cursor);
    for (let retry = 0; retry < 2; retry++)
      await assert.rejects(
        gateway.wait(ack, async () => target(), signal(), "peer"),
        { code: "operation_unknown" },
      );
    assert.equal(drains, 1);
    assert.equal(effects, 1);
  } finally {
    finish.resolve();
    await tools.close();
  }
});

test("explicit cancel uses target task cancellation evidence and preserves final output", async () => {
  const runtime = ordinary(async (call) => {
    await new Promise<void>((resolve) => {
      call.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { output: "cancelled body", exitCode: 130 };
  });
  Object.assign(runtime, {
    taskPolicy: { cancellation: "confirmed-on-settle" },
  });
  const tools = new ToolEnvironment({ runtimes: [runtime] });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    const first = await gateway.execute(
      payload,
      async () => target(),
      signal(),
      "peer",
    );
    const result = await gateway.cancel(
      observation(payload, first, first.cursor),
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(result.status, "cancelled");
    assert.equal(result.exitCode, 130);
    assert.equal(result.output, "cancelled body");
  } finally {
    await tools.close();
  }
});

test("expired admissions, cross-peer access and revocation cannot rerun mutation", async () => {
  let calls = 0;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async () => {
        calls++;
        return { output: "done", exitCode: 0 };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    const result = await gateway.execute(
      payload,
      async () => target(),
      signal(),
      "peer",
    );
    await assert.rejects(
      gateway.status(
        {
          ...binding(),
          admissionId: payload.admissionId,
          taskId: result.taskId,
        },
        async () => target(),
        "another-peer",
      ),
      { code: "operation_unknown" },
    );
    const expiredCreated = Date.now() - 2000;
    const expiredEnd = expiredCreated + 1000;
    await assert.rejects(
      gateway.execute(
        {
          ...payload,
          admissionId: makeRemoteToolAdmissionId(
            expiredCreated,
            expiredEnd,
            "expired",
          ),
          createdAtMs: expiredCreated,
          expiresAtMs: expiredEnd,
        },
        async () => target(),
        signal(),
        "peer",
      ),
      { code: "operation_unknown" },
    );
    gateway.revoke("peer");
    await assert.rejects(
      gateway.execute(payload, async () => target(), signal(), "peer"),
      { code: "revoked" },
    );
    assert.equal(calls, 1);
  } finally {
    await tools.close();
  }
});

test("post-dispatch unrepresentable media reports unknown side effects and same ID never reruns", async () => {
  let effects = 0;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async () => {
        effects++;
        return {
          output: "remote image",
          exitCode: 0,
          contentType: "image/png",
          structuredContent: { path: "/remote/image.png" },
        };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    await assert.rejects(
      gateway.execute(payload, async () => target(), signal(), "peer"),
      { code: "operation_unknown" },
    );
    await assert.rejects(
      gateway.execute(payload, async () => target(), signal(), "peer"),
      { code: "operation_unknown" },
    );
    assert.equal(effects, 1);
    const status = await gateway.status(
      { ...binding(), admissionId: payload.admissionId },
      async () => target(),
      "peer",
    );
    assert.equal(status.status, "failed");
  } finally {
    await tools.close();
  }
});

test("cancel without ack preserves lost incremental output and reports cancellation request", async () => {
  const runtime = ordinary(async (call) => {
    call.taskContext!.onOutput("unacknowledged");
    await new Promise<void>((resolve) =>
      call.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { output: "final", exitCode: 130 };
  });
  Object.assign(runtime, {
    taskPolicy: { cancellation: "confirmed-on-settle" },
  });
  const tools = new ToolEnvironment({ runtimes: [runtime] });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    const first = await gateway.execute(
      payload,
      async () => target(),
      signal(),
      "peer",
    );
    const cancelled = await gateway.cancel(
      observation(payload, first),
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(cancelled.status, "cancel_requested");
    assert.equal(cancelled.cursor, first.cursor);
    assert.equal(cancelled.output, "unacknowledged");
    const final = await gateway.wait(
      observation(payload, first, first.cursor),
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(final.status, "cancelled");
    assert.equal(final.output, "final");
  } finally {
    await tools.close();
  }
});

test("nested supported schemas validate every assertion and unsupported keywords are ineligible", async () => {
  let calls = 0;
  const runtime = ordinary(async () => {
    calls++;
    return { output: "validated", exitCode: 0 };
  });
  Object.assign(runtime.specification, {
    inputSchema: {
      type: "object",
      properties: {
        values: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: {
            oneOf: [
              { type: "integer", minimum: 1 },
              { type: "string", minLength: 2, maxLength: 3 },
            ],
          },
        },
        tag: { enum: ["a", "b"] },
        constant: { const: null },
      },
      required: ["values", "tag", "constant"],
      additionalProperties: false,
    },
  });
  const tools = new ToolEnvironment({ runtimes: [runtime] });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    const good = { values: [1, "ab"], tag: "a", constant: null };
    const result = await gateway.execute(
      { ...payload, arguments: good },
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(result.output, "validated");
    for (const [index, arguments_] of [
      { ...good, values: [] },
      { ...good, values: [1, 1] },
      { ...good, values: [0] },
      { ...good, values: ["x"] },
      { ...good, tag: "c" },
      { ...good, constant: false },
    ].entries())
      await assert.rejects(
        gateway.execute(
          {
            ...payload,
            admissionId: makeRemoteToolAdmissionId(
              payload.createdAtMs,
              payload.expiresAtMs,
              `bad-nested-${index}`,
            ),
            arguments: arguments_,
          },
          async () => target(),
          signal(),
          "peer",
        ),
        { code: "invalid_request" },
      );
    assert.equal(calls, 1);
    for (const [index, unsupported] of [
      { $ref: "#/$defs/x" },
      { type: "string", format: "date-time" },
      { type: "string", pattern: "x" },
    ].entries()) {
      tools.registerRuntime({
        name: `schema-${index}`,
        remoteExecution: "text-json",
        specification: {
          name: `schema-${index}`,
          description: "unsupported schema",
          inputSchema: unsupported,
        },
        async execute() {
          throw new Error("must not execute");
        },
      });
    }
    const catalog = await gateway.catalog(
      binding(),
      async () => target(),
      "peer",
    );
    assert.equal(
      catalog.tools
        .filter((entry) => entry.definition.name.startsWith("schema-"))
        .every((entry) => !entry.eligible),
      true,
    );
  } finally {
    await tools.close();
  }
});

test("text output truncation stays UTF-8 bounded and identity/control-field validation is strict", async () => {
  const tools = new ToolEnvironment({
    runtimes: [ordinary(async () => ({ output: "😀😀😀", exitCode: 0 }))],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    const result = await gateway.execute(
      { ...payload, maxOutputBytes: 5 },
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(result.output, "😀");
    assert.equal(result.sourceTruncated, true);
    await assert.rejects(
      gateway.catalog(
        { ...binding(), sourceThreadId: "bad\nidentity" },
        async () => target(),
        "peer",
      ),
      { code: "invalid_request" },
    );
    await assert.rejects(
      gateway.execute(
        {
          ...payload,
          admissionId: makeRemoteToolAdmissionId(
            payload.createdAtMs,
            payload.expiresAtMs,
            "extra",
          ),
          cwd: "/caller",
        } as never,
        async () => target(),
        signal(),
        "peer",
      ),
      { code: "invalid_request" },
    );
  } finally {
    await tools.close();
  }
});

test("immutable acceptance identity cannot be renewed after expiry and allows bounded clock skew", async () => {
  let calls = 0;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async () => {
        calls++;
        return { output: "once", exitCode: 0 };
      }),
    ],
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    await assert.rejects(
      gateway.execute(
        {
          ...payload,
          createdAtMs: payload.createdAtMs + 1,
          expiresAtMs: payload.expiresAtMs + 1,
        },
        async () => target(),
        signal(),
        "peer",
      ),
      { code: "invalid_request" },
    );
    const futureStart = Date.now() + 1000;
    const futureEnd = futureStart + 60_000;
    const result = await gateway.execute(
      {
        ...payload,
        admissionId: makeRemoteToolAdmissionId(
          futureStart,
          futureEnd,
          "clock-skew",
        ),
        createdAtMs: futureStart,
        expiresAtMs: futureEnd,
      },
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
  } finally {
    await tools.close();
  }
});

test("target gateway prepares exact local runtime and rejects non-domain routing selectors", async () => {
  let transitRoutes = 0;
  let localCalls = 0;
  const runtime = ordinary(async (call) => {
    localCalls++;
    return { output: String(call.arguments.device ?? "local"), exitCode: 0 };
  });
  Object.assign(runtime.specification, {
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" }, value: { type: "integer" } },
      additionalProperties: true,
    },
  });
  const tools = new ToolEnvironment({ runtimes: [runtime] });
  tools.setTargetRouter({
    prepare(invocation) {
      transitRoutes++;
      return {
        owner: { kind: "builtin", id: "transit" },
        definition: runtime.specification,
        executionMode: "exclusive",
        async execute() {
          return { output: `transit:${invocation.name}`, exitCode: 0 };
        },
      };
    },
  });
  const gateway = new FleetToolGateway({
    tools,
    hostId: "host",
    processEpoch: "epoch",
  });
  try {
    const payload = await request(gateway);
    const result = await gateway.execute(
      { ...payload, arguments: { device: "domain-device", value: 7 } },
      async () => target(),
      signal(),
      "peer",
    );
    assert.equal(result.output, "domain-device");
    await assert.rejects(
      gateway.execute(
        {
          ...payload,
          admissionId: makeRemoteToolAdmissionId(
            payload.createdAtMs,
            payload.expiresAtMs,
            "routing-extra",
          ),
          arguments: { value: 7, target_context: { workspace: "third-host" } },
        },
        async () => target(),
        signal(),
        "peer",
      ),
      { code: "invalid_request" },
    );
    assert.equal(localCalls, 1);
    assert.equal(transitRoutes, 0);
  } finally {
    await tools.close();
  }
});
