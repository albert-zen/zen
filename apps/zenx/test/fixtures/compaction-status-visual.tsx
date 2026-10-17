/** Same-screen production components. Synthetic data only; no Host actions. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import type { ComposerState } from "../../src/renderer/src/composer-state.js";
import {
  recoveryScenario,
  type RecoveryPhase,
} from "./loop-recovery-scenario.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { ContextCompactionItem } from "../../../../src/item.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const zh = i18n.resolvedLanguage === "zh-CN";
Object.assign(window, {
  zenx: {
    protocol: {
      request: async () => {
        throw new Error(
          zh
            ? "合成只读历史不可用；未调用 Host。"
            : "Synthetic history unavailable; no Host request was made.",
        );
      },
    },
  },
});
const style = document.createElement("style");
style.textContent = `html,body,#root{height:auto;overflow:auto} .status-comparison{max-width:1000px;margin:auto;padding:12px;display:grid;gap:12px}.status-scene{height:520px;display:flex;flex-direction:column;border:1px dashed var(--border);min-width:0}.status-scene>h2{font-size:12px;margin:8px 12px;color:var(--text-3)}.status-scene>.thread-view{min-height:0;flex:1}`;
document.head.append(style);
function Scene({
  phase,
  compaction,
}: {
  phase: RecoveryPhase;
  compaction: "success" | "pending" | "failed";
}) {
  const [dismissed, setDismissed] = useState(false);
  const view = recoveryScenario(phase, phase === "stopped" ? "reload" : "live");
  view.turns = view.turns.map((turn) => ({
    ...turn,
    items: [],
    startedAt: Math.floor(Date.now() / 1000) - 30,
  }));
  const item: ContextCompactionItem = {
    id: "synthetic-compaction",
    type: "context_compaction",
    threadId: view.id,
    createdAt: "2026-10-17T00:00:00Z",
    provenance: "agentic",
    turnId: "synthetic-turn",
    callId: "synthetic-call",
    sourceModelResponseId: "synthetic-response",
    coveredThroughItemId: "synthetic-original",
    summary: zh
      ? "保留工作进展和原始历史引用。这是合成摘要，不是真实用户数据。"
      : "Keep the accepted plan and the original-history reference. Synthetic summary, not user data.",
    retainedItemIds: [],
    algorithmVersion: "synthetic",
    includeOriginalReference: true,
  };
  view.canonicalItems = compaction === "success" ? [item] : [];
  const feedback: ComposerState["compaction"] =
    compaction === "pending"
      ? {
          status: "pending",
          message: zh ? "正在压缩上下文…" : "Compacting context…",
        }
      : compaction === "failed" && !dismissed
        ? {
            status: "failed",
            message: zh
              ? "无法确认上下文压缩。"
              : "Could not confirm context compaction.",
            detail: params.has("long")
              ? `${zh ? "合成诊断：历史保持不变。" : "Synthetic diagnostic: original history is unchanged."}\n${"synthetic-unbroken-diagnostic-".repeat(40)}`
              : zh
                ? "合成诊断：历史保持不变。"
                : "Synthetic diagnostic: original history is unchanged.",
          }
        : undefined;
  return (
    <section className="status-scene" data-scene={compaction}>
      <h2>
        {phase} + compaction {compaction} · production ThreadView / synthetic
      </h2>
      <ThreadView
        approvals={[]}
        thread={view}
        composer={{ ...emptyComposerState(), compaction: feedback }}
        onDraftChange={() => {}}
        onInterrupt={async () => {}}
        onSubmit={async () => {}}
        onRespondToApproval={async () => {}}
        onDismissCompaction={() => setDismissed(true)}
      />
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <main className="status-comparison">
    <Scene phase="running" compaction="success" />
    <Scene phase="recovering" compaction="pending" />
    <Scene phase="failed" compaction="failed" />
  </main>,
);
