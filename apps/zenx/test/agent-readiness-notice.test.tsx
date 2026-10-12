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

async function mount(
  plugins: ZenXPluginSnapshot,
  bridge: object,
  beforeRender?: (dom: JSDOM) => void,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window, "zenx", { value: bridge });
  beforeRender?.(dom);
  const opened: string[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(AgentReadinessNotice, {
        pluginSnapshot: plugins,
        onOpenBrowserSettings: () => opened.push("browser-settings"),
      }),
    );
    await Promise.resolve();
  });
  const button = (label: string) => {
    const found = [...dom.window.document.querySelectorAll("button")].find(
      (entry) => entry.textContent?.includes(label),
    );
    assert.ok(found, `Expected a ${label} button`);
    return found;
  };
  const close = async () => {
    await act(async () => root.unmount());
    dom.window.close();
  };
  return { dom, opened, button, close };
}

test("Computer probe gives separate permission steps and opens matching macOS panels", async () => {
  let probes = 0;
  const opened: string[] = [];
  const view = await mount(snapshot(true), {
    computerReadiness: {
      probe: async () => {
        probes += 1;
        return {
          platform: "darwin",
          accessibility: "needs-setup",
          screenRecording: "denied",
          foregroundControlEnabled: false,
          verification: {
            accessibility: { state: "needs-setup" },
            screenCapture: { state: "needs-setup" },
          },
        };
      },
      openSettings: async (kind: string) => opened.push(kind),
    },
  });
  const card = view.dom.window.document.querySelector(
    '[aria-label="Tool setup"]',
  );
  assert.ok(card);
  assert.equal(probes, 1);
  assert.match(card.textContent ?? "", /Accessibility.*Screen Recording/su);
  assert.match(card.textContent ?? "", /enable this ZenX.*check again/su);
  assert.doesNotMatch(
    card.textContent ?? "",
    /waiting|Foreground control|Plugin settings/iu,
  );
  await act(async () => view.button("Open Accessibility settings").click());
  await act(async () => view.button("Open Screen Recording settings").click());
  assert.deepEqual(opened, ["accessibility", "screen-recording"]);
  await view.close();
});

test("Computer uses the actual helper check and clears setup when a focus recheck succeeds", async () => {
  let ready = false;
  let probes = 0;
  const view = await mount(snapshot(true), {
    computerReadiness: {
      probe: async () => {
        probes += 1;
        return {
          platform: "darwin",
          accessibility: "granted",
          screenRecording: "granted",
          foregroundControlEnabled: false,
          verification: {
            accessibility: { state: ready ? "ready" : "needs-setup" },
            screenCapture: { state: "ready" },
          },
        };
      },
    },
  });
  assert.ok(
    view.dom.window.document.querySelector('[aria-label="Tool setup"]'),
  );
  ready = true;
  await act(async () => {
    view.dom.window.dispatchEvent(new view.dom.window.Event("focus"));
    await Promise.resolve();
  });
  assert.equal(probes, 2);
  assert.equal(
    view.dom.window.document.querySelector('[aria-label="Tool setup"]'),
    null,
  );
  await view.close();
});

test("A capture probe failure is shown as a failed check, not a missing grant", async () => {
  const view = await mount(snapshot(true), {
    computerReadiness: {
      probe: async () => ({
        platform: "darwin",
        accessibility: "granted",
        screenRecording: "granted",
        foregroundControlEnabled: false,
        verification: {
          accessibility: { state: "ready" },
          screenCapture: {
            state: "failed",
            detail: "The test window could not be captured.",
          },
        },
      }),
      openSettings: async () => {},
    },
  });
  const card = view.dom.window.document.querySelector(
    '[aria-label="Tool setup"]',
  );
  assert.ok(card);
  assert.match(
    card.textContent ?? "",
    /Screen Recording.*Check failed.*test window could not be captured/su,
  );
  assert.doesNotMatch(card.textContent ?? "", /Needs permission/u);
  assert.match(card.textContent ?? "", /Check tool access/u);
  assert.equal(
    [...card.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Open Screen Recording settings"),
    ),
    false,
  );
  assert.doesNotMatch(card.textContent ?? "", /Review the macOS permission/u);
  await view.close();
});

test("Connected Chrome explains the click needed and opens Browser settings", async () => {
  let connected = false;
  let reads = 0;
  const view = await mount(snapshot(false, true), {
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
  });
  const card = view.dom.window.document.querySelector(
    '[aria-label="Tool setup"]',
  );
  assert.ok(card);
  assert.match(
    card.textContent ?? "",
    /Connected Chrome.*Connect a tab.*click the ZenX extension/su,
  );
  assert.doesNotMatch(card.textContent ?? "", /waiting/iu);
  await act(async () => view.button("Open Browser settings").click());
  assert.deepEqual(view.opened, ["browser-settings"]);
  connected = true;
  await act(async () => {
    view.dom.window.dispatchEvent(new view.dom.window.Event("focus"));
    await Promise.resolve();
  });
  assert.ok(reads >= 2);
  assert.equal(
    view.dom.window.document.querySelector('[aria-label="Tool setup"]'),
    null,
  );
  await view.close();
});

test("Chrome polling does not repeatedly run the Computer probe", async () => {
  let poll: (() => void) | undefined;
  let probes = 0;
  let reads = 0;
  const view = await mount(
    snapshot(true, true),
    {
      computerReadiness: {
        probe: async () => {
          probes += 1;
          return {
            platform: "darwin",
            accessibility: "needs-setup",
            screenRecording: "granted",
            foregroundControlEnabled: false,
            verification: {
              accessibility: { state: "needs-setup" },
              screenCapture: { state: "ready" },
            },
          };
        },
      },
      chromeBridge: {
        get: async () => {
          reads += 1;
          return {
            effectiveMode: "user-session",
            connector: "chrome-extension",
            nativeHostRegistered: true,
            connection: { state: "waiting", tabCount: 0 },
          };
        },
      },
    },
    (dom) => {
      dom.window.setInterval = ((callback: () => void) => {
        poll = callback;
        return 1;
      }) as typeof dom.window.setInterval;
      dom.window.clearInterval = (() =>
        undefined) as typeof dom.window.clearInterval;
    },
  );
  assert.ok(poll);
  await act(async () => {
    poll?.();
    await Promise.resolve();
  });
  assert.equal(probes, 1);
  assert.ok(reads >= 2);
  await view.close();
});

test("isolated Browser and disabled plugins do not require Chrome setup", async () => {
  const view = await mount(snapshot(false, true), {
    chromeBridge: {
      get: async () => ({
        effectiveMode: "isolated",
        connector: "inactive",
        nativeHostRegistered: false,
        connection: { state: "waiting", tabCount: 0 },
      }),
    },
  });
  assert.equal(
    view.dom.window.document.querySelector('[aria-label="Tool setup"]'),
    null,
  );
  await view.close();
});

test("Failed Computer check can be retried without interrupting the Thread", async () => {
  let probes = 0;
  const view = await mount(snapshot(true), {
    computerReadiness: {
      probe: async () => {
        probes += 1;
        if (probes === 1) throw new Error("helper unavailable");
        return {
          platform: "darwin",
          accessibility: "granted",
          screenRecording: "granted",
          foregroundControlEnabled: false,
          verification: {
            accessibility: { state: "ready" },
            screenCapture: { state: "ready" },
          },
        };
      },
    },
  });
  assert.match(
    view.dom.window.document.body.textContent ?? "",
    /Computer.*Check failed.*Check again/su,
  );
  await act(async () => {
    view.button("Check again").click();
    await Promise.resolve();
  });
  assert.equal(probes, 2);
  assert.equal(
    view.dom.window.document.querySelector('[aria-label="Tool setup"]'),
    null,
  );
  await view.close();
});
