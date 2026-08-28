import { useEffect, useRef, useState } from "react";

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
import { ThreadLifecycleAction } from "./ThreadLifecycleAction.js";
import { ThreadView } from "./ThreadView.js";

type ProductPage = string;
const MODEL_CATALOG_LOADING = "Models are still loading. Try again.";

interface NewThreadDraft {
  workspace: string | null;
  composer: ComposerState;
}

export function App() {
  const selectionEpoch = useRef(0);
  const newThreadPendingRef = useRef(false);
  const newThreadDraftRef = useRef<NewThreadDraft | null>(null);
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
  const [projectError, setProjectError] = useState<string | null>(null);
  const [threadLifecycleBusy, setThreadLifecycleBusy] = useState(false);
  const [threadLifecycleError, setThreadLifecycleError] = useState<
    string | null
  >(null);
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

  const confirmNewThreadDraft = (draft: NewThreadDraft | null) => {
    newThreadDraftRef.current = draft;
    setNewThreadDraft(draft);
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
      }
    } catch (error) {
      if (projectLoadEpoch.current === epoch)
        setProjectError(describeError(error));
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
    setThreadLifecycleError(null);
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
      if (projectPickerIntent !== null) setProjectPickerIntent(null);
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
    ) ?? null;
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

  const openNewThreadDraft = (workspace?: string) => {
    if (workspace === undefined && configuredProjects.length === 0) {
      setProjectPickerIntent("new-thread");
      return;
    }
    const selectedWorkspace = workspace ?? lastUsedWorkspace;
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
      workspace: selectedWorkspace,
      composer: emptyComposerState(),
    });
    void loadComposerCatalog();
  };

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
    confirmNewThreadDraft(startedDraft);
    const submission = startedComposer.submission;
    if (submission === null || submission.status !== "pending") return;
    if (newThreadPendingRef.current) return;
    newThreadPendingRef.current = true;
    setNewThreadPending(true);
    const epoch = selectionEpoch.current;
    let createdThreadId: string | null = null;
    try {
      const result = await window.zenx.projects.startThread(workspace);
      createdThreadId = result.thread.id;
      const promotedStates = {
        ...composerStatesRef.current,
        [createdThreadId]: startedComposer,
      };
      composerStatesRef.current = promotedStates;
      setComposerStates(promotedStates);
      try {
        await window.zenx.settings.markWorkspaceUsed(workspace);
      } catch (error) {
        setRequestError(describeError(error));
      }
      await loadThreadSummaries();
      await loadProjects();
      const stillCurrent =
        selectionEpoch.current === epoch &&
        newThreadDraftRef.current?.composer.submission?.clientUserMessageId ===
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
          setRequestError(`New thread failed: ${message}`);
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

  const changeThreadLifecycle = async () => {
    if (selectedSummary === null) return;
    setThreadLifecycleBusy(true);
    setThreadLifecycleError(null);
    try {
      await performThreadLifecycle(selectedSummary, true);
    } catch (error) {
      setThreadLifecycleError(describeError(error));
    } finally {
      setThreadLifecycleBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar
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
        onModeChange={(mode) => {
          setSidebarMode(mode);
          try {
            writeSidebarMode(window.localStorage, mode);
          } catch {
            // The preference remains valid for this window.
          }
        }}
        onNewThread={(workspace) => {
          openNewThreadDraft(workspace);
        }}
        onAddProject={() => setProjectPickerIntent("add-project")}
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
              const imports = await Promise.all(
                files.map(async (file) => ({
                  name: file.name,
                  mediaType: file.type,
                  bytes: new Uint8Array(await file.arrayBuffer()),
                })),
              );
              const images = await window.zenx.imageAttachments.import(imports);
              updateNewThreadDraft((current) => ({
                ...current,
                composer: addComposerImages(current.composer, images),
              }));
            }}
            onPickImages={async (threadId) => {
              const images = await window.zenx.imageAttachments.pick();
              updateComposer(threadId, (state) =>
                addComposerImages(state, images),
              );
            }}
            onPickNewThreadImages={async () => {
              const images = await window.zenx.imageAttachments.pick();
              updateNewThreadDraft((current) => ({
                ...current,
                composer: addComposerImages(current.composer, images),
              }));
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
            onChangeThreadLifecycle={changeThreadLifecycle}
            hasProjects={projects.projects.some(
              (project) => project.configured,
            )}
            hasLastUsedProject={lastUsedWorkspace !== null}
            onAddProject={() => setProjectPickerIntent("add-project")}
            onNewThread={() => {
              openNewThreadDraft();
            }}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenWorkspace={() => setWorkspaceOpen(true)}
            onRename={async (title) => {
              if (selectedSummary === null) return;
              await renameThread(selectedSummary.threadId, title);
            }}
            onRespondToApproval={respondToApproval}
            onRetryTitle={async () => {
              if (selectedSummary === null) return;
              const projection = await window.zenx.titles.retry(
                selectedSummary.threadId,
              );
              setTitleSnapshot((current) => ({
                ...current,
                [selectedSummary.threadId]: projection,
              }));
            }}
            onSubmit={submitComposer}
            onSubmitNewThread={submitNewThreadDraft}
            requestError={projectError ?? requestError}
            selectedSettings={selectedSettings}
            selectedSummary={selectedSummary}
            serverStatus={serverStatus}
            switchingModel={switchingModel}
            threadLifecycleBusy={threadLifecycleBusy}
            threadLifecycleError={threadLifecycleError}
            threadArchiving={
              threadDetail !== null && archivingThreadIds.has(threadDetail.id)
            }
            threadDetail={threadDetail}
            threadError={threadError}
            threadLoading={threadLoading}
            titleProjection={
              selectedSummary === null
                ? undefined
                : titleSnapshot[selectedSummary.threadId]
            }
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
          onCancel={() => setProjectPickerIntent(null)}
          onSelect={(workspace) => {
            if (projectPickerIntent === "new-thread") {
              void window.zenx.settings
                .addWorkspace(workspace)
                .then(async () => {
                  await loadProjects();
                  setProjectPickerIntent(null);
                  openNewThreadDraft(workspace);
                })
                .catch((error: unknown) =>
                  setRequestError(describeError(error)),
                );
              return;
            }
            void window.zenx.settings
              .addWorkspace(workspace)
              .then(async () => {
                await loadProjects();
                setProjectPickerIntent(null);
              })
              .catch((error: unknown) => setRequestError(describeError(error)));
          }}
        />
      ) : null}
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
  onChangeThreadLifecycle,
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
  hasProjects,
  hasLastUsedProject,
  onAddProject,
  onInterrupt,
  onModelChange,
  onReasoningChange,
  onNewThread,
  onOpenSidebar,
  onOpenWorkspace,
  onRename,
  onRespondToApproval,
  onRetryTitle,
  onSubmit,
  onSubmitNewThread,
  requestError,
  selectedSettings,
  selectedSummary,
  serverStatus,
  switchingModel,
  threadLifecycleBusy,
  threadLifecycleError,
  threadArchiving,
  threadDetail,
  threadError,
  threadLoading,
  titleProjection,
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
  onChangeThreadLifecycle(): Promise<void>;
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
  hasProjects: boolean;
  hasLastUsedProject: boolean;
  onAddProject(): void;
  onInterrupt(turnId: string): Promise<void>;
  onModelChange(model: string): void;
  onReasoningChange(effort: string): void;
  onNewThread(): void;
  onOpenSidebar(): void;
  onOpenWorkspace(): void;
  onRename(title: string): Promise<void>;
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  onRetryTitle(): Promise<void>;
  onSubmit(
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ): Promise<void>;
  onSubmitNewThread(
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ): Promise<void>;
  requestError: string | null;
  selectedSettings: SelectedThreadSettings | null;
  selectedSummary: NativeThreadSummary | null;
  serverStatus: AppServerHostStatus;
  switchingModel: boolean;
  threadLifecycleBusy: boolean;
  threadLifecycleError: string | null;
  threadArchiving: boolean;
  threadDetail: Thread | null;
  threadError: string | null;
  threadLoading: boolean;
  titleProjection: ThreadTitleProjection | undefined;
}) {
  const draftSettings = defaultDraftSettings(models);
  const draftProject =
    newThreadDraft === null
      ? undefined
      : configuredProjects.find(
          (project) => project.workspace === newThreadDraft.workspace,
        );
  const draftProjectLabel =
    newThreadDraft?.workspace === null || newThreadDraft === null
      ? null
      : projectLabel(newThreadDraft.workspace);
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
      {newThreadDraft !== null ? (
        <button
          className="icon-button mobile-menu new-thread-draft-mobile"
          type="button"
          aria-label="Open sidebar"
          onClick={onOpenSidebar}
        >
          <Icon name="tree" />
        </button>
      ) : (
        <header className="workspace-header">
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
              {selectedSummary === null ? (
                <strong>Start a conversation</strong>
              ) : (
                <ThreadTitleEditor
                  editable={!selectedSummary.archived}
                  onRename={onRename}
                  onRetry={onRetryTitle}
                  projection={titleProjection}
                  title={threadTitle(selectedSummary)}
                />
              )}
              <span>
                {selectedSummary === null
                  ? "Select a Thread or create a new one"
                  : selectedSummary.status === "systemError"
                    ? "Unavailable journal"
                    : selectedSummary.currentMetadata.cwd}
              </span>
            </div>
          </div>
          <div className="top-actions">
            {selectedSummary === null ||
            selectedSummary.status === "systemError" ||
            selectedSummary.archived ? null : (
              <ThreadLifecycleAction
                archived={selectedSummary.archived}
                busy={threadLifecycleBusy || threadArchiving}
                error={threadLifecycleError}
                hasActiveTurn={threadHasActiveTurn(
                  selectedSummary,
                  threadDetail,
                )}
                onChange={onChangeThreadLifecycle}
              />
            )}
            <button
              className="icon-button search-thread"
              type="button"
              aria-label="Thread search is not available in this build"
              disabled
            >
              <Icon name="search" />
            </button>
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
        </header>
      )}

      {serverStatus.type === "error" || requestError !== null ? (
        <EmptyState
          error
          title={
            serverStatus.type === "error"
              ? "Zen App Server stopped"
              : "ZenX could not load data"
          }
          detail={
            serverStatus.type === "error" ? serverStatus.message : requestError!
          }
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
            <NewThreadProjectSelector
              disabled={
                newThreadDraft.composer.submission?.status === "pending"
              }
              onChange={onNewThreadProjectChange}
              projects={configuredProjects}
              selectedWorkspace={newThreadDraft.workspace}
            />
          }
          emptyContent={
            <div className="thread-empty new-thread-draft-empty">
              <div className="empty-glyph" aria-hidden="true">
                <Icon name="compose" size={20} />
              </div>
              <h2>
                {draftProjectLabel === null
                  ? "What should we build?"
                  : `What should we build in ${draftProjectLabel}?`}
              </h2>
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
      ) : selectedSummary === null || threadDetail === null ? (
        <EmptyState
          title={hasProjects ? "No thread selected" : "Add your first project"}
          detail={
            hasProjects
              ? "Choose New thread to start working in the selected Project."
              : "Choose a folder before ZenX creates a Thread. Your files stay where they are."
          }
          action={hasProjects ? onNewThread : onAddProject}
          actionLabel={
            hasProjects
              ? hasLastUsedProject
                ? "New thread"
                : "Choose project"
              : "Add project"
          }
          actionIcon={hasProjects ? "compose" : "folder"}
        />
      ) : (
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
  onChange,
  projects,
  selectedWorkspace,
}: {
  disabled: boolean;
  onChange(workspace: string): void;
  projects: readonly ZenXProjectProjectionEntry[];
  selectedWorkspace: string | null;
}) {
  const [open, setOpen] = useState(selectedWorkspace === null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedProject = projects.find(
    (project) => project.workspace === selectedWorkspace,
  );
  const selectedLabel =
    selectedWorkspace === null
      ? "Choose a Project"
      : selectedProject === undefined
        ? `${projectLabel(selectedWorkspace)} unavailable`
        : projectLabel(selectedProject.workspace);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    const focusSelected = () => {
      const selected = menuRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      );
      (
        selected ??
        menuRef.current?.querySelector<HTMLButtonElement>(
          '[role="menuitemradio"]',
        )
      )?.focus();
    };
    queueMicrotask(focusSelected);
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="new-thread-project-context" ref={rootRef}>
      <div
        className="new-thread-project-current"
        title={selectedWorkspace ?? undefined}
      >
        <Icon name="folder" size={13} />
        <span>{selectedLabel}</span>
      </div>
      <button
        ref={triggerRef}
        className="new-thread-project-trigger"
        type="button"
        aria-controls={open ? "new-thread-project-menu" : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        Change Project
        <Icon name="chevron-down" size={12} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="new-thread-project-menu"
          id="new-thread-project-menu"
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
          {projects.map((project) => {
            const selected = project.workspace === selectedWorkspace;
            return (
              <button
                key={project.key}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={project.workspace}
                onClick={() => {
                  onChange(project.workspace);
                  closeAndRestoreFocus();
                }}
              >
                <Icon name="folder" size={13} />
                <span>{projectLabel(project.workspace)}</span>
                {selected ? <Icon name="check" size={13} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
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
      <strong>{title}</strong>
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
  return model === undefined
    ? null
    : {
        threadId: "",
        model: model.id,
        modelProvider: model.model,
        reasoningEffort: model.defaultReasoningEffort,
      };
}

function projectLabel(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace;
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
