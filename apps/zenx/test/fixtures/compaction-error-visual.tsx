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
function Fixture() {
  const [composer, setComposer] = useState(emptyComposerState());
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
    <div
      className="agent-surface"
      style={{ height: "100vh", gridTemplateRows: "minmax(0, 1fr)" }}
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
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
