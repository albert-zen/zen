import { createHash } from "node:crypto";
import type { ModelTool } from "../model.js";

/** Deliberately deny unknown routes and model aliases; API compatibility is not capability. */
export function supportsHostedToolSearch(
  endpoint: string,
  model: string,
): boolean {
  const url = new URL(endpoint);
  return (
    url.origin === "https://api.openai.com" &&
    url.pathname === "/v1/responses" &&
    ["gpt-5.4", "gpt-6-astra"].includes(model.trim())
  );
}

/** Stable plugin namespace identity, independent of catalog order and discovery history. */
export function pluginToolNamespace(pluginId: string): string {
  return `plugin_${pluginId.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 38)}_${createHash("sha256").update(pluginId).digest("hex").slice(0, 16)}`;
}

export function responsesToolPresentation(
  tools: readonly ModelTool[],
  native: boolean,
): { tools: Record<string, unknown>[]; namespaces: Map<string, string> } {
  const output: Record<string, unknown>[] = [];
  const groups = new Map<string, Record<string, unknown>[]>();
  const namespaces = new Map<string, string>();
  for (const tool of [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const pluginId = tool.pluginId;
    const deferred = native && pluginId !== undefined;
    const definition = {
      type: "function",
      name: tool.name,
      description: deferred
        ? (tool.fullDescription ?? tool.description)
        : tool.description,
      parameters: tool.inputSchema,
      strict: false,
      ...(deferred ? { defer_loading: true } : {}),
    };
    if (deferred) {
      const namespace = pluginToolNamespace(pluginId);
      namespaces.set(tool.name, namespace);
      const group = groups.get(pluginId) ?? [];
      group.push(definition);
      groups.set(pluginId, group);
    } else output.push(definition);
  }
  for (const [pluginId, definitions] of [...groups].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    output.push({
      type: "namespace",
      name: pluginToolNamespace(pluginId),
      description: `Tools provided by the ${pluginId} plugin.`,
      tools: definitions,
    });
  }
  if (groups.size > 0) output.push({ type: "tool_search" });
  return { tools: output, namespaces };
}
