import type {
  ZenXCapabilitySnapshot,
  ZenXCapabilityUiContribution,
} from "../../main/capabilities/types.js";

export interface LoadedPluginContribution
  extends ZenXCapabilityUiContribution {
  capabilityId: string;
  available: boolean;
}

export function loadedPluginContributions(
  snapshot: ZenXCapabilitySnapshot | null,
): LoadedPluginContribution[] {
  if (snapshot === null) return [];
  return snapshot.contributions
    .filter(
      (contribution) =>
        contribution.slot === "sidebar-plugin-space" &&
        contribution.available &&
        contribution.enabled,
    )
    .sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    );
}
