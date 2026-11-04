/** Production ThreadView, synthetic native lifecycle and recovery only. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import {
  emptyReasoningScenario,
  type EmptyReasoningPhase,
} from "./empty-reasoning-scenario.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
await i18n.changeLanguage("zh-CN");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
function Preview() {
  const [phase, setPhase] = useState<EmptyReasoningPhase>("started");
  const [generation, setGeneration] = useState(0);
  const thread = emptyReasoningScenario(phase);
  Object.assign(window, {
    emptyReasoningProbe: {
      setPhase(next: EmptyReasoningPhase) {
        if (next.startsWith("restored")) setGeneration((value) => value + 1);
        setPhase(next);
      },
      state() {
        return {
          phase,
          items: thread.turns[0]!.items,
          canonicalItems: thread.canonicalItems,
        };
      },
    },
  });
  return (
    <div
      className="agent-surface"
      style={{ gridTemplateRows: "minmax(0, 1fr)" }}
    >
      <ThreadView
        key={generation}
        approvals={[]}
        composer={emptyComposerState()}
        thread={thread}
        onDraftChange={() => {}}
        onInterrupt={async () => {}}
        onRespondToApproval={async () => {}}
        onSubmit={async () => {}}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
