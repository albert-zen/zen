import type { PluginRequirement } from "./plugin-readiness.js";

/** Preset guidance only: these plugins keep the same APIs for every Agent. */
export const PAW_PLUGIN_REQUIREMENTS: readonly PluginRequirement[] =
  Object.freeze([
    { pluginId: "zenx-rooms", purpose: "Chat and memory", required: true },
    {
      pluginId: "zenx-triggers",
      purpose: "Reply to new messages",
      required: true,
    },
    {
      pluginId: "zenx-self-control",
      purpose: "Work with conversations",
      required: false,
    },
    { pluginId: "zenx-subagents", purpose: "Delegate work", required: false },
  ]);
