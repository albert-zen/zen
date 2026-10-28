/** Actual production Board/information components; synthetic current-state and effect ports only. */
import React, { useEffect, useState } from "react";
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
const custom = String.raw`<style>body{margin:0;font:13px system-ui;line-height:1.5}section{border:1px solid var(--plugin-border,#ddd);border-radius:8px;padding:13px}h3{margin:0 0 6px;font-size:13px}p{margin:4px 0 12px;opacity:.7}button{border:1px solid #bbb8;background:transparent;color:inherit;border-radius:5px;padding:7px 9px;font:inherit;margin-right:5px}small{display:block;margin-top:12px;opacity:.6}</style><section><h3>Custom interactive canvas</h3><p>Local interaction, script execution and model delivery are independent.</p><button id="local">Local count · 0</button><button id="chain">Check & share</button><small id="result">No message sent</small></section><script>let count=0;addEventListener('zenx-plugin-ui:init',({detail:{sdk}})=>{document.getElementById('local').onclick=()=>{document.getElementById('local').textContent='Local count · '+(++count)};sdk.commands.execute('event',{eventId:'sendCustom',values:{answer:'ONLOAD MUST NOT SEND'}}).then(()=>document.body.dataset.onload='allowed',()=>document.body.dataset.onload='blocked');document.getElementById('chain').onclick=async()=>{const button=document.getElementById('chain');button.disabled=true;document.getElementById('result').textContent='Checking locally…';try{await sdk.interaction.run(async({commands})=>{const result=await commands.execute('event',{eventId:'check'});if(result.error)throw new Error(result.error);await commands.execute('event',{eventId:'sendCustom',values:{answer:'Custom count '+count+'; script checked successfully.'}})});document.getElementById('result').textContent='Admitted after async check';}catch(error){document.getElementById('result').textContent=error.message;}finally{button.disabled=false;}}});</script>`;
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
        id: "send",
        kind: "action",
        label: "Send my selection",
        event: "send",
        emphasis: true,
      },
    ],
    events: [
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
    const result: BoardEventResult = {
      snapshot: acceptedSnapshot,
      outcomes: [
        {
          kind: args.eventId === "check" ? "script" : "submit",
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
function Preview() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [, refresh] = useState(0);
  const [resourceOpen, setResourceOpen] = useState(false);
  useEffect(() => {
    const listener = () => refresh((value) => value + 1);
    window.addEventListener("fixture-change", listener);
    return () => window.removeEventListener("fixture-change", listener);
  }, []);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.platform = "darwin";
  return (
    <div
      className="app-shell"
      style={
        {
          "--workspace-panel-width": resourceOpen ? "480px" : "0px",
          gridTemplateColumns: "220px 1fr",
        } as React.CSSProperties
      }
    >
      <header
        className="window-titlebar"
        style={{ gridColumn: "1 / -1", padding: "0 20px" }}
      >
        <strong style={{ fontSize: 13, letterSpacing: 2 }}>ZENX</strong>
        <span style={{ marginLeft: 170, fontSize: 12 }}>Release workspace</span>
        <button
          style={{ marginLeft: "auto", marginRight: 80 }}
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          Switch theme
        </button>
        <button
          onClick={() => {
            failNextAction = true;
            refresh((value) => value + 1);
          }}
        >
          {failNextAction ? "Next action will fail" : "Fail next action"}
        </button>
        <button onClick={() => setResourceOpen((value) => !value)}>
          Toggle resource panel
        </button>
        <button
          onClick={() => {
            current = {
              ...current,
              revision: current.revision + 1,
              document: { ...current.document, html: focusProbe },
            };
            document.getElementById("composer-draft")?.focus();
          }}
        >
          Agent update + focus probe
        </button>
      </header>
      <aside
        style={{
          gridRow: 2,
          padding: 20,
          borderRight: "1px solid var(--color-border-subtle)",
          fontSize: 13,
        }}
      >
        <p style={{ margin: "0 0 26px" }}>＋ New conversation</p>
        <p style={{ color: "var(--color-text-muted)", fontSize: 11 }}>
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
        <p
          style={{
            position: "absolute",
            bottom: 20,
            color: "var(--color-text-muted)",
            fontSize: 10,
            maxWidth: 175,
          }}
        >
          Synthetic demonstration. No private data, model or network calls.
        </p>
      </aside>
      <main className="workspace">
        <section
          className="agent-surface"
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "50px max(32px,9%) 24px",
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
            }
            {" · Navigations: "}
            {calls.filter((call) => call.navigate).length}
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
        {resourceOpen ? (
          <aside
            className="auxiliary-panel"
            data-open="true"
            style={{ width: 480 }}
          >
            <header className="information-header">
              Browser · synthetic resource
            </header>
            <p style={{ padding: 20 }}>
              Existing resource stays open while the Board adapts to available
              workspace width.
            </p>
          </aside>
        ) : null}
        <PluginInformationHost
          snapshot={snapshot}
          registry={registry}
          resourcePanelWidth={resourceOpen ? 480 : 0}
          owner={{ kind: "thread", threadId: "synthetic-thread" }}
          theme={theme}
          navigate={(route) => {
            calls.push({ navigate: route });
            window.dispatchEvent(new Event("fixture-change"));
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
    read: () => structuredClone(current),
    update: () => {
      current = {
        ...current,
        revision: current.revision + 1,
        document: { ...current.document, title: "Release plan · updated" },
      };
    },
    setHtml: (html: string) => {
      current = {
        ...current,
        revision: current.revision + 1,
        document: { ...current.document, html },
      };
    },
  },
});
createRoot(document.getElementById("root")!).render(<Preview />);
