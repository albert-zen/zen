import { useTranslation } from "react-i18next";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import {
  GenericPluginUiHost,
  type PluginUiRegistry,
} from "./plugin-ui-host.js";
import { conversationKey, type BoardConversation } from "./board-ui-state.js";
import { Icon } from "./icons.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/controls.js";

/** A separate contribution slot: no resource tab, navigation or execution ownership. */
export function PluginInformationHost({
  snapshot,
  registry,
  owner,
  theme,
  navigate,
  executeCommand,
  readHandle,
  resourcePanelWidth = 0,
}: {
  snapshot: ZenXPluginSnapshot;
  registry: PluginUiRegistry;
  owner: BoardConversation;
  theme: "light" | "dark";
  navigate(route: string): void;
  executeCommand(
    pluginId: string,
    commandId: string,
    input?: unknown,
  ): Promise<unknown>;
  readHandle(pluginId: string, handleId: string): Promise<unknown>;
  resourcePanelWidth?: number;
}) {
  const { t } = useTranslation("panels");
  const contributions = snapshot.information ?? [];
  const ownerKey = conversationKey(owner);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(contributions[0]?.key ?? "");
  const trigger = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [headerBottom, setHeaderBottom] = useState(0);
  useLayoutEffect(() => {
    const workspace = toolbar.current?.closest(".workspace");
    if (!workspace) return;
    const heading = workspace.querySelector<HTMLElement>(
      '.auxiliary-panel[data-open="true"] > .auxiliary-heading',
    );
    const measure = () => {
      const bottom = heading?.getBoundingClientRect().bottom ?? 0;
      setHeaderBottom(bottom);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(workspace);
    if (heading) observer?.observe(heading);
    return () => observer?.disconnect();
    // A late-admitted contribution mounts the toolbar after the initial null render.
  }, [resourcePanelWidth, contributions.length]);
  useEffect(() => {
    setOpen(false);
  }, [ownerKey, contributions.length === 0]);
  const active =
    contributions.find((item) => item.key === selected) ?? contributions[0];
  if (!active) return null;
  const admissionId = snapshot.plugins.find(
    (plugin) => plugin.id === active.pluginId,
  )?.admissionId;
  const surface = (
    <GenericPluginUiHost
      key={`${active.key}:${ownerKey}`}
      registry={registry}
      snapshot={snapshot}
      pluginId={active.pluginId}
      surfaceId={active.surfaceId}
      context={{ owner, admissionId }}
      theme={theme}
      navigate={navigate}
      executeCommand={executeCommand}
      readHandle={readHandle}
      className="information-content"
    />
  );
  const tabs =
    contributions.length > 1 ? (
      <nav className="information-tabs" aria-label={t("boardViews")}>
        {contributions.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={item.key === active.key}
            onClick={() => {
              setSelected(item.key);
            }}
          >
            {item.title}
          </button>
        ))}
      </nav>
    ) : null;
  return (
    <div ref={toolbar} className="information-toolbar">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            className="icon-button"
            aria-label={t("boardTitle")}
            title={t("boardTitle")}
            aria-pressed={open}
          >
            <Icon name="list-detail" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          className="information-popover"
          style={{
            maxHeight: `min(720px, calc(100vh - ${Math.max(headerBottom, trigger.current?.getBoundingClientRect().bottom ?? 44) + 16}px))`,
          }}
          sideOffset={Math.max(
            8,
            headerBottom -
              (trigger.current?.getBoundingClientRect().bottom ?? 0) +
              8,
          )}
          aria-label={active.title}
        >
          {tabs}
          {surface}
        </PopoverContent>
      </Popover>
    </div>
  );
}
