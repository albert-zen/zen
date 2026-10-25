import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { ToolEnvironment } from "../src/tool.js";
import { png1x1 } from "./fixtures.js";
import {
  BUILTIN_CHAT_TOOL_MEDIA_CAPABILITIES,
  BUILTIN_CHAT_TOOL_MEDIA_EVIDENCE_CONFLICTS,
} from "../src/model/tool-media-profiles.js";

for (const target of [
  { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", conflict: 1 },
  {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-vl-plus",
    conflict: 1,
  },
  {
    baseUrl: "https://synthetic.invalid/v1",
    model: "deepseek-flash",
    conflict: 0,
  },
]) {
  test(`Host injects reviewed transport evidence without enabling unknown native media: ${target.model} ${target.conflict}`, async () => {
    assert.equal(BUILTIN_CHAT_TOOL_MEDIA_CAPABILITIES.length, 0);
    assert.equal(BUILTIN_CHAT_TOOL_MEDIA_EVIDENCE_CONFLICTS.length, 2);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-media-profile-"),
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
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const delta =
        bodies.length === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call_image",
                  type: "function",
                  function: { name: "fixture_image", arguments: "{}" },
                },
              ],
            }
          : { content: "done" };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] })}\n\n`,
      );
    };
    const host = createHostedAppServer({
      cwd: directory,
      dataDirectory: directory,
      approvalPolicy: "never",
      model: target.model,
      provider: {
        type: "openai-compatible",
        baseUrl: target.baseUrl,
        apiKey: "synthetic-not-real",
      },
      modelCatalog: [
        {
          id: target.model,
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
      host.modelRequestDebug.control({ action: "setEnabled", enabled: true });
      const thread = await host.startThread();
      await (
        await host.startTurn(thread.id, "synthetic image request")
      ).done;
      assert.equal(bodies.length, 2);
      const tool = bodies[1].messages.findIndex((m: any) => m.role === "tool");
      assert.equal(typeof bodies[1].messages[tool].content, "string");
      assert.equal(bodies[1].messages[tool + 1].role, "user");
      const summaries = host.modelRequestDebug.control({
        action: "list",
        threadId: thread.id,
      }).records!;
      const summary = summaries.find(
        (entry) => entry.toolMediaTransport?.compatibilitySupplement === 1,
      )!;
      assert.ok(summary);
      assert.equal(summary.toolMediaTransport?.nativeToolContent, 0);
      assert.equal(
        summary.toolMediaTransport?.conflictingEvidence,
        target.conflict,
      );
      assert.equal(
        summary.toolMediaTransport?.unknownTarget,
        1 - target.conflict,
      );
      const canonical = await host.readThread(thread.id);
      assert.doesNotMatch(
        JSON.stringify(canonical.items),
        /toolMediaTransport|conflictingEvidence|reviewedOn/,
      );
    } finally {
      await host.closeHostResources();
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
