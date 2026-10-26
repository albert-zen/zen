import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZenAppServer } from "../../../src/app-server.ts";
import { originalUserInput } from "../../../src/item.ts";
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
  insertInlineReference,
  referenceMessage,
} from "../src/renderer/src/reference-draft.ts";
import { validateWorkspaceFileReference } from "../src/main/workspace-files.ts";

const output = path.resolve(
  process.argv[2] ?? ".inline-reference-context-capture",
);
await mkdir(output, { recursive: true });
const workspace = path.join(os.tmpdir(), "zen-reference-v3-synthetic");
const filePath = "reports/completion-check.md";
const fileContent = "验收记录：部署完成；最终检查报告仍待归档。\n";
const syntheticFile = path.join(workspace, filePath);
await mkdir(path.dirname(syntheticFile), { recursive: true });
let createdFile = false;
try {
  await writeFile(syntheticFile, fileContent, { flag: "wx" });
  createdFile = true;
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  assert.equal(await readFile(syntheticFile, "utf8"), fileContent);
}

// No live network is permitted, even if a code path bypasses the injected fetch.
globalThis.fetch = async () => {
  throw new Error("Network forbidden in synthetic provider capture");
};
const timestamp = "2026-10-21T03:00:00.000Z";
const clientId = "synthetic-inline-reference-v3-submission";
const captureReports = [];
let capturedUserMessage;
try {
  for (const format of ["chat-completions", "responses"]) {
    const journal = new InMemoryThreadJournal();
    const metadata = new InMemoryThreadMetadataStore();
    const attachments = new InMemoryAttachmentStore();
    let hostSequence = 0;
    let runtimeSequence = 0;
    let phase = "seed";
    let capturedRaw;
    let outgoingForCapture;
    let requestCount = 0;
    let matchingUserMessageCaptures = 0;
    const dispatchPhases = [];
    const fakeFetch = async (_url, init) => {
      const body = String(init.body);
      dispatchPhases.push(phase);
      if (phase === "capture") {
        requestCount += 1;
        const request = JSON.parse(body);
        const messages = request.messages ?? request.input;
        const userMessage = [...messages]
          .reverse()
          .find((message) => message.role === "user");
        assert.ok(userMessage, "provider request contains a user message");
        const textParts = (
          Array.isArray(userMessage.content)
            ? userMessage.content
            : [{ type: "text", text: userMessage.content }]
        ).filter((part) => ["text", "input_text"].includes(part.type));
        const exactUserText = textParts
          .map((part) => part.text)
          .find((value) => value === outgoingForCapture);
        if (exactUserText !== undefined) {
          matchingUserMessageCaptures += 1;
          if (capturedRaw === undefined) capturedRaw = body;
          if (capturedUserMessage === undefined)
            capturedUserMessage = exactUserText;
          else
            assert.ok(
              exactUserText === capturedUserMessage,
              "provider formats agree on the exact user string",
            );
        }
      }

      const answer =
        phase === "seed"
          ? seedMessages[seedIndex++]
          : "合成响应，仅用于结束测试。";
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
                  id: "msg_v3_synthetic",
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
      stream: (request) => adapter.stream(request),
    };
    const server = new ZenAppServer({
      journal,
      threadMetadata: metadata,
      attachments,
      runtime: new AgentRuntime({
        toolEnvironment: new ToolEnvironment({ runtimes: [] }),
        idFactory: () => `synthetic-v3-runtime-${++runtimeSequence}`,
        now: () => timestamp,
      }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: wrapped.provider,
          adapter: wrapped,
          modelCatalog: new StaticModelCatalog([
            {
              id: "synthetic-model",
              isDefault: true,
              contextWindow: 32768,
              inputModalities: ["text"],
            },
          ]),
        },
      ]),
      defaults: {
        cwd: workspace,
        providerProfileId: wrapped.provider,
        modelId: "synthetic-model",
        reasoningEffort: "medium",
        sandbox: "read-only",
        approvalPolicy: "always",
      },
      idFactory: () => `synthetic-v3-host-${++hostSequence}`,
      now: () => timestamp,
    });
    const seedMessages = [
      "部署与最终验收已完成，记录已归档。",
      "部署已完成，但最终验收报告尚未归档。",
    ];
    let seedIndex = 0;
    try {
      const target = await server.startThread();
      const threadA = await server.startThread();
      await metadata.setName(threadA.id, "项目状态讨论");
      phase = "seed";
      await (
        await server.sendMessage(threadA.id, "记录当前验收结论。", {
          clientId: "synthetic-v3-seed-thread-a",
        })
      ).done;
      const messageA = (await journal.read(threadA.id)).find(
        (item) => item.type === "agent_message",
      );
      assert.ok(messageA && messageA.type === "agent_message");
      const subagentB = await server.createChildThread({
        parentThreadId: target.id,
        mode: "fresh",
      });
      await metadata.setName(subagentB.id, "执行子任务审查");
      // Keep the synthetic source IDs stable across adapters that reserve
      // different numbers of runtime IDs while parsing the first response.
      if (format === "chat-completions") runtimeSequence += 1;
      await (
        await server.sendMessage(subagentB.id, "补充执行状态。", {
          clientId: "synthetic-v3-seed-subagent-b",
        })
      ).done;
      const messageB = (await journal.read(subagentB.id)).find(
        (item) => item.type === "agent_message",
      );
      assert.ok(messageB && messageB.type === "agent_message");
      const file = await validateWorkspaceFileReference(workspace, filePath);
      const references = [
        {
          kind: "message",
          name: "验收结论 A",
          cwd: threadA.cwd,
          threadId: threadA.id,
          id: messageA.id,
          excerpt: "部署与最终验收已完成",
        },
        {
          kind: "message",
          name: "验收结论 B",
          cwd: subagentB.cwd,
          threadId: subagentB.id,
          id: messageB.id,
          excerpt: "部署已完成，但最终验收报告尚未归档",
        },
        {
          kind: "thread",
          name: "项目状态讨论",
          cwd: threadA.cwd,
          id: threadA.id,
        },
        {
          kind: "thread",
          name: "执行子任务审查",
          cwd: subagentB.cwd,
          id: subagentB.id,
        },
        { kind: "file", ...file },
      ];
      let draftText =
        "这一段  是什么意思？结合下面这段  是否意味着…？线程  说完成了这件事，线程  又说另一件事；请结合文件  检查他们是否都完成、是否矛盾。";
      const anchors = [
        draftText.indexOf("  是什么意思") + 1,
        draftText.indexOf("  是否意味着") + 1,
        draftText.indexOf("  说完成了") + 1,
        draftText.indexOf("  又说另一件事") + 1,
        draftText.indexOf("  检查他们") + 1,
      ];
      assert.ok(anchors.every((anchor) => anchor > 0));
      for (const [index, reference] of references.entries()) {
        const inserted = insertInlineReference(
          draftText,
          references.slice(0, index).map((item, refIndex) => ({
            ...item,
            position: anchors[refIndex] + refIndex,
          })),
          reference,
          anchors[index] + index,
          anchors[index] + index,
        );
        draftText = inserted.text;
        references[index] = {
          ...reference,
          position: inserted.caret - 1,
        };
      }
      const orderedReferences = references;
      const outgoing = referenceMessage(draftText, orderedReferences, clientId);
      assert.ok(
        outgoing.startsWith(
          `[zenx-reference-message:v3;clientId=${JSON.stringify(clientId)}]\n`,
        ),
      );
      outgoingForCapture = outgoing;
      phase = "capture";
      const nativeInput = await prepareNativeInput(
        [{ type: "text", text: outgoing }],
        server,
      );
      await (
        await server.sendMessage(target.id, nativeInput, { clientId })
      ).done;
      assert.ok(capturedRaw, "fake provider saw the actual v3 user request");
      const saved = await journal.read(target.id);
      const userMessage = saved.find((item) => item.type === "user_message");
      assert.ok(userMessage && userMessage.type === "user_message");
      assert.deepEqual(originalUserInput(userMessage), nativeInput);
      assert.deepEqual(userMessage.contentAuthority.hostTextPartIndices, [0]);
      assert.match(userMessage.content[0].text, /received_at=/);
      assert.equal(userMessage.clientId, clientId);
      assert.ok(requestCount >= 1);
      assert.ok(matchingUserMessageCaptures >= 1);
      assert.ok(dispatchPhases.includes("capture"));
      assert.ok(
        dispatchPhases.every((observedPhase) => observedPhase !== "other"),
      );

      const request = JSON.parse(capturedRaw);
      const providerMessages = request.messages ?? request.input;
      const actualUserMessage = [...providerMessages]
        .reverse()
        .find((message) => message.role === "user");
      assert.ok(actualUserMessage);
      const textParts = (
        Array.isArray(actualUserMessage.content)
          ? actualUserMessage.content
          : [{ type: "text", text: actualUserMessage.content }]
      ).filter((part) => ["text", "input_text"].includes(part.type));
      assert.deepEqual(
        textParts.map((part) => part.text),
        userMessage.content
          .filter((part) => part.type === "text")
          .map((part) => part.text),
        "all provider-visible user text equals committed canonical content",
      );
      const actualUserText = textParts
        .map((part) => part.text)
        .find((value) => value === outgoing);
      assert.ok(
        actualUserText === outgoing,
        `${format} user text matches the outgoing v3 string`,
      );
      if (capturedUserMessage === undefined)
        capturedUserMessage = actualUserText;
      else
        assert.ok(
          actualUserText === capturedUserMessage,
          "provider formats agree on the exact v3 string",
        );
      await writeFile(
        path.join(output, `${format}.complete-user-message.json`),
        JSON.stringify(
          {
            canonicalContent: userMessage.content,
            serializedUserMessage: actualUserMessage,
          },
          null,
          2,
        ) + "\n",
      );
      captureReports.push({
        format,
        requestCount,
        matchingUserMessageCaptures,
        networkRequests: 0,
        canonicalJournalMatch: true,
        originalUserMatch: true,
        completeCanonicalTextMatch: true,
        threadAId: threadA.id,
        subagentBId: subagentB.id,
        sourceMessageAId: messageA.id,
        sourceMessageBId: messageB.id,
      });
      if (format === "chat-completions") {
        const fixtureMetadata = {
          scenario:
            "Synthetic ordered references for completion-status comparison.",
          timestamp,
          text: draftText,
          references: orderedReferences,
          clientId,
          payload: actualUserText,
          payloadScope:
            "original-user-text-only; see complete-user-message files for model input",
          threadAId: threadA.id,
          subagentBId: subagentB.id,
          sourceMessageAId: messageA.id,
          sourceMessageBId: messageB.id,
          file: { path: file.path, cwd: file.cwd, name: file.name },
        };
        await writeFile(
          path.join(output, "fixture-metadata.json"),
          JSON.stringify(fixtureMetadata, null, 2) + "\n",
        );
        await writeFile(
          path.join(output, "model-user-message.txt"),
          `${actualUserText}\n`,
        );
      }
    } finally {
      await server.closeRuntimeConfiguration();
    }
  }
} finally {
  if (createdFile) await unlink(syntheticFile);
  await rmdir(path.dirname(syntheticFile)).catch((error) => {
    if (error.code !== "ENOTEMPTY") throw error;
  });
  await rmdir(workspace).catch((error) => {
    if (error.code !== "ENOTEMPTY") throw error;
  });
}

await writeFile(
  path.join(output, "verification.json"),
  JSON.stringify(
    {
      timestamp,
      assertions: "passed",
      reports: captureReports,
      capturesOnlyUserMessage: true,
      modelUserMessageTxtScope: "original-user-text-only",
      completeUserMessagesIncludeHostMetadata: true,
      fullProviderRequestsWritten: false,
      systemAndToolPromptsWritten: false,
      networkRequests: 0,
      notes: [
        "The captured string came from each production provider adapter request at an injected fake transport boundary.",
        "model-user-message.txt is the original v3 user text only (legacy UI fixture filename), not the complete model input. Per-format complete-user-message.json stores the complete ordered canonical content and actual serialized user message, including received_at.",
        "Source threads, source messages, and the synthetic file are created only in memory or a temporary directory and are not included as bodies in the captured user string unless an exact excerpt is explicitly referenced.",
        "Thread and file references are pointers, not evidence that the source body was read or included.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(captureReports, null, 2));
