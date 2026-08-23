import type {
  ZenXPluginPageProjection,
  ZenXPluginSidebarProjection,
  ZenXPluginSnapshot,
} from "../../main/capabilities/types.js";

export interface LoadedPluginContribution extends ZenXPluginSidebarProjection {
  page: ZenXPluginPageProjection;
}

export function loadedPluginContributions(
  snapshot: ZenXPluginSnapshot | null,
): LoadedPluginContribution[] {
  if (snapshot === null) return [];
  const pages = new Map(
    snapshot.pages.map((page) => [`${page.pluginId}:${page.id}`, page]),
  );
  return snapshot.sidebar
    .flatMap((contribution) => {
      const page = pages.get(`${contribution.pluginId}:${contribution.pageId}`);
      return page === undefined ? [] : [{ ...contribution, page }];
    })
    .sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        left.key.localeCompare(right.key),
    );
}
