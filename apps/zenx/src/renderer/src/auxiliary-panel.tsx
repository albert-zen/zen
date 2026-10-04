import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type { WorkspaceBrowserTab } from "../../main/workspace-browser.js";
import { WorkspaceBrowserPanel } from "./workspace-browser-panel.js";
import { BrowserThreadPanel } from "./browser-thread-panel.js";
import { ComputerThreadPanel } from "./computer-thread-panel.js";
import { GenericPluginUiHost } from "./plugin-ui-host.js";
import { pluginUiRegistry, useAppearance } from "./PluginProductPage.js";
import {
  WorkspaceFileDrafts,
  fileDraftKey,
  isFileDirty,
} from "./workspace-file-drafts.js";
import { WorkspaceFilesPanel } from "./workspace-files-panel.js";
import { WorkspaceFilePicker } from "./workspace-file-picker.js";
import { Icon, type IconName } from "./icons.js";
import { messageFilePath } from "./message-file-path.js";

interface ContentTab {
  id: string;
  title: string;
  icon: IconName;
  path?: string;
  browser?: WorkspaceBrowserTab;
  render?: () => React.ReactNode;
}
export type AuxiliaryConversationContext =
  | { kind: "thread"; threadId: string }
  | {
      kind: "room";
      roomId: string;
      resourceThread?: {
        threadId: string;
        title: string;
        workspacePath?: string;
      };
    };

export interface AuxiliaryCustomTab {
  /** The shell namespaces this ID as custom:<id>. */
  id: string;
  title: string;
  icon: IconName;
  render(): React.ReactNode;
}

type AuxiliaryPanelProps = {
  customTabs?: readonly AuxiliaryCustomTab[];
  contextControl?: React.ReactNode;
  threadContext?: Readonly<Record<string, unknown>>;
  conversation?: {
    threadId: string;
    title: string;
    render(threadId: string): React.ReactNode;
  };
  messageLinkRequest?: {
    id: number;
    kind: "file" | "browser";
    value: string;
  } | null;
  onWidthChange?(width: number): void;
  navigate?(route: string): void;
  fileDrafts?: WorkspaceFileDrafts;
  workspacePath?: string;
  title: string;
  open: boolean | undefined;
  onOpenChange(open: boolean): void;
  snapshot: ZenXPluginSnapshot | null;
  selectedTab?: string;
  onSelectTab(tab: string): void;
  openedTabs?: string[];
  onTabsChange?(tabs: string[]): void;
} & (
  | { conversationContext: AuxiliaryConversationContext; threadId?: never }
  | { conversationContext?: undefined; threadId: string }
);

export function AuxiliaryPanel({
  navigate,
  threadId: legacyThreadId,
  conversationContext,
  customTabs = [],
  contextControl,
  title,
  open,
  onOpenChange,
  snapshot,
  selectedTab,
  onSelectTab,
  fileDrafts,
  workspacePath: legacyWorkspacePath,
  openedTabs,
  onTabsChange,
  onWidthChange,
  messageLinkRequest,
  threadContext,
  conversation,
}: AuxiliaryPanelProps) {
  useTranslation("panels");
  const roomContext =
    conversationContext?.kind === "room" ? conversationContext : undefined;
  // Room identity owns presentation only. Execution APIs always use a real Thread.
  const threadId = roomContext
    ? roomContext.resourceThread?.threadId
    : conversationContext?.kind === "thread"
      ? conversationContext.threadId
      : legacyThreadId;
  const workspacePath = roomContext
    ? roomContext.resourceThread?.workspacePath
    : legacyWorkspacePath;
  const [localDrafts] = useState(() => new WorkspaceFileDrafts());
  const drafts = fileDrafts ?? localDrafts;
  const entries = useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const [localTabs, setLocalTabs] = useState<string[]>([]);
  const order = openedTabs ?? localTabs;
  const setOrder = onTabsChange ?? setLocalTabs;
  const theme = useAppearance();
  const [width, setWidth] = useState(520);
  const panel = useRef<HTMLElement>(null);
  const tabRail = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!panel.current || !onWidthChange) return;
    const measure = () =>
      onWidthChange(open ? panel.current!.getBoundingClientRect().width : 0);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(panel.current);
    measure();
    return () => {
      observer?.disconnect();
      onWidthChange(0);
    };
  }, [open, onWidthChange]);
  const [expanded, setExpanded] = useState(false);
  const restoreToggleFocus = useRef(false);
  useLayoutEffect(() => {
    if (open) {
      if (document.activeElement?.id === "thread-browser-toggle")
        panel.current
          ?.querySelector<HTMLButtonElement>(".auxiliary-close-button")
          ?.focus();
    } else if (restoreToggleFocus.current) {
      restoreToggleFocus.current = false;
      document.getElementById("thread-browser-toggle")?.focus();
    }
  }, [open]);
  const [choosing, setChoosing] = useState(false);
  const [pickingFile, setPickingFile] = useState(false);
  const [browserTabs, setBrowserTabs] = useState<WorkspaceBrowserTab[]>([]);
  const [browserListThread, setBrowserListThread] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const selectionEpoch = useRef(0);
  const pendingTabFocus = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const browser =
    threadId !== undefined &&
    (snapshot?.plugins.some(
      (p) => p.id === "browser" && p.enabled && p.available,
    ) ??
      false);
  const computer =
    threadId !== undefined &&
    (snapshot?.plugins.some(
      (p) => p.id === "computer" && p.enabled && p.available,
    ) ??
      false);
  const panels = [
    ...(threadId === undefined ? [] : (snapshot?.panels ?? [])),
  ].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key),
  );
  const files = [...entries.entries()].filter(
    ([key]) => threadId !== undefined && JSON.parse(key)[0] === threadId,
  );
  const candidates: ContentTab[] = [
    ...customTabs.map((tab) => ({ ...tab, id: `custom:${tab.id}` })),
    ...(conversation && threadId !== undefined
      ? [
          {
            id: `thread:${conversation.threadId}`,
            title: conversation.title,
            icon: "users" as const,
          },
        ]
      : []),
    ...files.map(([, draft]) => ({
      id: `file:${draft.base.path}`,
      title: draft.base.path.split("/").at(-1)!,
      icon: "file" as const,
      path: draft.base.path,
    })),
    ...(threadId !== undefined && browserListThread === threadId
      ? browserTabs
      : []
    ).map((tab) => ({
      id: `browser:${tab.id}`,
      title: tab.title || i18n.t("panels:newTab"),
      icon: "browser" as const,
      browser: tab,
    })),
    ...(computer
      ? [
          {
            id: "computer",
            title: i18n.t("panels:computer"),
            icon: "computer" as const,
          },
        ]
      : []),
    ...(browser
      ? [
          {
            id: "attached",
            title: i18n.t("panels:attachedBrowser"),
            icon: "browser" as const,
          },
        ]
      : []),
    ...panels.map((panel) => ({
      id: `plugin:${panel.key}`,
      title: panel.title,
      icon: "layers" as const,
    })),
  ];
  const available = new Map(candidates.map((tab) => [tab.id, tab]));
  const ids = [
    ...new Set([
      ...order,
      ...candidates
        .filter((tab) => tab.path || tab.browser)
        .map((tab) => tab.id),
      ...(selectedTab && available.has(selectedTab) ? [selectedTab] : []),
    ]),
  ].filter((id) => available.has(id));
  const signature = JSON.stringify(ids);
  const browserListReady =
    threadId === undefined ||
    !window.zenx.workspaceBrowser ||
    browserListThread === threadId;
  useEffect(() => {
    if (browserListReady && JSON.stringify(order) !== signature)
      setOrder(JSON.parse(signature));
    const selectionKnown = selectedTab?.startsWith("custom:")
      ? true
      : selectedTab?.startsWith("file:") || selectedTab?.startsWith("browser:")
        ? browserListReady
        : snapshot !== null;
    if (
      browserListReady &&
      selectionKnown &&
      selectedTab &&
      !ids.includes(selectedTab)
    ) {
      selectionEpoch.current += 1;
      onSelectTab(ids[0] ?? "");
    }
  }, [
    browserListReady,
    ids,
    onSelectTab,
    order,
    selectedTab,
    setOrder,
    signature,
    snapshot,
  ]);
  const tabs = ids.map((id) => available.get(id)!);
  const active =
    selectedTab && ids.includes(selectedTab) ? selectedTab : ids[0];
  const idsRef = useRef(ids);
  const activeRef = useRef(active);
  const orderRef = useRef(order);
  const threadIdRef = useRef(threadId);
  const resourceEpoch = useRef(0);
  if (threadIdRef.current !== threadId) resourceEpoch.current += 1;
  idsRef.current = ids;
  activeRef.current = active;
  orderRef.current = order;
  threadIdRef.current = threadId;
  const resourceCurrent = (epoch: number, owner: string) =>
    mounted.current &&
    threadIdRef.current === owner &&
    resourceEpoch.current === epoch;
  const showChooser = choosing || tabs.length === 0;
  const select = (id: string, focusTab = false) => {
    selectionEpoch.current += 1;
    pendingTabFocus.current = focusTab ? id : null;
    setChoosing(false);
    setPickingFile(false);
    setError("");
    onSelectTab(id);
  };
  useLayoutEffect(() => {
    // Host SDK panel requests can change selection without calling select().
    // Fence pending actions as soon as that external selection is committed.
    selectionEpoch.current += 1;
    if (pendingTabFocus.current !== selectedTab) pendingTabFocus.current = null;
    setChoosing(false);
    setPickingFile(false);
  }, [selectedTab]);
  useLayoutEffect(() => {
    const rail = tabRail.current;
    if (!rail || !open) return;
    const reveal = () => {
      const tab = active ? document.getElementById(`aux-tab-${active}`) : null;
      const item = tab?.closest<HTMLElement>(".workspace-content-tab");
      if (!item || !rail.contains(item) || rail.clientWidth <= 0) return;
      const bounds = item.getBoundingClientRect();
      const railBounds = rail.getBoundingClientRect();
      const left = bounds.left - railBounds.left + rail.scrollLeft;
      const right = bounds.right - railBounds.left + rail.scrollLeft;
      const visibleEnd = rail.scrollLeft + rail.clientWidth;
      const next =
        left < rail.scrollLeft || bounds.width > rail.clientWidth
          ? left
          : right > visibleEnd
            ? right - rail.clientWidth
            : rail.scrollLeft;
      rail.scrollLeft = Math.max(
        0,
        Math.min(next, rail.scrollWidth - rail.clientWidth),
      );
    };
    reveal();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(reveal);
    observer?.observe(rail);
    return () => observer?.disconnect();
  }, [active, open, signature, width, expanded]);
  useLayoutEffect(() => {
    const target = pendingTabFocus.current;
    if (target === null || showChooser || active !== target) return;
    const tab = document.getElementById(`aux-tab-${target}`);
    if (tab && panel.current?.contains(tab)) {
      pendingTabFocus.current = null;
      tab.focus({ preventScroll: true });
    }
  }, [active, selectedTab, showChooser, signature]);
  useEffect(() => {
    const api = window.zenx.workspaceBrowser;
    selectionEpoch.current += 1;
    setBrowserListThread(undefined);
    setBrowserTabs([]);
    setBusy(false);
    setError("");
    setPickingFile(false);
    if (threadId === undefined) return;
    if (!api) {
      setBrowserListThread(threadId);
      return;
    }
    let alive = true;
    let changed = false;
    const stop = api.onChanged((value) => {
      if (alive && value.threadId === threadId) {
        changed = true;
        setBrowserListThread(threadId);
        setBrowserTabs(value.tabs);
      }
    });
    void api.command(threadId, "list").then(
      (value) => {
        if (alive && !changed) {
          setBrowserListThread(threadId);
          setBrowserTabs(value);
        }
      },
      (reason) => {
        if (alive) setError(String(reason.message ?? reason));
      },
    );
    return () => {
      alive = false;
      stop();
    };
  }, [threadId]);
  const add = async (id: string) => {
    const operationEpoch = ++selectionEpoch.current;
    const bindingEpoch = resourceEpoch.current;
    setError("");
    if (id === "file") {
      setPickingFile(true);
      setChoosing(true);
      return;
    }
    if (id !== "browser") {
      setOrder([...new Set([...orderRef.current, id])]);
      select(id, true);
      return;
    }
    if (!window.zenx.workspaceBrowser) {
      setError("__zenx_interactive_browsing_unavailable__");
      return;
    }
    if (threadId === undefined) return;
    setBusy(true);
    try {
      const value = await window.zenx.workspaceBrowser.command(threadId, "new");
      if (!resourceCurrent(bindingEpoch, threadId)) return;
      setBrowserTabs(value);
      if (selectionEpoch.current !== operationEpoch) return;
      const created = value.at(-1);
      if (created) select(`browser:${created.id}`, true);
    } catch (reason) {
      if (resourceCurrent(bindingEpoch, threadId))
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (resourceCurrent(bindingEpoch, threadId)) setBusy(false);
    }
  };
  const openFile = async (path: string) => {
    if (threadId === undefined) return;
    const operationEpoch = selectionEpoch.current;
    const bindingEpoch = resourceEpoch.current;
    const value = await window.zenx.workspaceFiles.read(threadId, path);
    if (
      !resourceCurrent(bindingEpoch, threadId) ||
      selectionEpoch.current !== operationEpoch
    )
      return;
    const key = fileDraftKey(threadId, value.path);
    const current = drafts.snapshot().get(key);
    if (!current || (!isFileDirty(current) && !current.saving))
      drafts.set(key, { base: value, text: value.text });
    select(`file:${value.path}`);
  };
  const handledLink = useRef<number | null>(null);
  useEffect(() => {
    if (
      threadId === undefined ||
      !messageLinkRequest ||
      handledLink.current === messageLinkRequest.id
    )
      return;
    handledLink.current = messageLinkRequest.id;
    selectionEpoch.current += 1;
    let active = true;
    setError("");
    void (async () => {
      try {
        if (messageLinkRequest.kind === "file") {
          await openFile(
            messageFilePath(messageLinkRequest.value, workspacePath),
          );
        } else {
          const tabs = await window.zenx.workspaceBrowser.command(
            threadId,
            "new",
            undefined,
            messageLinkRequest.value,
          );
          if (active) {
            setBrowserTabs(tabs);
            const newest = tabs.at(-1);
            if (newest) select(`browser:${newest.id}`);
          }
        }
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      active = false;
    };
    // A request id represents a single click; render changes must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageLinkRequest?.id, threadId]);
  const remove = (id: string, expectedEpoch?: number) => {
    const currentIds = idsRef.current;
    const currentOrder = orderRef.current;
    const source = currentOrder.includes(id) ? currentOrder : currentIds;
    const index = source.indexOf(id);
    const remaining = source.filter((value) => value !== id);
    setOrder(remaining);
    if (
      activeRef.current === id &&
      (expectedEpoch === undefined || selectionEpoch.current === expectedEpoch)
    ) {
      selectionEpoch.current += 1;
      onSelectTab(remaining[Math.min(index, remaining.length - 1)] ?? "");
    }
  };
  const closeTab = async (tab: ContentTab) => {
    setError("");
    const bindingEpoch = resourceEpoch.current;
    let operationEpoch: number | undefined;
    if (tab.path) {
      if (threadId === undefined) return;
      const key = fileDraftKey(threadId, tab.path);
      const draft = drafts.snapshot().get(key);
      if (draft && (isFileDirty(draft) || draft.saving)) {
        if (draft.conflict || draft.error) {
          select(tab.id);
          setError("__zenx_file_save_blocked__");
          return;
        }
        drafts.closeAfterSave(key, (text, revision) =>
          window.zenx.workspaceFiles.save(threadId, tab.path!, text, revision),
        );
        return;
      }
      drafts.remove(key);
    } else if (tab.browser) {
      if (threadId === undefined) return;
      operationEpoch = selectionEpoch.current;
      try {
        const value = await window.zenx.workspaceBrowser.command(
          threadId,
          "close",
          tab.browser.id,
        );
        if (!resourceCurrent(bindingEpoch, threadId)) return;
        setBrowserTabs(value);
      } catch (reason) {
        if (resourceCurrent(bindingEpoch, threadId)) setError(String(reason));
        return;
      }
    }
    remove(tab.id, operationEpoch);
  };
  const close = () => {
    setExpanded(false);
    restoreToggleFocus.current = true;
    onOpenChange(false);
  };
  return (
    <aside
      ref={panel}
      id="thread-workspace-panel"
      className="auxiliary-panel"
      data-open={open === true}
      inert={!open}
      data-expanded={expanded}
      aria-label={`Side panel for ${title}`}
      style={{ "--auxiliary-width": `${width}px` } as React.CSSProperties}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          if (choosing) {
            setChoosing(false);
            setPickingFile(false);
          } else if (expanded) setExpanded(false);
          else close();
        }
      }}
    >
      <div
        className="browser-panel-resizer"
        role="separator"
        aria-label={i18n.t("panels:sidePanelWidth")}
        aria-orientation="vertical"
        aria-valuemin={360}
        aria-valuemax={780}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            setWidth((value) =>
              Math.max(
                360,
                Math.min(780, value + (event.key === "ArrowLeft" ? 20 : -20)),
              ),
            );
          }
        }}
        onPointerDown={(event) =>
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setWidth(
              Math.max(
                360,
                Math.min(
                  780,
                  event.currentTarget.parentElement!.getBoundingClientRect()
                    .right - event.clientX,
                ),
              ),
            );
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />
      <header className="auxiliary-heading">
        <div className="workspace-tab-rail">
          <div
            ref={tabRail}
            role="tablist"
            aria-label={i18n.t("panels:workspaceTabs")}
          >
            {tabs.map((tab, index) => (
              <span
                className="workspace-content-tab"
                data-active={!showChooser && active === tab.id}
                key={tab.id}
              >
                <button
                  type="button"
                  role="tab"
                  id={`aux-tab-${tab.id}`}
                  aria-selected={!showChooser && active === tab.id}
                  aria-controls={`aux-content-${tab.id}`}
                  tabIndex={active === tab.id ? 0 : -1}
                  title={tab.path ?? tab.browser?.url ?? tab.title}
                  onClick={() => select(tab.id)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : event.key === "ArrowRight"
                            ? (index + 1) % tabs.length
                            : event.key === "ArrowLeft"
                              ? (index + tabs.length - 1) % tabs.length
                              : -1;
                    if (next >= 0) {
                      event.preventDefault();
                      select(tabs[next]!.id);
                      document
                        .getElementById(`aux-tab-${tabs[next]!.id}`)
                        ?.focus();
                    }
                  }}
                >
                  <Icon name={tab.icon} />
                  <span>{tab.title}</span>
                  {tab.path &&
                  threadId !== undefined &&
                  isFileDirty(
                    entries.get(fileDraftKey(threadId, tab.path))!,
                  ) ? (
                    <span
                      className="workspace-tab-dirty"
                      aria-label={i18n.t("panels:unsavedChanges")}
                    >
                      •
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="workspace-tab-close"
                  aria-label={`Close tab ${tab.title}`}
                  title={`Close tab ${tab.title}`}
                  disabled={
                    tab.path && threadId !== undefined
                      ? entries.get(fileDraftKey(threadId, tab.path))
                          ?.closing === true
                      : false
                  }
                  onClick={() => void closeTab(tab)}
                >
                  <Icon name="x" />
                </button>
              </span>
            ))}
          </div>
          <button
            type="button"
            className="icon-button workspace-add-tab"
            aria-label={i18n.t("panels:newWorkspaceTab")}
            title={i18n.t("panels:newWorkspaceTab")}
            aria-pressed={showChooser}
            onClick={() => {
              selectionEpoch.current += 1;
              setChoosing(true);
              setPickingFile(false);
              setError("");
            }}
          >
            <Icon name="plus" />
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={
            expanded
              ? i18n.t("panels:restoreSidePanel")
              : i18n.t("panels:expandSidePanel")
          }
          title={
            expanded
              ? i18n.t("panels:restoreSidePanel")
              : i18n.t("panels:expandSidePanel")
          }
          aria-pressed={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name={expanded ? "minimize" : "maximize"} />
        </button>
        <button
          type="button"
          className="icon-button auxiliary-close-button"
          aria-label={i18n.t("panels:closeSidePanel")}
          title={i18n.t("panels:closeSidePanel")}
          onClick={close}
        >
          <Icon name="panel-right" />
        </button>
      </header>
      {contextControl ? (
        <div className="auxiliary-context-control">{contextControl}</div>
      ) : null}
      {error ? (
        <p className="workspace-panel-error" role="alert">
          {error === "__zenx_interactive_browsing_unavailable__"
            ? i18n.t("panels:interactiveBrowsingIsAvailableInTheZenx")
            : error === "__zenx_file_save_blocked__"
              ? i18n.t("panels:resolveThisFileSSaveIssueBefore")
              : error}
        </p>
      ) : null}
      {showChooser ? (
        <div className="auxiliary-content workspace-new-tab">
          {pickingFile ? (
            threadId !== undefined ? (
              <WorkspaceFilePicker
                threadId={threadId}
                onOpen={openFile}
                onBack={() => {
                  selectionEpoch.current += 1;
                  setPickingFile(false);
                }}
              />
            ) : null
          ) : (
            <div
              className="workspace-tab-types"
              aria-label={i18n.t("panels:newTabType")}
            >
              <header>
                <h3>
                  {roomContext
                    ? i18n.t("panels:openBesideThisRoom")
                    : i18n.t("panels:openBesideThisConversation")}
                </h3>
                <p>
                  {roomContext
                    ? roomContext.resourceThread
                      ? i18n.t("panels:conversationResourcesUse", {
                          name: roomContext.resourceThread.title,
                        })
                      : i18n.t("panels:chooseARoomMemberToEnableConversation")
                    : i18n.t(
                        "panels:filesPagesAndObservationsShareThisWorkspace",
                      )}
                </p>
              </header>
              {customTabs.map((tab) => (
                <button
                  type="button"
                  key={`custom:${tab.id}`}
                  onClick={() => void add(`custom:${tab.id}`)}
                >
                  <Icon name={tab.icon} />
                  <span>
                    <strong>{tab.title}</strong>
                  </span>
                </button>
              ))}
              {threadId !== undefined ? (
                <>
                  <button type="button" onClick={() => void add("file")}>
                    <Icon name="file" />
                    <span>
                      <strong>{i18n.t("panels:file")}</strong>
                      <small>{i18n.t("panels:readOrEditAFileInThis")}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void add("browser")}
                  >
                    <Icon name="browser" />
                    <span>
                      <strong>{i18n.t("panels:browser")}</strong>
                      <small>
                        {i18n.t("panels:browseASharedPageWithTheAgent")}
                      </small>
                    </span>
                  </button>
                  {computer ? (
                    <button type="button" onClick={() => void add("computer")}>
                      <Icon name="computer" />
                      <span>
                        <strong>{i18n.t("panels:computer")}</strong>
                        <small>
                          {i18n.t("panels:observeTheAgentSDesktopActivity")}
                        </small>
                      </span>
                    </button>
                  ) : null}
                  {browser ? (
                    <button type="button" onClick={() => void add("attached")}>
                      <Icon name="browser" />
                      <span>
                        <strong>{i18n.t("panels:attachedBrowser")}</strong>
                        <small>
                          {i18n.t("panels:inspectConnectedBrowserActivity")}
                        </small>
                      </span>
                    </button>
                  ) : null}
                  {panels.map((panel) => (
                    <button
                      type="button"
                      key={panel.key}
                      onClick={() => void add(`plugin:${panel.key}`)}
                    >
                      <Icon name="layers" />
                      <span>
                        <strong>{panel.title}</strong>
                      </span>
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      {tabs.map((tab) => {
        const visible = !showChooser && active === tab.id;
        const panel = panels.find((value) => `plugin:${value.key}` === tab.id);
        return (
          <div
            className="auxiliary-content"
            key={tab.id}
            role="tabpanel"
            id={`aux-content-${tab.id}`}
            aria-labelledby={`aux-tab-${tab.id}`}
            hidden={!visible}
          >
            {conversation &&
            threadId !== undefined &&
            tab.id === `thread:${conversation.threadId}` &&
            open &&
            visible ? (
              <div className="auxiliary-conversation">
                <header className="auxiliary-conversation-heading">
                  <span>{conversation.title}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={i18n.t("panels:openConversationFullScreen")}
                    title={i18n.t("panels:openConversationFullScreen")}
                    onClick={() =>
                      navigate?.(
                        `/threads/${encodeURIComponent(conversation.threadId)}`,
                      )
                    }
                  >
                    <Icon name="expand" />
                  </button>
                </header>
                {conversation.render(conversation.threadId)}
              </div>
            ) : null}
            {tab.render ? tab.render() : null}
            {tab.path && threadId !== undefined ? (
              <WorkspaceFilesPanel
                threadId={threadId}
                drafts={drafts}
                workspacePath={workspacePath}
                initialPath={tab.path}
                standalone
              />
            ) : null}
            {tab.browser && threadId !== undefined && visible ? (
              <WorkspaceBrowserPanel
                threadId={threadId}
                tab={tab.browser}
                open={open === true}
              />
            ) : null}
            {tab.id === "computer" && threadId !== undefined ? (
              <ComputerThreadPanel
                threadId={threadId}
                active={open === true && visible}
              />
            ) : null}
            {tab.id === "attached" && threadId !== undefined ? (
              <BrowserThreadPanel
                threadId={threadId}
                title={title}
                embedded
                open={open === true && visible}
                onOpenChange={onOpenChange}
                providerRevision={snapshot}
              />
            ) : null}
            {panel && snapshot && threadId !== undefined ? (
              <GenericPluginUiHost
                key={panel.key}
                className="auxiliary-plugin"
                registry={pluginUiRegistry}
                snapshot={snapshot}
                pluginId={panel.pluginId}
                surfaceId={panel.surfaceId}
                context={{
                  ...threadContext,
                  active: open === true && visible,
                  route: roomContext ? "room" : "agent",
                  threadId,
                  ...(roomContext ? { roomId: roomContext.roomId } : {}),
                }}
                theme={theme}
                executeCommand={window.zenx.plugins.executeCommand}
                readHandle={window.zenx.plugins.readHandle}
                navigate={navigate}
              />
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}
