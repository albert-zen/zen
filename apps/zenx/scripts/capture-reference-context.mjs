import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZenAppServer } from "../../../src/app-server.ts";
import { AgentRuntime } from "../../../src/runtime.ts";
import { InMemoryThreadJournal } from "../../../src/journal.ts";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.ts";
import { InMemoryAttachmentStore } from "../../../src/attachment.ts";
import { StaticModelCatalog } from "../../../src/model-catalog.ts";
import { ProviderRegistry } from "../../../src/provider-registry.ts";
import { ToolEnvironment } from "../../../src/tool.ts";
import { prepareNativeInput } from "../../../src/protocol/native/input.ts";
import { OpenAiCompatibleModel } from "../../../src/model/openai-compatible.ts";
import { OpenAiSubscriptionModel } from "../../../src/model/openai-subscription.ts";
import {
  referenceMessage,
  withReferenceDraft,
} from "../src/renderer/src/reference-draft.ts";
import { parseSkillDraft } from "../src/renderer/src/skill-draft.ts";
import {
  beginComposerSubmission,
  emptyComposerState,
} from "../src/renderer/src/composer-state.ts";
import { validateWorkspaceFileReference } from "../src/main/workspace-files.ts";
import { png1x1 } from "../../../test/fixtures.ts";

const output = path.resolve(process.argv[2] ?? ".reference-context-capture");
await mkdir(output, { recursive: true });
const fixture = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL(
        "../docs/reference-context/current/fixture-input.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);
// Use only this owned synthetic fixture. Never overwrite a differing existing file.
await mkdir(fixture.workspace, { recursive: true });
const syntheticFile = path.join(fixture.workspace, fixture.file.path);
let createdFile = false;
try {
  await writeFile(syntheticFile, fixture.file.content, { flag: "wx" });
  createdFile = true;
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  assert.equal(
    await readFile(syntheticFile, "utf8"),
    fixture.file.content,
    "Refuse to overwrite a non-fixture file",
  );
}
// All network is replaced, including a tripwire against an accidental non-injected fetch.
globalThis.fetch = async () => {
  throw new Error("Network forbidden in synthetic provider capture");
};
const timestamp = "2026-10-21T02:00:00.000Z";
const reports = [];
try {
  for (const variant of ["five-references", "with-image"]) {
    for (const format of ["chat-completions", "responses"]) {
      const stem =
        variant === "five-references" ? format : `with-image.${format}`;
      const journal = new InMemoryThreadJournal();
      const metadata = new InMemoryThreadMetadataStore();
      const attachments = new InMemoryAttachmentStore();
      const image = await attachments.importBytes(png1x1(), "image/png");
      let hostSequence = 0,
        runtimeSequence = 0;
      let phase = "seed";
      let capturedRaw, capturedModelRequest;
      const dispatchBodies = [];
      const fakeFetch = async (_url, init) => {
        const body = String(init.body);
        dispatchBodies.push({ phase, body });
        if (phase === "capture") capturedRaw = body;
        const answer =
          phase === "seed" ? fixture.fullMessage : "合成响应，仅用于结束测试。";
        const frames =
          format === "chat-completions"
            ? [
                {
                  choices: [
                    {
                      index: 0,
                      delta: { content: answer },
                      finish_reason: "stop",
                    },
                  ],
                },
                "[DONE]",
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
                  output_index: 0,
                  delta: answer,
                },
                {
                  type: "response.completed",
                  response: { status: "completed", output: [] },
                },
              ];
        return new Response(
          frames
            .map(
              (frame) =>
                `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic-signature`;
      const adapter =
        format === "chat-completions"
          ? new OpenAiCompatibleModel({
              baseUrl: "https://synthetic-provider.invalid/v1",
              apiKey: "synthetic-key",
              fetch: fakeFetch,
              attachments,
            })
          : new OpenAiSubscriptionModel({
              endpoint: "https://synthetic-provider.invalid/responses",
              acquireAccessLease: async () => ({ accessToken: token }),
              fetch: fakeFetch,
              attachments,
            });
      const wrapped = {
        provider: adapter.provider,
        requestPayloadFormat: adapter.requestPayloadFormat,
        async *stream(request) {
          if (phase === "capture")
            capturedModelRequest = {
              model: request.model,
              reasoningEffort: request.reasoningEffort,
              messages: request.messages,
              tools: request.tools,
              sessionId: request.sessionId,
              debugContext: request.debugContext,
            };
          yield* adapter.stream(request);
        },
      };
      const catalog = new StaticModelCatalog([
        {
          id: "synthetic-model",
          isDefault: true,
          contextWindow: 32768,
          inputModalities: ["text", "image"],
        },
      ]);
      const server = new ZenAppServer({
        journal,
        threadMetadata: metadata,
        attachments,
        runtime: new AgentRuntime({
          toolEnvironment: new ToolEnvironment({ runtimes: [] }),
          idFactory: () => `synthetic-runtime-${++runtimeSequence}`,
          now: () => timestamp,
        }),
        providerRegistry: new ProviderRegistry([
          {
            providerProfileId: wrapped.provider,
            adapter: wrapped,
            modelCatalog: catalog,
          },
        ]),
        defaults: {
          cwd: fixture.workspace,
          providerProfileId: wrapped.provider,
          modelId: "synthetic-model",
          reasoningEffort: "medium",
          sandbox: "read-only",
          approvalPolicy: "always",
        },
        idFactory: () => `synthetic-host-${++hostSequence}`,
        now: () => timestamp,
      });
      const target = await server.startThread();
      const source = await server.startThread();
      await metadata.setName(source.id, fixture.threadTitle);
      await (
        await server.sendMessage(source.id, fixture.sourcePrompt, {
          clientId: "synthetic-source-submission",
        })
      ).done;
      const sourceItems = (await server.readThread(source.id)).items;
      const sourceMessage = sourceItems.find(
        (item) => item.type === "agent_message",
      );
      assert.equal(sourceMessage.text, fixture.fullMessage);
      const child = await server.createChildThread({
        parentThreadId: target.id,
        mode: "fresh",
      });
      await metadata.setName(child.id, fixture.subagentTitle);
      assert.equal(child.parentThreadId, target.id);
      const file = await validateWorkspaceFileReference(
        fixture.workspace,
        fixture.file.path,
      );
      // These are exactly the existing Reference variants. Full-message and selection
      // both use message snapshots; a dedicated @message picker does not yet exist.
      const references = [
        {
          kind: "thread",
          id: source.id,
          name: fixture.threadTitle,
          cwd: source.cwd,
        },
        {
          kind: "message",
          threadId: source.id,
          id: sourceMessage.id,
          name: "完整消息",
          cwd: source.cwd,
          excerpt: fixture.fullMessage,
        },
        {
          kind: "thread",
          id: child.id,
          name: fixture.subagentTitle,
          cwd: child.cwd,
        },
        {
          kind: "message",
          threadId: source.id,
          id: sourceMessage.id,
          name: "选中文字",
          cwd: source.cwd,
          excerpt: fixture.selection,
        },
        { kind: "file", ...file },
      ];
      const draftText = withReferenceDraft(fixture.question, references);
      const draft = {
        ...emptyComposerState(),
        draft: {
          text: draftText,
          images:
            variant === "with-image"
              ? [{ id: "synthetic-image", attachment: image }]
              : [],
        },
      };
      const submission = beginComposerSubmission(
        draft,
        "start",
        null,
        () => fixture.clientId,
      ).submission;
      const parsed = parseSkillDraft(submission.text);
      const canonicalText = referenceMessage(
        parsed.text,
        parsed.references,
        submission.clientUserMessageId,
      );
      const wireInput = [
        { type: "text", text: canonicalText },
        ...submission.images.map((image) => ({
          type: "image",
          attachment: image.attachment,
        })),
      ];
      phase = "capture";
      const nativeInput = await prepareNativeInput(wireInput, server);
      await (
        await server.sendMessage(target.id, nativeInput, {
          clientId: submission.clientUserMessageId,
        })
      ).done;
      const captured = JSON.parse(capturedRaw);
      const saved = await journal.read(target.id);
      const userMessage = saved.find((item) => item.type === "user_message");
      assert.deepEqual(userMessage.content, nativeInput);
      assert.equal(userMessage.clientId, fixture.clientId);
      const last = (captured.messages ?? captured.input).at(-1);
      const textParts = last.content.filter((part) =>
        ["text", "input_text"].includes(part.type),
      );
      assert.equal(textParts[1].text, canonicalText);
      if (variant === "with-image")
        assert.equal(
          last.content[2].type,
          format === "chat-completions" ? "image_url" : "input_image",
        );
      else assert.equal(last.content.length, 2);
      assert(!capturedRaw.includes("FILE_CONTENT_NOT_INCLUDED"));
      assert(!capturedRaw.includes("THREAD_CONTENT_NOT_INCLUDED"));
      assert.equal(
        dispatchBodies.filter((item) => item.phase === "capture").length,
        1,
      );
      assert(
        capturedModelRequest.tools.every(
          (tool) => typeof tool.name === "string",
        ),
      );
      assert(!saved.some((item) => item.type === "tool_call"));
      await writeFile(
        path.join(output, `${stem}.request.raw.json`),
        capturedRaw,
      );
      await writeFile(
        path.join(output, `${stem}.request.pretty.json`),
        JSON.stringify(captured, null, 2) + "\n",
      );
      await writeFile(
        path.join(output, `${stem}.model-request.json`),
        JSON.stringify(capturedModelRequest, null, 2) + "\n",
      );
      await writeFile(
        path.join(output, `${stem}.canonical-journals.json`),
        JSON.stringify(
          {
            target: saved,
            source: await journal.read(source.id),
            subagent: await journal.read(child.id),
          },
          null,
          2,
        ) + "\n",
      );
      await writeFile(
        path.join(output, `${stem}.canonical-user-message.json`),
        JSON.stringify(userMessage, null, 2) + "\n",
      );
      if (format === "chat-completions" && variant === "five-references")
        await writeFile(
          path.join(output, "fixture-bundle.json"),
          JSON.stringify(
            {
              timestamp,
              question: fixture.question,
              references,
              optionalImage: {
                label: "第六类对照：实际图片附件，不是文件指针",
                attachment: image,
              },
              sourcePrompt: fixture.sourcePrompt,
              sourceFullMessage: fixture.fullMessage,
              sourceSelection: fixture.selection,
              file: fixture.file,
              clientId: fixture.clientId,
              draftText,
              canonicalText,
              wireInput,
            },
            null,
            2,
          ) + "\n",
        );
      reports.push({
        variant,
        format,
        targetThreadId: target.id,
        sourceThreadId: source.id,
        subagentThreadId: child.id,
        sourceMessageId: sourceMessage.id,
        requestCount: 1,
        assertions: "passed",
        networkRequests: 0,
      });
      await server.closeRuntimeConfiguration();
    }
  }
} finally {
  if (createdFile) await unlink(syntheticFile);
  await rmdir(fixture.workspace).catch((error) => {
    if (error.code !== "ENOTEMPTY") throw error;
  });
}
await writeFile(
  path.join(output, "verification.json"),
  JSON.stringify(
    {
      sourceCommit: "6e2777cb68544012d0d24f910c215b5553bf2f30",
      timestamp,
      notes: [
        "Actual production serialization, native input validation, Host admission, Runtime, in-memory journal and production provider adapters.",
        "Only external fetch and authentication are synthetic; no live provider call, credentials, source document or transcript.",
        "Canonical journal records are read back from InMemoryThreadJournal, not OS-durable JSONL.",
        "Full-message reference is an existing message snapshot assembled by fixture; no dedicated @message picker exists.",
        "Main request has exactly five references and no image. with-image.* files are a separate sixth-category comparison with complete 1x1 PNG bytes.",
        "Tool catalog is deliberately restricted to the automatically supplied wait tool: this exact run has no file/thread-reading capability, and no tool was called.",
        "timestamp is fixed synthetic admission time, not wall-clock capture time.",
      ],
      reports,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(reports, null, 2));
