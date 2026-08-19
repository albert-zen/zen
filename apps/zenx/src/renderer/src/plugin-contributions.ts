import type {
  ZenXPluginSidebarProjection,
  ZenXPluginSnapshot,
} from "../../main/capabilities/types.js";

export interface LoadedPluginContribution
  extends ZenXPluginSidebarProjection {
  page: "triggers" | "rooms";
}

export function loadedPluginContributions(
  snapshot: ZenXPluginSnapshot | null,
): LoadedPluginContribution[] {
  if (snapshot === null) return [];
  return snapshot.sidebar
    .filter((contribution) =>
      contribution.pageId === "triggers" || contribution.pageId === "rooms",
    )
    .map((contribution) => ({
      ...contribution,
      page: contribution.pageId as "triggers" | "rooms",
    }))
    .sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) || left.key.localeCompare(right.key),
    );
}
