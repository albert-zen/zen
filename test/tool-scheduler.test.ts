import assert from "node:assert/strict";
import test from "node:test";

import { ZenAppServer } from "../src/app-server.js";
import { RunCodeToolRuntime } from "../src/code-runtime.js";
import type { CanonicalItem } from "../src/item.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ToolBundle,
  type ToolExecutionResult,
  type ToolRuntime,
} from "../src/tool.js";
import { testToolBundle, testToolRuntime } from "./tool-fixtures.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T extends void ? void : T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T extends void ? void : T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value: T extends void ? void : T) => void;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function batchModel(
  calls: readonly {
    callId: string;
    name: string;
    arguments?: Record<string, unknown>;
  }[],
): ModelAdapter {
  return {
    provider: "scheduler-test-model",
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "text_delta", delta: "done" };
        return;
      }
      for (const call of calls) {
        yield {
          type: "tool_call",
          callId: call.callId,
          name: call.name,
          arguments: call.arguments ?? {},
        };
      }
    },
  };
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function toolResults(items: readonly CanonicalItem[]) {
  return items.filter((item) => item.type === "tool_result");
}

function assertEveryToolCallHasOneResult(
  items: readonly CanonicalItem[],
): void {
  for (const call of items.filter((item) => item.type === "tool_call")) {
    assert.equal(
      toolResults(items).filter((result) => result.callId === call.callId)
        .length,
      1,
    );
  }
}

function runtimeServer(options: {
  model: ModelAdapter;
  runtimes?: readonly ToolRuntime[];
  bundles?: readonly ToolBundle[];
  maxConcurrentToolBodies?: number;
  approvalPolicy?: "always" | "never";
}): ZenAppServer {
  const catalog = new StaticModelCatalog([
    { id: "model", isDefault: true, contextWindow: 32_768 },
  ]);
  return new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        ...(options.runtimes === undefined
          ? {}
          : { runtimes: options.runtimes }),
        ...(options.bundles === undefined ? {} : { bundles: options.bundles }),
      }),
      ...(options.maxConcurrentToolBodies === undefined
        ? {}
        : { maxConcurrentToolBodies: options.maxConcurrentToolBodies }),
    }),
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

test("parallel-safe bodies overlap while canonical results keep submission order", async () => {
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const releaseSecond = deferred<void>();
  const secondFinished = deferred<void>();
  const bundle = testToolBundle({ kind: "external", id: "parallel" }, [
    testToolRuntime({
      name: "parallel",
      description: "Controlled parallel fixture.",
      executionMode: "parallel_safe",
      execute: async (invocation): Promise<ToolExecutionResult> => {
        if (invocation.callId === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
          await releaseSecond.promise;
          secondFinished.resolve();
        }
        return { output: invocation.callId, exitCode: 0 };
      },
    }),
  ]);
  const server = runtimeServer({
    model: batchModel([
      { callId: "first", name: "parallel" },
      { callId: "second", name: "parallel" },
    ]),
    bundles: [bundle],
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "parallel");

  await within(firstStarted.promise, "the first body to start");
  await within(secondStarted.promise, "the second body to overlap");
  releaseSecond.resolve();
  await within(secondFinished.promise, "the second body to finish first");
  assert.equal(
    (await server.readThread(thread.id)).items.some(
      (item) => item.type === "tool_result",
    ),
    false,
  );

  releaseFirst.resolve();
  await within(turn.done, "the parallel Turn to complete");
  const results = (await server.readThread(thread.id)).items.filter(
    (item) => item.type === "tool_result",
  );
  assert.deepEqual(
    results.map((item) => [item.callId, item.output]),
    [
      ["first", "first"],
      ["second", "second"],
    ],
  );
});

test("exclusive calls form FIFO barriers around parallel-safe bodies", async () => {
  const starts: string[] = [];
  const firstStarted = deferred<void>();
  const barrierStarted = deferred<void>();
  const lastStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const releaseBarrier = deferred<void>();
  const releaseLast = deferred<void>();
  const execute = async (
    invocation: Parameters<ToolRuntime["execute"]>[0],
  ): Promise<ToolExecutionResult> => {
    starts.push(invocation.callId);
    if (invocation.callId === "first") {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else if (invocation.callId === "middle") {
      barrierStarted.resolve();
      await releaseBarrier.promise;
    } else {
      lastStarted.resolve();
      await releaseLast.promise;
    }
    return { output: invocation.callId, exitCode: 0 };
  };
  const bundle = testToolBundle({ kind: "external", id: "barrier" }, [
    testToolRuntime({
      name: "parallel",
      description: "Parallel fixture.",
      executionMode: "parallel_safe",
      execute,
    }),
    testToolRuntime({
      name: "barrier",
      description: "Exclusive fixture.",
      executionMode: "exclusive",
      execute,
    }),
  ]);
  const server = runtimeServer({
    model: batchModel([
      { callId: "first", name: "parallel" },
      { callId: "middle", name: "barrier" },
      { callId: "last", name: "parallel" },
    ]),
    bundles: [bundle],
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "barriers");

  await within(firstStarted.promise, "the leading parallel body");
  await nextTask();
  assert.deepEqual(starts, ["first"]);
  releaseFirst.resolve();
  await within(barrierStarted.promise, "the exclusive body");
  await nextTask();
  assert.deepEqual(starts, ["first", "middle"]);
  releaseBarrier.resolve();
  await within(lastStarted.promise, "the trailing parallel body");
  assert.deepEqual(starts, ["first", "middle", "last"]);
  releaseLast.resolve();
  await within(turn.done, "the barrier Turn");
});

test("builtin shell and undeclared runtimes stay exclusive", async () => {
  const starts: string[] = [];
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const releaseSecond = deferred<void>();
  const undeclared = testToolBundle({ kind: "external", id: "undeclared" }, [
    testToolRuntime({
      name: "undeclared",
      description: "No execution mode declaration.",
      execute: async (invocation) => {
        starts.push(invocation.callId);
        if (invocation.callId === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
        return { output: invocation.callId, exitCode: 0 };
      },
    }),
  ]);
  const server = runtimeServer({
    model: batchModel([
      { callId: "first", name: "undeclared" },
      {
        callId: "shell",
        name: "shell",
        arguments: { command: "printf shell" },
      },
      { callId: "second", name: "undeclared" },
    ]),
    bundles: [undeclared],
    runtimes: [new ShellToolRuntime()],
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "fail closed");

  await within(firstStarted.promise, "the first undeclared body");
  await nextTask();
  assert.deepEqual(starts, ["first"]);
  releaseFirst.resolve();
  await within(secondStarted.promise, "the body after shell");
  const beforeSecondRelease = await server.readThread(thread.id);
  assert(
    toolResults(beforeSecondRelease.items).some(
      (result) => result.callId === "shell" && result.output === "shell",
    ),
  );
  releaseSecond.resolve();
  await within(turn.done, "the fail-closed Turn");
});

test("the default body cap is eight and a configured cap must be positive", async () => {
  for (const invalid of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        new AgentRuntime({
          toolEnvironment: new ToolEnvironment(),
          maxConcurrentToolBodies: invalid,
        }),
      /positive safe integer/u,
    );
  }

  const eightStarted = deferred<void>();
  const allStarted = deferred<void>();
  const release = deferred<void>();
  let starts = 0;
  let active = 0;
  let maxActive = 0;
  const bundle = testToolBundle({ kind: "external", id: "default-cap" }, [
    testToolRuntime({
      name: "parallel",
      description: "Default cap fixture.",
      executionMode: "parallel_safe",
      execute: async () => {
        starts += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (starts === 8) eightStarted.resolve();
        if (starts === 9) allStarted.resolve();
        await release.promise;
        active -= 1;
        return { output: "ok", exitCode: 0 };
      },
    }),
  ]);
  const server = runtimeServer({
    model: batchModel(
      Array.from({ length: 9 }, (_, index) => ({
        callId: `call-${String(index + 1)}`,
        name: "parallel",
      })),
    ),
    bundles: [bundle],
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "default cap");

  await within(eightStarted.promise, "eight bodies at the default cap");
  await nextTask();
  assert.equal(starts, 8);
  assert.equal(maxActive, 8);
  release.resolve();
  await within(allStarted.promise, "the ninth body after capacity frees");
  await within(turn.done, "the default-cap Turn");
});

test("nested Promise.all shares the cap while outer run_code holds no child slot", async () => {
  const twoStarted = deferred<void>();
  const thirdStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const releaseSecond = deferred<void>();
  const releaseThird = deferred<void>();
  let starts = 0;
  let active = 0;
  let maxActive = 0;
  const child = testToolBundle({ kind: "external", id: "nested-cap" }, [
    testToolRuntime({
      name: "child",
      description: "Nested cap fixture.",
      executionMode: "parallel_safe",
      execute: async (invocation) => {
        starts += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        const sequence = Number(invocation.arguments.sequence);
        if (starts === 2) twoStarted.resolve();
        if (starts === 3) thirdStarted.resolve();
        await [releaseFirst, releaseSecond, releaseThird][sequence - 1]!
          .promise;
        active -= 1;
        return { output: String(sequence), exitCode: 0 };
      },
    }),
  ]);
  const server = runtimeServer({
    model: batchModel([
      {
        callId: "outer",
        name: "run_code",
        arguments: {
          description: "nested cap",
          code: `
            const values = await Promise.all([
              tools.child({ sequence: 1 }),
              tools.child({ sequence: 2 }),
              tools.child({ sequence: 3 }),
            ]);
            text(values.map((value) => value.output));
          `,
        },
      },
    ]),
    bundles: [child],
    runtimes: [new RunCodeToolRuntime()],
    maxConcurrentToolBodies: 2,
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "nested cap");

  await within(twoStarted.promise, "two nested bodies");
  await nextTask();
  assert.equal(starts, 2);
  assert.equal(maxActive, 2);
  releaseFirst.resolve();
  await within(thirdStarted.promise, "the third nested body");
  releaseThird.resolve();
  await nextTask();
  assert.deepEqual(
    toolResults((await server.readThread(thread.id)).items).map(
      (result) => result.output,
    ),
    ["1"],
  );
  releaseSecond.resolve();
  await within(turn.done, "the nested-cap Turn");

  const snapshot = await server.readThread(thread.id);
  const calls = snapshot.items.filter((item) => item.type === "tool_call");
  const children = calls.filter((item) => item.parentCallId === "outer");
  assert.equal(children.length, 3);
  assert.deepEqual(
    toolResults(snapshot.items).map((result) => result.callId),
    [...children.map((call) => call.callId), "outer"],
  );
  assertEveryToolCallHasOneResult(snapshot.items);
});

test("both presentation freezes direct and nested capabilities through scheduler barriers", async () => {
  const directStarted = deferred<void>();
  const twoNestedStarted = deferred<void>();
  const releaseDirect = deferred<void>();
  const releaseNested = deferred<void>();
  let nestedStarts = 0;
  let active = 0;
  let maxActive = 0;
  let hiddenExecutions = 0;
  const visible = testToolBundle({ kind: "external", id: "visible" }, [
    testToolRuntime({
      name: "visible_child",
      description: "Frozen scheduler fixture.",
      inputSchema: {
        type: "object",
        properties: { sequence: { type: "number" } },
        required: ["sequence"],
        additionalProperties: false,
      },
      executionMode: "parallel_safe",
      execute: async (invocation) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (invocation.callId === "direct-visible") {
          directStarted.resolve();
          await releaseDirect.promise;
        } else {
          nestedStarts += 1;
          if (nestedStarts === 2) twoNestedStarted.resolve();
          await releaseNested.promise;
        }
        active -= 1;
        return {
          output: String(invocation.arguments.sequence),
          exitCode: 0,
        };
      },
    }),
  ]);
  const hidden = testToolBundle({ kind: "external", id: "late-hidden" }, [
    testToolRuntime({
      name: "late_hidden",
      description: "Registered after the sample freezes.",
      executionMode: "parallel_safe",
      execute: async () => {
        hiddenExecutions += 1;
        return { output: "hidden", exitCode: 0 };
      },
    }),
  ]);
  const environment = new ToolEnvironment({
    bundles: [visible],
    runtimes: [new RunCodeToolRuntime()],
  });
  const requests: ModelRequest[] = [];
  let sample = 0;
  const model: ModelAdapter = {
    provider: "frozen-scheduler-model",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request));
      sample += 1;
      if (sample === 1) {
        environment.registerBundle(hidden);
        yield {
          type: "tool_call",
          callId: "direct-visible",
          name: "visible_child",
          arguments: { sequence: 0 },
        };
        yield {
          type: "tool_call",
          callId: "outer",
          name: "run_code",
          arguments: {
            description: "exercise frozen nested scheduling",
            code: `
              const values = await Promise.all([
                tools.visible_child({ sequence: 1 }),
                tools.visible_child({ sequence: 2 }),
                tools.late_hidden({}).catch((error) => ({ output: error.message, exitCode: 1 })),
              ]);
              text(values);
            `,
          },
        };
        yield {
          type: "tool_call",
          callId: "direct-hidden",
          name: "late_hidden",
          arguments: {},
        };
      } else {
        yield { type: "text_delta", delta: "done" };
      }
    },
  };
  const catalog = new StaticModelCatalog([
    { id: "model", isDefault: true, contextWindow: 32_768 },
  ]);
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      toolEnvironment: environment,
      toolPresentation: "both",
      maxConcurrentToolBodies: 2,
      toolDefinitionProjection: () =>
        environment.definitions.filter(({ name }) => name !== "late_hidden"),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: catalog,
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "frozen scheduler");

  await within(directStarted.promise, "the direct body before run_code");
  await nextTask();
  assert.equal(nestedStarts, 0);
  releaseDirect.resolve();
  await within(twoNestedStarted.promise, "two nested bodies at the shared cap");
  assert.equal(active, 2);
  assert.equal(maxActive, 2);
  assert.equal(hiddenExecutions, 0);
  releaseNested.resolve();
  await within(turn.done, "the frozen scheduler Turn");

  assert.deepEqual(
    requests[0]?.tools.map(({ name }) => name),
    ["visible_child", "run_code"],
  );
  assert.match(requests[0]?.tools[1]?.description ?? "", /visible_child/u);
  assert.doesNotMatch(requests[0]?.tools[1]?.description ?? "", /late_hidden/u);
  assert.equal(hiddenExecutions, 0);
  const snapshot = await server.readThread(thread.id);
  const children = snapshot.items.filter(
    (item) => item.type === "tool_call" && item.parentCallId === "outer",
  );
  assert.equal(children.length, 3);
  assert.deepEqual(
    toolResults(snapshot.items).map((result) => result.callId),
    [
      "direct-visible",
      ...children.map((child) => {
        assert.equal(child.type, "tool_call");
        return child.callId;
      }),
      "outer",
      "direct-hidden",
    ],
  );
  const hiddenResults = toolResults(snapshot.items).filter((result) => {
    const call = snapshot.items.find(
      (item) => item.type === "tool_call" && item.callId === result.callId,
    );
    return call?.type === "tool_call" && call.name === "late_hidden";
  });
  assert.equal(hiddenResults.length, 2);
  for (const result of hiddenResults) {
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /not available in this model sample/u);
  }
  assertEveryToolCallHasOneResult(snapshot.items);
});

test("nested body results reach guest promises before ordered canonical commit", async () => {
  const firstStarted = deferred<void>();
  const thirdStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const bundle = testToolBundle({ kind: "external", id: "nested-result" }, [
    testToolRuntime({
      name: "child",
      description: "Nested result fixture.",
      executionMode: "parallel_safe",
      execute: async (invocation) => {
        const label = String(invocation.arguments.label);
        if (label === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else if (label === "third") {
          thirdStarted.resolve();
        }
        return { output: label, exitCode: 0 };
      },
    }),
  ]);
  const server = runtimeServer({
    model: batchModel([
      {
        callId: "outer",
        name: "run_code",
        arguments: {
          description: "guest result before commit",
          code: `
            const first = Promise.resolve(tools.child({ label: "first" }));
            const second = Promise.resolve(tools.child({ label: "second" }));
            await second;
            await tools.child({ label: "third" });
            await first;
          `,
        },
      },
    ]),
    bundles: [bundle],
    runtimes: [new RunCodeToolRuntime()],
    maxConcurrentToolBodies: 2,
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "nested result");

  await within(firstStarted.promise, "the first nested body");
  await within(
    thirdStarted.promise,
    "guest continuation before the first canonical result",
  );
  assert.equal(
    toolResults((await server.readThread(thread.id)).items).length,
    0,
  );
  releaseFirst.resolve();
  await within(turn.done, "the nested-result Turn");
  assertEveryToolCallHasOneResult((await server.readThread(thread.id)).items);
});

test("parallel failure settles in order and does not suppress later calls", async () => {
  const firstStarted = deferred<void>();
  const failed = deferred<void>();
  const releaseFirst = deferred<void>();
  const bundle = testToolBundle({ kind: "external", id: "failure" }, [
    testToolRuntime({
      name: "parallel",
      description: "Failure fixture.",
      executionMode: "parallel_safe",
      execute: async (invocation) => {
        if (invocation.callId === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
          return { output: "first", exitCode: 0 };
        }
        failed.resolve();
        throw new Error("fixture failure");
      },
    }),
  ]);
  const server = runtimeServer({
    model: batchModel([
      { callId: "first", name: "parallel" },
      { callId: "failed", name: "parallel" },
    ]),
    bundles: [bundle],
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "failure");

  await within(firstStarted.promise, "the leading body");
  await within(failed.promise, "the failing overlapping body");
  await nextTask();
  assert.equal(
    toolResults((await server.readThread(thread.id)).items).length,
    0,
  );
  releaseFirst.resolve();
  await within(turn.done, "the failure Turn");
  const results = toolResults((await server.readThread(thread.id)).items);
  assert.deepEqual(
    results.map((result) => result.callId),
    ["first", "failed"],
  );
  assert.equal(results[1]?.exitCode, 1);
  assert.match(results[1]?.output ?? "", /fixture failure/u);
});

test("abort settles every admitted parallel call once and leaves no body active", async () => {
  const bothStarted = deferred<void>();
  const secondSawAbort = deferred<void>();
  const releaseSecondAbort = deferred<void>();
  let starts = 0;
  let active = 0;
  const bundle = testToolBundle({ kind: "external", id: "abort" }, [
    testToolRuntime({
      name: "parallel",
      description: "Abort fixture.",
      executionMode: "parallel_safe",
      execute: async (invocation) => {
        starts += 1;
        active += 1;
        if (starts === 2) bothStarted.resolve();
        try {
          return await new Promise<ToolExecutionResult>((_resolve, reject) => {
            invocation.signal.addEventListener(
              "abort",
              () => {
                if (invocation.callId === "second") {
                  secondSawAbort.resolve();
                  void releaseSecondAbort.promise.then(() =>
                    reject(invocation.signal.reason),
                  );
                } else {
                  reject(invocation.signal.reason);
                }
              },
              { once: true },
            );
          });
        } finally {
          active -= 1;
        }
      },
    }),
  ]);
  const server = runtimeServer({
    model: batchModel([
      { callId: "first", name: "parallel" },
      { callId: "second", name: "parallel" },
    ]),
    bundles: [bundle],
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "abort");
  await within(bothStarted.promise, "both abortable bodies");
  const interruption = server.interruptTurn(thread.id, turn.id);
  await within(secondSawAbort.promise, "the second body to observe abort");
  assert.equal(
    (await server.readThread(thread.id)).items.some(
      (item) => item.type === "turn_aborted",
    ),
    false,
  );
  releaseSecondAbort.resolve();
  await within(interruption, "Turn interruption");
  await within(turn.done, "the interrupted Turn");

  const snapshot = await server.readThread(thread.id);
  assert.equal(active, 0);
  assertEveryToolCallHasOneResult(snapshot.items);
  assert.deepEqual(
    toolResults(snapshot.items).map((result) => [
      result.callId,
      result.exitCode,
    ]),
    [
      ["first", 130],
      ["second", 130],
    ],
  );
  assert.equal(snapshot.turns[0]?.status, "interrupted");
});

test("parallel-safe preparation leases survive bundle removal while queued", async () => {
  const twoLeases = deferred<void>();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let leases = 0;
  const bundle = testToolBundle(
    { kind: "external", id: "leased" },
    [
      testToolRuntime({
        name: "parallel",
        description: "Bundle lease fixture.",
        executionMode: "parallel_safe",
        execute: async (invocation) => {
          if (invocation.callId === "first") {
            firstStarted.resolve();
            await releaseFirst.promise;
          } else {
            secondStarted.resolve();
          }
          return { output: invocation.callId, exitCode: 0 };
        },
      }),
    ],
    () => {
      leases += 1;
      if (leases === 2) twoLeases.resolve();
      return () => {
        leases -= 1;
      };
    },
  );
  const environment = new ToolEnvironment({ bundles: [bundle] });
  const catalog = new StaticModelCatalog([
    { id: "model", isDefault: true, contextWindow: 32_768 },
  ]);
  const model = batchModel([
    { callId: "first", name: "parallel" },
    { callId: "second", name: "parallel" },
  ]);
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      toolEnvironment: environment,
      maxConcurrentToolBodies: 1,
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: catalog,
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "lease");

  await within(firstStarted.promise, "the first leased body");
  await within(twoLeases.promise, "both preparation leases");
  assert.equal(environment.unregisterBundle(bundle.identity), true);
  assert.equal(leases, 2);
  releaseFirst.resolve();
  await within(secondStarted.promise, "the queued leased body");
  await within(turn.done, "the bundle-removal Turn");
  assert.equal(leases, 0);
  assertEveryToolCallHasOneResult((await server.readThread(thread.id)).items);
});

test("outer admissions stay FIFO while an admitted parallel body runs", async () => {
  const firstApproval = deferred<void>();
  const secondApproval = deferred<void>();
  const releaseFirstApproval = deferred<void>();
  const releaseBodies = deferred<void>();
  const approvals: string[] = [];
  const execute = async (
    invocation: Parameters<ToolRuntime["execute"]>[0],
  ): Promise<ToolExecutionResult> => {
    await releaseBodies.promise;
    return { output: invocation.name, exitCode: 0 };
  };
  const bundle = testToolBundle({ kind: "external", id: "admission" }, [
    testToolRuntime({
      name: "first_tool",
      description: "First admission fixture.",
      executionMode: "parallel_safe",
      execute,
    }),
    testToolRuntime({
      name: "second_tool",
      description: "Second admission fixture.",
      executionMode: "parallel_safe",
      execute,
    }),
  ]);
  const server = runtimeServer({
    model: batchModel([
      { callId: "first", name: "first_tool" },
      { callId: "second", name: "second_tool" },
    ]),
    bundles: [bundle],
    approvalPolicy: "always",
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "admission", {
    requestApproval: async (request) => {
      approvals.push(request.callId);
      if (request.callId === "first") {
        firstApproval.resolve();
        await releaseFirstApproval.promise;
      } else {
        secondApproval.resolve();
      }
      return "accept";
    },
  });

  await within(firstApproval.promise, "the first approval");
  await nextTask();
  assert.deepEqual(approvals, ["first"]);
  releaseFirstApproval.resolve();
  await within(secondApproval.promise, "the second approval");
  assert.deepEqual(approvals, ["first", "second"]);
  releaseBodies.resolve();
  await within(turn.done, "the admission Turn");
});

test("sibling run_code calls are serial composite barriers", async () => {
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const starts: string[] = [];
  const child = testToolBundle({ kind: "external", id: "composite-child" }, [
    testToolRuntime({
      name: "child",
      description: "Composite child fixture.",
      executionMode: "parallel_safe",
      execute: async (invocation) => {
        const label = String(invocation.arguments.label);
        starts.push(label);
        if (label === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
        }
        return { output: label, exitCode: 0 };
      },
    }),
  ]);
  const server = runtimeServer({
    model: batchModel([
      {
        callId: "outer-first",
        name: "run_code",
        arguments: {
          description: "first composite",
          code: `await tools.child({ label: "first" });`,
        },
      },
      {
        callId: "outer-second",
        name: "run_code",
        arguments: {
          description: "second composite",
          code: `await tools.child({ label: "second" });`,
        },
      },
    ]),
    bundles: [child],
    runtimes: [new RunCodeToolRuntime()],
    maxConcurrentToolBodies: 1,
  });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "composite barriers");

  await within(firstStarted.promise, "the first composite child");
  await nextTask();
  assert.deepEqual(starts, ["first"]);
  releaseFirst.resolve();
  await within(secondStarted.promise, "the second composite child");
  assert.deepEqual(starts, ["first", "second"]);
  await within(turn.done, "the composite Turn");

  const snapshot = await server.readThread(thread.id);
  const results = toolResults(snapshot.items);
  const firstOuterResult = results.findIndex(
    (result) => result.callId === "outer-first",
  );
  const secondChildResult = results.findIndex((result) => {
    const call = snapshot.items.find(
      (item) => item.type === "tool_call" && item.callId === result.callId,
    );
    return call?.type === "tool_call" && call.parentCallId === "outer-second";
  });
  assert(firstOuterResult >= 0 && firstOuterResult < secondChildResult);
  assertEveryToolCallHasOneResult(snapshot.items);
});
