import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolEnvironment,
  UnawaitedNestedToolCallError,
  type CompositeToolRuntime,
  type ToolRuntime,
} from "../src/tool.js";
import { ZenAppServer } from "../src/app-server.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { RunCodeToolRuntime } from "../src/code-runtime.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { createMediaOutputConverter } from "../src/model-content.js";
import { png1x1 } from "./fixtures.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("bounded cancellation did not return")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const invocation = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  callId: name,
  arguments: args,
  threadId: "thread",
  cwd: process.cwd(),
  signal: new AbortController().signal,
});

for (const cancel of ["parent", "deadline"] as const) {
  test(`inherited completion wait releases observation after ${cancel} cancellation with partial output and a reusable handle`, async (t) => {
    const started = deferred();
    const finish = deferred();
    const controller = new AbortController();
    const env = new ToolEnvironment({
      taskOptions: { yieldTimeMs: 1, shutdownWaitMs: 20 },
      runtimes: [
        {
          name: "child",
          specification: {
            name: "child",
            description: "child",
            inputSchema: {},
          },
          async execute(call) {
            call.taskContext?.onOutput("partial-evidence");
            started.resolve();
            await finish.promise;
            return { output: "late-final", exitCode: 0 };
          },
        },
      ],
    });
    t.after(async () => {
      finish.resolve();
      await env.close();
    });
    const pending = env.execute(
      env.prepare({
        ...invocation("child"),
        signal: controller.signal,
        task: {
          waitForCompletion: true,
          timeoutMs: cancel === "deadline" ? 30 : 10000,
        },
      }),
    );
    await started.promise;
    if (cancel === "parent") controller.abort();
    const result = await within(pending);
    const data = result.structuredContent as {
      status: string;
      task_id: string;
    };
    assert.equal(data.status, "cancellation_unconfirmed");
    assert.match(result.output, /partial-evidence/);
    assert.equal(env.taskManager.activeTaskCount, 1);
    await assert.rejects(
      env.execute(env.prepare(invocation("child"))),
      /resource is busy/,
    );
    const next = await env.waitRuntime.execute(
      invocation("wait", { task_id: data.task_id, yield_time_ms: 1 }),
    );
    assert.doesNotMatch(next.output, /partial-evidence/);
    finish.resolve();
    const final = await env.waitRuntime.execute(
      invocation("wait", { task_id: data.task_id, yield_time_ms: 500 }),
    );
    assert.match(final.output, /late-final/);
    assert.equal(
      (final.structuredContent as { status: string }).status,
      "completed",
    );
    assert.equal(env.taskManager.activeTaskCount, 0);
  });
}

function serverFor(
  env: ToolEnvironment,
  code: string,
  journal = new InMemoryThreadJournal(),
  attachments = new InMemoryAttachmentStore(),
) {
  let round = 0;
  return new ZenAppServer({
    journal,
    attachments,
    runtime: new AgentRuntime({
      toolEnvironment: env,
      resolveCodeMedia: createMediaOutputConverter(attachments),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "test",
        adapter: {
          provider: "test",
          async *stream() {
            if (++round === 1)
              yield {
                type: "tool_call" as const,
                callId: "program",
                name: "run_code",
                arguments: { code },
              };
            else yield { type: "text_delta" as const, delta: "done" };
          },
        },
        modelCatalog: new StaticModelCatalog([
          {
            id: "model",
            isDefault: true,
            contextWindow: 32768,
            inputModalities: ["text", "image"],
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "test",
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

for (const unawaited of [false, true]) {
  test(`Runtime commits authoritative child cancellation receipt (unawaited=${unawaited})`, async (t) => {
    const controller = new AbortController();
    const finish = deferred();
    const composite: CompositeToolRuntime = {
      name: "run_code",
      specification: { name: "run_code", description: "code", inputSchema: {} },
      async execute() {
        throw new Error("wrong entry");
      },
      async executeComposite(_call, port) {
        return await port.invoke("child", {}, controller.signal);
      },
    };
    const child: ToolRuntime = {
      name: "child",
      specification: { name: "child", description: "child", inputSchema: {} },
      async execute(call) {
        call.taskContext?.onOutput("streamed-child-evidence");
        controller.abort(
          unawaited ? new UnawaitedNestedToolCallError() : new Error("cancel"),
        );
        await finish.promise;
        return { output: "late-result", exitCode: 0 };
      },
    };
    const env = new ToolEnvironment({
      runtimes: [composite, child],
      taskOptions: { yieldTimeMs: 2000, shutdownWaitMs: 400 },
    });
    t.after(async () => {
      finish.resolve();
      await env.close();
    });
    const server = serverFor(env, "unused");
    const thread = await server.startThread();
    await within((await server.startTurn(thread.id, "run")).done);
    const items = (await server.readThread(thread.id)).items;
    const childCall = items.find(
      (i) => i.type === "tool_call" && i.name === "child",
    );
    assert(childCall?.type === "tool_call");
    const result = items.find(
      (i) => i.type === "tool_result" && i.callId === childCall.callId,
    );
    assert(result?.type === "tool_result");
    assert.equal(
      (result.structuredContent as { status: string }).status,
      "cancellation_unconfirmed",
    );
    assert.match(result.output, /streamed-child-evidence/);
    const handle = (result.structuredContent as { task_id: string }).task_id;
    const next = await env.waitRuntime.execute({
      ...invocation("wait", { task_id: handle, yield_time_ms: 1 }),
      threadId: thread.id,
    });
    assert.doesNotMatch(next.output, /streamed-child-evidence/);
  });
}

test("image conversion waits for the child canonical attachment commit", async (t) => {
  const attachments = new InMemoryAttachmentStore();
  const attachment = await attachments.importBytes(png1x1());
  class DelayedJournal extends InMemoryThreadJournal {
    override async append(
      item: Parameters<InMemoryThreadJournal["append"]>[0],
    ) {
      if (
        item.type === "tool_result" &&
        item.modelContent?.some((p) => p.type === "image")
      ) {
        await new Promise((r) => setTimeout(r, 60));
      }
      await super.append(item);
    }
  }
  const env = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 2000 },
    runtimes: [
      new RunCodeToolRuntime(),
      {
        name: "picture",
        executionMode: "parallel_safe",
        specification: {
          name: "picture",
          description: "picture",
          inputSchema: {},
        },
        async execute() {
          return {
            output: "picture",
            exitCode: 0,
            modelContent: [{ type: "image" as const, attachment }],
          };
        },
      },
    ],
  });
  t.after(() => env.close());
  const server = serverFor(
    env,
    "const result = await tools.picture({}); image(result.modelContent[0]);",
    new DelayedJournal(),
    attachments,
  );
  const thread = await server.startThread();
  await within((await server.startTurn(thread.id, "image")).done);
  const items = (await server.readThread(thread.id)).items;
  const result = items.find(
    (i) => i.type === "tool_result" && i.callId === "program",
  );
  assert(result?.type === "tool_result");
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(result.modelContent, [{ type: "image", attachment }]);
});

test("a child settling during cancellation grace returns its final evidence", async (t) => {
  const controller = new AbortController();
  const started = deferred();
  const env = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 1, shutdownWaitMs: 200 },
    runtimes: [
      {
        name: "child",
        specification: {
          name: "child",
          description: "cooperative",
          inputSchema: {},
        },
        taskPolicy: { cancellation: "confirmed-on-settle" },
        async execute(call) {
          const aborted = new Promise<void>((resolve) =>
            call.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          started.resolve();
          await aborted;
          await new Promise((r) => setTimeout(r, 10));
          return { output: "cleanup-completed", exitCode: 130 };
        },
      },
    ],
  });
  t.after(() => env.close());
  const pending = env.execute(
    env.prepare({
      ...invocation("child"),
      signal: controller.signal,
      task: { waitForCompletion: true },
    }),
  );
  await started.promise;
  controller.abort();
  const result = await within(pending);
  assert.equal(
    (result.structuredContent as { status: string }).status,
    "cancelled",
  );
  assert.match(result.output, /cleanup-completed/);
  assert.equal(result.exitCode, 130);
  assert.equal(env.taskManager.activeTaskCount, 0);
});

test("real guest abandoning a started child retains streamed evidence and a wait handle", async (t) => {
  const finish = deferred();
  const env = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 2000 },
    runtimes: [
      new RunCodeToolRuntime(),
      {
        name: "child",
        specification: { name: "child", description: "child", inputSchema: {} },
        async execute(call) {
          call.taskContext?.onOutput("real-guest-partial");
          await finish.promise;
          return { output: "real-guest-final", exitCode: 0 };
        },
      },
    ],
  });
  t.after(async () => {
    finish.resolve();
    await env.close();
  });
  const server = serverFor(
    env,
    "void tools.child({}).then(() => undefined); await new Promise(r => setTimeout(r, 50));",
  );
  const thread = await server.startThread();
  await within((await server.startTurn(thread.id, "run")).done);
  const items = (await server.readThread(thread.id)).items;
  const child = items.find((i) => i.type === "tool_call" && i.name === "child");
  assert(child?.type === "tool_call");
  const result = items.find(
    (i) => i.type === "tool_result" && i.callId === child.callId,
  );
  assert(result?.type === "tool_result");
  const data = result.structuredContent as { status: string; task_id: string };
  assert.equal(data.status, "cancellation_unconfirmed");
  assert.match(result.output, /real-guest-partial/);
  finish.resolve();
  const final = await env.waitRuntime.execute({
    ...invocation("wait", { task_id: data.task_id, yield_time_ms: 500 }),
    threadId: thread.id,
  });
  assert.match(final.output, /real-guest-final/);
  assert.doesNotMatch(final.output, /real-guest-partial/);
});
