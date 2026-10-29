/** Actual production Board/information components; synthetic current-state and effect ports only. */
import React, { useEffect, useState } from "react";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { useAppearance } from "../src/renderer/src/PluginProductPage.js";
import { WorkspaceFileDrafts } from "../src/renderer/src/workspace-file-drafts.js";
import {
  applySidebarPatch,
  emptySidebarState,
  sidebarTabId,
  type ThreadSidebarPatch,
  type ThreadSidebarState,
} from "../src/thread-sidebar-state.js";
import type { WorkspaceBrowserTab } from "../src/main/workspace-browser.js";
import { createRoot } from "react-dom/client";
import { PluginInformationHost } from "../src/renderer/src/plugin-information-host.js";
import { createPluginUiRegistry } from "../src/renderer/src/plugin-ui-host.js";
import { registerBoardUi } from "../src/renderer/src/board-ui.js";
import { boardManifest } from "../../../packages/zenx-board-plugin/src/manifest.js";
import type {
  BoardSnapshot,
  BoardEventResult,
} from "../../../packages/zenx-board-plugin/src/board.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { i18n } from "../src/renderer/src/i18n.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
void i18n.changeLanguage("en");
const registry = createPluginUiRegistry();
registerBoardUi(registry);
const custom = String.raw`<style>body{margin:0;font:13px system-ui;line-height:1.5}section{border:1px solid var(--plugin-border,#ddd);border-radius:8px;padding:13px}h3{margin:0 0 6px;font-size:13px}p{margin:4px 0 12px;opacity:.7}button{border:1px solid #bbb8;background:transparent;color:inherit;border-radius:5px;padding:7px 9px;font:inherit;margin-right:5px}small{display:block;margin-top:12px;opacity:.6}</style><section><h3>Custom interactive canvas</h3><p>Local interaction, script execution and model delivery are independent.</p><button id="local">Local count · 0</button><button id="chain">Check & share</button><button id="docs">Open docs</button><small id="result">No message sent</small></section><script>let count=0;addEventListener('zenx-plugin-ui:init',({detail:{sdk}})=>{document.getElementById('local').onclick=()=>{document.getElementById('local').textContent='Local count · '+(++count)};document.getElementById('docs').onclick=()=>sdk.interaction.run(async({commands})=>{await commands.execute('event',{eventId:'openDocs'});document.getElementById('result').textContent='Docs opened locally · no message sent';});sdk.commands.execute('event',{eventId:'sendCustom',values:{answer:'ONLOAD MUST NOT SEND'}}).then(()=>document.body.dataset.onload='allowed',()=>document.body.dataset.onload='blocked');document.getElementById('chain').onclick=async()=>{const button=document.getElementById('chain');button.disabled=true;document.getElementById('result').textContent='Checking locally…';try{await sdk.interaction.run(async({commands})=>{const result=await commands.execute('event',{eventId:'check'});if(result.error)throw new Error(result.error);await commands.execute('event',{eventId:'sendCustom',values:{answer:'Custom count '+count+'; script checked successfully.'}})});document.getElementById('result').textContent='Admitted after async check';}catch(error){document.getElementById('result').textContent=error.message;}finally{button.disabled=false;}}});</script>`;
const focusProbe = `<input id="focus-probe" autofocus value="Synthetic autofocus attempt"><p>On-load effect attempts must be rejected.</p><script>addEventListener('zenx-plugin-ui:init', ({detail:{sdk}}) => { document.getElementById('focus-probe').focus(); Promise.allSettled([sdk.commands.execute('draft',{note:'ONLOAD MUST NOT OVERWRITE'}),sdk.commands.execute('event',{eventId:'sendCustom',values:{answer:'ONLOAD MUST NOT SEND'}}),sdk.navigation.navigate('/synthetic-unwanted-navigation')]).then(results => { document.body.insertAdjacentHTML('beforeend','<p>Blocked attempts: '+results.filter(result=>result.status==='rejected').length+'/3</p>'); }); });</script>`;
let current: BoardSnapshot = {
  revision: 1,
  draftRevision: 0,
  pinned: false,
  values: {
    scope: "Focused release",
    note: "Keep this draft while I explore.",
  },
  document: {
    id: "release",
    title: "A calmer release",
    summary: "A small decision board, built for this conversation.",
    owner: { kind: "thread", threadId: "synthetic-thread" },
    blocks: [
      {
        id: "status",
        kind: "note",
        text: "The plan is ready. Choose what to ship; local checks do not wake the model.",
      },
      {
        id: "checks",
        kind: "metric",
        title: "Checks passing",
        value: "12 / 14",
        detail: "Two visual checks still need a look.",
      },
      { id: "ready", kind: "progress", title: "Readiness", value: 86 },
      {
        id: "scope",
        kind: "field",
        label: "Release scope",
        field: "scope",
        input: "select",
        options: ["Focused release", "Full release"],
      },
      {
        id: "note",
        kind: "field",
        label: "Your note",
        field: "note",
        input: "textarea",
      },
      {
        id: "existing-browser",
        kind: "action",
        label: "Return to existing Browser",
        event: "existingBrowser",
      },
      {
        id: "send",
        kind: "action",
        label: "Send my selection",
        event: "send",
        emphasis: true,
      },
    ],
    events: [
      {
        id: "existingBrowser",
        label: "Select exact Browser",
        actions: [
          {
            kind: "navigate",
            target: { kind: "browser", id: "fixture-existing" },
          },
        ],
      },
      {
        id: "openDocs",
        label: "Open documentation",
        actions: [
          {
            kind: "navigate",
            target: { kind: "url", url: "https://example.test/docs" },
          },
        ],
      },
      {
        id: "send",
        label: "Send selection",
        actions: [{ kind: "submit", text: "{{scope}} · {{note}}" }],
      },
      {
        id: "check",
        label: "Run a local check",
        actions: [{ kind: "script", command: "echo synthetic" }],
      },
      {
        id: "sendCustom",
        label: "Send custom result",
        actions: [{ kind: "submit", text: "{{answer}}" }],
      },
    ],
    html: custom,
  },
};
const calls: Array<Record<string, unknown>> = [];
let failNextAction = false;
const command = async (_plugin: string, _command: string, input?: unknown) => {
  const args = input as Record<string, unknown>;
  if (args.operation === "read") return structuredClone(current);
  if (args.operation === "draft") {
    if (args.expectedDraftRevision !== current.draftRevision)
      throw new Error("Synthetic draft conflict");
    current = {
      ...current,
      values: { ...current.values, ...(args.values as object) },
      draftRevision: current.draftRevision + 1,
    };
    return structuredClone(current);
  }
  if (args.operation === "event") {
    if (
      args.revision !== current.revision ||
      args.draftRevision !== current.draftRevision
    )
      throw new Error("Board changed");
    if (failNextAction) {
      failNextAction = false;
      window.dispatchEvent(new Event("fixture-change"));
      throw new Error("Synthetic temporary failure. Try the action again.");
    }
    const acceptedSnapshot = structuredClone(current);
    calls.push({ event: args.eventId, values: args.values });
    window.dispatchEvent(new Event("fixture-change"));
    if (args.eventId === "check")
      await new Promise((resolve) => setTimeout(resolve, 6200));
    if (args.eventId === "existingBrowser") {
      const tab = browserTabs.find((tab) => tab.id === "fixture-existing");
      if (!tab)
        throw new Error("Synthetic exact Browser is no longer available");
      editResource({
        open: true,
        tabs: resource.tabs.some(
          (item) => item.kind === "browser" && item.id === tab.id,
        )
          ? resource.tabs
          : [...resource.tabs, { kind: "browser", id: tab.id }],
        selectedTab: `browser:${tab.id}`,
      });
    }
    if (args.eventId === "openDocs") {
      const tabs = await browserCommand(
        "synthetic-thread",
        "new",
        undefined,
        "https://example.test/docs",
      );
      const tab = tabs.at(-1)!;
      editResource({ open: true, selectedTab: `browser:${tab.id}` });
    }
    const result: BoardEventResult = {
      snapshot: acceptedSnapshot,
      outcomes: [
        {
          kind:
            args.eventId === "check"
              ? "script"
              : args.eventId === "existingBrowser" ||
                  args.eventId === "openDocs"
                ? "navigate"
                : "submit",
          result: { status: "accepted", exitCode: 0 },
        },
      ],
      navigation: [],
    };
    return result;
  }
  throw new Error("Unsupported synthetic command");
};
const snapshot: ZenXPluginSnapshot = {
  plugins: [],
  bundles: boardManifest.ui.bundles.map((item) => ({
    ...item,
    key: `zenx-board:${item.id}`,
    pluginId: "zenx-board",
  })),
  surfaces: boardManifest.ui.surfaces.map((item) => ({
    ...item,
    key: `zenx-board:${item.id}`,
    pluginId: "zenx-board",
  })),
  information: boardManifest.contributions.information.map((item) => ({
    ...item,
    key: `zenx-board:${item.id}`,
    pluginId: "zenx-board",
  })),
  sidebar: [],
  pages: [],
  subroutes: [],
  settings: [],
  panels: [],
  commands: [],
  menus: [],
};
const threadId = "synthetic-thread";
let informationEnabled = true;
let resource: ThreadSidebarState = {
  ...emptySidebarState({ kind: "thread", id: threadId }),
  tabs: [{ kind: "browser" as const, id: "fixture-existing" }],
  selectedTab: "browser:fixture-existing",
};
const makeBrowserTab = (id: string, url: string): WorkspaceBrowserTab => ({
  id,
  threadId,
  url,
  title: id === "fixture-existing" ? "Release workspace" : "Documentation",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  sharedWithAgent: true,
  control: "human",
  agentActionsInFlight: 0,
  agentActionOutcomeUnknown: false,
  requiresFreshObservation: false,
});
let browserTabs: WorkspaceBrowserTab[] = [
  makeBrowserTab("fixture-existing", "https://example.test/release"),
];
const browserCalls: Array<Record<string, unknown>> = [];
const browserListeners = new Set<
  (value: { threadId: string; tabs: WorkspaceBrowserTab[] }) => void
>();
const changed = () => window.dispatchEvent(new Event("fixture-change"));
function editResource(patch: ThreadSidebarPatch) {
  resource = applySidebarPatch(resource, patch);
  changed();
}
async function browserCommand(
  owner: string,
  operation: string,
  id?: string,
  url?: string,
) {
  if (owner !== threadId) throw new Error("Synthetic resource owner mismatch");
  browserCalls.push({ operation, id, url });
  if (operation === "new" || operation === "materialize") {
    const tab = makeBrowserTab(
      id ?? `fixture-docs-${browserTabs.length}`,
      url ?? "about:blank",
    );
    browserTabs = [...browserTabs, tab];
    editResource({ tabs: [...resource.tabs, { kind: "browser", id: tab.id }] });
  } else if (operation === "close") {
    browserTabs = browserTabs.filter((tab) => tab.id !== id);
  } else if (operation !== "list") {
    browserTabs = browserTabs.map((tab) =>
      tab.id === id
        ? {
            ...tab,
            ...(operation === "navigate" && url ? { url } : {}),
            ...(operation === "take-control"
              ? { control: "human" as const }
              : {}),
            ...(operation === "return-control"
              ? { control: "agent" as const }
              : {}),
          }
        : tab,
    );
  }
  for (const listener of browserListeners)
    listener({ threadId, tabs: structuredClone(browserTabs) });
  return structuredClone(browserTabs);
}
Object.assign(window, {
  zenx: {
    platform: "darwin",
    workspaceBrowser: {
      command: browserCommand,
      mount: async () => undefined,
      onChanged: (
        listener: (value: {
          threadId: string;
          tabs: WorkspaceBrowserTab[];
        }) => void,
      ) => {
        browserListeners.add(listener);
        return () => browserListeners.delete(listener);
      },
      onFocusAddress: () => () => {},
      onPresentation: () => () => {},
      presentationContext: async () => undefined,
      declinePresentation: async () => undefined,
    },
    workspaceFiles: {
      applications: async () => ({ platform: "darwin", applications: {} }),
      read: async () => {
        throw new Error("No file resource in this synthetic fixture");
      },
      list: async () => ({ path: ".", entries: [], truncated: false }),
    },
    plugins: { executeCommand: command, readHandle: async () => null },
  },
});
// Even the production external-open button remains a no-network fixture effect.
window.open = ((url: unknown) => {
  browserCalls.push({ operation: "external-open", url });
  return null;
}) as typeof window.open;
document.documentElement.dataset.appearance = "light";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "darwin";
const drafts = new WorkspaceFileDrafts();
const setTheme = (theme: "light" | "dark") => {
  document.documentElement.dataset.appearance = theme;
};
const toggleResource = (open = !resource.open) => editResource({ open });
const setInformation = (enabled: boolean) => {
  informationEnabled = enabled;
  changed();
};
const focusProbeUpdate = () => {
  current = {
    ...current,
    revision: current.revision + 1,
    document: { ...current.document, html: focusProbe },
  };
  document.getElementById("composer-draft")?.focus();
  changed();
};
function Preview() {
  const theme = useAppearance();
  const [, refresh] = useState(0);
  const [resourceWidth, setResourceWidth] = useState(0);
  useEffect(() => {
    const listener = () => refresh((value) => value + 1);
    window.addEventListener("fixture-change", listener);
    return () => window.removeEventListener("fixture-change", listener);
  }, []);
  return (
    <div
      className="app-shell board-fixture"
      style={
        {
          "--workspace-panel-width": `${resourceWidth}px`,
          "--sidebar-width": "220px",
        } as React.CSSProperties
      }
    >
      <style>{String.raw`
        .board-fixture > .fixture-sidebar { grid-column:1; grid-row:1 / -1; min-width:0; padding:20px; overflow:auto; border-right:1px solid var(--color-border-subtle); font-size:13px; }
        .fixture-sidebar h1 { margin:0 0 28px; font-size:15px; letter-spacing:2px; }
        .fixture-sidebar button { display:block; width:100%; margin:6px 0; padding:7px 8px; font:inherit; text-align:left; color:var(--color-text-primary); background:var(--color-surface-raised); border:1px solid var(--color-border-subtle); border-radius:6px; }
        .fixture-sidebar .fixture-controls { margin-top:34px; }
        .fixture-sidebar small { display:block; margin-top:20px; color:var(--color-text-muted); font-size:10px; line-height:1.6; }
        .board-fixture .workspace-browser-viewport::after { content:"Synthetic Browser viewport\A Production Browser toolbar and resource panel\A No native page, network requests or private data"; display:grid; place-content:center; text-align:center; white-space:pre-line; line-height:1.9; height:100%; padding:32px; box-sizing:border-box; color:var(--color-text-muted); font:13px/1.9 system-ui; background:var(--color-surface-raised); }
      `}</style>
      <aside className="fixture-sidebar">
        <h1>ZENX</h1>
        <p>＋ New conversation</p>
        <p
          style={{
            color: "var(--color-text-muted)",
            fontSize: 11,
            marginTop: 28,
          }}
        >
          PROJECTS
        </p>
        <strong>Product workspace</strong>
        <p
          style={{
            padding: "9px 10px",
            background: "var(--color-surface-hover)",
            borderRadius: 7,
          }}
        >
          A calmer release
        </p>
        <p style={{ padding: "9px 10px", opacity: 0.6 }}>Design exploration</p>
        <section
          className="fixture-controls"
          aria-label="Synthetic preview controls"
        >
          <strong>Preview controls</strong>
          <button
            data-fixture="theme"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            Switch theme · {theme}
          </button>
          <button
            data-fixture="fail-next"
            onClick={() => {
              failNextAction = true;
              changed();
            }}
          >
            {failNextAction ? "Next action will fail" : "Fail next action"}
          </button>
          <button data-fixture="resource" onClick={() => toggleResource()}>
            Toggle resource panel
          </button>
          <button
            data-fixture="information"
            onClick={() => setInformation(!informationEnabled)}
          >
            {informationEnabled ? "Remove information" : "Add information"}
          </button>
          <button data-fixture="focus-probe" onClick={focusProbeUpdate}>
            Agent update + focus probe
          </button>
        </section>
        <small>
          Synthetic component demonstration. Actual Board, AuxiliaryPanel and
          WorkspaceBrowserPanel; native Browser viewport is simulated. No
          private data, model or network calls.
        </small>
      </aside>
      <main className="workspace">
        <section
          className="agent-surface"
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "50px max(24px,7%) 24px",
            boxSizing: "border-box",
          }}
        >
          <div style={{ maxWidth: 660, alignSelf: "center", width: "100%" }}>
            <p style={{ textAlign: "right", fontSize: 14 }}>
              Can you help me plan the release?
            </p>
            <div style={{ marginTop: 45, fontSize: 14, lineHeight: 1.8 }}>
              <strong>Start with the smallest useful version.</strong>
              <p>
                I've put the choices and readiness checks in the information
                board. Your notes stay separate from this conversation's draft.
              </p>
              <p style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                The board can run a local check without sending a message, or
                assemble exactly what you want to share.
              </p>
            </div>
          </div>
          <p
            aria-live="polite"
            data-fixture="receipts"
            style={{
              fontSize: 11,
              color: "var(--color-text-muted)",
              marginTop: "auto",
            }}
          >
            Preview receipts · Local checks:{" "}
            {calls.filter((call) => call.event === "check").length} · Agent
            messages:{" "}
            {
              calls.filter(
                (call) => call.event === "send" || call.event === "sendCustom",
              ).length
            }{" "}
            · Navigations:{" "}
            {
              calls.filter(
                (call) =>
                  call.event === "existingBrowser" ||
                  call.event === "openDocs" ||
                  call.navigate,
              ).length
            }
          </p>
          <textarea
            id="composer-draft"
            defaultValue="My unsent chat draft stays here."
            aria-label="Chat draft"
            style={{
              marginTop: "auto",
              minHeight: 90,
              padding: 15,
              borderRadius: 12,
              border: "1px solid var(--color-border-subtle)",
              background: "var(--color-surface-main)",
              color: "var(--color-text-primary)",
              font: "inherit",
            }}
          />
        </section>
        <AuxiliaryPanel
          title="Release workspace"
          threadId={threadId}
          presentationState={resource}
          open={resource.open}
          onOpenChange={(open) => editResource({ open })}
          snapshot={null}
          fileDrafts={drafts}
          selectedTab={resource.selectedTab ?? ""}
          openedTabs={resource.tabs.map(sidebarTabId)}
          onSelectTab={(selectedTab) => editResource({ selectedTab })}
          onTabsChange={(ids) =>
            editResource({
              tabs: ids
                .map((id) =>
                  resource.tabs.find((tab) => sidebarTabId(tab) === id)!,
                )
                .filter(Boolean),
            })
          }
          onRemoveTab={(id) => {
            const tabs = resource.tabs.filter(
              (tab) => sidebarTabId(tab) !== id,
            );
            editResource({
              tabs,
              selectedTab: tabs[0] ? sidebarTabId(tabs[0]) : null,
            });
          }}
          onFullscreenChange={(fullscreen) => editResource({ fullscreen })}
          onWidthChange={setResourceWidth}
        />
        <PluginInformationHost
          snapshot={{
            ...snapshot,
            information: informationEnabled ? snapshot.information : [],
          }}
          registry={registry}
          resourcePanelWidth={resourceWidth}
          owner={{ kind: "thread", threadId }}
          theme={theme}
          navigate={(route) => {
            calls.push({ navigate: route });
            changed();
          }}
          executeCommand={command}
          readHandle={async () => null}
        />
      </main>
    </div>
  );
}
Object.assign(window, {
  __boardFixture: {
    calls,
    browserCalls,
    read: () => structuredClone(current),
    resourceState: () => structuredClone(resource),
    browserTabs: () => structuredClone(browserTabs),
    setTheme,
    toggleResource,
    setInformation,
    setFullscreen: (fullscreen: boolean) => editResource({ fullscreen }),
    failNext: () => {
      failNextAction = true;
      changed();
    },
    focusProbe: focusProbeUpdate,
    update: () => {
      current = {
        ...current,
        revision: current.revision + 1,
        document: { ...current.document, title: "Release plan · updated" },
      };
      changed();
    },
    setHtml: (html: string) => {
      current = {
        ...current,
        revision: current.revision + 1,
        document: { ...current.document, html },
      };
      changed();
    },
  },
});
createRoot(document.getElementById("root")!).render(<Preview />);
