import { ThreadDebugger } from "../src/renderer/src/ThreadDebugger.js";
import type { Thread } from "../src/protocol-client/index.js";
import type { CanonicalItem } from "../../../src/item.js";
/** Actual experimental action/dialog, synthetic message scaffold and local-memory capture API. */
import React from "react";
import { createRoot } from "react-dom/client";
import {
  MessageContextDebugAction,
  MessageContextDebugContext,
} from "../src/renderer/src/MessageContextDebug.js";
import { referenceMessage } from "../src/renderer/src/reference-draft.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
} from "../../cli/src/model-request-debug-types.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
const query = new URLSearchParams(location.search);
const lang = query.get("lang") === "zh-CN" ? "zh-CN" : "en";
document.documentElement.dataset.appearance =
  query.get("theme") === "light" ? "light" : "dark";
const text = referenceMessage(
  "Explain this passage, then compare with the other thread.",
  [
    {
      kind: "thread",
      id: "synthetic-research",
      name: "Research",
      cwd: "/synthetic/workspace",
    },
  ],
  "synthetic-client",
);
const item = {
  type: "user_message" as const,
  id: "synthetic-message",
  threadId: "synthetic-thread",
  turnId: "synthetic-turn",
  createdAt: "2026-10-25T05:00:00Z",
  contentAuthority: { version: 1 as const, hostTextPartIndices: [0] },
  content: [
    {
      type: "text" as const,
      text: '[Zen recorded user-message metadata: received_at="2026-10-25T05:00:00.000Z"]',
    },
    { type: "text" as const, text },
  ],
};
const historyItems: CanonicalItem[] = [
  item,
  {
    type: "model_operation",
    id: "synthetic-operation",
    threadId: item.threadId,
    createdAt: item.createdAt,
    kind: "image-capability-probe",
    sourceItemIds: [item.id],
    selection: {
      providerProfileId: "Synthetic draft provider",
      modelId: "Synthetic probe model",
      reasoningEffort: null,
    },
  },
  {
    type: "context_message",
    id: "synthetic-context",
    threadId: item.threadId,
    createdAt: item.createdAt,
    compilerPolicyVersion: 1,
    sourceItemIds: ["synthetic-operation"],
    role: "user",
    origin: "host",
    purpose: "image-capability-probe",
    variant: "synthetic",
    content: [
      { type: "text", text: "Describe the synthetic image in one word." },
    ],
  },
  {
    type: "model_operation_completed",
    id: "synthetic-completed",
    threadId: item.threadId,
    createdAt: item.createdAt,
    operationItemId: "synthetic-operation",
    status: "completed",
    probeOutcome: "supported",
    content: [{ type: "text", text: "Blue" }],
  },
];
const historyThread = {
  id: item.threadId,
  cwd: "/synthetic",
  turns: [],
  status: { type: "idle" },
  canonicalItems: historyItems,
} as unknown as Thread;
const result: ModelRequestDebugResult = {
  sessionId: "synthetic-session",
  generation: 1,
  enabled: true,
  retainedCount: 1,
  retainedBytes: 300,
  evictedCount: 0,
  limits: {
    maxRecords: 64,
    maxBytes: 10000,
    maxRecordBytes: 10000,
    pageCharacters: 10000,
  },
  records: [
    {
      id: "synthetic-capture",
      capturedAt: "2026-10-25T05:00:01Z",
      threadId: item.threadId,
      turnId: item.turnId,
      purpose: "turn",
      sampleId: "synthetic-sample",
      sampleAttempt: 1,
      transportAttempt: 1,
      contextBoundaryItemId: item.id,
      provider: "synthetic",
      model: "Demo model",
      format: "chat-completions",
      redacted: false,
      truncated: false,
      originalBytes: 300,
      retainedBytes: 300,
      sourceAttachments: [],
      sourceAttachmentCount: 0,
      messageSources: [{ itemId: item.id, container: "messages", index: 1 }],
    },
  ],
};
const commands: ModelRequestDebugCommand[] = [];
Object.assign(window, {
  zenx: {
    modelOperationHistory: async (threadId?: string) =>
      threadId
        ? { threadId, items: historyItems }
        : {
            summaries: [
              {
                threadId: item.threadId,
                name: "Synthetic image probe",
                createdAt: item.createdAt,
              },
            ],
          },
    modelRequestDebug: {
      request: async (command: ModelRequestDebugCommand) => {
        commands.push(command);
        if (command.action === "setEnabled")
          throw new Error("Fixture must not enable capture");
        const response = structuredClone(result);
        if (command.action === "read") {
          const payloadText = JSON.stringify(
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: '[Zen recorded user-message metadata: received_at="2026-10-25T05:00:00.000Z"]',
                },
                { type: "text", text },
              ],
            },
            null,
            2,
          );
          response.page = {
            record: response.records![0]!,
            view: "message",
            text: payloadText,
            offset: 0,
            nextOffset: null,
            totalCharacters: payloadText.length,
          };
        }
        return response;
      },
    },
  },
  messageDebugFixture: { commands },
});
void i18n.changeLanguage(lang).then(() =>
  createRoot(document.getElementById("root")!).render(
    query.get("mode") === "history" ? (
      <main
        style={{
          height: "100vh",
          padding: 16,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ThreadDebugger
          thread={historyThread}
          items={historyItems}
          localModelDebug
        />
      </main>
    ) : (
      <main style={{ maxWidth: 760, margin: "48px auto", padding: 20 }}>
        <p>
          {lang === "zh-CN"
            ? "合成示例 · 不连接真实模型或 Host"
            : "Synthetic fixture · no model or Host connection"}
        </p>
        <MessageContextDebugContext.Provider
          value={{
            threadId: item.threadId,
            items: new Map([[item.id, item]]),
            captureAvailable: true,
          }}
        >
          <article className="user-row">
            <div className="user-bubble">
              {lang === "zh-CN"
                ? "解释这段引用，再与另一个线程比较。"
                : "Explain this reference, then compare with the other thread."}
            </div>
            <div className="message-actions user-message-actions">
              <MessageContextDebugAction itemId={item.id} />
            </div>
          </article>
        </MessageContextDebugContext.Provider>
      </main>
    ),
  ),
);
