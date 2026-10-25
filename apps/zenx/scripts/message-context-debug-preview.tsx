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
  text,
};
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
    modelRequestDebug: {
      request: async (command: ModelRequestDebugCommand) => {
        commands.push(command);
        if (command.action === "setEnabled")
          throw new Error("Fixture must not enable capture");
        const response = structuredClone(result);
        if (command.action === "read") {
          const text = JSON.stringify(
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: '[Zen recorded user-message metadata: received_at="2026-10-25T05:00:00.000Z"]',
                },
                { type: "text", text: item.text },
              ],
            },
            null,
            2,
          );
          response.page = {
            record: response.records![0]!,
            view: "message",
            text,
            offset: 0,
            nextOffset: null,
            totalCharacters: text.length,
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
    <main style={{ maxWidth: 760, margin: "48px auto", padding: 20 }}>
      <p>
        {lang === "zh-CN"
          ? "合成示例 · 不连接真实模型或 Host"
          : "Synthetic fixture · no model or Host connection"}
      </p>
      <MessageContextDebugContext.Provider
        value={{ threadId: item.threadId, items: new Map([[item.id, item]]) }}
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
    </main>,
  ),
);
