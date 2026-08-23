import React from "react";

import type { CommandItem } from "../../protocol-client/index.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import {
  GenericPluginUiHost,
  type PluginUiRegistry,
} from "./plugin-ui-host.js";

export function ToolResultRenderer({
  item,
  snapshot,
  registry,
  theme,
}: {
  item: CommandItem;
  snapshot: ZenXPluginSnapshot | null;
  registry: PluginUiRegistry | null;
  theme: "light" | "dark";
}) {
  const renderer = (snapshot?.resultRenderers ?? []).find(
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
  const rendererAvailable =
    surface !== undefined &&
    bundle !== undefined &&
    bundle.apiVersion === 1 &&
    (bundle.kind === "isolated" ||
      registry?.resolveTrusted(bundle.entry)?.[surface.exportName] !==
        undefined);
  if (
    renderer === undefined ||
    snapshot === null ||
    registry === null ||
    !rendererAvailable ||
    item.structuredContent === undefined
  ) {
    return <ToolResultFallback item={item} />;
  }
  return (
    <GenericPluginUiHost
      registry={registry}
      snapshot={snapshot}
      pluginId={renderer.pluginId}
      surfaceId={renderer.surfaceId}
      context={{
        contentType: item.contentType,
        structuredContent: item.structuredContent,
        fallback: {
          output: item.aggregatedOutput ?? "",
          exitCode: item.exitCode,
        },
      }}
      theme={theme}
      executeCommand={window.zenx.plugins.executeCommand}
      readHandle={window.zenx.plugins.readHandle}
      className="plugin-result-surface"
    />
  );
}

export function ToolResultFallback({ item }: { item: CommandItem }) {
  const json =
    item.structuredContent === undefined
      ? null
      : JSON.stringify(item.structuredContent, null, 2);
  return (
    <section className="tool-result-fallback" aria-label="Tool result">
      {json === null ? null : <pre>{json}</pre>}
      {item.aggregatedOutput ? <pre>{item.aggregatedOutput}</pre> : null}
      {item.exitCode === null ? null : <small>Exit code {item.exitCode}</small>}
    </section>
  );
}
