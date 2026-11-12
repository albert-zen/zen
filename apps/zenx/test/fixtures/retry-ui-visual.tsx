/** Synthetic acceptance scene using the production ThreadView and native projection. */
import React, { useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  createManualTurnRetryRequester,
  type ManualTurnRetryParams,
} from "../../src/renderer/src/manual-turn-retry.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import {
  emptyComposerState,
  editComposer,
} from "../../src/renderer/src/composer-state.js";
import {
  recoveryScenario,
  type RecoveryPhase,
} from "./loop-recovery-scenario.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "zh-CN");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
function Fixture() {
  const [phase, setPhase] = useState<RecoveryPhase>(
    (params.get("phase") as RecoveryPhase) ?? "failed",
  );
  const [disabled, setDisabled] = useState(params.has("disabled"));
  const [composer, setComposer] = useState(() =>
    editComposer(emptyComposerState(), params.get("draft") ?? ""),
  );
  const [sends, setSends] = useState(0);
  const [retrySends, setRetrySends] = useState(0);
  const [lastRequest, setLastRequest] = useState<ManualTurnRetryParams | null>(
    null,
  );
  const release = useRef<(() => void) | null>(null);
  const rejectReceipt = useRef<(() => void) | null>(null);
  const [requestRetry] = useState(() =>
    createManualTurnRetryRequester((params) => {
      setRetrySends((n) => n + 1);
      setLastRequest(params);
      return new Promise((resolve, reject) => {
        rejectReceipt.current = () => {
          reject(new Error("合成请求未确认，请重试。"));
          release.current = null;
          rejectReceipt.current = null;
        };
        release.current = () => {
          setPhase("continuing");
          resolve({ turnId: "synthetic-manual-continuation" });
          release.current = null;
          rejectReceipt.current = null;
        };
      });
    }),
  );
  const [startedAt] = useState(() => Math.floor(Date.now() / 1000) - 30);
  const view = recoveryScenario(phase, phase === "stopped" ? "reload" : "live");
  view.turns = view.turns.map((turn) => ({
    ...turn,
    startedAt,
    completedAt: turn.status === "inProgress" ? null : startedAt + 30,
    durationMs: turn.status === "inProgress" ? null : 30_000,
    items: params.has("long")
      ? [
          ...turn.items,
          ...Array.from({ length: 18 }, (_, index) => ({
            type: "agentMessage" as const,
            id: `synthetic-progress-${index}`,
            phase: "commentary" as const,
            text: `合成检查进度 ${index + 1}：已核对这一项并保留结果。继续检查剩余页面与响应行为。`,
            memoryCitation: null,
          })),
        ]
      : turn.items,
  }));
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        maxWidth: 1000,
        margin: "auto",
      }}
    >
      <aside
        aria-label="Synthetic QA controls"
        style={{
          flexShrink: 0,
          border: "1px dashed var(--border)",
          padding: 10,
          margin: 10,
          fontSize: 12,
        }}
      >
        合成验收控制区 · 以下为生产 ThreadView（非 Electron 端到端）
        <select
          aria-label="Scenario"
          value={phase}
          onChange={(e) => setPhase(e.target.value as RecoveryPhase)}
        >
          {[
            "running",
            "recovering",
            "continuing",
            "completed",
            "failed",
            "stopped",
          ].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          禁止输入
        </label>
        <span>
          普通发送：{sends} · 合成重试请求：{retrySends}
        </span>
        <button onClick={() => release.current?.()} disabled={!release.current}>
          确认合成回执
        </button>
        <button
          onClick={() => rejectReceipt.current?.()}
          disabled={!rejectReceipt.current}
        >
          拒绝合成回执
        </button>
        {lastRequest ? (
          <span>
            请求文本：{lastRequest.language === "zh-CN" ? "继续" : "Go on"}
          </span>
        ) : null}
      </aside>
      <ThreadView
        approvals={[]}
        thread={view}
        composer={composer}
        composerDisabled={disabled}
        onDraftChange={(text) =>
          setComposer((value) => editComposer(value, text))
        }
        onRetryTurn={(turnId) => requestRetry(view, turnId)}
        onSubmit={async () => {
          setSends((n) => n + 1);
        }}
        onInterrupt={async () => setPhase("stopped")}
        onRespondToApproval={async () => undefined}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
