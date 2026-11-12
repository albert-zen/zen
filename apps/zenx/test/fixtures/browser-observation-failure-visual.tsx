/** Production BrowserThreadPanel; synthetic local events only, no browser or Agent API. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserThreadPanel } from "../../src/renderer/src/browser-thread-panel.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type {
  BrowserThreadEvent,
  BrowserThreadTarget,
} from "../../src/main/capabilities/browser-thread-observation.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "zh-CN");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
const target: BrowserThreadTarget = {
  id: "connected:synthetic-target",
  sessionId: "synthetic-session",
  tabId: "synthetic-tab",
  title: "Synthetic reference page",
  url: "https://example.test/reference",
  loading: false,
  mode: "live",
  backendId: "connected",
  canOpenExternally: true,
};
const failure: BrowserThreadEvent = {
  type: "status",
  status: "failed",
  message: "The live browser view could not be connected.",
  details: JSON.stringify(
    {
      message: "Synthetic observation transport unavailable",
      code: "E_SYNTHETIC_OBSERVER",
      cause: {
        message: '<img src=x onerror="alert(1)"> (literal untrusted text)',
      },
      diagnostic: "diagnostic_".repeat(70),
    },
    null,
    2,
  ),
};
type Scenario = "before" | "stream" | "empty" | "missing" | "snapshot";
let scenario: Scenario = "before";
const listeners = new Set<(event: BrowserThreadEvent) => void>();
let subscriptions = 0;
let updateCounts: (() => void) | undefined;
const emit = (event: BrowserThreadEvent) => {
  for (const listener of listeners) listener(event);
};
function syntheticFrame(): BrowserThreadEvent {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 620;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ecf1f5";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#273747";
  ctx.font = "30px sans-serif";
  ctx.fillText("Synthetic page preview", 60, 110);
  ctx.font = "22px sans-serif";
  ctx.fillText("Observation recovered. No Agent was run.", 60, 160);
  ctx.fillText("No real browser, account or page content.", 60, 205);
  return {
    type: "frame",
    frame: {
      sequence: 1,
      mimeType: "image/jpeg",
      data: canvas.toDataURL("image/jpeg").split(",")[1]!,
      width: canvas.width,
      height: canvas.height,
    },
  };
}
function sendScenario(receive: (event: BrowserThreadEvent) => void) {
  if (scenario === "before") {
    receive(failure);
  } else if (scenario === "empty" || scenario === "missing") {
    receive({ type: "targets", targets: [] });
  } else {
    receive({ type: "targets", targets: [target], selectedId: target.id });
    if (scenario === "stream") receive(failure);
    else {
      receive({
        type: "targets",
        targets: [{ ...target, mode: "snapshot" }],
        selectedId: target.id,
      });
      receive({
        type: "status",
        status: "idle",
        message:
          "Waiting for the Agent to inspect this page. This provider shows snapshots.",
      });
    }
  }
}
Object.assign(window, {
  zenx: {
    browserObservation: {
      subscribe(
        _request: unknown,
        receive: (event: BrowserThreadEvent) => void,
      ) {
        listeners.add(receive);
        subscriptions++;
        updateCounts?.();
        queueMicrotask(() => {
          if (listeners.has(receive)) sendScenario(receive);
        });
        return () => listeners.delete(receive);
      },
      async openExternal() {
        throw new Error("Synthetic fixture never opens an external browser");
      },
    },
  },
});
function Preview() {
  const [revision, setRevision] = useState(1);
  const [current, setCurrent] = useState<Scenario | "recovered">("before");
  const [narrow, setNarrow] = useState(false);
  const [, redraw] = useState(0);
  updateCounts = () => redraw((n) => n + 1);
  const choose = (next: Scenario) => {
    scenario = next;
    setCurrent(next);
    setRevision((n) => n + 1);
  };
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        minHeight: 0,
      }}
    >
      <aside
        aria-label="Synthetic fixture controls"
        style={{
          padding: 12,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          flexShrink: 0,
          fontSize: 12,
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <strong>Synthetic controls · production BrowserThreadPanel</strong>
        <button onClick={() => choose("before")}>Fail before targets</button>
        <button onClick={() => choose("stream")}>Fail known page stream</button>
        <button onClick={() => choose("empty")}>Known empty catalog</button>
        <button onClick={() => choose("missing")}>Missing fixed target</button>
        <button onClick={() => choose("snapshot")}>Known snapshot mode</button>
        <button
          onClick={() => {
            emit({ type: "targets", targets: [target], selectedId: target.id });
            emit({
              type: "status",
              status: "live",
              message: "Synthetic preview connected.",
            });
            emit(syntheticFrame());
            setCurrent("recovered");
          }}
        >
          Recover observation
        </button>
        <button
          onClick={() => {
            document.documentElement.dataset.appearance = "light";
          }}
        >
          Light theme
        </button>
        <button
          onClick={() => {
            document.documentElement.dataset.appearance = "dark";
          }}
        >
          Dark theme
        </button>
        <button
          onClick={() => {
            void i18n.changeLanguage("en");
          }}
        >
          English
        </button>
        <button
          onClick={() => {
            void i18n.changeLanguage("zh-CN");
          }}
        >
          中文
        </button>
        <button
          onClick={() => setNarrow((value) => !value)}
          aria-pressed={narrow}
        >
          Narrow panel
        </button>
        <output>
          Scenario: {current} · subscriptions: {subscriptions} · Agent runs: 0
        </output>
      </aside>
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          flex: 1,
          minHeight: 0,
          padding: 16,
        }}
      >
        <section
          className="auxiliary-panel"
          style={{
            // The real workspace positions this shell absolutely. The fixture
            // keeps it in flow so its visible controls remain above the pane.
            position: "relative",
            inset: "auto",
            display: "flex",
            flexDirection: "column",
            flex: "0 1 auto",
            width: narrow ? 360 : 680,
            maxWidth: "100%",
            minWidth: 0,
            border: "1px solid var(--color-border-subtle)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <header
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid var(--color-border-subtle)",
              fontSize: 13,
            }}
          >
            Synthetic browser observation · no real page content
          </header>
          <BrowserThreadPanel
            threadId="synthetic-observation-thread"
            title="Synthetic reference"
            open
            embedded
            fixedTargetId={scenario === "empty" ? undefined : target.id}
            providerRevision={revision}
            onOpenChange={() => {}}
          />
        </section>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
