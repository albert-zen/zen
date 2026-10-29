/** Production renderer components with synthetic records only. No Host or model. */
import React from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import {
  runtimeCommand,
  runtimeMessage,
  runtimeThread,
} from "./agent-runtime-data.js";
import type {
  CanonicalItem,
  ContextCompactionItem,
} from "../../../../src/item.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

async function mount() {
  Object.assign(globalThis, { React });
  const params = new URLSearchParams(location.search);
  await i18n.changeLanguage(params.get("lang") ?? "zh-CN");
  const zh = i18n.resolvedLanguage === "zh-CN";
  document.documentElement.dataset.appearance = params.get("theme") ?? "light";
  const call = (id: string, toolName: string) => ({
    ...runtimeCommand(id, toolName),
    toolName,
  });
  const view = runtimeThread([
    {
      id: "user",
      type: "userMessage",
      content: [
        {
          type: "text",
          text: zh
            ? "请优化过程摘要和上下文压缩的阅读体验。"
            : "Make process summaries and compacted context easier to read.",
        },
      ],
    },
    ...["a", "b", "c"].map((id) => call(id, "shell")),
    runtimeMessage(
      "progress-a",
      zh
        ? "已检查现有实现，接下来核对上下文。"
        : "The implementation is checked. Next, reviewing the context.",
    ),
    call("compact-call", "compact_context"),
    call("image", "view_image"),
    runtimeMessage(
      "progress-b",
      zh
        ? "保留必要信息，并通知协作会话。"
        : "Keeping the needed context and notifying the collaborating threads.",
    ),
    call("send-a", "threads_send"),
    call("send-b", "threads_send"),
  ]);
  const base = {
    threadId: view.id,
    turnId: "runtime-turn",
    createdAt: "2026-10-28T12:00:00Z",
  };
  const original: CanonicalItem = {
    ...base,
    id: "boundary",
    type: "agent_message",
    text: zh
      ? "原始记录保持不变，可以读取完整公开内容。"
      : "Original records remain unchanged; full public content is readable.",
  };
  const compact: ContextCompactionItem = {
    ...base,
    id: "compaction",
    type: "context_compaction",
    provenance: "agentic",
    initiator: "agent",
    callId: "compact-call",
    sourceModelResponseId: "response",
    coveredThroughItemId: original.id,
    summary: zh
      ? "## 当前目标\n让执行过程更易读，压缩记录只保留一个清晰入口。\n\n- 中英文使用确定性自然模板。\n- 原始历史、保留的上下文和诊断信息分别查看。\n- 所有原始数据保持不变。"
      : "## Current goal\nMake execution easier to follow, with one clear entry per compaction.\n\n- Use deterministic, natural summaries in both languages.\n- Keep retained context, original history and diagnostics in separate views.\n- Preserve all original data.",
    retainedItemIds: [],
    algorithmVersion: "synthetic-preview",
    includeOriginalReference: true,
  };
  view.canonicalItems = [original, compact];
  let reads = 0;
  Object.assign(window, {
    zenx: {
      protocol: {
        request: async (
          method: string,
          request: {
            granularity?: string;
            threadId: string;
            throughItemId: string;
          },
        ) => {
          if (
            method !== "zen/thread/original/read" ||
            request.threadId !== view.id ||
            request.throughItemId !== original.id
          )
            throw new Error("Unexpected synthetic request");
          document.body.dataset.historyReads = String(++reads);
          if (request.granularity === "item")
            return {
              granularity: "item",
              threadId: view.id,
              snapshotThroughItemId: original.id,
              itemId: original.id,
              offset: 0,
              content: JSON.stringify(original),
              totalLength: JSON.stringify(original).length,
              nextCursor: null,
            };
          return {
            granularity: "items",
            threadId: view.id,
            snapshotThroughItemId: original.id,
            items: [
              {
                itemId: original.id,
                turnId: base.turnId,
                createdAt: base.createdAt,
                type: original.type,
                text: original.text,
              },
            ],
            nextCursor: null,
          };
        },
      },
    },
  });
  const style = document.createElement("style");
  style.textContent =
    "html,body,#root{height:100%;overflow:hidden}.process-compaction-preview{height:100%;max-width:900px;margin:auto;padding:16px;display:grid;grid-template-rows:auto minmax(0,1fr)}.process-compaction-preview>header{font-size:12px;color:var(--text-3);padding-bottom:8px}.process-compaction-preview .thread-view{min-height:0}";
  document.head.append(style);
  const noop = async () => {};
  createRoot(document.getElementById("root")!).render(
    <main className="process-compaction-preview">
      <header>
        Synthetic QA · production ThreadView · no Host / model requests
      </header>
      <ThreadView
        thread={view}
        composer={emptyComposerState()}
        approvals={[]}
        onDraftChange={() => {}}
        onInterrupt={noop}
        onRespondToApproval={noop}
        onSubmit={noop}
      />
    </main>,
  );
}
void mount();
