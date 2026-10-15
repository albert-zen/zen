import React from "react";
import { createRoot } from "react-dom/client";
import { FleetComposerSurface } from "../../src/renderer/src/FleetComposerSurface.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { runtimeThread, runtimeMessage } from "./agent-runtime-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/fleet-ui.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const thread = runtimeThread(
  [
    runtimeMessage(
      "answer",
      "The synthetic benchmark produced 900 output tokens in a three-second Turn. Hover this answer's telemetry, or open the context indicator below, to inspect the rate.",
    ),
  ],
  "completed",
);
(window as any).zenx = {
  fleet: {
    status: async () => ({
      revision: 1,
      config: {
        version: 1,
        devices: [
          {
            id: "research",
            label: "Research workstation · Linux",
            description: "Synthetic long machine name",
          },
          {
            id: "design",
            label: "Design and prototyping MacBook Pro",
            description: "Synthetic long machine name",
          },
        ],
      },
      host: { hostId: "synthetic", enabled: false, clients: [] },
    }),
    catalog: async () => {
      throw new Error("This visual fixture does not connect to machines.");
    },
  },
};
createRoot(document.getElementById("root")!).render(
  <main
    style={{
      margin: "20px auto",
      width: "min(900px, calc(100% - 24px))",
      height: "calc(100vh - 40px)",
      display: "grid",
      gridTemplateRows: "auto minmax(0, 1fr)",
    }}
  >
    <div
      style={{
        padding: 12,
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <FleetComposerSurface text="" onTextChange={() => {}}>
        {(control) => (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {control}
            <small>
              Synthetic machines and telemetry; production components.
            </small>
          </div>
        )}
      </FleetComposerSurface>
    </div>
    <ThreadView
      thread={thread}
      approvals={[]}
      composer={emptyComposerState()}
      onDraftChange={() => {}}
      onInterrupt={() => {}}
      onRespondToApproval={async () => {}}
      onSubmit={() => {}}
      threadUsage={{
        thread: {
          responseCount: 1,
          inputTokens: 1000,
          outputTokens: 900,
          cacheHitRate: 0.5,
        },
        turns: params.has("unknown")
          ? {}
          : {
              "runtime-turn": {
                responseCount: 1,
                inputTokens: 1000,
                outputTokens: 900,
                cacheHitRate: 0.5,
              },
            },
        context: {
          inputTokens: 1000,
          inputTokenSource: "provider",
          contextWindow: 32000,
          ratio: 1000 / 32000,
        },
      }}
    />
  </main>,
);
