/** Production AuxiliaryPanel with synthetic current-state events only.
 * No browser, model, account, native input or history API is called.
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuxiliaryPanel } from "../../src/renderer/src/auxiliary-panel.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { WorkspaceBrowserTab } from "../../src/main/workspace-browser.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "./workspace-browser-tab-activity-visual.css";

Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
void i18n.changeLanguage(params.get("lang") ?? "en");
const initialPages = (threadId: string): WorkspaceBrowserTab[] =>
  ["Reference", "Draft", "Manual page"].map((title, index) => ({
    id: String(index + 1),
    threadId,
    title,
    url: "https://example.test/synthetic-same-url",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sharedWithAgent: true,
    control: index === 2 ? "human" : "agent",
    agentActionsInFlight: 0,
    agentInspectionsInFlight: 0,
    agentActionOutcomeUnknown: false,
    requiresFreshObservation: false,
  }));
let owner = "synthetic-owner-a";
let pages = initialPages(owner);
type Snapshot = { threadId: string; tabs: WorkspaceBrowserTab[] };
const listeners = new Set<(snapshot: Snapshot) => void>();
let mounts = 0;
let lists = 0;
let redraw: (() => void) | undefined;
function publish() {
  for (const listener of listeners) listener({ threadId: owner, tabs: pages });
  redraw?.();
}
function update(
  id: string,
  patch: (page: WorkspaceBrowserTab) => Partial<WorkspaceBrowserTab>,
) {
  pages = pages.map((page) =>
    page.id === id ? { ...page, ...patch(page) } : page,
  );
  publish();
}
Object.assign(window, {
  zenx: {
    plugins: {},
    workspaceBrowser: {
      async command(threadId: string, command: string, id?: string) {
        if (command === "list") lists++;
        else if (command === "close")
          pages = pages.filter((page) => page.id !== id);
        else if (command === "take-control" || command === "return-control")
          update(id!, () => ({
            control: command === "take-control" ? "human" : "agent",
          }));
        else
          throw new Error(
            "Synthetic fixture does not navigate or create real pages",
          );
        return pages.filter((page) => page.threadId === threadId);
      },
      onChanged(listener: (snapshot: Snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onFocusAddress: () => () => undefined,
      async mount() {
        mounts++;
        redraw?.();
      },
    },
  },
});

function Preview() {
  const [threadId, setThreadId] = useState(owner);
  const [selectedTab, onSelectTab] = useState("custom:notes");
  const [open, onOpenChange] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [, refresh] = useState(0);
  redraw = () => refresh((revision) => revision + 1);
  return (
    <main className="builtin-tab-activity-fixture">
      <aside aria-label="Synthetic fixture controls">
        <strong>
          Synthetic state · production workspace tabs · no Agent or browser
          calls
        </strong>
        <div className="builtin-tab-activity-fixture-controls">
          <button
            onClick={() =>
              update("1", (page) => ({
                agentActionsInFlight: page.agentActionsInFlight + 1,
              }))
            }
          >
            Start Reference action
          </button>
          <button
            onClick={() =>
              update("1", (page) => ({
                agentInspectionsInFlight:
                  (page.agentInspectionsInFlight ?? 0) + 1,
              }))
            }
          >
            Start Reference inspection
          </button>
          <button
            onClick={() =>
              update("2", (page) => ({
                agentInspectionsInFlight:
                  (page.agentInspectionsInFlight ?? 0) + 1,
              }))
            }
          >
            Start Draft inspection
          </button>
          <button
            onClick={() =>
              update("1", (page) => ({
                agentActionsInFlight: Math.max(
                  0,
                  page.agentActionsInFlight - 1,
                ),
              }))
            }
          >
            Settle one Reference action
          </button>
          <button onClick={() => update("1", () => ({ control: "human" }))}>
            Human takes Reference control
          </button>
          <button
            onClick={() =>
              update("3", () => ({ control: "human", loading: true }))
            }
          >
            Human loads Manual page
          </button>
          <button
            onClick={() => {
              pages = pages.map((page) => ({
                ...page,
                agentActionsInFlight: 0,
                agentInspectionsInFlight: 0,
                agentActionOutcomeUnknown: true,
              }));
              publish();
            }}
          >
            Settle all · outcome unknown
          </button>
          <button
            onClick={() => {
              for (const listener of listeners)
                listener({
                  threadId: "retired-owner",
                  tabs: initialPages("retired-owner").map((page) => ({
                    ...page,
                    agentActionsInFlight: 1,
                  })),
                });
            }}
          >
            Emit late other-owner activity
          </button>
          <button
            onClick={() => {
              owner =
                owner === "synthetic-owner-a"
                  ? "synthetic-owner-b"
                  : "synthetic-owner-a";
              pages = initialPages(owner);
              setThreadId(owner);
              onSelectTab("custom:notes");
            }}
          >
            Switch owner
          </button>
          <button onClick={() => onOpenChange((value) => !value)}>
            {open ? "Close workspace" : "Open workspace"}
          </button>
          <button
            onClick={() => setNarrow((value) => !value)}
            aria-pressed={narrow}
          >
            Narrow panel
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
        </div>
        <output>
          Owner: {threadId} · selected: {selectedTab} · workspace:{" "}
          {open ? "open" : "closed"} · synthetic mounts: {mounts} · list reads:{" "}
          {lists} · Agent runs: 0
        </output>
        <output>
          {pages
            .map(
              (page) =>
                `${page.title}: ${page.agentActionsInFlight} action / ${page.agentInspectionsInFlight ?? 0} inspection`,
            )
            .join(" · ")}
        </output>
      </aside>
      <label className="builtin-tab-activity-fixture-composer">
        Focus stays here during background updates{" "}
        <input
          aria-label="Synthetic draft"
          placeholder="Type a draft, then inspect the background tab glyphs"
        />
      </label>
      <div className="builtin-tab-activity-fixture-panel" data-narrow={narrow}>
        <AuxiliaryPanel
          threadId={threadId}
          title="Synthetic workspace"
          snapshot={null}
          open={open}
          onOpenChange={onOpenChange}
          selectedTab={selectedTab}
          onSelectTab={onSelectTab}
          customTabs={[
            {
              id: "notes",
              title: "Notes",
              icon: "file",
              render: () => (
                <article className="builtin-tab-activity-fixture-notes">
                  <h2>Keep reading here</h2>
                  <p>
                    Start an Agent action on Reference or an inspection on Draft
                    using the controls above. Only that exact tab’s icon
                    changes; this Notes tab stays selected.
                  </p>
                  <p>
                    Repeat Start Reference action, then settle one: activity
                    remains until every action and inspection settles. Human
                    loading and a settled unknown outcome do not light an Agent
                    icon.
                  </p>
                  <p>
                    All content is synthetic. Selecting a Browser tab shows the
                    production toolbar, but no real native page is mounted in
                    this browser fixture.
                  </p>
                </article>
              ),
            },
          ]}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
