/** Real renderer components with synthetic events only. No Host or model calls. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ContextCompactionPanel } from "../../src/renderer/src/ContextCompactionPanel.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { applyCompactionStatus } from "../../src/renderer/src/compaction-feedback.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import { recoveryScenario } from "./loop-recovery-scenario.js";
import type { ContextCompactionStatusEvent } from "../../../../src/app-server.js";
import type { ContextCompactionItem } from "../../../../src/item.js";
import {
  CONTEXT_COMPACTION_ALGORITHM_VERSION,
  type ContextCompactionConfig,
} from "../../../../src/context-compaction.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

async function mount() {
  Object.assign(globalThis, { React });
  await i18n.changeLanguage(
    new URLSearchParams(location.search).get("lang") ?? "zh-CN",
  );
  const style = document.createElement("style");
  style.textContent = `html,body,#root{height:100%;overflow:hidden}.fixture{height:100%;display:flex;flex-direction:column}.fixture-controls{display:flex;gap:8px;padding:10px;flex-wrap:wrap;border-bottom:1px solid var(--border);font:13px system-ui}.fixture-controls label{display:flex;gap:5px;align-items:center}.fixture-controls select,.fixture-controls button{font:inherit;padding:5px;min-height:30px}.fixture-surface{flex:1;min-height:0;width:100%;max-width:1000px;margin:auto;display:flex;flex-direction:column}.fixture-surface.narrow{max-width:390px}.fixture-surface>.thread-view{flex:1;min-height:0}.fixture-settings{overflow:auto;padding:16px}.fixture-controls small{width:100%}`;
  document.head.append(style);
  function Fixture() {
    const [phase, setPhase] =
      useState<ContextCompactionStatusEvent["phase"]>("pending");
    const [reason, setReason] =
      useState<ContextCompactionStatusEvent["trigger"]["reason"]>(
        "next_turn_estimate",
      );
    const [language, setLanguage] = useState(i18n.resolvedLanguage ?? "zh-CN");
    const [theme, setTheme] = useState("light");
    const [narrow, setNarrow] = useState(false);
    const [settings, setSettings] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [config, setConfig] = useState<ContextCompactionConfig | undefined>({
      agenticEnabled: true,
      triggerPercent: 80,
      targetPercent: 80,
    });
    document.documentElement.dataset.appearance = theme;
    const view = recoveryScenario("completed", "reload");
    const event: ContextCompactionStatusEvent = {
      type: "context_compaction_status",
      threadId: view.id,
      operationId: "synthetic-operation",
      initiator: reason === "explicit_request" ? "human" : "automatic",
      phase,
      coveredThroughItemId: "turn-done",
      startedAfterItemId: "turn-done",
      contextWindow: 128_000,
      triggerPercent: 80,
      targetPercent: 80,
      agenticEnabled: reason === "active_turn_fallback",
      trigger: {
        reason,
        estimatedInputTokens: 103_000,
        providerInputTokens: 96_000,
        thresholdTokens: 102_400,
      },
      ...(phase === "committed"
        ? { compactionItemId: "synthetic-compaction" }
        : {}),
      ...(["failed", "unknown"].includes(phase)
        ? {
            error: {
              name: "SyntheticError",
              message:
                "Synthetic local diagnostic: <script>never executed</script>\nSummary generation rejected; this fixture did not contact any provider.",
            },
          }
        : {}),
    };
    const item: ContextCompactionItem = {
      id: "synthetic-compaction",
      threadId: view.id,
      createdAt: "2026-10-29T00:00:00.000Z",
      type: "context_compaction",
      provenance: "provider_generated",
      initiator: event.initiator,
      coveredThroughItemId: "turn-done",
      summary:
        "Synthetic continuation: preserve the accepted goal and continue only after the pending user input is admitted.",
      retainedItemIds: [],
      includeOriginalReference: false,
      algorithmVersion: CONTEXT_COMPACTION_ALGORITHM_VERSION,
      providerProfileId: "synthetic",
      modelId: "synthetic",
      reasoningEffort: null,
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
    };
    if (phase === "committed")
      view.canonicalItems = [...(view.canonicalItems ?? []), item];
    const composer = dismissed
      ? emptyComposerState()
      : applyCompactionStatus(emptyComposerState(), event);
    return (
      <div className="fixture">
        <header className="fixture-controls">
          <label>
            Phase{" "}
            <select
              aria-label="Compaction phase"
              value={phase}
              onChange={(e) => {
                setPhase(e.target.value as typeof phase);
                setDismissed(false);
              }}
            >
              {["pending", "committed", "failed", "cancelled", "unknown"].map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Cause{" "}
            <select
              aria-label="Compaction cause"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value as typeof reason);
                setDismissed(false);
              }}
            >
              {[
                "explicit_request",
                "next_turn_estimate",
                "completed_turn_usage",
                "active_turn_threshold",
                "active_turn_fallback",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <select
            aria-label="Language"
            value={language}
            onChange={(e) => {
              const next = e.target.value;
              void i18n.changeLanguage(next).then(() => setLanguage(next));
            }}
          >
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
          <select
            aria-label="Theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          >
            <option>light</option>
            <option>dark</option>
          </select>
          <button onClick={() => setNarrow(!narrow)}>390px / wide</button>
          <button onClick={() => setSettings(!settings)}>
            Status / Settings
          </button>
          <small>
            Synthetic data · actual ThreadView / ContextCompactionPanel / native
            feedback reducer · no Host, paid API, retries or user data.
          </small>
        </header>
        <main className={`fixture-surface${narrow ? " narrow" : ""}`}>
          {settings ? (
            <div className="fixture-settings">
              <ContextCompactionPanel config={config} onChange={setConfig} />
            </div>
          ) : (
            <ThreadView
              key={language}
              thread={view}
              composer={composer}
              approvals={[]}
              onDraftChange={() => {}}
              onInterrupt={async () => {}}
              onSubmit={async () => {}}
              onRespondToApproval={async () => {}}
              onDismissCompaction={() => setDismissed(true)}
            />
          )}
        </main>
      </div>
    );
  }
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
void mount();
