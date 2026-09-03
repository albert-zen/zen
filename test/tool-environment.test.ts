import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shellPrintCommand } from "./fixtures.js";

import { ZenAppServer } from "../src/app-server.js";
import type { CanonicalItem } from "../src/item.js";
import { InMemoryThreadJournal, JsonlThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/model.js";
import { compileModelMessages } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import {
  InMemoryToolPolicyStore,
  SetToolPolicyStore,
  ShellToolRuntime,
  ToolEnvironment,
  MAX_STRUCTURED_TOOL_RESULT_BYTES,
} from "../src/tool.js";
import { testToolBundle, testToolRuntime } from "./tool-fixtures.js";

test("structured tool results survive canonical persistence without entering model context", async () => {
  const source = { cards: [{ id: "one", title: "Verbatim" }] };
  const bundle = testToolBundle({ kind: "plugin", id: "fixture" }, [
    testToolRuntime({
      name: "fixture_cards",
      description: "Cards",
      inputSchema: {},
      execute: async () => ({
        output: "exact textual fallback",
        exitCode: 0,
        contentType: "fixture/cards",
        structuredContent: source,
      }),
    }),
  ]);
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), "zen-structured-"));
  try {
    const journal = new JsonlThreadJournal(journalRoot);
    const server = new ZenAppServer({
      journal,
      runtime: new AgentRuntime({
        toolEnvironment: new ToolEnvironment({ bundles: [bundle] }),
      }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "structured",
          adapter: modelCalling("fixture_cards"),
          modelCatalog: new StaticModelCatalog([
            { id: "fixture-model", isDefault: true },
          ]),
        },
      ]),
      threadMetadata: new InMemoryThreadMetadataStore(),
      defaults: {
        cwd: process.cwd(),
        providerProfileId: "structured",
        modelId: "fixture-model",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "cards")
    ).done;
    source.cards[0]!.title = "mutated after execution";
    const replayed = await journal.read(thread.id);
    const result = replayed.find((item) => item.type === "tool_result");
    assert(result?.type === "tool_result");
    assert.equal(result.contentType, "fixture/cards");
    assert.deepEqual(result.structuredContent, {
      cards: [{ id: "one", title: "Verbatim" }],
    });
    assert.deepEqual(
      compileModelMessages(replayed).find((message) => message.role === "tool"),
      {
        role: "tool",
        callId: "fixture_cards-1",
        text: "exact textual fallback",
        exitCode: 0,
      },
    );
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test("legacy tool results keep their exact serialized shape", () => {
  const legacy = {
    id: "result",
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-08-24T00:00:00.000Z",
    type: "tool_result",
    callId: "call",
    output: 'legacy bytes {"exact":true}',
    exitCode: 7,
  } as const;
  assert.equal(
    JSON.stringify(legacy),
    '{"id":"result","threadId":"thread","turnId":"turn","createdAt":"2026-08-24T00:00:00.000Z","type":"tool_result","callId":"call","output":"legacy bytes {\\"exact\\":true}","exitCode":7}',
  );
  assert.deepEqual(compileModelMessages([legacy]), [
    {
      role: "tool",
      callId: "call",
      text: 'legacy bytes {"exact":true}',
      exitCode: 7,
    },
  ]);
});

test("structured result admission rejects non-JSON, cyclic, oversized, and foreign plugin content", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cases = [
    {
      contentType: "fixture/value",
      structuredContent: { value: undefined },
      pattern: /JSON-compatible/u,
    },
    {
      contentType: "fixture/value",
      structuredContent: cyclic,
      pattern: /cyclic/u,
    },
    {
      contentType: "fixture/value",
      structuredContent: "x".repeat(MAX_STRUCTURED_TOOL_RESULT_BYTES + 1),
      pattern: /byte limit/u,
    },
    {
      contentType: "other/value",
      structuredContent: { ok: true },
      pattern: /does not own/u,
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    const environment = new ToolEnvironment({
      bundles: [
        testToolBundle({ kind: "plugin", id: "fixture" }, [
          testToolRuntime({
            name: "fixture_value",
            description: "Value",
            inputSchema: {},
            execute: async () =>
              ({ output: "unchanged", exitCode: 7, ...fixture }) as never,
          }),
        ]),
      ],
    });
    const prepared = environment.prepare({
      callId: String(index),
      name: "fixture_value",
      arguments: {},
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    await assert.rejects(environment.execute(prepared), fixture.pattern);
  }
});

test("invalid structured content settles its tool call and lets the model continue", async () => {
  const bundle = testToolBundle({ kind: "plugin", id: "fixture" }, [
    testToolRuntime({
      name: "fixture_invalid",
      description: "Invalid",
      inputSchema: {},
      execute: async () => ({
        output: "must not be appended",
        exitCode: 0,
        contentType: "foreign/value",
        structuredContent: { ok: true },
      }),
    }),
  ]);
  const server = createServer(
    modelCalling("fixture_invalid"),
    new ToolEnvironment({ bundles: [bundle] }),
    "never",
  );
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "invalid structured result")
  ).done;
  const snapshot = await server.readThread(thread.id);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.exitCode, 1);
  assert.match(results[0]!.output, /does not own/u);
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.equal(
    snapshot.items.some((item) => item.type === "failure"),
    false,
  );
  assert.equal(
    snapshot.items.some(
      (item) =>
        item.type === "tool_result" && item.output === "must not be appended",
    ),
    false,
  );
  assertEveryToolCallHasOneResult(snapshot.items);
});

test("a prepared invocation keeps its exact runtime after bundle removal", async () => {
  const calls: string[] = [];
  let preparedLeases = 0;
  const bundle = testToolBundle(
    { kind: "plugin", id: "fixture" },
    [
      testToolRuntime({
        name: "fixture_echo",
        description: "Echo fixture input.",
        execute: async (invocation) => {
          calls.push(invocation.name);
          return { output: "fixture result", exitCode: 0 };
        },
      }),
    ],
    () => {
      preparedLeases += 1;
      return () => {
        preparedLeases -= 1;
      };
    },
  );
  const environment = new ToolEnvironment({
    bundles: [bundle],
    policyStore: new InMemoryToolPolicyStore(),
  });
  const prepared = environment.prepare({
    callId: "call-1",
    name: "fixture_echo",
    arguments: { value: "unchanged" },
    cwd: "/workspace",
    signal: new AbortController().signal,
  });

  assert.equal(
    environment.unregisterBundle({ kind: "plugin", id: "fixture" }),
    true,
  );
  assert.equal(preparedLeases, 1);
  assert.deepEqual(environment.definitions, []);
  assert.deepEqual(await environment.execute(prepared), {
    output: "fixture result",
    exitCode: 0,
  });
  assert.equal(preparedLeases, 0);
  assert.deepEqual(calls, ["fixture_echo"]);
});

test("concurrent unknown calls share one persisted admission decision", async () => {
  const bundle = countingBundle("plugin_shared");
  const environment = new ToolEnvironment({ bundles: [bundle] });
  const signal = new AbortController().signal;
  const first = environment.prepare({
    callId: "first",
    name: "plugin_shared",
    arguments: {},
    cwd: "/workspace",
    signal,
  });
  const second = environment.prepare({
    callId: "second",
    name: "plugin_shared",
    arguments: {},
    cwd: "/workspace",
    signal,
  });
  let approvalRequests = 0;
  let releaseApproval!: () => void;
  const approval = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });
  const admit = async (
    prepared: typeof first,
  ): Promise<"accept" | "acceptForSession" | "decline" | "cancel"> =>
    await environment.admit(prepared, {
      policy: "ask_unknown",
      approvalRequest: {
        threadId: "thread",
        turnId: "turn",
        itemId: prepared.invocation.callId,
        callId: prepared.invocation.callId,
        command: prepared.invocation.name,
        cwd: prepared.invocation.cwd,
        signal,
      },
      requestApproval: async () => {
        approvalRequests += 1;
        await approval;
        return "accept";
      },
    });

  const firstAdmission = admit(first);
  await Promise.resolve();
  const secondAdmission = admit(second);
  releaseApproval();
  assert.deepEqual(await Promise.all([firstAdmission, secondAdmission]), [
    "accept",
    "accept",
  ]);
  assert.equal(approvalRequests, 1);
});

test("bundle definitions appear and disappear on consecutive model samples", async () => {
  const sampledTools: string[][] = [];
  const executedSignals: AbortSignal[] = [];
  const bundle = testToolBundle({ kind: "plugin", id: "fixture" }, [
    testToolRuntime({
      name: "fixture_echo",
      description: "Echo fixture input.",
      execute: async (invocation) => {
        executedSignals.push(invocation.signal);
        return { output: String(invocation.arguments.value), exitCode: 0 };
      },
    }),
  ]);
  const environment = new ToolEnvironment({
    runtimes: [new ShellToolRuntime()],
  });
  let round = 0;
  const model: ModelAdapter = {
    provider: "dynamic-tools",
    async *stream(request): AsyncIterable<ModelEvent> {
      sampledTools.push(request.tools.map((tool) => tool.name));
      if (round === 0) {
        round += 1;
        environment.registerBundle(bundle);
        yield {
          type: "tool_call",
          callId: "builtin-call",
          name: "shell",
          arguments: { command: shellPrintCommand("registered") },
        };
        return;
      }
      if (round === 1) {
        round += 1;
        yield {
          type: "tool_call",
          callId: "plugin-call",
          name: "fixture_echo",
          arguments: { value: "credential-like trace bytes" },
        };
        return;
      }
      yield { type: "text_delta", delta: "complete" };
    },
  };
  const server = createServer(model, environment, "always");
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "dynamic providers", {
      requestApproval: async (request) => {
        if (request.callId === "plugin-call") {
          environment.unregisterBundle(bundle.identity);
        }
        return "accept";
      },
    })
  ).done;

  const snapshot = await server.readThread(thread.id);
  assert.equal(
    snapshot.turns[0]?.status,
    "completed",
    JSON.stringify(snapshot.items),
  );
  assert.deepEqual(sampledTools, [
    ["shell"],
    ["shell", "fixture_echo"],
    ["shell"],
  ]);
  assert.equal(executedSignals.length, 1);
  assert.equal(executedSignals[0]?.aborted, false);
  const pluginResult = snapshot.items.find(
    (item) => item.type === "tool_result" && item.callId === "plugin-call",
  );
  assert(pluginResult?.type === "tool_result");
  assert.equal(pluginResult.output, "credential-like trace bytes");
  assertEveryToolCallHasOneResult(snapshot.items);
});

test("full access bypasses approval and ask unknown persists allow and deny", async () => {
  const bundle = countingBundle("external_lookup");
  const fullAccessEnvironment = new ToolEnvironment({ bundles: [bundle] });
  let fullAccessApprovals = 0;
  const fullAccess = createServer(
    modelCalling("external_lookup"),
    fullAccessEnvironment,
    "never",
  );
  const fullAccessThread = await fullAccess.startThread();
  await (
    await fullAccess.startTurn(fullAccessThread.id, "full access", {
      requestApproval: async () => {
        fullAccessApprovals += 1;
        return "decline";
      },
    })
  ).done;
  assert.equal(fullAccessApprovals, 0);
  assert.equal(bundle.executions(), 1);

  const approvedTools = new Set<string>();
  const deniedTools = new Set<string>();
  const policyStore = new SetToolPolicyStore({ approvedTools, deniedTools });
  const allowedBundle = countingBundle("plugin_allowed");
  const allowedEnvironment = new ToolEnvironment({
    bundles: [allowedBundle],
    policyStore,
  });
  let allowApprovals = 0;
  const allowed = createServer(
    modelCalling("plugin_allowed"),
    allowedEnvironment,
    "always",
  );
  const allowedThread = await allowed.startThread();
  for (const input of ["first", "second"]) {
    await (
      await allowed.startTurn(allowedThread.id, input, {
        requestApproval: async () => {
          allowApprovals += 1;
          return "accept";
        },
      })
    ).done;
  }
  assert.equal(allowApprovals, 1);
  assert.deepEqual([...approvedTools], ["plugin_allowed"]);
  assert.equal(allowedBundle.executions(), 2);

  const deniedBundle = countingBundle("plugin_denied");
  const deniedEnvironment = new ToolEnvironment({
    bundles: [deniedBundle],
    policyStore,
  });
  let denyApprovals = 0;
  const denied = createServer(
    modelCalling("plugin_denied"),
    deniedEnvironment,
    "always",
  );
  const deniedThread = await denied.startThread();
  for (const input of ["first", "second"]) {
    await (
      await denied.startTurn(deniedThread.id, input, {
        requestApproval: async () => {
          denyApprovals += 1;
          return "decline";
        },
      })
    ).done;
  }
  const deniedSnapshot = await denied.readThread(deniedThread.id);
  assert.equal(denyApprovals, 1);
  assert.deepEqual([...deniedTools], ["plugin_denied"]);
  assert.equal(deniedBundle.executions(), 0);
  assertEveryToolCallHasOneResult(deniedSnapshot.items);
});

test("interrupt sends the exact runtime signal to the admitted runtime", async () => {
  let started!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let receivedSignal: AbortSignal | undefined;
  const runtime = testToolRuntime({
    name: "external_wait",
    description: "Wait for cancellation.",
    execute: async (invocation) => {
      receivedSignal = invocation.signal;
      started();
      return await new Promise((_resolve, reject) => {
        invocation.signal.addEventListener(
          "abort",
          () => reject(invocation.signal.reason),
          { once: true },
        );
      });
    },
  });
  const server = createServer(
    modelCalling("external_wait"),
    new ToolEnvironment({
      bundles: [testToolBundle({ kind: "external", id: "waiter" }, [runtime])],
    }),
    "never",
  );
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "wait");
  await within(executionStarted);
  await within(server.interruptTurn(thread.id, turn.id));

  const snapshot = await server.readThread(thread.id);
  assert.equal(receivedSignal?.aborted, true);
  assertEveryToolCallHasOneResult(snapshot.items);
  assert.equal(
    snapshot.items.find((item) => item.type === "tool_result")?.exitCode,
    130,
  );
});

function createServer(
  model: ModelAdapter,
  toolEnvironment: ToolEnvironment,
  approvalPolicy: "always" | "never",
): ZenAppServer {
  return new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({ toolEnvironment }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture-model", isDefault: true },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "fixture-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy,
    },
  });
}

function modelCalling(toolName: string): ModelAdapter {
  let callNumber = 0;
  return {
    provider: `model-for-${toolName}`,
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "text_delta", delta: "complete" };
        return;
      }
      callNumber += 1;
      yield {
        type: "tool_call",
        callId: `${toolName}-${String(callNumber)}`,
        name: toolName,
        arguments: {},
      };
    },
  };
}

function countingBundle(toolName: string): ReturnType<typeof testToolBundle> & {
  executions(): number;
} {
  let count = 0;
  return {
    ...testToolBundle({ kind: "plugin", id: toolName }, [
      testToolRuntime({
        name: toolName,
        execute: async () => {
          count += 1;
          return { output: "fixture", exitCode: 0 };
        },
      }),
    ]),
    executions: () => count,
  };
}

function assertEveryToolCallHasOneResult(
  items: readonly CanonicalItem[],
): void {
  const callIds = items
    .filter((item) => item.type === "tool_call")
    .map((item) => item.callId);
  const resultIds = items
    .filter((item) => item.type === "tool_result")
    .map((item) => item.callId);
  assert(callIds.length > 0);
  for (const callId of callIds) {
    assert.equal(resultIds.filter((resultId) => resultId === callId).length, 1);
  }
}

async function within<T>(operation: Promise<T>): Promise<T> {
  return await Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("operation timed out")), 1000);
    }),
  ]);
}
