/** Synthetic component boundary only: no App, IPC, native admission or provider. */
import React, { useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import { Markdown } from "../../src/renderer/src/Markdown.js";
import { applyNativeThreadEvent } from "../../src/renderer/src/thread-view-state.js";
import {
  emptyComposerState,
  editComposer,
  beginComposerSubmission,
  acceptComposerSubmission,
} from "../../src/renderer/src/composer-state.js";
import {
  runtimeThread,
  runtimeMessage,
} from "../../test/fixtures/agent-runtime-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { Thread, ThreadItem } from "../../src/protocol-client/index.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
type Counts = { markdown: number; thread: number; commits: number };
type Action =
  | "remember"
  | "restore"
  | "clear"
  | "open"
  | "delta"
  | "markdown"
  | "markdownDelta"
  | "sendScene"
  | "clickSend"
  | "admit";
declare global {
  interface Window {
    __uxCounts: Counts;
    __ux: {
      action(action: Action, n?: number, key?: string): void;
      measure(action: Action, n?: number, key?: string): Promise<unknown>;
      state(): unknown;
      transcript(): {
        lastText: string | null;
        renderedLastText: string | null;
      };
    };
  }
}
const paragraph =
  "## Synthetic heading\n\nA **bold** sentence with `inline code` and [link](https://example.com).\n\n- First item\n- Second item\n\n";
const large = paragraph
  .repeat(Math.ceil(51200 / paragraph.length))
  .slice(0, 51200);
const longtasks: { start: number; duration: number }[] = [];
new PerformanceObserver((list) =>
  longtasks.push(
    ...list
      .getEntries()
      .map((x) => ({ start: x.startTime, duration: x.duration })),
  ),
).observe({ type: "longtask", buffered: true });
function Fixture() {
  const snapshots = useRef(new Map<string, Thread>());
  const [thread, setThread] = useState<Thread | null>(null);
  const [mode, setMode] = useState<"empty" | "thread" | "markdown">("empty");
  const [text, setText] = useState(large);
  const [composer, setComposer] = useState(emptyComposerState);
  const submit = () =>
    setComposer((current) =>
      beginComposerSubmission(current, "start", null, () => "synthetic-client"),
    );
  const action = (kind: Action, n = 100, key = "synthetic-thread") => {
    if (kind === "remember") {
      if (!thread) throw Error("No transcript to preserve");
      snapshots.current.set(thread.id, thread);
      return;
    }
    if (kind === "restore") {
      const saved = snapshots.current.get(key);
      if (!saved) throw Error("No preserved transcript");
      setThread(saved);
      setComposer(emptyComposerState());
      setMode("thread");
      return;
    }
    if (kind === "clear") {
      setMode("empty");
      return;
    }
    if (kind === "open") {
      if (![100, 1000, 5000].includes(n))
        throw Error("Unsupported bounded fixture size");
      const next = runtimeThread([], "inProgress", key);
      const template = next.turns[0]!;
      next.turns = Array.from({ length: n }, (_, i) => ({
        ...template,
        id: "turn-" + i,
        items: [
          runtimeMessage(
            "message-" + i,
            `Synthetic message ${i}. **Bold text** and code.`,
          ),
        ],
        status: i === n - 1 ? ("inProgress" as const) : ("completed" as const),
        completedAt: i === n - 1 ? null : template.startedAt! + 1,
      }));
      setThread(next);
      setComposer(emptyComposerState());
      setMode("thread");
      return;
    }
    if (kind === "delta") {
      setThread((current) => {
        if (!current) throw Error("Missing transcript");
        const last = current.turns.at(-1)!;
        return applyNativeThreadEvent(current, {
          type: "item_delta",
          threadId: current.id,
          turnId: last.id,
          itemId: last.items[0]!.id,
          delta: " delta",
        });
      });
      return;
    }
    if (kind === "markdown") {
      setText(large);
      setMode("markdown");
      return;
    }
    if (kind === "markdownDelta") {
      setText((current) => current + " delta");
      return;
    }
    if (kind === "sendScene") {
      setThread({ ...runtimeThread([], "completed"), turns: [] });
      setComposer(
        editComposer(emptyComposerState(), "Synthetic send feedback"),
      );
      setMode("thread");
      return;
    }
    if (kind === "clickSend") {
      const button = document.querySelector<HTMLButtonElement>(
        ".composer-actions .action-orb.send",
      );
      if (!button || button.disabled)
        throw Error("Synthetic send button unavailable");
      button.click();
      return;
    }
    if (kind === "admit") {
      if (!composer.submission) throw Error("No synthetic submission");
      const item: ThreadItem = {
        type: "userMessage",
        id: "synthetic-admitted",
        clientId: "synthetic-client",
        content: [
          { type: "text", text: composer.submission.text, text_elements: [] },
        ],
      };
      setThread(runtimeThread([item]));
      setComposer((current) =>
        acceptComposerSubmission(current, "synthetic-client"),
      );
    }
  };
  window.__ux = {
    action,
    transcript: () => {
      const last = thread?.turns.at(-1)?.items.at(-1);
      return {
        lastText: last?.type === "agentMessage" ? last.text : null,
        renderedLastText:
          Array.from(
            document.querySelectorAll(".agent-copy [data-message-quote-body]"),
          ).at(-1)?.textContent ?? null,
      };
    },
    state: () => ({
      mode,
      threadId: thread?.id,
      turns: thread?.turns.length ?? 0,
      markdownCharacters: text.length,
      submission: composer.submission?.status ?? null,
      admitted: !!document.querySelector(
        '[data-sent-message-id="synthetic-admitted"]',
      ),
      bodyText: document.body.textContent,
    }),
    measure: async (kind, n, key) => {
      const before = { ...window.__uxCounts };
      const start = performance.now();
      action(kind, n, key);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        ms: performance.now() - start,
        startedAtMs: start,
        counts: Object.fromEntries(
          Object.keys(before).map((k) => [
            k,
            window.__uxCounts[k as keyof Counts] - before[k as keyof Counts],
          ]),
        ),
        longtasks: longtasks.filter((x) => x.start >= start),
        domNodes: document.querySelectorAll("*").length,
      };
    },
  };
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {mode === "thread" ? (
        <ThreadView
          thread={thread}
          approvals={[]}
          composer={composer}
          onDraftChange={(value) =>
            setComposer((current) => editComposer(current, value))
          }
          onInterrupt={async () => {}}
          onRespondToApproval={async () => {}}
          onSubmit={async () => submit()}
        />
      ) : mode === "markdown" ? (
        <Markdown text={text} />
      ) : null}
    </main>
  );
}
void i18n.changeLanguage("en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <ThreadReadingStateProvider>
      <Fixture />
    </ThreadReadingStateProvider>,
  ),
);
