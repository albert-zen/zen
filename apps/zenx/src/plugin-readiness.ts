import type { ZenXPluginReadinessSummary } from "./main/capabilities/types.js";

export interface PluginRequirement {
  pluginId: string;
  purpose: string;
  required: boolean;
}

export interface PluginReadiness {
  pluginId: string;
  name: string;
  state: "ready" | "missing" | "disabled" | "unavailable";
  action: "none" | "install" | "enable" | "repair";
}

/** A non-authoritative catalog projection; readiness never grants permission. */
export function pluginReadiness(
  plugins: readonly ZenXPluginReadinessSummary[],
  pluginIds: readonly string[],
): PluginReadiness[] {
  return [...new Set(pluginIds)].map((pluginId) => {
    const plugin = plugins.find((entry) => entry.id === pluginId);
    const name = plugin?.displayName ?? pluginId;
    if (!plugin || plugin.lifecycle === "uninstalled")
      return { pluginId, name, state: "missing", action: "install" };
    if (!plugin.available)
      return { pluginId, name, state: "unavailable", action: "repair" };
    if (!plugin.enabled)
      return { pluginId, name, state: "disabled", action: "enable" };
    return { pluginId, name, state: "ready", action: "none" };
  });
}

export function requirementsReady(
  requirements: readonly PluginRequirement[],
  readiness: readonly PluginReadiness[],
): boolean {
  return requirements.every(
    (requirement) =>
      !requirement.required ||
      readiness.some(
        (entry) =>
          entry.pluginId === requirement.pluginId && entry.state === "ready",
      ),
  );
}
