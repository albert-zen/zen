import React, { useState } from "react";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import {
  emptyComposerState,
  editComposer,
} from "../../src/renderer/src/composer-state.js";
import {
  withSkillDraft,
  parseSkillDraft,
} from "../../src/renderer/src/skill-draft.js";
import { referenceMessage } from "../../src/renderer/src/reference-draft.js";
import { runtimeMessage, runtimeThread } from "./agent-runtime-data.js";
import { applyNativeThreadEvent } from "../../src/renderer/src/thread-view-state.js";
const excerpt = 'Synthetic exact quote.\nSecond line with "punctuation".';
const source = {
  kind: "message" as const,
  name: "Main message",
  cwd: "/synthetic",
  threadId: "synthetic-main",
  id: "synthetic-source",
  excerpt,
  position: 0,
};
function Pane({ side }: { side: boolean }) {
  const id = side ? "synthetic-side" : source.threadId;
  const [thread, setThread] = useState(() => ({
    ...runtimeThread(
      [
        runtimeMessage(
          side ? "side-source" : source.id,
          side ? "Synthetic side chat; no provider calls." : excerpt,
        ),
      ],
      "completed",
      id,
    ),
    cwd: "/synthetic",
  }));
  const [composer, setComposer] = useState(() =>
    editComposer(
      emptyComposerState(),
      side ? "Existing side draft: " : withSkillDraft("\uFFFC", [], [source]),
    ),
  );
  return (
    <section
      data-clipboard-pane={side ? "side" : "main"}
      style={{
        width: "50%",
        height: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--color-border)",
      }}
    >
      <h2 style={{ fontSize: 16, padding: "12px 20px" }}>
        {side ? "Side chat" : "Main thread"}
      </h2>
      <ThreadView
        thread={thread}
        composer={composer}
        composerId={side ? "side-composer" : "main-composer"}
        approvals={[]}
        onDraftChange={(text) => setComposer((old) => editComposer(old, text))}
        onInterrupt={async () => {}}
        onRespondToApproval={async () => {}}
        onSubmit={async () => {
          const draft = parseSkillDraft(composer.draft.text);
          const clientId = `synthetic-send-${id}`;
          setThread((old) =>
            applyNativeThreadEvent(old, {
              type: "item_completed",
              item: {
                type: "user_message",
                id: `sent-${id}`,
                threadId: id,
                turnId: "runtime-turn",
                createdAt: "2026-10-30T07:00:00Z",
                clientId,
                content: [
                  {
                    type: "text",
                    text: referenceMessage(
                      draft.text,
                      draft.references,
                      clientId,
                    ),
                  },
                ],
              },
            }),
          );
          setComposer(emptyComposerState());
        }}
      />
    </section>
  );
}
export function QuoteClipboardVisual() {
  return (
    <ThreadReadingStateProvider>
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <header style={{ padding: 12 }}>
          Synthetic production Composer test — native cut/paste; no model calls
        </header>
        <main style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <Pane side={false} />
          <Pane side />
        </main>
      </div>
    </ThreadReadingStateProvider>
  );
}
