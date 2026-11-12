/** Synthetic admission delays; real ThreadView, Composer and state transitions. No Host/Provider. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import {
  acceptComposerSubmission,
  beginComposerSubmission,
  editComposer,
  emptyComposerState,
  failComposerSubmission,
} from "../../src/renderer/src/composer-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import { runtimeThread, runtimeIntro } from "./agent-runtime-data.js";
import type { Thread, ThreadItem } from "../../src/protocol-client/index.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
void i18n.changeLanguage("en");
const initial = () => ({
  ...runtimeThread(),
  turns: [],
  status: { type: "idle" as const },
});
function Preview() {
  const [thread, setThread] = useState<Thread>(initial);
  const [composer, setComposer] = useState(() =>
    editComposer(
      emptyComposerState(),
      "Send this synthetic message without waiting for the title.",
    ),
  );
  const [steer, setSteer] = useState(false);
  const send = () => {
    const next = beginComposerSubmission(
      composer,
      steer ? "steer" : "start",
      steer ? "runtime-turn" : null,
      () => "synthetic-client",
    );
    if (next === composer || next.submission === null) return;
    setComposer(next);
    if (!steer) setThread(runtimeThread([]));
  };
  const admit = () => {
    if (!composer.submission) return;
    const item: ThreadItem = {
      type: "userMessage",
      id: "synthetic-admitted-input",
      clientId: composer.submission.clientUserMessageId,
      content: [
        { type: "text", text: composer.submission.text, text_elements: [] },
      ],
    };
    setThread((current) => ({
      ...current,
      turns: current.turns.map((turn) => ({
        ...turn,
        items: [...turn.items, item],
      })),
    }));
    setComposer((current) =>
      acceptComposerSubmission(current, "synthetic-client"),
    );
  };
  Object.assign(window, {
    __sendAdmissionPreview: {
      send,
      admit,
      fail: () => {
        setComposer((current) =>
          failComposerSubmission(
            current,
            "synthetic-client",
            "Synthetic input rejected before durable admission; draft preserved.",
          ),
        );
        if (!steer) setThread(initial());
      },
      reset: (active = false) => {
        setSteer(active);
        setThread(active ? runtimeThread([runtimeIntro[0]!]) : initial());
        setComposer(
          editComposer(
            emptyComposerState(),
            active
              ? "Synthetic steer stays pending until admitted."
              : "Send this synthetic message without waiting for the title.",
          ),
        );
      },
      setTheme: (theme: string) => {
        document.documentElement.dataset.appearance = theme;
      },
    },
  });
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: 12,
          borderBottom: "1px solid var(--border)",
          font: "13px system-ui",
        }}
      >
        <strong>Send admission · synthetic fixture</strong>
        <p>
          No Host, Provider, real user data or background requests. Send holds
          admission; click Admit or Reject to settle it.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={send}>Send / hold</button>
          <button onClick={admit}>Admit input</button>
          <button onClick={() => (window as any).__sendAdmissionPreview.fail()}>
            Reject input
          </button>
          <button
            onClick={() => (window as any).__sendAdmissionPreview.reset(false)}
          >
            Idle
          </button>
          <button
            onClick={() => (window as any).__sendAdmissionPreview.reset(true)}
          >
            Active / steer
          </button>
        </div>
      </header>
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ThreadReadingStateProvider>
          <ThreadView
            thread={thread}
            approvals={[]}
            composer={composer}
            onDraftChange={(text) =>
              setComposer((current) => editComposer(current, text))
            }
            onSubmit={async () => send()}
            onInterrupt={async () => {}}
            onRespondToApproval={async () => {}}
          />
        </ThreadReadingStateProvider>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
