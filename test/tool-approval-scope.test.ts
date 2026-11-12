import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryToolPolicyStore,
  SetToolPolicyStore,
  ToolEnvironment,
  type ApprovalHandler,
  type ApprovalRequest,
  type CompositeToolRuntime,
  type PreparedToolInvocation,
  type ToolApprovalScope,
  type ToolInvocation,
  type ToolPolicyStore,
  type ToolRuntime,
} from "../src/tool.js";

const toolName = "browser_external";

function invocation(instance = "a", name = toolName): ToolInvocation {
  return {
    callId: `${name}-${instance}`,
    name,
    arguments: { instance, nested: { value: "original" } },
    cwd: "/workspace",
    threadId: "thread",
    signal: new AbortController().signal,
  };
}

function runtime(overrides: Partial<ToolRuntime> = {}): ToolRuntime {
  return {
    name: toolName,
    specification: { name: toolName, description: "Browser", inputSchema: {} },
    approvalScope: (call) => ({
      key: String(call.arguments.instance),
      label: `Browser ${String(call.arguments.instance)}`,
      generation: "generation-1",
    }),
    execute: async () => ({ output: "executed", exitCode: 0 }),
    ...overrides,
  };
}

function request(prepared: PreparedToolInvocation): ApprovalRequest {
  return {
    threadId: "thread",
    turnId: "turn",
    itemId: prepared.invocation.callId,
    callId: prepared.invocation.callId,
    command: "navigate",
    cwd: prepared.invocation.cwd,
    signal: prepared.invocation.signal,
  };
}

function admit(
  environment: ToolEnvironment,
  prepared: PreparedToolInvocation,
  requestApproval?: ApprovalHandler,
  policy: "ask_unknown" | "full_access" = "ask_unknown",
) {
  return environment.admit(prepared, {
    policy,
    approvalRequest: request(prepared),
    ...(requestApproval === undefined ? {} : { requestApproval }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

for (const kind of ["memory", "sets"] as const) {
  test(`${kind} policy storage separates scope, tool name, and legacy grants`, async () => {
    const store =
      kind === "memory"
        ? new InMemoryToolPolicyStore({ [toolName]: "approved" })
        : new SetToolPolicyStore({
            approvedTools: new Set([toolName]),
            deniedTools: new Set(),
          });
    await store.setScoped(toolName, "a", "denied");
    assert.equal(await store.get(toolName), "approved");
    assert.equal(await store.getScoped(toolName, "a"), "denied");
    assert.equal(await store.getScoped(toolName, "b"), undefined);
    assert.equal(await store.getScoped("other", "a"), undefined);
    await store.setScoped(toolName, "a", "approved");
    assert.equal(await store.getScoped(toolName, "a"), "approved");
    await store.set(`${toolName}:b`, "approved");
    await store.set(JSON.stringify([toolName, "b"]), "approved");
    assert.equal(await store.getScoped(toolName, "b"), undefined);
  });
}

test("legacy grants and instance A approval never admit instance B", async () => {
  const store = new InMemoryToolPolicyStore({ [toolName]: "approved" });
  const environment = new ToolEnvironment({
    runtimes: [runtime()],
    policyStore: store,
  });
  const prompts: ApprovalRequest[] = [];
  const approve: ApprovalHandler = async (prompt) => {
    prompts.push(prompt);
    return "accept";
  };
  try {
    assert.equal(
      await admit(environment, environment.prepare(invocation()), approve),
      "accept",
    );
    assert.equal(
      await admit(environment, environment.prepare(invocation()), approve),
      "accept",
    );
    assert.equal(
      await admit(environment, environment.prepare(invocation("b")), approve),
      "accept",
    );
    assert.equal(prompts.length, 2);
    assert.deepEqual(
      prompts.map((prompt) => prompt.approvalTarget),
      [
        { key: "a", label: "Browser a" },
        { key: "b", label: "Browser b" },
      ],
    );
    assert.match(prompts[0]!.command, /^\[Target: Browser a\]\nnavigate$/u);
    assert.equal(await store.get(toolName), "approved");
    assert.equal(await store.getScoped(toolName, "a"), "approved");
    assert.equal(await store.getScoped(toolName, "b"), "approved");
  } finally {
    await environment.close();
  }
});

test("scoped denial deduplicates same-instance prompts without blocking siblings", async () => {
  const environment = new ToolEnvironment({ runtimes: [runtime()] });
  const firstPrompt = deferred<void>();
  const secondPrompt = deferred<void>();
  const firstDecision = deferred<"decline">();
  const prompts: string[] = [];
  const approve: ApprovalHandler = async (prompt) => {
    const key = prompt.approvalTarget!.key;
    prompts.push(key);
    if (key === "a") {
      firstPrompt.resolve();
      return firstDecision.promise;
    }
    secondPrompt.resolve();
    return "accept";
  };
  try {
    const a = admit(environment, environment.prepare(invocation()), approve);
    await firstPrompt.promise;
    const again = admit(
      environment,
      environment.prepare(invocation()),
      approve,
    );
    const b = admit(environment, environment.prepare(invocation("b")), approve);
    await secondPrompt.promise;
    firstDecision.resolve("decline");
    assert.deepEqual(await Promise.all([a, again, b]), [
      "decline",
      "decline",
      "accept",
    ]);
    assert.deepEqual(prompts, ["a", "b"]);
    assert.equal(
      await admit(environment, environment.prepare(invocation()), approve),
      "decline",
    );
    assert.equal(prompts.length, 2);
  } finally {
    firstDecision.resolve("decline");
    await environment.close();
  }
});

test("cancelled scoped prompts are not remembered or inherited by siblings", async () => {
  const store = new InMemoryToolPolicyStore();
  const environment = new ToolEnvironment({
    runtimes: [runtime()],
    policyStore: store,
  });
  try {
    assert.equal(
      await admit(
        environment,
        environment.prepare(invocation()),
        async () => "cancel",
      ),
      "cancel",
    );
    assert.equal(await store.getScoped(toolName, "a"), undefined);
    assert.equal(
      await admit(
        environment,
        environment.prepare(invocation()),
        async () => "accept",
      ),
      "accept",
    );
    assert.equal(
      await environment.admitInherited(environment.prepare(invocation("b"))),
      "decline",
    );
  } finally {
    await environment.close();
  }
});

for (const support of ["neither", "get-only", "set-only"] as const) {
  test(`missing scoped store support (${support}) fails closed without unscoped access`, async () => {
    let legacyReads = 0;
    let writes = 0;
    let prompts = 0;
    const store: ToolPolicyStore = {
      async get() {
        legacyReads += 1;
        return "approved";
      },
      async set() {
        writes += 1;
      },
      ...(support === "get-only"
        ? { getScoped: async () => "approved" as const }
        : {}),
      ...(support === "set-only"
        ? {
            setScoped: async () => {
              writes += 1;
            },
          }
        : {}),
    };
    const environment = new ToolEnvironment({
      runtimes: [runtime()],
      policyStore: store,
    });
    try {
      await assert.rejects(
        admit(environment, environment.prepare(invocation()), async () => {
          prompts += 1;
          return "accept";
        }),
        /scoped.*policy|policy.*scoped/iu,
      );
      await assert.rejects(
        environment.admitInherited(environment.prepare(invocation())),
        /scoped.*policy|policy.*scoped/iu,
      );
      assert.equal(legacyReads, 0);
      assert.equal(writes, 0);
      assert.equal(prompts, 0);
    } finally {
      await environment.close();
    }
  });
}

test("scope resolver sees deep-frozen arguments and executes the captured immutable snapshot", async () => {
  const original = invocation();
  const scope = { key: "a", label: "Browser a", generation: "generation-1" };
  let resolved = 0;
  let received: ToolInvocation | undefined;
  const environment = new ToolEnvironment({
    runtimes: [
      runtime({
        approvalScope(call) {
          resolved += 1;
          assert(Object.isFrozen(call));
          assert(Object.isFrozen(call.arguments));
          assert(Object.isFrozen(call.arguments.nested));
          assert.throws(() => {
            (call.arguments.nested as { value: string }).value = "forged";
          }, TypeError);
          return scope;
        },
        async execute(call) {
          received = call;
          return { output: "executed", exitCode: 0 };
        },
      }),
    ],
  });
  try {
    const prepared = environment.prepare(original);
    original.arguments.instance = "b";
    (original.arguments.nested as { value: string }).value = "changed";
    scope.key = "b";
    scope.generation = "generation-2";
    assert.deepEqual(prepared.approvalScope, {
      key: "a",
      label: "Browser a",
      generation: "generation-1",
    });
    assert(Object.isFrozen(prepared.approvalScope));
    await admit(environment, prepared, async () => "accept");
    await environment.execute(prepared);
    assert.equal(resolved, 1);
    assert.equal(received!.arguments.instance, "a");
    assert.equal(
      (received!.arguments.nested as { value: string }).value,
      "original",
    );
    assert.deepEqual(received!.approvalScope, prepared.approvalScope);
    assert(Object.isFrozen(received!.approvalScope));
  } finally {
    await environment.close();
  }
});

test("caller-supplied top-level scopes are rejected before resolver or routing", async () => {
  let resolved = 0;
  const environment = new ToolEnvironment({
    runtimes: [
      runtime({
        approvalScope() {
          resolved += 1;
          return undefined;
        },
      }),
    ],
  });
  try {
    assert.throws(
      () =>
        environment.prepare({
          ...invocation(),
          approvalScope: { key: "a", label: "Forged", generation: "forged" },
        }),
      /trusted|scope/iu,
    );
    assert.equal(resolved, 0);
  } finally {
    await environment.close();
  }
});

test("malformed trusted scope is rejected instead of becoming an unscoped grant", async () => {
  for (const scope of [
    null,
    {},
    { key: "a", label: "Browser a" },
    { key: "", label: "Browser a", generation: "one" },
  ]) {
    const environment = new ToolEnvironment({
      runtimes: [runtime({ approvalScope: () => scope as ToolApprovalScope })],
    });
    try {
      assert.throws(() => environment.prepare(invocation()), /scope/iu);
    } finally {
      await environment.close();
    }
  }
});

test("inherited scoped admission requires the exact scoped grant and preserves sibling denial", async () => {
  const store = new InMemoryToolPolicyStore({
    [toolName]: "approved",
    run_code: "approved",
  });
  const environment = new ToolEnvironment({
    runtimes: [runtime()],
    policyStore: store,
  });
  try {
    assert.equal(
      await environment.admitInherited(environment.prepare(invocation())),
      "decline",
    );
    await store.setScoped(toolName, "a", "approved");
    await store.setScoped(toolName, "b", "denied");
    assert.equal(
      await environment.admitInherited(environment.prepare(invocation())),
      "accept",
    );
    assert.equal(
      await environment.admitInherited(environment.prepare(invocation("b"))),
      "decline",
    );
  } finally {
    await environment.close();
  }
});

test("explicit full access still bypasses scoped policy for direct calls", async () => {
  const store = new InMemoryToolPolicyStore();
  await store.setScoped(toolName, "a", "denied");
  const environment = new ToolEnvironment({
    runtimes: [runtime()],
    policyStore: store,
  });
  try {
    assert.equal(
      await admit(
        environment,
        environment.prepare(invocation()),
        async () => {
          assert.fail("Full Access must not prompt");
        },
        "full_access",
      ),
      "accept",
    );
    assert.equal(await store.getScoped(toolName, "a"), "denied");
  } finally {
    await environment.close();
  }
});

test("ordinary tools preserve remembered grants, inherited unknown admission, and full access", async () => {
  const ordinary: ToolRuntime = {
    name: "ordinary",
    specification: {
      name: "ordinary",
      description: "Ordinary",
      inputSchema: {},
    },
    execute: async () => ({ output: "ordinary", exitCode: 0 }),
  };
  const store = new InMemoryToolPolicyStore({ ordinary: "approved" });
  const environment = new ToolEnvironment({
    runtimes: [ordinary],
    policyStore: store,
  });
  try {
    const call = () => environment.prepare(invocation("a", "ordinary"));
    assert.equal(await admit(environment, call()), "accept");
    await store.set("ordinary", "denied");
    assert.equal(await admit(environment, call()), "decline");
    assert.equal(
      await admit(environment, call(), undefined, "full_access"),
      "accept",
    );
    assert.equal(await environment.admitInherited(call()), "decline");
    const unknown = new ToolEnvironment({ runtimes: [ordinary] });
    try {
      assert.equal(
        await unknown.admitInherited(
          unknown.prepare(invocation("a", "ordinary")),
        ),
        "accept",
      );
    } finally {
      await unknown.close();
    }
  } finally {
    await environment.close();
  }
});

test("one-time sandbox approval identifies the scoped target without remembering a grant", async () => {
  const store = new InMemoryToolPolicyStore();
  const environment = new ToolEnvironment({
    runtimes: [runtime()],
    policyStore: store,
  });
  try {
    const prepared = environment.prepare({
      ...invocation(),
      sandbox: "workspace-write",
    });
    assert.equal(
      await admit(environment, prepared, async (prompt) => {
        assert.equal(prompt.scope, "once");
        assert.deepEqual(prompt.approvalTarget, {
          key: "a",
          label: "Browser a",
        });
        assert.match(prompt.command, /Target: Browser a/u);
        return "accept";
      }),
      "accept",
    );
    assert.equal(await store.getScoped(toolName, "a"), undefined);
  } finally {
    await environment.close();
  }
});

function composite(scope?: ToolApprovalScope): CompositeToolRuntime {
  return {
    name: "run_code",
    specification: {
      name: "run_code",
      description: "Composite",
      inputSchema: {},
    },
    ...(scope === undefined ? {} : { approvalScope: () => scope }),
    execute: async () => ({ output: "unused", exitCode: 0 }),
    executeComposite: async () => ({ output: "unused", exitCode: 0 }),
  };
}

test("scoped inherited Full Access requires an exact admitted composite parent", async () => {
  const environment = new ToolEnvironment({
    runtimes: [runtime(), composite()],
  });
  const parent = environment.prepare(invocation("a", "run_code"));
  try {
    await assert.rejects(
      environment.admitInherited(environment.prepare(invocation()), parent),
      /admitted composite parent/u,
    );
    assert.equal(
      await admit(environment, parent, undefined, "full_access"),
      "accept",
    );
    assert.equal(
      await environment.admitInherited(
        environment.prepare(invocation()),
        parent,
      ),
      "accept",
    );
    assert.equal(
      await environment.admitInherited(
        environment.prepare(invocation("b")),
        parent,
      ),
      "accept",
    );
    await assert.rejects(
      environment.admitInherited(
        environment.prepare({ ...invocation(), threadId: "other" }),
        parent,
      ),
      /admitted composite parent/u,
    );
    await assert.rejects(
      environment.admitInherited(environment.prepare(invocation()), {
        ...parent,
      }),
      /not prepared/u,
    );
    environment.discard(parent);
    await assert.rejects(
      environment.admitInherited(environment.prepare(invocation()), parent),
      /not prepared/u,
    );
  } finally {
    await environment.close();
  }
});

test("a scoped parent approval cannot authorize a sibling instance", async () => {
  const environment = new ToolEnvironment({
    runtimes: [
      runtime(),
      composite({ key: "a", label: "Browser a", generation: "one" }),
    ],
  });
  try {
    const parent = environment.prepare(invocation("a", "run_code"));
    assert.equal(
      await admit(environment, parent, async () => "accept"),
      "accept",
    );
    assert.equal(
      await environment.admitInherited(
        environment.prepare(invocation("b")),
        parent,
      ),
      "decline",
    );
    assert.equal(
      await admit(environment, parent, undefined, "full_access"),
      "accept",
    );
    assert.equal(
      await environment.admitInherited(
        environment.prepare(invocation("b")),
        parent,
      ),
      "decline",
    );
  } finally {
    await environment.close();
  }
});

test("scoped Full Access authority stays bounded through unscoped composite children", async () => {
  const middle = {
    ...composite(),
    name: "middle",
    specification: { name: "middle", description: "Middle", inputSchema: {} },
  };
  const environment = new ToolEnvironment({
    runtimes: [
      runtime({
        approvalScope: (call) => ({
          key: String(call.arguments.instance),
          label: `Browser ${String(call.arguments.instance)}`,
          generation: String(call.arguments.generation ?? "generation-1"),
        }),
      }),
      composite({ key: "a", label: "Browser a", generation: "generation-1" }),
      middle,
    ],
  });
  try {
    const parent = environment.prepare(invocation("a", "run_code"));
    await admit(environment, parent, undefined, "full_access");
    const child = environment.prepare(invocation("a", "middle"));
    assert.equal(await environment.admitInherited(child, parent), "accept");
    assert.equal(
      await environment.admitInherited(
        environment.prepare(invocation("a")),
        child,
      ),
      "accept",
    );
    assert.equal(
      await environment.admitInherited(
        environment.prepare(invocation("b")),
        child,
      ),
      "decline",
    );
    assert.equal(
      await environment.admitInherited(
        environment.prepare({
          ...invocation(),
          arguments: { instance: "a", generation: "generation-2" },
        }),
        child,
      ),
      "decline",
    );
  } finally {
    await environment.close();
  }
});

for (const target of ["denied-sibling", "new-generation"] as const) {
  test(`unscoped Full Access narrows at an inherited scoped composite (${target})`, async () => {
    const scope = { key: "a", label: "Browser a", generation: "generation-1" };
    const middle = {
      ...composite(scope),
      name: "scoped_composite",
      specification: {
        name: "scoped_composite",
        description: "Scoped composite",
        inputSchema: {},
      },
    };
    const policyStore = new InMemoryToolPolicyStore();
    await policyStore.setScoped(toolName, "b", "denied");
    const environment = new ToolEnvironment({
      policyStore,
      runtimes: [
        composite(),
        middle,
        runtime({
          approvalScope: (call) => ({
            key: String(call.arguments.instance),
            label: `Browser ${String(call.arguments.instance)}`,
            generation: String(call.arguments.generation ?? "generation-1"),
          }),
        }),
      ],
    });
    try {
      const parent = environment.prepare(invocation("a", "run_code"));
      await admit(environment, parent, undefined, "full_access");
      const child = environment.prepare(invocation("a", "scoped_composite"));
      assert.equal(await environment.admitInherited(child, parent), "accept");
      assert.equal(
        await environment.admitInherited(
          environment.prepare(invocation("a")),
          child,
        ),
        "accept",
      );
      const targetCall =
        target === "denied-sibling"
          ? invocation("b")
          : {
              ...invocation("a"),
              arguments: { instance: "a", generation: "generation-2" },
            };
      assert.equal(
        await environment.admitInherited(
          environment.prepare(targetCall),
          child,
        ),
        "decline",
      );
      assert.equal(await policyStore.getScoped(toolName, "b"), "denied");
    } finally {
      await environment.close();
    }
  });
}

test("an independently approved cross-scope composite cannot lend its ancestor's Full Access", async () => {
  const middle = {
    ...composite({ key: "b", label: "Browser b", generation: "generation-1" }),
    name: "scoped_composite",
    specification: {
      name: "scoped_composite",
      description: "Scoped composite",
      inputSchema: {},
    },
  };
  const policyStore = new InMemoryToolPolicyStore();
  await policyStore.setScoped("scoped_composite", "b", "approved");
  const environment = new ToolEnvironment({
    policyStore,
    runtimes: [
      composite({ key: "a", label: "Browser a", generation: "generation-1" }),
      middle,
      runtime(),
    ],
  });
  try {
    const parent = environment.prepare(invocation("a", "run_code"));
    await admit(environment, parent, undefined, "full_access");
    const child = environment.prepare(invocation("b", "scoped_composite"));
    assert.equal(await environment.admitInherited(child, parent), "accept");
    for (const target of ["a", "b"]) {
      assert.equal(
        await environment.admitInherited(
          environment.prepare(invocation(target)),
          child,
        ),
        "decline",
      );
    }
  } finally {
    await environment.close();
  }
});

for (const kind of ["builtin", "plugin"] as const) {
  test(`registration rejects combining target scope with automatic sandbox admission (${kind})`, async () => {
    const policyStore = new InMemoryToolPolicyStore();
    await policyStore.setScoped(toolName, "a", "denied");
    const environment = new ToolEnvironment({ policyStore });
    try {
      assert.throws(
        () =>
          environment.registerRuntime(runtime({ enforcesSandbox: true }), {
            kind,
            id: "scoped",
          }),
        /approvalScope cannot be combined with enforcesSandbox/u,
      );
      assert(
        !environment.definitions.some(
          (definition) => definition.name === toolName,
        ),
      );
      // A failed registration leaves no reservation or partially published tool.
      environment.registerRuntime(runtime(), { kind, id: "scoped" });
      assert.equal(
        await admit(environment, environment.prepare(invocation())),
        "decline",
      );
    } finally {
      await environment.close();
    }
  });
}

for (const sandbox of ["read-only", "workspace-write"] as const) {
  test(`unscoped sandbox-enforcing builtins retain automatic admission (${sandbox})`, async () => {
    const ordinary: ToolRuntime = {
      name: "sandboxed",
      specification: {
        name: "sandboxed",
        description: "Sandboxed",
        inputSchema: {},
      },
      enforcesSandbox: true,
      execute: async () => ({ output: "unused", exitCode: 0 }),
    };
    const environment = new ToolEnvironment({
      runtimes: [ordinary],
      policyStore: new InMemoryToolPolicyStore({ sandboxed: "denied" }),
    });
    try {
      assert.equal(
        await admit(
          environment,
          environment.prepare({ ...invocation("a", "sandboxed"), sandbox }),
          async () => {
            assert.fail(
              "Sandbox-enforcing unscoped builtins retain automatic admission",
            );
          },
        ),
        "accept",
      );
    } finally {
      await environment.close();
    }
  });
}
