import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { ThreadSidebarState } from "../src/thread-sidebar-state.js";
import { emptySidebarState } from "../src/thread-sidebar-state.js";
import type { WorkspaceBrowserTab } from "../src/main/workspace-browser.js";

const page = (
  id: string,
  patch: Partial<WorkspaceBrowserTab> = {},
): WorkspaceBrowserTab => ({
  id,
  threadId: "owner-a",
  title: `Page ${id}`,
  // Same URL must never merge tab activity.
  url: "https://example.test/shared-url",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  sharedWithAgent: true,
  control: "agent",
  agentActionsInFlight: 0,
  agentInspectionsInFlight: 0,
  agentActionOutcomeUnknown: false,
  requiresFreshObservation: false,
  ...patch,
});
type Snapshot = { threadId: string; tabs: WorkspaceBrowserTab[] };

async function fixture(options: { deferredList?: boolean } = {}) {
  const dom = new JSDOM('<input id="composer"><div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  await i18n.changeLanguage("en");
  let receive!: (snapshot: Snapshot) => void;
  const retired: (typeof receive)[] = [];
  const lists: {
    threadId: string;
    resolve(tabs: WorkspaceBrowserTab[]): void;
  }[] = [];
  const commands: string[] = [];
  const mounts: { tabId?: string }[] = [];
  const selection: string[] = [];
  const opened: boolean[] = [];
  const api = {
    onChanged: (listener: typeof receive) => {
      receive = listener;
      return () => {
        retired.push(listener);
      };
    },
    onFocusAddress: () => () => undefined,
    mount: async (request: { tabId?: string }) => {
      mounts.push(request);
    },
    command: async (threadId: string, command: string) => {
      commands.push(command);
      assert.equal(
        command,
        "list",
        "activity never dispatches browser commands",
      );
      if (options.deferredList) {
        return await new Promise<WorkspaceBrowserTab[]>((resolve) => {
          lists.push({ threadId, resolve });
        });
      }
      return [page("1", { threadId }), page("2", { threadId })];
    },
  };
  (dom.window as any).zenx = { workspaceBrowser: api, plugins: {} };
  function Harness({
    threadId,
    open,
    state,
  }: {
    threadId: string;
    open: boolean;
    state?: ThreadSidebarState;
  }) {
    const [selectedTab, setSelected] = useState("custom:notes");
    return React.createElement(AuxiliaryPanel, {
      threadId,
      title: "Synthetic task",
      open,
      onOpenChange: (value) => opened.push(value),
      snapshot: null,
      selectedTab: state?.selectedTab ?? selectedTab,
      presentationState: state,
      onReplaceTab: () => true,
      onSelectTab: (value) => {
        selection.push(value);
        setSelected(value);
      },
      customTabs: [
        {
          id: "notes",
          title: "Notes",
          icon: "file",
          render: () => React.createElement("p", null, "Keep reading here"),
        },
      ],
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const render = async (
    threadId = "owner-a",
    open = true,
    state?: ThreadSidebarState,
  ) => {
    await act(async () =>
      root.render(React.createElement(Harness, { threadId, open, state })),
    );
  };
  const emit = async (tabs: WorkspaceBrowserTab[], threadId = "owner-a") => {
    await act(async () => receive({ threadId, tabs }));
  };
  const tab = (id: string) => document.getElementById(`aux-tab-browser:${id}`)!;
  const activeIds = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.workspace-content-tab[data-browser-tab="true"][data-agent-active="true"]',
      ),
    ].map((element) => element.dataset.tabId);
  await render();
  return {
    dom,
    render,
    emit,
    tab,
    activeIds,
    retired,
    lists,
    commands,
    mounts,
    selection,
    opened,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      delete (globalThis as any).ResizeObserver;
    },
  };
}

test("builtin tab glyph reflects concurrent exact-target Agent calls, not human browsing or permission", async () => {
  const f = await fixture();
  try {
    const composer = document.getElementById("composer")!;
    composer.focus();
    const baseline = {
      selection: f.selection.length,
      mounts: f.mounts.length,
      commands: f.commands.length,
    };
    assert.deepEqual(f.activeIds(), []);
    await f.emit([
      page("1", { agentInspectionsInFlight: 1 }),
      page("2", { agentActionsInFlight: 2, agentInspectionsInFlight: 1 }),
    ]);
    assert.deepEqual(f.activeIds(), ["browser:1", "browser:2"]);
    assert.equal(
      f.tab("1").getAttribute("aria-label"),
      "Page 1 — Agent is inspecting this page",
    );
    assert.equal(
      f.tab("2").getAttribute("aria-label"),
      "Page 2 — Agent is operating this page",
    );
    assert.match(f.tab("2").title, /Agent is operating this page/);
    assert.ok(
      f
        .tab("2")
        .querySelector('.workspace-browser-tab-icon[aria-hidden="true"]'),
    );
    assert.equal(f.tab("2").getAttribute("aria-selected"), "false");

    // An older operation settling does not erase the remaining operations.
    await f.emit([
      page("1"),
      page("2", {
        agentActionsInFlight: 1,
        agentInspectionsInFlight: 1,
        control: "human",
      }),
    ]);
    assert.deepEqual(f.activeIds(), ["browser:2"]);
    assert.equal(
      f.tab("2").getAttribute("aria-label"),
      `Page 2 — ${i18n.t("panels:browserActionFinishing")}`,
    );
    await f.emit([
      page("1"),
      page("2", {
        agentInspectionsInFlight: 1,
        control: "human",
        agentActionOutcomeUnknown: true,
      }),
    ]);
    assert.deepEqual(f.activeIds(), ["browser:2"]);
    assert.match(f.tab("2").getAttribute("aria-label")!, /Agent is inspecting/);
    await f.emit([
      page("1", { loading: true }),
      page("2", {
        loading: true,
        control: "human",
        agentActionOutcomeUnknown: true,
        requiresFreshObservation: true,
      }),
    ]);
    assert.deepEqual(
      f.activeIds(),
      [],
      "settled unknown outcome and human page loading are not active Agent work",
    );
    assert.equal(f.tab("2").getAttribute("aria-label"), null);
    assert.equal(f.tab("2").title, "https://example.test/shared-url");
    assert.ok(
      document.activeElement === composer,
      "background activity retains the current keyboard focus",
    );
    assert.equal(
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      "Notes",
    );
    assert.equal(f.selection.length, baseline.selection);
    assert.equal(
      f.mounts.length,
      baseline.mounts,
      "background activity never mounts a native page",
    );
    assert.equal(
      f.commands.length,
      baseline.commands,
      "no polling or commands are needed for indicator changes",
    );
    assert.deepEqual(f.opened, []);

    // Manual selection remains available while an Agent operation is pending.
    await f.emit([page("1"), page("2", { agentActionsInFlight: 1 })]);
    await act(async () => f.tab("2").click());
    assert.equal(f.tab("2").getAttribute("aria-selected"), "true");
    assert.equal(f.mounts.at(-1)?.tabId, "2");
    assert.deepEqual(f.activeIds(), ["browser:2"]);
    await f.emit([page("1"), page("2")]);
    assert.deepEqual(f.activeIds(), []);
    assert.equal(f.tab("2").getAttribute("aria-selected"), "true");
  } finally {
    await f.close();
  }
});

test("latest snapshots beat late list replies and previous owners cannot light current tabs", async () => {
  const f = await fixture({ deferredList: true });
  try {
    await f.emit([
      page("1", { agentActionsInFlight: 1 }),
      page("foreign", { threadId: "owner-b", agentActionsInFlight: 1 }),
    ]);
    assert.deepEqual(f.activeIds(), ["browser:1"]);
    assert.ok(
      f.tab("foreign") === null,
      "mixed-owner snapshots cannot borrow a same workspace target",
    );
    await f.emit([page("1")]);
    await act(async () =>
      f.lists[0]!.resolve([page("1", { agentActionsInFlight: 5 })]),
    );
    assert.deepEqual(
      f.activeIds(),
      [],
      "a stale list result cannot resurrect settled activity",
    );

    await f.render("owner-b");
    await f.emit(
      [page("1", { threadId: "owner-b", agentInspectionsInFlight: 1 })],
      "owner-b",
    );
    assert.deepEqual(f.activeIds(), ["browser:1"]);
    await act(async () =>
      f.retired[0]!({ threadId: "owner-a", tabs: [page("1")] }),
    );
    await f.emit([page("1")], "owner-a");
    assert.deepEqual(
      f.activeIds(),
      ["browser:1"],
      "old listener and mismatched current event cannot settle another owner's same-ID tab",
    );
    await f.emit([], "owner-b");
    await act(async () =>
      f.lists[1]!.resolve([
        page("1", { threadId: "owner-b", agentActionsInFlight: 1 }),
      ]),
    );
    assert.ok(
      f.tab("1") === null,
      "late list reply cannot resurrect a removed tab",
    );
    assert.deepEqual(f.activeIds(), []);
    assert.deepEqual(f.opened, []);
  } finally {
    await f.close();
  }
});

test("closed workspace stays closed and localized glyph status is purely presentational", async () => {
  const f = await fixture();
  try {
    await f.render("owner-a", false);
    const composer = document.getElementById("composer")!;
    composer.focus();
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    await f.emit([page("1", { agentInspectionsInFlight: 1 }), page("2")]);
    assert.deepEqual(f.activeIds(), ["browser:1"]);
    assert.equal(
      f.tab("1").getAttribute("aria-label"),
      `Page 1 — ${i18n.t("panels:browserAgentInspecting")}`,
    );
    assert.equal(
      document.querySelector(".auxiliary-panel")?.getAttribute("data-open"),
      "false",
    );
    assert.deepEqual(f.opened, []);
    assert.deepEqual(f.mounts, []);
    assert.ok(
      document.activeElement === composer,
      "background activity retains the current keyboard focus",
    );
  } finally {
    await f.close();
    await i18n.changeLanguage("en");
  }
});

test("builtin glyph uses neutral tokens and a static reduced-motion/forced-colors fallback", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const glyph = styles.slice(
    styles.indexOf("/* Builtin activity"),
    styles.indexOf("/* Reserve the outcome"),
  );
  assert.match(glyph, /var\(--color-text-primary\)/);
  assert.doesNotMatch(glyph, /var\(--accent\)|var\(--text-accent\)|Highlight/);
  assert.match(
    glyph,
    /@media \(prefers-reduced-motion: reduce\), \(forced-colors: active\)[\s\S]*?animation: none;/,
  );
  assert.match(glyph, /color: ButtonText/);
  assert.match(glyph, /background: ButtonText/);
  assert.match(
    styles,
    /\.workspace-content-tab\[data-agent-active="true"\]:not\(\[data-browser-tab\]\)/,
  );
});

test("late human command replies cannot overwrite a newer Agent activity snapshot", async () => {
  const f = await fixture();
  try {
    const api = (window as any).zenx.workspaceBrowser;
    const command = api.command;
    let settleClose!: (tabs: WorkspaceBrowserTab[]) => void;
    api.command = async (threadId: string, action: string) => {
      if (action === "close")
        return await new Promise<WorkspaceBrowserTab[]>((resolve) => {
          settleClose = resolve;
        });
      return await command(threadId, action);
    };
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close tab Page 1"]')!
        .click(),
    );
    await f.emit([page("2", { agentActionsInFlight: 1 })]);
    assert.deepEqual(f.activeIds(), ["browser:2"]);
    await act(async () => settleClose([page("2")]));
    assert.deepEqual(
      f.activeIds(),
      ["browser:2"],
      "the older close reply must not hide a subsequent dispatch",
    );
    await f.emit([page("2")]);
    assert.deepEqual(f.activeIds(), []);
  } finally {
    await f.close();
  }
});

test("late new and materialize replies cannot resurrect already-settled Agent activity", async () => {
  for (const kind of ["new", "materialize"] as const) {
    const f = await fixture();
    try {
      const api = (window as any).zenx.workspaceBrowser;
      const command = api.command;
      let settle!: (tabs: WorkspaceBrowserTab[]) => void;
      api.command = async (threadId: string, action: string) => {
        if (action === kind)
          return await new Promise<WorkspaceBrowserTab[]>((resolve) => {
            settle = resolve;
          });
        return await command(threadId, action);
      };
      await f.emit([page("1", { agentActionsInFlight: 1 }), page("2")]);
      if (kind === "new") {
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              '[aria-label="New workspace tab"]',
            )!
            .click(),
        );
        const browser = [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".workspace-tab-types button",
          ),
        ].find(
          (button) =>
            button.querySelector("strong")?.textContent === "ZenX browser",
        )!;
        await act(async () => browser.click());
      } else {
        await f.render("owner-a", true, {
          ...emptySidebarState("owner-a"),
          open: true,
          tabs: [
            {
              kind: "webpage",
              id: "manual-intent",
              url: "https://example.test/manual",
            },
          ],
          selectedTab: "webpage:manual-intent",
        });
      }
      await f.emit([page("1"), page("2"), page("3")]);
      assert.deepEqual(f.activeIds(), []);
      await act(async () =>
        settle([page("1", { agentActionsInFlight: 1 }), page("2"), page("3")]),
      );
      assert.deepEqual(
        f.activeIds(),
        [],
        `${kind} reply cannot resurrect an older unsettled count`,
      );
    } finally {
      await f.close();
    }
  }
});
