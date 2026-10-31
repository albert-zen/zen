/** Actual ThreadView; synthetic input/status and fixed clock only. No Host/model calls. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { runtimeThread } from "./agent-runtime-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
// Fixture-only clock: preparation and continuation must retain the same elapsed total.
Date.now = () => 22000;
const thread = runtimeThread(
  [
    {
      type: "userMessage",
      id: "synthetic-input",
      clientId: "synthetic-client",
      content: [
        {
          type: "text",
          text: "Please review this synthetic example.",
          text_elements: [],
        },
      ],
    },
  ],
  "inProgress",
  "synthetic-thread",
);
thread.turns[0].startedAt = 10;
function Preview() {
  const [pending, setPending] = useState(true);
  Object.assign(window, {
    __preparationPreview: { resume: () => setPending(false) },
  });
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "18px 24px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        Synthetic acceptance fixture · actual ThreadView · simulated clock · no
        Host/model call
      </header>
      <ThreadView
        thread={thread}
        approvals={[]}
        composer={{
          ...emptyComposerState(),
          compaction: pending
            ? {
                status: "pending",
                message: "Automatically compacting context…",
                detail: "Synthetic pre-turn preparation observation.",
              }
            : undefined,
        }}
        onDraftChange={() => {}}
        onInterrupt={async () => {}}
        onRespondToApproval={async () => {}}
        onSubmit={async () => {}}
      />
    </main>
  );
}
i18n
  .changeLanguage("en")
  .then(() => createRoot(document.getElementById("root")!).render(<Preview />));
