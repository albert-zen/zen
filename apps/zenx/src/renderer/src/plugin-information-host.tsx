import { useTranslation } from "react-i18next";
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
} from "react";
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
  contextContent,
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
  contextContent?: React.ReactNode;
}) {
  const { t } = useTranslation("panels");
  const contributions = snapshot.information ?? [];
  const ownerKey = conversationKey(owner);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(contributions[0]?.key ?? "");
  const trigger = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const previousResourceOpen = useRef(false);
  const previousPrimaryActive = useRef(false);
  const [layout, setLayout] = useState({
    headerBottom: 0,
    triggerBottom: undefined as number | undefined,
    top: 12,
    right: 12,
    dock: false,
  });
  useLayoutEffect(() => {
    const workspace = toolbar.current?.closest(".workspace");
    if (!workspace) return;
    const panel = workspace.querySelector<HTMLElement>(
      ":scope > .auxiliary-panel",
    );
    const heading = panel?.querySelector<HTMLElement>(
      ":scope > .auxiliary-heading",
    );
    const titlebar = workspace
      .closest(".app-shell")
      ?.querySelector<HTMLElement>(
        ":scope > .window-titlebar .window-titlebar-session",
      );
    const visibleBottom = (element: HTMLElement | null | undefined) => {
      if (!element) return 0;
      const style =
        element.ownerDocument.defaultView?.getComputedStyle(element);
      return style?.display === "none" || style?.visibility === "hidden"
        ? 0
        : element.getBoundingClientRect().bottom;
    };
    const measure = () => {
      const bounds = workspace.getBoundingClientRect();
      const resourceOpen = panel?.dataset.open === "true";
      const primaryActive =
        resourceOpen && panel?.dataset.primaryActive === "true";
      const resourceWidth =
        resourceOpen && !primaryActive ? resourcePanelWidth : 0;
      // Windows/Linux have a separate visible conversation row below the OS
      // strip; macOS may hide that row when workspace tabs own the same space.
      const headerBottom = Math.max(
        visibleBottom(titlebar),
        resourceOpen ? visibleBottom(heading) : 0,
      );
      const next = {
        headerBottom,
        // Render must not synchronously flush the transcript's dirty layout,
        // including when Radix keeps the information popover closed.
        triggerBottom: trigger.current?.getBoundingClientRect().bottom,
        top: Math.max(0, headerBottom - bounds.top) + 12,
        right: resourceWidth + 12,
        // Our responsive allocation, not a value copied from a reference app:
        // a 340px card, 24px gutters and at least 556px for the conversation.
        dock:
          bounds.width - resourceWidth >= 920 &&
          !(
            resourceOpen &&
            panel?.dataset.expanded === "true" &&
            !primaryActive
          ),
      };
      if (resourceOpen && !previousResourceOpen.current) setOpen(false);
      if (
        previousPrimaryActive.current &&
        !primaryActive &&
        resourceOpen &&
        panel?.dataset.expanded === "true"
      )
        setOpen(false);
      previousResourceOpen.current = resourceOpen;
      previousPrimaryActive.current = primaryActive;
      setLayout((current) =>
        Object.keys(next).every(
          (key) =>
            next[key as keyof typeof next] ===
            current[key as keyof typeof current],
        )
          ? current
          : next,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(workspace);
    if (trigger.current) observer?.observe(trigger.current);
    if (heading) observer?.observe(heading);
    if (titlebar) observer?.observe(titlebar);
    // The primary conversation stays mounted in place while a workspace tab is
    // selected. Observe only its presentation attributes, never transcript DOM.
    const presentation =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(measure);
    if (panel)
      presentation?.observe(panel, {
        attributes: true,
        attributeFilter: ["data-open", "data-expanded", "data-primary-active"],
      });
    return () => {
      observer?.disconnect();
      presentation?.disconnect();
    };
  }, [resourcePanelWidth, contributions.length]);
  useEffect(() => {
    if (!open || !layout.dock) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      const target = event.target as Node | null;
      if (
        !document.getElementById(contentId)?.contains(target) &&
        target !== trigger.current
      )
        return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, layout.dock, contentId]);
  useEffect(() => {
    setOpen(false);
  }, [ownerKey, contributions.length === 0]);
  const active =
    contributions.find((item) => item.key === selected) ?? contributions[0];
  if (!active && !contextContent) return null;
  const admissionId = snapshot.plugins.find(
    (plugin) => plugin.id === active?.pluginId,
  )?.admissionId;
  const surface = (
    <div className="information-content">
      {contextContent}
      {active ? (
        <GenericPluginUiHost
          key={`${active.key}:${ownerKey}`}
          registry={registry}
          snapshot={snapshot}
          pluginId={active.pluginId}
          surfaceId={active.surfaceId}
          context={{
            owner,
            admissionId,
            hasConversationInformation: !!contextContent,
          }}
          theme={theme}
          navigate={navigate}
          executeCommand={executeCommand}
          readHandle={readHandle}
        />
      ) : null}
    </div>
  );
  const tabs =
    contributions.length > 1 ? (
      <nav className="information-tabs" aria-label={t("boardViews")}>
        {contributions.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={item.key === active?.key}
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
    <>
      <div ref={toolbar} className="information-toolbar">
        <Popover
          open={open && !layout.dock}
          onOpenChange={(next) =>
            setOpen((current) => (layout.dock ? !current : next))
          }
        >
          <PopoverTrigger asChild>
            <button
              ref={trigger}
              type="button"
              className="icon-button"
              aria-label={t("boardTitle")}
              title={t("boardTitle")}
              aria-pressed={open}
              aria-expanded={open}
              aria-controls={contentId}
            >
              <Icon name="list-detail" />
            </button>
          </PopoverTrigger>
          {!layout.dock && (
            <PopoverContent
              id={contentId}
              side="bottom"
              align="end"
              className="information-popover"
              style={{
                maxHeight: `min(720px, calc(100vh - ${Math.max(layout.headerBottom, layout.triggerBottom ?? 44) + 16}px))`,
              }}
              sideOffset={Math.max(
                8,
                layout.headerBottom - (layout.triggerBottom ?? 0) + 8,
              )}
              aria-label={active?.title ?? t("boardTitle")}
            >
              {tabs}
              {surface}
            </PopoverContent>
          )}
        </Popover>
      </div>
      {open && layout.dock ? (
        <aside
          id={contentId}
          className="information-dock"
          aria-label={active?.title ?? t("boardTitle")}
          style={{
            top: layout.top,
            right: layout.right,
            maxHeight: `calc(100% - ${layout.top + 12}px)`,
          }}
        >
          {tabs}
          {surface}
        </aside>
      ) : null}
    </>
  );
}
