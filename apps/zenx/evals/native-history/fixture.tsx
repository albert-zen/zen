/** Production ThreadView + native wire fixtures served page-by-page, never all history in JS. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import {
  emptyComposerState,
  editComposer,
} from "../../src/renderer/src/composer-state.js";
import { projectNativeRecovery } from "../../src/renderer/src/thread-view-state.js";
import { readTranscriptAnchor } from "../../src/renderer/src/transcript-viewport-pins.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { Thread } from "../../src/protocol-client/index.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
let manifest: Record<
  string,
  { initial: string; pages: Record<string, string> }
>;
let requests = 0;
let selectedDataset = "";
window.zenx = {
  protocol: {
    request: async (
      method: string,
      params: { threadId: string; before: string },
    ) => {
      if (method !== "zen/thread/history")
        throw new Error(`Unexpected request ${method}`);
      const url = manifest[selectedDataset]?.pages[params.before];
      if (!url) throw new Error("History cursor unavailable");
      requests++;
      return { thread: await fetch(url).then((response) => response.json()) };
    },
  },
} as unknown as typeof window.zenx;
const settle = async () => {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
};
function Fixture() {
  const [thread, setThread] = useState<Thread | null>(null);
  const [composer, setComposer] = useState(() =>
    editComposer(emptyComposerState(), "Keep this draft"),
  );
  Object.assign(window, {
    __historyQA: {
      open: async (id: string) => {
        const start = performance.now();
        selectedDataset = id;
        requests = 0;
        const dataset = manifest[id];
        if (!dataset) throw new Error(`Unknown history dataset: ${id}`);
        const snapshot = await fetch(dataset.initial).then((response) =>
          response.json(),
        );
        setThread(projectNativeRecovery(snapshot));
        await settle();
        return {
          ms: performance.now() - start,
          bytes: JSON.stringify(snapshot).length,
          domNodes: document.querySelectorAll("*").length,
        };
      },
      close: async () => {
        setThread(null);
        await settle();
      },
      load: async () => {
        const button = document.querySelector<HTMLButtonElement>(
          ".thread-history-backfill button",
        );
        if (!button) throw new Error("No earlier history");
        button.click();
        await settle();
        for (
          let i = 0;
          i < 100 &&
          document.querySelector<HTMLButtonElement>(
            ".thread-history-backfill button",
          )?.disabled;
          i++
        )
          await settle();
      },
      anchor: () => {
        const viewport = document.querySelector<HTMLElement>(".messages");
        return viewport ? readTranscriptAnchor(viewport) : null;
      },
      state: () => ({
        requests,
        draft: composer.draft.text,
        mountedTurns: document.querySelectorAll(".turn").length,
        domNodes: document.querySelectorAll("*").length,
        historyRemaining: !!document.querySelector(
          ".thread-history-backfill button",
        ),
        text: document.body.textContent,
      }),
    },
  });
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {thread ? (
        <ThreadView
          thread={thread}
          approvals={[]}
          composer={composer}
          onDraftChange={(text) =>
            setComposer((current) => editComposer(current, text))
          }
          onInterrupt={async () => {}}
          onRespondToApproval={async () => {}}
          onSubmit={async () => {}}
        />
      ) : null}
    </main>
  );
}
void Promise.all([
  i18n.changeLanguage("en"),
  fetch("/history-index.html")
    .then((response) => response.json())
    .then((value) => {
      manifest = value;
    }),
]).then(() =>
  createRoot(document.getElementById("root")!).render(
    <ThreadReadingStateProvider>
      <Fixture />
    </ThreadReadingStateProvider>,
  ),
);
