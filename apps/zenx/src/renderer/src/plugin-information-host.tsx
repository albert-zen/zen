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
import { InformationOverflowCue } from "./InformationOverflowCue.js";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/controls.js";
import {
  consumeInformationReveal,
  readInformationOpen,
  rememberInformationOpen,
} from "./information-panel-memory.js";

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
  managedBoard = false,
  revealSignal = 0,
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
  /** The native editable layout already places every built-in Board document. */
  managedBoard?: boolean;
  /** Foreground question arrival; does not move keyboard focus. */
  revealSignal?: number;
}) {
  const { t } = useTranslation("panels");
  const contributions = (snapshot.information ?? []).filter(
    (entry) => !managedBoard || entry.pluginId !== "zenx-board",
  );
  const ownerKey = conversationKey(owner);
  const [visibility, setVisibility] = useState(() => ({
    ownerKey,
    open: readInformationOpen(ownerKey),
  }));
  const open =
    visibility.ownerKey === ownerKey
      ? visibility.open
      : readInformationOpen(ownerKey);
  const setOpen = React.useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      const value =
        typeof next === "function" ? next(readInformationOpen(ownerKey)) : next;
      rememberInformationOpen(ownerKey, value);
      setVisibility({ ownerKey, open: value });
    },
    [ownerKey],
  );
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (consumeInformationReveal(ownerKey, revealSignal)) {
      focusOnOpen.current = false;
      setOpen(true);
    }
  }, [ownerKey, revealSignal, setOpen]);
  const [selected, setSelected] = useState(contributions[0]?.key ?? "");
  const trigger = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [contentMounted, setContentMounted] = useState(false);
  const contentRef = React.useCallback((node: HTMLDivElement | null) => {
    setContentMounted(node !== null);
  }, []);
  // Width changes rebuild observers; keep transition history across that rebind.
  const hasMeasuredLayout = useRef(false);
  const previousResourceOpen = useRef(false);
  const previousPrimaryActive = useRef(false);
  const [layout, setLayout] = useState({
    headerBottom: 0,
    triggerBottom: undefined as number | undefined,
    width: 340,
    anchorX: 0,
    anchorY: 0,
    right: 12,
    available: true,
  });
  useLayoutEffect(() => {
    const workspace = toolbar.current?.closest(".workspace");
    if (!workspace) return;
    let panel: HTMLElement | null = null;
    let heading: HTMLElement | null = null;
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
      const triggerBottom = trigger.current?.getBoundingClientRect().bottom;
      const next = {
        headerBottom,
        available:
          !resourceOpen || panel?.dataset.expanded !== "true" || primaryActive,
        // Render must not synchronously flush the transcript's dirty layout,
        // including when Radix keeps the information popover closed.
        triggerBottom,
        // Same floating card in closed and split workspaces, entirely on the
        // conversation side of the divider. Never allocate a third column.
        width: Math.max(0, Math.min(340, bounds.width - resourceWidth - 24)),
        anchorX: bounds.right - resourceWidth - 12,
        anchorY: Math.max(headerBottom, triggerBottom ?? bounds.top),
        right: resourceWidth + 12,
      };
      if (
        hasMeasuredLayout.current &&
        resourceOpen &&
        !previousResourceOpen.current
      )
        setOpen(false);
      if (
        hasMeasuredLayout.current &&
        previousPrimaryActive.current &&
        !primaryActive &&
        resourceOpen &&
        panel?.dataset.expanded === "true"
      )
        setOpen(false);
      hasMeasuredLayout.current = true;
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
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(workspace);
    if (trigger.current) observer?.observe(trigger.current);
    if (titlebar) observer?.observe(titlebar);
    // Watch only the workspace's direct children and the current panel's own
    // presentation/heading. A late or replaced panel must own the observers;
    // transcript and resource-content mutations must never trigger measurement.
    const presentation =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(() => {
            bindPanel();
            measure();
          });
    const bindPanel = () => {
      const nextPanel = workspace.querySelector<HTMLElement>(
        ":scope > .auxiliary-panel",
      );
      const nextHeading =
        nextPanel?.querySelector<HTMLElement>(":scope > .auxiliary-heading") ??
        null;
      if (nextPanel !== panel) {
        presentation?.disconnect();
        panel = nextPanel;
        if (panel)
          presentation?.observe(panel, {
            attributes: true,
            attributeFilter: [
              "data-open",
              "data-expanded",
              "data-primary-active",
            ],
            childList: true,
          });
      }
      if (nextHeading !== heading) {
        if (heading) observer?.unobserve(heading);
        heading = nextHeading;
        if (heading) observer?.observe(heading);
      }
    };
    const children =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(() => {
            bindPanel();
            measure();
          });
    children?.observe(workspace, { childList: true });
    bindPanel();
    measure();
    return () => {
      observer?.disconnect();
      presentation?.disconnect();
      children?.disconnect();
    };
  }, [resourcePanelWidth, contributions.length, !!contextContent, setOpen]);
  useEffect(() => {
    if (contributions.length === 0 && !contextContent) setOpen(false);
  }, [contributions.length, !!contextContent, setOpen]);
  const active =
    contributions.find((item) => item.key === selected) ?? contributions[0];
  const presentedOpen = open && layout.available;
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
      <div
        ref={toolbar}
        className="information-toolbar"
        data-clearance-open={presentedOpen && contentMounted}
        data-clearance-right={layout.anchorX}
        hidden={!layout.available}
      >
        <Popover
          modal={false}
          open={presentedOpen}
          onOpenChange={(next) => {
            focusOnOpen.current = next;
            setOpen(next);
          }}
        >
          <button
            ref={trigger}
            onClick={(event) => {
              if (open) event.currentTarget.focus({ preventScroll: true });
              focusOnOpen.current = !open;
              setOpen(!open);
            }}
            type="button"
            className="icon-button"
            aria-label={t("boardTitle")}
            title={t("boardTitle")}
            aria-pressed={presentedOpen}
            aria-expanded={presentedOpen}
            aria-haspopup="dialog"
            aria-controls={presentedOpen ? contentId : undefined}
          >
            <Icon name="list-detail" />
          </button>
          <PopoverAnchor asChild>
            <span
              aria-hidden="true"
              style={{
                position: "fixed",
                left: layout.anchorX - 1,
                top: layout.anchorY - 1,
                width: 1,
                height: 1,
                pointerEvents: "none",
              }}
            />
          </PopoverAnchor>
          <PopoverContent
            ref={contentRef}
            id={contentId}
            onInteractOutside={(event) => {
              const target = event.target as Element | null;
              // Navigation swaps owners; it must not first record that the
              // outgoing owner's card was explicitly dismissed.
              if (
                trigger.current?.contains(target) ||
                target?.closest?.(".sidebar")
              )
                event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const focused = document.activeElement;
              if (
                !focused ||
                focused === document.body ||
                document.getElementById(contentId)?.contains(focused)
              )
                trigger.current?.focus({ preventScroll: true });
            }}
            onOpenAutoFocus={(event) => {
              if (!focusOnOpen.current) event.preventDefault();
              focusOnOpen.current = false;
            }}
            avoidCollisions={false}
            side="bottom"
            align="end"
            className="information-popover"
            style={{
              width: `var(--information-reading-card-width, ${layout.width}px)`,
              maxHeight: `min(720px, calc(100vh - ${Math.max(layout.headerBottom, layout.triggerBottom ?? 44) + 16}px))`,
            }}
            sideOffset={8}
            aria-label={active?.title ?? t("boardTitle")}
          >
            {layout.right > 12 && (
              <div className="information-dismiss-toolbar">
                <InformationOverflowCue label={t("informationMoreBelow")} />
              </div>
            )}
            {tabs}
            {surface}
          </PopoverContent>
        </Popover>
      </div>
    </>
  );
}
