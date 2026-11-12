import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ThreadView,
  MessageForkContext,
} from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { runtimeThread, runtimeMessage } from "./agent-runtime-data.js";
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const base = runtimeThread(
  [
    {
      type: "userMessage",
      id: "request",
      clientId: null,
      content: [
        {
          type: "text",
          text: "Compare two approaches, then show the next steps.",
          text_elements: [],
        },
      ],
    },
    {
      ...runtimeMessage(
        "checkpoint",
        "The smaller change reuses the existing canonical history. We can fork at this checkpoint and explore another direction.",
      ),
      phase: "commentary",
    },
    runtimeMessage(
      "later-reply",
      "This is a later message. Forking from the checkpoint above must leave this reply behind.",
    ),
  ],
  "interrupted",
  "synthetic-source",
);
base.turns[0]!.items = base.turns[0]!.items.filter(
  (item) => item.id !== "runtime-user" && item.id !== "runtime-intro",
);
const source = {
  ...base,
  canonicalItems: nativeRecoveryForThread(base).thread.items,
};
function Fixture() {
  const [thread, setThread] = useState(source);
  const [notice, setNotice] = useState(
    "Synthetic conversation • actual ThreadView component",
  );
  return (
    <ThreadReadingStateProvider>
      <MessageForkContext.Provider
        value={async (target, current) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (params.has("fail"))
            throw new Error("This exact message is no longer available.");
          if (!current.isCurrent()) return;
          const index = source.turns[0]!.items.findIndex(
            (item) => item.id === target.itemId,
          );
          const next = {
            ...source,
            id: "synthetic-fork",
            turns: [
              {
                ...source.turns[0]!,
                items: source.turns[0]!.items.slice(0, index + 1),
              },
            ],
          };
          setThread({
            ...next,
            canonicalItems: nativeRecoveryForThread(next).thread.items,
          });
          setNotice("Opened synthetic fork • no new Turn or tool replay");
        }}
      >
        <main
          style={{
            height: "100vh",
            display: "grid",
            gridTemplateRows: "auto minmax(0, 1fr)",
            maxWidth: 1000,
            margin: "0 auto",
          }}
        >
          <header
            style={{
              padding: "18px 24px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <strong>Message Fork</strong>
            <p
              style={{
                margin: "4px 0 0",
                fontSize: 12,
                color: "var(--text-3)",
              }}
            >
              {notice}
            </p>
          </header>
          <ThreadView
            thread={thread}
            approvals={[]}
            composer={emptyComposerState()}
            onDraftChange={() => {}}
            onInterrupt={async () => {}}
            onRespondToApproval={async () => {}}
            onSubmit={async () => {}}
          />
        </main>
      </MessageForkContext.Provider>
    </ThreadReadingStateProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
