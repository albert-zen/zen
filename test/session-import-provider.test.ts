import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { parseCodexRollout } from "../src/protocol/codex/rollout-import.js";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import {
  historicalCallId,
  historicalToolName,
} from "../src/model/imported-history.js";

const row = (type: string, payload: unknown) =>
  JSON.stringify({ timestamp: "2026-10-12T00:00:00Z", type, payload });
const message = (role: string, text: string) => ({
  type: "message",
  role,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});
const meta = row("session_meta", {
  id: "synthetic-public-format",
  cli_version: "0.146.0",
  cwd: "/source/project",
});
const call = (id: string, name = "run_code", namespace?: string) => ({
  type: "function_call",
  call_id: id,
  name,
  arguments: '{"command":"historical only"}',
  ...(namespace === undefined ? {} : { namespace }),
});
const result = (id: string) => ({
  type: "function_call_output",
  call_id: id,
  output: [{ type: "input_text", text: "exact past output" }],
});
const flat = (...items: unknown[]) =>
  [meta, ...items.map((item) => row("response_item", item))].join("\n");

// WorldStateItem {full,state} and emission order are pinned to public rust-v0.146.0
// protocol.rs and core/src/session/mod.rs. These are synthetic, not private exports.
test("ordinary initial and post-compaction world-state snapshots are explicitly excluded", () => {
  const initial = [
    meta,
    row("response_item", message("user", "original")),
    row("world_state", {
      full: true,
      state: { configuration: "never restore" },
    }),
    row("turn_context", { model: "source-model" }),
    row("response_item", message("assistant", "answer")),
  ].join("\n");
  assert.match(
    parseCodexRollout(initial).source.exclusions.join("\n"),
    /world-state configuration.*1/u,
  );
  const checkpoint =
    initial +
    "\n" +
    [
      row("compacted", {
        message: "",
        replacement_history: [
          message("user", "checkpoint context"),
          message("assistant", "explicit summary"),
        ],
      }),
      row("world_state", { full: true, state: { permissions: "source-only" } }),
      row("world_state", {
        full: false,
        state: [{ op: "replace", path: "/cwd", value: "/foreign" }],
      }),
      row("response_item", message("user", "continue")),
      row("response_item", message("assistant", "continued")),
    ].join("\n");
  const parsed = parseCodexRollout(checkpoint);
  assert.match(
    parsed.source.exclusions.join("\n"),
    /world-state configuration.*2/u,
  );
  assert.equal(parsed.source.contextBasis?.kind, "replacement-history");
  assert.equal(JSON.stringify(parsed.turns).includes("permissions"), false);
  for (const invalid of [{ full: "true", state: {} }, { full: true }])
    assert.throws(
      () => parseCodexRollout(initial + "\n" + row("world_state", invalid)),
      /Invalid source world_state/u,
    );
  assert.throws(
    () => parseCodexRollout(initial + "\n" + row("future_unknown", {})),
    /Unsupported rollout record/u,
  );
});

test("incomplete tool batches cannot be split by new calls or persisted reasoning", () => {
  const prefix = [message("user", "question"), call("a"), call("b")];
  assert.throws(
    () =>
      parseCodexRollout(
        flat(...prefix, result("a"), call("c"), result("b"), result("c")),
      ),
    /incomplete tool-result batch/u,
  );
  assert.throws(
    () =>
      parseCodexRollout(
        flat(
          ...prefix,
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "between calls" }],
          },
          result("a"),
          result("b"),
        ),
      ),
    /incomplete tool-call batch/u,
  );
  assert.equal(
    parseCodexRollout(
      flat(...prefix, result("b"), result("a"), call("c"), result("c")),
    ).turns.length,
    1,
  );
});

for (const provider of ["subscription", "compatible"] as const)
  test(`imported tool provenance continues through actual ${provider} request serialization`, async () => {
    const contents = flat(
      message("user", "retain exact prior work"),
      call("same|one", "functions.exec_command", "functions"),
      result("same|one"),
      call("same|two", "run_code"),
      result("same|two"),
      {
        type: "custom_tool_call",
        call_id: "custom",
        name: "run_code",
        namespace: "old_tools",
        input: "text('past only')",
      },
      {
        type: "custom_tool_call_output",
        call_id: "custom",
        output: "raw source result",
      },
      call("long", "x".repeat(128)),
      result("long"),
      message("assistant", "past answer"),
    );
    let body: Record<string, unknown> | undefined;
    let requests = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requests++;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const events =
        provider === "subscription"
          ? [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "message",
                  id: "new-local",
                  role: "assistant",
                  content: [],
                },
              },
              {
                type: "response.output_text.delta",
                output_index: 0,
                delta: "new local response",
              },
              {
                type: "response.completed",
                response: { status: "completed", output: [] },
              },
            ].map((value) => JSON.stringify(value))
          : [
              JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: { content: "new local response" },
                    finish_reason: "stop",
                  },
                ],
              }),
              "[DONE]",
            ];
      return new Response(
        events.map((value) => `data: ${value}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const adapter =
      provider === "subscription"
        ? new OpenAiSubscriptionModel({
            // Synthetic local lease; fake fetch above never transmits it.
            acquireAccessLease: async () => ({
              accessToken: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.x`,
            }),
            fetch,
          })
        : new OpenAiCompatibleModel({
            baseUrl: "https://provider.test/v1",
            apiKey: "synthetic-unused",
            fetch,
          });
    const env = new ToolEnvironment({ runtimes: [] });
    const app = new ZenAppServer({
      journal: new InMemoryThreadJournal(),
      threadMetadata: new InMemoryThreadMetadataStore(),
      runtime: new AgentRuntime({ toolEnvironment: env }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "local",
          adapter,
          modelCatalog: new StaticModelCatalog([
            { id: "test", isDefault: true, contextWindow: 32768 },
          ]),
        },
      ]),
      defaults: {
        cwd: os.tmpdir(),
        providerProfileId: "local",
        modelId: "test",
        reasoningEffort: "medium",
        sandbox: "read-only",
        approvalPolicy: "always",
      },
    });
    try {
      const imported = await app.importThread(parseCodexRollout(contents), {
        cwd: os.tmpdir(),
      });
      assert.equal(requests, 0);
      const originals = imported.thread.items.filter(
        (item) => item.type === "tool_call",
      );
      assert.equal(originals[0]!.name, "functions.exec_command");
      assert.deepEqual(originals[0]!.imported, {
        inputFormat: "json",
        namespace: "functions",
      });
      assert.deepEqual(originals[2]!.arguments, { input: "text('past only')" });
      await (
        await app.startTurn(imported.thread.id, "Continue now")
      ).done;
      assert.equal(requests, 1);
      assert.ok(body);
      const after = await app.readThread(imported.thread.id);
      assert.equal(after.turns.at(-1)?.status, "completed");
      assert(
        after.items.some(
          (item) =>
            item.type === "agent_message" && item.text === "new local response",
        ),
      );
      assert.equal(
        JSON.stringify(body.tools ?? []).includes("history_"),
        false,
      );
      if (provider === "subscription") {
        const input = body.input as Array<Record<string, unknown>>;
        const calls = input.filter(
          (item) =>
            item.type === "function_call" || item.type === "custom_tool_call",
        );
        const outputs = input.filter(
          (item) =>
            item.type === "function_call_output" ||
            item.type === "custom_tool_call_output",
        );
        assert.deepEqual(
          calls.map((item) => item.type),
          [
            "function_call",
            "function_call",
            "custom_tool_call",
            "function_call",
          ],
        );
        assert.equal(calls[2]!.input, "text('past only')");
        assert.equal(outputs[2]!.type, "custom_tool_call_output");
        assert.equal(calls[1]!.arguments, '{"command":"historical only"}');
        for (const [index, original] of originals.entries()) {
          assert.equal(calls[index]!.name, historicalToolName(original));
          assert.match(String(calls[index]!.name), /^[a-zA-Z0-9_-]{1,64}$/u);
          assert.equal(
            calls[index]!.call_id,
            historicalCallId(original.callId),
          );
          assert.equal(outputs[index]!.call_id, calls[index]!.call_id);
          assert.match(
            String(outputs[index]!.output),
            /Historical tool result; execution outcome unknown/u,
          );
        }
        assert.notEqual(calls[0]!.call_id, calls[1]!.call_id);
      } else {
        const messages = body.messages as Array<Record<string, unknown>>;
        const calls = messages.flatMap(
          (entry) =>
            (entry.tool_calls ?? []) as Array<{
              id: string;
              function: { name: string; arguments: string };
            }>,
        );
        const outputs = messages.filter((entry) => entry.role === "tool");
        for (const [index, original] of originals.entries()) {
          assert.equal(
            calls[index]!.function.name,
            historicalToolName(original),
          );
          assert.equal(outputs[index]!.tool_call_id, calls[index]!.id);
          assert.match(
            String(outputs[index]!.content),
            /Historical tool result; execution outcome unknown/u,
          );
        }
        assert.equal(
          calls[2]!.function.arguments,
          JSON.stringify({ input: "text('past only')" }),
        );
        assert.equal(
          calls[1]!.function.arguments,
          '{"command":"historical only"}',
        );
      }
    } finally {
      await env.close();
      await app.closeRuntimeConfiguration();
    }
  });
