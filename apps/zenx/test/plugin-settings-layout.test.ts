import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { PluginSettings } from "../src/renderer/src/PluginSettings.js";

const styles = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

// JSDOM does not perform Grid layout. Check the real declarations responsible
// for placement here; the native Electron fixture verifies rendered geometry.
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = styles.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "u"))?.[0];
  assert.ok(value, `Missing ${selector} rule`);
  return value;
}

test("plugin lifecycle confirmation spans the card instead of its icon column", async () => {
  const dom = new JSDOM('<div class="settings-panel" id="root"></div>', {
    url: "https://zenx.local",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  const style = dom.window.document.createElement("style");
  style.textContent = rule(".marketplace-card") + rule(".plugin-confirm");
  dom.window.document.head.append(style);
  let snapshot: ZenXPluginSnapshot = {
    plugins: [
      {
        id: "fixture",
        displayName: "Fixture",
        version: "1.0.0",
        source: "local",
        description: "Keep project notes and useful references together.",
        lifecycle: "enabled",
        enabled: true,
        available: true,
        contributionCount: 0,
      },
    ],
    bundles: [],
    surfaces: [],
    sidebar: [],
    pages: [],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
    resultRenderers: [],
  };
  const calls: string[] = [];
  const change = (lifecycle: "enabled" | "installed" | "uninstalled") => {
    snapshot = {
      ...snapshot,
      plugins: snapshot.plugins.map((plugin) => ({
        ...plugin,
        lifecycle,
        enabled: lifecycle === "enabled",
      })),
    };
    return { snapshot, capabilityRefresh: { status: "refreshed" } };
  };
  Object.defineProperty(dom.window, "zenx", {
    value: {
      marketplace: { get: async () => ({ entries: [], builtIns: [] }) },
      plugins: {
        get: async () => snapshot,
        onChange: () => () => {},
        setEnabled: async () => {
          calls.push("disable");
          return change("installed");
        },
        uninstall: async () => {
          calls.push("uninstall");
          return change("uninstalled");
        },
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const button = (label: string) => {
    const value = [...dom.window.document.querySelectorAll("button")].find(
      (candidate) =>
        (candidate.querySelector("strong")?.textContent ??
          candidate.textContent) === label,
    );
    assert.ok(value, `Missing ${label}`);
    return value;
  };
  try {
    await act(async () => {
      root.render(React.createElement(PluginSettings));
      await Promise.resolve();
    });
    await act(async () => {
      button("Disable").click();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document
        .querySelector(".marketplace-card")
        ?.getAttribute("data-lifecycle"),
      "installed",
    );
    await act(async () => button("More actions").click());
    await act(async () => button("Uninstall").click());
    const confirmation = dom.window.document.querySelector(".plugin-confirm");
    assert.ok(confirmation);
    assert.equal(
      dom.window.getComputedStyle(confirmation).gridColumn,
      "1 / -1",
    );
    await act(async () => {
      button("Confirm uninstall").click();
      await Promise.resolve();
    });
    assert.deepEqual(calls, ["disable", "uninstall"]);
    assert.equal(dom.window.document.querySelector(".plugin-confirm"), null);
    assert.equal(
      dom.window.document
        .querySelector(".marketplace-card")
        ?.getAttribute("data-lifecycle"),
      "uninstalled",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("settings content cannot grow an implicit min-content grid track", () => {
  const dom = new JSDOM('<div class="settings-panel"></div>');
  const style = dom.window.document.createElement("style");
  style.textContent = rule(".settings-panel");
  dom.window.document.head.append(style);
  const panel = dom.window.document.querySelector(".settings-panel")!;
  assert.equal(
    dom.window.getComputedStyle(panel).gridTemplateColumns,
    "minmax(0, 1fr)",
  );
  dom.window.close();
});

test("advanced source controls reflow before their desktop columns exceed available space", () => {
  const mediumStart = styles.indexOf("@container (max-width: 900px)");
  const compactStart = styles.indexOf("@container (max-width: 640px)");
  assert.ok(mediumStart >= 0 && compactStart > mediumStart);
  const medium = styles.slice(mediumStart, compactStart);
  assert.match(
    medium,
    /\.plugin-source-install\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 2fr\);/su,
  );
  assert.match(
    medium,
    /\.plugin-source-copy,\s*\.plugin-source-actions\s*\{[^}]*grid-column: 1 \/ -1;/su,
  );
  const compact = styles.slice(
    compactStart,
    styles.indexOf(".plugin-access-wrap", compactStart),
  );
  assert.match(
    compact,
    /\.plugin-source-install,[\s\S]*grid-template-columns: minmax\(0, 1fr\);/u,
  );
});
