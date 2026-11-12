import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

/** Synthetic admitted contributions; no real conversations, credentials or Host. */
export const workspaceLauncherSnapshot: ZenXPluginSnapshot = {
  plugins: ["browser", "computer", "zenx-subagents", "zenx-triggers"].map(
    (id) => ({
      id,
      displayName: id,
      version: "1.0.0",
      source: "bundled",
      lifecycle: "enabled",
      enabled: true,
      available: true,
      contributionCount: 1,
    }),
  ),
  panels: [
    {
      key: "zenx-subagents:subagents",
      pluginId: "zenx-subagents",
      id: "subagents",
      title: "Subagents",
      surfaceId: "subagents-panel",
      order: 0,
    },
    {
      key: "zenx-triggers:triggers",
      pluginId: "zenx-triggers",
      id: "triggers",
      title: "Triggers",
      surfaceId: "trigger-panel",
      order: 1,
    },
  ],
  bundles: [
    {
      key: "zenx-subagents:main",
      pluginId: "zenx-subagents",
      id: "main",
      apiVersion: 1,
      kind: "trusted",
      entry: "zenx/bundled/subagents-ui",
    },
    {
      key: "zenx-triggers:main",
      pluginId: "zenx-triggers",
      id: "main",
      apiVersion: 1,
      kind: "trusted",
      entry: "zenx/bundled/triggers-ui",
    },
  ],
  surfaces: [
    {
      key: "zenx-subagents:subagents-panel",
      pluginId: "zenx-subagents",
      id: "subagents-panel",
      bundleId: "main",
      exportName: "subagents-panel",
    },
    {
      key: "zenx-triggers:trigger-panel",
      pluginId: "zenx-triggers",
      id: "trigger-panel",
      bundleId: "main",
      exportName: "trigger-panel",
    },
  ],
  sidebar: [],
  pages: [],
  subroutes: [],
  settings: [],
  commands: [],
  menus: [],
};
