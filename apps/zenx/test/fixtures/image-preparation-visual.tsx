/** Production ThreadView; synthetic ItemList snapshots, never a Host/model call. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ContextItem } from "../../../../src/item-list.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { runtimeThread, runtimeMessage } from "./agent-runtime-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
declare const __IMAGE_PREPARATION_SOURCE__: { commit: string; tree: string };
const params = new URLSearchParams(location.search);
const lang = params.get("lang") === "zh-CN" ? "zh-CN" : "en";
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.lang = lang;
const original = {
  type: "attachment" as const,
  sha256: "synthetic-original",
  mediaType: "image/png",
  byteLength: 100,
  width: 4000,
  height: 3000,
};
function input(id: string, sequence: number): ContextItem {
  return {
    id,
    threadId: "synthetic-image-preparation",
    turnId: "synthetic-turn",
    createdAt: "2026-11-03T12:00:00Z",
    kind: "message",
    role: "user",
    source: { kind: "user_message", sequence },
    content: { text: "Synthetic image metadata only", parts: [] },
  } as ContextItem;
}
function notice(
  id: string,
  sequence: number,
  sampleId: string,
  itemId: string,
  supports: boolean | null,
  dimensions = [4000, 3000, 1600, 1200],
  requestedDetail: "high" | "original" = "original",
): ContextItem {
  const [width, height, preparedWidth, preparedHeight] = dimensions;
  const attachment = { ...original, width, height };
  return {
    ...input(id, sequence),
    source: {
      kind: "image_preparation",
      sequence,
      metadata: {
        onlySampleId: sampleId,
        imagePreparation: {
          profile: "codex-high-v1",
          requestedDetail,
          supportsImageDetailOriginal: supports,
          occurrence: {
            itemId,
            field: "parts",
            partIndex: 0,
            sha256: original.sha256,
          },
          originalAttachment: attachment,
        },
      },
    },
    content: {
      text: "Synthetic model-only notice must not appear in ordinary UI.",
      parts: [
        {
          type: "image",
          attachment: {
            ...attachment,
            sha256: "synthetic-prepared",
            width: preparedWidth,
            height: preparedHeight,
          },
        },
      ],
    },
  } as ContextItem;
}
const first = notice("notice-first", 3, "current", "input-first", null);
const second = notice(
  "notice-second",
  5,
  "current",
  "input-second",
  false,
  [2400, 1800, 1536, 1152],
);
const current = [
  input("input-old", 0),
  notice("notice-old", 1, "old", "input-old", false, [9999, 7777, 1000, 778]),
  input("input-first", 2),
  first,
  input("input-second", 4),
  second,
  second,
];
const selection = {
  ...input("selection", 10),
  kind: "selection",
  source: { kind: "context_compaction", sequence: 10 },
  content: {
    text: "Synthetic selection",
    coveredThroughItemId: "notice-second",
    coveredSequence: 9,
    retainedItemIds: [],
  },
} as ContextItem;
const unavailable = {
  ...input("unavailable", 10),
  source: {
    kind: "media_unavailable",
    sequence: 10,
    metadata: { onlySampleId: "later-unavailable", omittedMedia: [] },
  },
} as ContextItem;
function codecUnavailable(
  id: string,
  sequence: number,
  sampleId: string,
  itemId: string,
  reason: "image_decode_failed" | "image_processing_failed",
): ContextItem {
  const prepared = notice(id, sequence, sampleId, itemId, false);
  return {
    ...prepared,
    source: {
      ...prepared.source,
      metadata: {
        ...prepared.source.metadata,
        imagePreparation: {
          ...(prepared.source.metadata?.imagePreparation as Record<
            string,
            unknown
          >),
          outcome: "unavailable",
          reason,
        },
      },
    },
    content: {
      text: "Synthetic safe model-only unavailable notice.",
      parts: [
        { type: "text", text: "Synthetic safe model-only unavailable notice." },
      ],
    },
  } as ContextItem;
}
const scenarios: Record<string, readonly ContextItem[]> = {
  Current: current,
  "Ordinary prepared": [
    input("input-ordinary", 0),
    notice(
      "notice-ordinary",
      1,
      "ordinary",
      "input-ordinary",
      true,
      undefined,
      "high",
    ),
  ],
  "Codec unavailable": [
    input("input-codec", 0),
    codecUnavailable(
      "notice-codec",
      1,
      "codec",
      "input-codec",
      "image_decode_failed",
    ),
  ],
  "Mixed outcome": [
    input("input-first", 0),
    notice("notice-first", 1, "mixed", "input-first", null),
    input("input-codec", 2),
    codecUnavailable(
      "notice-codec",
      3,
      "mixed",
      "input-codec",
      "image_processing_failed",
    ),
  ],
  "Codec cold selected": [
    input("input-codec", 0),
    codecUnavailable(
      "notice-codec",
      1,
      "codec",
      "input-codec",
      "image_decode_failed",
    ),
    {
      ...selection,
      content: {
        ...selection.content,
        retainedItemIds: ["input-codec", "notice-codec"],
      },
    } as ContextItem,
  ],
  Compacted: [...current, selection],
  "Later unavailable": [...current, unavailable],
  "Retained only": [
    ...current,
    {
      ...selection,
      content: {
        ...selection.content,
        retainedItemIds: ["input-first", "notice-first"],
      },
    } as ContextItem,
  ],
  "Other thread": [],
};
function Preview() {
  const [scene, setScene] = useState("Current");
  const [draft, setDraft] = useState({ text: "", images: [] });
  const thread = runtimeThread(
    [
      runtimeMessage(
        "synthetic-answer",
        lang === "zh-CN"
          ? "此处仅使用合成图片元数据。原生 Host、附件读取和模型派发未在此预览中运行。"
          : "This fixture uses synthetic image metadata only. Native Host, attachment reading and model dispatch do not run here.",
      ),
    ],
    "completed",
    scene === "Other thread"
      ? "synthetic-other"
      : "synthetic-image-preparation",
  );
  thread.name = "Synthetic image preparation";
  thread.itemList = [...(scenarios[scene] ?? [])];
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <header
        style={{
          flex: "0 0 auto",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
        }}
      >
        <strong>Synthetic fixture · production ThreadView</strong>
        <div>
          Source {__IMAGE_PREPARATION_SOURCE__.commit.slice(0, 8)} · tree{" "}
          {__IMAGE_PREPARATION_SOURCE__.tree.slice(0, 8)} · no App/Host/model
          call
        </div>
        <nav
          aria-label="Synthetic snapshot controls"
          style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}
        >
          {Object.keys(scenarios).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={scene === name}
              onClick={() => setScene(name)}
            >
              {name}
            </button>
          ))}
        </nav>
        <div role="status">Synthetic snapshot: {scene}</div>
      </header>
      <ThreadView
        thread={thread}
        approvals={[]}
        composer={{ ...emptyComposerState(), draft }}
        onDraftChange={(text) =>
          setDraft((previous) => ({ ...previous, text }))
        }
        onInterrupt={async () => {}}
        onRespondToApproval={async () => {}}
        onSubmit={async () => {}}
      />
    </main>
  );
}
i18n
  .changeLanguage(lang)
  .then(() => createRoot(document.getElementById("root")!).render(<Preview />));
