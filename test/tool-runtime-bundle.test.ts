import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolEnvironment,
  type CompositeToolRuntime,
  type NestedToolInvocationPort,
  type ToolBundle,
  type ToolExecutionResult,
  type ToolInvocation,
  type ToolRuntime,
} from "../src/tool.js";

function runtime(
  name: string,
  execute: (invocation: ToolInvocation) => Promise<ToolExecutionResult>,
  executionMode: "parallel_safe" | "exclusive" = "exclusive",
): ToolRuntime {
  return {
    name,
    specification: {
      name,
      description: `Execute ${name}`,
      inputSchema: { type: "object" },
    },
    executionMode,
    execute,
  };
}

function bundle(
  id: string,
  tools: readonly ToolRuntime[],
  retainPreparedInvocation?: () => () => void,
): ToolBundle {
  return {
    identity: { kind: "plugin", id },
    tools,
    ...(retainPreparedInvocation === undefined
      ? {}
      : { retainPreparedInvocation }),
  };
}

function invocation(name: string): ToolInvocation {
  return {
    callId: `call-${name}`,
    name,
    arguments: {},
    cwd: "/workspace",
    signal: new AbortController().signal,
  };
}

test("a bundle publishes exact single-tool runtimes without name redispatch", async () => {
  const calls: string[] = [];
  const first = runtime("first", async () => {
    calls.push("first-runtime");
    return { output: "first", exitCode: 0 };
  });
  const second = runtime(
    "second",
    async () => {
      calls.push("second-runtime");
      return { output: "second", exitCode: 0 };
    },
    "parallel_safe",
  );
  const environment = new ToolEnvironment({
    bundles: [bundle("fixture", [first, second])],
  });

  assert.deepEqual(
    environment.definitions.map(({ name }) => name),
    ["first", "second"],
  );
  const prepared = environment.prepare(invocation("second"));
  assert.deepEqual(prepared.owner, { kind: "plugin", id: "fixture" });
  assert.equal(prepared.definition.name, "second");
  assert.equal(prepared.executionMode, "parallel_safe");
  assert.deepEqual(await environment.execute(prepared), {
    output: "second",
    exitCode: 0,
  });
  assert.deepEqual(calls, ["second-runtime"]);
});

test("an independent runtime registers without a caller-visible bundle", async () => {
  const environment = new ToolEnvironment({
    runtimes: [
      runtime("standalone", async () => ({ output: "ok", exitCode: 0 })),
    ],
  });

  const prepared = environment.prepare(invocation("standalone"));
  assert.deepEqual(prepared.owner, { kind: "builtin", id: "standalone" });
  assert.deepEqual(await environment.execute(prepared), {
    output: "ok",
    exitCode: 0,
  });
});

test("bundle staging validates every runtime before atomically publishing any", () => {
  const environment = new ToolEnvironment({
    bundles: [
      bundle("existing", [
        runtime("taken", async () => ({ output: "", exitCode: 0 })),
      ]),
    ],
  });

  assert.throws(
    () =>
      environment.stageBundle(
        bundle("candidate", [
          runtime("new-name", async () => ({ output: "", exitCode: 0 })),
          runtime("taken", async () => ({ output: "", exitCode: 0 })),
        ]),
      ),
    /already registered/u,
  );
  assert.deepEqual(
    environment.definitions.map(({ name }) => name),
    ["taken"],
  );
  assert.throws(
    () => environment.prepare(invocation("new-name")),
    /Unsupported/u,
  );
});

test("prepared calls retain their exact runtime and bundle lease across replacement", async () => {
  let leases = 0;
  const calls: string[] = [];
  const original = bundle(
    "replaceable",
    [
      runtime("echo", async () => {
        calls.push("original");
        return { output: "original", exitCode: 0 };
      }),
    ],
    () => {
      leases += 1;
      return () => {
        leases -= 1;
      };
    },
  );
  const environment = new ToolEnvironment({ bundles: [original] });
  const prepared = environment.prepare(invocation("echo"));
  assert.equal(leases, 1);

  environment
    .stageBundle(
      bundle("replaceable", [
        runtime("echo", async () => {
          calls.push("replacement");
          return { output: "replacement", exitCode: 0 };
        }),
      ]),
      { replaceCurrent: true },
    )
    .publish();

  assert.deepEqual(await environment.execute(prepared), {
    output: "original",
    exitCode: 0,
  });
  assert.equal(leases, 0);
  assert.deepEqual(
    await environment.execute(environment.prepare(invocation("echo"))),
    { output: "replacement", exitCode: 0 },
  );
  assert.deepEqual(calls, ["original", "replacement"]);
});

test("external composite-shaped runtimes cannot receive the nested invocation port", async () => {
  let compositeCalls = 0;
  let ordinaryCalls = 0;
  const external: CompositeToolRuntime = {
    ...runtime("external_composite", async () => {
      ordinaryCalls += 1;
      return { output: "ordinary", exitCode: 0 };
    }),
    executeComposite: async (
      _invocation,
      _nested: NestedToolInvocationPort,
    ) => {
      compositeCalls += 1;
      return { output: "composite", exitCode: 0 };
    },
  };
  const environment = new ToolEnvironment({
    bundles: [
      {
        identity: { kind: "external", id: "untrusted" },
        tools: [external],
      },
    ],
  });
  const nested: NestedToolInvocationPort = {
    invoke: async () => ({ output: "nested", exitCode: 0 }),
  };

  assert.deepEqual(
    await environment.execute(
      environment.prepare(invocation("external_composite")),
      nested,
    ),
    { output: "ordinary", exitCode: 0 },
  );
  assert.equal(ordinaryCalls, 1);
  assert.equal(compositeCalls, 0);
});
