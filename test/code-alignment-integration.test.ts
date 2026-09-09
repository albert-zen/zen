import assert from "node:assert/strict";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment, type ToolRuntime } from "../src/tool.js";
import { RunCodeToolRuntime } from "../src/code-runtime.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { createMediaOutputConverter } from "../src/model-content.js";
import { codeStateFromItems } from "../src/code-state.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/model.js";
import { png1x1 } from "./fixtures.js";

function setup(
  adapter: ModelAdapter,
  journal = new InMemoryThreadJournal(),
  tools: ToolRuntime[] = [],
  inputModalities: ("text" | "image" | "audio")[] = ["text"],
) {
  const attachments = new InMemoryAttachmentStore();
  const env = new ToolEnvironment({
    runtimes: [new RunCodeToolRuntime(), ...tools],
    taskOptions: { yieldTimeMs: 5 },
  });
  const server = new ZenAppServer({
    journal,
    attachments,
    runtime: new AgentRuntime({
      toolEnvironment: env,
      resolveCodeMedia: createMediaOutputConverter(attachments),
      maxToolRounds: 30,
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: adapter.provider,
        adapter,
        modelCatalog: new StaticModelCatalog([
          {
            id: "model",
            isDefault: true,
            contextWindow: 32768,
            inputModalities,
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: adapter.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  return { server, env, journal };
}

function waitCall(request: ModelRequest, id: string): ModelEvent | undefined {
  const last = request.messages.filter((m) => m.role === "tool").at(-1);
  if (!last || !last.text.includes("[tool task running]")) return undefined;
  const taskId = /^task_id: (.+)$/m.exec(last.text)?.[1];
  assert(taskId);
  return {
    type: "tool_call",
    callId: id,
    name: "wait",
    arguments: { task_id: taskId, yield_time_ms: 200 },
  };
}

test("whole program yields while awaited child returns final result; canonical writes survive runtime reconstruction", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let round = 0;
  const requests: ModelRequest[] = [];
  const adapter: ModelAdapter = {
    provider: "alignment",
    async *stream(request) {
      requests.push(request);
      round++;
      if (round === 1) {
        yield {
          type: "tool_call",
          callId: "program",
          name: "run_code",
          arguments: {
            code: `store("rows", [1,2,3]); text("before"); const result = await tools.child({}); text(result.output); store("done", true); text("after");`,
          },
        };
        return;
      }
      release();
      const next = waitCall(request, `wait-${round}`);
      if (next) {
        yield next;
        return;
      }
      yield { type: "text_delta", delta: "done" };
    },
  };
  const { server, env, journal } = setup(adapter, undefined, [
    {
      name: "child",
      specification: {
        name: "child",
        description: "returns final",
        inputSchema: {},
      },
      async execute() {
        await gate;
        await new Promise((r) => setTimeout(r, 25));
        return { output: "actual-child-result", exitCode: 0 };
      },
    },
  ]);
  t.after(() => env.close());
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "run code")
  ).done;
  const items = (await server.readThread(thread.id)).items;
  assert(!items.some((item) => item.type === "failure"));
  assert(
    items.some((item) => item.type === "tool_call" && item.name === "wait"),
  );
  const child = items.find(
    (item) => item.type === "tool_call" && item.name === "child",
  );
  assert(child?.type === "tool_call");
  assert.equal(child.parentCallId, "program");
  const output = items
    .flatMap((item) =>
      item.type === "tool_result" && item.callId !== child.callId
        ? [item.output]
        : [],
    )
    .join("");
  assert.match(output, /actual-child-result/);
  assert.equal(output.match(/before/g)?.length, 1);
  assert.equal(output.match(/after/g)?.length, 1);
  assert.deepEqual(
    { ...codeStateFromItems(items) },
    { rows: [1, 2, 3], done: true },
  );
  assert.doesNotMatch(
    JSON.stringify(requests.map((r) => r.messages)),
    /"type":"code_state"/,
  );

  let sample = 0;
  const restored = setup(
    {
      provider: "alignment",
      async *stream(request) {
        sample++;
        if (sample === 1) {
          yield {
            type: "tool_call",
            callId: "restore",
            name: "run_code",
            arguments: {
              code: `text(load("rows").filter(n => n > 1)); text(load("done"));`,
            },
          };
          return;
        }
        const next = waitCall(request, `restore-wait-${sample}`);
        if (next) {
          yield next;
          return;
        }
        yield { type: "text_delta", delta: "restored" };
      },
    },
    journal,
  );
  t.after(() => restored.env.close());
  await (
    await restored.server.startTurn(thread.id, "read saved data")
  ).done;
  const reloaded = (await restored.server.readThread(thread.id)).items;
  assert(
    reloaded.some(
      (item) => item.type === "tool_result" && item.output.includes("[2,3]"),
    ),
  );
  assert.deepEqual(
    { ...codeStateFromItems(reloaded) },
    { rows: [1, 2, 3], done: true },
  );
  const other = await restored.server.startThread();
  assert.deepEqual({ ...codeStateFromItems(other.items) }, {});
});

test("explicit media and text survive program failure; text-only request does not change canonical image", async (t) => {
  let round = 0;
  const requests: ModelRequest[] = [];
  const data = `data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`;
  const { server, env } = setup({
    provider: "media",
    async *stream(request) {
      requests.push(request);
      round++;
      if (round === 1) {
        yield {
          type: "tool_call",
          callId: "image-program",
          name: "run_code",
          arguments: {
            code: `text("evidence-before-failure"); image(${JSON.stringify(data)}); throw new Error("expected-failure");`,
          },
        };
        return;
      }
      const next = waitCall(request, `media-wait-${round}`);
      if (next) {
        yield next;
        return;
      }
      yield { type: "text_delta", delta: "failure inspected" };
    },
  });
  t.after(() => env.close());
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "inspect")
  ).done;
  const items = (await server.readThread(thread.id)).items;
  assert(
    items.some(
      (item) =>
        item.type === "tool_result" &&
        item.modelContent?.some((part) => part.type === "image"),
    ),
  );
  const output = items
    .filter((item) => item.type === "tool_result")
    .map((item) => item.output)
    .join("");
  assert.match(output, /evidence-before-failure/);
  assert.match(output, /expected-failure/);
  assert.doesNotMatch(
    JSON.stringify(requests.map((r) => r.messages)),
    /"type":"image"/,
  );
});
