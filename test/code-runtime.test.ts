import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenAppServer } from "../src/app-server.js";
import {
  CodeRuntime,
  CodeRuntimeError,
  EMPTY_CODE_OUTPUT,
  RunCodeToolProvider,
} from "../src/code-runtime.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { projectCompletedItem } from "../src/protocol/codex/mapper.js";
import { AgentRuntime } from "../src/runtime.js";
import { Thread } from "../src/thread.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import {
  InMemoryToolPolicyStore,
  ShellToolExecutor,
  ToolEnvironment,
  type NestedToolInvocationPort,
  type ToolExecutionResult,
  type ToolProvider,
} from "../src/tool.js";

function runtimeServer(options: {
  model: ModelAdapter;
  tools: ToolEnvironment;
  journal?: ThreadJournal;
  approvalPolicy?: "always" | "never";
}): ZenAppServer {
  const catalog = new StaticModelCatalog([{ id: "model", isDefault: true }]);
  return new ZenAppServer({
    journal: options.journal ?? new InMemoryThreadJournal(),
    runtime: new AgentRuntime({ toolEnvironment: options.tools }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: options.model.provider,
        adapter: options.model,
        modelCatalog: catalog,
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: options.model.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: options.approvalPolicy ?? "never",
    },
  });
}

const noNestedTools: NestedToolInvocationPort = {
  invoke: async () => {
    throw new Error("unexpected nested tool");
  },
};

async function executeCode(
  code: string,
  options: ConstructorParameters<typeof CodeRuntime>[0] = {},
  nested: NestedToolInvocationPort = noNestedTools,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  return await new CodeRuntime(options).execute({ code, nested, signal });
}

function oneRunCodeModel(code: string): ModelAdapter {
  let sample = 0;
  return {
    provider: "one-run-code",
    async *stream(): AsyncIterable<ModelEvent> {
      sample += 1;
      if (sample % 2 === 1) {
        yield {
          type: "tool_call",
          callId: `outer-${String(sample)}`,
          name: "run_code",
          arguments: { code, description: "test code" },
        };
      } else {
        yield { type: "text_delta", delta: "done" };
      }
    },
  };
}

test("public runtime seam executes TypeScript, Node authority, nested shell, and explicit text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-run-code-tracer-"));
  const file = path.join(root, "value.txt");
  await writeFile(file, "filesystem-value", "utf8");
  const network = createServer((_request, response) =>
    response.end("loopback-value"),
  );
  await new Promise<void>((resolve) => network.listen(0, "127.0.0.1", resolve));
  const address = network.address();
  assert(address && typeof address === "object");

  const requests: ModelRequest[] = [];
  const code = `
    const fs = await import("node:fs/promises");
    const fromFile: string = await fs.readFile(${JSON.stringify(file)}, "utf8");
    const response = await fetch("http://127.0.0.1:${String(address.port)}");
    const child = await tools.shell({ command: ${JSON.stringify(`${process.execPath} -e "process.stdout.write('child-value')"`)} });
    console.log("not-model-visible");
    process.stdout.write("also-not-model-visible");
    text({ fromFile, fromNetwork: await response.text(), child: child.output });
    return "return-is-not-output";
  `;
  let sample = 0;
  const model: ModelAdapter = {
    provider: "tracer",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request));
      sample += 1;
      if (sample === 1) {
        yield {
          type: "tool_call",
          callId: "outer-call",
          name: "run_code",
          arguments: { code, description: "exercise the tracer" },
        };
      } else {
        yield { type: "text_delta", delta: "done" };
      }
    },
  };
  const environment = new ToolEnvironment({
    providers: [
      new ShellToolExecutor(),
      new RunCodeToolProvider(new CodeRuntime()),
    ],
  });

  try {
    const server = runtimeServer({ model, tools: environment });
    const thread = await server.startThread({ cwd: root });
    await (
      await server.startTurn(thread.id, "run tracer")
    ).done;
    const snapshot = await server.readThread(thread.id);
    const outer = snapshot.items.find(
      (item) => item.type === "tool_call" && item.callId === "outer-call",
    );
    assert(outer && outer.type === "tool_call");
    const child = snapshot.items.find(
      (item) => item.type === "tool_call" && item.parentCallId === "outer-call",
    );
    assert(child && child.type === "tool_call");
    assert.deepEqual(projectCompletedItem(child), {
      type: "commandExecution",
      id: child.id,
      pluginId: null,
      scriptPath: null,
      command: child.arguments.command,
      cwd: "",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    });
    assert.throws(
      () =>
        new Thread(thread.id, snapshot.items).append({
          ...child,
          id: "orphan-child",
          callId: "orphan-call",
          parentCallId: "missing-parent",
        }),
      /exactly one earlier parent/u,
    );
    const outerResult = snapshot.items.find(
      (item) => item.type === "tool_result" && item.callId === "outer-call",
    );
    assert(outerResult && outerResult.type === "tool_result");
    assert.deepEqual(JSON.parse(outerResult.output), {
      fromFile: "filesystem-value",
      fromNetwork: "loopback-value",
      child: "child-value",
    });
    assert.deepEqual(
      snapshot.items
        .filter(
          (item) => item.type === "tool_call" || item.type === "tool_result",
        )
        .map((item) => [item.type, item.callId]),
      [
        ["tool_call", "outer-call"],
        ["tool_call", child.callId],
        ["tool_result", child.callId],
        ["tool_result", "outer-call"],
      ],
    );
    assert.deepEqual(
      requests[1]?.messages,
      compileModelMessages(snapshot.items).slice(0, -1),
    );
    assert.equal(
      requests[1]?.messages.some(
        (message) => message.role === "tool" && message.callId === child.callId,
      ),
      false,
    );
    assert.equal(await readFile(file, "utf8"), "filesystem-value");
  } finally {
    await new Promise<void>((resolve, reject) =>
      network.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("only explicit lossless JSON text is visible", async () => {
  assert.equal(
    await executeCode(
      `console.log("hidden"); process.stderr.write("hidden"); return 7;`,
    ),
    EMPTY_CODE_OUTPUT,
  );
  assert.equal(
    await executeCode(`text("first"); text({ value: 2 }); text([true, null]);`),
    'first\n{"value":2}\n[true,null]',
  );
  await assert.rejects(
    executeCode(`text(undefined);`),
    (error: unknown) =>
      error instanceof CodeRuntimeError &&
      error.code === "EXECUTION_FAILED" &&
      /not JSON-compatible/u.test(error.message),
  );
  assert.equal(
    await executeCode(`globalThis.__zen_run_marker = "set"; text("first");`),
    "first",
  );
  assert.equal(
    await executeCode(`text(globalThis.__zen_run_marker ?? "fresh");`),
    "fresh",
  );
  await assert.rejects(
    executeCode(`text({ value: Number.NaN });`),
    (error: unknown) =>
      error instanceof CodeRuntimeError &&
      error.code === "EXECUTION_FAILED" &&
      /not lossless JSON/u.test(error.message),
  );
});

test("reports TypeScript strip errors, wall limits, output limits, and abort", async () => {
  await assert.rejects(
    executeCode(`enum Direction { Up }`),
    (error: unknown) =>
      error instanceof CodeRuntimeError &&
      error.code === "TYPESCRIPT_STRIP_FAILED",
  );
  await assert.rejects(
    executeCode(`while (true) {}`, { wallTimeMs: 40 }),
    (error: unknown) =>
      error instanceof CodeRuntimeError && error.code === "WALL_TIME_LIMIT",
  );
  await assert.rejects(
    executeCode(`text("12345");`, { maxTextBytes: 4 }),
    (error: unknown) =>
      error instanceof CodeRuntimeError && error.code === "TEXT_OUTPUT_LIMIT",
  );

  const controller = new AbortController();
  const running = executeCode(
    `await new Promise(() => {});`,
    { wallTimeMs: 5_000 },
    noNestedTools,
    controller.signal,
  );
  controller.abort(new DOMException("test abort", "AbortError"));
  await assert.rejects(running, (error: unknown) =>
    error instanceof DOMException ? error.name === "AbortError" : false,
  );
});

test("heap containment terminates an allocating Worker", async () => {
  await assert.rejects(
    executeCode(
      `
        const retained = [];
        for (;;) retained.push(new Array(250_000).fill(Math.random()));
      `,
      { maxOldGenerationSizeMb: 16, wallTimeMs: 5_000 },
    ),
    (error: unknown) =>
      error instanceof CodeRuntimeError && error.code === "HEAP_LIMIT",
  );
});

test("serial bridge bounds tool calls, rejects unawaited calls, and preserves nonzero results", async () => {
  const active: string[] = [];
  let overlapping = false;
  const nested: NestedToolInvocationPort = {
    invoke: async (name): Promise<ToolExecutionResult> => {
      if (active.length > 0) overlapping = true;
      active.push(name);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active.pop();
      return {
        output: name === "bad" ? "failed child" : name,
        exitCode: name === "bad" ? 7 : 0,
      };
    },
  };
  assert.equal(
    await executeCode(
      `
        const values = await Promise.all([tools.first({}), tools.bad({})]);
        text(values.map((value) => [value.output, value.exitCode]));
      `,
      {},
      nested,
    ),
    '[["first",0],["failed child",7]]',
  );
  assert.equal(overlapping, false);
  assert.equal(
    await executeCode(`await tools.first({});`, {}, nested),
    EMPTY_CODE_OUTPUT,
  );
  assert.equal(
    await executeCode(
      `
        const failed = await tools.bad({});
        if (failed.exitCode !== 0) {
          const fallback = await tools.first({});
          text(fallback.output);
        }
      `,
      {},
      nested,
    ),
    "first",
  );

  await assert.rejects(
    executeCode(`tools.first({}); text("returned");`, {}, nested),
    (error: unknown) =>
      error instanceof CodeRuntimeError && error.code === "UNAWAITED_TOOL_CALL",
  );
  assert.equal(
    await executeCode(
      `
        await tools.first({});
        try { await tools.second({}); } catch (error) { text(error.name); }
      `,
      { maxToolCalls: 1 },
      nested,
    ),
    "TOOL_CALL_LIMIT",
  );
});

test("outer admission is remembered while inherited child admission preserves deny", async () => {
  let approvals = 0;
  const policyStore = new InMemoryToolPolicyStore({ shell: "denied" });
  const environment = new ToolEnvironment({
    policyStore,
    providers: [new ShellToolExecutor(), new RunCodeToolProvider()],
  });
  const server = runtimeServer({
    model: oneRunCodeModel(
      `const result = await tools.shell({ command: "printf forbidden" }); text(result);`,
    ),
    tools: environment,
    approvalPolicy: "always",
  });
  const thread = await server.startThread();
  for (let index = 0; index < 2; index += 1) {
    await (
      await server.startTurn(thread.id, `turn ${String(index)}`, {
        requestApproval: async (request) => {
          approvals += 1;
          assert.match(request.command, /^run_code /u);
          return "accept";
        },
      })
    ).done;
  }
  assert.equal(approvals, 1);
  const snapshot = await server.readThread(thread.id);
  const childResults = snapshot.items.filter(
    (
      item,
    ): item is Extract<
      (typeof snapshot.items)[number],
      { type: "tool_result" }
    > =>
      item.type === "tool_result" &&
      snapshot.items.some(
        (candidate) =>
          candidate.type === "tool_call" &&
          candidate.callId === item.callId &&
          candidate.parentCallId !== undefined,
      ),
  );
  assert.equal(childResults.length, 2);
  assert(
    childResults.every(
      (item) => item.output === "User declined this tool call.",
    ),
  );
});

test("declined outer run_code never starts a Worker", async () => {
  const missingWorker = new URL("file:///definitely/missing/worker.js");
  const environment = new ToolEnvironment({
    providers: [
      new RunCodeToolProvider(new CodeRuntime({ workerUrl: missingWorker })),
    ],
  });
  const server = runtimeServer({
    model: oneRunCodeModel(`text("must not run")`),
    tools: environment,
    approvalPolicy: "always",
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "decline", {
      requestApproval: async () => "decline",
    })
  ).done;
  const snapshot = await server.readThread(thread.id);
  const result = snapshot.items.find(
    (item) => item.type === "tool_result" && item.callId === "outer-1",
  );
  assert(result && result.type === "tool_result");
  assert.equal(result.exitCode, 126);
  assert.equal(result.output, "User declined this tool call.");
});

test("wall containment aborts and settles a terminable nested child before outer result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-run-code-child-"));
  const fixture = path.join(root, "fixture.cjs");
  const pidFile = path.join(root, "pid.txt");
  await writeFile(
    fixture,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    "utf8",
  );
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`;
  const environment = new ToolEnvironment({
    providers: [
      new ShellToolExecutor({ terminationGraceMs: 20 }),
      new RunCodeToolProvider(new CodeRuntime({ wallTimeMs: 100 })),
    ],
  });
  const server = runtimeServer({
    model: oneRunCodeModel(
      `await tools.shell({ command: ${JSON.stringify(command)} }); text("late");`,
    ),
    tools: environment,
  });
  try {
    const thread = await server.startThread({ cwd: root });
    await (
      await server.startTurn(thread.id, "contain child")
    ).done;
    const snapshot = await server.readThread(thread.id);
    const lifecycle = snapshot.items.filter(
      (item) => item.type === "tool_call" || item.type === "tool_result",
    );
    assert.deepEqual(
      lifecycle.map((item) => item.type),
      ["tool_call", "tool_call", "tool_result", "tool_result"],
    );
    const outerResult = lifecycle.at(-1);
    assert(outerResult?.type === "tool_result");
    assert.match(outerResult.output, /WALL_TIME_LIMIT/u);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) => {
        return (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ESRCH"
        );
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested provider result validation is still Runtime-owned", async () => {
  const invalidProvider: ToolProvider = {
    identity: { kind: "plugin", id: "invalid" },
    definitions: [
      {
        name: "invalid.result",
        description: "invalid",
        inputSchema: { type: "object" },
      },
    ],
    execute: async () => ({ output: "bad", exitCode: 1.5 }),
  };
  const environment = new ToolEnvironment({
    providers: [invalidProvider, new RunCodeToolProvider()],
  });
  const server = runtimeServer({
    model: oneRunCodeModel(
      `const result = await tools["invalid.result"]({}); text(result);`,
    ),
    tools: environment,
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "validate")
  ).done;
  const snapshot = await server.readThread(thread.id);
  const nestedResult = snapshot.items.find(
    (item) => item.type === "tool_result" && item.callId !== "outer-1",
  );
  assert(nestedResult && nestedResult.type === "tool_result");
  assert.match(nestedResult.output, /^Tool result normalization failed:/u);
  assert.equal(nestedResult.exitCode, 1);
});

test("parent validation, restart replay, context filtering, and compaction closure stay canonical", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-run-code-replay-"));
  const journal = new JsonlThreadJournal(root);
  const environment = new ToolEnvironment({
    providers: [new ShellToolExecutor(), new RunCodeToolProvider()],
  });
  const model = oneRunCodeModel(
    `const result = await tools.shell({ command: "printf replay" }); text(result.output);`,
  );
  try {
    const server = runtimeServer({ model, tools: environment, journal });
    const started = await server.startThread();
    await (
      await server.startTurn(started.id, "replay")
    ).done;
    const before = await readFile(
      path.join(root, `${started.id}.jsonl`),
      "utf8",
    );
    const replayed = runtimeServer({ model, tools: environment, journal });
    const snapshot = await replayed.readThread(started.id);
    const after = await readFile(
      path.join(root, `${started.id}.jsonl`),
      "utf8",
    );
    assert.equal(after, before);
    assert.equal(
      compileModelMessages(snapshot.items).some(
        (message) => message.role === "tool" && message.callId !== "outer-1",
      ),
      false,
    );

    const child = snapshot.items.find(
      (item) => item.type === "tool_call" && item.parentCallId === "outer-1",
    );
    assert(child && child.type === "tool_call");
    const completed = snapshot.items.find(
      (item) => item.type === "turn_completed" && item.turnId === child.turnId,
    );
    assert(completed && completed.type === "turn_completed");
    const compaction = {
      id: "compaction",
      threadId: started.id,
      createdAt: "2026-09-02T00:00:00.000Z",
      type: "context_compaction" as const,
      coveredThroughItemId: completed.id,
      summary: "summary",
      retainedItemIds: snapshot.items
        .filter((item) => item.turnId === child.turnId)
        .map((item) => item.id),
      providerProfileId: snapshot.providerProfileId,
      modelId: snapshot.modelId,
      reasoningEffort: snapshot.reasoningEffort,
      algorithmVersion: "zen.context-compaction.v1",
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
    };
    const compacted = new Thread(started.id, snapshot.items);
    compacted.append(compaction);
    assert.equal(
      compileModelMessages(compacted.items).some(
        (message) => message.role === "tool" && message.callId === child.callId,
      ),
      false,
    );
    assert.throws(
      () =>
        new Thread(started.id, snapshot.items).append({
          ...compaction,
          id: "broken-compaction",
          retainedItemIds: compaction.retainedItemIds.filter((id) => {
            const item = snapshot.items.find(
              (candidate) => candidate.id === id,
            );
            return !(
              id === child.id ||
              (item?.type === "tool_result" && item.callId === child.callId)
            );
          }),
        }),
      /nested tool lifecycle is incomplete/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
