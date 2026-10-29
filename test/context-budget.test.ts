import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../src/model.js";
import {
  estimateModelInput,
  isModelUsageProjection,
  projectModelUsage,
} from "../src/model-usage.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { testToolRuntime } from "./tool-fixtures.js";
import type { CanonicalItem } from "../src/item.js";
import { compileItemList } from "../src/item-list.js";

function fixture(window: number, description: string, instructions = "") {
  let requests = 0;
  const adapter: ModelAdapter = {
    provider: "fixture",
    contextInstructions: instructions,
    async *stream(): AsyncIterable<ModelEvent> {
      requests++;
      yield { type: "text_delta", delta: "ok" };
      yield { type: "usage", inputTokens: 77, outputTokens: 3 };
    },
  };
  const runtime = new AgentRuntime({
    toolEnvironment: new ToolEnvironment({
      runtimes: [
        testToolRuntime({
          name: "fixture",
          description,
          execute: async () => ({ output: "ok", exitCode: 0 }),
        }),
      ],
    }),
  });
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime,
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "fixture",
        adapter,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture", isDefault: true, contextWindow: window },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: "fixture",
      modelId: "fixture",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  return { server, requests: () => requests, runtime, adapter };
}

test("tool definitions alone exhaust window before any provider or compaction request", async () => {
  const f = fixture(500, "schema documentation ".repeat(500));
  const thread = await f.server.startThread();
  await assert.rejects(
    f.server.startTurn(thread.id, "hello"),
    /tool definitions and static model instructions exceed/i,
  );
  assert.equal(f.requests(), 0);
  assert.equal(
    (await f.server.readThread(thread.id)).items.some(
      (i) => i.type === "context_compaction",
    ),
    false,
  );
});

test("tools plus adapter static instructions exhaust the fixed budget before any request or compaction", async () => {
  const baseline = fixture(1000, "small tool");
  const tools = estimateModelInput(
    [],
    baseline.runtime.projectToolPresentation([], false).modelTools,
  ).total;
  assert(tools < 1000);
  const staticInstructions = "s".repeat((1000 - tools) * 4);
  assert(estimateModelInput([], [], staticInstructions).total < 1000);
  const f = fixture(1000, "small tool", staticInstructions);
  const thread = await f.server.startThread();
  await assert.rejects(
    f.server.startTurn(thread.id, "hello"),
    /static model instructions exceed/,
  );
  assert.equal(f.requests(), 0);
  assert.equal(
    (await f.server.readThread(thread.id)).items.some(
      (item) => item.type === "context_compaction",
    ),
    false,
  );
});

test("next-request breakdown sums and contains actual tool exposure without double counting", async () => {
  const f = fixture(32000, "plugin schema text", "static system");
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "hello")
  ).done;
  const usage = await f.server.readModelUsage(thread.id);
  const estimate = usage.context.estimate!;
  assert.equal(
    estimate.total,
    estimate.instructions +
      estimate.toolDefinitions +
      estimate.pluginContext +
      estimate.conversation,
  );
  assert(estimate.toolDefinitions > 0);
  assert(estimate.instructions > 0);
  assert(estimate.conversation > 0);
  assert.equal(usage.context.inputTokenSource, "estimated");
  assert.equal(usage.context.inputTokens, estimate.total);
  assert(isModelUsageProjection(usage));
  assert(
    !isModelUsageProjection({
      ...usage,
      context: {
        ...usage.context,
        estimate: { ...estimate, total: estimate.total + 1 },
      },
    }),
  );
});

test("canonical provenance separates instructions and injected plugin text, not human lookalikes", () => {
  const base = { threadId: "fixture", createdAt: "2026-01-01T00:00:00Z" };
  const items: CanonicalItem[] = [
    {
      ...base,
      type: "thread_instruction",
      id: "instructions",
      text: "host instruction",
    },
    {
      ...base,
      type: "host_message",
      id: "trigger",
      turnId: "t",
      sender: "host",
      clientId: "trigger-client",
      source: "trigger",
      text: "trigger text",
      mode: "start",
    },
    {
      ...base,
      type: "user_message",
      id: "user",
      turnId: "t",
      text: "[Host wakeup. Source: trigger] human text",
    },
  ];
  const messages = compileModelMessages(items);
  const estimate = estimateModelInput(messages, []);
  assert(estimate.instructions > 0);
  assert(estimate.pluginContext > 0);
  assert(estimate.conversation > 0);
  // Metadata is never included in the model's serialized message.
  assert(!JSON.stringify(messages).includes("pluginContext"));
  assert.equal(
    estimate.total,
    estimate.instructions + estimate.pluginContext + estimate.conversation,
  );
});

test("stable run_code declaration is budgeted without unprinted catalog details", async () => {
  const { buildToolPresentation } = await import("../src/tool-presentation.js");
  const definitions = [
    {
      name: "run_code",
      description: "runtime registration, not actual SDK",
      inputSchema: {},
    },
    {
      name: "plugin_read",
      description: "nested plugin capability ".repeat(100),
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ];
  const code = buildToolPresentation(definitions, "code");
  assert.equal(code.modelTools.length, 1);
  assert(!code.modelTools[0]!.description.includes("plugin_read"));
  assert(code.codeTools.some(({ name }) => name === "plugin_read"));
  const estimate = estimateModelInput([], code.modelTools);
  assert.equal(estimate.total, estimate.toolDefinitions);
  assert.equal(
    estimate.toolDefinitions,
    Math.ceil(JSON.stringify(code.modelTools[0]).length / 4) + 4,
  );
  assert.equal(
    estimate.toolDefinitions,
    estimateModelInput(
      [],
      buildToolPresentation([definitions[0]!], "code").modelTools,
    ).toolDefinitions,
  );
  const tool = {
    name: "plugin_read",
    description: "Read plugin data.",
    inputSchema: { type: "object" },
  };
  assert.deepEqual(
    estimateModelInput([], [tool]),
    estimateModelInput(
      [],
      [
        {
          ...tool,
          pluginId: "fixture",
          fullDescription: "long usage ".repeat(5000),
        },
      ],
    ),
  );
});

test("a current estimate is never replaced by stale provider usage and category validation is additive", () => {
  const usage = projectModelUsage(
    [
      {
        id: "usage",
        threadId: "fixture",
        turnId: "t",
        createdAt: "2026-01-01T00:00:00Z",
        type: "model_usage",
        modelResponseId: "r",
        inputTokens: 12,
        outputTokens: 1,
      },
    ],
    {
      contextWindow: 1000,
      estimate: {
        total: 100,
        instructions: 10,
        toolDefinitions: 40,
        pluginContext: 20,
        conversation: 30,
      },
    },
  );
  assert.equal(usage.context.inputTokens, 100);
  assert.equal(usage.context.lastProviderInputTokens, 12);
  assert.equal(usage.context.ratio, 0.1);
  assert.equal(usage.context.inputTokenSource, "estimated");
});

test("new eager schemas affect budgeting but code-only catalog details do not", async (t) => {
  for (const mode of ["direct", "code", "both"] as const) {
    for (const reportUsage of [false, true]) {
      await t.test(
        `${mode}, ${reportUsage ? "stale" : "absent"} usage`,
        async () => {
          let samples = 0;
          let executions = 0;
          const execute = async () => {
            executions++;
            return { output: "disclosed", exitCode: 0 };
          };
          const environment = new ToolEnvironment({
            runtimes: [
              testToolRuntime({ name: "disclose", execute }),
              // Synthetic execution receipt; code mode uses the production stable descriptor.
              testToolRuntime({ name: "run_code", execute }),
            ],
          });
          const runtime = new AgentRuntime({
            toolEnvironment: environment,
            toolPresentation: mode,
            toolDefinitionProjection: (items) => [
              ...environment.definitions,
              ...(items.some((item) => item.type === "tool_result")
                ? [
                    {
                      name: "large_plugin",
                      description: "plugin documentation ".repeat(6000),
                      inputSchema: {},
                    },
                  ]
                : []),
            ],
          });
          const model: ModelAdapter = {
            provider: "fixture",
            async *stream() {
              samples++;
              if (samples > 1) {
                yield { type: "text_delta", delta: "done" };
                return;
              }
              yield {
                type: "tool_call",
                callId: "disclose",
                name: mode === "code" ? "run_code" : "disclose",
                arguments:
                  mode === "code" ? { code: "/* synthetic receipt */" } : {},
              };
              if (reportUsage)
                yield { type: "usage", inputTokens: 20, outputTokens: 1 };
            },
          };
          const server = new ZenAppServer({
            journal: new InMemoryThreadJournal(),
            runtime,
            providerRegistry: new ProviderRegistry([
              {
                providerProfileId: "fixture",
                adapter: model,
                modelCatalog: new StaticModelCatalog([
                  { id: "fixture", isDefault: true, contextWindow: 4000 },
                ]),
              },
            ]),
            threadMetadata: new InMemoryThreadMetadataStore(),
            defaults: {
              cwd: os.tmpdir(),
              providerProfileId: "fixture",
              modelId: "fixture",
              reasoningEffort: "medium",
              sandbox: "danger-full-access",
              approvalPolicy: "never",
            },
          });
          const thread = await server.startThread();
          await (
            await server.startTurn(thread.id, "discover")
          ).done;
          assert.equal(samples, mode === "code" ? 2 : 1);
          assert.equal(executions, 1);
          const snapshot = await server.readThread(thread.id);
          assert.equal(
            snapshot.turns[0]?.status,
            mode === "code" ? "completed" : "failed",
          );
          assert(
            snapshot.items.some(
              (item) =>
                item.type === "tool_result" && item.output === "disclosed",
            ),
          );
          assert.equal(
            snapshot.items.filter((item) => item.type === "context_compaction")
              .length,
            0,
          );
          assert.equal(
            snapshot.items.filter((item) => item.type === "failure").length,
            mode === "code" ? 0 : 1,
          );
          await environment.close();
        },
      );
    }
  }
});

test("text-only capability projection budgets media receipts, preserving UI categories and actual sample totals", async () => {
  const { projectModelMessages } = await import("../src/model-content.js");
  let calls = 0;
  let lastRequest: ModelRequest | undefined;
  const environment = new ToolEnvironment({
    runtimes: [
      testToolRuntime({
        name: "image_fixture",
        execute: async () => ({
          output: "image receipt",
          exitCode: 0,
          modelContent: [
            {
              type: "image",
              attachment: {
                type: "attachment",
                sha256: "a".repeat(64),
                mediaType: "image/png",
                byteLength: 5000000,
                width: 4000,
                height: 4000,
              },
            },
          ],
        }),
      }),
    ],
  });
  const runtime = new AgentRuntime({ toolEnvironment: environment });
  const model: ModelAdapter = {
    provider: "fixture",
    contextInstructions: "static system",
    async *stream(request) {
      calls++;
      lastRequest = request;
      assert(estimateModelInput(request.messages, request.tools).total < 4000);
      assert.deepEqual(
        request.messages.filter((message) => message.role === "system"),
        [{ role: "system", text: "static system" }],
        "the compiler must materialize static instructions exactly once",
      );
      if (calls === 1)
        yield {
          type: "tool_call",
          callId: "image",
          name: "image_fixture",
          arguments: {},
        };
      else {
        assert(!JSON.stringify(request.messages).includes('"type":"image"'));
        assert.deepEqual(
          request.messages.filter(
            (message) =>
              message.role === "user" &&
              "content" in message &&
              message.content.some(
                (part) =>
                  part.type === "text" &&
                  part.text.startsWith("[image input is unavailable"),
              ),
          ),
          [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "[image input is unavailable for this selected model. Stored image attachments were not sent or read in this sample.]",
                },
              ],
            },
          ],
        );
        yield { type: "text_delta", delta: "read receipt" };
      }
    },
  };
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime,
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "fixture",
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "fixture",
            isDefault: true,
            contextWindow: 4000,
            inputModalities: ["text"],
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: "fixture",
      modelId: "fixture",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const thread = await server.startThread();
  await (
    await server.startTurn(thread.id, "inspect")
  ).done;
  const snapshot = await server.readThread(thread.id);
  assert.equal(
    snapshot.turns[0]?.status,
    "completed",
    JSON.stringify(
      snapshot.items.filter(
        (item) => item.type === "failure" || item.type === "tool_result",
      ),
    ),
  );
  assert.equal(calls, 2);
  assert(snapshot.itemList !== undefined);
  assert(lastRequest?.debugContext !== undefined);
  const compilation = {
    sampleId: lastRequest.debugContext.sampleId,
    selection: { providerProfileId: "fixture", modelId: "fixture" },
  };
  const complete = compileItemList(snapshot.itemList, compilation);
  assert(estimateModelInput(complete.messages, complete.tools).total > 4000);
  const projected = compileItemList(snapshot.itemList, {
    ...compilation,
    inputModalities: ["text"],
  });
  const expected = estimateModelInput(projected.messages, projected.tools);
  const originalResult = snapshot.items.find(
    (item) => item.type === "tool_result",
  );
  assert(originalResult?.type === "tool_result");
  assert.equal(originalResult.modelContent?.[0]?.type, "image");
  assert.deepEqual(
    (await server.readModelUsage(thread.id)).context.estimate,
    expected,
  );
  const instructions = compileModelMessages([
    {
      id: "i",
      threadId: "fixture",
      createdAt: "2026-01-01T00:00:00Z",
      type: "thread_instruction",
      text: "repository guidance",
    },
  ]);
  assert.deepEqual(
    estimateModelInput(projectModelMessages(instructions, ["text"]), []),
    estimateModelInput(instructions, []),
  );
  await environment.close();
});

test("removed provider/model preserves historical aggregates with current context explicitly unknown", async (t) => {
  for (const removed of ["provider", "model"] as const)
    await t.test(removed, async () => {
      const f = fixture(32000, "small tool");
      const thread = await f.server.startThread();
      await (
        await f.server.startTurn(thread.id, "hello")
      ).done;
      const before = await f.server.readModelUsage(thread.id);
      assert.equal(before.thread.inputTokens, 77);
      const configuration = f.server.currentRuntimeConfiguration();
      const providerProfileId =
        removed === "provider" ? "replacement-provider" : "fixture";
      f.server.publishRuntimeConfiguration(
        f.server.prepareRuntimeConfiguration({
          revision: configuration.revision + 1,
          defaults: {
            ...configuration.defaults,
            providerProfileId,
            modelId: "replacement-model",
          },
          providerProfiles: [
            {
              providerProfileId,
              adapter: f.adapter,
              modelCatalog: new StaticModelCatalog([
                {
                  id: "replacement-model",
                  isDefault: true,
                  contextWindow: 32000,
                },
              ]),
            },
          ],
        }),
      );
      const after = await f.server.readModelUsage(thread.id);
      assert.deepEqual(after.thread, before.thread);
      assert.deepEqual(after.turns, before.turns);
      assert.deepEqual(after.context, {
        inputTokens: null,
        inputTokenSource: null,
        contextWindow: null,
        ratio: null,
      });
      assert(isModelUsageProjection(after));
    });
});

test("usage projection does not swallow estimator bugs or unknown/deleted thread errors", async () => {
  const f = fixture(32000, "small tool");
  await assert.rejects(
    f.server.readModelUsage("nonexistent"),
    /Unknown thread/,
  );
  const thread = await f.server.startThread();
  await (
    await f.server.startTurn(thread.id, "hello")
  ).done;
  const original = f.runtime.projectToolPresentation;
  f.runtime.projectToolPresentation = () => {
    throw new Error("synthetic estimator failure");
  };
  await assert.rejects(
    f.server.readModelUsage(thread.id),
    /synthetic estimator failure/,
  );
  f.runtime.projectToolPresentation = original;
  const snapshot = await f.server.readThread(thread.id);
  await f.server.setThreadArchived(thread.id, true);
  await f.server.deleteThread(thread.id, snapshot.items.at(-1)!.id);
  await assert.rejects(f.server.readModelUsage(thread.id), /deleted/i);
});

test("Host/UI calibrates from the exact sent sample, not thread totals or cached subsets", async () => {
  const f = fixture(10000, "small tool");
  let requestEstimate = 0;
  let calls = 0;
  let lastSampleId: string | undefined;
  f.adapter.stream = async function* (request) {
    calls++;
    lastSampleId = request.debugContext?.sampleId;
    requestEstimate = estimateModelInput(request.messages, request.tools).total;
    yield { type: "text_delta", delta: "response" };
    yield {
      type: "usage",
      inputTokens: calls === 1 ? 500 : 700,
      cachedInputTokens: 450,
      outputTokens: 2,
    };
  };
  const thread = await f.server.startThread();
  for (const expectedProvider of [500, 700]) {
    await (
      await f.server.startTurn(thread.id, "next")
    ).done;
    const snapshot = await f.server.readThread(thread.id);
    assert(snapshot.itemList !== undefined);
    assert(lastSampleId !== undefined);
    const compiled = compileItemList(snapshot.itemList, {
      sampleId: lastSampleId,
      selection: { providerProfileId: "fixture", modelId: "fixture" },
      inputModalities: ["text"],
    });
    const raw = estimateModelInput(compiled.messages, compiled.tools);
    const usage = await f.server.readModelUsage(thread.id);
    assert.equal(
      usage.context.inputTokens,
      expectedProvider + raw.total - requestEstimate,
    );
    assert.equal(usage.context.estimate!.total, usage.context.inputTokens);
    assert.equal(
      usage.context.estimate!.instructions +
        usage.context.estimate!.toolDefinitions +
        usage.context.estimate!.pluginContext +
        usage.context.estimate!.conversation,
      usage.context.inputTokens,
    );
  }
  const usage = await f.server.readModelUsage(thread.id);
  assert.equal(usage.thread.inputTokens, 1200);
  assert.notEqual(usage.context.inputTokens, 1200);
});

test("native deferred presentation estimates only eager declarations and namespace summaries", () => {
  const tool = {
    name: "lookup",
    description: "short",
    fullDescription: "full docs ".repeat(10000),
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  };
  const descriptor = (description: string) => ({
    protocol: "openai-responses" as const,
    tools: [
      {
        type: "namespace",
        name: "plugin_docs",
        description: "Stable plugin summary",
        tools: [
          {
            type: "function",
            name: tool.name,
            description,
            parameters: tool.inputSchema,
            defer_loading: true,
          },
        ],
      },
      { type: "tool_search" },
    ],
  });
  const first = estimateModelInput([], [tool], "", descriptor("small"));
  assert.deepEqual(
    estimateModelInput([], [tool], "", descriptor(tool.fullDescription)),
    first,
  );
  assert.ok(first.toolDefinitions > 0);
  const discovered = estimateModelInput(
    [
      {
        role: "tool_discovery",
        protocol: "openai-responses",
        endpointSha256: "a".repeat(64),
        items: [
          {
            type: "tool_search_output",
            tools: [{ description: tool.fullDescription }],
          },
        ],
      },
    ],
    [tool],
    "",
    descriptor(tool.fullDescription),
  );
  assert.ok(discovered.conversation > first.conversation);
  assert.equal(discovered.toolDefinitions, first.toolDefinitions);
});
