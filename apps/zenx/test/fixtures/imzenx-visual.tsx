import React from "react";
import { createRoot } from "react-dom/client";
import { PluginProductPage } from "../../src/renderer/src/PluginProductPage.js";
import type { ZenXPluginSnapshot } from "../../src/main/capabilities/types.js";
import type { PluginUiSdkV1 } from "../../src/renderer/src/plugin-ui-host.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

let failed = location.search.includes("failed");
const configured = !location.search.includes("new");
document.documentElement.dataset.appearance = location.search.includes("dark")
  ? "dark"
  : "light";
let configuration: unknown = configured
  ? {
      pythonExecutable:
        "/Users/demo/Library/Application Support/ZenX/imzenx/.venv/bin/python",
      channelsConfigFile: "/Users/demo/.config/imzen/channels.json",
      cwd: "/Users/demo/work",
    }
  : null;
const sdk: PluginUiSdkV1 = {
  version: 1,
  pluginId: "imzenx",
  theme: "light",
  context: {},
  navigation: { navigate: () => {} },
  handles: { read: async () => ({}) },
  commands: {
    execute: async (command, input) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (command === "configure") {
        configuration = input;
        failed = false;
      }
      if (command === "connect") failed = false;
      return {
        state: failed ? "failed" : configuration ? "connected" : "unconfigured",
        configuration,
        ...(failed
          ? {
              error:
                "IM Gateway failed to start. Check Python and channel configuration.",
            }
          : {}),
      };
    },
  },
};
// Render the actual Host composition: a leaf-only preview missed its 60px row.
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
Object.defineProperty(window, "zenx", {
  value: {
    plugins: {
      executeCommand: (_pluginId: string, command: string, input?: unknown) =>
        sdk.commands.execute(command, input),
      readHandle: async () => ({}),
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <main style={{ height: "100vh", overflow: "hidden" }}>
    <PluginProductPage
      snapshot={snapshot}
      route="/plugins/imzenx/connection"
      navigate={() => {}}
    />
  </main>,
);
