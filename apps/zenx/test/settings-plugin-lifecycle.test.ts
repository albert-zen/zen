import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  SettingsView,
  type SettingsTab,
} from "../src/renderer/src/SettingsView.js";
import { useAppearance } from "../src/renderer/src/PluginProductPage.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

function dom() {
  const value = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: value.window,
    document: value.window.document,
    localStorage: value.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  return value;
}
test("appearance rereads authority after an Activity resumes", async () => {
  const documentOwner = dom();
  const root = createRoot(document.getElementById("root")!);
  function Reader() {
    return React.createElement("span", null, useAppearance());
  }
  const render = async (mode: "visible" | "hidden") =>
    act(async () =>
      root.render(
        React.createElement(React.Activity, {
          mode,
          children: React.createElement(Reader),
        }),
      ),
    );
  try {
    document.documentElement.dataset.appearance = "light";
    await render("visible");
    await render("hidden");
    document.documentElement.dataset.appearance = "dark";
    await render("visible");
    assert.equal(document.querySelector("span")?.textContent, "dark");
  } finally {
    await act(async () => root.unmount());
    documentOwner.window.close();
  }
});

test("settings retain the isolated document and settle requests while another tab or page is visible", async () => {
  const documentOwner = dom();
  const root = createRoot(document.getElementById("root")!);
  const snapshot: ZenXPluginSnapshot = {
    plugins: [
      {
        id: "sample",
        displayName: "Sample",
        version: "1",
        source: "bundled",
        lifecycle: "enabled",
        enabled: true,
        available: true,
        contributionCount: 1,
      },
    ],
    bundles: [
      {
        key: "sample:ui",
        pluginId: "sample",
        id: "ui",
        apiVersion: 1,
        kind: "isolated",
        entry: '<input value="draft">',
      },
    ],
    surfaces: [
      {
        key: "sample:settings",
        pluginId: "sample",
        id: "settings",
        bundleId: "ui",
        exportName: "settings",
      },
    ],
    settings: [
      {
        key: "sample:settings",
        pluginId: "sample",
        id: "settings",
        title: "Sample settings",
        surfaceId: "settings",
      },
    ],
    pages: [],
    subroutes: [],
    sidebar: [],
    panels: [],
    commands: [],
    menus: [],
  };
  let reads = 0;
  Object.assign(window, {
    zenx: {
      settings: {
        get: async () => ({
          profile: {
            version: 3,
            onboardingComplete: true,
            providerProfiles: [],
            defaultModel: { providerProfileId: "fake", modelId: "fake" },
            titleModel: { providerProfileId: "fake", modelId: "fake" },
            workspace: "/work",
            workspaces: ["/work"],
            approvalPolicy: "never",
            pinnedThreadIds: [],
          },
          hasApiKey: false,
          apiKeyProviderProfileIds: [],
          subscriptionProviderProfileId: null,
          subscription: { authenticated: false, expired: false },
        }),
        onManualCodeRequested: () => () => {},
      },
      marketplace: { get: async () => ({ entries: [], builtIns: [] }) },
      plugins: {
        get: async () => ({ plugins: [], marketplace: [] }),
        onChange: () => () => {},
        executeCommand: async () => null,
        readHandle: async () => ++reads,
      },
    },
  });
  const render = async (tab: SettingsTab, active = true) =>
    act(async () =>
      root.render(
        React.createElement(SettingsView, {
          tab,
          active,
          onTabChange() {},
          archivedError: null,
          archivedLoading: false,
          archivedThreads: [],
          onRetryArchived() {},
          onUnarchive: async () => {},
          pluginSnapshot: snapshot,
        }),
      ),
    );
  try {
    await render("plugins");
    const frame = document.querySelector("iframe")!;
    assert.ok(frame);
    const messages: any[] = [];
    frame.contentWindow!.postMessage = (message) => {
      messages.push(message);
    };
    await act(async () =>
      frame.dispatchEvent(new documentOwner.window.Event("load")),
    );
    const channel = JSON.parse(
      messages
        .find((message) => message.type === "zenx-plugin-ui:document")
        .html.match(/const init=(.*?);const deepFreeze/s)[1],
    ).channel;
    const request = async (requestId: string) => {
      await act(async () =>
        window.dispatchEvent(
          new documentOwner.window.MessageEvent("message", {
            source: frame.contentWindow,
            data: {
              channel,
              type: "zenx-plugin-ui:request",
              requestId,
              operation: "handles.read",
              id: "sample:context",
            },
          }),
        ),
      );
      assert.equal(
        messages.some(
          (message) =>
            message.requestId === requestId &&
            message.type === "zenx-plugin-ui:result",
        ),
        true,
        requestId,
      );
    };
    await request("visible");
    await render("general");
    assert.equal(
      document
        .querySelector<HTMLElement>(".preserved-plugin-settings")
        ?.hasAttribute("inert"),
      true,
    );
    await request("hidden-tab");
    await render("plugins", false);
    assert.equal(
      document.querySelector<HTMLElement>(".settings-view")?.hidden,
      true,
    );
    assert.equal(
      document
        .querySelector<HTMLElement>(".settings-view")
        ?.hasAttribute("inert"),
      true,
    );
    await request("hidden-page");
    document.documentElement.dataset.appearance = "dark";
    await render("plugins");
    await request("resumed");
    assert.equal(document.querySelector("iframe") === frame, true);
    assert.equal(reads, 4);
    assert.equal(
      messages
        .filter((message) => message.type === "zenx-plugin-ui:update")
        .at(-1)?.theme,
      "dark",
    );
  } finally {
    await act(async () => root.unmount());
    documentOwner.window.close();
  }
});
