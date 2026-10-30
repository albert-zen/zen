import { chooseSideChatQuoteTarget } from "./side-chat-quote-target.js";
import { addMessageQuote } from "./message-quote.js";
import type { MessageQuoteReference } from "./composer-selector.js";
import {
  ShellTargetNavigationContext,
  openShellTarget,
  type ShellTargetRequest,
} from "./shell-target-navigation.js";
import {
  applyCompactionStatus,
  markCompactionOutcomeUnknown,
} from "./compaction-feedback.js";
import { PluginInformationHost } from "./plugin-information-host.js";
import { resolveDeliveredMessage } from "./tool-action-targets.js";
import type { MessageTargetRequest } from "./message-target-navigation.js";
import { unwrapCompactionIpcReply } from "../../preload/compaction-ipc.js";
import type { ClientSendObservation } from "../../../../../src/client-observation.js";
import { sidebarTabId, sidebarTabFromId } from "../../thread-sidebar-state.js";
import { useThreadSidebar } from "./use-thread-sidebar.js";
import { requestManualTurnRetry } from "./manual-turn-retry.js";
import { type MessageSourceNavigator } from "./message-source-navigation.js";
import { requestQueuedSteer } from "./queue-steer-request.js";
import { sidebarTriggerAdmissionId } from "./sidebar-thread-information.js";
import { applyThreadTitleReceipt } from "./thread-title-receipt.js";
import {
  conversationReadStore,
  useConversationReadPreference,
  unreadThreadIds,
} from "./conversation-read-state.js";
import { createThreadEndNotificationObserver } from "./thread-end-notifications.js";
import {
  RemoteMessageSourceDialog,
  type RemoteMessageSourceApi,
} from "./RemoteMessageSourceDialog.js";
import type { FleetMessageSourceView } from "../../main/fleet-settings.js";
import { SessionImportDialog } from "./SessionImportDialog.js";
import type { DeletedThreadSummary } from "../../../../../src/protocol/native/wire.js";
import { ThreadReadingStateProvider } from "./thread-reading-state.js";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import {
  Dialog,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui/controls.js";
import { ImZenXDraftContext, type ImZenXDraft } from "./imzenx-ui.js";
import { RoomDraftContext } from "./room-drafts.js";
import { RoomHeaderContext } from "./room-header.js";
import {
  ROOM_ROUTE,
  useRoomConversations,
  roomConversationRoute,
  roomConversationAdmissionRevision,
} from "./room-conversations.js";
import {
  CompanionWorkspace,
  type CompanionViewState,
} from "./companion-workspace.js";
import { parseSkillDraft } from "./skill-draft.js";
import { referenceMessage, referenceTitle } from "./reference-draft.js";
import {
  handleCompactCommand,
  isCompactCommand,
  requestContextCompaction,
} from "./compact-command.js";
import { useWorkspaceFileDrafts } from "./workspace-file-drafts.js";
import { SideChatDrafts } from "./side-chat-drafts.js";
import { AuxiliaryPanel } from "./auxiliary-panel.js";
import { SidebarResizer } from "./SidebarResizer.js";
import { AgentReadinessNotice } from "./AgentReadinessNotice.js";
import { FleetComposerSurface } from "./FleetComposerSurface.js";
import type { FilePermissionMode } from "../../protocol-client/types.js";
import {
  default as React,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AttachmentRef } from "../../../../../src/attachment.js";
import type {
  AppServerEvent,
  QueuedCancellationResult,
  QueuedCancellationTarget,
} from "../../../../../src/app-server.js";
import type { EffectiveThreadConfiguration } from "../../../../../src/thread.js";
import type {
  NativeThreadSummary,
  ThreadSummary,
} from "../../../../../src/thread-summary.js";
import type { ModelUsageProjection } from "../../../../../src/model-usage.js";
import type {
  AppServerHostStatus,
  ApprovalDecision,
} from "../../main/app-server-manager.js";
import type { ZenXThreadAttachmentProjection } from "../../main/image-attachments.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type {
  ZenXProjectProjectionEntry,
  ZenXProjectProjectionSnapshot,
} from "../../main/project-projection.js";
import type {
  ZenXHostProfile,
  ZenXProviderProfile,
  ZenXSidebarOrder,
} from "../../main/host-profile.js";
import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "../../main/thread-title-types.js";
import type {
  ModelSummary,
  ServerNotificationMethod,
  ServerNotificationParams,
  Thread,
} from "../../protocol-client/index.js";
import {
  decodeModelKey,
  encodeModelKey,
} from "../../../../../src/protocol/model-key.js";
import {
  addApprovalRequest,
  markApprovalResponding,
  pendingApprovalThreadIds,
  replacePendingApprovals,
  resolveApproval,
  restoreApprovalPending,
  type ApprovalCardState,
  type ApprovalStateEvent,
} from "./approval-state.js";
import {
  acceptComposerSubmission,
  advanceComposerDraftRevision,
  addComposerImages,
  beginComposerSubmission,
  editComposer,
  emptyComposerState,
  dismissCompactionFeedback,
  failComposerSubmission,
  reconcileCanonicalAdmission,
  removeComposerImage,
  type ComposerIntent,
  type ComposerState,
  type ComposerSubmission,
} from "./composer-state.js";
import { Icon } from "./icons.js";
import { ProjectEditor } from "./ProjectEditor.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import {
  applySettingsMirror,
  canSendWithModel,
  hasValidReasoningSelection,
  canChangeThreadModel,
  modelChangeRequest,
  permissionModeFromPolicy,
  imageCapabilityMessage,
  imageCapabilityNotice,
  reasoningChangeRequest,
  settingsFromSnapshot,
  validateModelCatalog,
  type SelectedThreadSettings,
} from "./model-settings.js";
import {
  loadedPluginContributions,
  pluginRoutePath,
} from "./plugin-contributions.js";
import {
  PluginProductPage,
  pluginUiRegistry,
  useAppearance,
} from "./PluginProductPage.js";
import { SettingsView, type SettingsTab } from "./SettingsView.js";
import { ThreadTitleEditor } from "./thread-title-editor.js";
import { Sidebar, ThreadDebugMenuContext } from "./Sidebar.js";
import {
  derivePinnedThreads,
  EMPTY_SIDEBAR_ORDER,
  readSidebarMode,
  threadHasActiveTurn,
  lastUsedProjectWorkspace,
  moveSidebarProject,
  moveSidebarThread,
  movePinnedThreadIds,
  threadEditTitle,
  threadTitle,
  writeSidebarMode,
  type SidebarMode,
} from "./thread-list.js";
import {
  applyNativeThreadEvent,
  applyThreadViewNotification,
  markThreadViewAwaitingRecovery,
  projectNativeRecovery,
  projectNativeThread,
} from "./thread-view-state.js";
import {
  ThreadView,
  ThreadViewActionsProvider,
  type MessageForkHandler,
} from "./ThreadView.js";
import { ThreadConversationViewport } from "./thread-conversation-viewport.js";
import { requestQueuedEdit, importQueuedImages } from "./queue-edit-request.js";
import {
  createQueueEditStore,
  type QueueEditStore,
} from "./queue-edit-state.js";
import {
  ChildThreadSidebarContext,
  PluginThreadHeaders,
  ThreadBreadcrumbAncestors,
  SubagentCreationModelsContext,
  SideChatDraftContext,
} from "./subagents-ui.js";
import { cancellationResultsFromItems } from "./queue-cancel-state.js";
import type { WorkflowCommand } from "./workflow-commands.js";
import { ZenXBrand } from "./ZenXBrand.js";

type ProductPage = string;
const modelCatalogLoading = () => i18n.t("shell:modelsAreStillLoadingTryAgain");
const isModelCatalogLoading = (value: string | null) =>
  value !== null &&
  (value === i18n.t("shell:modelsAreStillLoadingTryAgain", { lng: "en" }) ||
    value === i18n.t("shell:modelsAreStillLoadingTryAgain", { lng: "zh-CN" }));
const SIDEBAR_COLLAPSED_STORAGE_KEY = "zenx.sidebar-collapsed";

interface NewThreadDraft {
  permissionMode?: FilePermissionMode;
  id: string;
  workspace: string | null;
  composer: ComposerState;
  settings: SelectedThreadSettings | null;
}

type BufferedProtocolNotification = {
  [M in ServerNotificationMethod]: {
    method: M;
    params: ServerNotificationParams[M];
  };
}[ServerNotificationMethod];

interface ThreadProjectionCacheEntry {
  thread: Thread;
  settings: SelectedThreadSettings;
  activeTurnNotifications: BufferedProtocolNotification[];
  processEpoch: string | null;
  watermark: number;
}

export function replayThreadProjection(
  thread: Thread,
  settings: SelectedThreadSettings,
  notifications: readonly BufferedProtocolNotification[],
  recovery: { processEpoch: string | null; watermark: number } | null = null,
): ThreadProjectionCacheEntry {
  let projectedThread = thread;
  let projectedSettings = settings;
  let processEpoch = recovery?.processEpoch ?? null;
  let watermark = recovery?.watermark ?? 0;
  const replayed: BufferedProtocolNotification[] = [];
  for (const notification of notifications) {
    if (notification.method === "zen/thread/event") {
      const event = notification.params;
      if (
        (processEpoch !== null && event.processEpoch !== processEpoch) ||
        event.watermark <= watermark
      )
        continue;
      processEpoch = event.processEpoch;
      watermark = event.watermark;
    } else if (
      processEpoch !== null &&
      isLegacyTurnProjectionNotification(notification.method)
    ) {
      continue;
    }
    replayed.push(notification);
    projectedThread =
      notification.method === "zen/thread/event"
        ? applyNativeThreadEvent(projectedThread, notification.params.event)
        : applyThreadViewNotification(
            projectedThread,
            notification.method,
            notification.params,
          );
    if (
      notification.method === "zen/thread/event" &&
      notification.params.event.type === "thread_settings_updated" &&
      notification.params.event.threadId === projectedSettings.threadId
    ) {
      projectedSettings = settingsFromSnapshot(
        projectedSettings.threadId,
        nativeSettingsSnapshot(notification.params.event.settings),
      );
    }
    if (notification.method === "thread/settings/updated") {
      const event =
        notification.params as ServerNotificationParams["thread/settings/updated"];
      projectedSettings =
        applySettingsMirror(
          projectedSettings,
          event.threadId,
          event.threadSettings,
        ) ?? projectedSettings;
    }
  }
  return {
    thread: projectedThread,
    settings: projectedSettings,
    activeTurnNotifications: activeTurnNotificationTail(replayed),
    processEpoch,
    watermark,
  };
}

function notificationThreadId(
  notification: BufferedProtocolNotification,
): string | null {
  const threadId = (notification.params as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : null;
}

function retainsActiveTurnNotification(
  method: ServerNotificationMethod,
): boolean {
  return (
    method === "zen/thread/event" ||
    method === "thread/queue/updated" ||
    method === "thread/settings/updated" ||
    method === "turn/started" ||
    method === "item/started" ||
    method === "item/agentMessage/delta" ||
    method === "item/reasoning/summaryPartAdded" ||
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta" ||
    method === "item/commandExecution/outputDelta" ||
    method === "item/completed"
  );
}

function isLegacyTurnProjectionNotification(
  method: ServerNotificationMethod,
): boolean {
  return (
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "item/started" ||
    method === "item/agentMessage/delta" ||
    method === "item/reasoning/summaryPartAdded" ||
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta" ||
    method === "item/commandExecution/outputDelta" ||
    method === "item/completed"
  );
}

function nativeSettingsSnapshot(
  snapshot: EffectiveThreadConfiguration,
): import("../../protocol-client/types.js").ThreadSettingsSnapshot {
  return {
    model: encodeModelKey(snapshot),
    modelProvider: snapshot.providerProfileId,
    serviceTier: null,
    cwd: snapshot.cwd,
    instructionSources: [],
    approvalPolicy:
      snapshot.approvalPolicy === "never" ? "never" : "on-request",
    approvalsReviewer: "user",
    sandbox:
      snapshot.sandbox === "danger-full-access"
        ? { type: "dangerFullAccess" }
        : snapshot.sandbox === "read-only"
          ? { type: "readOnly" }
          : {
              type: "workspaceWrite",
              writableRoots: [],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
    reasoningEffort: snapshot.reasoningEffort,
  };
}

function activeTurnNotificationTail(
  notifications: readonly BufferedProtocolNotification[],
): BufferedProtocolNotification[] {
  const tail: BufferedProtocolNotification[] = [];
  for (const notification of notifications) {
    if (
      notification.method === "turn/completed" ||
      (notification.method === "zen/thread/event" &&
        notification.params.event.type === "turn_completed")
    ) {
      const independent = tail.filter(
        (entry) =>
          entry.method === "thread/queue/updated" ||
          entry.method === "thread/settings/updated",
      );
      tail.splice(0, tail.length, ...independent);
    } else if (retainsActiveTurnNotification(notification.method)) {
      if (
        notification.method === "thread/queue/updated" ||
        notification.method === "thread/settings/updated"
      ) {
        const previous = tail.findIndex(
          (entry) => entry.method === notification.method,
        );
        if (previous !== -1) tail.splice(previous, 1);
      }
      tail.push(notification);
    }
  }
  return tail;
}

export function updateThreadProjectionCache(
  cache: Map<string, ThreadProjectionCacheEntry>,
  notification: BufferedProtocolNotification,
): ThreadProjectionCacheEntry | undefined {
  const threadId = notificationThreadId(notification);
  if (threadId === null) return undefined;
  const current = cache.get(threadId);
  if (current === undefined) return undefined;
  if (
    notification.method === "zen/thread/event" &&
    current.processEpoch === null
  ) {
    // Creation still returns a compatibility view. Retain, but do not trust or
    // apply, native events until resume establishes this Host's epoch/boundary.
    const pending = {
      ...current,
      activeTurnNotifications: [
        ...current.activeTurnNotifications,
        notification,
      ],
    };
    cache.set(threadId, pending);
    return pending;
  }
  if (
    notification.method === "zen/thread/event" &&
    (notification.params.processEpoch !== current.processEpoch ||
      notification.params.watermark <= current.watermark)
  )
    return current;
  if (
    current.processEpoch !== null &&
    isLegacyTurnProjectionNotification(notification.method)
  )
    return current;
  const updated = replayThreadProjection(
    current.thread,
    current.settings,
    [notification],
    {
      processEpoch: current.processEpoch,
      watermark:
        notification.method === "zen/thread/event"
          ? notification.params.watermark - 1
          : current.watermark,
    },
  );
  const notifications = [...current.activeTurnNotifications, notification];
  const activeTurnNotifications =
    current.processEpoch === null
      ? notifications
      : activeTurnNotificationTail(notifications);
  const next = { ...updated, activeTurnNotifications };
  cache.set(threadId, next);
  return next;
}

function AppConversationProviders({
  models,
  modelCatalogError,
  openSideChatDraft,
  shellNavigation,
  ...actions
}: React.ComponentProps<typeof ThreadViewActionsProvider> & {
  models: readonly ModelSummary[];
  modelCatalogError: string | null;
  shellNavigation: NonNullable<
    React.ContextType<typeof ShellTargetNavigationContext>
  >;
  openSideChatDraft: NonNullable<
    React.ContextType<typeof SideChatDraftContext>
  >;
}) {
  return (
    <ShellTargetNavigationContext.Provider value={shellNavigation}>
      <SubagentCreationModelsContext.Provider
        value={{ models, error: modelCatalogError }}
      >
        <SideChatDraftContext.Provider value={openSideChatDraft}>
          <ThreadViewActionsProvider {...actions} />
        </SideChatDraftContext.Provider>
      </SubagentCreationModelsContext.Provider>
    </ShellTargetNavigationContext.Provider>
  );
}

export function App() {
  return (
    <ThreadReadingStateProvider>
      <AppContent />
    </ThreadReadingStateProvider>
  );
}

function AppContent() {
  const appearance = useAppearance();
  const [importSessionOpen, setImportSessionOpen] = useState(false);
  const [queueEditStore] = useState(createQueueEditStore);
  const { i18n: activeI18n } = useTranslation("shell");
  const selectionEpoch = useRef(0);
  const endNotificationsRef = useRef<ReturnType<
    typeof createThreadEndNotificationObserver
  > | null>(null);
  const [debugThreadId, setDebugThreadId] = useState<string | null>(null);
  const messageForkRequests = useRef(new Map<string, Promise<void>>());
  const messageForkNavigation = useRef(0);
  const pendingResumeProjectionRef = useRef<{
    epoch: number;
    threadId: string;
    notifications: BufferedProtocolNotification[];
  } | null>(null);
  const threadProjectionCacheRef = useRef(
    new Map<string, ThreadProjectionCacheEntry>(),
  );
  const invalidateThreadSelection = () => {
    setDebugThreadId(null);
    selectionEpoch.current += 1;
    pendingResumeProjectionRef.current = null;
  };
  const approvalSnapshotEpoch = useRef(0);
  const pendingApprovalSnapshotRef = useRef<{
    epoch: number;
    events: ApprovalStateEvent[];
  } | null>(null);
  const newThreadPendingRef = useRef(false);
  const newThreadDraftRef = useRef<NewThreadDraft | null>(null);
  const newThreadPendingDraftRef = useRef<NewThreadDraft | null>(null);
  const newThreadPromotionsRef = useRef(new Map<string, string>());
  const newThreadImageLeasesRef = useRef(new Map<string, number>());
  /** Per-Project unsent welcome input, kept while the app window lives like
   * Thread composer drafts: renderer-local, never journal or profile state. */
  const retainedNewThreadDraftsRef = useRef(new Map<string, NewThreadDraft>());
  const projectPickerOperationEpoch = useRef(0);
  const projectPickerPendingRef = useRef(false);
  const projectPickerIntentRef = useRef<"add-project" | "new-thread" | null>(
    null,
  );
  const threadUsageLoadEpoch = useRef(0);
  const threadSummaryLoadEpoch = useRef(0);
  const projectLoadEpoch = useRef(0);
  const modelCatalogLoadEpoch = useRef(0);
  const projectsRef = useRef<ZenXProjectProjectionSnapshot>({
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  const selectedThreadIdRef = useRef<string | null>(null);
  const archivingThreadIdsRef = useRef<ReadonlySet<string>>(new Set());
  const composerStatesRef = useRef<Record<string, ComposerState>>({});
  const [, refreshSideChatDrafts] = useState(0);
  const [sideChatTabOrders, setSideChatTabOrders] = useState<
    Record<string, string[]>
  >({});
  const sideChatTabOrdersRef = useRef(sideChatTabOrders);
  sideChatTabOrdersRef.current = sideChatTabOrders;
  const [sideChatSelections, setSideChatSelections] = useState<
    Record<string, string>
  >({});
  const sideChatSelectionsRef = useRef(sideChatSelections);
  sideChatSelectionsRef.current = sideChatSelections;
  const sideChatDrafts = useRef(
    new SideChatDrafts<{
      itemId: string;
      contextItemId: string | null;
    }>(
      () => refreshSideChatDrafts((revision) => revision + 1),
      () => crypto.randomUUID(),
      () => i18n.t("panels:sideChatCreationUnconfirmed"),
    ),
  ).current;

  const pinnedThreadIdsRef = useRef<string[]>([]);
  const sidebarOrderRef = useRef<ZenXSidebarOrder>(EMPTY_SIDEBAR_ORDER);
  const profilePreferenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [composerSendMode, setComposerSendMode] = useState<
    "batch" | "queue" | "soft" | "hard"
  >("soft");
  const composerSendModeRef = useRef(composerSendMode);
  const applyComposerSendMode = (mode: typeof composerSendMode) => {
    if (mode !== composerSendModeRef.current) {
      composerSendModeRef.current = mode;
      const states = Object.fromEntries(
        Object.entries(composerStatesRef.current).map(([threadId, state]) => [
          threadId,
          advanceComposerDraftRevision(state),
        ]),
      );
      composerStatesRef.current = states;
      setComposerStates(states);
      for (const sideDraft of sideChatDrafts.entries())
        sideChatDrafts.updateComposer(
          sideDraft.id,
          advanceComposerDraftRevision,
        );
      const draft = newThreadDraftRef.current;
      if (draft !== null)
        confirmNewThreadDraft({
          ...draft,
          composer: advanceComposerDraftRevision(draft.composer),
        });
      const pending = newThreadPendingDraftRef.current;
      if (pending !== null && pending.id !== draft?.id)
        newThreadPendingDraftRef.current = {
          ...pending,
          composer: advanceComposerDraftRevision(pending.composer),
        };
    }
    setComposerSendMode(mode);
  };
  const [composerSendModeMigration, setComposerSendModeMigration] =
    useState<ZenXHostProfile["composerSendModeMigration"]>(undefined);
  const composerProfileRevisionRef = useRef(-1);
  const applyComposerProfile = (profile: ZenXHostProfile) => {
    const revision = profile.revision ?? 0;
    if (revision < composerProfileRevisionRef.current) return;
    composerProfileRevisionRef.current = revision;
    applyComposerSendMode(profile.composerSendMode ?? "soft");
    setComposerSendModeMigration(profile.composerSendModeMigration);
  };
  const [workflowCommands, setWorkflowCommands] = useState<WorkflowCommand[]>(
    [],
  );
  const [page, setPage] = useState<ProductPage>("agent");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return (
        window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
      );
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let active = true;
    void window.zenx.settings
      .get()
      .then((value) => {
        if (active) {
          applyComposerProfile(value.profile);
          setWorkflowCommands(value.profile.workflowCommands ?? []);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [page]);
  useEffect(() => {
    const onChanged = window.zenx.settings.onChanged;
    if (onChanged === undefined) return undefined;
    return onChanged((value) => {
      applyComposerProfile(value.profile);
      setWorkflowCommands(value.profile.workflowCommands ?? []);
    });
  }, []);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  const [browserSettingsFocusRequest, setBrowserSettingsFocusRequest] =
    useState(0);
  const fileDrafts = useWorkspaceFileDrafts();
  const sidebarState = useThreadSidebar();
  async function replaceSidebarTab(
    owner: import("../../thread-sidebar-state.js").SidebarOwner,
    oldId: string,
    tab: import("../../thread-sidebar-state.js").ThreadSidebarTab,
  ) {
    await sidebarState.controller.edit(
      owner,
      (state) => {
        const tabs = state.tabs
          .map((entry) => (sidebarTabId(entry) === oldId ? tab : entry))
          .filter(
            (entry, index, all) =>
              all.findIndex(
                (other) => sidebarTabId(other) === sidebarTabId(entry),
              ) === index,
          );
        return {
          tabs,
          selectedTab:
            state.selectedTab === oldId ? sidebarTabId(tab) : state.selectedTab,
        };
      },
      undefined,
      "preserve",
    );
    return (
      sidebarState.controller
        .get(owner)
        ?.tabs.some((entry) =>
          [oldId, sidebarTabId(tab)].includes(sidebarTabId(entry)),
        ) ?? false
    );
  }

  const {
    panelTabs,
    setPanelTabs,
    workspaceTabOrder,
    setWorkspaceTabOrder,
    browserPanels,
    setBrowserPanels,
    conversationPanels,
    setConversationPanels,
    roomWorkspaceStates,
    setRoomWorkspaceStates,
  } = sidebarState;
  useEffect(
    () =>
      window.zenx.panels.onOpen((request) => {
        sidebarState.controller.beginPresentationIntent(request.threadId);
        setPanelTabs((current) => ({
          ...current,
          [request.threadId]: `plugin:${request.pluginId}:${request.panelId}`,
        }));
        setBrowserPanels((current) => ({
          ...current,
          [request.threadId]: true,
        }));
      }),
    [],
  );
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(0);
  const [roomReplies, setRoomReplies] = useState<
    Record<string, import("../../main/trigger-types.js").RoomQuote | undefined>
  >({});
  const roomIntentRevisions = useRef<
    Record<
      string,
      { roomId: string; revision: number | null; settled: boolean }
    >
  >({});
  const imzenxDrafts = useRef<Record<string, ImZenXDraft>>({});
  const [roomDrafts, setRoomDrafts] = useState<Record<string, string>>({});
  const roomDraftRevisions = useRef<Record<string, number>>({});

  const messageLinkSequence = useRef(0);
  const [messageLinkRequest, setMessageLinkRequest] = useState<{
    id: number;
    threadId: string;
    kind: "file" | "browser";
    value: string;
  } | null>(null);
  const editingProjectFocusWorkspace = useRef<string | null>(null);
  const [editingProject, setEditingProject] = useState<{
    workspace: string;
    name: string;
  } | null>(null);
  const [projectPickerIntent, setProjectPickerIntent] = useState<
    "add-project" | "new-thread" | null
  >(null);
  const [pluginSnapshot, setPluginSnapshot] =
    useState<ZenXPluginSnapshot | null>(null);
  const [titleSnapshot, setTitleSnapshot] = useState<ThreadTitleSnapshot>({});
  const [serverStatus, setServerStatus] = useState<AppServerHostStatus>({
    type: "starting",
  });
  const [threadSummaries, setThreadSummaries] = useState<NativeThreadSummary[]>(
    [],
  );
  const [pinnedThreadIds, setPinnedThreadIds] = useState<string[]>([]);
  const [visibleSubagentThreadIds, setVisibleSubagentThreadIds] = useState<
    string[]
  >([]);
  const [sidebarOrder, setSidebarOrder] =
    useState<ZenXSidebarOrder>(EMPTY_SIDEBAR_ORDER);
  const [archivedThreadSummaries, setArchivedThreadSummaries] = useState<
    NativeThreadSummary[]
  >([]);
  const [deletedThreadSummaries, setDeletedThreadSummaries] = useState<
    DeletedThreadSummary[]
  >([]);
  const [deletedThreadError, setDeletedThreadError] = useState<string | null>(
    null,
  );
  const [deletedThreadLoading, setDeletedThreadLoading] = useState(true);
  const [threadListLoaded, setThreadListLoaded] = useState({
    active: false,
    archived: false,
  });
  const [threadListErrors, setThreadListErrors] = useState<{
    active: string | null;
    archived: string | null;
  }>({ active: null, archived: null });
  const [projects, setProjects] = useState<ZenXProjectProjectionSnapshot>({
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  const [projectListLoaded, setProjectListLoaded] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedThreadId) void sidebarState.controller.load(selectedThreadId);
  }, [selectedThreadId, sidebarState.controller]);
  useEffect(() => {
    if (sidebarState.error) setRequestError(sidebarState.error);
  }, [sidebarState.error]);
  const [threadDetail, setThreadDetail] = useState<Thread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [newThreadPending, setNewThreadPending] = useState(false);
  const [newThreadDraft, setNewThreadDraft] = useState<NewThreadDraft | null>(
    null,
  );
  const [approvals, setApprovals] = useState<ApprovalCardState[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [providerProfiles, setProviderProfiles] = useState<
    ZenXProviderProfile[]
  >([]);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(
    null,
  );
  const [selectedSettings, setSelectedSettings] =
    useState<SelectedThreadSettings | null>(null);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [switchingPermission, setSwitchingPermission] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [modelUpdateError, setModelUpdateError] = useState<string | null>(null);
  useEffect(() => {
    setModelUpdateError((current) =>
      isModelCatalogLoading(current) ? modelCatalogLoading() : current,
    );
  }, [activeI18n.resolvedLanguage]);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    try {
      return readSidebarMode(window.localStorage);
    } catch {
      return "projects";
    }
  });
  const [requestError, setRequestError] = useState<string | null>(null);
  const [queueFailure, setQueueFailure] = useState<Extract<
    AppServerEvent,
    { type: "queue_failed" }
  > | null>(null);
  const queueAttemptsRef = useRef(new Map<string, string>());
  const [optimisticSummary, setOptimisticSummary] =
    useState<NativeThreadSummary | null>(null);
  const [draftRecoveryNotice, setDraftRecoveryNotice] = useState<{
    draft: NewThreadDraft;
    message: string;
  } | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [archivingThreadIds, setArchivingThreadIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [composerStates, setComposerStates] = useState<
    Record<string, ComposerState>
  >({});
  const [threadAttachments, setThreadAttachments] =
    useState<ZenXThreadAttachmentProjection>({});
  const [threadUsage, setThreadUsage] = useState<
    ModelUsageProjection | undefined
  >();
  // Stable identity so streaming re-renders of App do not restart every
  // mounted attachment read; thumbnails cache payloads per attachment.
  const readAttachment = useCallback(
    (attachment: AttachmentRef) =>
      window.zenx.imageAttachments.read(attachment),
    [],
  );

  const confirmPinnedThreadIds = (threadIds: readonly string[]) => {
    const confirmed = [...threadIds];
    pinnedThreadIdsRef.current = confirmed;
    setPinnedThreadIds(confirmed);
  };

  const confirmSidebarOrder = (order: ZenXSidebarOrder) => {
    const confirmed = {
      ...order,
      projectKeys: [...order.projectKeys],
      threadIdsByProject: Object.fromEntries(
        Object.entries(order.threadIdsByProject).map(
          ([projectKey, threadIds]) => [projectKey, [...threadIds]],
        ),
      ),
    };
    sidebarOrderRef.current = confirmed;
    setSidebarOrder(confirmed);
  };

  const confirmProfilePreferences = (profile: {
    pinnedThreadIds: readonly string[];
    visibleSubagentThreadIds: readonly string[];
    sidebarOrder: ZenXSidebarOrder;
  }) => {
    confirmPinnedThreadIds(profile.pinnedThreadIds);
    setVisibleSubagentThreadIds([...(profile.visibleSubagentThreadIds ?? [])]);
    confirmSidebarOrder(profile.sidebarOrder);
  };

  const discardRecoverableDraft = () => setDraftRecoveryNotice(null);

  const confirmNewThreadDraft = (draft: NewThreadDraft | null) => {
    if (
      draft === null &&
      newThreadDraftRef.current !== null &&
      newThreadPendingDraftRef.current?.id === newThreadDraftRef.current.id
    )
      newThreadPendingDraftRef.current = newThreadDraftRef.current;
    newThreadDraftRef.current = draft;
    setNewThreadDraft(draft);
  };

  const newThreadDraftRetentionKey = (workspace: string | null) =>
    workspace ?? "";

  const newThreadDraftHasUnsentInput = (draft: NewThreadDraft) =>
    draft.composer.draft.text.trim().length > 0 ||
    draft.composer.draft.images.length > 0 ||
    newThreadImageLeasesRef.current.has(draft.id);

  /** Leaving the welcome page keeps unsent input per Project, the way
   * Thread Composer drafts survive navigation. In-flight submissions stay
   * with the promotion/recovery-notice path instead. */
  const retainNewThreadDraftUnsentInput = () => {
    const current = newThreadDraftRef.current;
    if (
      current !== null &&
      newThreadDraftHasUnsentInput(current) &&
      current.composer.submission?.status !== "pending"
    )
      retainedNewThreadDraftsRef.current.set(
        newThreadDraftRetentionKey(current.workspace),
        current,
      );
  };

  const takeRetainedNewThreadDraft = (
    workspace: string | null,
  ): NewThreadDraft | null => {
    const key = newThreadDraftRetentionKey(workspace);
    const retained = retainedNewThreadDraftsRef.current.get(key);
    if (retained === undefined) return null;
    retainedNewThreadDraftsRef.current.delete(key);
    return retained;
  };

  const changeNewThreadProject = (
    workspace: string | null,
    carryDraftToNewProject = false,
  ) => {
    setModelUpdateError(null);
    const current = newThreadDraftRef.current;
    if (current === null || current.workspace === workspace) return;
    if (
      (!newThreadDraftHasUnsentInput(current) &&
        current.composer.submission === null) ||
      (carryDraftToNewProject &&
        !retainedNewThreadDraftsRef.current.has(
          newThreadDraftRetentionKey(workspace),
        ))
    ) {
      // Only a genuinely new folder can carry the current input. Existing
      // Projects restore their own draft through the same selection path.
      const retained = takeRetainedNewThreadDraft(workspace);
      if (retained !== null) {
        confirmNewThreadDraft(retained);
        return;
      }
      updateNewThreadDraft((draft) => ({
        ...draft,
        workspace,
        composer: {
          ...draft.composer,
          submission:
            draft.composer.submission?.status === "failed"
              ? null
              : draft.composer.submission,
        },
      }));
      return;
    }
    if (current.composer.submission?.status === "pending") {
      // An in-flight first Send keeps its draft identity so the
      // promotion path can finish even while the Project moves.
      updateNewThreadDraft((draft) => ({ ...draft, workspace }));
      return;
    }
    // Each Project keeps its own unsent welcome input like an
    // independent Thread: stash the current text under the old
    // Project and swap in the target Project's retained draft.
    if (newThreadDraftHasUnsentInput(current))
      retainedNewThreadDraftsRef.current.set(
        newThreadDraftRetentionKey(current.workspace),
        current,
      );
    confirmNewThreadDraft(
      takeRetainedNewThreadDraft(workspace) ?? {
        id: crypto.randomUUID(),
        workspace,
        composer: emptyComposerState(),
        settings: current.settings,
        permissionMode: current.permissionMode,
      },
    );
  };

  const openProjectPicker = (intent: "add-project" | "new-thread") => {
    projectPickerOperationEpoch.current += 1;
    projectPickerPendingRef.current = false;
    projectPickerIntentRef.current = intent;
    setProjectPickerIntent(intent);
  };

  const closeProjectPicker = () => {
    projectPickerOperationEpoch.current += 1;
    projectPickerPendingRef.current = false;
    projectPickerIntentRef.current = null;
    setProjectPickerIntent(null);
  };

  const abandonNewThreadDraft = () => {
    if (newThreadDraftRef.current === null) return;
    invalidateThreadSelection();
    retainNewThreadDraftUnsentInput();
    confirmNewThreadDraft(null);
  };

  const queuePinMutation = (
    update: (current: readonly string[]) => readonly string[],
  ): Promise<void> => {
    const result = profilePreferenceQueueRef.current.then(async () => {
      const current = pinnedThreadIdsRef.current;
      const next = update(current);
      if (next === current) return;
      const value = await window.zenx.settings.setPinnedThreadIds(next);
      confirmProfilePreferences(value.profile);
    });
    profilePreferenceQueueRef.current = result.catch(() => undefined);
    return result;
  };

  const setSubagentThreadSidebarVisible = (
    threadId: string,
    visible: boolean,
  ): Promise<void> => {
    const result = profilePreferenceQueueRef.current.then(async () => {
      const value = await window.zenx.settings.setSubagentThreadSidebarVisible(
        threadId,
        visible,
      );
      confirmProfilePreferences(value.profile);
    });
    profilePreferenceQueueRef.current = result.catch(() => undefined);
    return result;
  };

  const queueSidebarOrderMutation = (
    update: (current: ZenXSidebarOrder) => ZenXSidebarOrder,
  ): Promise<void> => {
    const result = profilePreferenceQueueRef.current.then(async () => {
      const current = sidebarOrderRef.current;
      const next = update(current);
      if (next === current) return;
      const value = await window.zenx.settings.setSidebarOrder(next);
      confirmProfilePreferences(value.profile);
    });
    profilePreferenceQueueRef.current = result.catch(() => undefined);
    return result;
  };

  const loadThreadSummaries = async (showLoading = false) => {
    const epoch = ++threadSummaryLoadEpoch.current;
    if (showLoading) setThreadListLoaded({ active: false, archived: false });
    const [active, archived] = await Promise.allSettled([
      window.zenx.threads.list({ archived: false }),
      window.zenx.threads.list({ archived: true }),
    ]);
    if (threadSummaryLoadEpoch.current !== epoch) return;
    if (active.status === "fulfilled") {
      setThreadSummaries(active.value);
      setThreadListErrors((current) => ({ ...current, active: null }));
    } else {
      setThreadListErrors((current) => ({
        ...current,
        active: describeError(active.reason),
      }));
    }
    if (archived.status === "fulfilled") {
      setArchivedThreadSummaries(archived.value);
      setThreadListErrors((current) => ({ ...current, archived: null }));
    } else {
      setThreadListErrors((current) => ({
        ...current,
        archived: describeError(archived.reason),
      }));
    }
    setThreadListLoaded({ active: true, archived: true });
  };

  const deletedLoadEpoch = useRef(0);
  const loadDeletedThreads = async (showLoading = false) => {
    const epoch = ++deletedLoadEpoch.current;
    if (showLoading) setDeletedThreadLoading(true);
    try {
      const result = await window.zenx.protocol.request(
        "zen/thread/deleted/list",
        {},
      );
      if (deletedLoadEpoch.current !== epoch) return;
      setDeletedThreadSummaries(result.data);
      setDeletedThreadError(null);
    } catch (error) {
      if (deletedLoadEpoch.current !== epoch) return;
      setDeletedThreadError(describeError(error));
    } finally {
      if (deletedLoadEpoch.current === epoch) setDeletedThreadLoading(false);
    }
  };
  useEffect(() => {
    if (
      page === "settings" &&
      settingsTab === "archived" &&
      serverStatus.type === "ready"
    )
      void loadDeletedThreads(true);
  }, [page, settingsTab, serverStatus.type]);

  const loadProjects = async () => {
    const epoch = ++projectLoadEpoch.current;
    try {
      const snapshot = await window.zenx.projects.get({ archived: false });
      if (projectLoadEpoch.current === epoch) {
        projectsRef.current = snapshot;
        setProjects(snapshot);
        setProjectError(null);
        setProjectListLoaded(true);
      }
    } catch (error) {
      if (projectLoadEpoch.current === epoch)
        setProjectError(describeError(error));
    }
  };

  const selectProjectDirectory = async (workspace: string) => {
    const intent = projectPickerIntentRef.current;
    if (intent === null || projectPickerPendingRef.current) return;
    projectPickerPendingRef.current = true;
    const epoch = projectPickerOperationEpoch.current;
    const existingProject = projectsRef.current.projects.some(
      (project) => project.workspace === workspace,
    );
    try {
      await window.zenx.settings.addWorkspace(workspace);
      if (projectPickerOperationEpoch.current !== epoch) return;
      await loadProjects();
      if (projectPickerOperationEpoch.current !== epoch) return;
      closeProjectPicker();
      if (intent === "new-thread") {
        const draft = newThreadDraftRef.current;
        if (draft === null) openNewThreadDraft(workspace);
        else changeNewThreadProject(workspace, !existingProject);
      }
    } catch (error) {
      if (projectPickerOperationEpoch.current === epoch)
        setRequestError(describeError(error));
    } finally {
      if (projectPickerOperationEpoch.current === epoch)
        projectPickerPendingRef.current = false;
    }
  };

  const refreshThreadUsage = (threadId: string) => {
    const epoch = ++threadUsageLoadEpoch.current;
    void window.zenx.modelUsage
      .forThread(threadId)
      .then((usage) => {
        if (
          selectedThreadIdRef.current === threadId &&
          threadUsageLoadEpoch.current === epoch
        )
          setThreadUsage(usage);
      })
      .catch((error: unknown) => {
        if (
          selectedThreadIdRef.current === threadId &&
          threadUsageLoadEpoch.current === epoch
        )
          setRequestError(
            i18n.t("shell:threadUsageLoadFailed", {
              error: describeError(error),
            }),
          );
      });
  };

  const exitDebugMode = () => {
    const epoch = selectionEpoch.current;
    setDebugThreadId(null);
    requestAnimationFrame(() => {
      if (selectionEpoch.current === epoch)
        document.getElementById("thread-composer")?.focus();
    });
  };

  const resumeThread = async (
    threadId: string,
    preserveNavigation = false,
    propagateFailure = false,
    debugMode = false,
  ) => {
    setMessageTargetRequest(null);
    discardRecoverableDraft();
    const epoch = ++selectionEpoch.current;
    const cached = threadProjectionCacheRef.current.get(threadId);
    pendingResumeProjectionRef.current = { epoch, threadId, notifications: [] };
    retainNewThreadDraftUnsentInput();
    confirmNewThreadDraft(null);
    const usageEpoch = ++threadUsageLoadEpoch.current;
    selectedThreadIdRef.current = threadId;
    if (!preserveNavigation) {
      setDebugThreadId(debugMode ? threadId : null);
      setPage("agent");
      if (!debugMode) setSidebarOpen(false);
    }
    setSelectedThreadId(threadId);
    setThreadDetail(cached?.thread ?? null);
    setThreadAttachments({});
    setThreadUsage(undefined);
    setSelectedSettings(cached?.settings ?? null);
    setModelUpdateError(null);
    setThreadLoading(cached === undefined);
    setThreadError(null);
    void loadComposerCatalog();
    try {
      const result = await window.zenx.protocol.request("zen/thread/resume", {
        threadId,
      });
      if (selectionEpoch.current !== epoch) {
        if (propagateFailure)
          throw new Error(i18n.t("shell:importOpenSuperseded"));
        return;
      }
      endNotificationsRef.current?.recover(threadId, result);
      const pending = pendingResumeProjectionRef.current;
      const notifications =
        pending?.epoch === epoch && pending.threadId === threadId
          ? pending.notifications
          : (threadProjectionCacheRef.current.get(threadId)
              ?.activeTurnNotifications ?? []);
      if (pending?.epoch === epoch && pending.threadId === threadId)
        pendingResumeProjectionRef.current = null;
      const projected = replayThreadProjection(
        projectNativeRecovery(result),
        settingsFromSnapshot(threadId, nativeSettingsSnapshot(result.thread)),
        notifications,
        {
          processEpoch: result.processEpoch,
          watermark: result.watermark,
        },
      );
      threadProjectionCacheRef.current.set(threadId, projected);
      setThreadDetail(projected.thread);
      // Direct navigation from a PAW can precede the list projection. The
      // recovered Thread still owns its title and rename entry in that gap.
      setOptimisticSummary({
        ...optimisticThreadSummary(
          {
            thread: projected.thread,
            ...nativeSettingsSnapshot(result.thread),
          },
          projected.thread.preview,
        ),
        archived: result.thread.archived,
        parentThreadId: result.thread.parentThreadId,
        status: projected.thread.status.type === "active" ? "active" : "idle",
      });
      if (
        projected.thread.id === threadId &&
        projected.thread.canonicalItems !== undefined
      ) {
        updateComposer(threadId, (state) =>
          reconcileCanonicalAdmission(state, projected.thread.canonicalItems!),
        );
      }
      setSelectedSettings(projected.settings);
      void window.zenx.imageAttachments
        .forThread(threadId)
        .then((attachments) => {
          if (selectionEpoch.current === epoch)
            setThreadAttachments(attachments);
        })
        .catch((error: unknown) => {
          if (selectionEpoch.current === epoch)
            setRequestError(
              i18n.t("shell:threadImagesLoadFailed", {
                error: describeError(error),
              }),
            );
        });
      void window.zenx.modelUsage
        .forThread(threadId)
        .then((usage) => {
          if (
            selectionEpoch.current === epoch &&
            threadUsageLoadEpoch.current === usageEpoch
          )
            setThreadUsage(usage);
        })
        .catch((error: unknown) => {
          if (
            selectionEpoch.current === epoch &&
            threadUsageLoadEpoch.current === usageEpoch
          )
            setRequestError(
              i18n.t("shell:threadUsageLoadFailed", {
                error: describeError(error),
              }),
            );
        });
      void window.zenx.settings
        .markWorkspaceUsed(result.thread.cwd)
        .then(() => loadProjects())
        .catch(() => undefined);
    } catch (error) {
      if (selectionEpoch.current === epoch) {
        if (pendingResumeProjectionRef.current?.epoch === epoch)
          pendingResumeProjectionRef.current = null;
        setDebugThreadId(null);
        setThreadError(describeError(error));
      }
      if (propagateFailure) throw error;
    } finally {
      if (selectionEpoch.current === epoch) setThreadLoading(false);
    }
  };

  const loadComposerCatalog = async () => {
    const epoch = ++modelCatalogLoadEpoch.current;
    const [result, settings] = await Promise.allSettled([
      window.zenx.protocol.request("model/list", {}),
      window.zenx.settings.get(),
    ]);
    if (modelCatalogLoadEpoch.current !== epoch) return;
    if (settings.status === "fulfilled")
      setProviderProfiles(settings.value.profile.providerProfiles);
    try {
      if (settings.status === "rejected") throw settings.reason;
      if (result.status === "rejected") throw result.reason;
      validateModelCatalog(result.value.data);
      setModels(result.value.data);
      setModelCatalogError(null);
      setModelUpdateError((current) =>
        isModelCatalogLoading(current) ? null : current,
      );
    } catch (error) {
      setModelCatalogError(describeError(error));
    }
  };

  useEffect(() => {
    let active = true;
    const endNotifications = createThreadEndNotificationObserver(
      conversationReadStore(),
      () => window.zenx.protocol.request("zen/initialize", {}),
    );
    endNotificationsRef.current = endNotifications;
    void endNotifications.connect();
    const loadModels = async () => {
      const epoch = ++modelCatalogLoadEpoch.current;
      const [result, settings] = await Promise.allSettled([
        window.zenx.protocol.request("model/list", {}),
        window.zenx.settings.get(),
      ]);
      if (!active || modelCatalogLoadEpoch.current !== epoch) return;
      if (settings.status === "fulfilled")
        setProviderProfiles(settings.value.profile.providerProfiles);
      try {
        if (settings.status === "rejected") throw settings.reason;
        if (result.status === "rejected") throw result.reason;
        validateModelCatalog(result.value.data);
        setModels(result.value.data);
        setModelCatalogError(null);
        setModelUpdateError((current) =>
          isModelCatalogLoading(current) ? null : current,
        );
      } catch (error) {
        setModelCatalogError(describeError(error));
      }
    };
    const replaceApprovalSnapshot = async () => {
      const epoch = ++approvalSnapshotEpoch.current;
      const pending = {
        epoch,
        events: [
          ...(pendingApprovalSnapshotRef.current?.events ?? []),
        ] as ApprovalStateEvent[],
      };
      pendingApprovalSnapshotRef.current = pending;
      try {
        const snapshot = await window.zenx.protocol.getPendingApprovals();
        if (!active || approvalSnapshotEpoch.current !== epoch) return;
        if (pendingApprovalSnapshotRef.current?.epoch === epoch)
          pendingApprovalSnapshotRef.current = null;
        setApprovals(replacePendingApprovals(snapshot, pending.events));
      } catch (error) {
        if (!active || approvalSnapshotEpoch.current !== epoch) return;
        if (pendingApprovalSnapshotRef.current?.epoch === epoch)
          pendingApprovalSnapshotRef.current = null;
        setApprovals(replacePendingApprovals([], pending.events));
        setRequestError(
          i18n.t("shell:pendingApprovalsLoadFailed", {
            error: describeError(error),
          }),
        );
      }
    };
    const disposeStatus = window.zenx.protocol.onStatus((status) => {
      if (!active) return;
      setServerStatus(status);
      if (status.type !== "ready") endNotifications.disconnect();
      if (status.type === "ready") {
        void endNotifications.connect();
        void replaceApprovalSnapshot();
        void loadThreadSummaries();
        void loadProjects();
        void loadModels();
        if (status.reconnected && selectedThreadIdRef.current !== null) {
          void resumeThread(selectedThreadIdRef.current, true);
        }
      } else if (status.type === "reconnecting") {
        for (const id of Object.keys(composerStatesRef.current))
          updateComposer(id, markCompactionOutcomeUnknown);
        for (const draft of sideChatDrafts.entries())
          sideChatDrafts.updateComposer(draft.id, markCompactionOutcomeUnknown);
        invalidateThreadSelection();
        modelCatalogLoadEpoch.current += 1;
        const selectedId = selectedThreadIdRef.current;
        const selectedCache =
          selectedId === null
            ? undefined
            : threadProjectionCacheRef.current.get(selectedId);
        threadProjectionCacheRef.current.clear();
        if (selectedId !== null) {
          if (selectedCache !== undefined) {
            const awaiting = {
              ...selectedCache,
              thread: markThreadViewAwaitingRecovery(selectedCache.thread),
              activeTurnNotifications: [],
            };
            setThreadDetail(awaiting.thread);
          }
        }
      }
    });
    const disposeNotifications = window.zenx.protocol.onNotification(
      (method, params) => {
        if (!active) return;
        if (method === "model/catalog/updated") {
          void loadModels();
          return;
        }
        if (
          method === "zen/thread/event" ||
          method.startsWith("thread/") ||
          method.startsWith("turn/") ||
          method === "item/completed"
        ) {
          void loadThreadSummaries();
          void loadProjects();
        }
        if (method === "zen/thread/event") {
          endNotifications.observe(
            params as ServerNotificationParams["zen/thread/event"],
          );
          const lifecycle = (
            params as ServerNotificationParams["zen/thread/event"]
          ).event;
          if (lifecycle.type === "thread_deleted_updated")
            void loadDeletedThreads();
          if (
            lifecycle.type === "thread_deleted_updated" &&
            lifecycle.deleted
          ) {
            threadProjectionCacheRef.current.delete(lifecycle.threadId);
            setThreadSummaries((current) =>
              current.filter((entry) => entry.threadId !== lifecycle.threadId),
            );
            setArchivedThreadSummaries((current) =>
              current.filter((entry) => entry.threadId !== lifecycle.threadId),
            );
            clearSelectedThreadForArchive(lifecycle.threadId);
          }
        }
        const pendingResume = pendingResumeProjectionRef.current;
        const notification = {
          method,
          params,
        } as BufferedProtocolNotification;
        const eventThreadId = notificationThreadId(notification);
        const cached = updateThreadProjectionCache(
          threadProjectionCacheRef.current,
          notification,
        );
        if (method === "zen/thread/event" && cached !== undefined) {
          const event = params as ServerNotificationParams["zen/thread/event"];
          if (
            cached.processEpoch === event.processEpoch &&
            cached.watermark === event.watermark &&
            (event.event.type === "item_completed" ||
              event.event.type === "turn_completed") &&
            cached.thread.id === event.threadId &&
            cached.thread.canonicalItems !== undefined
          ) {
            updateComposer(event.threadId, (state) =>
              reconcileCanonicalAdmission(
                state,
                cached.thread.canonicalItems!,
                event.event.type === "turn_completed"
                  ? { turnId: event.event.turnId, status: event.event.status }
                  : undefined,
              ),
            );
          }
        }
        const bufferingResume =
          pendingResume !== null &&
          pendingResume.epoch === selectionEpoch.current &&
          pendingResume.threadId === eventThreadId;
        if (bufferingResume) {
          pendingResume.notifications.push(notification);
        } else if (
          cached !== undefined &&
          selectedThreadIdRef.current === eventThreadId
        ) {
          setThreadDetail(cached.thread);
          setSelectedSettings(cached.settings);
        }
        if (method === "zen/thread/event") {
          const projected =
            params as ServerNotificationParams["zen/thread/event"];
          const nativeEvent = projected.event;
          if (nativeEvent.type === "context_compaction_status") {
            if (
              cached?.processEpoch === projected.processEpoch &&
              cached.watermark === projected.watermark
            )
              updateComposer(projected.threadId, (state) =>
                applyCompactionStatus(state, nativeEvent, projected),
              );
            // A just-created side chat has an exact child ID before first Send,
            // but is not promoted into the normal Thread cache until admission.
            for (const draft of sideChatDrafts.entries())
              if (draft.threadId === projected.threadId)
                sideChatDrafts.updateComposer(draft.id, (state) =>
                  applyCompactionStatus(state, nativeEvent, projected),
                );
          }
          if (
            nativeEvent.type === "item_completed" &&
            nativeEvent.item.type === "user_message_queue_edited"
          ) {
            const edited = nativeEvent.item;
            queueAttemptsRef.current.delete(
              `${projected.threadId}:${edited.queuedItemId}`,
            );
            if (selectedThreadIdRef.current === projected.threadId)
              setQueueFailure((current) =>
                current?.queuedItemId === edited.queuedItemId &&
                (current.revision ?? 0) < edited.revision
                  ? null
                  : current,
              );
          }
          if (nativeEvent.type === "queue_admission_started") {
            const key = `${projected.threadId}:${nativeEvent.queuedItemId}`;
            const sameRevision = cached?.thread.queuedMessages?.some(
              (item) =>
                item.id === nativeEvent.queuedItemId &&
                item.clientId === nativeEvent.clientId &&
                (item.revision ?? 0) === (nativeEvent.revision ?? 0),
            );
            if (sameRevision)
              queueAttemptsRef.current.set(key, nativeEvent.attemptId);
            if (
              sameRevision &&
              selectedThreadIdRef.current === projected.threadId
            )
              setQueueFailure((current) =>
                current?.queuedItemId === nativeEvent.queuedItemId
                  ? null
                  : current,
              );
          }
          if (nativeEvent.type === "queue_failed") {
            const key = `${projected.threadId}:${nativeEvent.queuedItemId}`;
            if (
              selectedThreadIdRef.current === projected.threadId &&
              queueAttemptsRef.current.get(key) === nativeEvent.attemptId &&
              cached?.thread.queuedMessages?.some(
                (item) =>
                  item.id === nativeEvent.queuedItemId &&
                  item.clientId === nativeEvent.clientId &&
                  (item.revision ?? 0) === (nativeEvent.revision ?? 0),
              )
            )
              setQueueFailure(nativeEvent);
          }
          if (
            nativeEvent.type === "item_completed" &&
            nativeEvent.item.type === "user_message" &&
            nativeEvent.item.clientId !== undefined &&
            selectedThreadIdRef.current === projected.threadId
          ) {
            const acceptedId = nativeEvent.item.clientId;
            const queuedItemId = cached?.thread.canonicalItems?.find(
              (item) =>
                item.type === "user_message_queued" &&
                item.clientId === acceptedId,
            )?.id;
            if (queuedItemId !== undefined)
              queueAttemptsRef.current.delete(
                `${projected.threadId}:${queuedItemId}`,
              );
            setQueueFailure((current) =>
              current?.clientId === acceptedId ? null : current,
            );
          }
          if (
            projected.event.type === "item_completed" ||
            projected.event.type === "turn_completed"
          ) {
            if (selectedThreadIdRef.current === projected.threadId)
              refreshThreadUsage(projected.threadId);
          }
          if (
            projected.event.type === "item_completed" &&
            (projected.event.item.type === "user_message" ||
              (projected.event.item.type === "tool_result" &&
                projected.event.item.modelContent?.some(
                  (part) => part.type === "image",
                ))) &&
            selectedThreadIdRef.current === projected.threadId
          ) {
            void window.zenx.imageAttachments
              .forThread(projected.threadId)
              .then((attachments) => {
                if (selectedThreadIdRef.current === projected.threadId)
                  setThreadAttachments(attachments);
              })
              .catch((error: unknown) =>
                setRequestError(
                  i18n.t("shell:threadImagesLoadFailed", {
                    error: describeError(error),
                  }),
                ),
              );
          }
        }
        if (method === "item/completed" || method === "turn/completed") {
          const event = params as { threadId: string };
          if (selectedThreadIdRef.current === event.threadId)
            refreshThreadUsage(event.threadId);
        }
        if (method === "item/completed") {
          const event = params as ServerNotificationParams["item/completed"];
          if (
            (event.item.type === "userMessage" ||
              (event.item.type === "commandExecution" &&
                event.item.toolName === "view_image")) &&
            selectedThreadIdRef.current === event.threadId
          ) {
            void window.zenx.imageAttachments
              .forThread(event.threadId)
              .then((attachments) => {
                if (selectedThreadIdRef.current === event.threadId)
                  setThreadAttachments(attachments);
              })
              .catch((error: unknown) =>
                setRequestError(
                  i18n.t("shell:threadImagesLoadFailed", {
                    error: describeError(error),
                  }),
                ),
              );
          }
        }
        if (method === "thread/settings/updated") {
          setModelUpdateError(null);
        }
      },
    );
    const disposeApprovals = window.zenx.protocol.onApprovalRequest((event) => {
      if (!active) return;
      const pending = pendingApprovalSnapshotRef.current;
      if (pending === null) {
        setApprovals((current) => addApprovalRequest(current, event));
      } else {
        pending.events.push({ type: "requested", event });
      }
    });
    const disposeResolved = window.zenx.protocol.onApprovalResolved((event) => {
      if (!active) return;
      const pending = pendingApprovalSnapshotRef.current;
      if (pending === null) {
        setApprovals((current) => resolveApproval(current, event));
      } else {
        pending.events.push({ type: "resolved", event });
      }
    });
    void window.zenx.protocol
      .getStatus()
      .then((status) => {
        if (!active) return;
        setServerStatus(status);
        if (status.type === "ready") {
          void endNotifications.connect();
          void replaceApprovalSnapshot();
          void loadThreadSummaries();
          void loadProjects();
          void loadModels();
        }
      })
      .catch(
        (error: unknown) => active && setRequestError(describeError(error)),
      );
    return () => {
      active = false;
      endNotifications.disconnect();
      if (endNotificationsRef.current === endNotifications)
        endNotificationsRef.current = null;
      disposeStatus();
      disposeNotifications();
      disposeApprovals();
      disposeResolved();
    };
  }, []);

  useEffect(() => {
    const dispose = window.zenx.plugins.onChange(setPluginSnapshot);
    void window.zenx.plugins
      .get()
      .then(setPluginSnapshot)
      .catch((error: unknown) =>
        setRequestError(
          i18n.t("shell:pluginCatalogFailed", { error: describeError(error) }),
        ),
      );
    return dispose;
  }, []);

  useEffect(() => {
    const result = profilePreferenceQueueRef.current.then(async () => {
      const value = await window.zenx.settings.get();
      confirmProfilePreferences(value.profile);
      if (!value.profile.onboardingComplete) setPage("settings");
    });
    profilePreferenceQueueRef.current = result.catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    let notified = false;
    const dispose = window.zenx.titles.onChange((snapshot) => {
      notified = true;
      if (active) setTitleSnapshot(snapshot);
    });
    void window.zenx.titles.get().then(
      (snapshot) => {
        if (active && !notified) setTitleSnapshot(snapshot);
      },
      (error: unknown) => {
        if (active && !notified)
          setRequestError(
            i18n.t("shell:titleMetadataFailed", {
              error: describeError(error),
            }),
          );
      },
    );
    return () => {
      active = false;
      dispose();
    };
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (projectPickerIntent !== null) closeProjectPicker();
      else if (sidebarOpen) setSidebarOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [projectPickerIntent, sidebarOpen]);

  const readPreference = useConversationReadPreference();
  const unreadThreads = unreadThreadIds(threadSummaries, readPreference);
  const activeSummaries = threadSummaries.map((summary) =>
    titleSnapshot[summary.threadId]?.title === undefined
      ? summary
      : { ...summary, name: titleSnapshot[summary.threadId]!.title },
  );
  const archivedSummaries = archivedThreadSummaries.map((summary) =>
    titleSnapshot[summary.threadId]?.title === undefined
      ? summary
      : { ...summary, name: titleSnapshot[summary.threadId]!.title },
  );
  const pinnedSummaries = derivePinnedThreads(activeSummaries, pinnedThreadIds);
  const selectedBaseSummary =
    [...activeSummaries, ...archivedSummaries].find(
      (summary) => summary.threadId === selectedThreadId,
    ) ??
    (optimisticSummary?.threadId === selectedThreadId
      ? optimisticSummary
      : null);
  const selectedSummary =
    selectedBaseSummary && titleSnapshot[selectedBaseSummary.threadId]
      ? {
          ...selectedBaseSummary,
          name: titleSnapshot[selectedBaseSummary.threadId]!.title,
        }
      : selectedBaseSummary;
  const pendingThreadIds = pendingApprovalThreadIds(approvals);
  const pluginContributions = loadedPluginContributions(pluginSnapshot);
  const genericPluginTarget =
    (pluginSnapshot?.pages ?? []).find(
      (candidate) =>
        candidate.route === pluginRoutePath(page) &&
        candidate.surfaceId !== undefined,
    ) ??
    (pluginSnapshot?.subroutes ?? []).find(
      (candidate) =>
        candidate.route === pluginRoutePath(page) &&
        candidate.surfaceId !== undefined,
    );
  const selectedSidebarPage =
    genericPluginTarget?.route ??
    pluginContributions.find((contribution) => contribution.page.id === page)
      ?.page.route ??
    page;
  const roomsAdmitted =
    pluginSnapshot?.pages.some(
      (p) => p.pluginId === "zenx-rooms" && p.route === ROOM_ROUTE,
    ) ?? false;
  const roomConversations = useRoomConversations(
    roomsAdmitted,
    roomConversationAdmissionRevision(pluginSnapshot),
  );
  const roomQuery = new URLSearchParams(page.split("?")[1] ?? "");
  const selectedRoomId =
    roomsAdmitted && pluginRoutePath(page) === ROOM_ROUTE
      ? roomQuery.get("roomId")
      : null;
  const selectedRoom = roomConversations.rooms.find(
    (room) => room.id === selectedRoomId,
  );
  const [roomHeaderTarget, setRoomHeaderTarget] =
    useState<HTMLDivElement | null>(null);
  const roomPanel = roomQuery.get("panel");
  const roomSidebarState = selectedRoomId
    ? sidebarState.controller.get({ kind: "room", id: selectedRoomId })
    : undefined;
  useEffect(() => {
    if (!selectedRoomId) return;
    const owner = { kind: "room" as const, id: selectedRoomId };
    let current = true;
    void sidebarState.controller.load(owner).then(() => {
      if (!current || !roomPanel) return;
      void sidebarState.controller.edit(owner, (state) => {
        const selectedTab =
          roomPanel === "open"
            ? (state.selectedTab ?? "custom:overview")
            : `custom:${roomPanel}`;
        return {
          open: true,
          selectedTab,
          tabs: state.tabs.some((tab) => sidebarTabId(tab) === selectedTab)
            ? state.tabs
            : [...state.tabs, sidebarTabFromId(selectedTab)],
        };
      });
    });
    return () => {
      current = false;
    };
  }, [selectedRoomId, roomPanel, sidebarState.controller]);
  const lastUsedWorkspace = lastUsedProjectWorkspace(projects);

  const configuredProjects = projects.projects.filter(
    (project) => project.configured,
  );

  const showNewThreadDraft = (workspace: string | null) => {
    discardRecoverableDraft();
    invalidateThreadSelection();
    threadUsageLoadEpoch.current += 1;
    selectedThreadIdRef.current = null;
    setPage("agent");
    setSidebarOpen(false);
    setSelectedThreadId(null);
    setThreadDetail(null);
    setThreadLoading(false);
    setThreadAttachments({});
    setThreadUsage(undefined);
    setSelectedSettings(null);
    setThreadError(null);
    setModelUpdateError(null);
    retainNewThreadDraftUnsentInput();
    const retained = takeRetainedNewThreadDraft(workspace);
    confirmNewThreadDraft(
      retained ?? {
        id: crypto.randomUUID(),
        workspace,
        composer: emptyComposerState(),
        settings: defaultDraftSettings(models),
      },
    );
    void loadComposerCatalog();
  };

  const openNewThreadDraft = (workspace?: string) => {
    showNewThreadDraft(workspace ?? lastUsedWorkspace);
  };

  useEffect(() => {
    if (
      !projectListLoaded ||
      serverStatus.type !== "ready" ||
      page !== "agent" ||
      selectedThreadIdRef.current !== null ||
      newThreadDraftRef.current !== null
    )
      return;
    showNewThreadDraft(lastUsedWorkspace);
  }, [
    configuredProjects,
    lastUsedWorkspace,
    page,
    projectListLoaded,
    serverStatus.type,
  ]);

  const updateNewThreadDraft = (
    update: (draft: NewThreadDraft) => NewThreadDraft,
  ): NewThreadDraft | null => {
    const current = newThreadDraftRef.current;
    if (current === null) return null;
    const next = update(current);
    if (next !== current) confirmNewThreadDraft(next);
    return next;
  };

  const updateComposer = (
    threadId: string,
    update: (state: ComposerState) => ComposerState,
  ): ComposerState => {
    const current = composerStatesRef.current[threadId] ?? emptyComposerState();
    const next = update(current);
    if (next !== current) {
      composerStatesRef.current = {
        ...composerStatesRef.current,
        [threadId]: next,
      };
      setComposerStates(composerStatesRef.current);
    }
    return next;
  };

  const updateNewThreadComposer = (
    draftId: string,
    update: (state: ComposerState) => ComposerState,
  ) => {
    if (newThreadPendingDraftRef.current?.id === draftId)
      newThreadPendingDraftRef.current = {
        ...newThreadPendingDraftRef.current,
        composer: update(newThreadPendingDraftRef.current.composer),
      };
    if (newThreadDraftRef.current?.id === draftId) {
      updateNewThreadDraft((draft) => ({
        ...draft,
        composer: update(draft.composer),
      }));
      return;
    }
    for (const [key, retained] of retainedNewThreadDraftsRef.current) {
      if (retained.id !== draftId) continue;
      retainedNewThreadDraftsRef.current.set(key, {
        ...retained,
        composer: update(retained.composer),
      });
      return;
    }
    const threadId = newThreadPromotionsRef.current.get(draftId);
    if (threadId !== undefined) updateComposer(threadId, update);
  };

  const acquireNewThreadImageLease = (draftId: string) => {
    acquireDraftPromotionLease(newThreadImageLeasesRef.current, draftId);
  };

  const releaseNewThreadImageLease = (draftId: string) => {
    releaseDraftPromotionLease(
      newThreadImageLeasesRef.current,
      newThreadPromotionsRef.current,
      draftId,
    );
  };

  const deliverComposerSubmission = async (
    threadId: string,
    submission: ComposerSubmission,
  ) => {
    if (threadProjectionCacheRef.current.get(threadId)?.processEpoch === null) {
      // Promote the draft before this read: a failed bootstrap must retry the
      // same Thread, not create another one or send with unowned CAS history.
      const recovery = await window.zenx.protocol.request("zen/thread/resume", {
        threadId,
      });
      const current = threadProjectionCacheRef.current.get(threadId);
      if (
        current === undefined ||
        recovery.threadId !== threadId ||
        recovery.thread.id !== threadId
      )
        throw new Error(i18n.t("shell:theActiveTurnChangedBeforeSending"));
      if (current.processEpoch === null) {
        const projected = replayThreadProjection(
          projectNativeRecovery(recovery),
          settingsFromSnapshot(
            threadId,
            nativeSettingsSnapshot(recovery.thread),
          ),
          current.activeTurnNotifications,
          {
            processEpoch: recovery.processEpoch,
            watermark: recovery.watermark,
          },
        );
        threadProjectionCacheRef.current.set(threadId, projected);
        endNotificationsRef.current?.recover(threadId, recovery);
        if (selectedThreadIdRef.current === threadId) {
          setThreadDetail(projected.thread);
          setSelectedSettings(projected.settings);
        }
      } else if (current.processEpoch !== recovery.processEpoch) {
        throw new Error(i18n.t("shell:theActiveTurnChangedBeforeSending"));
      }
    }
    const skillDraft = parseSkillDraft(submission.text);
    const messageText = referenceMessage(
      skillDraft.text,
      skillDraft.references,
      submission.clientUserMessageId,
    );
    // Auxiliary naming has its own receipt/error path and must not hold input
    // admission behind title persistence or an unrelated title operation.
    if (submission.text.length > 0)
      void window.zenx.titles
        .observe(
          threadId,
          referenceTitle(skillDraft.text, skillDraft.references),
        )
        .then((projection) => {
          if (projection !== undefined)
            setTitleSnapshot((current) =>
              applyThreadTitleReceipt(current, projection),
            );
        })
        .catch((error: unknown) =>
          setRequestError(
            i18n.t("shell:threadTitleStagingFailed", {
              error: describeError(error),
            }),
          ),
        );
    if (skillDraft.skills.length > 0) {
      if (archivingThreadIdsRef.current.has(threadId))
        throw new Error(i18n.t("shell:thisThreadIsBeingArchived"));
      if (submission.intent === "replace" && submission.expectedTurnId === null)
        throw new Error(i18n.t("shell:theActiveTurnChangedBeforeSending"));
      const input: (
        | import("../../../../../src/item.js").UserInputPart
        | import("../../../../../src/skill-input.js").SkillReference
      )[] = [];
      if (messageText.trim().length > 0)
        input.push({ type: "text", text: messageText });
      for (const skill of skillDraft.skills)
        input.push({ type: "skill", id: skill.id });
      for (const image of submission.images)
        input.push({ type: "image", attachment: image.attachment });
      await window.zenx.protocol.request("zen/turn/send", {
        threadId,
        input,
        ...(submission.intent === "start" || submission.intent === "steer"
          ? {}
          : { mode: submission.intent }),
        clientUserMessageId: submission.clientUserMessageId,
        ...(submission.clientObservation === undefined
          ? {}
          : { clientObservation: submission.clientObservation }),
        ...(submission.intent !== "replace" ||
        submission.expectedTurnId === null
          ? {}
          : { expectedTurnId: submission.expectedTurnId }),
      });
      return;
    }
    const input = await composerSubmissionInput({
      ...submission,
      text: messageText,
    });
    if (submission.intent === "start" || submission.intent === "steer") {
      if (archivingThreadIdsRef.current.has(threadId))
        throw new Error(
          i18n.t("shell:thisThreadIsBeingArchivedTryAgainIfArchivingFails"),
        );
      await window.zenx.protocol.request("zen/turn/send", {
        threadId,
        input: input.map((part) =>
          part.type === "attachment"
            ? { type: "image" as const, attachment: part.attachment }
            : part.type === "text"
              ? part
              : (() => {
                  throw new Error(i18n.t("shell:unsupportedBatchInputPart"));
                })(),
        ),
        clientUserMessageId: submission.clientUserMessageId,
        ...(submission.clientObservation === undefined
          ? {}
          : { clientObservation: submission.clientObservation }),
      });
    } else if (submission.intent === "batch-next") {
      if (archivingThreadIdsRef.current.has(threadId))
        throw new Error(i18n.t("shell:thisThreadIsBeingArchived"));
      await window.zenx.protocol.request("zen/turn/send", {
        threadId,
        mode: "batch-next",
        input: input.map((part) =>
          part.type === "attachment"
            ? { type: "image" as const, attachment: part.attachment }
            : part.type === "text"
              ? part
              : (() => {
                  throw new Error(i18n.t("shell:unsupportedBatchInputPart"));
                })(),
        ),
        clientUserMessageId: submission.clientUserMessageId,
        ...(submission.clientObservation === undefined
          ? {}
          : { clientObservation: submission.clientObservation }),
      });
    } else if (submission.intent === "queue") {
      if (archivingThreadIdsRef.current.has(threadId))
        throw new Error(i18n.t("shell:thisThreadIsBeingArchived"));
      await window.zenx.protocol.request("zen/turn/send", {
        threadId,
        mode: "queue",
        input: input.map((part) =>
          part.type === "attachment"
            ? { type: "image" as const, attachment: part.attachment }
            : part.type === "text"
              ? part
              : (() => {
                  throw new Error(i18n.t("shell:unsupportedBatchInputPart"));
                })(),
        ),
        clientUserMessageId: submission.clientUserMessageId,
        ...(submission.clientObservation === undefined
          ? {}
          : { clientObservation: submission.clientObservation }),
      });
    } else {
      if (submission.expectedTurnId === null)
        throw new Error(i18n.t("shell:theActiveTurnChangedBeforeReplacement"));
      if (archivingThreadIdsRef.current.has(threadId))
        throw new Error(
          i18n.t("shell:thisThreadIsBeingArchivedTryAgainIfArchivingFails"),
        );
      await window.zenx.protocol.request("zen/turn/send", {
        threadId,
        mode: "replace",
        expectedTurnId: submission.expectedTurnId,
        input: input.map((part) =>
          part.type === "attachment"
            ? { type: "image" as const, attachment: part.attachment }
            : part.type === "text"
              ? part
              : (() => {
                  throw new Error(i18n.t("shell:unsupportedBatchInputPart"));
                })(),
        ),
        clientUserMessageId: submission.clientUserMessageId,
        ...(submission.clientObservation === undefined
          ? {}
          : { clientObservation: submission.clientObservation }),
      });
    }
  };

  const submitNewThreadDraft = async (
    intent: ComposerIntent,
    expectedTurnId: string | null,
    clientObservation?: ClientSendObservation,
  ) => {
    if (intent !== "start" || expectedTurnId !== null) return;
    const current = newThreadDraftRef.current;
    if (current === null) return;
    if (
      isCompactCommand(current.composer.draft.text) ||
      current.composer.compaction?.status === "pending"
    ) {
      await handleCompactCommand({
        threadId: null,
        active: false,
        read: () => current.composer,
        update: (change) => updateNewThreadComposer(current.id, change),
        compact: async () => {},
      });
      return;
    }
    const project = projectsRef.current.projects.find(
      (candidate) =>
        candidate.configured && candidate.workspace === current.workspace,
    );
    if (current.workspace !== null && project === undefined) {
      setModelUpdateError(
        i18n.t("shell:thisProjectIsNoLongerAvailableChooseAnotherProject"),
      );
      return;
    }
    const workspace = project?.workspace ?? null;
    const draftSettings = current.settings ?? defaultDraftSettings(models);
    if (current.composer.draft.images.length > 0) {
      const capabilityError = imageCapabilityMessage(
        providerProfiles,
        draftSettings,
        models,
      );
      if (capabilityError !== null) {
        setModelUpdateError(capabilityError);
        return;
      }
    }
    if (draftSettings === null) {
      setModelUpdateError(modelCatalogError ?? modelCatalogLoading());
      return;
    }
    if (!canSendWithModel(models, draftSettings.model)) {
      setModelUpdateError(i18n.t("shell:chooseAnAvailableModelBeforeSending"));
      return;
    }
    if (!hasValidReasoningSelection(models, draftSettings)) {
      setModelUpdateError(
        i18n.t("shell:chooseAnAvailableReasoningEffortBeforeSending"),
      );
      return;
    }
    const startedComposer = beginComposerSubmission(
      current.composer,
      intent,
      expectedTurnId,
      () => crypto.randomUUID(),
      clientObservation,
    );
    if (startedComposer === current.composer) return;
    const startedDraft = { ...current, composer: startedComposer };
    newThreadPendingDraftRef.current = startedDraft;
    confirmNewThreadDraft(startedDraft);
    const submission = startedComposer.submission;
    if (submission === null || submission.status !== "pending") return;
    if (newThreadPendingRef.current) return;
    newThreadPendingRef.current = true;
    setNewThreadPending(true);
    const epoch = selectionEpoch.current;
    const draftId = current.id;
    let createdThreadId: string | null = null;
    try {
      if (workspace !== null)
        await window.zenx.settings.addWorkspace(workspace);
      const selection = {
        sandbox: current.permissionMode ?? "danger-full-access",
        model: draftSettings.model,
        ...(draftSettings.reasoningEffort === null
          ? {}
          : { effort: draftSettings.reasoningEffort }),
      };
      const result =
        workspace === null
          ? await window.zenx.projects.startProjectlessThread(
              submission.text,
              selection,
            )
          : await window.zenx.projects.startThread(workspace, selection);
      createdThreadId = result.thread.id;
      const createdProjection: ThreadProjectionCacheEntry = {
        thread: result.thread,
        settings: settingsFromSnapshot(createdThreadId, result),
        activeTurnNotifications: [],
        processEpoch: null,
        watermark: 0,
      };
      threadProjectionCacheRef.current.set(createdThreadId, createdProjection);
      setOptimisticSummary(optimisticThreadSummary(result, submission.text));
      newThreadPromotionsRef.current.set(draftId, createdThreadId);
      if (!newThreadImageLeasesRef.current.has(draftId))
        newThreadPromotionsRef.current.delete(draftId);
      const activeDraft = newThreadDraftRef.current;
      const promotedComposer =
        activeDraft?.id === draftId &&
        activeDraft.composer.submission?.clientUserMessageId ===
          submission.clientUserMessageId
          ? activeDraft.composer
          : startedComposer;
      const promotedStates = {
        ...composerStatesRef.current,
        [createdThreadId]: promotedComposer,
      };
      composerStatesRef.current = promotedStates;
      setComposerStates(promotedStates);
      const stillCurrent =
        selectionEpoch.current === epoch &&
        activeDraft?.id === draftId &&
        activeDraft.composer.submission?.clientUserMessageId ===
          submission.clientUserMessageId;
      if (stillCurrent) {
        selectedThreadIdRef.current = createdThreadId;
        threadUsageLoadEpoch.current += 1;
        setSelectedThreadId(createdThreadId);
        setThreadDetail(createdProjection.thread);
        setThreadAttachments({});
        setThreadUsage(undefined);
        setSelectedSettings(createdProjection.settings);
        retainedNewThreadDraftsRef.current.delete(
          newThreadDraftRetentionKey(workspace),
        );
        confirmNewThreadDraft(null);
      }
      void (
        workspace === null
          ? Promise.resolve()
          : window.zenx.settings.markWorkspaceUsed(workspace)
      )
        .then(async () => await loadProjects())
        .catch((error: unknown) => {
          if (selectedThreadIdRef.current === createdThreadId)
            setRequestError(describeError(error));
        });
      void loadThreadSummaries();
      await deliverComposerSubmission(createdThreadId, submission);
      updateComposer(createdThreadId, (state) =>
        acceptComposerSubmission(state, submission.clientUserMessageId),
      );
      if (selectedThreadIdRef.current === createdThreadId) {
        void window.zenx.imageAttachments
          .forThread(createdThreadId)
          .then((attachments) => {
            if (selectedThreadIdRef.current === createdThreadId)
              setThreadAttachments(attachments);
          })
          .catch((error: unknown) =>
            setRequestError(
              i18n.t("shell:threadImagesLoadFailed", {
                error: describeError(error),
              }),
            ),
          );
      }
    } catch (error) {
      const message = describeError(error);
      if (createdThreadId === null) {
        const activeDraft = newThreadDraftRef.current;
        if (
          selectionEpoch.current === epoch &&
          activeDraft?.composer.submission?.clientUserMessageId ===
            submission.clientUserMessageId
        ) {
          updateNewThreadDraft((draft) => ({
            ...draft,
            composer: failComposerSubmission(
              draft.composer,
              submission.clientUserMessageId,
              message,
            ),
          }));
        } else {
          const latestDraft =
            newThreadPendingDraftRef.current?.id === draftId
              ? newThreadPendingDraftRef.current
              : startedDraft;
          setDraftRecoveryNotice({
            draft: {
              ...latestDraft,
              composer: failComposerSubmission(
                latestDraft.composer,
                submission.clientUserMessageId,
                message,
              ),
            },
            message: i18n.t("shell:newThreadCreationFailed", {
              error: message,
            }),
          });
        }
      } else {
        updateComposer(createdThreadId, (state) =>
          failComposerSubmission(
            state,
            submission.clientUserMessageId,
            message,
          ),
        );
      }
    } finally {
      newThreadPendingDraftRef.current = null;
      newThreadPendingRef.current = false;
      setNewThreadPending(false);
    }
  };

  const submitComposer = async (
    intent: ComposerIntent,
    expectedTurnId: string | null,
    clientObservation?: ClientSendObservation,
  ) => {
    if (
      threadDetail === null ||
      archivingThreadIdsRef.current.has(threadDetail.id)
    )
      return;
    const threadId = threadDetail.id;
    const current = composerStatesRef.current[threadId] ?? emptyComposerState();
    if (
      isCompactCommand(current.draft.text) ||
      current.compaction?.status === "pending"
    ) {
      await handleCompactCommand({
        threadId,
        active:
          expectedTurnId !== null ||
          threadDetail.turns.some((turn) => turn.status === "inProgress"),
        read: () => composerStatesRef.current[threadId] ?? emptyComposerState(),
        update: (change) => updateComposer(threadId, change),
        compact: async (id, includeOriginalReference) => {
          unwrapCompactionIpcReply(
            await window.zenx.protocol.request("thread/compact", {
              threadId: id,
              ...(includeOriginalReference
                ? {}
                : { includeOriginalReference: false }),
            }),
          );
        },
        refresh: async () => {
          if (selectedThreadIdRef.current === threadId)
            await resumeThread(threadId, true);
        },
      });
      return;
    }
    if (current.draft.images.length > 0) {
      const capabilityError = imageCapabilityMessage(
        providerProfiles,
        selectedSettings,
        models,
      );
      if (capabilityError !== null) {
        setModelUpdateError(capabilityError);
        return;
      }
    }
    if (intent !== "steer" && models.length === 0) {
      setModelUpdateError(modelCatalogError ?? modelCatalogLoading());
      return;
    }
    if (
      intent !== "steer" &&
      selectedSettings?.threadId === threadId &&
      !canSendWithModel(models, selectedSettings.model)
    ) {
      setModelUpdateError(
        unavailableSelectionMessage(
          models,
          providerProfiles,
          selectedSettings,
        ) ?? i18n.t("shell:chooseAnAvailableModelBeforeSending"),
      );
      return;
    }
    if (
      intent !== "steer" &&
      selectedSettings !== null &&
      !hasValidReasoningSelection(models, selectedSettings)
    ) {
      setModelUpdateError(
        i18n.t("shell:chooseAnAvailableReasoningEffortBeforeSending"),
      );
      return;
    }
    const started = beginComposerSubmission(
      current,
      intent,
      expectedTurnId,
      () => crypto.randomUUID(),
      clientObservation,
    );
    if (started === current) return;
    composerStatesRef.current = {
      ...composerStatesRef.current,
      [threadId]: started,
    };
    setComposerStates(composerStatesRef.current);
    const submission = started.submission;
    if (submission === null || submission.status !== "pending") return;
    try {
      await deliverComposerSubmission(threadId, submission);
      updateComposer(threadId, (state) =>
        acceptComposerSubmission(state, submission.clientUserMessageId),
      );
      if (selectedThreadIdRef.current === threadId) {
        void window.zenx.imageAttachments
          .forThread(threadId)
          .then((attachments) => {
            if (selectedThreadIdRef.current === threadId)
              setThreadAttachments(attachments);
          })
          .catch((error: unknown) =>
            setRequestError(
              i18n.t("shell:threadImagesLoadFailed", {
                error: describeError(error),
              }),
            ),
          );
      }
    } catch (error) {
      updateComposer(threadId, (state) =>
        failComposerSubmission(
          state,
          submission.clientUserMessageId,
          describeError(error),
        ),
      );
    }
  };

  const compactFromContext = async () => {
    if (
      threadDetail === null ||
      archivingThreadIdsRef.current.has(threadDetail.id)
    )
      return;
    const threadId = threadDetail.id;
    await requestContextCompaction({
      threadId,
      active: threadDetail.turns.some((turn) => turn.status === "inProgress"),
      clearCommandDraft: false,
      read: () => composerStatesRef.current[threadId] ?? emptyComposerState(),
      update: (change) => updateComposer(threadId, change),
      compact: async (id) => {
        unwrapCompactionIpcReply(
          await window.zenx.protocol.request("thread/compact", {
            threadId: id,
          }),
        );
      },
      refresh: async () => {
        if (selectedThreadIdRef.current === threadId)
          await resumeThread(threadId, true);
      },
    });
  };

  const respondToApproval = async (
    requestId: string,
    decision: ApprovalDecision,
  ) => {
    setApprovals((current) =>
      markApprovalResponding(current, requestId, decision),
    );
    try {
      await window.zenx.protocol.respondToApproval(requestId, decision);
    } catch (error) {
      setApprovals((current) => restoreApprovalPending(current, requestId));
      throw error;
    }
  };

  useEffect(() => {
    setPermissionError(null);
  }, [selectedThreadId]);

  const changePermission = async (sandbox: FilePermissionMode) => {
    const threadId = threadDetail?.id;
    if (!threadId) return;
    setSwitchingPermission(true);
    setPermissionError(null);
    try {
      await window.zenx.protocol.request("thread/permissions/update", {
        threadId,
        sandbox,
      });
    } catch (error) {
      if (selectedThreadIdRef.current === threadId)
        setPermissionError(describeError(error));
    } finally {
      setSwitchingPermission(false);
    }
  };

  const changeModel = async (model: string) => {
    if (
      threadDetail === null ||
      selectedSettings === null ||
      model === selectedSettings.model
    )
      return;
    setSwitchingModel(true);
    setModelUpdateError(null);
    try {
      await window.zenx.protocol.request(
        "thread/settings/update",
        modelChangeRequest(threadDetail.id, model),
      );
    } catch (error) {
      setModelUpdateError(describeError(error));
    } finally {
      setSwitchingModel(false);
    }
  };

  const changeReasoning = async (effort: string) => {
    if (
      threadDetail === null ||
      selectedSettings === null ||
      effort === selectedSettings.reasoningEffort
    )
      return;
    setSwitchingModel(true);
    setModelUpdateError(null);
    try {
      await window.zenx.protocol.request(
        "thread/settings/update",
        reasoningChangeRequest(threadDetail.id, selectedSettings.model, effort),
      );
    } catch (error) {
      setModelUpdateError(describeError(error));
    } finally {
      setSwitchingModel(false);
    }
  };

  const changeNewThreadModel = (model: string) => {
    const settings = draftSettingsForModel(
      models,
      model,
      newThreadDraftRef.current?.settings ?? null,
    );
    if (settings === null) {
      setModelUpdateError(i18n.t("shell:chooseAnAvailableModelBeforeSending"));
      return;
    }
    setModelUpdateError(null);
    updateNewThreadDraft((draft) => ({ ...draft, settings }));
  };

  const changeNewThreadReasoning = (effort: string) => {
    const draft = newThreadDraftRef.current;
    if (draft === null) return;
    const settings = draft.settings ?? defaultDraftSettings(models);
    const model =
      settings === null
        ? undefined
        : models.find((candidate) => candidate.id === settings.model);
    if (
      settings === null ||
      model === undefined ||
      !model.supportedReasoningEfforts.some(
        (candidate) => candidate.reasoningEffort === effort,
      )
    ) {
      setModelUpdateError(
        i18n.t("shell:chooseAnAvailableReasoningEffortBeforeSending"),
      );
      return;
    }
    setModelUpdateError(null);
    updateNewThreadDraft((current) => ({
      ...current,
      settings: { ...settings, reasoningEffort: effort },
    }));
  };

  const openPage = (next: ProductPage) => {
    setMessageTargetRequest(null);
    if (next.startsWith("/threads/")) {
      const target = new URL(next, "https://zenx.local");
      const threadId = decodeURIComponent(
        target.pathname.slice("/threads/".length),
      );
      if (
        selectedRoom &&
        (target.searchParams.get("view") === "panel" ||
          target.searchParams.has("panel"))
      ) {
        const requestedPanel = target.searchParams.get("panel");
        const validPanel =
          requestedPanel &&
          pluginSnapshot?.panels.some((p) => p.key === requestedPanel);
        if (target.searchParams.get("view") === "panel" || validPanel) {
          sidebarState.controller.beginPresentationIntent({
            kind: "room",
            id: selectedRoom.id,
          });
          setRoomWorkspaceStates((current) => ({
            ...current,
            [selectedRoom.id]: {
              ...(current[selectedRoom.id] ?? {
                selected: "custom:overview",
                tabs: [],
                member: selectedRoom.assistant?.threadId ?? "",
              }),
              ...(target.searchParams.get("view") === "panel"
                ? {
                    conversationThreadIds: [
                      ...new Set([
                        ...(current[selectedRoom.id]?.conversationThreadIds ??
                          []),
                        threadId,
                      ]),
                    ],
                    selected: `thread:${threadId}`,
                  }
                : { selected: `plugin:${requestedPanel}` }),
            },
          }));
          setPage(`${roomConversationRoute(selectedRoom.id)}&panel=open`);
        }
        return;
      }
      const owner = selectedThreadIdRef.current;
      if (
        target.searchParams.get("view") === "panel" &&
        owner !== null &&
        threadId !== owner
      ) {
        sidebarState.controller.beginPresentationIntent(owner);
        setConversationPanels((current) => ({
          ...current,
          [owner]: [...new Set([...(current[owner] ?? []), threadId])],
        }));
        setBrowserPanels((current) => ({ ...current, [owner]: true }));
        setPanelTabs((current) => ({
          ...current,
          [owner]: `thread:${threadId}`,
        }));
        return;
      }
      if (target.searchParams.has("panel") && owner !== null) {
        const panel = pluginSnapshot?.panels?.find(
          (entry) => entry.key === target.searchParams.get("panel"),
        );
        if (panel !== undefined) {
          sidebarState.controller.beginPresentationIntent(owner);
          setBrowserPanels((current) => ({ ...current, [owner]: true }));
          setPanelTabs((current) => ({
            ...current,
            [owner]: `plugin:${panel.key}`,
          }));
        }
        return;
      }
      void resumeThread(threadId);
      return;
    }
    if (
      next === page &&
      selectedRoom &&
      new URLSearchParams(next.split("?")[1] ?? "").has("panel")
    )
      void sidebarState.controller.edit(
        { kind: "room", id: selectedRoom.id },
        () => ({ open: true }),
      );
    discardRecoverableDraft();
    if (projectPickerIntentRef.current !== null) closeProjectPicker();
    if (next !== "agent") abandonNewThreadDraft();
    setPage(next);
    setSidebarOpen(false);
  };

  useEffect(() => {
    if (!page.startsWith("/plugins/")) return;
    const stillMounted = [
      ...(pluginSnapshot?.pages ?? []),
      ...(pluginSnapshot?.subroutes ?? []),
    ].some((candidate) => candidate.route === pluginRoutePath(page));
    if (stillMounted) return;
    setPage("agent");
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.focus(),
    );
  }, [page, pluginSnapshot]);

  const [shellTargetRequest, setShellTargetRequest] =
    useState<ShellTargetRequest | null>(null);
  const shellTargetIntent = useRef(0);
  const shellNavigationScope = useRef("");
  shellNavigationScope.current = `${page}:${selectedRoom?.id ?? selectedThreadId ?? ""}`;
  useEffect(() => {
    setShellTargetRequest(null);
    shellTargetIntent.current++;
  }, [page, selectedThreadId, selectedRoom?.id]);
  const shellNavigation: NonNullable<
    React.ContextType<typeof ShellTargetNavigationContext>
  > = {
    request: shellTargetRequest,
    consumed: (requestId) =>
      setShellTargetRequest((current) =>
        current?.requestId === requestId ? null : current,
      ),
    open: async (target, source) => {
      const api = window.zenx.shellPanel;
      if (!api) throw new Error(i18n.t("panels:shellUnavailable"));
      const intent = ++shellTargetIntent.current;
      const scope = shellNavigationScope.current;
      const owner = selectedRoom
        ? { kind: "room" as const, id: selectedRoom.id }
        : selectedThreadId
          ? { kind: "thread" as const, id: selectedThreadId }
          : null;
      if (
        !owner ||
        (selectedRoom &&
          !selectedRoom.members.some(
            (member) => member.threadId === target.threadId,
          ))
      )
        throw new Error(i18n.t("panels:backgroundShellOpenFailed"));
      const presentationIntent =
        sidebarState.controller.beginPresentationIntent(owner);
      const current = () =>
        source.isCurrent() &&
        shellTargetIntent.current === intent &&
        shellNavigationScope.current === scope &&
        sidebarState.controller.isPresentationIntentCurrent(
          owner,
          presentationIntent,
        );
      if (
        !(await openShellTarget({
          target,
          owner,
          api,
          sidebar: sidebarState.controller,
          isCurrent: current,
          presentationIntent,
        })) ||
        !current()
      )
        return;
      setSideChatSelections((previous) => ({
        ...previous,
        [owner.kind === "room" ? `room:${owner.id}` : owner.id]: "",
      }));
      setShellTargetRequest({
        ...target,
        ownerKey: `${owner.kind}:${owner.id}`,
        requestId: intent,
      });
    },
  };

  const [remoteMessageSource, setRemoteMessageSource] =
    useState<FleetMessageSourceView | null>(null);
  useEffect(() => setRemoteMessageSource(null), [page, selectedThreadId]);
  const [triggerSourceRequest, setTriggerSourceRequest] = useState<{
    viewportId: string;
    threadId: string;
    triggerId: string;
    requestId: number;
  } | null>(null);
  useEffect(
    () => setTriggerSourceRequest(null),
    [selectedThreadId, selectedRoom?.id],
  );
  const [messageTargetRequest, setMessageTargetRequest] =
    useState<MessageTargetRequest | null>(null);
  const sourceNavigationIntent = useRef(0);
  const sourceNavigationState = useRef({ page, selectedThreadId });
  sourceNavigationState.current = { page, selectedThreadId };
  const openMessageSource: MessageSourceNavigator = async (target, owner) => {
    const intent = ++sourceNavigationIntent.current;
    const navigation = sourceNavigationState.current;
    const epoch = selectionEpoch.current;
    const current = () =>
      owner.isCurrent() &&
      sourceNavigationIntent.current === intent &&
      selectionEpoch.current === epoch &&
      sourceNavigationState.current.page === navigation.page &&
      sourceNavigationState.current.selectedThreadId ===
        navigation.selectedThreadId;
    if (target.kind === "thread" && target.deviceId !== undefined) {
      if (!target.itemId || !target.returnBound)
        throw new Error(i18n.t("shell:sourceRemoteUnavailable"));
      const api = (window.zenx as unknown as { fleet: RemoteMessageSourceApi })
        .fleet;
      const source = await api.messageSource({
        threadId: owner.threadId,
        itemId: target.itemId,
      });
      if (current()) setRemoteMessageSource(source);
      return;
    }
    if (!target.id)
      throw new Error(i18n.t("shell:sourceNavigationUnavailable"));
    if (target.kind === "trigger") {
      const panel = pluginSnapshot?.panels.find(
        (entry) => entry.pluginId === "zenx-triggers",
      );
      if (!panel) throw new Error(i18n.t("shell:sourcePluginUnavailable"));
      if (!current()) return;
      const viewportId = selectedRoom?.id ?? selectedThreadId;
      if (!viewportId)
        throw new Error(i18n.t("shell:sourceNavigationUnavailable"));
      setTriggerSourceRequest({
        viewportId,
        threadId: target.threadId ?? owner.threadId,
        triggerId: target.id,
        requestId: intent,
      });
      if (selectedRoom) {
        setRoomWorkspaceStates((states) => ({
          ...states,
          [selectedRoom.id]: {
            ...(states[selectedRoom.id] ?? {
              selected: "custom:overview",
              tabs: [],
              member: "",
            }),
            member: owner.threadId,
          },
        }));
      }
      openPage(
        `/threads/${encodeURIComponent(owner.threadId)}?${new URLSearchParams({ panel: panel.key })}`,
      );
      return;
    }
    let result;
    try {
      result = await window.zenx.protocol.request("zen/thread/read", {
        threadId: target.id,
      });
    } catch {
      throw new Error(i18n.t("shell:sourceThreadUnavailable"));
    }
    if (!current()) return;
    if (result.thread.id !== target.id)
      throw new Error(i18n.t("shell:sourceThreadUnavailable"));
    if (result.thread.archived)
      throw new Error(i18n.t("shell:sourceThreadArchived"));
    const message = target.itemId
      ? resolveDeliveredMessage(result.thread.items, target.itemId)
      : undefined;
    if (message === "missing")
      throw new Error(i18n.t("shell:toolMessageMissing"));
    if (message === "cancelled")
      throw new Error(i18n.t("shell:toolMessageCancelled"));
    if (message === "pending")
      throw new Error(i18n.t("shell:toolMessagePending"));
    const panel =
      (selectedRoom !== undefined && selectedRoom !== null) ||
      owner.threadId !== selectedThreadIdRef.current;
    openPage(
      `/threads/${encodeURIComponent(target.id)}${panel ? "?view=panel" : ""}`,
    );
    if (message)
      setMessageTargetRequest({
        threadId: target.id,
        itemId: message.itemId,
        requestId: intent,
      });
  };

  const renameThread = async (threadId: string, title: string) => {
    const projection = await window.zenx.titles.rename(threadId, title);
    setTitleSnapshot((current) => applyThreadTitleReceipt(current, projection));
  };

  const changeThreadPinned = async (summary: NativeThreadSummary) => {
    const shouldPin = !pinnedThreadIds.includes(summary.threadId);
    await queuePinMutation((current) =>
      shouldPin
        ? [
            summary.threadId,
            ...current.filter((threadId) => threadId !== summary.threadId),
          ]
        : current.filter((threadId) => threadId !== summary.threadId),
    );
  };

  const clearSelectedThreadForArchive = (threadId: string) => {
    if (selectedThreadIdRef.current !== threadId) return;
    invalidateThreadSelection();
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setThreadDetail(null);
    setSelectedSettings(null);
    setSettingsTab("archived");
    openPage("settings");
  };

  const setThreadArchiving = (threadId: string, archiving: boolean) => {
    const current = archivingThreadIdsRef.current;
    if (current.has(threadId) === archiving) return;
    const next = new Set(current);
    if (archiving) next.add(threadId);
    else next.delete(threadId);
    archivingThreadIdsRef.current = next;
    setArchivingThreadIds(next);
  };

  const performThreadLifecycle = async (
    summary: NativeThreadSummary,
    clearSelectedOnArchive = false,
  ) => {
    if (!summary.archived && threadHasActiveTurn(summary, threadDetail)) {
      throw new Error(
        i18n.t("shell:waitForTheActiveTurnToFinishBeforeArchiving"),
      );
    }
    const fenceSelectedArchive =
      !summary.archived &&
      clearSelectedOnArchive &&
      selectedThreadIdRef.current === summary.threadId;
    if (
      fenceSelectedArchive &&
      archivingThreadIdsRef.current.has(summary.threadId)
    )
      return;
    if (fenceSelectedArchive) setThreadArchiving(summary.threadId, true);
    try {
      await window.zenx.protocol.request(
        summary.archived ? "thread/unarchive" : "thread/archive",
        { threadId: summary.threadId },
      );
    } catch (error) {
      if (fenceSelectedArchive) setThreadArchiving(summary.threadId, false);
      throw error;
    }
    if (!summary.archived) {
      if (clearSelectedOnArchive)
        clearSelectedThreadForArchive(summary.threadId);
      if (fenceSelectedArchive) setThreadArchiving(summary.threadId, false);
      try {
        await queuePinMutation((current) =>
          current.includes(summary.threadId)
            ? current.filter((threadId) => threadId !== summary.threadId)
            : current,
        );
      } catch (error) {
        setRequestError(
          i18n.t("shell:threadArchivedPinClearFailed", {
            error: describeError(error),
          }),
        );
      }
    }
    await loadThreadSummaries();
    await loadProjects();
  };

  const deleteArchivedThread = async (summary: NativeThreadSummary) => {
    if (summary.lastItemId === undefined)
      throw new Error(i18n.t("settings:settingsView.unavailableJournal"));
    await window.zenx.protocol.request("zen/thread/delete", {
      threadId: summary.threadId,
      expectedLastItemId: summary.lastItemId,
    });
    threadProjectionCacheRef.current.delete(summary.threadId);
    setArchivedThreadSummaries((current) =>
      current.filter((entry) => entry.threadId !== summary.threadId),
    );
    clearSelectedThreadForArchive(summary.threadId);
    await Promise.all([
      loadThreadSummaries(),
      loadDeletedThreads(),
      loadProjects(),
    ]);
  };

  const restoreDeletedThread = async (summary: DeletedThreadSummary) => {
    await window.zenx.protocol.request("zen/thread/restore", {
      threadId: summary.threadId,
      deletionItemId: summary.deletionItemId,
    });
    setDeletedThreadSummaries((current) =>
      current.filter((entry) => entry.threadId !== summary.threadId),
    );
    await Promise.all([
      loadThreadSummaries(),
      loadDeletedThreads(),
      loadProjects(),
    ]);
  };

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(
          SIDEBAR_COLLAPSED_STORAGE_KEY,
          String(next),
        );
      } catch {
        // The preference remains valid for this window.
      }
      return next;
    });
  };

  const openSidebar = () => {
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  };

  const forkThread = async (sourceThreadId: string) => {
    const result = await window.zenx.protocol.request("thread/fork", {
      sourceThreadId,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    await Promise.all([loadThreadSummaries(), loadProjects()]);
    await resumeThread(result.thread.id);
  };

  const forkMessage: MessageForkHandler = (target, owner) => {
    const key = JSON.stringify([target.sourceThreadId, target.itemId]);
    const pending = messageForkRequests.current.get(key);
    if (pending !== undefined) return pending;
    const selection = selectionEpoch.current;
    const intent = ++messageForkNavigation.current;
    const request = (async () => {
      try {
        const result = await window.zenx.protocol.request("zen/thread/fork", {
          sourceThreadId: target.sourceThreadId,
          through: { type: "item", itemId: target.itemId },
          workspace: { type: "same-directory" },
        });
        // Refresh the existing projections independently of opening the copy.
        // A later click/navigation owns the viewport, even if the user returns.
        void Promise.all([loadThreadSummaries(), loadProjects()]);
        if (
          owner.isCurrent() &&
          selectionEpoch.current === selection &&
          messageForkNavigation.current === intent
        )
          await resumeThread(result.thread.id);
      } catch (error) {
        // A lost reply can leave an already-created copy. Refresh only the
        // read projections so it can be found; never repeat creation or guess
        // which Thread should replace the source viewport.
        void Promise.all([loadThreadSummaries(), loadProjects()]);
        if (!owner.isVisible())
          setRequestError(
            i18n.t("shell:messageForkFailed", { error: describeError(error) }),
          );
        throw error;
      } finally {
        messageForkRequests.current.delete(key);
      }
    })();
    messageForkRequests.current.set(key, request);
    return request;
  };

  const changeSidebarMode = (mode: SidebarMode) => {
    setSidebarMode(mode);
    try {
      writeSidebarMode(window.localStorage, mode);
    } catch {
      // The preference remains valid for this window.
    }
  };

  const titleProjection =
    selectedSummary === null
      ? undefined
      : titleSnapshot[selectedSummary.threadId];
  const renameSelectedThread = async (title: string) => {
    if (selectedSummary === null) return;
    await renameThread(selectedSummary.threadId, title);
  };
  const retrySelectedTitle = async () => {
    if (selectedSummary === null) return;
    const projection = await window.zenx.titles.retry(selectedSummary.threadId);
    setTitleSnapshot((current) => applyThreadTitleReceipt(current, projection));
  };

  const changeComposerSendMode = async (
    mode: "batch" | "queue" | "soft" | "hard",
  ) => {
    const current = await window.zenx.settings.get();
    const saved = await window.zenx.settings.save({
      ...current.profile,
      baseRevision: current.profile.revision ?? 0,
      composerSendMode: mode,
      composerSendModeExplicit: true,
      ...(current.profile.composerSendModeMigration === undefined
        ? {}
        : {
            composerSendModeMigration: {
              ...current.profile.composerSendModeMigration,
              acknowledged: true,
            },
          }),
    });
    applyComposerProfile(saved.profile);
  };

  const settleLegacySendChoice = async (restoreQueue: boolean) => {
    const current = await window.zenx.settings.get();
    const migration = current.profile.composerSendModeMigration;
    if (migration === undefined || migration.acknowledged) return;
    const saved = await window.zenx.settings.save({
      ...current.profile,
      baseRevision: current.profile.revision ?? 0,
      composerSendMode: restoreQueue
        ? "queue"
        : (current.profile.composerSendMode ?? "soft"),
      composerSendModeExplicit: restoreQueue
        ? true
        : (current.profile.composerSendModeExplicit ?? false),
      composerSendModeMigration: { ...migration, acknowledged: true },
    });
    applyComposerProfile(saved.profile);
  };

  const cancelQueued = async (
    threadId: string,
    targets: readonly QueuedCancellationTarget[],
  ): Promise<{ results: QueuedCancellationResult[] }> => {
    try {
      return await window.zenx.protocol.request("zen/thread/queue/cancel", {
        threadId,
        items: targets,
      });
    } catch {
      // Uncertain transport results require one authoritative read by stable
      // queued IDs. Never automatically send a second cancellation request.
      try {
        const { thread } = await window.zenx.protocol.request(
          "zen/thread/read",
          { threadId },
        );
        const known = cancellationResultsFromItems(thread.items, targets);
        if (known !== null) {
          if (selectedThreadIdRef.current === threadId)
            await resumeThread(threadId, true);
          return { results: known };
        }
      } catch {
        // A failed read cannot prove the outcome either.
      }
      throw new Error(i18n.t("shell:cancellationUnconfirmedDetail"));
    }
  };

  const createSideChatDraft = async (
    input: { parentThreadId: string; model?: string; effort?: string },
    roomId?: string,
  ) => {
    const parent = input.parentThreadId;
    const { thread } = await window.zenx.protocol.request("zen/thread/read", {
      threadId: parent,
    });
    const lastItem = thread.items.at(-1);
    if (!lastItem)
      throw new Error(i18n.t("panels:newConversationUnidentified"));
    return sideChatDrafts.open(
      parent,
      {
        itemId: lastItem.id,
        contextItemId: thread.itemList?.at(-1)?.id ?? null,
      },
      {
        ...input,
        ...(roomId ? { roomId } : {}),
        contextPreview: projectNativeThread(thread),
        inheritedModel: encodeModelKey(thread),
        inheritedEffort: thread.reasoningEffort,
      },
    );
  };

  const revealSideChat = (
    parent: string,
    roomId: string | undefined,
    tab: string,
  ) => {
    const owner = roomId ? `room:${roomId}` : parent;
    const nativeOwner = roomId ? { kind: "room" as const, id: roomId } : parent;
    sidebarState.controller.beginPresentationIntent(nativeOwner);
    if (roomId) {
      void sidebarState.controller.edit(nativeOwner, () => ({
        open: true,
        ...(tab.startsWith("thread:") ? { selectedTab: tab } : {}),
      }));
    } else {
      setBrowserPanels((current) => ({ ...current, [parent]: true }));
      if (tab.startsWith("thread:"))
        setPanelTabs((current) => ({ ...current, [parent]: tab }));
    }
    setSideChatSelections((current) => ({
      ...current,
      [owner]: tab.startsWith("custom:") ? tab : "",
    }));
  };

  const openSideChatDraft: NonNullable<
    React.ContextType<typeof SideChatDraftContext>
  > = async (input) => {
    const roomId = selectedRoom?.id;
    const scope = shellNavigationScope.current;
    const draft = await createSideChatDraft(input, roomId);
    if (shellNavigationScope.current === scope)
      revealSideChat(
        input.parentThreadId,
        roomId,
        `custom:side-chat-draft-${draft.id}`,
      );
  };

  const [sideQuoteChoice, setSideQuoteChoice] = useState<{
    quote: MessageQuoteReference;
    parent: string;
    roomId?: string;
    scope: string;
  } | null>(null);
  const [composerFocus, setComposerFocus] = useState<{
    composerId: string;
    sequence: number;
  }>();
  const sideQuoteIntent = useRef(0);
  const sideQuoteCreations = useRef(
    new Map<string, ReturnType<typeof createSideChatDraft>>(),
  );
  useEffect(() => {
    setSideQuoteChoice(null);
    setComposerFocus(undefined);
  }, [page, selectedThreadId, selectedRoom?.id]);

  const sideQuoteTargets = (parent: string, roomId?: string) => {
    const nativeOwner = roomId ? { kind: "room" as const, id: roomId } : parent;
    const tabs = sidebarState.controller.get(nativeOwner)?.tabs ?? [];
    return [
      ...sideChatDrafts
        .entries()
        .filter(
          (draft) =>
            !draft.sending &&
            !draft.creationUnconfirmed &&
            (roomId
              ? draft.roomId === roomId
              : !draft.roomId && draft.parentThreadId === parent),
        )
        .map((draft, index) => ({
          id: `custom:side-chat-draft-${draft.id}`,
          draftId: draft.id,
          threadId: draft.threadId,
          title: `${i18n.t("panels:sideChat")} ${index + 1}`,
        })),
      ...tabs.flatMap((tab) => {
        if (
          tab.kind !== "thread" ||
          tab.threadId === parent ||
          archivedSummaries.some((summary) => summary.threadId === tab.threadId)
        )
          return [];
        const summary = activeSummaries.find(
          (entry) => entry.threadId === tab.threadId,
        );
        return [
          {
            id: `thread:${tab.threadId}`,
            draftId: undefined,
            threadId: tab.threadId,
            title: summary
              ? threadTitle(summary)
              : i18n.t("shell:conversation"),
          },
        ];
      }),
    ];
  };

  const insertSideQuote = async (
    request: NonNullable<typeof sideQuoteChoice>,
    targetId?: string,
  ) => {
    const intent = ++sideQuoteIntent.current;
    const { parent, roomId, quote, scope } = request;
    let target = targetId
      ? sideQuoteTargets(parent, roomId).find((entry) => entry.id === targetId)
      : undefined;
    // A closed target must not redirect silently or drop the pending quote.
    if (targetId && !target) {
      setSideQuoteChoice(request);
      return;
    }
    if (!target) {
      const owner = roomId ? `room:${roomId}` : parent;
      let creation = sideQuoteCreations.current.get(owner);
      if (!creation) {
        creation = createSideChatDraft({ parentThreadId: parent }, roomId);
        sideQuoteCreations.current.set(owner, creation);
      }
      try {
        const draft = await creation;
        target = {
          id: `custom:side-chat-draft-${draft.id}`,
          draftId: draft.id,
          threadId: undefined,
          title: i18n.t("panels:sideChat"),
        };
      } finally {
        if (sideQuoteCreations.current.get(owner) === creation)
          sideQuoteCreations.current.delete(owner);
      }
    }
    const append = (state: ComposerState) =>
      editComposer(state, addMessageQuote(state.draft.text, quote));
    if (target.draftId) sideChatDrafts.updateComposer(target.draftId, append);
    else if (target.threadId) updateComposer(target.threadId, append);
    if (
      shellNavigationScope.current !== scope ||
      sideQuoteIntent.current !== intent
    )
      return;
    setSideQuoteChoice(null);
    revealSideChat(parent, roomId, target.id);
    const composerId = target.draftId
      ? `side-chat-draft-${target.draftId}`
      : `side-composer-${target.threadId}`;
    setComposerFocus((previous) => ({
      composerId,
      sequence: (previous?.sequence ?? 0) + 1,
    }));
  };

  const addToSideChat = (quote: MessageQuoteReference) => {
    const roomId = selectedRoom?.id;
    const parent = roomId
      ? quote.threadId
      : (selectedThreadId ?? quote.threadId);
    const request = {
      parent,
      roomId,
      quote,
      scope: shellNavigationScope.current,
    };
    const owner = roomId ? `room:${roomId}` : parent;
    const selected =
      sideChatSelectionsRef.current[owner] ||
      sidebarState.controller.get(
        roomId ? { kind: "room", id: roomId } : parent,
      )?.selectedTab;
    const targets = sideQuoteTargets(parent, roomId);
    const target = chooseSideChatQuoteTarget(targets, selected ?? undefined);
    if (!target && targets.length > 1) setSideQuoteChoice(request);
    else
      void insertSideQuote(request, target?.id).catch((error: unknown) => {
        setSideQuoteChoice(request);
        setRequestError(describeError(error));
      });
  };

  const renderSideChatDraft = (id: string) => {
    const draft = sideChatDrafts.get(id);
    if (!draft) return null;
    if (draft.threadId && draft.composer.submission === null)
      return renderSideConversation(draft.threadId);
    const model = draft.model ?? draft.inheritedModel;
    const chosen = models.find((entry) => entry.id === model);
    const effort =
      draft.effort ??
      (draft.model ? chosen?.defaultReasoningEffort : draft.inheritedEffort) ??
      null;
    const settings = model
      ? {
          threadId: id,
          modelProvider: decodeModelKey(model).providerProfileId,
          model,
          reasoningEffort: effort,
        }
      : null;
    const effortInvalid =
      effort !== null &&
      !chosen?.supportedReasoningEfforts.some(
        (entry) => entry.reasoningEffort === effort,
      );
    const imageError = imageCapabilityMessage(
      providerProfiles,
      settings,
      models,
    );
    return (
      <ThreadView
        key={id}
        composerId={`side-chat-draft-${id}`}
        thread={null}
        contextPreview={draft.contextPreview}
        emptyContent={
          <div className="thread-empty">
            <h2>{i18n.t("panels:sideChat")}</h2>
            <p>{i18n.t("panels:sideChatContextPreview")}</p>
          </div>
        }
        composerContext={
          <p
            className="composer-note side-chat-context-note"
            role="status"
            aria-busy={draft.sending}
          >
            {draft.sending ? (
              <span className="mini-spinner" aria-hidden="true" />
            ) : null}
            {i18n.t(
              draft.sending
                ? draft.threadId
                  ? "panels:sideChatSending"
                  : "panels:sideChatCreating"
                : "panels:sideChatContextPreview",
            )}
          </p>
        }
        approvals={[]}
        composer={draft.composer}
        models={models}
        providerProfiles={providerProfiles}
        selectedModel={model}
        selectedReasoningEffort={effort}
        modelDisabled={draft.sending || !!draft.threadId}
        modelError={
          draft.creationUnconfirmed
            ? i18n.t("panels:sideChatCreationUnconfirmed")
            : effortInvalid
              ? i18n.t("panels:childSelectionUnavailable")
              : null
        }
        imageCapabilityError={imageError}
        composerSendMode={composerSendMode}
        onComposerSendModeChange={changeComposerSendMode}
        onModelChange={(model) =>
          sideChatDrafts.configure(id, { model, effort: undefined })
        }
        onReasoningChange={(effort) => sideChatDrafts.configure(id, { effort })}
        onDraftChange={(text) =>
          sideChatDrafts.updateComposer(id, (state) =>
            editComposer(state, text),
          )
        }
        onImportImages={async (files) => {
          const images = await window.zenx.imageAttachments.import(
            await Promise.all(
              files.map(async (file) => ({
                name: file.name,
                mediaType: file.type,
                bytes: new Uint8Array(await file.arrayBuffer()),
              })),
            ),
          );
          sideChatDrafts.updateComposer(id, (state) =>
            addComposerImages(state, images),
          );
        }}
        onPickImages={async () => {
          const images = await window.zenx.imageAttachments.pick();
          sideChatDrafts.updateComposer(id, (state) =>
            addComposerImages(state, images),
          );
        }}
        onRemoveImage={(image) =>
          sideChatDrafts.updateComposer(id, (state) =>
            removeComposerImage(state, image),
          )
        }
        onReadAttachment={async (attachment) =>
          await window.zenx.imageAttachments.read(attachment)
        }
        onInterrupt={async () => {}}
        onRespondToApproval={respondToApproval}
        onSubmit={async (intent, turn, observation) => {
          if (
            intent !== "start" ||
            turn !== null ||
            !model ||
            !canSendWithModel(models, model)
          )
            return;
          if (
            isCompactCommand(draft.composer.draft.text) ||
            effortInvalid ||
            (draft.composer.draft.images.length > 0 && imageError)
          )
            return;
          await sideChatDrafts.submit(
            id,
            async (current) => {
              const result = await window.zenx.protocol.request(
                "zen/thread/create-child-configured",
                {
                  parentThreadId: current.parentThreadId,
                  mode: "side-chat",
                  snapshot: current.boundary,
                  ...(current.model ? { model: current.model } : {}),
                  ...(current.effort ? { effort: current.effort } : {}),
                },
              );
              if (!result.thread.id)
                throw new Error(i18n.t("panels:newConversationUnidentified"));
              return result.thread.id;
            },
            deliverComposerSubmission,
            observation,
          );
          const current = sideChatDrafts.get(id);
          if (current?.threadId && current.composer.submission === null) {
            const child = current.threadId;
            const owner = current.roomId
              ? `room:${current.roomId}`
              : current.parentThreadId;
            const nativeOwner = current.roomId
              ? { kind: "room" as const, id: current.roomId }
              : current.parentThreadId;
            updateComposer(child, () => current.composer);
            const draftTab = `custom:side-chat-draft-${id}`;
            const order = (
              sideChatTabOrdersRef.current[owner] ??
              (current.roomId
                ? roomWorkspaceStates[current.roomId]?.tabs
                : workspaceTabOrder[owner]) ??
              []
            ).map((tab) => (tab === draftTab ? `thread:${child}` : tab));
            if (!order.includes(`thread:${child}`))
              order.push(`thread:${child}`);
            setSideChatTabOrders((orders) => ({ ...orders, [owner]: order }));
            await sidebarState.controller.edit(nativeOwner, (state) => {
              const tabs = [
                ...state.tabs,
                { kind: "thread" as const, threadId: child },
              ];
              const byId = new Map(tabs.map((tab) => [sidebarTabId(tab), tab]));
              const ids = [...new Set([...order, ...byId.keys()])].filter(
                (tab) => byId.has(tab),
              );
              return { tabs: ids.map((tab) => byId.get(tab)!) };
            });
            if (
              sideChatSelectionsRef.current[owner] ===
              `custom:side-chat-draft-${id}`
            ) {
              setSideChatSelections((selection) => ({
                ...selection,
                [owner]: "",
              }));
              if (current.roomId) {
                await sidebarState.controller.select(
                  nativeOwner,
                  `thread:${child}`,
                );
              } else
                setPanelTabs((tabs) => ({
                  ...tabs,
                  [owner]: `thread:${child}`,
                }));
            }
            sideChatDrafts.close(id);
            void loadThreadSummaries();
          }
        }}
      />
    );
  };

  const renderSideConversation = (id: string) => (
    <ThreadConversationViewport
      queueEditStore={queueEditStore}
      onRecovery={(threadId, snapshot) =>
        endNotificationsRef.current?.recover(threadId, snapshot)
      }
      key={id}
      threadId={id}
      composer={composerStates[id] ?? emptyComposerState()}
      readComposer={() => composerStatesRef.current[id] ?? emptyComposerState()}
      updateComposer={(change) => updateComposer(id, change)}
      deliver={(submission) => deliverComposerSubmission(id, submission)}
      cancelQueued={(items) => cancelQueued(id, items)}
      onOpenMessageLink={(target) => {
        void resumeThread(id)
          .then(() => {
            if (selectedThreadIdRef.current !== id) return;
            setMessageLinkRequest({
              ...target,
              id: ++messageLinkSequence.current,
              threadId: id,
            });
            setBrowserPanels((current) => ({
              ...current,
              [id]: true,
            }));
          })
          .catch((error: unknown) => setRequestError(describeError(error)));
      }}
      models={models}
      providerProfiles={providerProfiles}
      serverStatus={serverStatus}
      approvals={approvals}
      respondToApproval={respondToApproval}
      pluginSnapshot={pluginSnapshot}
      composerSendMode={composerSendMode}
      onComposerSendModeChange={changeComposerSendMode}
      workflowCommands={workflowCommands}
      archived={
        archivingThreadIds.has(id) ||
        archivedThreadSummaries.some((entry) => entry.threadId === id)
      }
    />
  );

  const shell = (
    <AppConversationProviders
      shellNavigation={shellNavigation}
      openSideChatDraft={openSideChatDraft}
      addToSideChat={addToSideChat}
      composerFocus={composerFocus}
      fork={forkMessage}
      source={openMessageSource}
      messageTarget={messageTargetRequest}
      onMessageTargetConsumed={(requestId) =>
        setMessageTargetRequest((current) =>
          current?.requestId === requestId ? null : current,
        )
      }
      models={models}
      modelCatalogError={modelCatalogError}
    >
      <div
        className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${sidebarOpen ? " sidebar-open" : ""}`}
        style={
          {
            "--workspace-panel-width": `${workspacePanelWidth}px`,
          } as React.CSSProperties
        }
      >
        <WindowTitleBar
          mode={sidebarMode}
          pendingApprovalCount={pendingThreadIds.size}
          sidebarCollapsed={sidebarCollapsed}
          onToggleInbox={() =>
            changeSidebarMode(sidebarMode === "inbox" ? "projects" : "inbox")
          }
          onToggleSidebar={toggleSidebarCollapsed}
        >
          {page === "agent" &&
          newThreadDraft === null &&
          selectedSummary !== null ? (
            <ConversationTitleBar
              onOpenSidebar={openSidebar}
              threads={[...activeSummaries, ...archivedSummaries]}
              onNavigate={openPage}
              onRename={renameSelectedThread}
              onOpenSource={(threadId) => void resumeThread(threadId)}
              onRetryTitle={retrySelectedTitle}
              selectedSummary={selectedSummary}
              sourceSummary={activeSummaries.find(
                (candidate) =>
                  candidate.threadId === threadDetail?.forkedFromId,
              )}
              threadDetail={threadDetail}
              titleProjection={titleProjection}
            />
          ) : page === "settings" ? (
            <PageTitleBar
              onOpenSidebar={openSidebar}
              subtitle={i18n.t(
                "shell:accountAppearanceModelsPluginsAndLocalHost",
              )}
              title={i18n.t("shell:settings")}
            />
          ) : genericPluginTarget !== undefined ? (
            <PageTitleBar
              onOpenSidebar={openSidebar}
              subtitle={
                selectedRoom
                  ? selectedRoom.assistant
                    ? "PAW"
                    : i18n.t("shell:sharedConversation")
                  : i18n.t("shell:providedByPlugin", {
                      plugin: genericPluginTarget.pluginId,
                    })
              }
              title={
                selectedRoom?.name ??
                (genericPluginTarget.pluginId === "zenx-triggers"
                  ? i18n.t("panels:automations")
                  : genericPluginTarget.title)
              }
              actions={
                genericPluginTarget.pluginId === "zenx-rooms" &&
                genericPluginTarget.route === ROOM_ROUTE &&
                selectedRoomId !== null ? (
                  <div
                    className="room-title-actions-host"
                    ref={setRoomHeaderTarget}
                  />
                ) : undefined
              }
            />
          ) : null}
        </WindowTitleBar>
        {page === "agent" &&
        newThreadDraft === null &&
        selectedSummary !== null &&
        browserPanels[selectedSummary.threadId] !== true ? (
          <button
            id="thread-browser-toggle"
            className="icon-button thread-panel-toggle"
            type="button"
            aria-label={
              browserPanels[selectedSummary.threadId]
                ? i18n.t("shell:closeSidePanel")
                : i18n.t("shell:openSidePanel")
            }
            title={
              browserPanels[selectedSummary.threadId]
                ? i18n.t("shell:closeSidePanel")
                : i18n.t("shell:openSidePanel")
            }
            aria-controls="thread-workspace-panel"
            aria-expanded={browserPanels[selectedSummary.threadId] === true}
            disabled={threadDetail === null}
            onClick={() => {
              setBrowserPanels((current) => ({
                ...current,
                [selectedSummary.threadId]: true,
              }));
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLButtonElement>(
                    '#thread-workspace-panel[data-open="true"] .auxiliary-close-button',
                  )
                  ?.focus(),
              );
            }}
          >
            <Icon name="panel-right" />
          </button>
        ) : null}
        <ThreadDebugMenuContext.Provider
          value={{
            threadId: page === "agent" ? debugThreadId : null,
            toggle: (threadId) => {
              if (page === "agent" && debugThreadId === threadId)
                setDebugThreadId(null);
              else if (page === "agent" && selectedThreadId === threadId)
                setDebugThreadId(threadId);
              else void resumeThread(threadId, false, false, true);
            },
          }}
        >
          <Sidebar
            triggerAdmissionId={sidebarTriggerAdmissionId(pluginSnapshot)}
            unreadThreadIds={unreadThreads}
            roomConversations={roomsAdmitted ? roomConversations : undefined}
            selectedRoomId={selectedRoomId}
            collapsed={sidebarCollapsed}
            liveThread={threadDetail}
            mode={sidebarMode}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            onChangeThreadLifecycle={(summary) =>
              performThreadLifecycle(summary, true)
            }
            onChangeThreadPinned={changeThreadPinned}
            onReorderProject={(sourceKey, targetKey, placement) =>
              queueSidebarOrderMutation((current) =>
                moveSidebarProject(
                  current,
                  projects,
                  sourceKey,
                  targetKey,
                  placement,
                ),
              )
            }
            onReorderThread={(
              sourceProjectKey,
              sourceThreadId,
              targetProjectKey,
              targetThreadId,
              placement,
            ) =>
              queueSidebarOrderMutation((current) =>
                moveSidebarThread(
                  current,
                  activeSummaries,
                  projects,
                  sourceProjectKey,
                  sourceThreadId,
                  targetProjectKey,
                  targetThreadId,
                  placement,
                ),
              )
            }
            onReorderPinnedThread={(
              sourceThreadId,
              targetThreadId,
              placement,
            ) =>
              queuePinMutation((current) =>
                movePinnedThreadIds(
                  current,
                  sourceThreadId,
                  targetThreadId,
                  placement,
                ),
              )
            }
            onNewThread={(workspace) => {
              openNewThreadDraft(workspace);
            }}
            onNewProjectlessThread={() => showNewThreadDraft(null)}
            onAddProject={() => openProjectPicker("add-project")}
            newThreadDisabled={newThreadPending}
            onRemoveProject={(workspace) => {
              void window.zenx.settings
                .removeWorkspace(workspace)
                .then(async () => await loadProjects())
                .catch((error: unknown) =>
                  setRequestError(describeError(error)),
                );
            }}
            onEditProject={(workspace, name) => {
              editingProjectFocusWorkspace.current = workspace;
              setEditingProject({ workspace, name });
            }}
            onSetDefaultProject={(workspace) => {
              void window.zenx.settings
                .addWorkspace(workspace)
                .then(
                  async () =>
                    await window.zenx.settings.setDefaultWorkspace(workspace),
                )
                .then(async () => await loadProjects())
                .catch((error: unknown) =>
                  setRequestError(describeError(error)),
                );
            }}
            onOpenContribution={(route) => {
              const target = pluginSnapshot?.pages.find(
                (candidate) => candidate.route === pluginRoutePath(route),
              );
              if (target?.surfaceId !== undefined) {
                openPage(route);
                if (target.pluginId === "zenx-rooms")
                  void roomConversations.refresh();
              }
            }}
            onOpenSettings={() => openPage("settings")}
            onRetryThreads={() => void loadThreadSummaries(true)}
            onRenameThread={renameThread}
            onForkThread={forkThread}
            onSelectThread={(threadId) => void resumeThread(threadId)}
            pendingApprovalThreadIds={pendingThreadIds}
            pluginContributions={pluginContributions}
            selectedPage={selectedSidebarPage}
            selectedThreadId={page === "agent" ? selectedThreadId : null}
            serverStatus={serverStatus}
            projects={projects}
            onChangeProjectPinned={(key) =>
              queueSidebarOrderMutation((current) => ({
                ...current,
                pinnedProjectKeys: current.pinnedProjectKeys?.includes(key)
                  ? current.pinnedProjectKeys.filter(
                      (candidate) => candidate !== key,
                    )
                  : [...(current.pinnedProjectKeys ?? []), key],
              }))
            }
            visibleSubagentThreadIds={visibleSubagentThreadIds}
            sidebarOrder={sidebarOrder}
            pinnedThreads={pinnedSummaries}
            threadError={threadListErrors.active}
            threadLoading={!threadListLoaded.active}
            threads={activeSummaries}
          />
        </ThreadDebugMenuContext.Provider>
        <SidebarResizer
          collapsed={sidebarCollapsed}
          onCollapse={toggleSidebarCollapsed}
        />

        {projectError !== null ||
        requestError !== null ||
        draftRecoveryNotice !== null ? (
          <div className="app-notice" role="alert">
            <span>
              {draftRecoveryNotice?.message ?? projectError ?? requestError}
            </span>
            {draftRecoveryNotice !== null ? (
              <button
                type="button"
                onClick={() => {
                  invalidateThreadSelection();
                  setPage("agent");
                  selectedThreadIdRef.current = null;
                  setSelectedThreadId(null);
                  setThreadDetail(null);
                  setThreadAttachments({});
                  setThreadUsage(undefined);
                  setSelectedSettings(null);
                  setThreadError(null);
                  // Restoring over a visible welcome page keeps whatever the
                  // user already typed there under its own Project.
                  retainNewThreadDraftUnsentInput();
                  confirmNewThreadDraft(draftRecoveryNotice.draft);
                  discardRecoverableDraft();
                }}
              >
                {i18n.t("shell:restoreDraft")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (draftRecoveryNotice !== null) {
                  discardRecoverableDraft();
                  return;
                }
                setProjectError(null);
                setRequestError(null);
              }}
            >
              {i18n.t("shell:dismiss")}
            </button>
          </div>
        ) : null}

        <RoomDraftContext.Provider
          value={{
            drafts: roomDrafts,
            intentRevisions: roomIntentRevisions,
            replies: roomReplies,
            setReplies: setRoomReplies,
            setDrafts: setRoomDrafts,
            revisions: roomDraftRevisions,
          }}
        >
          <main className="workspace">
            <SettingsView
              active={page === "settings"}
              onImportSession={() => {
                setImportSessionOpen(true);
                void loadComposerCatalog();
              }}
              archivedError={threadListErrors.archived}
              archivedLoading={!threadListLoaded.archived}
              archivedThreads={archivedSummaries}
              deletedThreads={deletedThreadSummaries}
              deletedError={deletedThreadError}
              deletedLoading={deletedThreadLoading}
              onDelete={deleteArchivedThread}
              onRestoreDeleted={restoreDeletedThread}
              onRetryArchived={() => {
                void loadThreadSummaries(true);
                void loadDeletedThreads(true);
              }}
              onTabChange={setSettingsTab}
              onUnarchive={performThreadLifecycle}
              onOpenSidebar={openSidebar}
              tab={settingsTab}
              pluginSnapshot={pluginSnapshot}
              browserSettingsFocusRequest={browserSettingsFocusRequest}
              showHeader={false}
            />
            {page === "settings" ? null : genericPluginTarget !== undefined &&
              pluginSnapshot !== null ? (
              <ImZenXDraftContext.Provider value={imzenxDrafts}>
                <RoomHeaderContext.Provider
                  value={{
                    roomId: selectedRoomId,
                    element: roomHeaderTarget,
                  }}
                >
                  <PluginProductPage
                    context={
                      genericPluginTarget.pluginId === "zenx-rooms"
                        ? { primaryNavigation: true }
                        : undefined
                    }
                    snapshot={pluginSnapshot}
                    route={page}
                    navigate={openPage}
                  />
                </RoomHeaderContext.Provider>
              </ImZenXDraftContext.Provider>
            ) : (
              <AgentSurface
                debugMode={
                  debugThreadId !== null && debugThreadId === selectedThreadId
                }
                onExitDebug={exitDebugMode}
                onRecoverQueuedEdit={(threadId) => {
                  // Reuse native resume's read-only snapshot/event barrier, never resumeQueue.
                  if (
                    selectedThreadIdRef.current === threadId &&
                    newThreadDraftRef.current === null
                  )
                    void resumeThread(threadId, true);
                }}
                queueEditStore={queueEditStore}
                threadHeader={
                  selectedThreadId !== null &&
                  newThreadDraft === null &&
                  pluginSnapshot !== null &&
                  (pluginSnapshot.threadHeaders?.length ?? 0) > 0 ? (
                    <PluginThreadHeaders
                      registry={pluginUiRegistry}
                      snapshot={pluginSnapshot}
                      threadId={selectedThreadId}
                      threads={[...activeSummaries, ...archivedSummaries]}
                      navigate={openPage}
                    />
                  ) : null
                }
                onOpenMessageLink={(threadId, target) => {
                  setMessageLinkRequest({
                    ...target,
                    id: ++messageLinkSequence.current,
                    threadId,
                  });
                  setBrowserPanels((current) => ({
                    ...current,
                    [threadId]: true,
                  }));
                }}
                composerSendMode={composerSendMode}
                onComposerSendModeChange={changeComposerSendMode}
                onCancelQueued={cancelQueued}
                composerSendModeMigration={composerSendModeMigration}
                queueFailure={queueFailure}
                onSettleLegacySendChoice={settleLegacySendChoice}
                onNoticeError={setRequestError}
                approvals={approvals}
                pluginSnapshot={pluginSnapshot}
                onOpenBrowserSettings={() => {
                  setSettingsTab("general");
                  setBrowserSettingsFocusRequest((value) => value + 1);
                  openPage("settings");
                }}
                composerStates={composerStates}
                configuredProjects={configuredProjects}
                newThreadDraft={newThreadDraft}
                threadAttachments={threadAttachments}
                threadUsage={threadUsage}
                models={models}
                providerProfiles={providerProfiles}
                workflowCommands={workflowCommands}
                modelCatalogError={modelCatalogError}
                modelUpdateError={modelUpdateError}
                onDraftChange={(threadId, draft) =>
                  updateComposer(threadId, (state) =>
                    editComposer(state, draft),
                  )
                }
                onNewThreadDraftChange={(draft) =>
                  updateNewThreadDraft((current) => ({
                    ...current,
                    composer: editComposer(current.composer, draft),
                  }))
                }
                onNewThreadModelChange={changeNewThreadModel}
                onNewThreadReasoningChange={changeNewThreadReasoning}
                onNewThreadProjectChange={changeNewThreadProject}
                onAddNewThreadProject={() => openProjectPicker("new-thread")}
                onImportImages={async (threadId, files) => {
                  const imports = await Promise.all(
                    files.map(async (file) => ({
                      name: file.name,
                      mediaType: file.type,
                      bytes: new Uint8Array(await file.arrayBuffer()),
                    })),
                  );
                  const images =
                    await window.zenx.imageAttachments.import(imports);
                  updateComposer(threadId, (state) =>
                    addComposerImages(state, images),
                  );
                }}
                onImportNewThreadImages={async (files) => {
                  const draftId = newThreadDraftRef.current?.id;
                  if (draftId === undefined) return;
                  acquireNewThreadImageLease(draftId);
                  try {
                    const imports = await Promise.all(
                      files.map(async (file) => ({
                        name: file.name,
                        mediaType: file.type,
                        bytes: new Uint8Array(await file.arrayBuffer()),
                      })),
                    );
                    const images =
                      await window.zenx.imageAttachments.import(imports);
                    updateNewThreadComposer(draftId, (state) =>
                      addComposerImages(state, images),
                    );
                  } finally {
                    releaseNewThreadImageLease(draftId);
                  }
                }}
                onPickImages={async (threadId) => {
                  const images = await window.zenx.imageAttachments.pick();
                  updateComposer(threadId, (state) =>
                    addComposerImages(state, images),
                  );
                }}
                onPickNewThreadImages={async () => {
                  const draftId = newThreadDraftRef.current?.id;
                  if (draftId === undefined) return;
                  acquireNewThreadImageLease(draftId);
                  try {
                    const images = await window.zenx.imageAttachments.pick();
                    updateNewThreadComposer(draftId, (state) =>
                      addComposerImages(state, images),
                    );
                  } finally {
                    releaseNewThreadImageLease(draftId);
                  }
                }}
                onRemoveImage={(threadId, imageId) =>
                  updateComposer(threadId, (state) =>
                    removeComposerImage(state, imageId),
                  )
                }
                onRemoveNewThreadImage={(imageId) =>
                  updateNewThreadDraft((current) => ({
                    ...current,
                    composer: removeComposerImage(current.composer, imageId),
                  }))
                }
                onReadAttachment={readAttachment}
                onRetryTurn={async (turnId) => {
                  if (
                    threadDetail === null ||
                    archivingThreadIdsRef.current.has(threadDetail.id)
                  )
                    throw new Error(
                      i18n.t("shell:manualRetryNoLongerAvailable"),
                    );
                  await requestManualTurnRetry(threadDetail, turnId);
                }}
                onInterrupt={async (turnId) => {
                  if (threadDetail === null)
                    throw new Error(i18n.t("shell:noThreadSelected"));
                  await window.zenx.protocol.request("turn/interrupt", {
                    threadId: threadDetail.id,
                    turnId,
                  });
                }}
                onModelChange={(model) => void changeModel(model)}
                onPermissionChange={(mode) => void changePermission(mode)}
                onNewThreadPermissionChange={(permissionMode) =>
                  updateNewThreadDraft((draft) => ({
                    ...draft,
                    permissionMode,
                  }))
                }
                permissionError={permissionError}
                switchingPermission={switchingPermission}
                onReasoningChange={(effort) => void changeReasoning(effort)}
                onOpenSidebar={openSidebar}
                onRespondToApproval={respondToApproval}
                onCompact={compactFromContext}
                onDismissCompaction={(threadId) =>
                  updateComposer(threadId, dismissCompactionFeedback)
                }
                onSubmit={submitComposer}
                onSubmitNewThread={submitNewThreadDraft}
                selectedSettings={selectedSettings}
                selectedSummary={selectedSummary}
                serverStatus={serverStatus}
                switchingModel={switchingModel}
                threadArchiving={
                  threadDetail !== null &&
                  archivingThreadIds.has(threadDetail.id)
                }
                threadDetail={threadDetail}
                threadError={threadError}
                threadLoading={threadLoading}
              />
            )}
            {pluginSnapshot &&
            ((page === "agent" &&
              newThreadDraft === null &&
              selectedThreadId) ||
              selectedRoomId) ? (
              <PluginInformationHost
                key={
                  selectedRoomId
                    ? `room:${selectedRoomId}`
                    : `thread:${selectedThreadId}`
                }
                snapshot={pluginSnapshot}
                registry={pluginUiRegistry}
                resourcePanelWidth={workspacePanelWidth}
                owner={
                  selectedRoomId
                    ? { kind: "room", roomId: selectedRoomId }
                    : { kind: "thread", threadId: selectedThreadId! }
                }
                theme={appearance}
                navigate={openPage}
                executeCommand={window.zenx.plugins.executeCommand}
                readHandle={window.zenx.plugins.readHandle}
              />
            ) : null}
            {selectedRoom &&
            (roomSidebarState?.open ?? Boolean(roomPanel)) &&
            pluginSnapshot ? (
              <CompanionWorkspace
                primaryConversation={{
                  title: i18n.t("panels:mainConversation", {
                    title: selectedRoom.name,
                  }),
                  contentId: "primary-conversation-content",
                  onSelect: () => {
                    const owner = {
                      kind: "room" as const,
                      id: selectedRoom.id,
                    };
                    const intent =
                      sidebarState.controller.beginPresentationIntent(owner);
                    return () =>
                      sidebarState.controller.isPresentationIntentCurrent(
                        owner,
                        intent,
                      );
                  },
                }}
                key={selectedRoom.id}
                room={selectedRoom}
                presentationState={roomSidebarState}
                ephemeralTabs={sideChatDrafts
                  .entries()
                  .filter((draft) => draft.roomId === selectedRoom.id)
                  .map((draft) => ({
                    id: `side-chat-draft-${draft.id}`,
                    title: i18n.t("panels:sideChat"),
                    icon: "users" as const,
                    render: () =>
                      sideChatSelections[`room:${selectedRoom.id}`] ===
                      `custom:side-chat-draft-${draft.id}`
                        ? renderSideChatDraft(draft.id)
                        : null,
                  }))}
                localSelectedTab={sideChatSelections[`room:${selectedRoom.id}`]}
                localTabOrder={sideChatTabOrders[`room:${selectedRoom.id}`]}
                onLocalSelectTab={(tab) => {
                  sidebarState.controller.beginPresentationIntent({
                    kind: "room",
                    id: selectedRoom.id,
                  });
                  setSideChatSelections((current) => ({
                    ...current,
                    [`room:${selectedRoom.id}`]: tab.startsWith(
                      "custom:side-chat-draft-",
                    )
                      ? tab
                      : "",
                  }));
                }}
                onLocalTabsChange={(tabs) =>
                  setSideChatTabOrders((current) => ({
                    ...current,
                    [`room:${selectedRoom.id}`]: tabs,
                  }))
                }

                onFullscreenChange={(fullscreen) => {
                  void sidebarState.controller.edit(
                    { kind: "room", id: selectedRoom.id },
                    () => ({ fullscreen }),
                  );
                }}
                onRemoveTab={(id) => {
                  sidebarState.controller.beginPresentationIntent({
                    kind: "room",
                    id: selectedRoom.id,
                  });
                  if (id.startsWith("custom:side-chat-draft-")) {
                    sideChatDrafts.close(
                      id.slice("custom:side-chat-draft-".length),
                    );
                    setSideChatSelections((current) => ({
                      ...current,
                      [`room:${selectedRoom.id}`]:
                        current[`room:${selectedRoom.id}`] === id
                          ? ""
                          : (current[`room:${selectedRoom.id}`] ?? ""),
                    }));
                  } else
                    sidebarState.controller.remove(
                      { kind: "room", id: selectedRoom.id },
                      id,
                    );
                }}
                onReplaceTab={(oldId, tab) =>
                  replaceSidebarTab(
                    { kind: "room", id: selectedRoom.id },
                    oldId,
                    tab,
                  )
                }
                triggerSourceRequest={
                  triggerSourceRequest?.viewportId === selectedRoom.id
                    ? triggerSourceRequest
                    : undefined
                }
                onRenameThread={renameThread}
                renderConversation={renderSideConversation}
                viewState={
                  roomWorkspaceStates[selectedRoom.id] ?? {
                    selected: `custom:${!roomPanel || roomPanel === "open" ? "overview" : roomPanel}`,
                    tabs: [],
                    member: selectedRoom.assistant?.threadId ?? "",
                  }
                }
                onViewChange={(update) =>
                  setRoomWorkspaceStates((current) => ({
                    ...current,
                    [selectedRoom.id]: update(
                      current[selectedRoom.id] ?? {
                        selected: `custom:${!roomPanel || roomPanel === "open" ? "overview" : roomPanel}`,
                        tabs: [],
                        member: selectedRoom.assistant?.threadId ?? "",
                      },
                    ),
                  }))
                }
                fileDrafts={fileDrafts}
                onWidthChange={setWorkspacePanelWidth}
                threads={[...activeSummaries, ...archivedSummaries]}
                snapshot={pluginSnapshot}
                section={roomPanel === "open" ? "" : (roomPanel ?? "")}
                sectionRequest={roomQuery.get("request") ?? undefined}
                navigate={openPage}
                onClose={async () => {
                  await sidebarState.controller.edit(
                    { kind: "room", id: selectedRoom.id },
                    () => ({ open: false }),
                  );
                  openPage(roomConversationRoute(selectedRoom.id));
                }}
              />
            ) : null}
            {page === "agent" &&
            newThreadDraft === null &&
            threadDetail !== null &&
            selectedThreadId === threadDetail.id ? (
              <AuxiliaryPanel
                primaryConversation={{
                  title: i18n.t("panels:mainConversation", {
                    title: selectedSummary
                      ? threadTitle(selectedSummary)
                      : i18n.t("shell:currentThread"),
                  }),
                  contentId: "primary-conversation-content",
                  onSelect: () => {
                    const owner = threadDetail.id;
                    const intent =
                      sidebarState.controller.beginPresentationIntent(owner);
                    return () =>
                      sidebarState.controller.isPresentationIntentCurrent(
                        owner,
                        intent,
                      );
                  },
                }}
                threadContext={{
                  triggerSourceRequest:
                    triggerSourceRequest?.viewportId === threadDetail.id
                      ? triggerSourceRequest
                      : undefined,
                  threads: [...activeSummaries, ...archivedSummaries],
                }}
                customTabs={sideChatDrafts
                  .entries()
                  .filter(
                    (draft) =>
                      !draft.roomId && draft.parentThreadId === threadDetail.id,
                  )
                  .map((draft) => ({
                    id: `side-chat-draft-${draft.id}`,
                    title: i18n.t("panels:sideChat"),
                    icon: "users" as const,
                    render: () =>
                      browserPanels[threadDetail.id] &&
                      sideChatSelections[threadDetail.id] ===
                        `custom:side-chat-draft-${draft.id}`
                        ? renderSideChatDraft(draft.id)
                        : null,
                  }))}
                conversations={(conversationPanels[threadDetail.id] ?? []).map(
                  (threadId) => {
                    const summary = [
                      ...activeSummaries,
                      ...archivedSummaries,
                    ].find((entry) => entry.threadId === threadId);
                    return {
                      threadId,
                      title: summary
                        ? threadTitle(summary)
                        : i18n.t("shell:conversation"),
                      render: renderSideConversation,
                    };
                  },
                )}
                messageLinkRequest={
                  messageLinkRequest?.threadId === threadDetail.id
                    ? messageLinkRequest
                    : null
                }
                onMessageLinkRequestHandled={(id) =>
                  setMessageLinkRequest((current) =>
                    current?.id === id ? null : current,
                  )
                }
                navigate={openPage}
                onWidthChange={setWorkspacePanelWidth}
                fileDrafts={fileDrafts}
                workspacePath={threadDetail.cwd}
                key={threadDetail.id}
                presentationState={sidebarState.states[threadDetail.id]}
                onFullscreenChange={(fullscreen) => {
                  void sidebarState.controller.edit(threadDetail.id, () => ({
                    fullscreen,
                  }));
                }}
                onRemoveTab={(id) => {
                  sidebarState.controller.beginPresentationIntent(
                    threadDetail.id,
                  );
                  if (id.startsWith("custom:side-chat-draft-")) {
                    sideChatDrafts.close(
                      id.slice("custom:side-chat-draft-".length),
                    );
                    setSideChatSelections((current) => ({
                      ...current,
                      [threadDetail.id]: "",
                    }));
                  } else sidebarState.controller.remove(threadDetail.id, id);
                }}
                onReplaceTab={(oldId, tab) =>
                  replaceSidebarTab(
                    { kind: "thread", id: threadDetail.id },
                    oldId,
                    tab,
                  )
                }
                threadId={threadDetail.id}
                title={
                  selectedSummary === null
                    ? i18n.t("shell:currentThread")
                    : threadTitle(selectedSummary)
                }
                open={browserPanels[threadDetail.id]}
                onOpenChange={(open) =>
                  setBrowserPanels((current) => ({
                    ...current,
                    [threadDetail.id]: open,
                  }))
                }
                snapshot={pluginSnapshot}
                openedTabs={
                  sideChatTabOrders[threadDetail.id] ??
                  workspaceTabOrder[threadDetail.id]
                }
                onTabsChange={(tabs) => {
                  setSideChatTabOrders((current) => ({
                    ...current,
                    [threadDetail.id]: tabs,
                  }));
                  setWorkspaceTabOrder((current) => ({
                    ...current,
                    [threadDetail.id]: tabs.filter(
                      (id) => !id.startsWith("custom:side-chat-draft-"),
                    ),
                  }));
                }}
                selectedTab={
                  sideChatSelections[threadDetail.id] ||
                  panelTabs[threadDetail.id]
                }
                onSelectTab={(tab) => {
                  sidebarState.controller.beginPresentationIntent(
                    threadDetail.id,
                  );
                  setSideChatSelections((current) => ({
                    ...current,
                    [threadDetail.id]: tab.startsWith("custom:side-chat-draft-")
                      ? tab
                      : "",
                  }));
                  if (!tab.startsWith("custom:side-chat-draft-"))
                    setPanelTabs((current) => ({
                      ...current,
                      [threadDetail.id]: tab,
                    }));
                }}
              />
            ) : null}
          </main>
        </RoomDraftContext.Provider>

        {sideQuoteChoice &&
        sideQuoteChoice.scope === shellNavigationScope.current ? (
          <Dialog
            open
            title={i18n.t("shell:chooseSideChat")}
            restoreFocus={() => false}
            onOpenChange={(open) => {
              if (!open) setSideQuoteChoice(null);
            }}
          >
            <div className="side-chat-quote-chooser">
              <h2>{i18n.t("shell:chooseSideChat")}</h2>
              {sideQuoteTargets(
                sideQuoteChoice.parent,
                sideQuoteChoice.roomId,
              ).map((target) => (
                <button
                  type="button"
                  key={target.id}
                  onClick={() => {
                    void insertSideQuote(sideQuoteChoice, target.id).catch(
                      (error: unknown) => setRequestError(describeError(error)),
                    );
                  }}
                >
                  {target.title}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  void insertSideQuote(sideQuoteChoice).catch(
                    (error: unknown) => setRequestError(describeError(error)),
                  );
                }}
              >
                {i18n.t("shell:newSideChat")}
              </button>
            </div>
          </Dialog>
        ) : null}
        {remoteMessageSource && (
          <RemoteMessageSourceDialog
            value={remoteMessageSource}
            onClose={() => {
              sourceNavigationIntent.current++;
              setRemoteMessageSource(null);
            }}
          />
        )}
        {importSessionOpen && (
          <SessionImportDialog
            models={models}
            initialCwd={lastUsedWorkspace ?? ""}
            onClose={() => setImportSessionOpen(false)}
            onImported={async (id) => {
              await Promise.all([loadThreadSummaries(), loadProjects()]);
              await resumeThread(id, false, true);
            }}
          />
        )}
        {editingProject !== null ? (
          <ProjectEditor
            workspace={editingProject.workspace}
            name={editingProject.name}
            isDefault={projects.projects.some(
              (project) =>
                project.workspace === editingProject.workspace &&
                project.isDefault,
            )}
            hostBusy={activeSummaries.some((summary) =>
              threadHasActiveTurn(summary, threadDetail),
            )}
            onClose={() => {
              const key = projectsRef.current.projects.find(
                (project) =>
                  project.workspace ===
                  (editingProjectFocusWorkspace.current ??
                    editingProject.workspace),
              )?.key;
              setEditingProject(null);
              requestAnimationFrame(() => {
                const target =
                  document.getElementById(
                    `project-more-trigger-${encodeURIComponent(key ?? "")}`,
                  ) ?? document.getElementById("sidebar-thread-list-heading");
                target?.focus();
              });
            }}
            onSave={async (name, folder) => {
              await window.zenx.settings.editWorkspace(
                editingProject.workspace,
                name,
                folder,
              );
              editingProjectFocusWorkspace.current = folder;
              await loadProjects();
            }}
            onRemove={async () => {
              await window.zenx.settings.removeWorkspace(
                editingProject.workspace,
              );
              await loadProjects();
            }}
          />
        ) : null}
        {projectPickerIntent !== null ? (
          <DirectoryPicker
            onCancel={closeProjectPicker}
            onSelect={(workspace) => void selectProjectDirectory(workspace)}
          />
        ) : null}
      </div>
    </AppConversationProviders>
  );
  return (
    <ChildThreadSidebarContext.Provider
      value={{
        visibleSubagentThreadIds,
        setVisible: setSubagentThreadSidebarVisible,
      }}
    >
      {shell}
    </ChildThreadSidebarContext.Provider>
  );
}

export function WindowTitleBar({
  children,
  mode,
  pendingApprovalCount,
  sidebarCollapsed,
  onToggleInbox,
  onToggleSidebar,
}: {
  children?: ReactNode;
  mode: SidebarMode;
  pendingApprovalCount: number;
  sidebarCollapsed: boolean;
  onToggleInbox(): void;
  onToggleSidebar(): void;
}) {
  return (
    <header
      className="window-titlebar"
      aria-label={i18n.t("shell:zenxWindowControls")}
    >
      <div className="window-titlebar-product">
        <ZenXBrand />
        <div className="window-titlebar-inbox">
          <button
            className="icon-button inbox-button"
            type="button"
            aria-label={
              mode === "inbox"
                ? i18n.t("shell:returnToProjects")
                : i18n.t("shell:openInbox")
            }
            aria-pressed={mode === "inbox"}
            title={
              mode === "inbox"
                ? i18n.t("shell:returnToProjects")
                : i18n.t("shell:openInbox")
            }
            onClick={onToggleInbox}
          >
            <Icon name="inbox" />
            {pendingApprovalCount > 0 ? (
              <span className="inbox-dot" aria-hidden="true" />
            ) : null}
          </button>
        </div>
      </div>
      <div className="window-titlebar-native-actions">
        <button
          className="icon-button sidebar-collapse-button"
          type="button"
          aria-controls="primary-sidebar"
          aria-expanded={!sidebarCollapsed}
          aria-label={
            sidebarCollapsed
              ? i18n.t("shell:expandSidebar")
              : i18n.t("shell:collapseSidebar")
          }
          title={
            sidebarCollapsed
              ? i18n.t("shell:expandSidebar")
              : i18n.t("shell:collapseSidebar")
          }
          onClick={onToggleSidebar}
        >
          <Icon name="panel-left" />
        </button>
      </div>
      <div className="window-titlebar-session">
        <div className="window-titlebar-drag" aria-hidden="true" />
        {children}
      </div>
    </header>
  );
}

function ConversationTitleBar({
  threads,
  onNavigate,
  onOpenSidebar,
  onRename,
  onOpenSource,
  onRetryTitle,
  selectedSummary,
  sourceSummary,
  threadDetail,
  titleProjection,
}: {
  threads: readonly NativeThreadSummary[];
  onNavigate(route: string): void;
  onOpenSidebar(): void;
  onRename(title: string): Promise<void>;
  onOpenSource(threadId: string): void;
  onRetryTitle(): Promise<void>;
  selectedSummary: NativeThreadSummary;
  sourceSummary: NativeThreadSummary | undefined;
  threadDetail: Thread | null;
  titleProjection: ThreadTitleProjection | undefined;
}) {
  return (
    <div className="workspace-header">
      <div className="workspace-heading-row">
        <button
          className="icon-button mobile-menu"
          type="button"
          aria-label={i18n.t("shell:openSidebar")}
          onClick={onOpenSidebar}
        >
          <Icon name="tree" />
        </button>
        <div className="thread-heading">
          <div className="thread-title-path">
            <ThreadBreadcrumbAncestors
              threadId={selectedSummary.threadId}
              threads={threads}
              navigate={onNavigate}
            />
            <ThreadTitleEditor
              key={selectedSummary.threadId}
              editable={!selectedSummary.archived}
              editTitle={threadEditTitle(selectedSummary)}
              onRename={onRename}
              onRetry={onRetryTitle}
              projection={titleProjection}
              title={threadTitle(selectedSummary)}
            />
          </div>
          <span>
            {selectedSummary.status === "systemError"
              ? i18n.t("shell:unavailableJournal")
              : selectedSummary.currentMetadata.cwd}
            {threadDetail?.forkedFromId === null ||
            threadDetail?.forkedFromId === undefined ? null : sourceSummary ===
              undefined ? (
              <>
                {" · "}
                {i18n.t("shell:copiedFromUnavailableSource")}
              </>
            ) : (
              <>
                {" · "}
                <button
                  className="thread-source-link"
                  type="button"
                  onClick={() => onOpenSource(sourceSummary.threadId)}
                >
                  {i18n.t("shell:copiedFrom", {
                    name: threadTitle(sourceSummary),
                  })}
                </button>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function PageTitleBar({
  onOpenSidebar,
  subtitle,
  title,
  actions,
}: {
  onOpenSidebar(): void;
  subtitle: string;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="workspace-header">
      <div className="page-title">
        <button
          className="icon-button mobile-menu"
          type="button"
          aria-label={i18n.t("shell:openSidebar")}
          onClick={onOpenSidebar}
        >
          <Icon name="tree" />
        </button>
        <div>
          <h1>{title}</h1>
          {subtitle !== title ? <p>{subtitle}</p> : null}
        </div>
      </div>
      {actions}
    </div>
  );
}

function AgentSurface({
  debugMode,
  onExitDebug,
  onRecoverQueuedEdit,
  queueEditStore,
  threadHeader,
  onOpenMessageLink,
  composerSendMode,
  onComposerSendModeChange,
  onCancelQueued,
  composerSendModeMigration,
  queueFailure,
  onSettleLegacySendChoice,
  onNoticeError,
  approvals,
  pluginSnapshot,
  onOpenBrowserSettings,
  composerStates,
  configuredProjects,
  newThreadDraft,
  threadAttachments,
  threadUsage,
  models,
  providerProfiles,
  workflowCommands,
  modelCatalogError,
  modelUpdateError,
  onDraftChange,
  onImportImages,
  onImportNewThreadImages,
  onPickImages,
  onPickNewThreadImages,
  onReadAttachment,
  onRemoveImage,
  onRemoveNewThreadImage,
  onNewThreadDraftChange,
  onNewThreadModelChange,
  onNewThreadReasoningChange,
  onNewThreadProjectChange,
  onAddNewThreadProject,
  onInterrupt,
  onRetryTurn,
  onModelChange,
  onPermissionChange,
  onNewThreadPermissionChange,
  permissionError,
  switchingPermission,
  onReasoningChange,
  onOpenSidebar,
  onRespondToApproval,
  onCompact,
  onDismissCompaction,
  onSubmit,
  onSubmitNewThread,
  selectedSettings,
  selectedSummary,
  serverStatus,
  switchingModel,
  threadArchiving,
  threadDetail,
  threadError,
  threadLoading,
}: {
  debugMode: boolean;
  onExitDebug(): void;
  onRecoverQueuedEdit(threadId: string): void;
  queueEditStore: QueueEditStore;
  onOpenMessageLink(
    threadId: string,
    target: { kind: "file" | "browser"; value: string },
  ): void;
  composerSendMode: "batch" | "queue" | "soft" | "hard";
  onComposerSendModeChange(
    mode: "batch" | "queue" | "soft" | "hard",
  ): Promise<void>;
  onCancelQueued(
    threadId: string,
    targets: readonly QueuedCancellationTarget[],
  ): Promise<{ results: QueuedCancellationResult[] }>;
  composerSendModeMigration: ZenXHostProfile["composerSendModeMigration"];
  queueFailure: Extract<AppServerEvent, { type: "queue_failed" }> | null;
  onSettleLegacySendChoice(restoreQueue: boolean): Promise<void>;
  onNoticeError(message: string): void;
  approvals: ApprovalCardState[];
  pluginSnapshot: ZenXPluginSnapshot | null;
  onOpenBrowserSettings(): void;
  composerStates: Record<string, ComposerState>;
  configuredProjects: ZenXProjectProjectionEntry[];
  newThreadDraft: NewThreadDraft | null;
  threadAttachments: ZenXThreadAttachmentProjection;
  threadUsage: ModelUsageProjection | undefined;
  models: ModelSummary[];
  providerProfiles: ZenXProviderProfile[];
  workflowCommands: WorkflowCommand[];
  modelCatalogError: string | null;
  modelUpdateError: string | null;
  onDraftChange(threadId: string, draft: string): void;
  onImportImages(threadId: string, files: readonly File[]): Promise<void>;
  onImportNewThreadImages(files: readonly File[]): Promise<void>;
  onPickImages(threadId: string): Promise<void>;
  onPickNewThreadImages(): Promise<void>;
  onReadAttachment(
    attachment: import("../../../../../src/attachment.js").AttachmentRef,
  ): Promise<Uint8Array>;
  onRemoveImage(threadId: string, imageId: string): void;
  onRemoveNewThreadImage(imageId: string): void;
  onNewThreadDraftChange(draft: string): void;
  onNewThreadModelChange(model: string): void;
  onNewThreadReasoningChange(effort: string): void;
  onNewThreadProjectChange(workspace: string | null): void;
  onAddNewThreadProject(): void;
  onInterrupt(turnId: string): Promise<void>;
  onRetryTurn(turnId: string): Promise<void>;
  onPermissionChange(mode: FilePermissionMode): void;
  onNewThreadPermissionChange(mode: FilePermissionMode): void;
  permissionError: string | null;
  switchingPermission: boolean;
  onModelChange(model: string): void;
  onReasoningChange(effort: string): void;
  onOpenSidebar(): void;
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  onCompact(): Promise<void>;
  onDismissCompaction(threadId: string): void;
  onSubmit(
    intent: ComposerIntent,
    expectedTurnId: string | null,
    clientObservation?: ClientSendObservation,
  ): Promise<void>;
  onSubmitNewThread(
    intent: ComposerIntent,
    expectedTurnId: string | null,
    clientObservation?: ClientSendObservation,
  ): Promise<void>;
  selectedSettings: SelectedThreadSettings | null;
  selectedSummary: NativeThreadSummary | null;
  threadHeader?: ReactNode;
  serverStatus: AppServerHostStatus;
  switchingModel: boolean;
  threadArchiving: boolean;
  threadDetail: Thread | null;
  threadError: string | null;
  threadLoading: boolean;
}) {
  const draftSettings =
    newThreadDraft?.settings ?? defaultDraftSettings(models);
  const draftProject =
    newThreadDraft === null
      ? undefined
      : configuredProjects.find(
          (project) => project.workspace === newThreadDraft.workspace,
        );
  const draftProjectError =
    newThreadDraft?.workspace !== null &&
    newThreadDraft !== null &&
    draftProject === undefined
      ? i18n.t("shell:thisProjectIsNoLongerAvailableChooseAnotherProject")
      : null;
  return (
    <section
      id="primary-conversation-content"
      className={`agent-surface${newThreadDraft === null ? "" : " new-thread-draft-surface"}${threadHeader ? " has-thread-header" : ""}`}
    >
      {threadHeader}
      <AgentReadinessNotice
        pluginSnapshot={pluginSnapshot}
        onOpenBrowserSettings={onOpenBrowserSettings}
      />
      {newThreadDraft !== null || selectedSummary === null ? (
        <button
          className="icon-button mobile-menu new-thread-draft-mobile"
          type="button"
          aria-label={i18n.t("shell:openSidebar")}
          onClick={onOpenSidebar}
        >
          <Icon name="tree" />
        </button>
      ) : null}

      {serverStatus.type === "error" ? (
        <EmptyState
          error
          title={i18n.t("shell:zenAppServerStopped")}
          detail={serverStatus.message}
        />
      ) : serverStatus.type !== "ready" ? (
        <EmptyState
          loading={
            serverStatus.type === "starting" ||
            serverStatus.type === "reconnecting"
          }
          title={
            serverStatus.type === "starting"
              ? i18n.t("shell:startingZenAppServer")
              : serverStatus.type === "reconnecting"
                ? i18n.t("shell:reconnectingToZenAppServer")
                : i18n.t("shell:zenAppServerDisconnected")
          }
          detail={i18n.t(
            "shell:yourDraftIsPreservedWhileZenxReconnectsToTheLocalRuntime",
          )}
        />
      ) : threadLoading ? (
        <EmptyState
          loading
          title={i18n.t("shell:loadingConversation")}
          detail={i18n.t("shell:reconstructingThread")}
        />
      ) : threadError !== null ? (
        <EmptyState
          error
          title={i18n.t("shell:couldNotOpenConversation")}
          detail={threadError}
        />
      ) : newThreadDraft !== null ? (
        <FleetComposerSurface
          key={newThreadDraft.id}
          text={newThreadDraft.composer.draft.text}
          onTextChange={onNewThreadDraftChange}
          attachmentCount={newThreadDraft.composer.draft.images.length}
          onNotice={onNoticeError}
          disabled={newThreadDraft.composer.submission?.status === "pending"}
        >
          {(machineControl) => (
            <ThreadView
              approvals={[]}
              composerContextPosition="after"
              composer={newThreadDraft.composer}
              composerSendMode={composerSendMode}
              onComposerSendModeChange={onComposerSendModeChange}
              composerContext={
                <div className="new-thread-composer-context">
                  {machineControl}
                  <NewThreadProjectSelector
                    variant="chip"
                    disabled={
                      newThreadDraft.composer.submission?.status === "pending"
                    }
                    onAddProject={onAddNewThreadProject}
                    onChange={onNewThreadProjectChange}
                    projects={configuredProjects}
                    selectedWorkspace={newThreadDraft.workspace}
                  />
                </div>
              }
              emptyContent={
                <div className="thread-empty new-thread-draft-empty">
                  <div
                    className="new-thread-draft-heading"
                    role="heading"
                    aria-level={2}
                  >
                    {i18n.t("shell:whatShouldWeBuildInStart")}{" "}
                    <NewThreadProjectSelector
                      disabled={
                        newThreadDraft.composer.submission?.status === "pending"
                      }
                      onAddProject={onAddNewThreadProject}
                      onChange={onNewThreadProjectChange}
                      projects={configuredProjects}
                      selectedWorkspace={newThreadDraft.workspace}
                    />
                    {i18n.t("shell:whatShouldWeBuildInEnd")}
                  </div>
                </div>
              }
              imageCapabilityError={imageCapabilityMessage(
                providerProfiles,
                draftSettings,
                models,
              )}
              imageCapabilityNotice={imageCapabilityNotice(
                providerProfiles,
                draftSettings,
                models,
              )}
              modelDisabled={
                newThreadDraft.composer.submission?.status === "pending"
              }
              modelError={
                draftProjectError ?? modelUpdateError ?? modelCatalogError
              }
              models={models}
              providerProfiles={providerProfiles}
              permissionMode={
                newThreadDraft.permissionMode ?? "danger-full-access"
              }
              onPermissionChange={onNewThreadPermissionChange}
              selectedModel={draftSettings?.model}
              selectedReasoningEffort={draftSettings?.reasoningEffort}
              thread={null}
              workflowCommands={workflowCommands}
              onDraftChange={onNewThreadDraftChange}
              onImportImages={onImportNewThreadImages}
              onPickImages={onPickNewThreadImages}
              onReadAttachment={onReadAttachment}
              onRemoveImage={onRemoveNewThreadImage}
              onInterrupt={async () => undefined}
              onModelChange={onNewThreadModelChange}
              onReasoningChange={onNewThreadReasoningChange}
              onRespondToApproval={onRespondToApproval}
              onSubmit={onSubmitNewThread}
            />
          )}
        </FleetComposerSurface>
      ) : selectedSummary === null || threadDetail === null ? null : (
        <>
          <ThreadView
            localModelDebug
            debugMode={debugMode}
            onExitDebug={onExitDebug}
            composerSendMode={composerSendMode}
            onComposerSendModeChange={onComposerSendModeChange}
            onOpenMessageLink={(target) => {
              onOpenMessageLink(threadDetail.id, target);
            }}
            onCancelQueued={(targets) =>
              onCancelQueued(threadDetail.id, targets)
            }
            queueEditStore={queueEditStore}
            onSteerQueued={(params) =>
              requestQueuedSteer(params, () =>
                onRecoverQueuedEdit(params.threadId),
              )
            }
            onEditQueued={(params) =>
              requestQueuedEdit(params, () =>
                onRecoverQueuedEdit(params.threadId),
              )
            }
            onImportQueueImages={importQueuedImages}
            onPickQueueImages={() => window.zenx.imageAttachments.pick()}
            composerContext={
              composerSendModeMigration?.acknowledged === false &&
              composerSendMode === "soft" ? (
                <div className="composer-migration-notice" role="status">
                  <p>{i18n.t("shell:olderQueuePreference")}</p>
                  <button
                    type="button"
                    onClick={() =>
                      void onSettleLegacySendChoice(true).catch(
                        (error: unknown) => onNoticeError(describeError(error)),
                      )
                    }
                  >
                    {i18n.t("shell:restorePerMessageQueue")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void onSettleLegacySendChoice(false).catch(
                        (error: unknown) => onNoticeError(describeError(error)),
                      )
                    }
                  >
                    {i18n.t("shell:keepSteer")}
                  </button>
                </div>
              ) : null
            }
            queueFailure={
              queueFailure?.threadId === threadDetail.id &&
              threadDetail.queuedMessages?.some(
                (item) =>
                  item.id === queueFailure.queuedItemId &&
                  item.clientId === queueFailure.clientId &&
                  (item.revision ?? 0) === (queueFailure.revision ?? 0),
              )
                ? queueFailure
                : null
            }
            onResumeQueue={async () => {
              await window.zenx.protocol.request("turn/queue/resume", {
                threadId: threadDetail.id,
              });
            }}
            approvals={approvals.filter(
              (approval) => approval.params.threadId === threadDetail.id,
            )}
            composer={composerStates[threadDetail.id] ?? emptyComposerState()}
            composerDisabled={threadArchiving}
            imageCapabilityError={imageCapabilityMessage(
              providerProfiles,
              selectedSettings,
              models,
            )}
            imageCapabilityNotice={imageCapabilityNotice(
              providerProfiles,
              selectedSettings,
              models,
            )}
            modelDisabled={!canChangeThreadModel(threadDetail)}
            modelError={
              modelUpdateError ??
              modelCatalogError ??
              unavailableSelectionMessage(
                models,
                providerProfiles,
                selectedSettings,
              )
            }
            models={models}
            providerProfiles={providerProfiles}
            permissionLabel={
              selectedSettings === null
                ? null
                : selectedSettings.permissionMode === "danger-full-access" &&
                    selectedSettings.approvalPolicy === "on-request"
                  ? i18n.t("shell:approvalRequired")
                  : i18n.t("shell:filePermissions")
            }
            permissionMode={
              selectedSettings?.permissionMode ?? "danger-full-access"
            }
            permissionError={permissionError}
            switchingPermission={switchingPermission}
            onPermissionChange={onPermissionChange}
            selectedModel={selectedSettings?.model}
            selectedReasoningEffort={selectedSettings?.reasoningEffort}
            switchingModel={switchingModel}
            thread={threadDetail}
            pluginSnapshot={pluginSnapshot}
            pluginUiRegistry={pluginUiRegistry}
            threadAttachments={threadAttachments}
            threadUsage={threadUsage}
            wakeups={[]}
            watching={false}
            workflowCommands={workflowCommands}
            onDraftChange={(draft) => onDraftChange(threadDetail.id, draft)}
            onImportImages={(files) => onImportImages(threadDetail.id, files)}
            onPickImages={() => onPickImages(threadDetail.id)}
            onReadAttachment={onReadAttachment}
            onRemoveImage={(imageId) => onRemoveImage(threadDetail.id, imageId)}
            onRetryTurn={onRetryTurn}
            onInterrupt={onInterrupt}
            onModelChange={onModelChange}
            onReasoningChange={onReasoningChange}
            onRespondToApproval={onRespondToApproval}
            onCompact={onCompact}
            onDismissCompaction={() => onDismissCompaction(threadDetail.id)}
            onSubmit={onSubmit}
          />
        </>
      )}
    </section>
  );
}

function NewThreadProjectSelector({
  disabled,
  onAddProject,
  onChange,
  projects,
  selectedWorkspace,
  variant = "heading",
}: {
  disabled: boolean;
  onAddProject(): void;
  onChange(workspace: string | null): void;
  projects: readonly ZenXProjectProjectionEntry[];
  selectedWorkspace: string | null;
  /** "heading" is the inline underlined name in the welcome sentence;
   * "chip" is the Composer-context trigger that matches the machine
   * switcher. Both open the same searchable Project popover. */
  variant?: "heading" | "chip";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popoverLayout, setPopoverLayout] = useState<{
    placement: "above" | "below";
    maxHeight: number;
    offsetX: number;
  }>({ placement: "above", maxHeight: 360, offsetX: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);
  const popoverId = useId();
  const selectedProject = projects.find(
    (project) => project.workspace === selectedWorkspace,
  );
  const selectedLabel =
    selectedWorkspace === null
      ? i18n.t("shell:noProject")
      : selectedProject === undefined
        ? i18n.t("shell:projectUnavailable", {
            project: projectLabel(selectedWorkspace),
          })
        : projectDisplayLabel(selectedProject.workspace, projects);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProjects = projects.filter((project) => {
    if (normalizedQuery.length === 0) return true;
    return `${projectDisplayLabel(project.workspace, projects)} ${project.workspace}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });

  const closeMenu = (restoreFocus: boolean) => {
    restoreFocusRef.current = restoreFocus;
    setOpen(false);
    setQuery("");
  };

  useLayoutEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (!open || variant === "chip") return;
    const updatePopoverLayout = () => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      const clippingRect = trigger
        .closest<HTMLElement>(".messages")
        ?.getBoundingClientRect();
      const viewportMargin = 16;
      const triggerGap = 12;
      const preferredHeight = 360;
      const preferredWidth = 286;
      const comfortableHeight = 240;
      const topLimit = Math.max(
        viewportMargin,
        (clippingRect?.top ?? 0) + viewportMargin,
      );
      const bottomLimit = Math.min(
        window.innerHeight - viewportMargin,
        (clippingRect?.bottom ?? window.innerHeight) - viewportMargin,
      );
      const availableAbove = Math.max(0, rect.top - topLimit - triggerGap);
      const availableBelow = Math.max(
        0,
        bottomLimit - rect.bottom - triggerGap,
      );
      const placement =
        availableAbove >= Math.min(preferredHeight, comfortableHeight) ||
        availableAbove >= availableBelow
          ? "above"
          : "below";
      const available = placement === "above" ? availableAbove : availableBelow;
      const popoverWidth = Math.min(
        preferredWidth,
        Math.max(0, window.innerWidth - viewportMargin * 2),
      );
      const triggerCenter = rect.left + rect.width / 2;
      const halfPopoverWidth = popoverWidth / 2;
      const clampedCenter = Math.min(
        window.innerWidth - viewportMargin - halfPopoverWidth,
        Math.max(viewportMargin + halfPopoverWidth, triggerCenter),
      );
      const next = {
        placement,
        maxHeight: Math.floor(Math.min(preferredHeight, available)),
        offsetX: Math.round(clampedCenter - triggerCenter),
      } as const;
      setPopoverLayout((current) =>
        current.placement === next.placement &&
        current.maxHeight === next.maxHeight &&
        current.offsetX === next.offsetX
          ? current
          : next,
      );
    };
    updatePopoverLayout();
    window.addEventListener("resize", updatePopoverLayout);
    window.addEventListener("scroll", updatePopoverLayout, true);
    return () => {
      window.removeEventListener("resize", updatePopoverLayout);
      window.removeEventListener("scroll", updatePopoverLayout, true);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) closeMenu(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => searchRef.current?.focus());
    // The Composer-context chip is a portaled Radix Popover: Radix already
    // owns outside interaction and Escape; manual listeners would close it
    // before a portal click reaches its target.
    if (variant === "chip") return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      const focusWasInPopover = rootRef.current?.contains(
        document.activeElement,
      );
      closeMenu(Boolean(focusWasInPopover && !isFocusableTarget(event.target)));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const focusProject = (direction: "first" | "selected") => {
    const selected = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"]',
    );
    (direction === "selected" ? (selected ?? first) : first)?.focus();
  };

  const trigger = (
    <button
      ref={triggerRef}
      className={`new-thread-project-trigger${
        variant === "chip" ? " new-thread-project-trigger-chip" : ""
      }`}
      type="button"
      aria-controls={open ? popoverId : undefined}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={
        selectedWorkspace === null
          ? i18n.t("shell:chooseProject")
          : i18n.t("shell:changeCurrentProject", {
              project: selectedWorkspace,
            })
      }
      disabled={disabled}
      title={
        selectedWorkspace === null
          ? i18n.t("shell:projectlessDirectoryHint")
          : variant === "chip"
            ? selectedWorkspace
            : undefined
      }
      onClick={() => {
        if (variant === "chip") return;
        if (open) closeMenu(false);
        else setOpen(true);
      }}
    >
      {variant === "chip" ? (
        <>
          <Icon name="folder" size={13} />
          <span>{selectedLabel}</span>
        </>
      ) : (
        selectedLabel
      )}
    </button>
  );

  const popoverContent = (
    <>
      <label className="new-thread-project-search">
        <Icon name="search" size={13} />
        <span className="sr-only">{i18n.t("shell:searchProjects")}</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder={i18n.t("shell:searchProjects")}
          aria-label={i18n.t("shell:searchProjects")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            focusProject(event.key === "ArrowUp" ? "selected" : "first");
          }}
        />
      </label>
      <div
        ref={menuRef}
        className="new-thread-project-menu"
        role="menu"
        aria-label={i18n.t("shell:chooseAProject")}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          const options = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="menuitemradio"]',
            ),
          );
          if (options.length === 0) return;
          event.preventDefault();
          const currentIndex = options.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const nextIndex =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? options.length - 1
                : currentIndex === -1
                  ? event.key === "ArrowUp"
                    ? options.length - 1
                    : 0
                  : event.key === "ArrowUp"
                    ? (currentIndex - 1 + options.length) % options.length
                    : (currentIndex + 1) % options.length;
          options[nextIndex]?.focus();
        }}
      >
        {normalizedQuery.length === 0 ||
        i18n
          .t("shell:noProject")
          .toLocaleLowerCase()
          .includes(normalizedQuery) ? (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selectedWorkspace === null}
            title={i18n.t("shell:projectlessDirectoryHint")}
            onClick={() => {
              onChange(null);
              closeMenu(true);
            }}
          >
            <Icon name="folder" size={13} />
            <span>{i18n.t("shell:noProject")}</span>
            {selectedWorkspace === null ? (
              <Icon name="check" size={13} />
            ) : null}
          </button>
        ) : null}
        {filteredProjects.map((project) => {
          const selected = project.workspace === selectedWorkspace;
          return (
            <button
              key={project.key}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              aria-label={`${selected ? i18n.t("shell:selectedProject") : i18n.t("shell:selectProject")}: ${project.workspace}`}
              title={project.workspace}
              onClick={() => {
                onChange(project.workspace);
                closeMenu(true);
              }}
            >
              <Icon name="folder" size={13} />
              <span>{projectDisplayLabel(project.workspace, projects)}</span>
              {selected ? <Icon name="check" size={13} /> : null}
            </button>
          );
        })}
        {filteredProjects.length === 0 ? (
          <p className="new-thread-project-empty">
            {i18n.t("shell:noProjectsFound")}
          </p>
        ) : null}
      </div>
      <div className="new-thread-project-actions">
        <div className="new-thread-project-separator" role="separator" />
        <button
          className="new-thread-project-add"
          type="button"
          onClick={() => {
            closeMenu(false);
            onAddProject();
          }}
        >
          <Icon name="folder-plus" size={13} />
          <span>{i18n.t("shell:addProject")}</span>
        </button>
      </div>
    </>
  );

  if (variant === "chip")
    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else closeMenu(true);
        }}
      >
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          className="new-thread-project-popover-portal"
          align="center"
          side="top"
          sideOffset={8}
          id={popoverId}
          role="dialog"
          aria-label={i18n.t("shell:switchProject")}
        >
          {popoverContent}
        </PopoverContent>
      </Popover>
    );

  return (
    <div className="new-thread-project-switcher" ref={rootRef}>
      {trigger}
      {open ? (
        <div
          className="new-thread-project-popover"
          data-placement={popoverLayout.placement}
          id={popoverId}
          role="dialog"
          aria-label={i18n.t("shell:switchProject")}
          style={{
            maxHeight: `${popoverLayout.maxHeight}px`,
            transform: `translateX(calc(-50% + ${popoverLayout.offsetX}px))`,
          }}
          onBlur={(event) => {
            const nextFocus = event.relatedTarget;
            if (
              !(nextFocus instanceof Node) ||
              !event.currentTarget.contains(nextFocus)
            ) {
              closeMenu(false);
            }
          }}
        >
          {popoverContent}
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  title,
  detail,
  action,
  loading = false,
  error = false,
  actionLabel = i18n.t("shell:newThread"),
  actionIcon = "compose",
}: {
  title: string;
  detail: string;
  action?: () => void;
  loading?: boolean;
  error?: boolean;
  actionLabel?: string;
  actionIcon?: "compose" | "folder";
}) {
  return (
    <section
      className={`empty-canvas${error ? " error" : ""}`}
      role={error ? "alert" : undefined}
    >
      {loading ? (
        <div className="loading-ring" />
      ) : (
        <div className="empty-glyph">
          <Icon name={error ? "warning" : "compose"} size={20} />
        </div>
      )}
      <h2>{title}</h2>
      <p>{detail}</p>
      {action === undefined ? null : (
        <button className="primary-button" type="button" onClick={action}>
          <Icon name={actionIcon} />
          {actionLabel}
        </button>
      )}
    </section>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableSelectionMessage(
  models: readonly ModelSummary[],
  providerProfiles: readonly ZenXProviderProfile[],
  settings: SelectedThreadSettings | null,
): string | null {
  if (
    models.length === 0 ||
    settings === null ||
    canSendWithModel(models, settings.model)
  )
    return null;
  const provider = providerProfiles.find(
    (candidate) => candidate.providerProfileId === settings.modelProvider,
  );
  return provider === undefined
    ? i18n.t("shell:providerProfileDeleted", {
        provider: settings.modelProvider,
      })
    : i18n.t("shell:configuredModelUnavailable", {
        provider: provider.displayName,
      });
}

function defaultDraftSettings(
  models: readonly ModelSummary[],
): SelectedThreadSettings | null {
  const model = models.find(
    (candidate) => candidate.isDefault && !candidate.hidden,
  );
  if (model === undefined) return null;
  let modelProvider = model.model;
  try {
    modelProvider = decodeModelKey(model.id).providerProfileId;
  } catch {
    // Preserve compatibility with legacy model catalogs that used unencoded ids.
  }
  return {
    threadId: "",
    permissionMode: "danger-full-access",
    approvalPolicy: "never",
    model: model.id,
    modelProvider,
    reasoningEffort: model.defaultReasoningEffort,
  };
}

function draftSettingsForModel(
  models: readonly ModelSummary[],
  modelId: string,
  current: SelectedThreadSettings | null,
): SelectedThreadSettings | null {
  const model = models.find(
    (candidate) => candidate.id === modelId && !candidate.hidden,
  );
  if (model === undefined) return null;
  let modelProvider = model.model;
  try {
    modelProvider = decodeModelKey(model.id).providerProfileId;
  } catch {
    // Preserve compatibility with legacy model catalogs that used unencoded ids.
  }
  const reasoningEffort = model.supportedReasoningEfforts.some(
    (candidate) => candidate.reasoningEffort === current?.reasoningEffort,
  )
    ? current!.reasoningEffort
    : model.defaultReasoningEffort;
  return {
    threadId: "",
    permissionMode: "danger-full-access",
    approvalPolicy: "never",
    model: model.id,
    modelProvider,
    reasoningEffort,
  };
}

function projectLabel(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace;
}

export function optimisticThreadSummary(
  result: {
    thread: Thread;
    model: string;
    modelProvider: string;
    cwd: string;
    approvalPolicy: "never" | "on-request";
    sandbox: import("../../protocol-client/types.js").FileSandboxPolicy;
  },
  preview: string,
): ThreadSummary {
  const draft = parseSkillDraft(preview);
  return {
    threadId: result.thread.id,
    currentMetadata: {
      model: result.model,
      provider: result.modelProvider,
      cwd: result.cwd,
      sandbox: permissionModeFromPolicy(result.sandbox),
      approvalPolicy:
        result.approvalPolicy === "on-request" ? "always" : "never",
    },
    archived: false,
    createdAt: new Date(result.thread.createdAt * 1_000).toISOString(),
    updatedAt: new Date(result.thread.updatedAt * 1_000).toISOString(),
    name: result.thread.name ?? i18n.t("shell:newThread"),
    preview: referenceTitle(draft.text, draft.references),
    status: "idle",
  };
}

export function acquireDraftPromotionLease(
  leases: Map<string, number>,
  draftId: string,
): void {
  leases.set(draftId, (leases.get(draftId) ?? 0) + 1);
}

export function releaseDraftPromotionLease(
  leases: Map<string, number>,
  promotions: Map<string, string>,
  draftId: string,
): void {
  const remaining = (leases.get(draftId) ?? 1) - 1;
  if (remaining > 0) {
    leases.set(draftId, remaining);
    return;
  }
  leases.delete(draftId);
  promotions.delete(draftId);
}

function projectDisplayLabel(
  workspace: string,
  projects: readonly ZenXProjectProjectionEntry[],
): string {
  const leaf =
    projects.find((project) => project.workspace === workspace)?.name ??
    projectLabel(workspace);
  const ambiguous = projects.some(
    (project) =>
      project.workspace !== workspace &&
      (project.name ?? projectLabel(project.workspace)) === leaf,
  );
  if (!ambiguous) return leaf;
  const normalized = workspace.replace(/[\\/]+$/u, "");
  const parent = normalized.replace(/[\\/][^\\/]+$/u, "") || workspace;
  return `${leaf} — ${parent}`;
}

function isFocusableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Node) || target.nodeType !== Node.ELEMENT_NODE)
    return false;
  return (
    (target as Element).closest(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) !== null
  );
}

async function composerSubmissionInput(
  submission: ComposerSubmission,
): Promise<import("../../protocol-client/index.js").UserInputPart[]> {
  const input: import("../../protocol-client/index.js").UserInputPart[] = [];
  if (submission.text.length > 0)
    input.push({ type: "text", text: submission.text });
  for (const image of submission.images) {
    input.push({ type: "attachment", attachment: image.attachment });
  }
  return input;
}
