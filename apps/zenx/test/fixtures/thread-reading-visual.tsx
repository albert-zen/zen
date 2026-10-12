import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import {
  runtimeThread,
  runtimeCommand,
  runtimeMessage,
} from "./agent-runtime-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
void i18n.changeLanguage("en");
document.documentElement.dataset.appearance =
  new URLSearchParams(location.search).get("theme") ?? "light";
const longAnswer = Array.from(
  { length: 16 },
  (_, i) =>
    `### Reading checkpoint ${i + 1}\n\nThis is an idle, completed conversation. Reading and selecting these paragraphs should never reattach the viewport to the bottom. There are no streaming messages in this fixture.`,
).join("\n\n");
function Fixture() {
  const [id, setId] = useState("thread-a");
  const [hidden, setHidden] = useState(false);
  const [wide, setWide] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const thread = {
    ...runtimeThread(
      [
        runtimeCommand("one"),
        runtimeCommand("two"),
        runtimeMessage("answer", longAnswer),
      ],
      "completed",
    ),
    id,
  };
  return (
    <ThreadReadingStateProvider>
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <nav
          style={{
            display: "flex",
            gap: 12,
            padding: 12,
            flexWrap: "wrap",
            flexShrink: 0,
          }}
          aria-label="Replay controls"
        >
          <button
            onClick={() => {
              setId("thread-a");
              setHidden(false);
            }}
          >
            Thread A
          </button>
          <button
            onClick={() => {
              setId("thread-b");
              setHidden(false);
            }}
          >
            Thread B
          </button>
          <button onClick={() => setHidden((value) => !value)}>
            Toggle Settings
          </button>
          <button onClick={() => setWide((value) => !value)}>
            Resize idle layout
          </button>
          <span>Idle completed fixture · {id}</span>
        </nav>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            width: wide ? "100%" : "40%",
            margin: "auto",
            display: "grid",
          }}
        >
          {hidden ? (
            <div role="status">
              Settings placeholder; conversation unmounted.
            </div>
          ) : (
            <ThreadView
              thread={thread}
              approvals={[]}
              composer={{
                ...emptyComposerState(),
                draft: { text: drafts[id] ?? "", images: [] },
              }}
              onDraftChange={(text) =>
                setDrafts((current) => ({ ...current, [id]: text }))
              }
              onInterrupt={async () => {}}
              onRespondToApproval={async () => {}}
              onSubmit={async () => {}}
            />
          )}
        </div>
      </div>
    </ThreadReadingStateProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
