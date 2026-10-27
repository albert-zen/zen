import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileTraceStore } from "../src/trace.js";
import { ModelRequestDebugStore } from "../apps/cli/src/model-request-debug.js";
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
      const thread = await host.startThread();
      await (
        await host.startTurn(thread.id, "synthetic image request")
      ).done;
      assert.equal(bodies.length, 2);
      const tool = bodies[1].messages.findIndex((m: any) => m.role === "tool");
      assert.equal(typeof bodies[1].messages[tool].content, "string");
      assert.equal(bodies[1].messages[tool + 1].role, "user");
      const semanticPath = path.join(
        directory,
        "threads",
        "items",
        `${thread.id}.jsonl`,
      );
      const before = await readFile(semanticPath, "utf8");
      await host.closeHostResources();
      const coldTrace = new FileTraceStore(path.join(directory, "trace"));
      const reader = new ModelRequestDebugStore(coldTrace);
      const summaries = (
        await reader.control({
          action: "list",
          threadId: thread.id,
        })
      ).records!;
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
      const captured = (
        await reader.control({
          action: "read",
          threadId: thread.id,
          id: summary.id,
          view: "payload",
        })
      ).page!;
      assert.deepEqual(JSON.parse(captured.text), bodies[1]);
      const metadata = (await coldTrace.read(thread.id)).records.find(
        (r) => r.id === summary.id,
      )!.data as { toolMediaTransport: unknown };
      assert.deepEqual(metadata.toolMediaTransport, summary.toolMediaTransport);
      assert.equal(summary.dispatch, "observed");
      assert.equal(summary.sampleOutcome, "completed");
      assert.equal(
        await readFile(semanticPath, "utf8"),
        before,
        "cold inspection never rewrites model semantics",
      );
      assert.doesNotMatch(
        before,
        /toolMediaTransport|conflictingEvidence|reviewedOn/,
      );
      assert.doesNotMatch(
        JSON.stringify(bodies),
        /toolMediaTransport|conflictingEvidence|reviewedOn/,
      );
    } finally {
      await host.closeHostResources();
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
