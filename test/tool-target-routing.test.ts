import assert from "node:assert/strict";
import test from "node:test";
import { ApplyPatchToolRuntime } from "../src/apply-patch.js";
import {
  InMemoryToolPolicyStore,
  ShellToolRuntime,
  ToolEnvironment,
  type ApprovalRequest,
  type ToolExecutionResult,
  type ToolInvocation,
  type ToolRemoteDefinitionEntry,
  type ToolRuntime,
  type ToolTargetRoute,
  type ToolTargetRouter,
} from "../src/tool.js";

function invocation(
  name = "ordinary",
  args: Record<string, unknown> = {},
): ToolInvocation {
  return {
    callId: "call",
    canonicalToolCallId: "canonical",
    name,
    arguments: args,
    cwd: "/caller",
    threadId: "caller",
    signal: new AbortController().signal,
  };
}

function ordinary(
  execute: ToolRuntime["execute"] = async () => ({
    output: "local",
    exitCode: 0,
  }),
): ToolRuntime {
  return {
    name: "ordinary",
    remoteExecution: "text-json",
    specification: {
      name: "ordinary",
      description: "ordinary",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
    execute,
  };
}

function route(
  local: ToolRemoteDefinitionEntry | undefined,
  execute: ToolTargetRoute["execute"],
  waitPolicyExempt = false,
): ToolTargetRoute {
  return {
    owner: { kind: "external", id: "fleet-target" },
    definition: local?.definition ?? ordinary().specification,
    executionMode: "parallel_safe",
    waitPolicyExempt,
    execute,
  };
}

function router(
  execute: (call: ToolInvocation) => Promise<ToolExecutionResult>,
): ToolTargetRouter {
  return {
    prepare(call, local) {
      if (call.arguments.device !== "peer" || local?.eligible === false)
        return undefined;
      return route(local, () => execute(call));
    },
  };
}

function approval(call: ToolInvocation): ApprovalRequest {
  return {
    threadId: "caller",
    turnId: "turn",
    itemId: "canonical",
    callId: call.callId,
    command: call.name,
    cwd: call.cwd,
    signal: call.signal,
  };
}

test("task timing argument lookup clones only the current target runtime mapping", async () => {
  const mapping = { yieldTimeMs: "yield_time_ms", timeoutMs: "timeout_ms" };
  const runtime = { ...ordinary(), taskPolicy: { timingArguments: mapping } };
  const tools = new ToolEnvironment({ runtimes: [runtime] });
  try {
    const catalog = tools.remoteDefinitions;
    const schema = structuredClone(runtime.specification.inputSchema);
    const read = tools.taskTimingArguments("ordinary")!;
    assert.deepEqual(read, mapping);
    read.timeoutMs = "caller-mutation";
    assert.deepEqual(tools.taskTimingArguments("ordinary"), mapping);
    assert.equal(tools.taskTimingArguments("unknown"), undefined);
    assert.deepEqual(tools.remoteDefinitions, catalog);
    assert.deepEqual(
      tools.definitions.find((entry) => entry.name === "ordinary")!.inputSchema,
      schema,
    );
    const replacement = {
      ...ordinary(),
      taskPolicy: { timingArguments: { timeoutMs: "deadline_ms" } },
    };
    tools
      .stageBundle(
        { identity: { kind: "builtin", id: "ordinary" }, tools: [replacement] },
        { replaceCurrent: true },
      )
      .publish();
    assert.deepEqual(tools.taskTimingArguments("ordinary"), {
      timeoutMs: "deadline_ms",
    });
    tools.unregisterBundle({ kind: "builtin", id: "ordinary" });
    assert.equal(tools.taskTimingArguments("ordinary"), undefined);
  } finally {
    await tools.close();
  }
});

test("remote definitions are fresh exact-generation snapshots with explicit eligibility", async () => {
  const composite = {
    ...ordinary(),
    name: "composite",
    specification: { ...ordinary().specification, name: "composite" },
    async executeComposite() {
      return { output: "composite", exitCode: 0 };
    },
  };
  const media: ToolRuntime = {
    ...ordinary(),
    name: "media",
    specification: { ...ordinary().specification, name: "media" },
    requiredModelInputModalities: ["image"],
  };
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(),
      new ShellToolRuntime(),
      new ApplyPatchToolRuntime(),
      composite,
      media,
    ],
  });
  try {
    const first = tools.remoteDefinitions;
    assert.equal(
      first.find((entry) => entry.definition.name === "ordinary")!.eligible,
      true,
    );
    assert.equal(
      first.find((entry) => entry.definition.name === "shell")!.eligible,
      true,
    );
    assert.equal(
      first.find((entry) => entry.definition.name === "apply_patch")!.eligible,
      true,
    );
    for (const name of ["wait", "composite", "media"])
      assert.equal(
        first.find((entry) => entry.definition.name === name)!.eligible,
        false,
      );
    const previous = first.find(
      (entry) => entry.definition.name === "ordinary",
    )!;
    previous.definition.description = "mutated";
    previous.owner.id = "mutated";
    assert.equal(
      tools.remoteDefinitions.find(
        (entry) => entry.definition.name === "ordinary",
      )!.definition.description,
      "ordinary",
    );
    assert.equal(
      tools.remoteDefinitions.find(
        (entry) => entry.definition.name === "ordinary",
      )!.owner.id,
      "ordinary",
    );
    const staged = tools.stageBundle(
      { identity: { kind: "builtin", id: "ordinary" }, tools: [ordinary()] },
      { replaceCurrent: true },
    );
    assert.equal(
      tools.remoteDefinitions.find(
        (entry) => entry.definition.name === "ordinary",
      )!.generation,
      previous.generation,
    );
    staged.publish();
    assert.notEqual(
      tools.remoteDefinitions.find(
        (entry) => entry.definition.name === "ordinary",
      )!.generation,
      previous.generation,
    );
  } finally {
    await tools.close();
  }
});

test("default calls remain local and routed bodies retain no local bundle or task", async () => {
  let retained = 0;
  let released = 0;
  let localCalls = 0;
  let remoteCalls = 0;
  const tools = new ToolEnvironment({
    bundles: [
      {
        identity: { kind: "builtin", id: "ordinary" },
        tools: [
          ordinary(async () => {
            localCalls++;
            return { output: "local", exitCode: 0 };
          }),
        ],
        retainPreparedInvocation() {
          retained++;
          return () => {
            released++;
          };
        },
      },
    ],
    targetRouter: router(async () => {
      remoteCalls++;
      return { output: "remote", exitCode: 0 };
    }),
  });
  try {
    assert.equal(
      (await tools.execute(tools.prepare(invocation()))).output,
      "local",
    );
    assert.equal(retained, 1);
    assert.equal(released, 1);
    const remote = tools.prepare(invocation("ordinary", { device: "peer" }));
    assert.equal((await tools.execute(remote)).output, "remote");
    assert.equal(tools.taskManager.ownsInvocation(remote.invocation), false);
    assert.equal(tools.taskManager.activeTaskCount, 0);
    assert.equal(localCalls, 1);
    assert.equal(remoteCalls, 1);
    assert.equal(retained, 1);
    assert.equal(released, 1);
    const discarded = tools.prepare(invocation());
    tools.discard(discarded);
    tools.discard(discarded);
    assert.equal(retained, 2);
    assert.equal(released, 2);
    await assert.rejects(tools.execute(discarded), /not prepared/);
  } finally {
    await tools.close();
  }
});

test("target transport never consumes a caller execution slot or local resource claim", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async () => {
        await pending;
        return { output: "local done", exitCode: 0 };
      }),
    ],
    taskOptions: { maxRunningTasks: 1, yieldTimeMs: 1 },
    targetRouter: router(async () => ({ output: "remote done", exitCode: 0 })),
  });
  try {
    const first = await tools.execute(tools.prepare(invocation()));
    assert.equal(tools.taskManager.activeTaskCount, 1);
    assert.equal(
      (
        await tools.execute(
          tools.prepare(invocation("ordinary", { device: "peer" })),
        )
      ).output,
      "remote done",
    );
    assert.equal(tools.taskManager.activeTaskCount, 1);
    await assert.rejects(
      tools.execute(tools.prepare(invocation())),
      /capacity is busy/,
    );
    finish();
    const taskId = (first.structuredContent as { task_id: string }).task_id;
    await tools.execute(
      tools.prepare(
        invocation("wait", { task_id: taskId, yield_time_ms: 100 }),
      ),
    );
    assert.equal(tools.taskManager.activeTaskCount, 0);
  } finally {
    finish();
    await tools.close();
  }
});

test("remote caller admission retains deny/ask policy while target owns filesystem sandbox", async () => {
  let executions = 0;
  const denied = new ToolEnvironment({
    runtimes: [ordinary()],
    policyStore: new InMemoryToolPolicyStore({ ordinary: "denied" }),
    targetRouter: router(async () => {
      executions++;
      return { output: "remote", exitCode: 0 };
    }),
  });
  const call = {
    ...invocation("ordinary", { device: "peer" }),
    sandbox: "read-only" as const,
  };
  try {
    const prepared = denied.prepare(call);
    assert.equal(
      await denied.admit(prepared, {
        policy: "ask_unknown",
        approvalRequest: approval(call),
      }),
      "decline",
    );
    await assert.rejects(denied.execute(prepared), /not prepared/);
    assert.equal(executions, 0);
  } finally {
    await denied.close();
  }
  const tools = new ToolEnvironment({
    runtimes: [ordinary()],
    targetRouter: router(async () => ({ output: "remote", exitCode: 0 })),
  });
  try {
    let requests = 0;
    const prepared = tools.prepare(call);
    assert.equal(
      await tools.admit(prepared, {
        policy: "ask_unknown",
        approvalRequest: approval(call),
        requestApproval: async (request) => {
          requests++;
          assert.equal(request.scope, undefined);
          assert.equal(request.command, "ordinary");
          return "accept";
        },
      }),
      "accept",
    );
    assert.equal(requests, 1);
    assert.equal((await tools.execute(prepared)).output, "remote");
  } finally {
    await tools.close();
  }
});

test("qualified remote wait and cancellation use the route and preserve wait exemption", async () => {
  const calls: ToolInvocation[] = [];
  const tools = new ToolEnvironment({
    policyStore: new InMemoryToolPolicyStore({ wait: "denied" }),
    targetRouter: {
      prepare(call, local) {
        if (call.name !== "wait" || call.arguments.task_id !== "remote:opaque")
          return undefined;
        return route(
          local,
          async () => {
            calls.push(call);
            return {
              output: call.arguments.terminate
                ? "cancellation requested"
                : "running",
              exitCode: 0,
            };
          },
          true,
        );
      },
    },
  });
  try {
    for (const terminate of [false, true]) {
      const call = {
        ...invocation("wait", { task_id: "remote:opaque", terminate }),
        sandbox: "read-only" as const,
      };
      const prepared = tools.prepare(call);
      assert.equal(
        await tools.admit(prepared, {
          policy: "ask_unknown",
          approvalRequest: approval(call),
        }),
        "accept",
      );
      assert.equal(await tools.admitInherited(prepared), "accept");
      assert.equal(
        (await tools.execute(prepared)).output,
        terminate ? "cancellation requested" : "running",
      );
      assert.equal(
        tools.taskManager.ownsInvocation(prepared.invocation),
        false,
      );
    }
    assert.deepEqual(
      calls.map((call) => call.arguments.terminate),
      [false, true],
    );
    assert.equal(tools.taskManager.activeTaskCount, 0);
  } finally {
    await tools.close();
  }
});

test("explicit unsupported targets never fall back, and disclosed remote-only facades need no local registration", async () => {
  let localCalls = 0;
  const local = ordinary(async () => {
    localCalls++;
    return { output: "local", exitCode: 0 };
  });
  const tools = new ToolEnvironment({ runtimes: [local] });
  try {
    assert.throws(
      () => tools.prepare(invocation("ordinary", { device: "peer" })),
      /target is unavailable/,
    );
    tools.setTargetRouter({
      prepare(call, entry) {
        if (call.name === "disclosed_only" && call.arguments.device === "peer")
          return {
            ...route(entry, async () => ({ output: "proxy", exitCode: 0 })),
            definition: { ...ordinary().specification, name: "disclosed_only" },
          };
        return undefined;
      },
    });
    assert.equal(
      (
        await tools.execute(
          tools.prepare(invocation("disclosed_only", { device: "peer" })),
        )
      ).output,
      "proxy",
    );
    assert.throws(
      () => tools.prepare(invocation("undisclosed", { device: "peer" })),
      /target is unavailable/,
    );
    assert.throws(
      () =>
        tools.prepare(invocation("wait", { task_id: "local", device: "peer" })),
      /target is unavailable/,
    );
    assert.equal(localCalls, 0);
  } finally {
    await tools.close();
  }
  const ineligible = new ToolEnvironment({
    runtimes: [
      {
        name: "ordinary",
        specification: ordinary().specification,
        execute: ordinary().execute,
      },
    ],
    targetRouter: router(async () => ({ output: "wrong", exitCode: 0 })),
  });
  try {
    assert.throws(
      () => ineligible.prepare(invocation("ordinary", { device: "peer" })),
      /not eligible/,
    );
  } finally {
    await ineligible.close();
  }
});

test("Host-owned Fleet facades route despite ordinary remote eligibility exclusions", async () => {
  const names = [
    "zenx_fleet_tools",
    "zenx_fleet_execute",
    "zenx_fleet_tool_status",
  ];
  const tools = new ToolEnvironment({
    runtimes: names.map((name) => ({
      name,
      specification: { ...ordinary().specification, name },
      async execute() {
        throw new Error("local facade must not execute");
      },
    })),
    targetRouter: {
      prepare(call, local) {
        if (!names.includes(call.name)) return undefined;
        assert.equal(local?.eligible, false);
        return route(local, async () => ({ output: call.name, exitCode: 0 }));
      },
    },
  });
  try {
    for (const name of names) {
      const prepared = tools.prepare(invocation(name, { device: "peer" }));
      assert.equal((await tools.execute(prepared)).output, name);
      assert.equal(
        tools.taskManager.ownsInvocation(prepared.invocation),
        false,
      );
    }
  } finally {
    await tools.close();
  }
});

test("explicit local metadata reaches the router raw and is stripped before domain execution", async () => {
  let rawDevice: unknown;
  const tools = new ToolEnvironment({
    runtimes: [
      ordinary(async (call) => {
        assert.deepEqual(call.arguments, { value: "domain" });
        return { output: "local", exitCode: 0 };
      }),
    ],
    targetRouter: {
      prepare(call) {
        rawDevice = call.arguments.device;
        return undefined;
      },
    },
  });
  try {
    assert.equal(
      (
        await tools.execute(
          tools.prepare(
            invocation("ordinary", { device: "local", value: "domain" }),
          ),
        )
      ).output,
      "local",
    );
    assert.equal(rawDevice, "local");
    assert.throws(
      () =>
        tools.prepare(
          invocation("ordinary", {
            device: "local",
            target_context: { workspace: "remote" },
          }),
        ),
      /target is unavailable/,
    );
  } finally {
    await tools.close();
  }
});

test("routing metadata never pollutes local definitions or consumes domain-owned argument names", async () => {
  const runtime = {
    ...ordinary(),
    specification: {
      ...ordinary().specification,
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string" },
          target_context: { type: "string" },
        },
      },
    },
    async execute(call: ToolInvocation) {
      return {
        output:
          String(call.arguments.device) +
          ":" +
          String(call.arguments.target_context),
        exitCode: 0,
      };
    },
  };
  const tools = new ToolEnvironment({ runtimes: [runtime] });
  try {
    assert.deepEqual(
      tools.definitions.find((entry) => entry.name === "ordinary")!.inputSchema,
      runtime.specification.inputSchema,
    );
    assert.equal(
      (
        await tools.execute(
          tools.prepare(
            invocation("ordinary", {
              device: "domain-value",
              target_context: "domain-context",
            }),
          ),
        )
      ).output,
      "domain-value:domain-context",
    );
    const shell = new ToolEnvironment({ runtimes: [new ShellToolRuntime()] });
    try {
      const props = shell.definitions.find((entry) => entry.name === "shell")!
        .inputSchema.properties as Record<string, unknown>;
      assert.equal(props.device, undefined);
      assert.equal(props.target_context, undefined);
    } finally {
      await shell.close();
    }
  } finally {
    await tools.close();
  }
});

test("prepared routes are immutable and survive later router replacement", async () => {
  const args = { device: "peer", nested: { value: "captured" } };
  let captured!: ToolInvocation;
  const tools = new ToolEnvironment({
    runtimes: [ordinary()],
    targetRouter: router(async (call) => {
      captured = call;
      return {
        output: String((call.arguments.nested as { value: string }).value),
        exitCode: 0,
      };
    }),
  });
  try {
    const prepared = tools.prepare(invocation("ordinary", args));
    args.nested.value = "mutated";
    tools.setTargetRouter(
      router(async () => ({ output: "replacement", exitCode: 0 })),
    );
    assert.equal((await tools.execute(prepared)).output, "captured");
    assert.equal(Object.isFrozen(captured.arguments.nested), true);
    assert.equal(
      (await tools.execute(tools.prepare(invocation("ordinary", args)))).output,
      "replacement",
    );
  } finally {
    await tools.close();
  }
});

test("remote results retain ordinary normalization and reject media", async () => {
  const tools = new ToolEnvironment({
    runtimes: [ordinary()],
    targetRouter: router(async () => ({
      output: "remote",
      exitCode: 0,
      contentType: "fixture/card",
      structuredContent: { value: "target-normalized" },
    })),
  });
  try {
    const result = await tools.execute(
      tools.prepare(invocation("ordinary", { device: "peer" })),
    );
    assert.equal(result.contentType, "fixture/card");
    assert.equal(Object.isFrozen(result.structuredContent), true);
    tools.setTargetRouter(
      router(async () => ({ output: "invalid", exitCode: NaN })),
    );
    await assert.rejects(
      tools.execute(tools.prepare(invocation("ordinary", { device: "peer" }))),
      /invalid output or exit code/,
    );
    tools.setTargetRouter(
      router(async () => ({
        output: "media",
        exitCode: 0,
        modelContent: [{ type: "text", text: "injected" }],
      })),
    );
    await assert.rejects(
      tools.execute(tools.prepare(invocation("ordinary", { device: "peer" }))),
      /text\/JSON results only/,
    );
    tools.setTargetRouter({
      prepare(call, local) {
        return {
          ...route(local, async () => ({
            output: "bad namespace",
            exitCode: 0,
            contentType: "other/card",
            structuredContent: {},
          })),
          owner: { kind: "plugin", id: "fixture" },
        };
      },
    });
    await assert.rejects(
      tools.execute(tools.prepare(invocation("ordinary", { device: "peer" }))),
      /does not own/,
    );
  } finally {
    await tools.close();
  }
});

test("task status snapshots enforce thread ownership and never drain output", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tools = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 1 },
    runtimes: [
      ordinary(async (call) => {
        await pending;
        call.taskContext?.onOutput("incremental-after-snapshot");
        return { output: "tail", exitCode: 0 };
      }),
    ],
  });
  try {
    const first = await tools.execute(tools.prepare(invocation()));
    const taskId = (first.structuredContent as { task_id: string }).task_id;
    assert.throws(() => tools.taskManager.status("other", taskId), /not found/);
    assert.equal(
      (
        tools.taskManager.status("caller", taskId).structuredContent as {
          status: string;
        }
      ).status,
      "running",
    );
    finish();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      (
        tools.taskManager.status("caller", taskId).structuredContent as {
          status: string;
        }
      ).status,
      "completed",
    );
    const result = await tools.execute(
      tools.prepare(
        invocation("wait", { task_id: taskId, yield_time_ms: 100 }),
      ),
    );
    assert.match(result.output, /incremental-after-snapshot/);
    assert.match(result.output, /tail/);
    assert.throws(
      () => tools.taskManager.status("caller", taskId),
      /not found/,
    );
  } finally {
    finish();
    await tools.close();
  }
});

test("target gateway local binding never consults a caller target router", async () => {
  let routes = 0;
  const environment = new ToolEnvironment({
    runtimes: [
      {
        name: "target_owned",
        remoteExecution: "text-json",
        specification: {
          name: "target_owned",
          description: "local target",
          inputSchema: { type: "object", properties: {} },
        },
        execute: async () => ({
          output: "executed on selected target",
          exitCode: 0,
        }),
      },
    ],
    targetRouter: {
      prepare: () => {
        routes++;
        throw new Error("should never consult routing");
      },
    },
  });
  try {
    const prepared = environment.prepare(
      {
        callId: "target-call",
        name: "target_owned",
        arguments: {},
        cwd: process.cwd(),
        threadId: "target-thread",
        signal: new AbortController().signal,
      },
      { targetRouting: false },
    );
    assert.equal(
      (await environment.execute(prepared)).output,
      "executed on selected target",
    );
    assert.equal(routes, 0);
  } finally {
    await environment.close();
  }
});
