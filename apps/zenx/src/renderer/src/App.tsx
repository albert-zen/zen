import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
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
  ZenXProviderProfile,
  ZenXSidebarOrder,
} from "../../main/host-profile.js";
import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "../../main/thread-title-types.js";
import type {
  ModelSummary,
  ServerNotificationParams,
  Thread,
} from "../../protocol-client/index.js";
import { decodeModelKey } from "../../../../../src/protocol/codex/model-key.js";
import {
  addApprovalRequest,
  markApprovalResponding,
  pendingApprovalThreadIds,
  resolveApproval,
  restoreApprovalPending,
  type ApprovalCardState,
} from "./approval-state.js";
import {
  acceptComposerSubmission,
  addComposerImages,
  beginComposerSubmission,
  editComposer,
  emptyComposerState,
  failComposerSubmission,
  removeComposerImage,
  type ComposerIntent,
  type ComposerState,
  type ComposerSubmission,
} from "./composer-state.js";
import { Icon } from "./icons.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import {
  applySettingsMirror,
  canSendWithModel,
  canChangeThreadModel,
  modelChangeRequest,
  imageCapabilityMessage,
  imageCapabilityNotice,
  reasoningChangeRequest,
  settingsFromSnapshot,
  validateModelCatalog,
  type SelectedThreadSettings,
} from "./model-settings.js";
import { loadedPluginContributions } from "./plugin-contributions.js";
import {
  PluginAgentPanels,
  PluginProductPage,
  pluginUiRegistry,
} from "./PluginProductPage.js";
import { SettingsView, type SettingsTab } from "./SettingsView.js";
import { Sidebar } from "./Sidebar.js";
import {
  derivePinnedThreads,
  EMPTY_SIDEBAR_ORDER,
  readSidebarMode,
  threadHasActiveTurn,
  lastUsedProjectWorkspace,
  moveSidebarProject,
  moveSidebarThread,
  threadTitle,
  writeSidebarMode,
  type SidebarMode,
} from "./thread-list.js";
import { applyThreadViewNotification } from "./thread-view-state.js";
import { ThreadView, usageLabel } from "./ThreadView.js";
import { ZenXBrand } from "./ZenXBrand.js";

type ProductPage = string;
const MODEL_CATALOG_LOADING = "Models are still loading. Try again.";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "zenx.sidebar-collapsed";

interface NewThreadDraft {
  id: string;
  workspace: string | null;
  composer: ComposerState;
}

export function App() {
  const selectionEpoch = useRef(0);
  const newThreadPendingRef = useRef(false);
  const newThreadDraftRef = useRef<NewThreadDraft | null>(null);
  const newThreadPendingDraftRef = useRef<NewThreadDraft | null>(null);
  const newThreadPromotionsRef = useRef(new Map<string, string>());
  const newThreadImageLeasesRef = useRef(new Map<string, number>());
  const projectPickerOperationEpoch = useRef(0);
  const projectPickerPendingRef = useRef(false);
  const projectPickerIntentRef = useRef<"add-project" | "new-thread" | null>(
    null,
  );
  const threadUsageLoadEpoch = useRef(0);
  const threadSummaryLoadEpoch = useRef(0);
  const projectLoadEpoch = useRef(0);
  const projectsRef = useRef<ZenXProjectProjectionSnapshot>({
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  const selectedThreadIdRef = useRef<string | null>(null);
  const archivingThreadIdsRef = useRef<ReadonlySet<string>>(new Set());
  const composerStatesRef = useRef<Record<string, ComposerState>>({});
  const pinnedThreadIdsRef = useRef<string[]>([]);
  const sidebarOrderRef = useRef<ZenXSidebarOrder>(EMPTY_SIDEBAR_ORDER);
  const profilePreferenceQueueRef = useRef<Promise<void>>(Promise.resolve());
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
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
  const [sidebarOrder, setSidebarOrder] =
    useState<ZenXSidebarOrder>(EMPTY_SIDEBAR_ORDER);
  const [archivedThreadSummaries, setArchivedThreadSummaries] = useState<
    NativeThreadSummary[]
  >([]);
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
  const [modelUpdateError, setModelUpdateError] = useState<string | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    try {
      return readSidebarMode(window.localStorage);
    } catch {
      return "projects";
    }
  });
  const [requestError, setRequestError] = useState<string | null>(null);
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

  const confirmPinnedThreadIds = (threadIds: readonly string[]) => {
    const confirmed = [...threadIds];
    pinnedThreadIdsRef.current = confirmed;
    setPinnedThreadIds(confirmed);
  };

  const confirmSidebarOrder = (order: ZenXSidebarOrder) => {
    const confirmed = {
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
    sidebarOrder: ZenXSidebarOrder;
  }) => {
    confirmPinnedThreadIds(profile.pinnedThreadIds);
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
    selectionEpoch.current += 1;
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
    try {
      await window.zenx.settings.addWorkspace(workspace);
      if (projectPickerOperationEpoch.current !== epoch) return;
      await loadProjects();
      if (projectPickerOperationEpoch.current !== epoch) return;
      closeProjectPicker();
      if (intent === "new-thread") {
        const draft = newThreadDraftRef.current;
        if (draft === null) openNewThreadDraft(workspace);
        else {
          setModelUpdateError(null);
          confirmNewThreadDraft({
            ...draft,
            workspace,
            composer: {
              ...draft.composer,
              submission:
                draft.composer.submission?.status === "failed"
                  ? null
                  : draft.composer.submission,
            },
          });
        }
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
            `Thread usage could not be loaded: ${describeError(error)}`,
          );
      });
  };

  const resumeThread = async (threadId: string, preserveNavigation = false) => {
    discardRecoverableDraft();
    const epoch = ++selectionEpoch.current;
    confirmNewThreadDraft(null);
    const usageEpoch = ++threadUsageLoadEpoch.current;
    selectedThreadIdRef.current = threadId;
    if (!preserveNavigation) {
      setPage("agent");
      setSidebarOpen(false);
      setWorkspaceOpen(false);
    }
    setSelectedThreadId(threadId);
    setThreadDetail(null);
    setThreadAttachments({});
    setThreadUsage(undefined);
    setSelectedSettings(null);
    setModelUpdateError(null);
    setThreadLoading(true);
    setThreadError(null);
    void loadComposerCatalog();
    try {
      const [result, attachments, usage] = await Promise.all([
        window.zenx.protocol.request("thread/resume", { threadId }),
        window.zenx.imageAttachments.forThread(threadId),
        window.zenx.modelUsage.forThread(threadId),
      ]);
      if (selectionEpoch.current !== epoch) return;
      setThreadDetail(result.thread);
      setThreadAttachments(attachments);
      if (threadUsageLoadEpoch.current === usageEpoch) setThreadUsage(usage);
      setSelectedSettings(settingsFromSnapshot(result.thread.id, result));
      void window.zenx.settings
        .markWorkspaceUsed(result.thread.cwd)
        .then(() => loadProjects())
        .catch(() => undefined);
    } catch (error) {
      if (selectionEpoch.current === epoch)
        setThreadError(describeError(error));
    } finally {
      if (selectionEpoch.current === epoch) setThreadLoading(false);
    }
  };

  const loadComposerCatalog = async () => {
    const [result, settings] = await Promise.allSettled([
      window.zenx.protocol.request("model/list", {}),
      window.zenx.settings.get(),
    ]);
    if (settings.status === "fulfilled")
      setProviderProfiles(settings.value.profile.providerProfiles);
    try {
      if (settings.status === "rejected") throw settings.reason;
      if (result.status === "rejected") throw result.reason;
      validateModelCatalog(result.value.data);
      setModels(result.value.data);
      setModelCatalogError(null);
      setModelUpdateError((current) =>
        current === MODEL_CATALOG_LOADING ? null : current,
      );
    } catch (error) {
      setModelCatalogError(describeError(error));
    }
  };

  useEffect(() => {
    let active = true;
    const loadModels = async () => {
      const [result, settings] = await Promise.allSettled([
        window.zenx.protocol.request("model/list", {}),
        window.zenx.settings.get(),
      ]);
      if (active && settings.status === "fulfilled")
        setProviderProfiles(settings.value.profile.providerProfiles);
      try {
        if (settings.status === "rejected") throw settings.reason;
        if (result.status === "rejected") throw result.reason;
        validateModelCatalog(result.value.data);
        if (active) {
          setModels(result.value.data);
          setModelCatalogError(null);
          setModelUpdateError((current) =>
            current === MODEL_CATALOG_LOADING ? null : current,
          );
        }
      } catch (error) {
        if (active) setModelCatalogError(describeError(error));
      }
    };
    const disposeStatus = window.zenx.protocol.onStatus((status) => {
      if (!active) return;
      setServerStatus(status);
      if (status.type === "ready") {
        void loadThreadSummaries();
        void loadProjects();
        void loadModels();
        if (status.reconnected && selectedThreadIdRef.current !== null) {
          void resumeThread(selectedThreadIdRef.current, true);
        }
      }
    });
    const disposeNotifications = window.zenx.protocol.onNotification(
      (method, params) => {
        if (!active) return;
        if (
          method.startsWith("thread/") ||
          method.startsWith("turn/") ||
          method === "item/completed"
        ) {
          void loadThreadSummaries();
          void loadProjects();
        }
        setThreadDetail((current) =>
          current === null
            ? null
            : applyThreadViewNotification(current, method, params),
        );
        if (method === "item/completed" || method === "turn/completed") {
          const event = params as { threadId: string };
          if (selectedThreadIdRef.current === event.threadId)
            refreshThreadUsage(event.threadId);
        }
        if (method === "item/completed") {
          const event = params as ServerNotificationParams["item/completed"];
          if (
            event.item.type === "userMessage" &&
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
                  `Thread images could not be loaded: ${describeError(error)}`,
                ),
              );
          }
        }
        if (method === "thread/settings/updated") {
          const event =
            params as ServerNotificationParams["thread/settings/updated"];
          setSelectedSettings((current) =>
            applySettingsMirror(current, event.threadId, event.threadSettings),
          );
          setModelUpdateError(null);
        }
      },
    );
    const disposeApprovals = window.zenx.protocol.onApprovalRequest((event) => {
      if (active) setApprovals((current) => addApprovalRequest(current, event));
    });
    const disposeResolved = window.zenx.protocol.onApprovalResolved((event) => {
      if (active) setApprovals((current) => resolveApproval(current, event));
    });
    void window.zenx.protocol
      .getPendingApprovals()
      .then((pending) => {
        if (active)
          setApprovals((current) =>
            pending.reduce(addApprovalRequest, current),
          );
      })
      .catch(() => undefined);
    void window.zenx.protocol
      .getStatus()
      .then((status) => {
        if (!active) return;
        setServerStatus(status);
        if (status.type === "ready") {
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
        setRequestError(`ZenX plugin catalog failed: ${describeError(error)}`),
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
    const dispose = window.zenx.titles.onChange(setTitleSnapshot);
    void window.zenx.titles
      .get()
      .then(setTitleSnapshot)
      .catch((error: unknown) =>
        setRequestError(`ZenX title metadata failed: ${describeError(error)}`),
      );
    return dispose;
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (projectPickerIntent !== null) closeProjectPicker();
      else if (workspaceOpen) setWorkspaceOpen(false);
      else if (sidebarOpen) setSidebarOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [projectPickerIntent, sidebarOpen, workspaceOpen]);

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
  const selectedSummary =
    [...activeSummaries, ...archivedSummaries].find(
      (summary) => summary.threadId === selectedThreadId,
    ) ??
    (optimisticSummary?.threadId === selectedThreadId
      ? optimisticSummary
      : null);
  const pendingThreadIds = pendingApprovalThreadIds(approvals);
  const pluginContributions = loadedPluginContributions(pluginSnapshot);
  const genericPluginTarget =
    (pluginSnapshot?.pages ?? []).find(
      (candidate) =>
        candidate.route === page && candidate.surfaceId !== undefined,
    ) ??
    (pluginSnapshot?.subroutes ?? []).find(
      (candidate) =>
        candidate.route === page && candidate.surfaceId !== undefined,
    );
  const selectedSidebarPage =
    genericPluginTarget?.route ??
    pluginContributions.find((contribution) => contribution.page.id === page)
      ?.page.route ??
    page;
  const lastUsedWorkspace = lastUsedProjectWorkspace(projects);

  const configuredProjects = projects.projects.filter(
    (project) => project.configured,
  );

  const showNewThreadDraft = (workspace: string | null) => {
    discardRecoverableDraft();
    selectionEpoch.current += 1;
    threadUsageLoadEpoch.current += 1;
    selectedThreadIdRef.current = null;
    setPage("agent");
    setSidebarOpen(false);
    setWorkspaceOpen(false);
    setSelectedThreadId(null);
    setThreadDetail(null);
    setThreadLoading(false);
    setThreadAttachments({});
    setThreadUsage(undefined);
    setSelectedSettings(null);
    setThreadError(null);
    setModelUpdateError(null);
    confirmNewThreadDraft({
      id: crypto.randomUUID(),
      workspace,
      composer: emptyComposerState(),
    });
    void loadComposerCatalog();
  };

  const openNewThreadDraft = (workspace?: string) => {
    if (workspace === undefined && configuredProjects.length === 0) {
      openProjectPicker("new-thread");
      return;
    }
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
    showNewThreadDraft(
      lastUsedWorkspace ??
        configuredProjects.find((project) => project.isDefault)?.workspace ??
        configuredProjects[0]?.workspace ??
        null,
    );
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
    if (submission.text.length > 0)
      await window.zenx.titles
        .observe(threadId, submission.text)
        .then((projection) => {
          if (projection !== undefined)
            setTitleSnapshot((current) => ({
              ...current,
              [threadId]: projection,
            }));
        })
        .catch((error: unknown) =>
          setRequestError(
            `Thread title could not be staged: ${describeError(error)}`,
          ),
        );
    const input = await composerSubmissionInput(submission);
    if (submission.intent === "start") {
      if (archivingThreadIdsRef.current.has(threadId))
        throw new Error(
          "This Thread is being archived. Try again if archiving fails.",
        );
      await window.zenx.protocol.request("turn/start", {
        threadId,
        input,
        clientUserMessageId: submission.clientUserMessageId,
      });
    } else if (submission.intent === "steer") {
      if (submission.expectedTurnId === null)
        throw new Error("The active turn changed before steering");
      if (archivingThreadIdsRef.current.has(threadId))
        throw new Error(
          "This Thread is being archived. Try again if archiving fails.",
        );
      await window.zenx.protocol.request("turn/steer", {
        threadId,
        expectedTurnId: submission.expectedTurnId,
        input,
        clientUserMessageId: submission.clientUserMessageId,
      });
    } else {
      if (submission.expectedTurnId === null)
        throw new Error("The active turn changed before replacement");
      if (archivingThreadIdsRef.current.has(threadId))
        throw new Error(
          "This Thread is being archived. Try again if archiving fails.",
        );
      await window.zenx.protocol.request("turn/replace", {
        threadId,
        expectedTurnId: submission.expectedTurnId,
        input,
        clientUserMessageId: submission.clientUserMessageId,
      });
    }
  };

  const submitNewThreadDraft = async (
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ) => {
    if (intent !== "start" || expectedTurnId !== null) return;
    const current = newThreadDraftRef.current;
    if (current === null) return;
    if (current.workspace === null) {
      setModelUpdateError("Choose a Project before sending.");
      return;
    }
    const project = projectsRef.current.projects.find(
      (candidate) =>
        candidate.configured && candidate.workspace === current.workspace,
    );
    if (project === undefined) {
      setModelUpdateError(
        "This Project is no longer available. Choose another Project.",
      );
      return;
    }
    const workspace = project.workspace;
    const draftSettings = defaultDraftSettings(models);
    if (current.composer.draft.images.length > 0) {
      const capabilityError = imageCapabilityMessage(
        providerProfiles,
        draftSettings,
      );
      if (capabilityError !== null) {
        setModelUpdateError(capabilityError);
        return;
      }
    }
    if (draftSettings === null) {
      setModelUpdateError(modelCatalogError ?? MODEL_CATALOG_LOADING);
      return;
    }
    if (!canSendWithModel(models, draftSettings.model)) {
      setModelUpdateError("Choose an available model before sending.");
      return;
    }
    const startedComposer = beginComposerSubmission(
      current.composer,
      intent,
      expectedTurnId,
      () => crypto.randomUUID(),
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
      await window.zenx.settings.addWorkspace(workspace);
      const result = await window.zenx.projects.startThread(workspace);
      createdThreadId = result.thread.id;
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
        setThreadDetail(result.thread);
        setThreadAttachments({});
        setThreadUsage(undefined);
        setSelectedSettings(settingsFromSnapshot(createdThreadId, result));
        confirmNewThreadDraft(null);
      }
      void window.zenx.settings
        .markWorkspaceUsed(workspace)
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
              `Thread images could not be loaded: ${describeError(error)}`,
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
            message: `New Thread could not be created: ${message}`,
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
  ) => {
    if (
      threadDetail === null ||
      archivingThreadIdsRef.current.has(threadDetail.id)
    )
      return;
    const threadId = threadDetail.id;
    const current = composerStatesRef.current[threadId] ?? emptyComposerState();
    if (current.draft.images.length > 0) {
      const capabilityError = imageCapabilityMessage(
        providerProfiles,
        selectedSettings,
      );
      if (capabilityError !== null) {
        setModelUpdateError(capabilityError);
        return;
      }
    }
    if (intent !== "steer" && models.length === 0) {
      setModelUpdateError(modelCatalogError ?? MODEL_CATALOG_LOADING);
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
        ) ?? "Choose an available model before sending.",
      );
      return;
    }
    const started = beginComposerSubmission(
      current,
      intent,
      expectedTurnId,
      () => crypto.randomUUID(),
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
              `Thread images could not be loaded: ${describeError(error)}`,
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

  const openPage = (next: ProductPage) => {
    discardRecoverableDraft();
    if (projectPickerIntentRef.current !== null) closeProjectPicker();
    if (next !== "agent") abandonNewThreadDraft();
    setPage(next);
    setSidebarOpen(false);
    setWorkspaceOpen(false);
  };

  useEffect(() => {
    if (!page.startsWith("/plugins/")) return;
    const stillMounted = [
      ...(pluginSnapshot?.pages ?? []),
      ...(pluginSnapshot?.subroutes ?? []),
    ].some((candidate) => candidate.route === page);
    if (stillMounted) return;
    setPage("agent");
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.focus(),
    );
  }, [page, pluginSnapshot]);

  const renameThread = async (threadId: string, title: string) => {
    const projection = await window.zenx.titles.rename(threadId, title);
    setTitleSnapshot((current) => ({
      ...current,
      [threadId]: projection,
    }));
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
    selectionEpoch.current += 1;
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
      throw new Error("Wait for the active Turn to finish before archiving.");
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
          `Thread archived, but its local Pin could not be cleared: ${describeError(error)}`,
        );
      }
    }
    await loadThreadSummaries();
    await loadProjects();
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
    setTitleSnapshot((current) => ({
      ...current,
      [selectedSummary.threadId]: projection,
    }));
  };

  return (
    <div
      className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${sidebarOpen ? " sidebar-open" : ""}`}
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
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenWorkspace={() => setWorkspaceOpen(true)}
            onRename={renameSelectedThread}
            onRetryTitle={retrySelectedTitle}
            selectedSummary={selectedSummary}
            threadDetail={threadDetail}
            threadUsage={threadUsage}
            titleProjection={titleProjection}
          />
        ) : null}
      </WindowTitleBar>
      <Sidebar
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
        onNewThread={(workspace) => {
          openNewThreadDraft(workspace);
        }}
        onAddProject={() => openProjectPicker("add-project")}
        newThreadDisabled={newThreadPending}
        onRemoveProject={(workspace) => {
          void window.zenx.settings
            .removeWorkspace(workspace)
            .then(async () => await loadProjects())
            .catch((error: unknown) => setRequestError(describeError(error)));
        }}
        onSetDefaultProject={(workspace) => {
          void window.zenx.settings
            .addWorkspace(workspace)
            .then(
              async () =>
                await window.zenx.settings.setDefaultWorkspace(workspace),
            )
            .then(async () => await loadProjects())
            .catch((error: unknown) => setRequestError(describeError(error)));
        }}
        onOpenContribution={(route) => {
          const target = pluginSnapshot?.pages.find(
            (candidate) => candidate.route === route,
          );
          if (target?.surfaceId !== undefined) openPage(route);
        }}
        onOpenSettings={() => openPage("settings")}
        onRetryThreads={() => void loadThreadSummaries(true)}
        onRenameThread={renameThread}
        onSelectThread={(threadId) => void resumeThread(threadId)}
        pendingApprovalThreadIds={pendingThreadIds}
        pluginContributions={pluginContributions}
        selectedPage={selectedSidebarPage}
        selectedThreadId={selectedThreadId}
        serverStatus={serverStatus}
        projects={projects}
        sidebarOrder={sidebarOrder}
        pinnedThreads={pinnedSummaries}
        threadError={threadListErrors.active}
        threadLoading={!threadListLoaded.active}
        threads={activeSummaries}
      />

      {projectError !== null ||
      requestError !== null ||
      draftRecoveryNotice !== null ? (
        <div className="app-notice" role="alert">
          <span>
            {projectError ?? requestError ?? draftRecoveryNotice?.message}
          </span>
          {draftRecoveryNotice !== null ? (
            <button
              type="button"
              onClick={() => {
                selectionEpoch.current += 1;
                setPage("agent");
                selectedThreadIdRef.current = null;
                setSelectedThreadId(null);
                setThreadDetail(null);
                setThreadAttachments({});
                setThreadUsage(undefined);
                setSelectedSettings(null);
                setThreadError(null);
                setWorkspaceOpen(false);
                confirmNewThreadDraft(draftRecoveryNotice.draft);
                discardRecoverableDraft();
              }}
            >
              Restore draft
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setProjectError(null);
              setRequestError(null);
              discardRecoverableDraft();
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <main className="workspace">
        {page === "settings" ? (
          <SettingsView
            archivedError={threadListErrors.archived}
            archivedLoading={!threadListLoaded.archived}
            archivedThreads={archivedSummaries}
            onRetryArchived={() => void loadThreadSummaries(true)}
            onTabChange={setSettingsTab}
            onUnarchive={performThreadLifecycle}
            onOpenSidebar={() => setSidebarOpen(true)}
            tab={settingsTab}
            pluginSnapshot={pluginSnapshot}
          />
        ) : genericPluginTarget !== undefined && pluginSnapshot !== null ? (
          <PluginProductPage
            snapshot={pluginSnapshot}
            route={page}
            navigate={openPage}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        ) : (
          <AgentSurface
            approvals={approvals}
            pluginSnapshot={pluginSnapshot}
            composerStates={composerStates}
            configuredProjects={configuredProjects}
            newThreadDraft={newThreadDraft}
            threadAttachments={threadAttachments}
            threadUsage={threadUsage}
            models={models}
            providerProfiles={providerProfiles}
            modelCatalogError={modelCatalogError}
            modelUpdateError={modelUpdateError}
            onDraftChange={(threadId, draft) =>
              updateComposer(threadId, (state) => editComposer(state, draft))
            }
            onNewThreadDraftChange={(draft) =>
              updateNewThreadDraft((current) => ({
                ...current,
                composer: editComposer(current.composer, draft),
              }))
            }
            onNewThreadProjectChange={(workspace) => {
              setModelUpdateError(null);
              updateNewThreadDraft((current) => ({
                ...current,
                workspace,
                composer: {
                  ...current.composer,
                  submission:
                    current.composer.submission?.status === "failed"
                      ? null
                      : current.composer.submission,
                },
              }));
            }}
            onAddNewThreadProject={() => openProjectPicker("new-thread")}
            onImportImages={async (threadId, files) => {
              const imports = await Promise.all(
                files.map(async (file) => ({
                  name: file.name,
                  mediaType: file.type,
                  bytes: new Uint8Array(await file.arrayBuffer()),
                })),
              );
              const images = await window.zenx.imageAttachments.import(imports);
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
            onReadAttachment={(attachment) =>
              window.zenx.imageAttachments.read(attachment)
            }
            onInterrupt={async (turnId) => {
              if (threadDetail === null)
                throw new Error("No thread is selected");
              await window.zenx.protocol.request("turn/interrupt", {
                threadId: threadDetail.id,
                turnId,
              });
            }}
            onModelChange={(model) => void changeModel(model)}
            onReasoningChange={(effort) => void changeReasoning(effort)}
            onOpenSidebar={() => setSidebarOpen(true)}
            onRespondToApproval={respondToApproval}
            onSubmit={submitComposer}
            onSubmitNewThread={submitNewThreadDraft}
            selectedSettings={selectedSettings}
            selectedSummary={selectedSummary}
            serverStatus={serverStatus}
            switchingModel={switchingModel}
            threadArchiving={
              threadDetail !== null && archivingThreadIds.has(threadDetail.id)
            }
            threadDetail={threadDetail}
            threadError={threadError}
            threadLoading={threadLoading}
          />
        )}
      </main>

      {workspaceOpen && threadDetail !== null ? (
        <WorkspaceDrawer
          onClose={() => setWorkspaceOpen(false)}
          settings={selectedSettings}
          thread={threadDetail}
        />
      ) : null}
      {projectPickerIntent !== null ? (
        <DirectoryPicker
          onCancel={closeProjectPicker}
          onSelect={(workspace) => void selectProjectDirectory(workspace)}
        />
      ) : null}
    </div>
  );
}

function WindowTitleBar({
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
    <header className="window-titlebar" aria-label="ZenX window controls">
      <div className="window-titlebar-product">
        <ZenXBrand />
        <div className="window-titlebar-inbox">
          <button
            className="icon-button inbox-button"
            type="button"
            aria-label={mode === "inbox" ? "Return to projects" : "Open inbox"}
            aria-pressed={mode === "inbox"}
            title={mode === "inbox" ? "Return to projects" : "Open inbox"}
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
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
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
  onOpenSidebar,
  onOpenWorkspace,
  onRename,
  onRetryTitle,
  selectedSummary,
  threadDetail,
  threadUsage,
  titleProjection,
}: {
  onOpenSidebar(): void;
  onOpenWorkspace(): void;
  onRename(title: string): Promise<void>;
  onRetryTitle(): Promise<void>;
  selectedSummary: NativeThreadSummary;
  threadDetail: Thread | null;
  threadUsage: ModelUsageProjection | undefined;
  titleProjection: ThreadTitleProjection | undefined;
}) {
  return (
    <div className="workspace-header">
      <div className="workspace-heading-row">
        <button
          className="icon-button mobile-menu"
          type="button"
          aria-label="Open sidebar"
          onClick={onOpenSidebar}
        >
          <Icon name="tree" />
        </button>
        <div className="thread-heading">
          <ThreadTitleEditor
            editable={!selectedSummary.archived}
            onRename={onRename}
            onRetry={onRetryTitle}
            projection={titleProjection}
            title={threadTitle(selectedSummary)}
          />
          <span>
            {selectedSummary.status === "systemError"
              ? "Unavailable journal"
              : selectedSummary.currentMetadata.cwd}
          </span>
        </div>
      </div>
      <div className="top-actions">
        {threadUsage === undefined ||
        threadUsage.thread.responseCount === 0 ? null : (
          <small className="thread-usage">
            {usageLabel(threadUsage.thread, "Thread cache")}
          </small>
        )}
        <button
          className="icon-button"
          type="button"
          aria-label="Open workspace panel"
          aria-haspopup="dialog"
          disabled={threadDetail === null}
          onClick={onOpenWorkspace}
        >
          <Icon name="panel-right" />
        </button>
      </div>
    </div>
  );
}

function AgentSurface({
  approvals,
  pluginSnapshot,
  composerStates,
  configuredProjects,
  newThreadDraft,
  threadAttachments,
  threadUsage,
  models,
  providerProfiles,
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
  onNewThreadProjectChange,
  onAddNewThreadProject,
  onInterrupt,
  onModelChange,
  onReasoningChange,
  onOpenSidebar,
  onRespondToApproval,
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
  approvals: ApprovalCardState[];
  pluginSnapshot: ZenXPluginSnapshot | null;
  composerStates: Record<string, ComposerState>;
  configuredProjects: ZenXProjectProjectionEntry[];
  newThreadDraft: NewThreadDraft | null;
  threadAttachments: ZenXThreadAttachmentProjection;
  threadUsage: ModelUsageProjection | undefined;
  models: ModelSummary[];
  providerProfiles: ZenXProviderProfile[];
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
  onNewThreadProjectChange(workspace: string): void;
  onAddNewThreadProject(): void;
  onInterrupt(turnId: string): Promise<void>;
  onModelChange(model: string): void;
  onReasoningChange(effort: string): void;
  onOpenSidebar(): void;
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  onSubmit(
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ): Promise<void>;
  onSubmitNewThread(
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ): Promise<void>;
  selectedSettings: SelectedThreadSettings | null;
  selectedSummary: NativeThreadSummary | null;
  serverStatus: AppServerHostStatus;
  switchingModel: boolean;
  threadArchiving: boolean;
  threadDetail: Thread | null;
  threadError: string | null;
  threadLoading: boolean;
}) {
  const draftSettings = defaultDraftSettings(models);
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
      ? "This Project is no longer available. Choose another Project."
      : null;
  return (
    <section
      className={`agent-surface${newThreadDraft === null ? "" : " new-thread-draft-surface"}`}
    >
      {newThreadDraft !== null || selectedSummary === null ? (
        <button
          className="icon-button mobile-menu new-thread-draft-mobile"
          type="button"
          aria-label="Open sidebar"
          onClick={onOpenSidebar}
        >
          <Icon name="tree" />
        </button>
      ) : null}

      {serverStatus.type === "error" ? (
        <EmptyState
          error
          title="Zen App Server stopped"
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
              ? "Starting Zen App Server"
              : serverStatus.type === "reconnecting"
                ? "Reconnecting to Zen App Server"
                : "Zen App Server disconnected"
          }
          detail="Your draft is preserved while ZenX reconnects to the local runtime."
        />
      ) : threadLoading ? (
        <EmptyState
          loading
          title="Loading conversation"
          detail="Reconstructing this Thread from App Server history…"
        />
      ) : threadError !== null ? (
        <EmptyState
          error
          title="Could not open conversation"
          detail={threadError}
        />
      ) : newThreadDraft !== null ? (
        <ThreadView
          approvals={[]}
          composer={newThreadDraft.composer}
          composerContext={
            <NewThreadProjectContext
              projects={configuredProjects}
              selectedWorkspace={newThreadDraft.workspace}
            />
          }
          emptyContent={
            <div className="thread-empty new-thread-draft-empty">
              <div
                className="new-thread-draft-heading"
                role="heading"
                aria-level={2}
              >
                What should we build in{" "}
                <NewThreadProjectSelector
                  disabled={
                    newThreadDraft.composer.submission?.status === "pending"
                  }
                  onAddProject={onAddNewThreadProject}
                  onChange={onNewThreadProjectChange}
                  projects={configuredProjects}
                  selectedWorkspace={newThreadDraft.workspace}
                />
                ?
              </div>
            </div>
          }
          imageCapabilityError={imageCapabilityMessage(
            providerProfiles,
            draftSettings,
          )}
          imageCapabilityNotice={imageCapabilityNotice(
            providerProfiles,
            draftSettings,
          )}
          modelDisabled
          modelError={
            draftProjectError ?? modelUpdateError ?? modelCatalogError
          }
          models={models}
          providerProfiles={providerProfiles}
          permissionLabel={null}
          selectedModel={draftSettings?.model}
          selectedReasoningEffort={draftSettings?.reasoningEffort}
          thread={null}
          onDraftChange={onNewThreadDraftChange}
          onImportImages={onImportNewThreadImages}
          onPickImages={onPickNewThreadImages}
          onReadAttachment={onReadAttachment}
          onRemoveImage={onRemoveNewThreadImage}
          onInterrupt={async () => undefined}
          onRespondToApproval={onRespondToApproval}
          onSubmit={onSubmitNewThread}
        />
      ) : selectedSummary === null || threadDetail === null ? null : (
        <>
          <ThreadView
            approvals={approvals.filter(
              (approval) => approval.params.threadId === threadDetail.id,
            )}
            composer={composerStates[threadDetail.id] ?? emptyComposerState()}
            composerDisabled={threadArchiving}
            imageCapabilityError={imageCapabilityMessage(
              providerProfiles,
              selectedSettings,
            )}
            imageCapabilityNotice={imageCapabilityNotice(
              providerProfiles,
              selectedSettings,
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
              selectedSummary.status !== "systemError" &&
              selectedSummary.currentMetadata.approvalPolicy === "never"
                ? "Full access"
                : "Approval required"
            }
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
            onDraftChange={(draft) => onDraftChange(threadDetail.id, draft)}
            onImportImages={(files) => onImportImages(threadDetail.id, files)}
            onPickImages={() => onPickImages(threadDetail.id)}
            onReadAttachment={onReadAttachment}
            onRemoveImage={(imageId) => onRemoveImage(threadDetail.id, imageId)}
            onInterrupt={onInterrupt}
            onModelChange={onModelChange}
            onReasoningChange={onReasoningChange}
            onRespondToApproval={onRespondToApproval}
            onSubmit={onSubmit}
          />
          {pluginSnapshot === null ? null : (
            <PluginAgentPanels
              snapshot={pluginSnapshot}
              threadId={threadDetail.id}
            />
          )}
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
}: {
  disabled: boolean;
  onAddProject(): void;
  onChange(workspace: string): void;
  projects: readonly ZenXProjectProjectionEntry[];
  selectedWorkspace: string | null;
}) {
  const [open, setOpen] = useState(selectedWorkspace === null);
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
      ? "Choose a Project"
      : selectedProject === undefined
        ? `${projectLabel(selectedWorkspace)} unavailable`
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
    if (!open) return;
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
    if (selectedWorkspace === null && !disabled) setOpen(true);
  }, [disabled, selectedWorkspace]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => searchRef.current?.focus());
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

  return (
    <div className="new-thread-project-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        className="new-thread-project-trigger"
        type="button"
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          selectedWorkspace === null
            ? "Choose a Project"
            : `Change Project. Current Project: ${selectedWorkspace}`
        }
        disabled={disabled}
        onClick={() => (open ? closeMenu(false) : setOpen(true))}
      >
        {selectedLabel}
      </button>
      {open ? (
        <div
          className="new-thread-project-popover"
          data-placement={popoverLayout.placement}
          id={popoverId}
          role="dialog"
          aria-label="Switch Project"
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
          <label className="new-thread-project-search">
            <Icon name="search" size={13} />
            <span className="sr-only">Search projects</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search projects"
              aria-label="Search projects"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                  return;
                event.preventDefault();
                focusProject(event.key === "ArrowUp" ? "selected" : "first");
              }}
            />
          </label>
          <div
            ref={menuRef}
            className="new-thread-project-menu"
            role="menu"
            aria-label="Choose a Project"
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
            {filteredProjects.map((project) => {
              const selected = project.workspace === selectedWorkspace;
              return (
                <button
                  key={project.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-label={`${selected ? "Selected Project" : "Select Project"}: ${project.workspace}`}
                  title={project.workspace}
                  onClick={() => {
                    onChange(project.workspace);
                    closeMenu(true);
                  }}
                >
                  <Icon name="folder" size={13} />
                  <span>
                    {projectDisplayLabel(project.workspace, projects)}
                  </span>
                  {selected ? <Icon name="check" size={13} /> : null}
                </button>
              );
            })}
            {filteredProjects.length === 0 ? (
              <p className="new-thread-project-empty">No projects found</p>
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
              <span>Add project</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NewThreadProjectContext({
  projects,
  selectedWorkspace,
}: {
  projects: readonly ZenXProjectProjectionEntry[];
  selectedWorkspace: string | null;
}) {
  const selectedProject = projects.find(
    (project) => project.workspace === selectedWorkspace,
  );
  const selectedLabel =
    selectedWorkspace === null
      ? "Choose a Project"
      : selectedProject === undefined
        ? `${projectLabel(selectedWorkspace)} unavailable`
        : projectDisplayLabel(selectedProject.workspace, projects);
  return (
    <div
      className="new-thread-project-context"
      aria-label={
        selectedWorkspace === null
          ? "No Project selected"
          : `Selected Project: ${selectedWorkspace}`
      }
      title={selectedWorkspace ?? undefined}
    >
      <Icon name="folder" size={13} />
      <span>{selectedLabel}</span>
    </div>
  );
}

function WorkspaceDrawer({
  onClose,
  settings,
  thread,
}: {
  onClose(): void;
  settings: SelectedThreadSettings | null;
  thread: Thread;
}) {
  const [tab, setTab] = useState<"files" | "artifacts" | "context">("files");
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);
  const commands = thread.turns.flatMap((turn) =>
    turn.items.filter(
      (
        item,
      ): item is Extract<
        (typeof turn.items)[number],
        { type: "commandExecution" }
      > => item.type === "commandExecution",
    ),
  );
  return (
    <div
      className="drawer-layer"
      role="presentation"
      onPointerDown={(event) =>
        event.target === event.currentTarget && onClose()
      }
    >
      <aside
        className="workspace-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-drawer-title"
      >
        <header>
          <div>
            <strong id="workspace-drawer-title">Workspace</strong>
            <span>Linked context for this Thread</span>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            aria-label="Close workspace"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <div
          className="drawer-tabs"
          role="tablist"
          aria-label="Workspace views"
        >
          {(["files", "artifacts", "context"] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
            >
              {name[0]!.toUpperCase() + name.slice(1)}
            </button>
          ))}
        </div>
        <div className="drawer-content">
          {tab === "files" ? (
            <>
              <p>
                Files explicitly represented by this Thread’s current product
                projection.
              </p>
              <div className="drawer-row">
                <Icon name="folder" />
                <div>
                  <strong>{thread.cwd}</strong>
                  <span>Thread workspace</span>
                </div>
              </div>
              <p className="drawer-empty">
                No file-reference Items are available for this Thread.
              </p>
            </>
          ) : tab === "artifacts" ? (
            <p className="drawer-empty">No live artifacts are available.</p>
          ) : (
            <>
              <div className="drawer-row">
                <Icon name="folder" />
                <div>
                  <strong>{thread.cwd}</strong>
                  <span>Current workspace</span>
                </div>
              </div>
              <div className="drawer-row">
                <Icon name="layers" />
                <div>
                  <strong>{settings?.model ?? thread.modelProvider}</strong>
                  <span>Effective Thread model</span>
                </div>
              </div>
              <div className="drawer-row">
                <Icon name="terminal" />
                <div>
                  <strong>
                    {commands.length} tool{" "}
                    {commands.length === 1 ? "call" : "calls"}
                  </strong>
                  <span>From canonical Thread Items</span>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function EmptyState({
  title,
  detail,
  action,
  loading = false,
  error = false,
  actionLabel = "New thread",
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

function ThreadTitleEditor({
  editable,
  title,
  projection,
  onRename,
  onRetry,
}: {
  editable: boolean;
  title: string;
  projection: ThreadTitleProjection | undefined;
  onRename(title: string): Promise<void>;
  onRetry(): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);
  if (editing) {
    return (
      <form
        className="thread-title-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void onRename(draft)
            .then(() => setEditing(false))
            .catch((reason: unknown) => setError(describeError(reason)))
            .finally(() => setBusy(false));
        }}
      >
        <input
          autoFocus
          aria-label="Thread title"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {error ? <small role="alert">{error}</small> : null}
      </form>
    );
  }
  return (
    <div className="thread-title-line">
      <strong title={title}>{title}</strong>
      {editable ? (
        <button
          type="button"
          aria-label="Rename Thread"
          onClick={() => setEditing(true)}
        >
          Rename
        </button>
      ) : null}
      {editable && projection?.status === "generating" ? (
        <small>Generating title…</small>
      ) : null}
      {editable && projection?.status === "failed" ? (
        <button type="button" onClick={() => void onRetry()}>
          Retry title
        </button>
      ) : null}
    </div>
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
    ? `Provider profile “${settings.modelProvider}” was deleted. Choose a model before sending.`
    : `The configured model from “${provider.displayName}” is hidden or unavailable. Choose another model before sending.`;
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
    model: model.id,
    modelProvider,
    reasoningEffort: model.defaultReasoningEffort,
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
  },
  preview: string,
): NativeThreadSummary {
  return {
    threadId: result.thread.id,
    currentMetadata: {
      model: result.model,
      provider: result.modelProvider,
      cwd: result.cwd,
      sandbox: "danger-full-access",
      approvalPolicy:
        result.approvalPolicy === "on-request" ? "always" : "never",
    },
    archived: false,
    createdAt: new Date(result.thread.createdAt * 1_000).toISOString(),
    updatedAt: new Date(result.thread.updatedAt * 1_000).toISOString(),
    name: result.thread.name ?? "New thread",
    preview,
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
  const leaf = projectLabel(workspace);
  const ambiguous = projects.some(
    (project) =>
      project.workspace !== workspace &&
      projectLabel(project.workspace) === leaf,
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
