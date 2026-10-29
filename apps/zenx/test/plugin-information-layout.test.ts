import "./dom-primitives.js";
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

test("late information admission measures Browser coexistence, tracks wrapped header and transfers pin focus", async () => {
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
  const callbacks = new Set<() => void>();
  const prior = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(readonly callback: () => void) {
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
  function Harness() {
    const theme = useAppearance();
    return React.createElement(PluginInformationHost, {
      snapshot: current,
      registry,
      resourcePanelWidth: 480,
      owner: { kind: "thread", threadId: "fixture" },
      theme,
      navigate() {},
      executeCommand: async () => null,
      readHandle: async () => null,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const click = async (selector: string) => {
    await act(async () => {
      document.querySelector<HTMLButtonElement>(selector)!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(document.querySelector(".information-toolbar"), null);
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
    await click("[data-information-pin]");
    const rail = document.querySelector<HTMLElement>(".information-rail")!;
    assert.equal(
      rail.dataset.floating,
      "true",
      "480px Browser leaves insufficient chat + rail width",
    );
    assert.equal(rail.style.top, "68px");
    assert.equal(
      document.activeElement,
      rail.querySelector("[data-information-pin]"),
      "pin focuses the new Unpin action, not a removed popup",
    );
    headerBottom = 160;
    await act(async () => {
      for (const callback of callbacks) callback();
    });
    assert.equal(
      rail.style.top,
      "124px",
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
  } finally {
    await act(async () => root.unmount());
    globalThis.ResizeObserver = prior;
    dom.window.close();
  }
});

test("information reserves its own slot and primary hover keeps inverse text contrast", async () => {
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
  assert.match(app, /const appearance = useAppearance\(\)/);
  assert.match(app, /theme=\{appearance\}/);
  assert.doesNotMatch(app, /document\.documentElement\.dataset\.theme/);
});
