import "./dom-primitives.js";
import { waitForFocus } from "./wait-for-focus.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PluginInformationHost } from "../src/renderer/src/plugin-information-host.js";
import { createPluginUiRegistry } from "../src/renderer/src/plugin-ui-host.js";
import { useAppearance } from "../src/renderer/src/PluginProductPage.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

const snapshot: ZenXPluginSnapshot = {
  plugins: [],
  sidebar: [],
  pages: [],
  subroutes: [],
  settings: [],
  panels: [],
  commands: [],
  menus: [],
  bundles: [
    {
      key: "fixture:ui",
      pluginId: "fixture",
      id: "ui",
      apiVersion: 1,
      kind: "trusted",
      entry: "fixture",
    },
  ],
  surfaces: [
    {
      key: "fixture:info",
      pluginId: "fixture",
      id: "info",
      bundleId: "ui",
      exportName: "info",
    },
  ],
  information: [
    {
      key: "fixture:info",
      pluginId: "fixture",
      id: "info",
      title: "Fixture",
      surfaceId: "info",
    },
  ],
};

test("Board uses one headerless toggle, measures Browser coexistence and retires hidden owners", async () => {
  const dom = new JSDOM(
    '<div class="app-shell"><header class="window-titlebar"><div class="window-titlebar-session"></div></header><main class="workspace"><aside class="auxiliary-panel" data-open="true"><header class="auxiliary-heading"></header></aside><div id="root"></div></main></div>',
    { url: "https://zenx.local" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const observed = new Set<Element>();
  const callbacks = new Set<(entries: ResizeObserverEntry[]) => void>();
  const prior = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(readonly callback: (entries: ResizeObserverEntry[]) => void) {
      callbacks.add(callback);
    }
    observe(target: Element) {
      observed.add(target);
    }
    unobserve() {}
    disconnect() {
      callbacks.delete(this.callback);
    }
  } as unknown as typeof ResizeObserver;
  let titlebarBottom = 88;
  let headerBottom = 104;
  let workspaceWidth = 1000;
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  const heading = document.querySelector<HTMLElement>(".auxiliary-heading")!;
  const titlebar = document.querySelector<HTMLElement>(
    ".window-titlebar-session",
  )!;
  titlebar.getBoundingClientRect = () =>
    ({ bottom: titlebarBottom }) as DOMRect;
  workspace.getBoundingClientRect = () =>
    ({ top: 44, width: workspaceWidth }) as DOMRect;
  heading.getBoundingClientRect = () => ({ bottom: headerBottom }) as DOMRect;
  const registry = createPluginUiRegistry();
  registry.registerTrusted("fixture", {
    info: ({ sdk }) =>
      React.createElement(
        "p",
        { "data-theme-receipt": sdk.theme },
        "Fixture content",
      ),
  });
  let current: ZenXPluginSnapshot = { ...snapshot, information: [] };
  let threadId = "fixture";
  let revealSignal = 0;
  localStorage.setItem("zenx.information.pin.thread:fixture", "fixture:info");
  function Harness() {
    const theme = useAppearance();
    return React.createElement(PluginInformationHost, {
      snapshot: current,
      registry,
      resourcePanelWidth: 480,
      owner: { kind: "thread", threadId },
      revealSignal,
      theme,
      navigate() {},
      executeCommand: async () => null,
      readHandle: async () => null,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const click = async (selector: string) => {
    const target = document.querySelector<HTMLButtonElement>(selector)!;
    const closing = target.getAttribute("aria-expanded") === "true";
    await act(async () => target.click());
    if (closing) await act(async () => waitForFocus(target));
  };
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      document.querySelector(".information-toolbar") === null,
      "no contributions means no Board toggle",
    );
    current = snapshot;
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      observed.has(workspace),
      "late contribution attaches workspace measurement",
    );
    assert.ok(
      observed.has(heading),
      "resource heading is measured, not an assumed 44px row",
    );
    await click(".information-toolbar button");
    assert.match(
      document.querySelector<HTMLElement>(".information-popover")!.style
        .maxHeight,
      /120px/,
      "popup height is bounded below the measured header, not shifted over its controls",
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      ".information-toolbar button",
    )!;
    assert.ok(
      observed.has(trigger),
      "trigger resizing updates the cached popover geometry",
    );
    let triggerBottom = 40;
    trigger.getBoundingClientRect = () =>
      ({ bottom: triggerBottom }) as DOMRect;
    assert.equal(trigger.getAttribute("aria-pressed"), "true");
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.ok(
      document.querySelector(".information-header") === null,
      "the duplicate Board header is absent",
    );
    assert.ok(
      document.querySelector(".information-rail") === null,
      "the obsolete pinned rail is absent",
    );
    assert.ok(
      document.querySelector("[data-information-pin]") === null,
      "no duplicate pin control remains",
    );
    assert.equal(
      document
        .querySelector(".information-popover")
        ?.getAttribute("aria-label"),
      "Fixture",
    );
    headerBottom = 160;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.match(
      document.querySelector<HTMLElement>(".information-popover")!.style
        .maxHeight,
      /176px/,
      "wrapped/fullscreen header remains clear",
    );
    triggerBottom = 220;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.match(
      document.querySelector<HTMLElement>(".information-popover")!.style
        .maxHeight,
      /236px/,
      "popover clears the live trigger when it extends below the header",
    );
    triggerBottom = 40;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    for (const theme of ["dark", "light", "dark"]) {
      await act(async () => {
        document.documentElement.dataset.appearance = theme;
        await Promise.resolve();
      });
      assert.equal(
        document
          .querySelector("[data-theme-receipt]")
          ?.getAttribute("data-theme-receipt"),
        theme,
      );
    }
    for (let repeat = 0; repeat < 3; repeat++) {
      await click(".information-toolbar button");
      assert.ok(
        document.querySelector(".information-popover") === null,
        "closing hides the Board popup",
      );
      assert.equal(trigger.getAttribute("aria-pressed"), "false");
      assert.equal(trigger.getAttribute("aria-expanded"), "false");
      await click(".information-toolbar button");
      assert.ok(
        Boolean(document.querySelector(".information-popover")),
        "the same toggle reopens the Board popup",
      );
      assert.equal(trigger.getAttribute("aria-pressed"), "true");
    }
    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    await act(async () => waitForFocus(trigger));
    assert.ok(
      document.querySelector(".information-popover") === null,
      "closing hides the Board popup",
    );
    assert.ok(
      document.activeElement === trigger,
      "Escape returns focus to the sole toggle",
    );
    // Resizing the real conversation allocation switches presentation without
    // changing the owner or inventing a persistent pin mode.
    workspaceWidth = 1600;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    await click(".information-toolbar button");
    assert.ok(
      document.querySelector(".information-dock"),
      "wide chat reserves a docked card",
    );
    const panel = document.querySelector<HTMLElement>(".auxiliary-panel")!;
    panel.dataset.open = "false";
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.equal(
      document.querySelector<HTMLElement>(".information-dock")!.style.top,
      "56px",
      "ordinary dock clears the visible Windows/Linux conversation title row",
    );
    assert.ok(observed.has(titlebar), "title row resizing is observed");
    titlebarBottom = 132;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.equal(
      document.querySelector<HTMLElement>(".information-dock")!.style.top,
      "100px",
    );
    titlebarBottom = 88;
    panel.dataset.open = "true";
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.equal(
      trigger.getAttribute("aria-pressed"),
      "false",
      "opening the workspace hides information once",
    );
    workspaceWidth = 1000;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    await click(".information-toolbar button");
    assert.ok(
      document.querySelector(".information-popover"),
      "manual reopen beside workspace uses an overlay",
    );
    panel.dataset.expanded = "true";
    panel.dataset.primaryActive = "true";
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.ok(
      document.querySelector(".information-dock"),
      "maximized main-conversation tab uses the whole available width",
    );
    panel.dataset.primaryActive = "false";
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.equal(
      trigger.getAttribute("aria-pressed"),
      "false",
      "switching from main conversation to a resource closes its dock",
    );
    panel.dataset.primaryActive = "true";
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    await click(".information-toolbar button");
    workspaceWidth = 700;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.ok(
      document.querySelector(".information-popover"),
      "narrow maximized main conversation remains usable",
    );
    await click(".information-toolbar button");
    await click(".information-toolbar button");
    threadId = "another-owner";
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      document.querySelector(".information-popover") === null,
      "owner changes close presentation without auto-opening the next owner",
    );
    threadId = "fixture";
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      document.querySelector(".information-popover"),
      "returning to an owner restores the visibility it was left with",
    );
    threadId = "another-owner";
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      document.querySelector(".information-popover") === null,
      "an owner that was never opened still starts closed",
    );
    revealSignal = 1;
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      document.querySelector(".information-popover"),
      "a foreground attention signal reveals the current owner's surface",
    );
    await click(".information-toolbar button");
    current = { ...snapshot, information: [] };
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      document.querySelector(".information-toolbar") === null,
      "no contributions means no Board toggle",
    );
    current = snapshot;
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      document.querySelector(".information-popover") === null,
      "re-admission never reopens a revoked surface",
    );
    assert.equal(
      localStorage.getItem("zenx.information.pin.thread:fixture"),
      "fixture:info",
      "obsolete pin preferences are neither restored nor rewritten",
    );
  } finally {
    await act(async () => root.unmount());
    globalThis.ResizeObserver = prior;
    dom.window.close();
  }
});

test("information reserves its slot, uses neutral pressed state and keeps primary hover contrast", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const app = await readFile(
    new URL("../src/renderer/src/App.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.workspace:has\(> \.information-toolbar\)[\s\S]*?\.auxiliary-close-button\s*\{\s*margin-inline-start: 44px;/,
  );
  assert.match(
    css,
    /\.board-action\.primary:hover:not\(:disabled\)\s*\{[^}]*background: var\(--color-text-secondary\);[^}]*color: var\(--color-surface-main\);/,
  );
  assert.match(
    css,
    /\.information-toolbar > \.icon-button\[aria-pressed="true"\],\s*\.auxiliary-heading > \.auxiliary-close-button\s*\{\s*color: var\(--color-text-primary\);\s*background: var\(--color-surface-active\);\s*\}/,
  );
  assert.doesNotMatch(css, /\.information-(?:header|rail)/);
  assert.match(app, /const appearance = useAppearance\(\)/);
  assert.match(app, /theme=\{appearance\}/);
  assert.doesNotMatch(app, /document\.documentElement\.dataset\.theme/);
});

test("native-only information remembers Thread and Room visibility across remounts, reveals once, and keeps focus", async () => {
  const dom = new JSDOM(
    '<button id="outside">Composer</button><main class="workspace"><div id="root"></div></main>',
    { url: "https://zenx.local" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const outside = document.getElementById("outside")!;
  const render = (
    owner:
      { kind: "thread"; threadId: string } | { kind: "room"; roomId: string },
    signal = 0,
  ) =>
    act(async () =>
      root.render(
        React.createElement(PluginInformationHost, {
          key: JSON.stringify(owner),
          owner,
          snapshot: { ...snapshot, information: [] },
          registry: createPluginUiRegistry(),
          theme: "light",
          managedBoard: true,
          contextContent: React.createElement("button", {}, "Native question"),
          revealSignal: signal,
          navigate() {},
          executeCommand: async () => null,
          readHandle: async () => null,
        }),
      ),
    );
  const expanded = () =>
    document
      .querySelector(".information-toolbar button")
      ?.getAttribute("aria-expanded");
  const toggle = () =>
    act(async () =>
      document
        .querySelector<HTMLButtonElement>(".information-toolbar button")!
        .click(),
    );
  try {
    await render({ kind: "thread", threadId: "memory-thread" });
    assert.equal(expanded(), "false");
    outside.focus();
    await render({ kind: "thread", threadId: "memory-thread" }, 1);
    assert.equal(
      expanded(),
      "true",
      "attention opens native content even without plugin contributions",
    );
    assert.ok(
      document.activeElement === outside,
      "automatic reveal never takes focus",
    );
    await render({ kind: "room", roomId: "memory-room" });
    assert.equal(expanded(), "false", "Room does not inherit Thread state");
    await toggle();
    await render({ kind: "thread", threadId: "memory-thread" }, 1);
    assert.equal(
      expanded(),
      "true",
      "Thread visibility survives keyed remount",
    );
    await toggle();
    await render({ kind: "room", roomId: "memory-room" });
    assert.equal(expanded(), "true", "Room retains its independent visibility");
    await render({ kind: "thread", threadId: "memory-thread" }, 1);
    assert.equal(
      expanded(),
      "false",
      "old attention does not undo explicit dismissal",
    );
    outside.focus();
    await render({ kind: "thread", threadId: "memory-thread" }, 2);
    assert.equal(expanded(), "true", "a later question can reveal again");
    assert.ok(
      document.activeElement === outside,
      "later attention also keeps focus",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Chinese information lineage consistently names child conversations", async () => {
  const { zhCN } = await import("../src/renderer/src/i18n/panels.js");
  assert.equal(zhCN.informationLineage, "子对话");
  assert.equal(zhCN.subagentConversations, "子对话");
  assert.equal(zhCN.subagents, "子对话");
  assert.equal(zhCN.noSubagentsYet, "尚无子对话。");
});
