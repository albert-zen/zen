import React, { useState } from "react";

import type { ToolInvocation } from "../../../../src/tool.js";
import type {
  ZenXCapabilityPackage,
  ZenXPluginManifestV2,
} from "../../src/main/capabilities/types.js";
import type {
  PluginUiModule,
  PluginUiSurfaceProps,
} from "../../src/renderer/src/plugin-ui-host.js";

export const WORKBENCH_PLUGIN_ID = "workbench";
export const WORKBENCH_UI_ENTRY = "zenx/test-fixtures/workbench";

export class ZenXWorkbenchFixturePackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXPluginManifestV2 = {
    schemaVersion: 2,
    id: WORKBENCH_PLUGIN_ID,
    name: "Workbench",
    version: "1.0.0",
    description: "Generic UI Host product fixture",
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: { type: "bundled", entry: "zenx/test-fixtures/workbench-runtime" },
    mainDocument: "Use Workbench to verify the generic ZenX plugin UI host.",
    provider: {
      id: "workbench-bundled",
      platforms: ["*"],
      interactionModes: ["background_safe"],
      capabilities: ["workbench.refresh"],
    },
    permissions: [],
    tools: [
      {
        name: "workbench_refresh",
        description: "Refresh the Workbench fixture",
        inputSchema: { type: "object" },
        permissions: [],
        interactionMode: "background_safe",
        capabilities: ["workbench.refresh"],
      },
    ],
    resources: [],
    ui: {
      bundles: [
        {
          id: "main",
          apiVersion: 1,
          kind: "trusted",
          entry: WORKBENCH_UI_ENTRY,
        },
      ],
      surfaces: [
        { id: "overview", bundleId: "main", exportName: "overview" },
        { id: "details", bundleId: "main", exportName: "details" },
        { id: "preferences", bundleId: "main", exportName: "preferences" },
        { id: "status", bundleId: "main", exportName: "status" },
      ],
    },
    contributions: {
      pages: [
        {
          id: "home",
          title: "Workbench",
          route: "/plugins/workbench/home",
          surfaceId: "overview",
        },
      ],
      subroutes: [
        {
          id: "details",
          pageId: "home",
          title: "Workbench details",
          route: "/plugins/workbench/home/details",
          surfaceId: "details",
        },
      ],
      sidebar: [
        {
          id: "home",
          label: "Workbench",
          icon: "plug",
          pageId: "home",
          order: 30,
        },
      ],
      settings: [
        {
          id: "preferences",
          title: "Workbench preferences",
          surfaceId: "preferences",
        },
      ],
      panels: [
        { id: "status", title: "Workbench status", surfaceId: "status" },
      ],
      commands: [
        {
          id: "refresh",
          title: "Refresh Workbench",
          tool: "workbench_refresh",
        },
      ],
      menus: [
        {
          id: "refresh-page",
          label: "Refresh",
          commandId: "refresh",
          location: "page",
        },
      ],
    },
  };

  async invoke(
    _toolName: string,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    invocation.signal.throwIfAborted();
    return {
      ok: true,
      command: "refresh",
      callId: invocation.callId,
    };
  }
}

function Overview({ sdk }: PluginUiSurfaceProps) {
  const [reply, setReply] = useState("Ready");
  return (
    <div className="workbench-card">
      <p className="eyebrow">Plugin UI SDK v{sdk.version}</p>
      <h2>Workbench</h2>
      <p>A generic bundled surface mounted inside the ZenX workspace.</p>
      <div className="plugin-action-row">
        <button
          type="button"
          onClick={() =>
            sdk.navigation.navigate("/plugins/workbench/home/details")
          }
        >
          Open details
        </button>
        <button
          type="button"
          onClick={() => {
            void sdk.commands.execute("refresh").then((value) => {
              const result = value as { result?: { ok?: boolean } };
              setReply(result.result?.ok === true ? "Refreshed" : "Completed");
            });
          }}
        >
          Refresh
        </button>
      </div>
      <p role="status">{reply}</p>
    </div>
  );
}

function Details({ sdk }: PluginUiSurfaceProps) {
  return (
    <div className="workbench-card">
      <p className="eyebrow">Subroute</p>
      <h2>Workbench details</h2>
      <p>Theme from the shared UI SDK: {sdk.theme}</p>
      <button
        type="button"
        onClick={() => sdk.navigation.navigate("/plugins/workbench/home")}
      >
        Back to overview
      </button>
    </div>
  );
}

function Preferences({ sdk }: PluginUiSurfaceProps) {
  return (
    <div className="workbench-card">
      <h3>Workbench preferences</h3>
      <p>Host context handle: {String(sdk.context.handleId)}</p>
    </div>
  );
}

function Status() {
  return (
    <div
      className="workbench-panel"
      role="status"
      aria-label="Workbench status"
    >
      Workbench is connected through the generic panel surface.
    </div>
  );
}

export const workbenchPluginUi: PluginUiModule = {
  overview: Overview,
  details: Details,
  preferences: Preferences,
  status: Status,
};
