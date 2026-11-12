// Isolated renderer fixture: production ThreadView and request executor, injected
// rejection only. Never invokes a real Host, user Thread, or compact operation.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Thread } from "../../src/protocol-client/index.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { requestContextCompaction } from "../../src/renderer/src/compact-command.js";
import {
  dismissCompactionFeedback,
  emptyComposerState,
} from "../../src/renderer/src/composer-state.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
document.documentElement.dataset.appearance = "dark";
const thread: Thread = {
  id: "synthetic-thread",
  sessionId: "synthetic-thread",
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  isPinned: false,
  modelProvider: "test",
  createdAt: 0,
  updatedAt: 0,
  recencyAt: null,
  status: { type: "idle" },
  path: null,
  cwd: "/synthetic-fixture",
  cliVersion: "fixture",
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Synthetic context failure",
  turns: [
    {
      id: "synthetic-turn",
      items: [
        {
          type: "userMessage",
          id: "synthetic-user",
          clientId: null,
          content: [
            {
              type: "text",
              text: "Synthetic test: summarize this context.",
              text_elements: [],
            },
          ],
        },
        {
          type: "agentMessage",
          id: "synthetic-answer",
          text: "This is fixture content, not a user conversation.",
          phase: "final_answer",
          memoryCitation: null,
        },
      ],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 0,
      completedAt: 1,
      durationMs: 1000,
    },
  ],
};
type Scenario = "http400" | "refresh-failed" | "unknown";
function Fixture() {
  const [scenario, setScenario] = useState<Scenario>("http400");
  const [attempt, setAttempt] = useState(0);
  const [composer, setComposer] = useState(emptyComposerState());
  React.useEffect(() => {
    void requestContextCompaction({
      threadId: thread.id,
      active: false,
      clearCommandDraft: false,
      read: () => emptyComposerState(),
      update: (change) => setComposer((current) => change(current)),
      refresh:
        scenario === "refresh-failed"
          ? async () => {
              throw new Error(
                "Synthetic refresh failure: read-only thread/resume returned HTTP 503. Compaction receipt was already received. No retry was sent.",
              );
            }
          : undefined,
      compact: async () => {
        if (scenario === "refresh-failed")
          return { compactionItemId: "synthetic-receipt" };
        if (scenario === "unknown")
          throw new Error(
            "Synthetic connection lost before a receipt was received. Commit outcome is unknown; do not resend automatically.",
          );
        throw Object.assign(
          new Error(
            "HTTP 400 invalid_parameter_error: developer is not an allowed role. Allowed roles: system, assistant, user, tool, function.\nSynthetic diagnostic only; no real request was sent.",
          ),
          { zenCode: "compaction_generation_failed" },
        );
      },
    });
  }, [scenario, attempt]);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav
        aria-label="Synthetic acceptance scenarios"
        style={{
          padding: 12,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <strong>Synthetic data · production ThreadView</strong>
        <label>
          Scenario{" "}
          <select
            aria-label="Scenario"
            value={scenario}
            onChange={(event) => setScenario(event.target.value as Scenario)}
          >
            <option value="http400">HTTP 400 · not applied</option>
            <option value="refresh-failed">Committed · refresh failed</option>
            <option value="unknown">Transport error · unknown outcome</option>
          </select>
        </label>
        <button onClick={() => setAttempt((value) => value + 1)}>
          Replay synthetic scenario
        </button>
        <output data-testid="fixture-compaction-state">
          {composer.compaction?.status ?? "dismissed"}
        </output>
      </nav>
      <div style={{ padding: "0 12px 12px", fontSize: 12 }}>
        Acceptance: open error details → verify original synthetic cause; close
        notice → verify it disappears; replay restores notice. Committed +
        refresh failed must have no spinner and must not say compaction failed.
      </div>
      <div
        className="agent-surface"
        style={{ flex: 1, minHeight: 0, gridTemplateRows: "minmax(0, 1fr)" }}
      >
        <ThreadView
          approvals={[]}
          composer={composer}
          thread={thread}
          onDraftChange={() => {}}
          onInterrupt={async () => {}}
          onRespondToApproval={async () => {}}
          onSubmit={async () => {}}
          onDismissCompaction={() =>
            setComposer((current) => dismissCompactionFeedback(current))
          }
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
