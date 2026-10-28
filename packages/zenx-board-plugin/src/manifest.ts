import type { ZenXPluginManifestV2 } from "@zenx/plugin-sdk";
export const boardManifest = {
  schemaVersion: 2,
  id: "zenx-board",
  name: "Board",
  version: "1.0.0",
  description:
    "Agent-defined interactive information boards with isolated custom content.",
  compatibility: {
    zenx: ">=0.1.0 <0.2.0",
  },
  runtime: {
    type: "bundled",
    entry: "./dist/runtime.js",
  },
  storageVersion: 1,
  mainDocument:
    "Read and compose the current conversation information Board. Use short document/block/event IDs. put replaces the document but preserves user-owned field values; read returns compact semantic state, never full HTML. Templates (notes, metrics, progress, fields, actions) compose freely with custom isolated HTML/CSS/JS. UI events alone may deliver assembled text or execute scripts; model tools cannot invoke human events. Submit text interpolates {{field}}. Scripts use only {{valuesBase64}} (base64 JSON of fields) so user input is not shell code. if conditions may inspect result.exitCode/result.output after a script. Owner defaults to the calling Thread; explicit Room owner must use that exact member Thread. No model message is sent merely by updating or reading a Board.",
  provider: {
    id: "zenx-board",
    platforms: ["*"],
    interactionModes: ["background_safe"],
    capabilities: ["zenx.board.manage"],
  },
  permissions: [
    {
      id: "zenx-board.manage",
      title: "Manage information boards",
      description:
        "Read and update conversation-owned Board documents; explicit user events use existing Host permissions.",
      scope: "workspace",
    },
  ],
  tools: [
    {
      name: "zenx_board_put",
      description:
        "Replace the current information Board document, preserving all user-owned draft values. No model delivery or execution occurs.",
      inputSchema: {
        type: "object",
        properties: {
          document: {
            type: "object",
          },
        },
        required: ["document"],
        additionalProperties: false,
      },
      permissions: ["zenx-board.manage"],
      interactionMode: "background_safe",
      capabilities: ["zenx.board.manage"],
    },
    {
      name: "zenx_board_read",
      description:
        "Read compact semantic Board state and short event/field IDs; never full HTML.",
      inputSchema: {
        type: "object",
        properties: {
          owner: {
            type: "object",
          },
        },
        required: [],
        additionalProperties: false,
      },
      permissions: ["zenx-board.manage"],
      interactionMode: "background_safe",
      capabilities: ["zenx.board.manage"],
    },
    {
      name: "zenx_board_ui",
      description: "Human UI only; unavailable to models.",
      inputSchema: {
        type: "object",
        properties: {
          input: {
            type: "object",
          },
        },
        required: ["input"],
        additionalProperties: false,
      },
      permissions: ["zenx-board.manage"],
      interactionMode: "background_safe",
      capabilities: ["zenx.board.manage"],
    },
  ],
  contributions: {
    information: [
      {
        id: "board",
        title: "Board",
        surfaceId: "board",
      },
    ],
    commands: [
      {
        id: "ui",
        title: "Board interaction",
        tool: "zenx_board_ui",
      },
    ],
  },
  ui: {
    bundles: [
      {
        id: "board",
        apiVersion: 1,
        kind: "trusted",
        entry: "zenx/bundled/board-ui",
      },
    ],
    surfaces: [
      {
        id: "board",
        bundleId: "board",
        exportName: "board",
      },
    ],
  },
} as const satisfies ZenXPluginManifestV2;
