import assert from "node:assert/strict";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import { testToolRuntime } from "./tool-fixtures.js";

test("model continues independent work then observes a generic task through canonical wait results", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const environment = new ToolEnvironment({
    taskOptions: { yieldTimeMs: 1 },
    runtimes: [
      testToolRuntime({
        name: "generate",
        execute: async (invocation) => {
          invocation.taskContext?.onOutput("generation has started\n");
          await gate;
          return { output: "generated image ready", exitCode: 0 };
        },
      }),
      testToolRuntime({
        name: "inspect",
        execute: async () => ({
          output: "independent read succeeded",
          exitCode: 0,
        }),
      }),
    ],
  });
  let samples = 0;
  let taskId = "";
  const adapter: ModelAdapter = {
    provider: "fixture",
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      samples++;
      assert(request.tools.some((tool) => tool.name === "wait"));
      assert(!request.tools.some((tool) => tool.name === "shell_wait"));
      const results = request.messages.filter(
        (message) => message.role === "tool",
      );
      if (samples === 1) {
        yield {
          type: "tool_call",
          callId: "generate-call",
          name: "generate",
          arguments: {},
        };
      } else if (samples === 2) {
        const receipt = results.find(
          (result) => result.callId === "generate-call",
        );
        assert(receipt);
        const match = /^task_id: (.+)$/mu.exec(receipt.text);
        assert(match?.[1]);
        taskId = match[1];
        assert.match(receipt.text, /generation has started/u);
        yield {
          type: "tool_call",
          callId: "inspect-call",
          name: "inspect",
          arguments: {},
        };
      } else if (samples === 3) {
        assert(
          results.some(
            (result) => result.text === "independent read succeeded",
          ),
        );
        finish();
        yield {
          type: "tool_call",
          callId: "wait-call",
          name: "wait",
          arguments: { task_id: taskId, yield_time_ms: 100 },
        };
      } else {
        assert.equal(samples, 4);
        assert(
          results.some(
            (result) =>
              result.callId === "wait-call" &&
              result.text.includes("generated image ready"),
          ),
        );
        yield { type: "text_delta", delta: "complete" };
      }
    },
  };
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({ toolEnvironment: environment }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "fixture",
        adapter,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "fixture",
      modelId: "fixture",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  try {
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "generate and inspect")
    ).done;
    const items = (await server.readThread(thread.id)).items;
    assert.equal(samples, 4);
    assert.deepEqual(
      items
        .filter((item) => item.type === "tool_call")
        .map((item) => item.name),
      ["generate", "inspect", "wait"],
    );
    assert.equal(items.filter((item) => item.type === "tool_result").length, 3);
    assert(items.some((item) => item.type === "turn_completed"));
  } finally {
    finish();
    await environment.close();
  }
});
