import { ShellTargetNavigationContext } from "./shell-target-navigation.js";
import {
  sidebarTabId,
  sidebarTabFromId,
  sidebarOwnerKey,
  type ThreadSidebarState,
  type ThreadSidebarTab,
} from "../../thread-sidebar-state.js";
import { ShellThreadPanel } from "./shell-thread-panel.js";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import React, {
  useEffect,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type { BrowserThreadTarget } from "../../main/capabilities/browser-thread-observation.js";
import type { WorkspaceBrowserPresentation } from "../../main/workspace-browser.js";
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

function panelIcon(pluginId: string): IconName {
  if (pluginId === "zenx-subagents") return "users";
  if (pluginId === "zenx-triggers") return "trigger";
  return "layers";
}

interface ContentTab {
  id: string;
  title: string;
  icon: IconName;
  path?: string;
  resourceThreadId?: string;
  descriptor?: ThreadSidebarTab;
  browser?: WorkspaceBrowserTab;
  externalBrowser?: BrowserThreadTarget;
  render?: () => React.ReactNode;
}

/** Per-conversation expanded state; the panel remounts on every thread switch. */
const browserFollowingByThread = new Map<
  string,
  { epoch: string; suppressed: boolean; tabId: string }
>();

const externalPresentations = new Set<string>();
const browserOperationWatermarks = new Map<string, number>();
function acceptBrowserOperation(threadId: string, sequence: number): boolean {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence < (browserOperationWatermarks.get(threadId) ?? 0)
  )
    return false;
  browserOperationWatermarks.delete(threadId);
  browserOperationWatermarks.set(threadId, sequence);
  if (browserOperationWatermarks.size > 512)
    browserOperationWatermarks.delete(
      browserOperationWatermarks.keys().next().value!,
    );
  return true;
}

const expandedByConversation = new Map<string, boolean>();

export type AuxiliaryConversationContext =
  | { kind: "thread"; threadId: string }
  | {
      kind: "room";
      roomId: string;
      resourceThreads?: readonly {
        threadId: string;
        title: string;
        workspacePath?: string;
      }[];
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
  presentationState?: ThreadSidebarState;
  onFullscreenChange?(value: boolean): void;
  onRemoveTab?(id: string): void;
  onReplaceTab?(
    id: string,
    tab: ThreadSidebarTab,
  ): Promise<boolean> | boolean | void;
  customTabs?: readonly AuxiliaryCustomTab[];
  contextControl?: React.ReactNode;
  threadContext?: Readonly<Record<string, unknown>>;
  conversations?: readonly {
    threadId: string;
    title: string;
    render(threadId: string): React.ReactNode;
  }[];
  messageLinkRequest?: {
    id: number;
    kind: "file" | "browser";
    value: string;
  } | null;
  /** Acknowledges a handled request; the owner clears it so remounts never replay it. */
  onMessageLinkRequestHandled?(id: number): void;
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
  presentationState,
  onFullscreenChange,
  onRemoveTab,
  onReplaceTab,
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
  onMessageLinkRequestHandled,
  threadContext,
  conversations = [],
}: AuxiliaryPanelProps) {
  useTranslation("panels");
  const shellNavigation = useContext(ShellTargetNavigationContext);
  const roomContext =
    conversationContext?.kind === "room" ? conversationContext : undefined;
  const [choosing, setChoosing] = useState(false);
  const selectedDescriptor =
    presentationState?.tabs.find((tab) => sidebarTabId(tab) === selectedTab) ??
    (customTabs.some((tab) => `custom:${tab.id}` === selectedTab)
      ? undefined
      : presentationState?.tabs[0]);
  const selectedResource = !choosing
    ? selectedDescriptor?.resourceThreadId
    : undefined;
  const roomResource = selectedResource
    ? roomContext?.resourceThreads?.find(
        (member) => member.threadId === selectedResource,
      )
    : roomContext?.resourceThread;
  const scopedId = (id: string) => {
    if (
      !presentationState ||
      !roomContext ||
      !threadId ||
      id.startsWith("custom:") ||
      id.startsWith("thread:")
    )
      return id;
    const tab = sidebarTabFromId(id);
    return sidebarTabId({ ...tab, resourceThreadId: threadId });
  };
  const scopedIdRef = useRef(scopedId);
  scopedIdRef.current = scopedId;
  // Room identity owns presentation only. Execution APIs always use a real Thread.
  const threadId = roomContext
    ? roomResource?.threadId
    : conversationContext?.kind === "thread"
      ? conversationContext.threadId
      : legacyThreadId;
  const workspacePath = roomContext
    ? roomResource?.workspacePath
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
  const pointerDrag = useRef<{
    source: string;
    pointerId: number;
    originX: number;
    originY: number;
    x: number;
    y: number;
    dragging: boolean;
    capture: HTMLElement;
    target?: string;
    after?: boolean;
  } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const suppressDragClick = useRef(false);
  const [tabDrag, setTabDrag] = useState<{
    source: string;
    target?: string;
    placement?: "before" | "after";
  } | null>(null);
  const reorderedFocus = useRef<string | null>(null);
  const fileBody = useRef<HTMLDivElement>(null);
  const [fileNavigationWidth, setFileNavigationWidth] = useState(192);
  const [fileNavigationHeight, setFileNavigationHeight] = useState(180);
  const [fileSplit, setFileSplit] = useState({ stacked: false, max: 360 });
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
  const expandedKey = roomContext
    ? `room:${roomContext.roomId}`
    : `thread:${threadId}`;
  const [localExpanded, setExpandedState] = useState(
    () => expandedByConversation.get(expandedKey) ?? false,
  );
  useEffect(() => {
    setExpandedState(expandedByConversation.get(expandedKey) ?? false);
  }, [expandedKey]);
  const expanded = presentationState?.fullscreen ?? localExpanded;
  const setExpanded = (update: React.SetStateAction<boolean>) => {
    if (onFullscreenChange) {
      onFullscreenChange(
        typeof update === "function" ? update(expanded) : update,
      );
      return;
    }
    setExpandedState((current) => {
      const next =
        typeof update === "function"
          ? (update as (value: boolean) => boolean)(current)
          : update;
      if (next) expandedByConversation.set(expandedKey, true);
      else expandedByConversation.delete(expandedKey);
      return next;
    });
  };
  const restoreToggleFocus = useRef(false);
  const autoOpening = useRef(false);
  useLayoutEffect(() => {
    if (open) {
      if (autoOpening.current) {
        autoOpening.current = false;
        return;
      }
      if (document.activeElement?.id === "thread-browser-toggle")
        panel.current
          ?.querySelector<HTMLButtonElement>(".auxiliary-close-button")
          ?.focus();
    } else if (restoreToggleFocus.current) {
      restoreToggleFocus.current = false;
      document.getElementById("thread-browser-toggle")?.focus();
    }
  }, [open]);
  const [pickingFile, setPickingFile] = useState(false);
  const [fileNavigationOpen, setFileNavigationOpen] = useState(true);
  const [externalListScope, setExternalListScope] = useState<string>();
  const [dismissedExternal, setDismissedExternal] = useState<string[]>([]);
  const [externalTargets, setExternalTargets] = useState<BrowserThreadTarget[]>(
    [],
  );
  const currentExternalIds = useRef(new Set<string>());
  const dismissedExternalRef = useRef(dismissedExternal);
  dismissedExternalRef.current = dismissedExternal;
  const [presentation, setPresentation] =
    useState<WorkspaceBrowserPresentation>();
  const automaticSelection = useRef<string | undefined>(undefined);
  const presentationCallbacks = useRef({ onSelectTab, onOpenChange });
  presentationCallbacks.current = {
    onSelectTab: (id) => onSelectTab(scopedId(id)),
    onOpenChange,
  };
  const lastBrowserIntent = useRef(0);
  const [followRevision, setFollowRevision] = useState(0);
  const suppressFollowing = () => {
    lastBrowserIntent.current = Date.now();
    autoOpening.current = false;
    setPresentation(undefined);
    const state = threadId ? browserFollowingByThread.get(threadId) : undefined;
    if (state) state.suppressed = true;
    setFollowRevision((value) => value + 1);
  };
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
  const browserAdmissionId = snapshot?.plugins.find(
    (plugin) => plugin.id === "browser",
  )?.admissionId;
  const externalScope = JSON.stringify([
    threadId ?? null,
    browserAdmissionId ?? null,
  ]);
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
    ...(threadId !== undefined
      ? [
          {
            id: "terminal",
            title: i18n.t("panels:shellTitle"),
            icon: "terminal" as const,
          },
        ]
      : []),
    ...customTabs.map((tab) => ({ ...tab, id: `custom:${tab.id}` })),
    ...(threadId !== undefined ? conversations : []).map((conversation) => ({
      id: `thread:${conversation.threadId}`,
      title: conversation.title,
      icon: "users" as const,
    })),
    ...files.map(([, draft]) => ({
      id: sidebarTabId({ kind: "file", path: draft.base.path }),
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
    ...(externalListScope === externalScope ? externalTargets : [])
      .filter((target) => !dismissedExternal.includes(target.id))
      .map((target) => ({
        id: `external-browser:${target.id}`,
        title: `${target.title || target.url} · ${i18n.t("panels:externalReadOnly")}`,
        icon: "browser" as const,
        externalBrowser: target,
      })),
    ...panels.map((panel) => ({
      id: `plugin:${panel.key}`,
      title:
        panel.pluginId === "zenx-triggers"
          ? i18n.t("panels:automations")
          : panel.title,
      icon: panelIcon(panel.pluginId),
    })),
  ];
  for (const tab of candidates) {
    tab.id = scopedId(tab.id);
    tab.resourceThreadId = threadId;
  }
  const available = new Map(candidates.map((tab) => [tab.id, tab]));
  for (const descriptor of presentationState?.tabs ?? []) {
    const id = sidebarTabId(descriptor);
    const resource = descriptor.resourceThreadId ?? threadId;
    const existing = available.get(id);
    available.set(id, {
      ...existing,
      id,
      descriptor,
      resourceThreadId: resource,
      title:
        existing?.title ??
        (descriptor.kind === "file"
          ? descriptor.path.split("/").at(-1)!
          : descriptor.kind === "webpage"
            ? descriptor.url
            : descriptor.kind === "terminal"
              ? i18n.t("panels:shellTitle")
              : descriptor.kind),
      icon:
        existing?.icon ??
        (descriptor.kind === "file"
          ? "file"
          : descriptor.kind === "terminal"
            ? "terminal"
            : "browser"),
      ...(descriptor.kind === "file" ? { path: descriptor.path } : {}),
    });
  }
  const persistedIds = presentationState?.tabs.map(sidebarTabId);
  // Unsaved side chats belong to this renderer. Their owner filters these IDs
  // out of durable mutations and supplies the combined order via openedTabs.
  const ephemeralIds = customTabs
    .map((tab) => `custom:${tab.id}`)
    .filter((id) => !persistedIds?.includes(id));
  const presentationIds = persistedIds
    ? [...persistedIds, ...ephemeralIds]
    : undefined;
  const ids = presentationIds
    ? ephemeralIds.length && openedTabs
      ? [
          ...new Set([
            ...openedTabs.filter((id) => presentationIds.includes(id)),
            ...presentationIds,
          ]),
        ]
      : presentationIds
    : [
        ...new Set([
          ...order,
          ...candidates
            .filter((tab) => tab.path || tab.browser || tab.externalBrowser)
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
    if (presentationState) return;
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
  const canReorder =
    tabs.length > 1 && (!presentationState || Boolean(onTabsChange));
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
  const clearTabDrag = () => {
    const drag = pointerDrag.current;
    pointerDrag.current = null;
    if (dragFrame.current !== null) {
      window.cancelAnimationFrame(dragFrame.current);
      dragFrame.current = null;
    }
    if (drag?.capture.hasPointerCapture?.(drag.pointerId))
      drag.capture.releasePointerCapture(drag.pointerId);
    setTabDrag(null);
  };
  const reorderTab = (
    source: string,
    target: string,
    after: boolean,
    focus = false,
  ) => {
    const current = idsRef.current;
    if (
      !canReorder ||
      source === target ||
      !current.includes(source) ||
      !current.includes(target)
    )
      return;
    const next = current.filter((id) => id !== source);
    next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
    if (next.every((id, index) => id === current[index])) return;
    if (focus) reorderedFocus.current = source;
    setOrder(next);
  };
  const reorderTabRef = useRef(reorderTab);
  reorderTabRef.current = reorderTab;
  const moveTab = (id: string, direction: -1 | 1) => {
    const current = idsRef.current;
    const index = current.indexOf(id);
    const target = current[index + direction];
    if (index >= 0 && target) reorderTab(id, target, direction === 1, true);
  };
  useLayoutEffect(() => {
    const id = reorderedFocus.current;
    if (!id) return;
    reorderedFocus.current = null;
    document.getElementById(`aux-tab-${id}`)?.focus({ preventScroll: true });
  }, [signature]);
  const workspaceIdentity = roomContext
    ? `room:${roomContext.roomId}`
    : `thread:${threadId}`;
  useEffect(() => {
    clearTabDrag();
    const updateTarget = () => {
      const drag = pointerDrag.current;
      const rail = tabRail.current;
      if (!drag?.dragging || !rail) return;
      const edge = rail.getBoundingClientRect();
      drag.target = undefined;
      if (
        drag.x >= edge.left &&
        drag.x <= edge.right &&
        drag.y >= edge.top &&
        drag.y <= edge.bottom
      ) {
        const items = [
          ...rail.querySelectorAll<HTMLElement>(".workspace-content-tab"),
        ];
        const target =
          items.find((item) => drag.x < item.getBoundingClientRect().right) ??
          items.at(-1);
        if (target) {
          const bounds = target.getBoundingClientRect();
          drag.target = target.dataset.tabId;
          drag.after = drag.x >= bounds.left + bounds.width / 2;
        }
      }
      setTabDrag({
        source: drag.source,
        target: drag.target,
        placement: drag.after ? "after" : "before",
      });
    };
    const scrollAtEdge = () => {
      dragFrame.current = null;
      const drag = pointerDrag.current;
      const rail = tabRail.current;
      if (!drag?.dragging || !rail) return;
      const edge = rail.getBoundingClientRect();
      if (
        drag.x < edge.left ||
        drag.x > edge.right ||
        drag.y < edge.top ||
        drag.y > edge.bottom
      )
        return;
      const inset = Math.min(28, edge.width / 3);
      const delta =
        drag.x < edge.left + inset
          ? -Math.ceil((edge.left + inset - drag.x) / 3)
          : drag.x > edge.right - inset
            ? Math.ceil((drag.x - edge.right + inset) / 3)
            : 0;
      const previous = rail.scrollLeft;
      rail.scrollLeft += delta;
      updateTarget();
      if (delta && rail.scrollLeft !== previous)
        dragFrame.current = window.requestAnimationFrame(scrollAtEdge);
    };
    const move = (event: PointerEvent) => {
      const drag = pointerDrag.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.dragging) {
        if (Math.hypot(drag.x - drag.originX, drag.y - drag.originY) < 6)
          return;
        drag.dragging = true;
      }
      event.preventDefault();
      updateTarget();
      if (dragFrame.current === null)
        dragFrame.current = window.requestAnimationFrame(scrollAtEdge);
    };
    const finish = (event: PointerEvent) => {
      const drag = pointerDrag.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.dragging) {
        drag.x = event.clientX;
        drag.y = event.clientY;
        updateTarget();
        suppressDragClick.current = true;
        if (drag.target)
          reorderTabRef.current(drag.source, drag.target, Boolean(drag.after));
      }
      clearTabDrag();
    };
    const cancel = () => {
      if (pointerDrag.current?.dragging) suppressDragClick.current = true;
      clearTabDrag();
    };
    const cancelPointer = (event: PointerEvent) => {
      if (pointerDrag.current?.pointerId === event.pointerId) cancel();
    };
    const cancelKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", cancelKey);
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", cancelKey);
      window.removeEventListener("blur", cancel);
    };
  }, [workspaceIdentity, open, signature, canReorder]);
  const resourceCurrent = (epoch: number, owner: string) =>
    mounted.current &&
    threadIdRef.current === owner &&
    resourceEpoch.current === epoch;
  const materializing = useRef(new Set<string>());
  useEffect(() => {
    const descriptor = selectedDescriptor;
    if (
      !open ||
      choosing ||
      !threadId ||
      descriptor?.kind !== "webpage" ||
      !presentationState ||
      !onReplaceTab
    )
      return;
    const id = sidebarTabId(descriptor);
    const owner = threadId;
    const intent = `${sidebarOwnerKey(presentationState.owner)}:${descriptor.id}`;
    if (materializing.current.has(intent)) return;
    materializing.current.add(intent);
    void window.zenx.workspaceBrowser
      .command(owner, "materialize", intent, descriptor.url)
      .then(async (value) => {
        const tab = value.at(-1);
        if (!tab) return;
        // The owner controller, not a mounted snapshot, decides whether this
        // intent or its idempotent native tab is still retained in any window.
        const retained = await onReplaceTab(id, {
          kind: "browser",
          id: tab.id,
          ...(descriptor.resourceThreadId
            ? { resourceThreadId: descriptor.resourceThreadId }
            : {}),
        });
        if (retained === false)
          await window.zenx.workspaceBrowser.command(owner, "close", tab.id);
        else if (mounted.current && threadIdRef.current === owner) {
          setBrowserTabs(value);
          setBrowserListThread(owner);
        }
      })
      .catch((reason) => {
        if (mounted.current) setError(String(reason));
      })
      .finally(() => materializing.current.delete(intent));
  }, [
    open,
    choosing,
    threadId,
    selectedTab,
    selectedDescriptor,
    presentationState,
    onReplaceTab,
  ]);
  const showChooser = choosing || tabs.length === 0;
  const fileSurface =
    (!showChooser && active?.startsWith("file:")) ||
    (showChooser && pickingFile);
  const fileNavigationVisible =
    fileSurface && (fileNavigationOpen || pickingFile);
  useLayoutEffect(() => {
    const body = fileBody.current;
    if (!body || !open || !fileNavigationVisible || pickingFile) return;
    const measure = () => {
      const bounds = body.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const stacked = getComputedStyle(body).flexDirection === "column";
      const max = stacked
        ? Math.max(100, Math.min(300, bounds.height - 160))
        : Math.max(140, Math.min(360, bounds.width - 240));
      setFileSplit((current) =>
        current.stacked === stacked && current.max === max
          ? current
          : { stacked, max },
      );
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(body);
    measure();
    return () => observer?.disconnect();
  }, [open, expanded, fileNavigationVisible, pickingFile]);
  const fileNavigationMinimum = fileSplit.stacked ? 100 : 140;
  const fileNavigationSize = Math.min(
    fileSplit.max,
    Math.max(
      fileNavigationMinimum,
      fileSplit.stacked ? fileNavigationHeight : fileNavigationWidth,
    ),
  );
  const resizeFileNavigation = (value: number) => {
    const clamped = Math.max(
      fileNavigationMinimum,
      Math.min(fileSplit.max, value),
    );
    if (fileSplit.stacked) setFileNavigationHeight(clamped);
    else setFileNavigationWidth(clamped);
  };
  const select = (id: string, focusTab = false) => {
    suppressFollowing();
    setPresentation(undefined);
    selectionEpoch.current += 1;
    reorderedFocus.current = null;
    pendingTabFocus.current = focusTab ? id : null;
    setChoosing(false);
    setPickingFile(false);
    setError("");
    onSelectTab(available.has(id) ? id : scopedId(id));
  };
  useLayoutEffect(() => {
    // Host SDK panel requests can change selection without calling select().
    // Fence pending actions as soon as that external selection is committed.
    selectionEpoch.current += 1;
    reorderedFocus.current = null;
    if (pendingTabFocus.current !== selectedTab) pendingTabFocus.current = null;
    setChoosing(false);
    setPickingFile(false);
  }, [selectedTab]);
  useLayoutEffect(() => {
    const rail = tabRail.current;
    if (!rail || !open) return;
    const items = [
      ...rail.querySelectorAll<HTMLElement>(".workspace-content-tab"),
    ];
    const measure = () => {
      const origin = rail.getBoundingClientRect().left - rail.scrollLeft;
      return items.map((item) => {
        const bounds = item.getBoundingClientRect();
        return {
          item,
          left: bounds.left - origin,
          right: bounds.right - origin,
        };
      });
    };
    const reveal = () => {
      if (rail.clientWidth <= 0) return;
      const bounds = measure();
      const last = bounds.at(-1);
      // Reserve only the missing fraction of a tab at the end. Without this
      // slack, maxScroll clamps the last reveal halfway through an earlier tab.
      const maximum = Math.max(0, (last?.right ?? 0) + 2 - rail.clientWidth);
      const end = bounds.find((tab) => tab.left - 2 >= maximum - 0.5)?.left;
      rail.style.setProperty(
        "--workspace-tab-end-gap",
        `${Math.ceil(Math.max(0, (end ?? maximum + 2) - 2 - maximum))}px`,
      );
      const selected = bounds.find(
        ({ item }) =>
          item.querySelector('[role="tab"]')?.id === `aux-tab-${active}`,
      );
      if (selected) {
        const minimum = selected.right + 2 - rail.clientWidth;
        // Keep as many complete preceding tabs as fit, never a title-only tail.
        const candidates = bounds
          .map((tab) => tab.left - 2)
          .filter(
            (left) => left >= minimum - 0.5 && left <= selected.left - 2 + 0.5,
          );
        const next = candidates.reduce(
          (nearest, left) =>
            Math.abs(left - rail.scrollLeft) <
            Math.abs(nearest - rail.scrollLeft)
              ? left
              : nearest,
          candidates[0] ?? selected.left - 2,
        );
        rail.scrollLeft = Math.max(
          0,
          Math.min(next, rail.scrollWidth - rail.clientWidth),
        );
      }
    };
    reveal();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(reveal);
    observer?.observe(rail);
    for (const item of items) observer?.observe(item);
    return () => {
      observer?.disconnect();
    };
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
  useEffect(() => {
    currentExternalIds.current.clear();
    setExternalTargets([]);
    setExternalListScope(externalScope);
    setDismissedExternal([]);
  }, [externalScope]);
  useEffect(() => {
    if (!browser || !threadId || !window.zenx.browserObservation) return;
    let alive = true;
    const stop = window.zenx.browserObservation.subscribe(
      { threadId, frames: false, catalog: true },
      (event) => {
        if (!alive) return;
        if (event.type === "activity") {
          if (
            event.phase !== "started" ||
            event.threadId !== threadId ||
            !acceptBrowserOperation(threadId, event.operationSequence) ||
            !currentExternalIds.current.has(event.targetId)
          )
            return;
          const prior = browserFollowingByThread.get(threadId);
          const following =
            prior?.epoch === event.sessionEpoch
              ? prior
              : {
                  epoch: event.sessionEpoch,
                  suppressed: prior?.suppressed ?? false,
                  tabId: "",
                };
          following.tabId = `external-browser:${event.targetId}`;
          browserFollowingByThread.set(threadId, following);
          if (browserFollowingByThread.size > 512)
            browserFollowingByThread.delete(
              browserFollowingByThread.keys().next().value!,
            );
          setFollowRevision((value) => value + 1);
          const key = JSON.stringify([event.sessionEpoch, event.targetId]);
          if (externalPresentations.has(key)) return;
          externalPresentations.add(key);
          if (externalPresentations.size > 512)
            externalPresentations.delete(
              externalPresentations.values().next().value!,
            );
          if (
            following.suppressed ||
            dismissedExternalRef.current.includes(event.targetId) ||
            document.visibilityState === "hidden" ||
            Date.now() - event.requestedAt > 5_000 ||
            lastBrowserIntent.current >= event.requestedAt
          ) {
            following.suppressed = true;
            return;
          }
          automaticSelection.current = scopedIdRef.current(following.tabId);
          setPresentation(undefined);
          setChoosing(false);
          setPickingFile(false);
          presentationCallbacks.current.onSelectTab(following.tabId);
          autoOpening.current = true;
          presentationCallbacks.current.onOpenChange(true);
          return;
        }
        if (event.type !== "targets") return;
        // Preserve exact observer/backend/connection identity, never match URLs.
        const external = event.targets.filter(
          (target) => target.backendId !== "workspace",
        );
        currentExternalIds.current = new Set(
          external.map((target) => target.id),
        );
        setExternalTargets((previous) => [
          ...previous
            .filter((old) => !external.some((next) => next.id === old.id))
            .map((old) => ({ ...old, activityCount: 0 })),
          ...external,
        ]);
      },
    );
    return () => {
      alive = false;
      stop();
    };
  }, [threadId, browser, snapshot]);
  useEffect(() => {
    const api = window.zenx.workspaceBrowser;
    setPresentation(undefined);
    automaticSelection.current = undefined;
    if (!threadId || !api?.onPresentation) return;
    const lease = crypto.randomUUID();
    let alive = true;
    const stop = api.onPresentation((request) => {
      if (!alive || request.threadId !== threadId) return;
      if (!acceptBrowserOperation(threadId, request.operationSequence)) {
        void api.declinePresentation(request.requestId).catch(() => undefined);
        return;
      }
      const previous = browserFollowingByThread.get(threadId);
      const following =
        previous?.epoch === request.sessionEpoch
          ? previous
          : {
              epoch: request.sessionEpoch,
              suppressed: previous?.suppressed ?? false,
              tabId: `browser:${request.tab.id}`,
            };
      following.tabId = `browser:${request.tab.id}`;
      browserFollowingByThread.set(threadId, following);
      if (browserFollowingByThread.size > 512)
        browserFollowingByThread.delete(
          browserFollowingByThread.keys().next().value!,
        );
      setFollowRevision((value) => value + 1);
      if (
        following.suppressed ||
        document.visibilityState === "hidden" ||
        request.expiresAt <= Date.now() ||
        lastBrowserIntent.current >= request.requestedAt
      ) {
        following.suppressed = true;
        void api.declinePresentation(request.requestId).catch(() => undefined);
        return;
      }
      automaticSelection.current = scopedIdRef.current(
        `browser:${request.tab.id}`,
      );
      setBrowserTabs((tabs) => [
        ...tabs.filter((tab) => tab.id !== request.tab.id),
        request.tab,
      ]);
      setBrowserListThread(threadId);
      setPresentation(request);
      setChoosing(false);
      setPickingFile(false);
      presentationCallbacks.current.onSelectTab(automaticSelection.current);
      autoOpening.current = true;
      presentationCallbacks.current.onOpenChange(true);
    });
    void api.presentationContext({ threadId, lease }).catch((reason) => {
      if (alive) setError(String(reason));
    });
    return () => {
      alive = false;
      stop();
      void api.presentationContext({ lease }).catch(() => undefined);
    };
  }, [threadId]);
  useEffect(() => {
    if (
      automaticSelection.current &&
      selectedTab !== automaticSelection.current
    )
      suppressFollowing();
    if (open === false && automaticSelection.current) suppressFollowing();
  }, [selectedTab, open]);
  const following = threadId
    ? browserFollowingByThread.get(threadId)
    : undefined;
  const followAgent = () => {
    if (!following) return;
    if (following.tabId.startsWith("external-browser:")) {
      const id = following.tabId.slice("external-browser:".length);
      if (!currentExternalIds.current.has(id)) return;
      setDismissedExternal((previous) =>
        previous.filter((value) => value !== id),
      );
    }
    following.suppressed = false;
    setPresentation(undefined);
    automaticSelection.current = scopedIdRef.current(following.tabId);
    onSelectTab(automaticSelection.current);
    onOpenChange(true);
    setChoosing(false);
    setFollowRevision(followRevision + 1);
  };
  const add = async (id: string) => {
    const operationEpoch = ++selectionEpoch.current;
    const bindingEpoch = resourceEpoch.current;
    setError("");
    if (id === "file") {
      setPickingFile(true);
      setFileNavigationOpen(true);
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
    select(sidebarTabId({ kind: "file", path: value.path }));
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
    // Consume the request: the panel is keyed by thread and remounts on
    // every switch, so a stale request would otherwise reopen the link.
    onMessageLinkRequestHandled?.(messageLinkRequest.id);
    const operationEpoch = ++selectionEpoch.current;
    const bindingEpoch = resourceEpoch.current;
    const current = () =>
      resourceCurrent(bindingEpoch, threadId) &&
      selectionEpoch.current === operationEpoch;
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
          if (current()) {
            setBrowserTabs(tabs);
            const newest = tabs.at(-1);
            if (newest) select(`browser:${newest.id}`);
          }
        }
      } catch (reason) {
        if (current())
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    // Clearing the inbox acknowledges consumption, not cancellation. Existing
    // resource/selection epochs fence newer navigation and actual unmounts.
    // A request id represents a single click; render changes must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageLinkRequest?.id, threadId]);
  const remove = (id: string, expectedEpoch?: number) => {
    if (onRemoveTab) {
      onRemoveTab(id);
      return;
    }
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
      const owner = tab.resourceThreadId ?? threadId;
      if (owner === undefined) return;
      const key = fileDraftKey(owner, tab.path);
      const draft = drafts.snapshot().get(key);
      if (draft && (isFileDirty(draft) || draft.saving)) {
        if (draft.conflict || draft.error) {
          select(tab.id);
          setError("__zenx_file_save_blocked__");
          return;
        }
        drafts.closeAfterSave(
          key,
          (text, revision) =>
            window.zenx.workspaceFiles.save(owner, tab.path!, text, revision),
          () => remove(tab.id),
        );
        return;
      }
      drafts.remove(key);
    } else if (tab.browser || tab.descriptor?.kind === "browser") {
      const owner = tab.resourceThreadId ?? threadId;
      const browserId =
        tab.browser?.id ??
        (tab.descriptor?.kind === "browser" ? tab.descriptor.id : undefined);
      if (!owner || !browserId) return;
      // An unavailable member's descriptor may be dismissed, but must not execute
      // against a different selected member or a departed member's resources.
      if (
        roomContext &&
        !roomContext.resourceThreads?.some(
          (member) => member.threadId === owner,
        ) &&
        roomContext.resourceThread?.threadId !== owner
      ) {
        remove(tab.id);
        return;
      }
      operationEpoch = selectionEpoch.current;
      try {
        const value = await window.zenx.workspaceBrowser.command(
          owner,
          "close",
          browserId,
        );
        if (resourceCurrent(bindingEpoch, owner)) setBrowserTabs(value);
        else if (!onRemoveTab) return;
      } catch (reason) {
        if (mounted.current) setError(String(reason));
        return;
      }
    }
    if (tab.externalBrowser)
      setDismissedExternal((ids) => [...ids, tab.externalBrowser!.id]);
    remove(tab.id, operationEpoch);
  };
  const close = () => {
    suppressFollowing();
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
      aria-label={i18n.t("panels:sidePanelFor", { title })}
      style={{ "--auxiliary-width": `${width}px` } as React.CSSProperties}
      onKeyDown={(event) => {
        if (
          fileSurface &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === "p" &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          event.preventDefault();
          setFileNavigationOpen(true);
          requestAnimationFrame(() => {
            const input = panel.current?.querySelector<HTMLInputElement>(
              '.workspace-file-navigation input[type="search"]',
            );
            input?.focus();
            input?.select();
          });
        }
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
                data-agent-active={Boolean(
                  (tab.browser &&
                    (tab.browser.agentActionsInFlight > 0 ||
                      (tab.browser.agentInspectionsInFlight ?? 0) > 0)) ||
                  (tab.externalBrowser?.activityCount ?? 0) > 0,
                )}
                key={tab.id}
                data-tab-id={tab.id}
                data-reorderable={canReorder || undefined}
                data-dragging={tabDrag?.source === tab.id || undefined}
                data-drop-placement={
                  tabDrag?.target === tab.id ? tabDrag.placement : undefined
                }
                onDragStart={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                  suppressDragClick.current = false;
                  if (
                    !canReorder ||
                    event.button !== 0 ||
                    event.pointerType === "touch" ||
                    pointerDrag.current ||
                    (event.target as HTMLElement).closest(
                      ".workspace-tab-close",
                    )
                  )
                    return;
                  const capture =
                    event.currentTarget.querySelector<HTMLElement>(
                      '[role="tab"]',
                    )!;
                  pointerDrag.current = {
                    source: tab.id,
                    pointerId: event.pointerId,
                    originX: event.clientX,
                    originY: event.clientY,
                    x: event.clientX,
                    y: event.clientY,
                    dragging: false,
                    capture,
                  };
                  capture.setPointerCapture?.(event.pointerId);
                }}
                onLostPointerCapture={(event) => {
                  if (pointerDrag.current?.pointerId === event.pointerId) {
                    suppressDragClick.current = pointerDrag.current.dragging;
                    clearTabDrag();
                  }
                }}
                onClickCapture={(event) => {
                  if (suppressDragClick.current && event.detail !== 0) {
                    suppressDragClick.current = false;
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
              >
                <button
                  type="button"
                  role="tab"
                  id={`aux-tab-${tab.id}`}
                  aria-selected={!showChooser && active === tab.id}
                  aria-controls={`aux-content-${tab.id}`}
                  tabIndex={active === tab.id ? 0 : -1}
                  aria-keyshortcuts={
                    canReorder ? "Alt+ArrowLeft Alt+ArrowRight" : undefined
                  }
                  aria-description={
                    canReorder
                      ? i18n.t("panels:reorderWorkspaceTabHint")
                      : undefined
                  }
                  title={tab.path ?? tab.browser?.url ?? tab.title}
                  onClick={() => select(tab.id)}
                  onKeyDown={(event) => {
                    if (
                      event.altKey &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      ["ArrowLeft", "ArrowRight"].includes(event.key)
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      moveTab(tab.id, event.key === "ArrowLeft" ? -1 : 1);
                      return;
                    }
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
                      select(tabs[next]!.id, true);
                    }
                  }}
                >
                  <Icon name={tab.icon} />
                  <span>{tab.title}</span>
                  {tab.path &&
                  threadId !== undefined &&
                  entries.has(
                    fileDraftKey(tab.resourceThreadId ?? threadId, tab.path),
                  ) &&
                  isFileDirty(
                    entries.get(
                      fileDraftKey(tab.resourceThreadId ?? threadId, tab.path),
                    )!,
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
                  aria-label={i18n.t("panels:closeTabNamed", {
                    title: tab.title,
                  })}
                  title={i18n.t("panels:closeTabNamed", { title: tab.title })}
                  disabled={
                    tab.path && threadId !== undefined
                      ? entries.get(
                          fileDraftKey(
                            tab.resourceThreadId ?? threadId,
                            tab.path,
                          ),
                        )?.closing === true
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
              suppressFollowing();
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
        {following?.suppressed ? (
          <button
            type="button"
            className="browser-follow-button"
            onClick={followAgent}
          >
            {i18n.t("panels:followAgent")}
          </button>
        ) : null}
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
      <div
        ref={fileBody}
        className="auxiliary-body"
        style={
          {
            "--file-navigation-width": `${fileSplit.stacked ? fileNavigationWidth : fileNavigationSize}px`,
            "--file-navigation-height": `${fileSplit.stacked ? fileNavigationSize : fileNavigationHeight}px`,
          } as React.CSSProperties
        }
        data-files={Boolean(fileSurface)}
        data-navigation-open={Boolean(fileNavigationVisible)}
        data-picking={showChooser && pickingFile}
      >
        {fileSurface && !pickingFile ? (
          <button
            type="button"
            className="icon-button workspace-navigation-toggle"
            aria-label={i18n.t(
              fileNavigationVisible
                ? "panels:hideFileNavigation"
                : "panels:showFileNavigation",
            )}
            title={i18n.t(
              fileNavigationVisible
                ? "panels:hideFileNavigation"
                : "panels:showFileNavigation",
            )}
            aria-pressed={Boolean(fileNavigationVisible)}
            aria-expanded={Boolean(fileNavigationVisible)}
            aria-controls="workspace-file-navigation"
            onClick={() => setFileNavigationOpen((value) => !value)}
          >
            <Icon name="folder" />
          </button>
        ) : null}
        {threadId !== undefined && (files.length > 0 || pickingFile) ? (
          <nav
            id="workspace-file-navigation"
            className="workspace-file-navigation"
            aria-label={i18n.t("panels:workspaceFiles")}
            hidden={!fileNavigationVisible}
          >
            <WorkspaceFilePicker
              threadId={threadId}
              workspacePath={workspacePath}
              selectedPath={
                active?.startsWith("file:")
                  ? available.get(active)?.path
                  : undefined
              }
              navigation={!pickingFile}
              onOpen={openFile}
              onBack={() => {
                selectionEpoch.current += 1;
                setPickingFile(false);
              }}
            />
          </nav>
        ) : null}
        {threadId !== undefined && files.length > 0 ? (
          <div
            className="workspace-file-resizer"
            role="separator"
            aria-label={i18n.t("panels:resizeFileNavigation")}
            title={i18n.t("panels:resizeFileNavigation")}
            aria-controls="workspace-file-navigation"
            aria-orientation={fileSplit.stacked ? "horizontal" : "vertical"}
            aria-valuemin={fileNavigationMinimum}
            aria-valuemax={fileSplit.max}
            aria-valuenow={fileNavigationSize}
            hidden={!fileNavigationVisible || pickingFile}
            tabIndex={0}
            onKeyDown={(event) => {
              const decrease = fileSplit.stacked ? "ArrowUp" : "ArrowLeft";
              const increase = fileSplit.stacked ? "ArrowDown" : "ArrowRight";
              const next =
                event.key === "Home"
                  ? fileNavigationMinimum
                  : event.key === "End"
                    ? fileSplit.max
                    : event.key === decrease
                      ? fileNavigationSize - 20
                      : event.key === increase
                        ? fileNavigationSize + 20
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              resizeFileNavigation(next);
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              const bounds = fileBody.current?.getBoundingClientRect();
              if (bounds)
                resizeFileNavigation(
                  fileSplit.stacked
                    ? event.clientY - bounds.top
                    : event.clientX - bounds.left,
                );
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          />
        ) : null}
        <div className="auxiliary-views" hidden={showChooser && pickingFile}>
          {showChooser ? (
            <div className="auxiliary-content workspace-new-tab">
              {pickingFile ? null : (
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
                          : i18n.t(
                              "panels:chooseARoomMemberToEnableConversation",
                            )
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
                      <button
                        type="button"
                        onClick={() => void add("terminal")}
                      >
                        <Icon name="terminal" />
                        <span>
                          <strong>{i18n.t("panels:shellTitle")}</strong>
                          <small>{i18n.t("panels:shellChooser")}</small>
                        </span>
                      </button>
                      <button type="button" onClick={() => void add("file")}>
                        <Icon name="file" />
                        <span>
                          <strong>{i18n.t("panels:file")}</strong>
                          <small>
                            {i18n.t("panels:readOrEditAFileInThis")}
                          </small>
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
                        <button
                          type="button"
                          onClick={() => void add("computer")}
                        >
                          <Icon name="computer" />
                          <span>
                            <strong>{i18n.t("panels:computer")}</strong>
                            <small>
                              {i18n.t("panels:observeTheAgentSDesktopActivity")}
                            </small>
                          </span>
                        </button>
                      ) : null}
                      {panels.map((panel) => (
                        <div
                          className="workspace-plugin-choice"
                          key={panel.key}
                        >
                          <button
                            type="button"
                            onClick={() => void add(`plugin:${panel.key}`)}
                          >
                            <Icon name={panelIcon(panel.pluginId)} />
                            <span>
                              <strong>
                                {panel.pluginId === "zenx-triggers"
                                  ? i18n.t("panels:automations")
                                  : panel.title}
                              </strong>
                              {panel.pluginId === "zenx-subagents" ? (
                                <small>
                                  {i18n.t(
                                    "panels:subagentsWorkspaceDescription",
                                  )}
                                </small>
                              ) : panel.pluginId === "zenx-triggers" ? (
                                <small>
                                  {i18n.t(
                                    "panels:triggersWorkspaceDescription",
                                  )}
                                </small>
                              ) : null}
                            </span>
                          </button>
                          {panel.pluginId === "zenx-subagents" && snapshot ? (
                            <GenericPluginUiHost
                              registry={pluginUiRegistry}
                              snapshot={snapshot}
                              pluginId={panel.pluginId}
                              surfaceId={panel.surfaceId}
                              context={{
                                threadId,
                                quickCreate: true,
                                active: open === true,
                              }}
                              theme={theme}
                              executeCommand={
                                window.zenx.plugins.executeCommand
                              }
                              readHandle={window.zenx.plugins.readHandle}
                              navigate={navigate}
                            />
                          ) : null}
                        </div>
                      ))}
                    </>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
          {tabs.map((tab) => {
            const visible = !showChooser && active === tab.id;
            const panel = panels.find(
              (value) => scopedId(`plugin:${value.key}`) === tab.id,
            );
            const conversation = conversations.find(
              (value) => `thread:${value.threadId}` === tab.id,
            );
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
                {visible && selectedResource && !roomResource ? (
                  <p role="status">
                    This resource's Thread is no longer available in this Room.
                  </p>
                ) : null}
                {tab.path && threadId !== undefined && open && visible ? (
                  <WorkspaceFilesPanel
                    threadId={tab.resourceThreadId ?? threadId}
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
                    presentationId={
                      presentation?.tab.id === tab.browser.id
                        ? presentation.requestId
                        : undefined
                    }
                  />
                ) : null}
                {(tab.descriptor?.kind === "terminal" ||
                  tab.id === "terminal") &&
                threadId !== undefined ? (
                  <ShellThreadPanel
                    key={tab.resourceThreadId ?? threadId}
                    threadId={tab.resourceThreadId ?? threadId}
                    active={open === true && visible}
                    targetRequest={
                      shellNavigation?.request?.ownerKey ===
                      (presentationState
                        ? sidebarOwnerKey(presentationState.owner)
                        : `thread:${threadId}`)
                        ? shellNavigation.request
                        : null
                    }
                    onTargetConsumed={shellNavigation?.consumed}
                  />
                ) : null}
                {(tab.descriptor?.kind === "computer" ||
                  tab.id === "computer") &&
                threadId !== undefined ? (
                  <ComputerThreadPanel
                    threadId={threadId}
                    active={open === true && visible}
                  />
                ) : null}
                {tab.externalBrowser && threadId !== undefined ? (
                  <BrowserThreadPanel
                    threadId={threadId}
                    title={tab.externalBrowser.connectionLabel || title}
                    fixedTargetId={tab.externalBrowser.id}
                    activityCount={tab.externalBrowser.activityCount}
                    activityFailed={tab.externalBrowser.activityFailed}
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
        </div>
      </div>
    </aside>
  );
}
