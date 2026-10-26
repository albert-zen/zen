import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { ToolEnvironment } from "../src/tool.js";
import { png1x1 } from "./fixtures.js";

for (const { protocol, rejectNative } of [
  { protocol: undefined, rejectNative: false },
  { protocol: "chat-completions" as const, rejectNative: false },
  { protocol: "responses" as const, rejectNative: false },
  { protocol: "responses" as const, rejectNative: true },
]) {
  test(`Host factory uses only explicit public Responses selection: ${protocol ?? "legacy"}, reject native: ${rejectNative}`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-public-responses-"),
    );
    const attachments = new InMemoryAttachmentStore();
    const ref = await attachments.importBytes(png1x1());
    const environment = new ToolEnvironment();
    environment.registerRuntime(
      {
        name: "fixture_image",
        specification: {
          name: "fixture_image",
          description: "Synthetic image",
          inputSchema: { type: "object", properties: {} },
        },
        execute: async () => ({
          output: "receipt",
          exitCode: 0,
          modelContent: [{ type: "image", attachment: ref }],
        }),
      },
      { kind: "builtin", id: "fixture" },
    );
    const originalFetch = globalThis.fetch;
    const bodies: any[] = [];
    const urls: string[] = [];
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)));
      const first = bodies.length === 1;
      if (!first && rejectNative) {
        const outputIndex = bodies
          .at(-1)
          .input.findIndex((item: any) => item.type === "function_call_output");
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "invalid_image",
              param: `input[${outputIndex}].output[1]`,
              message: "Native tool image rejected",
            },
          }),
          { status: 400 },
        );
      }
      const events =
        protocol === "responses"
          ? [
              ...(first
                ? [
                    {
                      type: "response.output_item.done",
                      output_index: 0,
                      item: {
                        type: "reasoning",
                        id: "rs_fixture",
                        encrypted_content: "opaque-fixture",
                        summary: [],
                      },
                    },
                    {
                      type: "response.output_item.done",
                      output_index: 1,
                      item: {
                        type: "function_call",
                        id: "fc_image",
                        call_id: "call_image",
                        name: "fixture_image",
                        arguments: "{}",
                      },
                    },
                  ]
                : [
                    {
                      type: "response.output_item.added",
                      output_index: 0,
                      item: {
                        type: "message",
                        id: "msg_fixture",
                        role: "assistant",
                        content: [],
                      },
                    },
                    {
                      type: "response.output_text.delta",
                      item_id: "msg_fixture",
                      output_index: 0,
                      content_index: 0,
                      delta: "done",
                    },
                  ]),
              {
                type: "response.completed",
                response: { status: "completed", output: [] },
              },
            ]
          : [
              {
                choices: [
                  {
                    index: 0,
                    delta: first
                      ? {
                          tool_calls: [
                            {
                              index: 0,
                              id: "call_image",
                              type: "function",
                              function: {
                                name: "fixture_image",
                                arguments: "{}",
                              },
                            },
                          ],
                        }
                      : { content: "done" },
                    finish_reason: first ? "tool_calls" : "stop",
                  },
                ],
              },
            ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      );
    };
    const host = createHostedAppServer({
      cwd: directory,
      dataDirectory: directory,
      approvalPolicy: "never",
      model: "fixture-model",
      provider: {
        type: "openai-compatible",
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: "synthetic-not-real",
        ...(protocol === undefined ? {} : { protocol }),
      },
      modelCatalog: [
        {
          id: "fixture-model",
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
          contextWindow: 32768,
          source: "manual",
        },
      ],
      toolPresentation: "direct",
      toolEnvironment: environment,
      attachments,
    });
    try {
      const thread = await host.startThread();
      await (
        await host.startTurn(thread.id, "synthetic image request")
      ).done;
      assert.equal(bodies.length, 2);
      const canonical = await host.readThread(thread.id);
      assert.equal(canonical.items.at(-1)?.type, "turn_completed");
      if (rejectNative) {
        const terminal = canonical.items.at(-1)!;
        assert.equal(terminal.type, "turn_completed");
        if (terminal.type === "turn_completed")
          assert.equal(terminal.status, "failed");
        const tool = canonical.items.find(
          (item) =>
            item.type === "tool_result" &&
            item.modelContent?.some((part) => part.type === "image"),
        );
        assert.ok(tool?.type === "tool_result");
        assert.equal(tool.modelContent?.[0]?.type, "image");
        assert.equal(
          canonical.items.some(
            (item) => item.type === "failure" && item.recovery !== undefined,
          ),
          false,
        );
      }
      if (protocol === "responses") {
        assert.equal(urls[0], "https://synthetic.invalid/v1/responses");
        const output = bodies[1].input.find(
          (item: any) => item.type === "function_call_output",
        );
        assert.equal(output.call_id, "call_image");
        assert.equal(output.output[1].type, "input_image");
        const reasoning = bodies[1].input.find(
          (item: any) => item.type === "reasoning",
        );
        assert.equal(reasoning.id, "rs_fixture");
        assert.equal(reasoning.encrypted_content, "opaque-fixture");
        assert.equal("opaqueReplayProvenance" in reasoning, false);
        const saved = canonical.items.find((item) => item.type === "reasoning");
        assert.ok(saved?.type === "reasoning");
        assert.equal(saved.opaqueReplayProvenance?.adapter, "public-responses");
        assert.equal(
          bodies[1].input.filter(
            (item: any) =>
              item.role === "user" &&
              item.content.some((part: any) => part.type === "input_image"),
          ).length,
          0,
        );
      } else {
        assert.equal(urls[0], "https://synthetic.invalid/v1/chat/completions");
        const index = bodies[1].messages.findIndex(
          (item: any) => item.role === "tool",
        );
        assert.equal(typeof bodies[1].messages[index].content, "string");
        assert.equal(bodies[1].messages[index + 1].role, "user");
      }
    } finally {
      await host.closeHostResources();
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
