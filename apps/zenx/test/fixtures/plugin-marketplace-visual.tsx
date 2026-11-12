import React from "react";
import { createRoot } from "react-dom/client";

import type { ZenXPluginSnapshot } from "../../src/main/capabilities/types.js";
import { PluginSettings } from "../../src/renderer/src/PluginSettings.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

const snapshot: ZenXPluginSnapshot = {
  plugins: [
    plugin("browser", "Browser", "@zenx/browser-plugin", "enabled", 0),
    plugin("zenx-rooms", "Rooms", "@zenx/rooms-plugin", "enabled", 2),
    plugin(
      "zenx-self-control",
      "ZenX self-control",
      "@zenx/self-control-plugin",
      "installed",
      0,
    ),
    plugin(
      "zenx-triggers",
      "Triggers",
      "@zenx/triggers-plugin",
      "uninstalled",
      1,
    ),
    {
      ...plugin("local-notes", "Local notes", "local-notes", "installed", 0),
      source: "local",
      profileSource: {
        mode: "local-copy",
        packageSpec: "/Users/demo/plugins/local-notes",
        resolvedSpec: "file:local-notes",
        packageName: "local-notes",
        packageVersion: "0.8.0",
      },
      version: "0.8.0",
      description: "Keep private notes through a narrow local tool.",
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

Object.defineProperty(window, "zenx", {
  value: {
    marketplace: {
      get: async () => ({
        entries: [],
        builtIns: [
          builtIn(
            "browser",
            "@zenx/browser-plugin",
            "Browser",
            "Browse and act on web pages through the selected local provider.",
          ),
          builtIn(
            "computer",
            "@zenx/computer-plugin",
            "Computer",
            "Inspect and control desktop applications with platform-aware actions.",
            false,
            "No computer provider is available for this platform.",
          ),
          builtIn(
            "zenx-rooms",
            "@zenx/rooms-plugin",
            "Rooms",
            "Coordinate shared conversations and route explicit member mentions.",
          ),
          builtIn(
            "zenx-self-control",
            "@zenx/self-control-plugin",
            "ZenX self-control",
            "Let the Agent work with ZenX Projects, Threads, and turns.",
          ),
          builtIn(
            "zenx-triggers",
            "@zenx/triggers-plugin",
            "Triggers",
            "Wake Agents from timers, signals, and completed work.",
          ),
        ],
      }),
    },
    plugins: {
      get: async () => snapshot,
      onChange: () => () => {},
      setEnabled: async () => ({
        snapshot,
        capabilityRefresh: { status: "refreshed" },
      }),
      selectTarball: async () => ({ canceled: true }),
      installBuiltIn: async () => ({
        snapshot,
        capabilityRefresh: { status: "refreshed" },
      }),
      installSource: async () => ({
        snapshot,
        capabilityRefresh: { status: "refreshed" },
      }),
      update: async () => ({
        snapshot,
        capabilityRefresh: { status: "refreshed" },
      }),
      uninstall: async () => ({
        snapshot,
        capabilityRefresh: { status: "refreshed" },
      }),
      reinstall: async () => ({
        snapshot,
        capabilityRefresh: { status: "refreshed" },
      }),
      deleteData: async () => {},
    },
  },
});

document.body.style.overflow = "auto";
const shell = document.createElement("style");
shell.textContent = `
  html, #root { height: auto; overflow: visible; }
  body { min-width: 320px; min-height: 100vh; background: var(--main); }
  .visual-shell { width: min(1120px, calc(100vw - 48px)); margin: 0 auto; padding: 34px 0 60px; }
  .visual-shell > header { margin: 0 0 22px; padding-bottom: 14px; border-bottom: 1px solid var(--border-soft); }
  .visual-shell > header span { color: var(--text-3); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
  .visual-shell > header h1 { margin: 5px 0 0; font-size: 20px; font-weight: 580; }
`;
document.head.append(shell);

createRoot(document.getElementById("root")!).render(
  <main className="visual-shell">
    <header>
      <span>Settings</span>
      <h1>Plugins</h1>
    </header>
    <PluginSettings />
  </main>,
);

function plugin(
  id: string,
  displayName: string,
  packageName: string,
  lifecycle: "enabled" | "installed" | "uninstalled",
  contributionCount: number,
) {
  return {
    id,
    displayName,
    version: "1.0.0",
    source: "bundled" as const,
    profileSource: {
      mode: "bundled" as const,
      packageSpec: `/Applications/ZenX/resources/plugins/${id}.tgz`,
      resolvedSpec: `file:${id}.tgz`,
      packageName,
      packageVersion: "1.0.0",
    },
    lifecycle,
    enabled: lifecycle === "enabled",
    available: lifecycle !== "uninstalled",
    contributionCount,
  };
}

function builtIn(
  pluginId: string,
  packageName: string,
  name: string,
  description: string,
  available = true,
  unavailableReason?: string,
) {
  return {
    pluginId,
    packageName,
    name,
    description,
    icon:
      pluginId === "browser"
        ? "search"
        : pluginId === "computer"
          ? "panel-right"
          : pluginId === "zenx-rooms"
            ? "users"
            : pluginId === "zenx-triggers"
              ? "trigger"
              : "layers",
    available,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}
