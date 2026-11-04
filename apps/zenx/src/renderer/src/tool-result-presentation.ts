import type { CommandItem } from "../../protocol-client/index.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type { PluginUiRegistry } from "./plugin-ui-host.js";

export interface ToolResultPresentationContext {
  snapshot: ZenXPluginSnapshot | null;
  registry: PluginUiRegistry | null;
}
export type ToolResultPresentation =
  | { kind: "fallback" }
  | { kind: "plugin"; pluginId: string; surfaceId: string };

/** One read-only branch contract for the real renderer and its disposable Find projection. */
export function resolveToolResultPresentation(
  item: Pick<CommandItem, "contentType" | "structuredContent">,
  snapshot: ZenXPluginSnapshot | null,
  registry: PluginUiRegistry | null,
): ToolResultPresentation {
  const renderer = snapshot?.resultRenderers?.find(
    (candidate) => candidate.contentType === item.contentType,
  );
  const surface = snapshot?.surfaces.find(
    (candidate) =>
      candidate.pluginId === renderer?.pluginId &&
      candidate.id === renderer.surfaceId,
  );
  const bundle = snapshot?.bundles.find(
    (candidate) =>
      candidate.pluginId === renderer?.pluginId &&
      candidate.id === surface?.bundleId,
  );
  const available =
    surface !== undefined &&
    bundle !== undefined &&
    bundle.apiVersion === 1 &&
    (bundle.kind === "isolated" ||
      registry?.resolveTrusted(bundle.entry)?.[surface.exportName] !==
        undefined);
  return renderer !== undefined &&
    snapshot !== null &&
    registry !== null &&
    available &&
    item.structuredContent !== undefined
    ? {
        kind: "plugin",
        pluginId: renderer.pluginId,
        surfaceId: renderer.surfaceId,
      }
    : { kind: "fallback" };
}

/** These are precisely the two preformatted bodies the fallback component displays. */
export function toolResultFallbackText(item: CommandItem) {
  return {
    structured:
      item.structuredContent === undefined
        ? null
        : JSON.stringify(item.structuredContent, null, 2),
    output: item.aggregatedOutput || null,
  };
}

/** Registry membership can change without changing registry identity. Never invoke a plugin surface. */
export function toolResultPresentationKey(
  snapshot: ZenXPluginSnapshot | null,
  registry: PluginUiRegistry | null,
): string {
  return JSON.stringify(
    snapshot?.resultRenderers?.map((renderer) => [
      renderer.contentType,
      resolveToolResultPresentation(
        { contentType: renderer.contentType, structuredContent: {} },
        snapshot,
        registry,
      ),
    ]) ?? [],
  );
}
