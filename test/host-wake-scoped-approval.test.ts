import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment, type ApprovalRequest } from "../src/tool.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelEvent, ModelRequest } from "../src/model.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import { deferred } from "./thread-message-fixture.js";

test(
  "Host soft steering preserves the prepared instance approval and never grants a sibling",
  { timeout: 10000 },
  async () => {
    const entered = deferred(),
      release = deferred();
    const executions: string[] = [];
    const prompts: ApprovalRequest[] = [];
    const samples: ModelRequest[] = [];
    const tools = new ToolEnvironment({
      runtimes: [
        {
          name: "browser_external",
          specification: {
            name: "browser_external",
            description: "Synthetic scoped browser",
            inputSchema: {
              type: "object",
              properties: { instance: { type: "string" } },
              required: ["instance"],
            },
          },
          approvalScope: (call) => ({
            key: String(call.arguments.instance),
            label: `Browser ${String(call.arguments.instance)}`,
            generation: "test-generation",
          }),
          execute: async (call) => {
            assert.ok(Object.isFrozen(call.approvalScope));
            assert.equal(call.approvalScope?.key, call.arguments.instance);
            executions.push(String(call.arguments.instance));
            return { output: "completed", exitCode: 0 };
          },
        },
      ],
    });
    const server = new ZenAppServer({
      journal: new InMemoryThreadJournal(),
      threadMetadata: new InMemoryThreadMetadataStore(),
      runtime: new AgentRuntime({ toolEnvironment: tools }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "scoped-host",
          modelCatalog: new StaticModelCatalog([
            { id: "fake", isDefault: true, contextWindow: 32768 },
          ]),
          adapter: {
            provider: "scoped-host",
            async *stream(request): AsyncIterable<ModelEvent> {
              samples.push(request);
              if (samples.length <= 2)
                yield {
                  type: "tool_call",
                  callId: `call-${samples.length}`,
                  name: "browser_external",
                  arguments: { instance: samples.length === 1 ? "a" : "b" },
                };
              else
                yield {
                  type: "text_delta",
                  delta: "Finished without running the declined sibling.",
                };
            },
          },
        },
      ]),
      defaults: {
        cwd: os.tmpdir(),
        providerProfileId: "scoped-host",
        modelId: "fake",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "always",
      },
    });
    const target = await server.startThread();
    const projection = new NativeRecoveryProjection(server);
    const connection = new NativeConnection({
      appServer: server,
      projection,
      isInitialized: () => true,
      send: () => {},
      requestApproval: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          entered.resolve();
          await release.promise;
          return "accept";
        }
        return "decline";
      },
    });
    try {
      await connection.receive({
        id: 1,
        method: "zen/turn/wake",
        params: {
          threadId: target.id,
          clientId: "trigger-a",
          source: "trigger",
          sourceId: "trigger",
          text: "Inspect browser A",
        },
      });
      await entered.promise;
      const turnId = prompts[0]!.turnId;
      const receipt = await server.wakeTurn(target.id, {
        clientId: "room-b",
        source: "room",
        sourceId: "room",
        text: "Next inspect browser B",
      });
      assert.equal(receipt.mode, "steer");
      assert.equal(receipt.turnId, turnId);
      assert.equal(samples.length, 1);
      assert.deepEqual(executions, []);
      assert.deepEqual(prompts[0]!.approvalTarget, {
        key: "a",
        label: "Browser a",
      });
      release.resolve();
      let snapshot = await server.readThread(target.id);
      for (
        let i = 0;
        i < 200 && snapshot.turns.some((turn) => turn.status === "inProgress");
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        snapshot = await server.readThread(target.id);
      }
      assert.equal(snapshot.turns[0]?.status, "completed");
      assert.deepEqual(
        prompts.map((prompt) => prompt.approvalTarget?.key),
        ["a", "b"],
      );
      assert.ok(
        prompts.every(
          (prompt) => prompt.threadId === target.id && prompt.turnId === turnId,
        ),
      );
      assert.deepEqual(executions, ["a"]);
      assert.equal(samples.length, 3);
      const context = samples[1]!.messages;
      const steerIndex = context.findIndex(
        (message) =>
          message.role === "user" &&
          "content" in message &&
          message.content.some(
            (part) =>
              part.type === "text" && part.text === "Next inspect browser B",
          ),
      );
      assert.ok(
        steerIndex > context.findIndex((message) => message.role === "tool"),
      );
      assert.equal(
        snapshot.items.filter((item) => item.type === "host_message").length,
        2,
      );
      assert.equal(
        snapshot.items.some(
          (item) =>
            item.type === "user_message" || item.type === "turn_aborted",
        ),
        false,
      );
    } finally {
      release.resolve();
      connection.close();
      projection.close();
      await tools.close();
    }
  },
);
