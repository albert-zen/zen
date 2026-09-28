// Isolated renderer fixture: production ThreadView and request executor, injected
// rejection only. Never invokes a real Host, user Thread, or compact operation.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalCardState } from "../../src/renderer/src/approval-state.js";
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
const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
document.documentElement.dataset.appearance = theme;
document.documentElement.dataset.platform = "darwin";
const crowded = params.get("crowded") === "1";
const queueOnly = params.get("queueOnly") === "1";
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
  status:
    crowded && !queueOnly
      ? { type: "active", activeFlags: [] }
      : { type: "idle" },
  path: null,
  cwd: "/synthetic-fixture",
  cliVersion: "fixture",
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Synthetic context failure",
  queuedMessages: crowded
    ? Array.from({ length: 6 }, (_, i) => ({
        id: `q-${i}`,
        clientId: `q-${i}`,
        text: `Synthetic queued message ${i + 1}`,
        imageCount: 0,
      }))
    : [],
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
    ...(crowded && !queueOnly
      ? [
          {
            id: "running-turn",
            items: [],
            itemsView: "full" as const,
            status: "inProgress" as const,
            error: null,
            startedAt: 2,
            completedAt: null,
            durationMs: null,
          },
        ]
      : []),
  ],
};
const approval = {
  requestId: "synthetic-approval",
  status: "pending",
  decision: null,
  params: {
    threadId: thread.id,
    turnId: "running-turn",
    itemId: "tool-item",
    startedAtMs: 3,
    environmentId: null,
    reason: null,
    command: "Synthetic command ".repeat(18),
    cwd: "/synthetic-fixture",
    toolName: "run_code",
    toolArguments: { code: "Synthetic command ".repeat(18) },
    commandActions: [],
    proposedExecpolicyAmendment: null,
    networkApprovalContext: null,
    proposedNetworkPolicyAmendments: null,
  },
} as ApprovalCardState;
function Fixture() {
  const [composer, setComposer] = useState(() => ({
    ...emptyComposerState(),
    draft: {
      text: crowded
        ? Array.from(
            { length: 18 },
            (_, i) => `Synthetic draft line ${i + 1}`,
          ).join("\n")
        : "Synthetic short draft",
      images: [],
    },
  }));
  React.useEffect(() => {
    void requestContextCompaction({
      threadId: thread.id,
      active: false,
      clearCommandDraft: false,
      read: () => emptyComposerState(),
      update: (change) => setComposer((current) => change(current)),
      compact: async () => {
        throw new Error(
          "Error invoking remote method 'zenx:protocol:request': private=fixture-secret",
        );
      },
    });
  }, []);
  return (
    <div className="app-shell sidebar-collapsed">
      <div className="window-titlebar" style={{ height: 44 }} />
      <aside className="sidebar" aria-hidden="true" />
      <main className="workspace">
        <section className="agent-surface">
          <ThreadView
            approvals={crowded && !queueOnly ? [approval] : []}
            composer={composer}
            thread={thread}
            onDraftChange={(text) =>
              setComposer((current) => ({
                ...current,
                draft: { ...current.draft, text },
              }))
            }
            onInterrupt={async () => {}}
            onRespondToApproval={async () => {}}
            onSubmit={async () => {}}
            onDismissCompaction={() =>
              setComposer((current) => dismissCompactionFeedback(current))
            }
          />
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
