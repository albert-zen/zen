import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXCapabilityPackage, ZenXPluginManifestV2 } from "./types.js";

export const WORKBENCH_PLUGIN_ID = "workbench";

export class ZenXWorkbenchFixturePackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXPluginManifestV2 = {
    schemaVersion: 2,
    id: WORKBENCH_PLUGIN_ID,
    name: "Workbench",
    version: "1.0.0",
    description: "Generic UI Host product fixture",
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: { type: "bundled", entry: "zenx/fixtures/workbench-runtime" },
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
          entry: "zenx/fixtures/workbench",
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
