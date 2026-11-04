import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import React from "react";

import type { CommandItem } from "../../protocol-client/index.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import {
  GenericPluginUiHost,
  type PluginUiRegistry,
} from "./plugin-ui-host.js";

import {
  resolveToolResultPresentation,
  toolResultFallbackText,
} from "./tool-result-presentation.js";

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
  useTranslation("panels");
  const presentation = resolveToolResultPresentation(item, snapshot, registry);
  if (presentation.kind === "fallback" || !snapshot || !registry)
    return <ToolResultFallback item={item} />;
  return (
    <GenericPluginUiHost
      registry={registry}
      snapshot={snapshot}
      pluginId={presentation.pluginId}
      surfaceId={presentation.surfaceId}
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
  useTranslation("panels");
  const { structured: json, output } = toolResultFallbackText(item);
  return (
    <section
      className="tool-result-fallback"
      aria-label={i18n.t("panels:toolResult")}
    >
      {json === null ? null : (
        <pre
          data-thread-find-item-id={item.id}
          data-thread-find-field="tool-structured"
        >
          {json}
        </pre>
      )}
      {output ? (
        <pre data-thread-find-item-id={item.id} data-thread-find-field="output">
          {output}
        </pre>
      ) : null}
      {item.exitCode === null ? null : (
        <small>
          {i18n.t("panels:exitCode")} {item.exitCode}
        </small>
      )}
    </section>
  );
}
