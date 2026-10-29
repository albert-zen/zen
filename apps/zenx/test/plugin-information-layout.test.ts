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
    '<main class="workspace"><aside class="auxiliary-panel" data-open="true"><header class="auxiliary-heading"></header></aside><div id="root"></div></main>',
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
  let headerBottom = 104;
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  const heading = document.querySelector<HTMLElement>(".auxiliary-heading")!;
  workspace.getBoundingClientRect = () => ({ top: 44, width: 1000 }) as DOMRect;
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
  localStorage.setItem("zenx.information.pin.thread:fixture", "fixture:info");
  function Harness() {
    const theme = useAppearance();
    return React.createElement(PluginInformationHost, {
      snapshot: current,
      registry,
      resourcePanelWidth: 480,
      owner: { kind: "thread", threadId },
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
    await click(".information-toolbar button");
    threadId = "another-owner";
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      document.querySelector(".information-popover") === null,
      "owner changes close presentation without auto-opening the next owner",
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
    /\.information-toolbar > \.icon-button\[aria-pressed="true"\]\s*\{\s*color: var\(--color-text-muted\);\s*background: var\(--color-surface-active\);\s*\}/,
  );
  assert.doesNotMatch(css, /\.information-(?:header|rail)/);
  assert.match(app, /const appearance = useAppearance\(\)/);
  assert.match(app, /theme=\{appearance\}/);
  assert.doesNotMatch(app, /document\.documentElement\.dataset\.theme/);
});
