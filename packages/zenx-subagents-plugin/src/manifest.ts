import type { ZenXPluginManifestV2 } from "@zenx/plugin-sdk";

export const subagentsManifest = {
  schemaVersion: 2,
  id: "zenx-subagents",
  name: "Subagents",
  version: "1.0.0",
  description: "Create and inspect native child Threads.",
  compatibility: {
    zenx: ">=0.1.0 <0.2.0",
  },
  runtime: {
    type: "bundled",
    entry: "./dist/runtime.js",
  },
  mainDocument: "Subagents tools: create, list, send, read.",
  provider: {
    id: "zenx-app-server",
    platforms: ["*"],
    interactionModes: ["background_safe"],
    capabilities: ["zenx.subagents.manage"],
  },
  permissions: [
    {
      id: "zenx-subagents.read",
      title: "Read Threads",
      description: "Read native Thread relationships and public history.",
      scope: "workspace",
    },
    {
      id: "zenx-subagents.write",
      title: "Manage child Threads",
      description: "Create native child Threads and submit explicit messages.",
      scope: "local-device",
    },
  ],
  tools: [
    {
      name: "zenx_subagents_create",
      description:
        "Create a native child Thread. side-chat snapshots the full parent context and waits for the user without starting a Turn. fresh/fork may optionally submit an explicit task; delivery reports acceptance, not completion.",
      inputSchema: {
        type: "object",
        properties: {
          parentThreadId: {
            type: "string",
          },
          mode: {
            type: "string",
            enum: ["fresh", "fork", "side-chat"],
          },
          title: {
            type: "string",
            maxLength: 256,
          },
          task: {
            type: "string",
            maxLength: 100000,
          },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      permissions: ["zenx-subagents.write"],
      interactionMode: "background_safe",
      capabilities: ["zenx.subagents.manage"],
      maxOutputBytes: 524288,
    },
    {
      name: "zenx_subagents_list",
      description:
        "List native descendant Thread summaries for a parent Thread, including canonical relationships and status.",
      inputSchema: {
        type: "object",
        properties: {
          parentThreadId: {
            type: "string",
          },
        },
        additionalProperties: false,
      },
      permissions: ["zenx-subagents.read"],
      interactionMode: "background_safe",
      capabilities: ["zenx.subagents.manage"],
      maxOutputBytes: 524288,
    },
    {
      name: "zenx_subagents_send",
      description:
        "Send agent text to a Thread. Defaults to prompt guidance in active work; explicit follow_up batches next work, and replacement interrupts current work.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Full Thread ID, unique ID prefix, or exact title. Ambiguous targets return candidates without writing.",
          },
          workspace: {
            type: "string",
            description: "Optional workspace path to disambiguate the target.",
          },
          messageType: {
            type: "string",
            enum: ["follow_up", "guidance", "replacement"],
            description:
              "follow_up: batch this with next work after the current Turn; guidance: add guidance to current work; replacement: interrupt current work and do this instead. Omit to deliver agent guidance promptly to active work, independent of the manual Composer preference.",
          },
          text: {
            type: "string",
          },
        },
        required: ["target", "text"],
        additionalProperties: false,
      },
      permissions: ["zenx-subagents.write"],
      interactionMode: "background_safe",
      capabilities: ["zenx.subagents.manage"],
      maxOutputBytes: 524288,
    },
    {
      name: "zenx_subagents_read",
      description:
        "Read the existing public Thread history projection, including actual Agent messages.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Full Thread ID, unique ID prefix, or exact title. Ambiguous targets return candidates without writing.",
          },
          workspace: {
            type: "string",
            description: "Optional workspace path to disambiguate the target.",
          },
          granularity: {
            type: "string",
            enum: ["turns", "items", "agent_messages", "item"],
          },
          turnId: {
            type: "string",
          },
          itemId: {
            type: "string",
          },
          cursor: {
            type: "string",
          },
          maxTurns: {
            type: "integer",
            minimum: 1,
            maximum: 20,
          },
          maxItemsPerTurn: {
            type: "integer",
            minimum: 1,
            maximum: 25,
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      permissions: ["zenx-subagents.read"],
      interactionMode: "background_safe",
      capabilities: ["zenx.subagents.manage"],
      maxOutputBytes: 524288,
    },
  ],
  ui: {
    bundles: [
      {
        id: "main",
        apiVersion: 1,
        kind: "trusted",
        entry: "zenx/bundled/subagents-ui",
      },
    ],
    surfaces: [
      {
        id: "subagents-panel",
        bundleId: "main",
        exportName: "subagents-panel",
      },
    ],
  },
  contributions: {
    panels: [
      {
        id: "subagents",
        title: "Subagents",
        surfaceId: "subagents-panel",
      },
    ],
    commands: [
      {
        id: "create",
        title: "Create Subagents",
        tool: "zenx_subagents_create",
      },
      {
        id: "list",
        title: "List Subagents",
        tool: "zenx_subagents_list",
      },
      {
        id: "send",
        title: "Send Subagents",
        tool: "zenx_subagents_send",
      },
      {
        id: "read",
        title: "Read Subagents",
        tool: "zenx_subagents_read",
      },
    ],
  },
} satisfies ZenXPluginManifestV2;
