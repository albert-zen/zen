/** Production read-only panels with synthetic catalogs/frames only. No native providers or Agent API. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserThreadPanel } from "../../src/renderer/src/browser-thread-panel.js";
import { ComputerThreadPanel } from "../../src/renderer/src/computer-thread-panel.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type {
  BrowserThreadEvent,
  BrowserThreadRequest,
  BrowserThreadTarget,
} from "../../src/main/capabilities/browser-thread-observation.js";
import type {
  ComputerThreadEvent,
  ComputerThreadRequest,
  ComputerThreadTarget,
} from "../../src/main/capabilities/computer-thread-observation.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "./manual-observation-visual.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
await i18n.changeLanguage(params.get("lang") ?? "en");
const browserTargets: BrowserThreadTarget[] = ["a", "b"].map((id) => ({
  id: `synthetic-page-${id}`,
  tabId: `page-${id}`,
  sessionId: "synthetic-session",
  title: `Synthetic page ${id.toUpperCase()}`,
  url: `https://example.test/${id}`,
  loading: false,
  mode: "live",
  backendId: "connected",
  canOpenExternally: false,
}));
const computerTargets: ComputerThreadTarget[] = ["a", "b"].map((id, index) => ({
  id: `synthetic-window-${id}`,
  invocationId: `synthetic-call-${id}`,
  mode: "live",
  target: {
    pid: index + 101,
    windowTitle: `Synthetic window ${id.toUpperCase()}`,
  },
}));
let unavailable = false;
let activity = false;
let serial = 0;
const browserListeners = new Map<
  (event: BrowserThreadEvent) => void,
  BrowserThreadRequest
>();
const computerListeners = new Map<
  (event: ComputerThreadEvent) => void,
  ComputerThreadRequest
>();
function pixels(title: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 600;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#edf1f4";
  context.fillRect(0, 0, 960, 600);
  context.fillStyle = "#253647";
  context.font = "32px sans-serif";
  context.fillText(title, 48, 84);
  context.font = "20px sans-serif";
  context.fillText("Synthetic read-only observation", 48, 132);
  context.fillText("No private page, native window or model call", 48, 172);
  context.fillStyle = "#ffffff";
  context.fillRect(48, 224, 864, 280);
  context.fillStyle = "#526678";
  context.fillText(`Sample frame ${++serial}`, 80, 272);
  return canvas.toDataURL("image/jpeg").split(",")[1]!;
}
function publishBrowser(
  receive: (event: BrowserThreadEvent) => void,
  request: BrowserThreadRequest,
) {
  const targets = (unavailable ? browserTargets.slice(1) : browserTargets).map(
    (target) => ({
      ...target,
      activityCount: activity && target.id.endsWith("-b") ? 1 : 0,
    }),
  );
  const selected = targets.find((target) => target.id === request.targetId);
  receive({ type: "targets", targets, selectedId: selected?.id });
  receive({
    type: "status",
    status: selected ? "live" : "idle",
    message: selected ? "" : "No browser page is selected for this thread.",
  });
  if (selected && request.frames)
    receive({
      type: "frame",
      frame: {
        sequence: serial + 1,
        mimeType: "image/jpeg",
        data: pixels(selected.title),
        width: 960,
        height: 600,
      },
    });
}
function publishComputer(
  receive: (event: ComputerThreadEvent) => void,
  request: ComputerThreadRequest,
) {
  const targets = (
    unavailable ? computerTargets.slice(1) : computerTargets
  ).map((target) => ({
    ...target,
    ...(activity && target.id.endsWith("-b")
      ? { activity: { kind: "background-window" as const, count: 1 } }
      : {}),
  }));
  const selected = targets.find((target) => target.id === request.targetId);
  receive({ type: "targets", targets, selectedId: selected?.id });
  receive({
    type: "status",
    status: selected ? "live" : "idle",
    message: selected ? "" : "No Computer window is selected for this thread.",
  });
  if (selected && request.frames)
    receive({
      type: "frame",
      frame: {
        sequence: serial + 1,
        mimeType: "image/jpeg",
        data: pixels(selected.target.windowTitle!),
        width: 960,
        height: 600,
        capturedAt: new Date().toISOString(),
      },
    });
}
function publish() {
  for (const [listener, request] of browserListeners)
    publishBrowser(listener, request);
  for (const [listener, request] of computerListeners)
    publishComputer(listener, request);
}
Object.assign(window, {
  zenx: {
    browserObservation: {
      subscribe(
        request: BrowserThreadRequest,
        receive: (event: BrowserThreadEvent) => void,
      ) {
        browserListeners.set(receive, request);
        publishBrowser(receive, request);
        return () => browserListeners.delete(receive);
      },
      openExternal: async () => {
        throw Error("Synthetic fixture cannot open external pages");
      },
    },
    computerObservation: {
      subscribe(
        request: ComputerThreadRequest,
        receive: (event: ComputerThreadEvent) => void,
      ) {
        computerListeners.set(receive, request);
        publishComputer(receive, request);
        return () => computerListeners.delete(receive);
      },
    },
  },
});
function Preview() {
  const [open, setOpen] = useState(true);
  const [revision, setRevision] = useState(0);
  return (
    <main className="manual-observation-fixture">
      <header>
        <strong>SYNTHETIC · Human-owned observation targets</strong>
        <p>
          Production Browser and Computer panels. Choose page A and window A,
          then emit B activity or retire A. No real accounts, OS input, native
          providers or model calls.
        </p>
        <div className="manual-observation-controls">
          <button
            onClick={() => {
              activity = !activity;
              publish();
              setRevision(revision + 1);
            }}
          >
            Toggle synthetic activity on B
          </button>
          <button
            onClick={() => {
              unavailable = !unavailable;
              publish();
              setRevision(revision + 1);
            }}
          >
            {unavailable
              ? "Restore synthetic A targets"
              : "Retire synthetic A targets"}
          </button>
          <button onClick={() => publish()}>
            Update selected synthetic frames
          </button>
          <button onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"} observations
          </button>
        </div>
        <p aria-live="polite">
          B activity: {activity ? "active" : "idle"} · A targets:{" "}
          {unavailable ? "unavailable" : "available"}
        </p>
      </header>
      <div className="manual-observation-panels">
        <section>
          <h2>External browser · read-only</h2>
          <BrowserThreadPanel
            threadId="synthetic-manual-browser"
            title="Synthetic external browser"
            embedded
            open={open}
            onOpenChange={setOpen}
            providerRevision="synthetic-provider"
          />
        </section>
        <section>
          <h2>Computer · read-only</h2>
          <ComputerThreadPanel
            threadId="synthetic-manual-computer"
            active={open}
          />
        </section>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
