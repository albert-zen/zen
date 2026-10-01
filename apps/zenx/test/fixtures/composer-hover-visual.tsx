// Production controls in an isolated renderer; no Host or user data is connected.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Thread } from "../../src/protocol-client/index.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import {
  emptyComposerState,
  editComposer,
  type ComposerSendMode,
} from "../../src/renderer/src/composer-state.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.platform = "darwin";
const running = params.get("running") === "1";
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
  status: running ? { type: "active", activeFlags: [] } : { type: "idle" },
  path: null,
  cwd: "/synthetic-fixture",
  cliVersion: "fixture",
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Hover controls",
  turns: [
    {
      id: "synthetic-turn",
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 0,
      completedAt: 1,
      durationMs: 1000,
      items: [
        {
          type: "agentMessage",
          id: "synthetic-answer",
          text: Array.from(
            { length: 12 },
            (_, i) => `Paragraph ${i + 1}: isolated renderer check.`,
          ).join("\n\n"),
          phase: "final_answer",
          memoryCitation: null,
        },
      ],
    },
    ...(running
      ? [
          {
            id: "running-turn",
            itemsView: "full" as const,
            items: [],
            status: "inProgress" as const,
            error: null,
            startedAt: Date.now() / 1000,
            completedAt: null,
            durationMs: null,
          },
        ]
      : []),
  ],
};
function Fixture() {
  const [composer, setComposer] = useState(() =>
    editComposer(emptyComposerState(), "Draft stays here"),
  );
  const [sendMode, setSendMode] = useState<ComposerSendMode>("soft");
  const [action, setAction] = useState("No action");
  return (
    <div className="app-shell sidebar-collapsed">
      <div className="window-titlebar" style={{ height: 44 }}>
        <span role="status">{action}</span>
      </div>
      <aside className="sidebar" aria-hidden="true" />
      <main className="workspace">
        <section className="agent-surface">
          <ThreadView
            approvals={[]}
            composer={composer}
            thread={thread}
            composerSendMode={sendMode}
            onComposerSendModeChange={async (mode) => setSendMode(mode)}
            threadUsage={{
              thread: {
                responseCount: 1,
                inputTokens: 51300,
                outputTokens: 348,
                cacheHitRate: 0.93,
              },
              turns: {},
              context: {
                inputTokens: 51300,
                inputTokenSource: "provider",
                contextWindow: 272000,
                ratio: 51300 / 272000,
              },
            }}
            onCompact={async () => setAction("Compacted")}
            onDraftChange={(text) =>
              setComposer((current) => editComposer(current, text))
            }
            onInterrupt={async () => setAction("Stopped")}
            onRespondToApproval={async () => {}}
            onSubmit={async (intent) => setAction(intent)}
          />
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
