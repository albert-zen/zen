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
  const storageKey = `zenx.information.pin.${ownerKey}`;
  const [pin, setPin] = useState<string | null>(() => readPin(storageKey));
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(contributions[0]?.key ?? "");
  const trigger = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLElement>(null);
  const focusAfterPin = useRef(false);
  const [floating, setFloating] = useState(false);
  useLayoutEffect(() => {
    const workspace = toolbar.current?.closest(".workspace");
    if (!workspace) return;
    const measure = () =>
      setFloating(
        workspace.getBoundingClientRect().width - resourcePanelWidth - 320 <
          360,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [resourcePanelWidth]);
  useEffect(() => {
    if (!pin || !focusAfterPin.current) return;
    const frame = requestAnimationFrame(() => {
      rail.current
        ?.querySelector<HTMLButtonElement>("[data-information-pin]")
        ?.focus();
      focusAfterPin.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [pin]);
  useEffect(() => {
    setPin(readPin(storageKey));
    setOpen(false);
  }, [storageKey]);
  const pinned = contributions.find((item) => item.key === pin);
  const active =
    pinned ??
    contributions.find((item) => item.key === selected) ??
    contributions[0];
  const changePin = (key: string | null) => {
    try {
      if (key) localStorage.setItem(storageKey, key);
      else localStorage.removeItem(storageKey);
    } catch {
      /* Storage may be disabled; retain this window's explicit presentation choice. */
    }
    setPin(key);
  };
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
  const header = (
    <header className="information-header">
      <div className="information-title">
        <Icon name="list-detail" size={16} />
        <strong>{active.title}</strong>
      </div>
      <div className="information-header-actions">
        <button
          type="button"
          className="icon-button"
          data-information-pin
          title={pinned ? t("boardUnpin") : t("boardPin")}
          aria-label={pinned ? t("boardUnpin") : t("boardPin")}
          onClick={() => {
            if (pinned) {
              changePin(null);
              setOpen(true);
            } else {
              focusAfterPin.current = true;
              changePin(active.key);
              setOpen(false);
            }
          }}
        >
          <Icon name={pinned ? "pin-off" : "pin"} size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t("boardClose")}
          onClick={() => {
            changePin(null);
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
    </header>
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
              if (pinned) changePin(item.key);
            }}
          >
            {item.title}
          </button>
        ))}
      </nav>
    ) : null;
  return (
    <>
      <div ref={toolbar} className="information-toolbar">
        <Popover open={open && !pinned} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              ref={trigger}
              type="button"
              className="icon-button"
              aria-label={t("boardTitle")}
              title={t("boardTitle")}
              aria-pressed={Boolean(pinned)}
              onClick={
                pinned
                  ? () => {
                      changePin(null);
                      setOpen(false);
                    }
                  : undefined
              }
            >
              <Icon name="list-detail" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="end"
            className="information-popover"
            aria-label={active.title}
            onCloseAutoFocus={(event) => {
              if (pinned) event.preventDefault();
            }}
          >
            {header}
            {tabs}
            {surface}
          </PopoverContent>
        </Popover>
      </div>
      {pinned ? (
        <aside
          ref={rail}
          data-floating={floating}
          className="information-rail"
          aria-label={t("boardPanelLabel", { title: active.title })}
        >
          {header}
          {tabs}
          {surface}
        </aside>
      ) : null}
    </>
  );
}
function readPin(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
