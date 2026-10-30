import { SideChatQuoteChooser } from "../../src/renderer/src/SideChatQuoteChooser.js";
import type { MessageQuoteReference } from "../../src/renderer/src/composer-selector.js";
import { chooseSideChatQuoteTarget } from "../../src/renderer/src/side-chat-quote-target.js";
import { addMessageQuote } from "../../src/renderer/src/message-quote.js";
import React, { useState } from "react";
import {
  ThreadView,
  ThreadViewActionsProvider,
} from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import {
  emptyComposerState,
  editComposer,
  type ComposerState,
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
function Pane({
  side,
  composer,
  setComposer,
}: {
  side: boolean;
  composer: ComposerState;
  setComposer: React.Dispatch<React.SetStateAction<ComposerState>>;
}) {
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
    canonicalItems: [
      {
        type: "agent_message" as const,
        id: side ? "side-source" : source.id,
        threadId: id,
        turnId: "runtime-turn",
        createdAt: "2026-10-30T07:00:00Z",
        text: side ? "Synthetic side chat; no provider calls." : excerpt,
      },
    ],
  }));
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
  const sideQuoteMode = new URLSearchParams(location.search).has("sidequote");
  const [mainComposer, setMainComposer] = useState(() =>
    editComposer(
      emptyComposerState(),
      sideQuoteMode
        ? "Existing main draft: "
        : withSkillDraft("\uFFFC", [], [source]),
    ),
  );
  const [sideComposer, setSideComposer] = useState(() =>
    editComposer(emptyComposerState(), "Existing side draft: "),
  );
  const [composerFocus, setComposerFocus] = useState<{
    composerId: string;
    sequence: number;
  }>();
  const [sourceStatus, setSourceStatus] = useState("");
  const chooserMode = new URLSearchParams(location.search).has("chooser");
  const [pendingQuote, setPendingQuote] =
    useState<MessageQuoteReference | null>(null);
  const targets = [
    { id: "side-composer", title: "Research notes" },
    ...(chooserMode
      ? [{ id: "alternate-composer", title: "Implementation questions" }]
      : []),
  ];
  const insertQuote = (quote: MessageQuoteReference, id: string) => {
    // Fixture offers one rendered destination. App tests cover native/local target ownership.
    if (id !== "side-composer") {
      setSourceStatus(
        "This synthetic fixture only renders Research notes; nothing was added or sent.",
      );
      return;
    }
    setSideComposer((current) =>
      editComposer(current, addMessageQuote(current.draft.text, quote)),
    );
    setComposerFocus((current) => ({
      composerId: id,
      sequence: (current?.sequence ?? 0) + 1,
    }));
    setPendingQuote(null);
  };
  return (
    <ThreadReadingStateProvider>
      <ThreadViewActionsProvider
        fork={async () => {
          throw new Error("Fork is unavailable in this synthetic fixture");
        }}
        source={async (target, owner) => {
          if (!owner.isCurrent() || target.kind !== "thread" || !target.itemId)
            return;
          const element = [
            ...document.querySelectorAll<HTMLElement>(
              "[data-quote-thread-id][data-quote-item-id]",
            ),
          ].find(
            (element) =>
              element.dataset.quoteThreadId === target.id &&
              element.dataset.quoteItemId === target.itemId,
          );
          if (!element)
            throw new Error("Exact synthetic source is unavailable");
          element.tabIndex = -1;
          element.focus({ preventScroll: true });
          element.scrollIntoView({ block: "center" });
          setSourceStatus(
            `Exact ${target.id === source.threadId ? "main" : "side"} message focused; drafts unchanged`,
          );
        }}
        composerFocus={composerFocus}
        addToSideChat={(quote) => {
          const target = chooseSideChatQuoteTarget(
            targets,
            chooserMode ? undefined : "side-composer",
          );
          if (!target) {
            setPendingQuote(quote);
            return;
          }
          insertQuote(quote, target.id);
        }}
      >
        <div
          style={{ height: "100vh", display: "flex", flexDirection: "column" }}
        >
          <header style={{ padding: 12 }}>
            Synthetic production ThreadViews — selection / native clipboard; no
            model calls or auto-send
            <small style={{ display: "block" }}>
              Synthetic targets use production quote helpers and chooser; source
              navigation is an exact-ID fixture callback, not Host lookup.
            </small>
            <span role="status">{sourceStatus}</span>
          </header>
          <main style={{ display: "flex", flex: 1, minHeight: 0 }}>
            <Pane
              side={false}
              composer={mainComposer}
              setComposer={setMainComposer}
            />
            <Pane side composer={sideComposer} setComposer={setSideComposer} />
          </main>
        </div>
        {pendingQuote ? (
          <SideChatQuoteChooser
            targets={targets}
            onClose={() => setPendingQuote(null)}
            onChoose={(id) =>
              insertQuote(pendingQuote, id ?? "new-synthetic-target")
            }
          />
        ) : null}
      </ThreadViewActionsProvider>
    </ThreadReadingStateProvider>
  );
}
