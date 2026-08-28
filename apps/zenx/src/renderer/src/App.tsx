import { useEffect, useRef, useState } from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { ModelUsageProjection } from "../../../../../src/model-usage.js";
import type {
  AppServerHostStatus,
  ApprovalDecision,
} from "../../main/app-server-manager.js";
import type { ZenXThreadAttachmentProjection } from "../../main/image-attachments.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type { ZenXProjectProjectionSnapshot } from "../../main/project-projection.js";
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
  startProjectThread,
  threadTitle,
  writeSidebarMode,
  type SidebarMode,
} from "./thread-list.js";
import { applyThreadViewNotification } from "./thread-view-state.js";
import { ThreadView, usageLabel } from "./ThreadView.js";

type ProductPage = string;
const MODEL_CATALOG_LOADING = "Models are still loading. Try again.";

export function App() {
  const selectionEpoch = useRef(0);
  const newThreadPendingRef = useRef(false);
  const threadUsageLoadEpoch = useRef(0);
  const threadSummaryLoadEpoch = useRef(0);
  const projectLoadEpoch = useRef(0);
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
  const [newThreadFailure, setNewThreadFailure] = useState<{
    workspace: string;
    message: string;
  } | null>(null);
  const [newThreadPending, setNewThreadPending] = useState(false);
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

  const newThread = async (workspace: string) => {
    if (newThreadPendingRef.current) return;
    newThreadPendingRef.current = true;
    const epoch = ++selectionEpoch.current;
    setNewThreadPending(true);
    setNewThreadFailure(null);
    setThreadError(null);
    setModelUpdateError(null);
    try {
      const result = await startProjectThread(
        workspace,
        async (candidate) => await window.zenx.settings.addWorkspace(candidate),
        async (params) => await window.zenx.projects.startThread(params.cwd),
        async (startedWorkspace) => {
          try {
            await window.zenx.settings.markWorkspaceUsed(startedWorkspace);
          } catch (error) {
            setRequestError(describeError(error));
          }
          await loadThreadSummaries();
          await loadProjects();
        },
      );
      if (selectionEpoch.current !== epoch) return;
      selectedThreadIdRef.current = result.thread.id;
      threadUsageLoadEpoch.current += 1;
      setPage("agent");
      setSidebarOpen(false);
      setSelectedThreadId(result.thread.id);
      setThreadDetail(result.thread);
      setThreadAttachments({});
      setThreadUsage(undefined);
      setSelectedSettings(settingsFromSnapshot(result.thread.id, result));
    } catch (error) {
      setNewThreadFailure({ workspace, message: describeError(error) });
    } finally {
      newThreadPendingRef.current = false;
      setNewThreadPending(false);
    }
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
          if (workspace === undefined) setProjectPickerIntent("new-thread");
          else void newThread(workspace);
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
        {newThreadFailure === null ? null : (
          <div className="new-thread-error-banner" role="alert">
            <div>
              <strong>New thread failed</strong>
              <span>{newThreadFailure.message}</span>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={newThreadPending}
              onClick={() => void newThread(newThreadFailure.workspace)}
            >
              Try again
            </button>
          </div>
        )}
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
            threadAttachments={threadAttachments}
            threadUsage={threadUsage}
            models={models}
            providerProfiles={providerProfiles}
            modelCatalogError={modelCatalogError}
            modelUpdateError={modelUpdateError}
            onDraftChange={(threadId, draft) =>
              updateComposer(threadId, (state) => editComposer(state, draft))
            }
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
            onPickImages={async (threadId) => {
              const images = await window.zenx.imageAttachments.pick();
              updateComposer(threadId, (state) =>
                addComposerImages(state, images),
              );
            }}
            onRemoveImage={(threadId, imageId) =>
              updateComposer(threadId, (state) =>
                removeComposerImage(state, imageId),
              )
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
            hasProjects={projects.projects.some(
              (project) => project.configured,
            )}
            hasLastUsedProject={lastUsedWorkspace !== null}
            onAddProject={() => setProjectPickerIntent("add-project")}
            onNewThread={() => {
              if (lastUsedWorkspace !== null) void newThread(lastUsedWorkspace);
              else setProjectPickerIntent("new-thread");
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
            requestError={projectError ?? requestError}
            selectedSettings={selectedSettings}
            selectedSummary={selectedSummary}
            serverStatus={serverStatus}
            switchingModel={switchingModel}
            threadArchiving={
              threadDetail !== null && archivingThreadIds.has(threadDetail.id)
            }
            threadDetail={threadDetail}
            threadError={threadError}
            threadLoading={threadLoading || newThreadPending}
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
              setProjectPickerIntent(null);
              void newThread(workspace);
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
  threadAttachments,
  threadUsage,
  models,
  providerProfiles,
  modelCatalogError,
  modelUpdateError,
  onDraftChange,
  onImportImages,
  onPickImages,
  onReadAttachment,
  onRemoveImage,
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
  requestError,
  selectedSettings,
  selectedSummary,
  serverStatus,
  switchingModel,
  threadArchiving,
  threadDetail,
  threadError,
  threadLoading,
  titleProjection,
}: {
  approvals: ApprovalCardState[];
  pluginSnapshot: ZenXPluginSnapshot | null;
  composerStates: Record<string, ComposerState>;
  threadAttachments: ZenXThreadAttachmentProjection;
  threadUsage: ModelUsageProjection | undefined;
  models: ModelSummary[];
  providerProfiles: ZenXProviderProfile[];
  modelCatalogError: string | null;
  modelUpdateError: string | null;
  onDraftChange(threadId: string, draft: string): void;
  onImportImages(threadId: string, files: readonly File[]): Promise<void>;
  onPickImages(threadId: string): Promise<void>;
  onReadAttachment(
    attachment: import("../../../../../src/attachment.js").AttachmentRef,
  ): Promise<Uint8Array>;
  onRemoveImage(threadId: string, imageId: string): void;
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
  requestError: string | null;
  selectedSettings: SelectedThreadSettings | null;
  selectedSummary: NativeThreadSummary | null;
  serverStatus: AppServerHostStatus;
  switchingModel: boolean;
  threadArchiving: boolean;
  threadDetail: Thread | null;
  threadError: string | null;
  threadLoading: boolean;
  titleProjection: ThreadTitleProjection | undefined;
}) {
  return (
    <section className="agent-surface">
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
      </header>

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
