import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

test("background parent updates preserve the open IM settings and do not reload its draft", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const keys = [
    "React",
    "window",
    "document",
    "MutationObserver",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const before = keys.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { PluginProductPage } =
    await import("../src/renderer/src/PluginProductPage.js");
  const snapshot: ZenXPluginSnapshot = {
    plugins: [],
    sidebar: [],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
    pages: [
      {
        id: "connection",
        key: "imzenx:connection",
        pluginId: "imzenx",
        title: "IMZenX",
        route: "/plugins/imzenx/connection",
        surfaceId: "connection",
      },
    ],
    bundles: [
      {
        id: "main",
        key: "imzenx:main",
        pluginId: "imzenx",
        apiVersion: 1,
        kind: "trusted",
        entry: "zenx/bundled/imzenx-ui",
      },
    ],
    surfaces: [
      {
        id: "connection",
        key: "imzenx:connection",
        pluginId: "imzenx",
        bundleId: "main",
        exportName: "connection",
      },
    ],
  };
  let statusCalls = 0;
  Object.defineProperty(dom.window, "zenx", {
    value: {
      plugins: {
        executeCommand: async () => {
          statusCalls++;
          return {
            state: "connected",
            configuration: {
              pythonExecutable: "/python",
              channelsConfigFile: "/channels",
              cwd: "/work",
            },
          };
        },
        readHandle: async () => ({}),
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const props = {
    snapshot,
    route: "/plugins/imzenx/connection",
    navigate: () => {},
  };
  try {
    await act(async () => {
      root.render(React.createElement(PluginProductPage, props));
    });
    const settings =
      dom.window.document.querySelector<HTMLDetailsElement>(
        ".imzenx-settings",
      )!;
    await act(async () => {
      settings.open = true;
      settings.dispatchEvent(new dom.window.Event("toggle"));
    });
    assert.equal(settings.open, true);
    await act(async () => {
      root.render(React.createElement(PluginProductPage, props));
    });
    assert.equal(
      settings.open,
      true,
      "incoming notifications must not collapse settings",
    );
    assert.equal(
      statusCalls,
      1,
      "unrelated renders must not reinitialize the form draft",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    keys.forEach((key, index) => {
      const descriptor = before[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
