import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  BrowserThreadEvent,
  BrowserThreadRequest,
} from "../../src/main/capabilities/browser-thread-observation.js";
import { BrowserThreadPanel } from "../../src/renderer/src/browser-thread-panel.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

document.documentElement.dataset.appearance =
  new URLSearchParams(location.search).get("appearance") ?? "dark";
const subscriptions: Array<{
  request: BrowserThreadRequest;
  listener: (event: BrowserThreadEvent) => void;
  active: boolean;
}> = [];
let frames: Record<string, string> = {};
function publish(subscription: (typeof subscriptions)[number]) {
  const { request, listener } = subscription;
  const targets = [1, 2].map((index) => ({
    id: `${request.threadId}-${index}`,
    sessionId: "work",
    tabId: `tab-${index}`,
    title: `${request.threadId} page ${index}`,
    url: `https://${request.threadId}.example/${index}`,
    loading: false,
    mode: "snapshot" as const,
  }));
  listener({
    type: "targets",
    targets,
    selectedId: request.targetId ?? targets[0]!.id,
  });
  listener({
    type: "status",
    status: "idle",
    message: "Waiting for the Agent screenshot.",
  });
  if (request.frames && frames[request.threadId])
    listener({
      type: "snapshot",
      data: frames[request.threadId]!,
      mimeType: "image/png",
      capturedAt: new Date().toISOString(),
      width: 1280,
      height: 720,
    });
}
Object.defineProperty(window, "zenx", {
  value: {
    browserObservation: {
      subscribe(
        request: BrowserThreadRequest,
        listener: (event: BrowserThreadEvent) => void,
      ) {
        const subscription = { request, listener, active: true };
        subscriptions.push(subscription);
        publish(subscription);
        return () => {
          subscription.active = false;
        };
      },
    },
  },
});
Object.assign(window, {
  browserFixture: {
    subscriptions,
    setFrames(value: Record<string, string>) {
      frames = value;
      subscriptions.filter((item) => item.active).forEach(publish);
    },
  },
});
function Harness() {
  const [thread, setThread] = useState("Thread-A");
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateRows: "52px minmax(0,1fr)",
      }}
    >
      <header
        className="page-header"
        style={{ display: "flex", gap: 16, padding: "0 20px" }}
      >
        <strong>Browser thread panel verification</strong>
        <button
          onClick={() =>
            setThread(thread === "Thread-A" ? "Thread-B" : "Thread-A")
          }
        >
          Switch thread
        </button>
        <button
          id="thread-browser-toggle"
          onClick={() =>
            setOpened((value) => ({ ...value, [thread]: !value[thread] }))
          }
        >
          Toggle Browser
        </button>
        <span>{thread}</span>
      </header>
      <main className="workspace" style={{ gridColumn: 1 }}>
        <section className="agent-surface">
          <div
            style={{
              padding: 28,
              display: "flex",
              flexDirection: "column",
              gap: 24,
            }}
          >
            <h2>Check two independent browser pages</h2>
            <p>
              The Browser panel belongs to this thread. Keep a draft while
              changing pages or viewing the browser.
            </p>
            <textarea
              aria-label="Message draft"
              placeholder="Write a message…"
              style={{ marginTop: "auto", width: "100%", minHeight: 120 }}
              defaultValue="Draft stays here"
            />
          </div>
        </section>
        <BrowserThreadPanel
          key={thread}
          threadId={thread}
          title={thread}
          open={opened[thread]}
          onOpenChange={(open) =>
            setOpened((value) => ({ ...value, [thread]: open }))
          }
          providerRevision="fixture"
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
