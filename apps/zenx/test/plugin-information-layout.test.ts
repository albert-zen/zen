import "./dom-primitives.js";
import { waitForFocus } from "./wait-for-focus.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
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

test("Board uses one toggle, measures Browser coexistence and retires hidden owners", async () => {
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
  let resourcePanelWidth = 480;
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  const heading = document.querySelector<HTMLElement>(".auxiliary-heading")!;
  const titlebar = document.querySelector<HTMLElement>(
    ".window-titlebar-session",
  )!;
  titlebar.getBoundingClientRect = () =>
    ({ bottom: titlebarBottom }) as DOMRect;
  workspace.getBoundingClientRect = () =>
    ({
      top: 44,
      left: 200,
      right: 200 + workspaceWidth,
      width: workspaceWidth,
    }) as DOMRect;
  heading.getBoundingClientRect = () => ({ bottom: headerBottom }) as DOMRect;
  const registry = createPluginUiRegistry();
  registry.registerTrusted("fixture", {
    info: ({ sdk }) =>
      React.createElement(
        "p",
        { "data-theme-receipt": sdk.theme },
        "Fixture content",
        React.createElement("input", {
          "aria-label": "Fixture draft",
          defaultValue: "initial",
        }),
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
      resourcePanelWidth,
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
    await click(".information-toolbar button");
    await act(async () => waitForFocus(trigger));
    assert.equal(document.querySelector(".information-popover"), null);
    assert.equal(document.activeElement, trigger);
    await click(".information-toolbar button");
    assert.match(document.body.textContent!, /Fixture content/);
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
    // Resizing the real conversation allocation keeps one presentation without
    // changing the owner or inventing a persistent pin mode.
    workspaceWidth = 1600;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    await click(".information-toolbar button");
    assert.ok(
      document.querySelector(".information-popover"),
      "wide chat uses the same floating card",
    );
    const wideCard = document.querySelector<HTMLElement>(
      ".information-popover",
    )!;
    const draft = wideCard.querySelector<HTMLInputElement>("input")!;
    draft.value = "unsent fixture";
    const anchorElement = document.querySelector<HTMLElement>(
      '.information-toolbar span[style*="position: fixed"]',
    )!;
    const oldAnchorLeft = anchorElement.style.left;
    await act(async () => {
      resourcePanelWidth = 520;
      flushSync(() => root.render(React.createElement(Harness)));
      wideCard.dispatchEvent(
        new dom.window.MouseEvent("pointerover", { bubbles: true }),
      );
    });
    assert.equal(wideCard.style.width, "340px");
    assert.notEqual(
      anchorElement.style.left,
      oldAnchorLeft,
      "same-width card follows the actual divider anchor",
    );
    assert.equal(document.querySelector(".information-popover"), wideCard);
    assert.equal(wideCard.querySelector("input"), draft);
    assert.equal(
      draft.value,
      "unsent fixture",
      "resize/hover retains the existing provider draft",
    );
    await click(".information-toolbar button");
    assert.equal(document.querySelector(".information-popover"), null);
    assert.equal(document.activeElement, trigger);
    await click(".information-toolbar button");
    assert.match(document.body.textContent!, /Fixture content/);
    assert.equal(
      document.querySelector(".information-dismiss-toolbar button"),
      null,
      "no duplicate close action",
    );
    const panel = document.querySelector<HTMLElement>(".auxiliary-panel")!;
    await act(async () => {
      panel.dataset.open = "false";
      resourcePanelWidth = 0;
      flushSync(() => root.render(React.createElement(Harness)));
    });
    assert.match(
      document.querySelector<HTMLElement>(".information-popover")!.style
        .maxHeight,
      /104px/,
      "floating card clears the visible Windows/Linux conversation title row",
    );
    assert.ok(observed.has(titlebar), "title row resizing is observed");
    titlebarBottom = 132;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.match(
      document.querySelector<HTMLElement>(".information-popover")!.style
        .maxHeight,
      /148px/,
    );
    titlebarBottom = 88;
    await act(async () => {
      panel.dataset.open = "true";
      resourcePanelWidth = 480;
      // AuxiliaryPanel can report its new width in the same commit that opens
      // it. Rebind measurement before MutationObserver gets a delivery turn.
      flushSync(() => root.render(React.createElement(Harness)));
    });
    assert.equal(
      trigger.getAttribute("aria-pressed"),
      "false",
      "opening the workspace hides information even when its width synchronously rebinds measurement",
    );
    workspaceWidth = 780;
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    await click(".information-toolbar button");
    assert.ok(
      document.querySelector(".information-popover"),
      "manual reopen beside workspace uses an overlay",
    );
    const sameCard = document.querySelector(".information-popover");
    const sameProvider = document.querySelector("[data-theme-receipt]");
    assert.equal(
      (sameCard as HTMLElement).style.width,
      "276px",
      "card cannot cross the conversation divider",
    );
    await act(async () => {
      resourcePanelWidth = 520;
      flushSync(() => root.render(React.createElement(Harness)));
    });
    assert.equal(
      trigger.getAttribute("aria-pressed"),
      "true",
      "later width changes do not close manually reopened information",
    );
    assert.equal(
      document.querySelector(".information-popover"),
      sameCard,
      "resize does not replace the floating shell",
    );
    assert.equal(
      document.querySelector("[data-theme-receipt]"),
      sameProvider,
      "resize does not remount provider drafts",
    );
    assert.equal((sameCard as HTMLElement).style.width, "236px");
    assert.notEqual(
      document.body.style.pointerEvents,
      "none",
      "nonmodal card does not disable the workspace",
    );
    let resourceClicks = 0;
    heading.addEventListener("click", () => {
      resourceClicks += 1;
    });
    await act(async () => {
      heading.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", { bubbles: true }),
      );
      heading.click();
    });
    assert.equal(
      resourceClicks,
      1,
      "outside resource action is not consumed by dismissal",
    );
    assert.equal(
      trigger.getAttribute("aria-expanded"),
      "false",
      "outside click dismisses the card",
    );
    await click(".information-toolbar button");
    panel.dataset.expanded = "true";
    panel.dataset.primaryActive = "true";
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.ok(
      document.querySelector(".information-popover"),
      "maximized main-conversation tab uses the same floating card",
    );
    await act(async () => {
      panel.dataset.primaryActive = "false";
      resourcePanelWidth = 1000;
      flushSync(() => root.render(React.createElement(Harness)));
    });
    assert.equal(
      trigger.getAttribute("aria-pressed"),
      "false",
      "switching from main conversation to a resource closes its floating card",
    );
    assert.equal(
      document.querySelector<HTMLElement>(".information-toolbar")!.hidden,
      true,
      "a maximized resource does not expose the main conversation's information entry",
    );
    panel.dataset.primaryActive = "true";
    await act(async () => {
      for (const callback of callbacks) callback([]);
    });
    assert.equal(
      document.querySelector<HTMLElement>(".information-toolbar")!.hidden,
      false,
      "returning to the maximized main tab restores its entry",
    );
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
    const sidebar = document.createElement("aside");
    sidebar.className = "sidebar";
    const ownerButton = document.createElement("button");
    sidebar.append(ownerButton);
    document.querySelector(".app-shell")!.prepend(sidebar);
    await act(async () => {
      ownerButton.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", { bubbles: true }),
      );
      ownerButton.focus();
    });
    assert.ok(
      document.querySelector(".information-popover"),
      "navigation input leaves the outgoing owner's recorded visibility open",
    );
    await act(async () => {
      threadId = "another-owner";
      flushSync(() => root.render(React.createElement(Harness)));
    });
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
  const auxiliary = await readFile(
    new URL("../src/renderer/src/auxiliary-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    auxiliary,
    /<header className="auxiliary-heading">[\s\S]*?<span className="auxiliary-information-slot" aria-hidden="true" \/>[\s\S]*?className="icon-button auxiliary-close-button"[\s\S]*?<\/header>/,
    "the no-drag rectangle must be inside the later native drag heading, not an earlier overlapping sibling",
  );
  assert.match(
    css,
    /\.workspace:has\(> \.information-toolbar\)\s*> \.auxiliary-panel\[data-open="true"\]\[data-expanded="true"\]\[data-primary-active="true"\][\s\S]*?> \.auxiliary-information-slot\s*\{\s*display: block;/,
  );
  assert.match(
    css,
    /\.workspace:has\(> \.auxiliary-panel\[data-open="true"\]:not\(\[data-expanded="true"\]\)\)\s*> \.information-toolbar\s*\{\s*right: calc\(var\(--workspace-panel-width, 0px\) \+ 8px\);/,
    "split entry follows the conversation/resource divider rather than resource controls",
  );
  assert.match(
    css,
    /\.auxiliary-information-slot\s*\{[^}]*flex: 0 0 40px;[^}]*height: 36px;[^}]*-webkit-app-region: no-drag;/,
  );
  assert.match(
    css,
    /\.board-action\.primary:hover:not\(:disabled\)\s*\{[^}]*background: var\(--color-text-secondary\);[^}]*color: var\(--color-surface-main\);/,
  );
  assert.match(
    css,
    /\.information-toolbar > \.icon-button\[aria-pressed="true"\],\s*\.auxiliary-heading > \.auxiliary-close-button\s*\{\s*color: var\(--color-text-primary\);\s*background: var\(--color-surface-active\);\s*\}/,
  );
  assert.doesNotMatch(css, /\.information-(?:header|rail|dock)/);
  assert.doesNotMatch(css, /information-dock-reserved-width/);
  const host = await readFile(
    new URL("../src/renderer/src/plugin-information-host.tsx", import.meta.url),
    "utf8",
  );
  assert.match(host, /modal=\{false\}/);
  assert.doesNotMatch(host, /layout\.dock|>= 920/);
  assert.match(host, /bounds\.right - resourceWidth - 12/);
  assert.match(host, /Math\.min\(340, bounds\.width - resourceWidth - 24\)/);
  const thread = await readFile(
    new URL("../src/renderer/src/ThreadView.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(thread, /informationConversationGutter|information-dock/);
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

test("information follows late and replaced workspace panels without a width change", async () => {
  const dom = new JSDOM(
    '<main class="workspace"><div id="root"></div></main>',
    { url: "https://zenx.local/" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  workspace.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 1400, width: 1400 }) as DOMRect;
  const observed = new Set<Element>();
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    owned = new Set<Element>();
    observe(element: Element) {
      this.owned.add(element);
      observed.add(element);
    }
    unobserve(element: Element) {
      this.owned.delete(element);
      observed.delete(element);
    }
    disconnect() {
      for (const element of this.owned) observed.delete(element);
      this.owned.clear();
    }
  } as unknown as typeof ResizeObserver;
  const root = createRoot(document.getElementById("root")!);
  const toolbar = () =>
    document.querySelector<HTMLElement>(".information-toolbar")!;
  const button = () => toolbar().querySelector<HTMLButtonElement>("button")!;
  const toggle = () => act(async () => button().click());
  const panel = () => {
    const element = document.createElement("aside");
    element.className = "auxiliary-panel";
    element.dataset.open = "true";
    element.dataset.expanded = "true";
    element.dataset.primaryActive = "false";
    element.innerHTML = '<header class="auxiliary-heading"></header>';
    return element;
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(PluginInformationHost, {
          snapshot: { ...snapshot, information: [] },
          registry: createPluginUiRegistry(),
          owner: { kind: "thread", threadId: "late-panel" },
          theme: "light",
          resourcePanelWidth: 480,
          contextContent: React.createElement("p", {}, "Information"),
          navigate() {},
          executeCommand: async () => null,
          readHandle: async () => null,
        }),
      ),
    );
    await toggle();
    const first = panel();
    await act(async () => workspace.append(first));
    assert.equal(
      toolbar().hidden,
      true,
      "late maximized resource hides the conversation entry",
    );
    assert.equal(button().getAttribute("aria-expanded"), "false");
    await act(async () => {
      first.dataset.primaryActive = "true";
    });
    assert.equal(
      toolbar().hidden,
      false,
      "late panel's main tab restores the entry",
    );
    await toggle();
    assert.ok(document.querySelector(".information-popover"));
    const second = panel();
    await act(async () => first.replaceWith(second));
    assert.equal(
      toolbar().hidden,
      true,
      "replacement resource owns current visibility",
    );
    assert.equal(
      observed.has(first.firstElementChild!),
      false,
      "detached heading is retired",
    );
    assert.equal(
      observed.has(second.firstElementChild!),
      true,
      "replacement heading is measured",
    );
    await act(async () => {
      first.dataset.primaryActive = "false";
      first.dataset.open = "false";
    });
    assert.equal(
      toolbar().hidden,
      true,
      "detached panel cannot override the current tab",
    );
    for (let repeat = 0; repeat < 3; repeat++) {
      await act(async () => {
        second.dataset.primaryActive = "true";
      });
      assert.equal(toolbar().hidden, false);
      await toggle();
      assert.equal(button().getAttribute("aria-expanded"), "true");
      await toggle();
      assert.equal(button().getAttribute("aria-expanded"), "false");
      await act(async () => {
        second.dataset.primaryActive = "false";
      });
      assert.equal(toolbar().hidden, true);
    }
    await act(async () => {
      second.dataset.primaryActive = "true";
      second.dataset.primaryActive = "false";
      second.dataset.expanded = "false";
    });
    assert.equal(
      toolbar().hidden,
      false,
      "split resource keeps the conversation entry reachable",
    );
    await toggle();
    assert.equal(button().getAttribute("aria-expanded"), "true");
    const currentCard = document.querySelector(".information-popover");
    assert.ok(currentCard);
    assert.equal(toolbar().dataset.clearanceResourceBeside, "true");
    await act(async () => {
      second.dataset.expanded = "true";
      second.dataset.primaryActive = "true";
    });
    assert.equal(toolbar().dataset.clearanceResourceBeside, "false");
    assert.equal(document.querySelector(".information-popover"), currentCard);
    await act(async () => {
      second.dataset.expanded = "false";
      second.dataset.primaryActive = "false";
    });
    assert.equal(toolbar().dataset.clearanceResourceBeside, "true");
    assert.equal(document.querySelector(".information-popover"), currentCard);
    const replacementHeading = document.createElement("header");
    replacementHeading.className = "auxiliary-heading";
    const oldHeading = second.firstElementChild!;
    await act(async () => oldHeading.replaceWith(replacementHeading));
    assert.equal(observed.has(oldHeading), false);
    assert.equal(observed.has(replacementHeading), true);
    await act(async () => second.remove());
    assert.equal(toolbar().hidden, false);
    assert.equal(observed.has(replacementHeading), false);
  } finally {
    await act(async () => root.unmount());
    globalThis.ResizeObserver = previous;
    dom.window.close();
  }
});

test("late native-only information starts observing the current panel", async () => {
  const dom = new JSDOM(
    '<main class="workspace"><aside class="auxiliary-panel" data-open="true" data-expanded="true" data-primary-active="false"></aside><div id="root"></div></main>',
    { url: "https://zenx.local/" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const registry = createPluginUiRegistry();
  const render = (content: boolean) =>
    act(async () =>
      root.render(
        React.createElement(PluginInformationHost, {
          snapshot: { ...snapshot, information: [] },
          registry,
          owner: { kind: "thread", threadId: "late-native-information" },
          theme: "light",
          contextContent: content
            ? React.createElement("p", {}, "Native content")
            : null,
          navigate() {},
          executeCommand: async () => null,
          readHandle: async () => null,
        }),
      ),
    );
  try {
    await render(false);
    assert.equal(document.querySelector(".information-toolbar"), null);
    await render(true);
    assert.equal(
      document.querySelector<HTMLElement>(".information-toolbar")!.hidden,
      true,
    );
    await act(async () => {
      document.querySelector<HTMLElement>(
        ".auxiliary-panel",
      )!.dataset.primaryActive = "true";
    });
    assert.equal(
      document.querySelector<HTMLElement>(".information-toolbar")!.hidden,
      false,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("floating Information respects the primary draft height without shortening a fitted card", async () => {
  const dom = new JSDOM(
    '<main class="workspace"><section id="primary-conversation-content" class="agent-surface"><div class="thread-conversation-surface"><div class="thread-view"><div class="bottom-zone"><form class="composer"><textarea>Synthetic draft</textarea></form></div></div></div></section><div id="root"></div></main>',
    { url: "https://zenx.local" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  workspace.getBoundingClientRect = () =>
    ({ top: 44, right: 1000, width: 736 }) as DOMRect;
  const resize = new Map<Element, () => void>();
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    readonly nodes = new Set<Element>();
    constructor(readonly measure: () => void) {}
    observe(node: Element) {
      this.nodes.add(node);
      resize.set(node, this.measure);
    }
    disconnect() {
      for (const node of this.nodes)
        if (resize.get(node) === this.measure) resize.delete(node);
    }
  } as unknown as typeof ResizeObserver;
  const view = document.querySelector<HTMLElement>(".thread-view")!;
  const composer = view.querySelector<HTMLElement>(".composer")!;
  const draft = composer.querySelector("textarea")!;
  let top = 694;
  composer.getBoundingClientRect = () =>
    ({ left: 288, right: 966, width: 678, top, height: 108 }) as DOMRect;
  const panel = document.createElement("aside");
  panel.className = "auxiliary-panel";
  panel.dataset.open = "true";
  panel.dataset.expanded = "true";
  panel.dataset.primaryActive = "true";
  panel.innerHTML =
    '<header class="auxiliary-heading"></header><div class="thread-view"><div class="bottom-zone"><form class="composer"></form></div></div>';
  const heading = panel.querySelector<HTMLElement>("header")!;
  heading.getBoundingClientRect = () => ({ bottom: 88 }) as DOMRect;
  workspace.append(panel);
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        React.createElement(PluginInformationHost, {
          snapshot: { ...snapshot, information: [] },
          registry: createPluginUiRegistry(),
          owner: { kind: "thread", threadId: "narrow-primary-composer" },
          theme: "light",
          resourcePanelWidth: 480,
          contextContent: React.createElement("input", {
            "aria-label": "Card answer",
            defaultValue: "Synthetic card answer",
          }),
          navigate() {},
          executeCommand: async () => null,
          readHandle: async () => null,
        }),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      ".information-toolbar button",
    )!;
    await act(async () => trigger.click());
    const card = document.querySelector<HTMLElement>(".information-popover")!;
    assert.ok(card);
    assert.match(card.style.maxHeight, /min\(590px/);
    assert.equal(resize.has(panel.querySelector(".composer")!), false);

    const answer = card.querySelector("input")!;
    await act(async () => answer.focus());
    top = 623;
    await act(async () => resize.get(composer)?.());
    assert.match(card.style.maxHeight, /min\(519px/);
    assert.equal(document.activeElement, answer);

    await act(async () => {
      view.dataset.informationLane = "true";
    });
    assert.match(card.style.maxHeight, /min\(720px/);
    assert.equal(document.querySelector(".information-popover"), card);

    await act(async () => {
      view.dataset.informationLane = "false";
      top = 225;
    });
    assert.match(card.style.maxHeight, /min\(720px/);
    assert.equal(draft.value, "Synthetic draft");

    const replacement = composer.cloneNode(true) as HTMLElement;
    replacement.getBoundingClientRect = () =>
      ({ left: 288, right: 966, width: 678, top: 650, height: 108 }) as DOMRect;
    await act(async () => composer.replaceWith(replacement));
    assert.equal(resize.has(composer), false);
    assert.equal(resize.has(replacement), true);
    assert.match(card.style.maxHeight, /min\(546px/);
    assert.equal(document.activeElement, answer);
    assert.equal(
      replacement.querySelector("textarea")!.value,
      "Synthetic draft",
    );

    await act(async () => replacement.remove());
    assert.equal(resize.has(replacement), false);
    assert.match(card.style.maxHeight, /min\(720px/);
    assert.equal(document.querySelector(".information-popover"), card);
  } finally {
    await act(async () => root.unmount());
    globalThis.ResizeObserver = previous;
    dom.window.close();
  }
});
