import "./dom-primitives.js";
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
  const { ImZenXDraftContext } =
    await import("../src/renderer/src/imzenx-ui.js");
  const drafts = {
    current: {} as Record<
      string,
      import("../src/renderer/src/imzenx-ui.js").ImZenXDraft
    >,
  };
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
  const view = () =>
    React.createElement(
      ImZenXDraftContext.Provider,
      { value: drafts },
      React.createElement(PluginProductPage, props),
    );
  try {
    await act(async () => {
      root.render(view());
    });
    assert.match(dom.window.document.body.textContent ?? "", /PAW/);
    assert.match(dom.window.document.body.textContent ?? "", /\/paws/);
    assert.match(
      dom.window.document.body.textContent ?? "",
      /只接收它主动发到聊天室的回复/,
    );
    assert.match(
      dom.window.document.body.textContent ?? "",
      /工作目录与 PAW 可见范围/,
    );
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
      root.render(view());
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
    const input = dom.window.document.querySelector<HTMLInputElement>(
      'input[value="/work"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "/draft-work");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(drafts.current.imzenx?.config.cwd, "/draft-work");
    await act(async () => root.render(null));
    await act(async () => root.render(view()));
    assert.equal(
      dom.window.document.querySelector<HTMLInputElement>(
        'input[value="/draft-work"]',
      )?.value,
      "/draft-work",
      "route remount retains unsaved configuration rather than replacing it with Host values",
    );
    assert.equal(drafts.current.imzenx?.dirty, true);
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
