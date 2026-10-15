import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import {
  recoveryPhases,
  recoveryScenario,
  type RecoveryPhase,
} from "./loop-recovery-scenario.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
await i18n.changeLanguage("zh-CN");
const phaseNames: Record<RecoveryPhase, string> = {
  running: "执行中",
  recovering: "恢复等待",
  continuing: "继续采样",
  completed: "已完成",
  failed: "恢复耗尽",
  stopped: "用户停止",
};
const requested = params.get("phase") as RecoveryPhase | null;
const initialPhase =
  requested !== null && recoveryPhases.includes(requested)
    ? requested
    : "recovering";
const mode = params.get("mode") === "reload" ? "reload" : "live";
const noop = async () => {};
function Fixture() {
  const [phase, setPhase] = useState<RecoveryPhase>(initialPhase);
  const thread = recoveryScenario(phase, mode);
  const turn = thread.turns[0]!;
  Object.assign(window, { recoveryFixture: { phase, mode, thread } });
  return (
    <main
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        maxWidth: params.has("narrow") ? 420 : 1100,
        margin: "auto",
        padding: 16,
      }}
    >
      <header style={{ marginBottom: 12 }}>
        <h2>同一轮自动恢复 · {phaseNames[phase]}</h2>
        <p>Synthetic QA · production ThreadView / native projection · {mode}</p>
        <nav
          aria-label="合成恢复场景"
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          {recoveryPhases.map((value) => (
            <button
              key={value}
              type="button"
              className="quiet-button"
              aria-pressed={value === phase}
              onClick={() => setPhase(value)}
            >
              {phaseNames[value]}
            </button>
          ))}
        </nav>
        <p data-testid="synthetic-state">
          Fixture metadata: Turn {turn.status}; error{" "}
          {turn.error === null ? "null" : "terminal"}; canonical recovery{" "}
          {
            thread.canonicalItems?.filter(
              (item) => item.type === "failure" && item.recovery !== undefined,
            ).length
          }
          ; synthetic write receipt {phase === "running" ? "pending" : "1"}
        </p>
      </header>
      <ThreadView
        thread={thread}
        composer={emptyComposerState()}
        approvals={[]}
        onDraftChange={() => {}}
        onInterrupt={noop}
        onRespondToApproval={noop}
        onSubmit={noop}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
