import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { AgentReadinessNotice } from "../src/renderer/src/AgentReadinessNotice.js";

function snapshot(computer = false, browser = false): ZenXPluginSnapshot {
  return {
    plugins: [
      {
        id: "computer",
        displayName: "Computer",
        version: "1",
        source: "bundled",
        lifecycle: "enabled",
        enabled: computer,
        available: true,
        contributionCount: 0,
      },
      {
        id: "browser",
        displayName: "Browser",
        version: "1",
        source: "bundled",
        lifecycle: "enabled",
        enabled: browser,
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
  };
}

test("Thread warns about missing Computer grants without treating foreground opt-in as a grant", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window, "zenx", {
    value: {
      computerReadiness: {
        get: async () => ({
          platform: "darwin",
          accessibility: "needs-setup",
          screenRecording: "denied",
          foregroundControlEnabled: false,
        }),
      },
    },
  });
  const opened: string[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(AgentReadinessNotice, {
        pluginSnapshot: snapshot(true),
        onOpenPlugins: () => opened.push("plugins"),
        onOpenGeneral: () => opened.push("general"),
      }),
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  const notice = dom.window.document.querySelector(
    '[aria-label="Agent tool readiness"]',
  );
  assert.ok(notice);
  assert.match(notice.textContent ?? "", /Accessibility.*Screen Recording/su);
  assert.match(notice.textContent ?? "", /Foreground control.*optional/su);
  assert.equal(notice.textContent?.includes("Chrome"), false);
  await act(async () =>
    (notice.querySelector("button") as HTMLButtonElement).click(),
  );
  assert.deepEqual(opened, ["plugins"]);
  await act(async () => root.unmount());
  dom.window.close();
});

test("Thread warns for disconnected Connected Chrome and clears on focus refresh", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let connected = false;
  let reads = 0;
  Object.defineProperty(dom.window, "zenx", {
    value: {
      chromeBridge: {
        get: async () => {
          reads += 1;
          return {
            effectiveMode: "user-session",
            connector: "chrome-extension",
            nativeHostRegistered: true,
            connection: {
              state: connected ? "connected" : "waiting",
              tabCount: connected ? 1 : 0,
            },
          };
        },
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(AgentReadinessNotice, {
        pluginSnapshot: snapshot(false, true),
        onOpenPlugins: () => {},
        onOpenGeneral: () => {},
      }),
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  assert.match(
    dom.window.document.body.textContent ?? "",
    /Connected Chrome.*waiting/su,
  );
  connected = true;
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Promise.resolve();
  });
  assert.ok(reads >= 2);
  assert.equal(
    dom.window.document.querySelector('[aria-label="Agent tool readiness"]'),
    null,
  );
  await act(async () => root.unmount());
  dom.window.close();
});

test("Thread notices a Chrome disconnect while ZenX stays focused", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let connected = true;
  let poll: (() => void) | undefined;
  dom.window.setInterval = ((callback: () => void) => {
    poll = callback;
    return 1;
  }) as typeof dom.window.setInterval;
  dom.window.clearInterval = (() =>
    undefined) as typeof dom.window.clearInterval;
  Object.defineProperty(dom.window, "zenx", {
    value: {
      chromeBridge: {
        get: async () => ({
          effectiveMode: "user-session",
          connector: "chrome-extension",
          nativeHostRegistered: true,
          connection: {
            state: connected ? "connected" : "waiting",
            tabCount: connected ? 1 : 0,
          },
        }),
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(AgentReadinessNotice, {
        pluginSnapshot: snapshot(false, true),
        onOpenPlugins: () => {},
        onOpenGeneral: () => {},
      }),
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(
    dom.window.document.querySelector('[aria-label="Agent tool readiness"]'),
    null,
  );
  assert.ok(poll);
  connected = false;
  await act(async () => {
    poll?.();
    await Promise.resolve();
  });
  assert.match(
    dom.window.document.body.textContent ?? "",
    /Connected Chrome.*waiting/su,
  );
  await act(async () => root.unmount());
  dom.window.close();
});

test("isolated Browser and disabled plugins never report Chrome setup", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window, "zenx", {
    value: {
      chromeBridge: {
        get: async () => ({
          effectiveMode: "isolated",
          connector: "inactive",
          nativeHostRegistered: false,
          connection: { state: "waiting", tabCount: 0 },
        }),
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(AgentReadinessNotice, {
        pluginSnapshot: snapshot(false, true),
        onOpenPlugins: () => {},
        onOpenGeneral: () => {},
      }),
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(
    dom.window.document.querySelector('[aria-label="Agent tool readiness"]'),
    null,
  );
  await act(async () => root.unmount());
  dom.window.close();
});

test("Thread keeps ordinary chat available when a readiness read fails and refresh recovers", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let reads = 0;
  Object.defineProperty(dom.window, "zenx", {
    value: {
      computerReadiness: {
        get: async () => {
          reads += 1;
          if (reads === 1) throw new Error("probe failed");
          return {
            platform: "darwin",
            accessibility: "granted",
            screenRecording: "granted",
            foregroundControlEnabled: false,
          };
        },
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(AgentReadinessNotice, {
        pluginSnapshot: snapshot(true),
        onOpenPlugins: () => {},
        onOpenGeneral: () => {},
      }),
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  assert.match(
    dom.window.document.body.textContent ?? "",
    /status is unavailable.*continue chatting/su,
  );
  const refresh = [...dom.window.document.querySelectorAll("button")].find(
    (button) => button.textContent === "Refresh status",
  );
  assert.ok(refresh);
  await act(async () => {
    refresh.click();
    await Promise.resolve();
  });
  assert.equal(
    dom.window.document.querySelector('[aria-label="Agent tool readiness"]'),
    null,
  );
  await act(async () => root.unmount());
  dom.window.close();
});
