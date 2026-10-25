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

function fixture(window: number, description: string, instructions = "") {
  let requests = 0;
  const adapter: ModelAdapter = {
    provider: "fixture",
    contextInstructions: instructions,
    async *stream(): AsyncIterable<ModelEvent> {
      requests++;
      yield { type: "text_delta", delta: "ok" };
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
  return { server, requests: () => requests, runtime };
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

test("generated run_code SDK is budgeted once as actually disclosed, including nested plugin signatures", async () => {
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
  assert(code.modelTools[0]!.description.includes("plugin_read"));
  const estimate = estimateModelInput([], code.modelTools);
  assert.equal(estimate.total, estimate.toolDefinitions);
  assert.equal(
    estimate.toolDefinitions,
    Math.ceil(JSON.stringify(code.modelTools[0]).length / 4) + 4,
  );
  assert(
    estimate.toolDefinitions >
      estimateModelInput([], definitions).toolDefinitions,
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

test("post-discovery expansion blocks the next sample in direct/code/both modes without replaying effects", async (t) => {
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
              // Synthetic execution receipt; code mode still uses the production generated SDK.
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
          assert.equal(samples, 1);
          assert.equal(executions, 1);
          const snapshot = await server.readThread(thread.id);
          assert.equal(snapshot.turns[0]?.status, "failed");
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
            1,
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
      assert(
        estimateModelInput(
          request.messages,
          request.tools,
          this.contextInstructions,
        ).total < 4000,
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
        assert(
          JSON.stringify(request.messages).includes("image input unavailable"),
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
  const messages = compileModelMessages(snapshot.items);
  const tools = runtime.projectToolPresentation(
    snapshot.items,
    false,
  ).modelTools;
  assert(
    estimateModelInput(messages, tools, model.contextInstructions).total > 4000,
  );
  const expected = estimateModelInput(
    projectModelMessages(messages, ["text"]),
    tools,
    model.contextInstructions,
  );
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
