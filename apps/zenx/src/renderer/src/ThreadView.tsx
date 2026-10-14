import { useReadVisibleMessage } from "./conversation-read-state.js";
import { HostMessageContent } from "./HostMessageContent.js";
import { ImportedThreadNotice } from "./ImportedThreadNotice.js";
import { projectThreadAttachmentItems } from "../../thread-attachment-projection.js";
import {
  ThreadReadingContext,
  useThreadReadingState,
  useReadingDisclosure,
  useReadingDisclosures,
  disclosureKey,
} from "./thread-reading-state.js";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import type { SkillEntry } from "../../../../cli/src/skills.js";
import { parseSkillDraft, withSkillDraft } from "./skill-draft.js";
import {
  commandStatus,
  commandPhaseLabel,
  commandPhase,
  toolPresentation,
  commandTitle,
} from "./tool-presentation.js";
import { isCompactCommand } from "./compact-command.js";
import { createPortal } from "react-dom";
import {
  createContext,
  useEffect,
  useContext,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { AttachmentRef } from "../../../../../src/attachment.js";
import type { FailureItem } from "../../../../../src/item.js";
import { pendingQueuedMessages } from "../../../../../src/input-queue.js";
import type {
  NativeQueueEditParams,
  NativeQueueEditResult,
} from "../../../../../src/protocol/native/wire.js";
import type {
  QueuedCancellationResult,
  QueuedCancellationTarget,
} from "../../../../../src/app-server.js";
import type {
  ModelContextUsageProjection,
  ModelUsageAggregate,
  ModelUsageProjection,
} from "../../../../../src/model-usage.js";

import type { ApprovalDecision } from "../../main/app-server-manager.js";
import type { TriggerHistoryEntry } from "../../main/trigger-types.js";
import type { ZenXProviderProfile } from "../../main/host-profile.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type {
  ModelSummary,
  Thread,
  ThreadItem,
  Turn,
} from "../../protocol-client/index.js";
import type { ApprovalCardState } from "./approval-state.js";
import {
  composerDraftHasContent,
  defaultComposerIntent,
  type ComposerSendMode,
  type ComposerDraftImage,
  type ComposerIntent,
  type ComposerState,
  type ComposerDraft,
} from "./composer-state.js";
import type { ZenXThreadAttachmentProjection } from "../../main/image-attachments.js";
import { ComposerShell, ComposerEditor } from "./Composer.js";
import { handleComposerSuggestionKey } from "./ComposerSuggestions.js";
import { ComposerSendControl } from "./ComposerSendControl.js";
import { ComposerModelMenu } from "./ComposerModelMenu.js";
import { Icon } from "./icons.js";
import { ActivityText } from "./ActivityText.js";
import { ApprovalRequestCard } from "./ApprovalRequestCard.js";
import { QueuedMessages } from "./QueuedMessages.js";
import { QueuedMessageEditor } from "./QueuedMessageEditor.js";
import { queuedInputDraft, queuedDraftInput } from "./queue-edit-draft.js";
import {
  createQueueEditStore,
  type QueueEditStore,
  type QueueEditSession,
} from "./queue-edit-state.js";
import {
  projectQueuedImages,
  sameImageAttachment,
} from "./queued-message-images.js";
import { PermissionSelect } from "./PermissionSelect.js";
import type { FilePermissionMode } from "../../protocol-client/types.js";
import type { ModelMessage } from "../../../../../src/model.js";
import { Markdown, MessageLinkContext } from "./Markdown.js";
import {
  AttachmentImage,
  ImagePreview,
  ThreadImagesContext,
  ToolImages,
} from "./ImagePresentation.js";
import { activeTurn } from "./thread-view-state.js";
import type { PluginUiRegistry } from "./plugin-ui-host.js";
import { ToolResultRenderer } from "./ToolResultRenderer.js";
import {
  groupReasoningWithoutDetailsRows,
  projectTurn,
  createTraceObservationIndex,
  summarizeTraceActivity,
  observedCommandPhase,
  traceSummary,
  type TraceObservationIndex,
  type TraceActivity,
  traceDisplayRows,
  type TurnDisplayNode,
} from "./turn-projection.js";
import { WorkflowCommandMenu } from "./WorkflowCommandMenu.js";
import type { WorkflowCommand } from "./workflow-commands.js";
import { useComposerSelector } from "./use-composer-selector.js";
import { Dialog } from "./ui/controls.js";
import {
  compactionInitiatorLabel,
  projectContextCompactions,
  type ContextCompactionProjection,
} from "./context-compaction-projection.js";

export type MessageForkTarget = { sourceThreadId: string; itemId: string };
export type MessageForkHandler = (
  target: MessageForkTarget,
  owner: { isCurrent(): boolean; isVisible(): boolean },
) => Promise<void>;
/** App-owned request handling is shared by main and embedded Thread viewports. */
export const MessageForkContext = createContext<MessageForkHandler | null>(
  null,
);
const CanonicalMessageForkContext = createContext<{
  threadId: string;
  items: Map<string, string | undefined>;
  isCurrent(itemId: string): boolean;
} | null>(null);

interface ThreadViewProps {
  composerId?: string;
  composerSendMode?: ComposerSendMode;
  onComposerSendModeChange?(mode: ComposerSendMode): Promise<void>;
  queueFailure?: {
    queuedItemId: string;
    clientId?: string;
    attemptId?: string;
    revision?: number;
    code: string;
    message: string;
  } | null;
  onResumeQueue?(): Promise<void>;
  queueEditStore?: QueueEditStore;
  onEditQueued?(params: NativeQueueEditParams): Promise<NativeQueueEditResult>;
  onImportQueueImages?(files: readonly File[]): Promise<ComposerDraftImage[]>;
  onPickQueueImages?(): Promise<ComposerDraftImage[]>;
  onCancelQueued?(
    targets: readonly QueuedCancellationTarget[],
  ): Promise<{ results: QueuedCancellationResult[] }>;
  approvals: readonly ApprovalCardState[];
  composer: ComposerState;
  composerContext?: ReactNode;
  composerContextPosition?: "before" | "after";
  composerDisabled?: boolean;
  emptyContent?: ReactNode;
  modelDisabled?: boolean;
  modelError?: string | null;
  imageCapabilityError?: string | null;
  imageCapabilityNotice?: string | null;
  models?: readonly ModelSummary[];
  permissionLabel?: string | null;
  permissionMode?: FilePermissionMode;
  permissionError?: string | null;
  switchingPermission?: boolean;
  onPermissionChange?(mode: FilePermissionMode): void;
  providerProfiles?: readonly ZenXProviderProfile[];
  selectedModel?: string;
  selectedReasoningEffort?: string | null;
  switchingModel?: boolean;
  thread: Thread | null;
  threadAttachments?: ZenXThreadAttachmentProjection;
  threadUsage?: ModelUsageProjection;
  wakeups?: readonly TriggerHistoryEntry[];
  watching?: boolean;
  workflowCommands?: readonly WorkflowCommand[];
  pluginSnapshot?: ZenXPluginSnapshot | null;
  pluginUiRegistry?: PluginUiRegistry | null;
  onDraftChange(draft: string): void;
  onOpenMessageLink?(target: { kind: "file" | "browser"; value: string }): void;
  onImportImages?(files: readonly File[]): Promise<void>;
  onPickImages?(): Promise<void>;
  onRemoveImage?(imageId: string): void;
  onReadAttachment?(attachment: AttachmentRef): Promise<Uint8Array>;
  onInterrupt(turnId: string): Promise<void>;
  onCompact?(): Promise<void>;
  onDismissCompaction?(): void;
  onModelChange?(model: string): void;
  onReasoningChange?(effort: string): void;
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  onSubmit(
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ): Promise<void>;
}

export function ThreadView(props: ThreadViewProps) {
  const readingState = useThreadReadingState(props.thread?.id);
  const items = props.thread?.canonicalItems;
  const canonicalAttachments = useMemo(
    () =>
      items === undefined ? undefined : projectThreadAttachmentItems(items),
    [items],
  );
  const forkSource = useMemo(
    () =>
      props.thread === null
        ? null
        : {
            threadId: props.thread.id,
            items: new Map(
              (items ?? [])
                .filter(
                  (item) =>
                    item.type === "agent_message" &&
                    item.threadId === props.thread?.id,
                )
                .map((item) => [item.id, item.turnId]),
            ),
          },
    [props.thread?.id, items],
  );
  const forkSourceRef = useRef(forkSource);
  forkSourceRef.current = forkSource;
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const forkContext =
    forkSource === null
      ? null
      : {
          ...forkSource,
          // A Turn finishing may fold or remount its message controls. Only leaving
          // the source viewport or losing the canonical Item invalidates ownership.
          isCurrent: (itemId: string) =>
            mounted.current &&
            forkSourceRef.current?.threadId === forkSource.threadId &&
            forkSourceRef.current.items.has(itemId),
        };
  // Native history and its image placeholders commit together, even while a
  // separate media refresh/payload read is pending. A newer canonical snapshot
  // also removes old references synchronously; never merge stale Host results.

  return (
    <ThreadReadingContext.Provider value={readingState}>
      <CanonicalMessageForkContext.Provider value={forkContext}>
        <ThreadViewContent
          {...props}
          threadAttachments={canonicalAttachments ?? props.threadAttachments}
        />
      </CanonicalMessageForkContext.Provider>
    </ThreadReadingContext.Provider>
  );
}

function ThreadViewContent({
  composerId = "thread-composer",
  composerSendMode = "soft",
  onComposerSendModeChange,
  queueFailure: suppliedQueueFailure = null,
  onResumeQueue,
  onCancelQueued,
  onEditQueued,
  queueEditStore,
  onImportQueueImages,
  onPickQueueImages,
  approvals,
  composer,
  composerContext = null,
  composerContextPosition = "before",
  composerDisabled = false,
  emptyContent = null,
  modelDisabled = false,
  modelError = null,
  imageCapabilityError = null,
  imageCapabilityNotice = null,
  models = [],
  permissionLabel = i18n.t("shell:fullAccess"),
  permissionMode = "danger-full-access",
  permissionError,
  switchingPermission,
  onPermissionChange,
  providerProfiles = [],
  selectedModel,
  selectedReasoningEffort = null,
  switchingModel = false,
  thread,
  threadAttachments = {},
  threadUsage,
  wakeups = [],
  watching = false,
  workflowCommands = [],
  pluginSnapshot = null,
  pluginUiRegistry = null,
  onDraftChange,
  onImportImages = async () => undefined,
  onPickImages = async () => undefined,
  onRemoveImage = () => undefined,
  onReadAttachment = async () => {
    throw new Error(i18n.t("shell:imageReaderUnavailable"));
  },
  onInterrupt,
  onCompact,
  onDismissCompaction,
  onModelChange,
  onReasoningChange,
  onRespondToApproval,
  onSubmit,
  onOpenMessageLink,
}: ThreadViewProps) {
  useTranslation("shell");
  const readingState = useContext(ThreadReadingContext)!;
  const queueFailure =
    suppliedQueueFailure &&
    thread?.queuedMessages?.some(
      (message) =>
        message.id === suppliedQueueFailure.queuedItemId &&
        (suppliedQueueFailure.clientId === undefined ||
          message.clientId === suppliedQueueFailure.clientId) &&
        (message.revision ?? 0) === (suppliedQueueFailure.revision ?? 0),
    )
      ? suppliedQueueFailure
      : null;
  const [stoppingRun, setStoppingRun] = useState<string | null>(null);
  const stopRequestRef = useRef<object | null>(null);
  const activeRunRef = useRef<string | null>(null);
  const currentThreadRef = useRef<string | null>(null);
  currentThreadRef.current = thread?.id ?? null;
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [queueResumeError, setQueueResumeError] = useState<{
    threadId: string;
    queuedItemId: string;
    clientId: string;
    revision: number;
    matchingFailureAttemptId: string | null;
    message: string;
  } | null>(null);
  const currentQueueFailureRef = useRef(queueFailure);
  currentQueueFailureRef.current = queueFailure;
  const cancelLocks = useRef(new Map<string, Set<string>>());
  const resumeLocks = useRef(new Set<string>());
  const editLocks = useRef(new Set<string>());
  const editOwner = useRef(Symbol("queue editor viewport"));
  const [localEditStore] = useState(createQueueEditStore);
  const editStore = queueEditStore ?? localEditStore;
  const editSessions = useSyncExternalStore(
    editStore.subscribe,
    editStore.getSnapshot,
    editStore.getSnapshot,
  );
  // Async callbacks from an unmounted viewport still address the App-owned cache.
  const editSessionsRef = useMemo(
    () => ({
      get current() {
        return editStore.getSnapshot();
      },
    }),
    [editStore],
  );
  const [openEditKey, setOpenEditKey] = useState<string | null>(null);
  const updateEditSession = editStore.set;
  useEffect(() => {
    const owner = editOwner.current;
    return () => {
      for (const [key, session] of Object.entries(editStore.getSnapshot())) {
        if (session.owner === owner)
          editStore.set(key, { ...session, owner: undefined });
      }
    };
  }, [editStore, thread?.id]);
  const nativeQueue = useMemo(
    () => pendingQueuedMessages(thread?.canonicalItems ?? []),
    [thread?.canonicalItems],
  );
  const observedEdit = (session: QueueEditSession) =>
    session.confirmed !== undefined &&
    thread?.id === session.threadId &&
    thread.canonicalItems?.some(
      (item) =>
        item.type === "user_message_queue_edited" &&
        item.id === session.confirmed!.editItemId &&
        item.threadId === session.threadId &&
        item.queuedItemId === session.queuedItemId &&
        item.clientId === session.clientId &&
        item.revision === session.confirmed!.revision &&
        item.editId === session.attempt?.editId &&
        JSON.stringify(item.input) === session.attempt?.fingerprint,
    ) === true;
  useEffect(() => {
    for (const [key, session] of Object.entries(editSessionsRef.current)) {
      if (session.owner === undefined && observedEdit(session))
        updateEditSession(key, null);
    }
  }, [thread?.canonicalItems, thread?.id, openEditKey, editSessions]);
  const editableQueue = new Map(
    nativeQueue.flatMap((item) => {
      if (
        item.type !== "user_message_queued" ||
        !thread?.queuedMessages?.some(
          (message) =>
            message.id === item.id && message.clientId === item.clientId,
        )
      )
        return [];
      const draft = queuedInputDraft(item.input, item.id);
      return draft === null ? [] : [[item.id, { item, draft }] as const];
    }),
  );
  const [, invalidateQueue] = useState(0);
  const cancelingQueue = thread !== null && cancelLocks.current.has(thread.id);
  const resumingQueue = thread !== null && resumeLocks.current.has(thread.id);
  const editingQueue =
    thread !== null &&
    (editLocks.current.has(thread.id) || editStore.isPending(thread.id));
  const [cancelConfirmation, setCancelConfirmation] = useState<{
    threadId: string;
    targets: QueuedCancellationTarget[];
    previews: string[];
    trigger: HTMLButtonElement;
  } | null>(null);
  const [cancelNotice, setCancelNotice] = useState<{
    threadId: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    setCancelConfirmation(null);
    setCancelNotice(null);
  }, [thread?.id]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingImages, setDraggingImages] = useState(false);
  const [preview, setPreview] = useState<{
    attachment: AttachmentRef;
    name: string;
    trigger: HTMLButtonElement;
    queueOwner?: { threadId: string; queuedItemId: string; clientId: string };
  } | null>(null);
  const queuedImages = useMemo(
    () => projectQueuedImages(thread),
    [thread?.canonicalItems, thread?.queuedMessages],
  );
  const queuedImageScope = useRef({
    threadId: thread?.id,
    images: queuedImages,
  });
  queuedImageScope.current = { threadId: thread?.id, images: queuedImages };
  const readQueuedImage = useCallback(
    async (attachment: AttachmentRef) => {
      const scope = queuedImageScope.current;
      if (
        scope.threadId !== thread?.id ||
        !Object.values(scope.images).some((images) =>
          images.some((image) => sameImageAttachment(image, attachment)),
        )
      ) {
        throw new Error(i18n.t("panels:imageUnavailable"));
      }
      return await onReadAttachment(attachment);
    },
    [thread?.id, onReadAttachment],
  );
  const queuePreviewCurrent =
    preview?.queueOwner === undefined ||
    (preview.queueOwner.threadId === thread?.id &&
      thread.queuedMessages?.some(
        (message) =>
          message.id === preview.queueOwner!.queuedItemId &&
          message.clientId === preview.queueOwner!.clientId,
      ) === true &&
      queuedImages[preview.queueOwner.queuedItemId]?.some((image) =>
        sameImageAttachment(image, preview.attachment),
      ) === true);
  useEffect(() => {
    if (!queuePreviewCurrent) setPreview(null);
  }, [queuePreviewCurrent]);
  const [atLive, setAtLive] = useState(readingState.scroll?.following ?? true);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillError, setSkillError] = useState<string | null>(null);
  const skillDraft = parseSkillDraft(composer.draft.text);
  useEffect(() => {
    if (window.zenx?.skills === undefined) return;
    let active = true;
    void window.zenx.skills
      .list()
      .then((value) => {
        if (active) {
          setSkills(value.skills);
          setSkillError(value.errors.join("\n") || null);
        }
      })
      .catch((error: unknown) => active && setSkillError(String(error)));
    return () => {
      active = false;
    };
  }, [thread?.id, composer.draft.text.startsWith("/")]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(readingState.scroll?.following ?? true);
  const viewRef = useRef<HTMLDivElement>(null);
  const bottomZoneRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const lastCanonicalAgentMessage = thread?.canonicalItems?.findLast(
    (item) => item.type === "agent_message",
  );
  const readMessageOrder = useMemo(
    () =>
      thread?.canonicalItems?.flatMap((item) =>
        item.type === "agent_message" ? [item.id] : [],
      ),
    [thread?.canonicalItems],
  );
  useReadVisibleMessage({
    scope: "threads",
    conversationId: thread?.id,
    message: lastCanonicalAgentMessage
      ? {
          id: lastCanonicalAgentMessage.id,
          createdAt: Date.parse(lastCanonicalAgentMessage.createdAt),
        }
      : undefined,
    messageOrder: readMessageOrder,
    viewport: scrollRef,
    occluder: bottomZoneRef,
  });
  const runningTurn = thread === null ? null : activeTurn(thread);
  const runKey =
    thread && runningTurn ? JSON.stringify([thread.id, runningTurn.id]) : null;
  activeRunRef.current = runKey;
  const interrupting = runKey !== null && stoppingRun === runKey;
  useEffect(() => {
    stopRequestRef.current = null;
    setStoppingRun(null);
    setInterruptError(null);
  }, [runKey]);
  const turns = thread?.turns ?? [];
  const contextCompactions = useMemo(
    () => projectContextCompactions(thread?.canonicalItems),
    [thread?.canonicalItems],
  );
  const transcriptRows = useMemo(
    () =>
      buildTranscriptRows(turns, thread?.canonicalItems, contextCompactions),
    [contextCompactions, thread?.canonicalItems, turns],
  );
  const pendingApprovals = approvals.filter(
    (approval) => approval.params.threadId === thread?.id,
  );
  const compactRequested = isCompactCommand(composer.draft.text);
  const submitting =
    composer.submission?.status === "pending" ||
    composer.compaction?.status === "pending";
  const hasDraft = composerDraftHasContent(composer.draft);
  const blockedByImageCapability =
    !compactRequested &&
    composer.draft.images.length > 0 &&
    imageCapabilityError !== null;
  const selector = useComposerSelector({
    draft: composer.draft.text,
    threadId: thread?.id,
    commands: workflowCommands,
    skills,
    onChange: onDraftChange,
    textarea: composerTextareaRef,
  });
  const selectorId = useId();

  const saveReadingPosition = useCallback(() => {
    const scroll = scrollRef.current;
    if (scroll)
      readingState.scroll = {
        top: scroll.scrollTop,
        following: shouldFollowRef.current,
      };
  }, [readingState]);
  const pauseFollowing = useCallback(() => {
    shouldFollowRef.current = false;
    setAtLive(false);
    saveReadingPosition();
  }, [saveReadingPosition]);
  const followBottom = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll || !shouldFollowRef.current) return;
    if (transcriptHasSelection(scroll)) {
      pauseFollowing();
      return;
    }
    scroll.scrollTop = scroll.scrollHeight;
    saveReadingPosition();
  }, [pauseFollowing, saveReadingPosition]);

  // The Composer overlays the bottom of the full-height transcript scroll
  // area. Publish its live height so the list reserves matching virtual
  // space and Back to live can float just above it. This is geometry only;
  // publishing a height never changes the reader's follow intent. Re-publish
  // on identity changes too: cached App navigation reuses this same DOM.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const zone = bottomZoneRef.current;
    if (view === null || zone === null) return;
    const publish = () => {
      const height = `${Math.round(zone.getBoundingClientRect().height)}px`;
      if (view.style.getPropertyValue("--bottom-zone-height") === height)
        return;
      view.style.setProperty("--bottom-zone-height", height);
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(zone);
    return () => {
      observer.disconnect();
    };
  }, [readingState]);

  // Restore only after this thread's Composer inset above has been published.
  // Otherwise scrollTop clamps to the temporary CSS fallback range and saving
  // that clamp loses near-bottom positions, especially with a tall draft.
  // This finishes synchronously: no delayed restore can override later input.
  // A new thread opens at live.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const saved = readingState.scroll;
    shouldFollowRef.current = saved?.following ?? true;
    scroll.scrollTop = saved?.top ?? scroll.scrollHeight;
    setAtLive(shouldFollowRef.current);
    saveReadingPosition();
  }, [readingState, saveReadingPosition]);

  // New transcript data may advance a live reader. Approvals, focus and Composer
  // layout are not new messages and must not independently pull an idle reader.
  const latestTurn = turns.at(-1);
  const transcriptArrival = JSON.stringify([
    thread?.id,
    turns.length,
    latestTurn?.id,
    latestTurn?.status,
    latestTurn?.items.length,
    latestTurn?.items.at(-1)?.id,
    thread?.canonicalItems?.length,
    thread?.canonicalItems?.at(-1)?.id,
  ]);
  useEffect(() => {
    followBottom();
  }, [followBottom, transcriptArrival]);

  useEffect(() => {
    const selection = () => {
      if (transcriptHasSelection(scrollRef.current)) pauseFollowing();
    };
    document.addEventListener("selectionchange", selection);
    return () => document.removeEventListener("selectionchange", selection);
  }, [pauseFollowing]);
  const streamingRef = useRef(false);
  streamingRef.current = runningTurn !== null;
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = scroll?.firstElementChild;
    if (!scroll || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (streamingRef.current) followBottom();
      else if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 1)
        pauseFollowing();
      // Idle layout changes can expose a Back to live action, never activate it.
    });
    observer.observe(content);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [followBottom, pauseFollowing]);

  // Keep a newly failed request visible when approvals, queued messages and a
  // long draft overflow the bottom zone. User scrolling afterwards is left
  // alone; focus can still scroll the queue and approval controls into view.
  useLayoutEffect(() => {
    if (composer.compaction?.status !== "failed") return;
    const zone = bottomZoneRef.current;
    if (zone !== null) zone.scrollTop = zone.scrollHeight;
  }, [composer.compaction, thread?.id]);

  const submit = (intent: ComposerIntent) => {
    if (composerDisabled || !hasDraft || submitting || blockedByImageCapability)
      return;
    if (intent === "start" && runningTurn !== null) return;
    if (intent !== "start" && runningTurn === null) return;
    void onSubmit(intent, runningTurn?.id ?? null);
  };

  const interrupt = async () => {
    if (
      composerDisabled ||
      runningTurn === null ||
      runKey === null ||
      interrupting ||
      submitting ||
      stopRequestRef.current !== null
    )
      return;
    const token = {};
    stopRequestRef.current = token;
    const key = runKey;
    setStoppingRun(key);
    setInterruptError(null);
    try {
      await onInterrupt(runningTurn.id);
      // The acknowledgement only accepts the request. Canonical terminal evidence ends it.
    } catch (error) {
      if (activeRunRef.current !== key || stopRequestRef.current !== token)
        return;
      setInterruptError(describeError(error));
      setStoppingRun(null);
      stopRequestRef.current = null;
    }
  };

  const sendIntent = defaultComposerIntent(
    runningTurn !== null,
    composerSendMode,
  );
  const primaryMode =
    runningTurn === null ? "send" : !hasDraft ? "stop" : sendIntent;
  const intentLabel = (intent: ComposerIntent) =>
    intent === "batch-next"
      ? i18n.t("shell:nextTurn")
      : intent === "queue"
        ? i18n.t("shell:eachTurn")
        : intent === "steer"
          ? i18n.t("shell:steerNow")
          : intent === "replace"
            ? i18n.t("shell:interruptAndSend")
            : i18n.t("shell:send");
  const primaryLabel = compactRequested
    ? i18n.t("shell:compactContext")
    : primaryMode === "stop"
      ? i18n.t(interrupting ? "shell:stopping" : "shell:stop")
      : intentLabel(sendIntent);
  const primary = () => {
    if (primaryMode === "stop") void interrupt();
    else submit(sendIntent);
  };
  const saveQueuedEdit = async (key: string, draft: ComposerDraft) => {
    const session = editSessionsRef.current[key];
    if (
      !session ||
      session.owner !== editOwner.current ||
      session.confirmed ||
      session.pending ||
      !onEditQueued ||
      composerDisabled ||
      currentThreadRef.current !== session.threadId ||
      editLocks.current.has(session.threadId) ||
      editStore.isPending(session.threadId) ||
      cancelLocks.current.has(session.threadId) ||
      resumeLocks.current.has(session.threadId)
    ) {
      throw new Error(i18n.t("shell:queueEditBusy"));
    }
    const input = queuedDraftInput(draft);
    const fingerprint = JSON.stringify(input);
    const attempt =
      session.attempt?.fingerprint === fingerprint
        ? session.attempt
        : { editId: crypto.randomUUID(), fingerprint };
    editLocks.current.add(session.threadId);
    updateEditSession(key, {
      ...session,
      draft,
      attempt,
      pending: true,
      error: null,
    });
    try {
      const result = await onEditQueued({
        threadId: session.threadId,
        queuedItemId: session.queuedItemId,
        clientId: session.clientId,
        expectedRevision: session.expectedRevision,
        editId: attempt.editId,
        input,
      });
      if (
        typeof result.editItemId !== "string" ||
        result.editItemId.length === 0 ||
        result.queuedItemId !== session.queuedItemId ||
        result.clientId !== session.clientId ||
        result.revision !== session.expectedRevision + 1 ||
        !["edited", "already_edited"].includes(result.status)
      )
        throw new Error(i18n.t("shell:queueEditUnconfirmed"));
      const current = editSessionsRef.current[key];
      if (current?.identity === session.identity)
        updateEditSession(key, {
          ...current,
          pending: false,
          error: null,
          confirmed: {
            editItemId: result.editItemId,
            revision: result.revision,
          },
        });
    } catch (error) {
      const current = editSessionsRef.current[key];
      if (current?.identity === session.identity)
        updateEditSession(key, {
          ...current,
          pending: false,
          error: describeError(error),
        });
      throw error;
    } finally {
      editLocks.current.delete(session.threadId);
      invalidateQueue((n) => n + 1);
    }
  };
  const cancelQueued = async (targets: readonly QueuedCancellationTarget[]) => {
    if (
      thread === null ||
      onCancelQueued === undefined ||
      composerDisabled ||
      currentThreadRef.current !== thread.id ||
      targets.length === 0 ||
      cancelLocks.current.has(thread.id) ||
      resumeLocks.current.has(thread.id) ||
      editLocks.current.has(thread.id) ||
      editStore.isPending(thread.id)
    )
      return;
    const threadId = thread.id;
    cancelLocks.current.set(
      threadId,
      new Set(targets.map((target) => target.queuedItemId)),
    );
    invalidateQueue((n) => n + 1);
    setCancelNotice(null);
    try {
      const result = await onCancelQueued(targets);
      const started = result.results.filter(
        (entry) => entry.status === "already_started",
      ).length;
      const missing = result.results.filter(
        (entry) => entry.status === "not_found",
      ).length;
      if ((started > 0 || missing > 0) && currentThreadRef.current === threadId)
        setCancelNotice({
          threadId,
          message: i18n.t("shell:queueCancelPartial", { started, missing }),
        });
    } catch (error) {
      if (currentThreadRef.current === threadId)
        setCancelNotice({ threadId, message: describeError(error) });
    } finally {
      cancelLocks.current.delete(threadId);
      invalidateQueue((n) => n + 1);
    }
  };
  const resumeQueue = async () => {
    if (
      !thread ||
      !onResumeQueue ||
      composerDisabled ||
      runningTurn !== null ||
      currentThreadRef.current !== thread.id ||
      resumeLocks.current.has(thread.id) ||
      cancelLocks.current.has(thread.id) ||
      editLocks.current.has(thread.id) ||
      editStore.isPending(thread.id)
    )
      return;
    const threadId = thread.id;
    const head = thread.queuedMessages?.[0];
    if (!head) return;
    const attemptedMessages = thread.queuedMessages ?? [];
    const previousFailureAttemptId = currentQueueFailureRef.current?.attemptId;
    resumeLocks.current.add(threadId);
    invalidateQueue((n) => n + 1);
    setQueueResumeError(null);
    try {
      await onResumeQueue();
    } catch (error) {
      if (currentThreadRef.current === threadId) {
        const message = describeError(error);
        const failure = currentQueueFailureRef.current;
        // Correlate only a new native attempt observed during this request.
        // An old failure with identical wording must not hide a new transport error.
        const matchingFailureAttemptId =
          failure?.attemptId &&
          failure.attemptId !== previousFailureAttemptId &&
          failure.message === message &&
          attemptedMessages.some(
            (entry) =>
              entry.id === failure.queuedItemId &&
              (failure.clientId === undefined ||
                entry.clientId === failure.clientId),
          )
            ? failure.attemptId
            : null;
        setQueueResumeError({
          threadId,
          queuedItemId: head.id,
          clientId: head.clientId,
          revision: head.revision ?? 0,
          matchingFailureAttemptId,
          message,
        });
      }
    } finally {
      resumeLocks.current.delete(threadId);
      invalidateQueue((n) => n + 1);
    }
  };
  const visibleResumeError =
    queueResumeError !== null &&
    queueResumeError.threadId === thread?.id &&
    thread?.queuedMessages?.some(
      (entry) =>
        entry.id === queueResumeError.queuedItemId &&
        entry.clientId === queueResumeError.clientId &&
        (entry.revision ?? 0) === queueResumeError.revision,
    ) &&
    !(
      queueResumeError.matchingFailureAttemptId !== null &&
      queueResumeError.matchingFailureAttemptId === queueFailure?.attemptId &&
      queueResumeError.message === queueFailure.message
    )
      ? (queueResumeError?.message ?? null)
      : null;
  const respondToApproval = async (
    requestId: string,
    decision: ApprovalDecision,
  ) => {
    const threadId = thread?.id;
    const ownsFocus = (element: EventTarget | null) => {
      const request =
        element instanceof Element
          ? element.closest("[data-approval-request]")
          : null;
      return (
        request?.getAttribute("data-approval-request") === requestId &&
        request.getAttribute("data-approval-thread") === threadId
      );
    };
    const owned = ownsFocus(document.activeElement);
    const composer = composerTextareaRef.current;
    const knownRequests = new Set(
      pendingApprovals.map((item) => item.requestId),
    );
    let focusMoved = false;
    const trackFocus = (event: FocusEvent) => {
      if (event.target !== document.body && !ownsFocus(event.target))
        focusMoved = true;
    };
    if (owned) document.addEventListener("focusin", trackFocus);
    try {
      await onRespondToApproval(requestId, decision);
    } catch (error) {
      document.removeEventListener("focusin", trackFocus);
      throw error;
    }
    if (!owned) return;
    // Let the card close its modal before moving focus outside Radix's trap.
    // Recheck ownership after that commit rather than trusting the click time.
    requestAnimationFrame(() => {
      document.removeEventListener("focusin", trackFocus);
      if (
        focusMoved ||
        currentThreadRef.current !== threadId ||
        !composer?.isConnected ||
        composerTextareaRef.current !== composer ||
        document.getSelection()?.isCollapsed === false
      )
        return;
      const active = document.activeElement;
      const replaced = [
        ...document.querySelectorAll("[data-approval-request]"),
      ].some(
        (element) =>
          element.getAttribute("data-approval-thread") === threadId &&
          !knownRequests.has(
            element.getAttribute("data-approval-request") ?? "",
          ),
      );
      if (ownsFocus(active) || (active === document.body && !replaced))
        composer.focus({ preventScroll: true });
    });
  };
  const composerError =
    interruptError ??
    attachmentError ??
    (blockedByImageCapability ? imageCapabilityError : null) ??
    (composer.submission?.draftRevision === composer.draftRevision
      ? composer.submission.error
      : null) ??
    modelError;

  return (
    <div
      className={`thread-view${draggingImages ? " image-dragging" : ""}`}
      ref={viewRef}
      onDragEnter={(event) => {
        if (composerDisabled || submitting) return;
        if (hasImageFiles(event.dataTransfer.files)) setDraggingImages(true);
      }}
      onDragOver={(event) => {
        if (composerDisabled || submitting) return;
        if (!hasImageFiles(event.dataTransfer.files)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDraggingImages(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDraggingImages(false);
      }}
      onDrop={(event) => {
        if (composerDisabled || submitting) return;
        const files = imageFiles(event.dataTransfer.files);
        setDraggingImages(false);
        if (files.length === 0) return;
        event.preventDefault();
        setAttachmentError(null);
        void onImportImages(files).catch((error: unknown) =>
          setAttachmentError(describeError(error)),
        );
      }}
    >
      <div
        className="messages"
        ref={scrollRef}
        onWheel={(event) => {
          if (
            event.deltaY >= 0 ||
            isNestedTranscriptScroll(event.target, event.currentTarget)
          )
            return;
          pauseFollowing();
        }}
        onPointerDownCapture={(event) => {
          if (!isNestedTranscriptScroll(event.target, event.currentTarget))
            pauseFollowing();
        }}
        onFocusCapture={pauseFollowing}
        onKeyDownCapture={(event) => {
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(event.key) &&
            !isNestedTranscriptScroll(event.target, event.currentTarget)
          )
            pauseFollowing();
        }}
        onScroll={(event) => {
          const target = event.currentTarget;
          // A scroll event (including one generated by layout/anchoring) may
          // pause following, but proximity to bottom never resumes it.
          if (
            transcriptHasSelection(target) ||
            target.scrollHeight - target.scrollTop - target.clientHeight > 1
          )
            pauseFollowing();
          saveReadingPosition();
        }}
      >
        <MessageLinkContext.Provider value={onOpenMessageLink ?? null}>
          <ThreadImagesContext.Provider
            value={{
              cwd: thread?.cwd,
              attachments: threadAttachments,
              read: onReadAttachment,
              open: (attachment, name, trigger) =>
                setPreview({ attachment, name, trigger }),
            }}
          >
            <div className="messages-inner">
              <ImportedThreadNotice items={thread?.canonicalItems ?? []} />
              {transcriptRows.length === 0
                ? (emptyContent ?? (
                    <div className="thread-empty">
                      <h2>{i18n.t("shell:startANewThread")}</h2>
                      <p>{i18n.t("shell:describeOutcome")}</p>
                    </div>
                  ))
                : transcriptRows.map((row) =>
                    row.type === "turn" ? (
                      <TurnBlock
                        index={row.index}
                        key={JSON.stringify([thread?.id, row.turn.id])}
                        turn={row.turn}
                        stopping={
                          interrupting && row.turn.id === runningTurn?.id
                        }
                        approvals={pendingApprovals.filter(
                          (approval) => approval.params.turnId === row.turn.id,
                        )}
                        confirmedStopped={
                          thread?.canonicalItems?.some(
                            (item) =>
                              item.type === "turn_aborted" &&
                              item.turnId === row.turn.id,
                          ) ?? false
                        }
                        failureDetail={
                          thread?.canonicalItems?.find(
                            (item): item is FailureItem =>
                              item.type === "failure" &&
                              item.turnId === row.turn.id,
                          ) ?? null
                        }
                        onContinue={() =>
                          composerTextareaRef.current?.focus({
                            preventScroll: true,
                          })
                        }
                        usage={threadUsage?.turns[row.turn.id]}
                        wakeups={wakeups}
                        attachments={threadAttachments}
                        onOpenImage={(attachment, name, trigger) =>
                          setPreview({ attachment, name, trigger })
                        }
                        onReadAttachment={onReadAttachment}
                        pluginSnapshot={pluginSnapshot}
                        pluginUiRegistry={pluginUiRegistry}
                      />
                    ) : (
                      <ContextCompactionEvent
                        key={row.compaction.item.id}
                        projection={row.compaction}
                      />
                    ),
                  )}
              {composer.compaction?.status === "pending" ? (
                <ContextCompactionProgress state={composer.compaction} />
              ) : null}
            </div>
          </ThreadImagesContext.Provider>
        </MessageLinkContext.Provider>
      </div>

      {atLive ? null : (
        <button
          className="back-live"
          type="button"
          onClick={() => {
            const scroll = scrollRef.current;
            if (scroll === null) return;
            shouldFollowRef.current = true;
            document.getSelection()?.removeAllRanges();
            scroll.scrollTo({ top: scroll.scrollHeight, behavior: "auto" });
            setAtLive(true);
            saveReadingPosition();
          }}
        >
          <Icon name="arrow-down" size={14} />
          {i18n.t("shell:backToLive")}
        </button>
      )}

      <div
        className={`bottom-zone${pendingApprovals.length ? " has-approval" : ""}${thread?.queuedMessages?.length ? " has-queue" : ""}`}
        ref={bottomZoneRef}
      >
        {composerContextPosition === "before" ? composerContext : null}
        {pendingApprovals.map((approval) => (
          <ApprovalRequestCard
            composerId={composerId}
            threadId={thread!.id}
            approval={approval}
            key={`${thread!.id}:${approval.requestId}`}
            onRespond={respondToApproval}
          />
        ))}
        {thread ? (
          <QueuedMessages
            threadId={thread.id}
            messages={thread.queuedMessages ?? []}
            attachments={queuedImages}
            onReadAttachment={readQueuedImage}
            onOpenImage={(message, attachment, name, trigger) => {
              if (
                currentThreadRef.current !== thread.id ||
                !thread.queuedMessages?.some(
                  (current) =>
                    current.id === message.id &&
                    current.clientId === message.clientId,
                ) ||
                !queuedImages[message.id]?.some((image) =>
                  sameImageAttachment(image, attachment),
                )
              )
                return;
              setPreview({
                attachment,
                name,
                trigger,
                queueOwner: {
                  threadId: thread.id,
                  queuedItemId: message.id,
                  clientId: message.clientId,
                },
              });
            }}
            queueFailure={queueFailure}
            pendingIds={cancelLocks.current.get(thread.id)}
            busy={cancelingQueue || editingQueue || composerDisabled}
            editableIds={new Set(editableQueue.keys())}
            editingIds={
              new Set(
                Object.values(editSessions)
                  .filter(
                    (session) =>
                      session.threadId === thread.id && session.pending,
                  )
                  .map((session) => session.queuedItemId),
              )
            }
            onEdit={
              onEditQueued
                ? (target, trigger) => {
                    const candidate = editableQueue.get(target.id);
                    const key = JSON.stringify([
                      thread.id,
                      target.id,
                      target.clientId,
                    ]);
                    const previous = editSessionsRef.current[key];
                    const inspectingPending = previous?.pending === true;
                    if (
                      !candidate ||
                      candidate.item.clientId !== target.clientId ||
                      currentThreadRef.current !== thread.id ||
                      (!inspectingPending &&
                        (composerDisabled ||
                          cancelingQueue ||
                          resumingQueue ||
                          editStore.isPending(thread.id))) ||
                      (previous?.owner !== undefined &&
                        previous.owner !== editOwner.current)
                    )
                      return;
                    updateEditSession(
                      key,
                      previous && !observedEdit(previous)
                        ? { ...previous, trigger, owner: editOwner.current }
                        : {
                            owner: editOwner.current,
                            identity: JSON.stringify([
                              key,
                              candidate.item.revision,
                            ]),
                            threadId: thread.id,
                            queuedItemId: target.id,
                            clientId: target.clientId,
                            expectedRevision: candidate.item.revision,
                            draft: candidate.draft,
                            trigger,
                            pending: false,
                            error: null,
                          },
                    );
                    setOpenEditKey(key);
                  }
                : undefined
            }
            resuming={resumingQueue}
            resumeError={visibleResumeError}
            compact={pendingApprovals.length > 0}
            onCancel={
              onCancelQueued
                ? (target) => void cancelQueued([target])
                : undefined
            }
            onCancelAll={
              onCancelQueued
                ? (trigger) =>
                    setCancelConfirmation({
                      threadId: thread.id,
                      trigger,
                      targets: (thread.queuedMessages ?? []).map((message) => ({
                        queuedItemId: message.id,
                        clientId: message.clientId,
                      })),
                      previews: (thread.queuedMessages ?? []).map((message) =>
                        [
                          message.text,
                          message.imageCount > 0
                            ? i18n.t("shell:imageCount", {
                                count: message.imageCount,
                              })
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · "),
                      ),
                    })
                : undefined
            }
            onResume={
              runningTurn === null && onResumeQueue
                ? () => void resumeQueue()
                : undefined
            }
            focusComposer={() =>
              composerTextareaRef.current?.focus({ preventScroll: true })
            }
          />
        ) : null}
        {composer.compaction?.status === "failed" ? (
          <ContextCompactionProgress
            state={composer.compaction}
            onDismiss={onDismissCompaction}
          />
        ) : null}
        {cancelNotice !== null && cancelNotice.threadId === thread?.id ? (
          <p className="queued-cancel-notice" role="alert">
            {cancelNotice.message}
          </p>
        ) : null}
        <ComposerShell
          onSubmit={(event) => {
            event.preventDefault();
            primary();
          }}
        >
          {skillError !== null && (
            <p role="alert" className="settings-error">
              {skillError}
            </p>
          )}
          {skillDraft.skills.length > 0 && (
            <div
              className="composer-images"
              aria-label={i18n.t("shell:skillsToSend")}
            >
              {skillDraft.skills.map((skill) => (
                <button
                  type="button"
                  className="quiet-button"
                  key={skill.id}
                  aria-label={i18n.t("shell:removeSkill", {
                    name: skill.name,
                  })}
                  onClick={() =>
                    onDraftChange(
                      withSkillDraft(
                        skillDraft.text,
                        skillDraft.skills.filter(
                          (entry) => entry.id !== skill.id,
                        ),
                        skillDraft.references,
                      ),
                    )
                  }
                >
                  {skill.name} ×
                </button>
              ))}
            </div>
          )}
          {skillDraft.references.length > 0 && (
            <div
              className="composer-skills composer-references"
              aria-label={i18n.t("shell:referencesToSend")}
            >
              {skillDraft.references.map((reference, index) => (
                <span
                  className="composer-skill"
                  key={index}
                  title={`${reference.cwd} · ${reference.kind === "file" ? reference.path : reference.id}`}
                >
                  <Icon name={reference.kind === "file" ? "file" : "thread"} />
                  <span>{reference.name}</span>
                  <button
                    type="button"
                    aria-label={i18n.t("shell:removeReference", {
                      name: reference.name,
                    })}
                    onClick={() =>
                      onDraftChange(
                        withSkillDraft(
                          skillDraft.text,
                          skillDraft.skills,
                          skillDraft.references.filter((_, i) => i !== index),
                        ),
                      )
                    }
                  >
                    <Icon name="x" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <WorkflowCommandMenu
            id={selectorId}
            selector={selector}
            textarea={composerTextareaRef}
          />
          <label className="sr-only" htmlFor={composerId}>
            {i18n.t("panels:messageZenx")}
          </label>
          {composer.draft.images.length === 0 ? null : (
            <div
              className="composer-images"
              aria-label={i18n.t("shell:imagesToSend")}
            >
              {composer.draft.images.map((image) => (
                <DraftImage
                  image={image}
                  key={image.id}
                  onOpen={(trigger) =>
                    setPreview({
                      attachment: image.attachment,
                      name: image.name,
                      trigger,
                    })
                  }
                  onReadAttachment={onReadAttachment}
                  onRemove={() => onRemoveImage(image.id)}
                />
              ))}
            </div>
          )}
          <ComposerEditor
            id={composerId}
            aria-label={i18n.t("shell:message")}
            aria-controls={selector.open ? selectorId : undefined}
            aria-activedescendant={
              selector.open && selector.rows.length
                ? `${selectorId}-${selector.active}`
                : undefined
            }
            aria-describedby={selector.open ? `${selectorId}-hint` : undefined}
            onSelect={(event) => selector.select(event.currentTarget)}
            onBlur={() => selector.dismiss()}

            disabled={composerDisabled}
            onChange={(event) => {
              selector.reopen();
              selector.select(event.currentTarget ?? event.target);
              onDraftChange(
                withSkillDraft(
                  event.target.value,
                  skillDraft.skills,
                  skillDraft.references,
                ),
              );
            }}
            onPaste={(event) => {
              if (composerDisabled || submitting) return;
              const files = imageFiles(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              setAttachmentError(null);
              void onImportImages(files).catch((error: unknown) =>
                setAttachmentError(describeError(error)),
              );
            }}
            onKeyDown={(event) => {
              if (handleComposerSuggestionKey(event, selector)) return;
              if (event.key !== "Enter" || event.shiftKey) return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (event.repeat) return;
              submit(
                defaultComposerIntent(
                  runningTurn !== null,
                  composerSendMode,
                  event.metaKey || event.ctrlKey,
                ),
              );
            }}
            placeholder={
              runningTurn === null
                ? watching
                  ? i18n.t("shell:sendAMessageToWakeThisThread")
                  : i18n.t("shell:askZenxAnything")
                : composerSendMode === "queue" || composerSendMode === "batch"
                  ? i18n.t("shell:messageForTheNextTurn")
                  : i18n.t("shell:steerTheCurrentRun")
            }
            textareaRef={composerTextareaRef}
            rows={1}
            value={skillDraft.text}
          />
          <div className="composer-rail">
            <div className="composer-tools">
              <button
                className="composer-tool icon-only"
                type="button"
                aria-label={i18n.t("shell:addImages")}
                title={i18n.t("shell:addImages")}
                disabled={composerDisabled || submitting}
                onClick={() => {
                  setAttachmentError(null);
                  void onPickImages().catch((error: unknown) =>
                    setAttachmentError(describeError(error)),
                  );
                }}
              >
                <Icon name="paperclip" />
              </button>
              {selectedModel === undefined ? null : (
                <ComposerModelMenu
                  disabled={composerDisabled || modelDisabled}
                  modelError={modelError}
                  models={models}
                  onModelChange={(model) => onModelChange?.(model)}
                  onReasoningChange={(effort) => onReasoningChange?.(effort)}
                  providerProfiles={providerProfiles}
                  selectedModel={selectedModel}
                  selectedReasoningEffort={selectedReasoningEffort}
                  switching={switchingModel}
                />
              )}
              <ContextUsageIndicator
                context={threadUsage?.context}
                threadCacheHitRate={threadUsage?.thread.cacheHitRate}
                compactDisabled={
                  composerDisabled || runningTurn !== null || submitting
                }
                onCompact={onCompact}
              />
              {permissionLabel === null ? null : (
                <PermissionSelect
                  errorId={`${composerId}-permission-error`}
                  legacyApproval={
                    permissionLabel === i18n.t("shell:approvalRequired")
                  }
                  value={permissionMode}
                  disabled={
                    runningTurn !== null ||
                    composerDisabled ||
                    composer.submission?.status === "pending"
                  }
                  switching={switchingPermission ?? false}
                  error={permissionError ?? null}
                  onChange={onPermissionChange}
                />
              )}
            </div>
            <div className="composer-actions">
              <ComposerSendControl
                mode={composerSendMode}
                running={runningTurn !== null}
                hasDraft={hasDraft}
                compact={compactRequested}
                primaryMode={primaryMode}
                primaryLabel={primaryLabel}
                stopDisabled={composerDisabled || interrupting || submitting}
                sendDisabled={
                  composerDisabled || submitting || blockedByImageCapability
                }
                disabled={
                  composerDisabled ||
                  (interrupting && primaryMode === "stop") ||
                  submitting ||
                  (primaryMode === "send" && !hasDraft) ||
                  blockedByImageCapability
                }
                onPrimary={primary}
                onSend={submit}
                onStop={() => void interrupt()}
                onModeChange={onComposerSendModeChange}
              />
            </div>
          </div>
          {composerError !== null ? (
            <p
              className="composer-error"
              id={modelError === null ? undefined : `${composerId}-model-error`}
              role="alert"
            >
              {composerError}
            </p>
          ) : null}
          {composer.draft.images.length > 0 &&
          imageCapabilityNotice !== null &&
          !blockedByImageCapability ? (
            <p className="composer-note" role="status">
              {imageCapabilityNotice}
            </p>
          ) : null}
        </ComposerShell>
        {composerContextPosition === "after" ? composerContext : null}
      </div>
      {cancelConfirmation === null ? null : (
        <Dialog
          open={cancelConfirmation.threadId === thread?.id}
          restoreFocus={() => {
            if (currentThreadRef.current !== cancelConfirmation.threadId)
              return false;
            const active = document.activeElement;
            const trigger = cancelConfirmation.trigger;
            if (
              active === document.body ||
              active === trigger ||
              (active instanceof Element &&
                active.closest(".queued-cancel-confirmation"))
            ) {
              const target =
                trigger.isConnected && !trigger.disabled
                  ? trigger
                  : composerTextareaRef.current;
              target?.focus({ preventScroll: true });
            }
            return false;
          }}
          onOpenChange={(open) => {
            if (!open) setCancelConfirmation(null);
          }}
          title={i18n.t("shell:cancelQueuedMessagesQuestion", {
            count: cancelConfirmation.targets.length,
          })}
        >
          <div className="queued-cancel-confirmation">
            <h2>
              {i18n.t("shell:cancelQueuedMessagesQuestion", {
                count: cancelConfirmation.targets.length,
              })}
            </h2>
            <p>{i18n.t("shell:cancelQueuedMessagesDetail")}</p>
            <ol>
              {cancelConfirmation.previews.map((preview, index) => (
                <li key={cancelConfirmation.targets[index]?.queuedItemId}>
                  {preview}
                </li>
              ))}
            </ol>
            <div className="queued-cancel-confirmation-actions">
              <button type="button" onClick={() => setCancelConfirmation(null)}>
                {i18n.t("shell:keepMessages")}
              </button>
              <button
                type="button"
                disabled={cancelingQueue || resumingQueue || composerDisabled}
                onClick={() => {
                  const targets = cancelConfirmation.targets;
                  setCancelConfirmation(null);
                  void cancelQueued(targets);
                }}
              >
                {i18n.t("shell:cancelTheseQueuedMessages", {
                  count: cancelConfirmation.targets.length,
                })}
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {Object.entries(editSessions).map(([key, session]) => (
        <QueuedMessageEditor
          key={session.identity}
          identity={session.identity}
          open={
            openEditKey === key &&
            session.owner === editOwner.current &&
            thread?.id === session.threadId
          }
          initialDraft={session.draft}
          pending={session.pending}
          error={session.error}
          trigger={session.trigger}
          canRestoreFocus={() =>
            currentThreadRef.current === session.threadId &&
            document.getSelection()?.isCollapsed !== false
          }
          onRestoreFocus={() => {
            if (
              currentThreadRef.current === session.threadId &&
              !document.querySelector('[role="dialog"]') &&
              document.getSelection()?.isCollapsed !== false
            )
              composerTextareaRef.current?.focus({ preventScroll: true });
          }}
          disabledReason={
            session.confirmed
              ? i18n.t("shell:queueEditSyncing")
              : composerDisabled
                ? i18n.t("shell:queueEditBusy")
                : undefined
          }
          onDraftChange={(draft) => {
            const current = editSessionsRef.current[key];
            if (
              current?.owner === editOwner.current &&
              !current.pending &&
              !current.confirmed
            )
              updateEditSession(key, { ...current, draft });
          }}
          onSave={(draft) => saveQueuedEdit(key, draft)}
          onClose={(_reason) => {
            const current = editSessionsRef.current[key];
            if (current?.owner === editOwner.current) {
              if (
                !current.pending &&
                (!current.confirmed || observedEdit(current))
              )
                updateEditSession(key, null);
              else updateEditSession(key, { ...current, owner: undefined });
            }
            setOpenEditKey((value) => (value === key ? null : value));
          }}
          onReadAttachment={onReadAttachment}
          onImportImages={
            onImportQueueImages ??
            (async () => {
              throw new Error(i18n.t("shell:imageReaderUnavailable"));
            })
          }
          onPickImages={
            onPickQueueImages ??
            (async () => {
              throw new Error(i18n.t("shell:imageReaderUnavailable"));
            })
          }
        />
      ))}
      {preview === null || !queuePreviewCurrent ? null : (
        <ImagePreview
          attachment={preview.attachment}
          name={preview.name}
          onClose={() => setPreview(null)}
          onReadAttachment={
            preview.queueOwner ? readQueuedImage : onReadAttachment
          }
          trigger={preview.trigger}
          safeError={preview.queueOwner !== undefined}
          restoreFocus={
            preview.queueOwner
              ? () => {
                  if (
                    currentThreadRef.current !== preview.queueOwner!.threadId ||
                    !document.getSelection()?.isCollapsed
                  )
                    return;
                  if (
                    preview.trigger.isConnected &&
                    !preview.trigger.closest("[hidden]")
                  )
                    preview.trigger.focus({ preventScroll: true });
                  else
                    composerTextareaRef.current?.focus({
                      preventScroll: true,
                    });
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

type TranscriptRow =
  | { type: "turn"; turn: Turn; index: number; order: number }
  | {
      type: "compaction";
      compaction: ContextCompactionProjection;
      order: number;
    };

function buildTranscriptRows(
  turns: readonly Turn[],
  canonicalItems: Thread["canonicalItems"],
  compactions: readonly ContextCompactionProjection[],
): TranscriptRow[] {
  const fallbackStart = (canonicalItems?.length ?? 0) + 1;
  const turnEnds = new Map<string, number>();
  canonicalItems?.forEach((item, index) => {
    if ("turnId" in item && typeof item.turnId === "string") {
      turnEnds.set(item.turnId, index);
    }
  });
  const rows: TranscriptRow[] = turns.map((turn, index) => ({
    type: "turn",
    turn,
    index,
    order: turnEnds.get(turn.id) ?? fallbackStart + index,
  }));
  for (const compaction of compactions) {
    const turnEnd =
      compaction.item.provenance === "agentic"
        ? turnEnds.get(compaction.item.turnId)
        : undefined;
    rows.push({
      type: "compaction",
      compaction,
      order:
        turnEnd === undefined
          ? compaction.canonicalIndex
          : Math.max(compaction.canonicalIndex, turnEnd) + 0.25,
    });
  }
  return rows.sort((left, right) => left.order - right.order);
}

function ContextCompactionProgress({
  state,
  onDismiss,
}: {
  state: NonNullable<ComposerState["compaction"]>;
  onDismiss?(): void;
}) {
  useTranslation("shell");
  const failed = state.status === "failed";
  return (
    <div
      className={`context-compaction-progress${failed ? " is-error" : ""}`}
      role={failed ? "alert" : "status"}
    >
      {failed ? (
        <Icon name="warning" size={15} />
      ) : (
        <span className="mini-spinner" aria-hidden="true" />
      )}
      <div className="context-compaction-progress-content">
        <span>{state.message}</span>
        {failed ? (
          <div className="context-compaction-error-actions">
            {state.detail ? (
              <details className="context-compaction-error-detail">
                <summary tabIndex={0}>
                  {i18n.t("shell:technicalDetails")}
                </summary>
                <p>{state.detail}</p>
              </details>
            ) : null}
            {onDismiss ? (
              <button
                type="button"
                onClick={onDismiss}
                aria-label={i18n.t("shell:dismissCompactionError")}
              >
                {i18n.t("shell:dismiss")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ContextCompactionEvent({
  projection,
}: {
  projection: ContextCompactionProjection;
}) {
  const [expanded, setExpanded] = useState(false);
  const { item, effectiveMessages } = projection;
  const [copyState, setCopyState] = useState("");
  return (
    <section
      className="context-compaction-event"
      aria-label={i18n.t("shell:contextCompacted")}
    >
      <button
        className="context-compaction-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="context-compaction-mark" aria-hidden="true">
          <Icon name="compress" size={14} />
        </span>
        <span>
          <strong>{i18n.t("shell:contextCompacted")}</strong>
          <small>
            {compactionInitiatorLabel(item)} ·{" "}
            {i18n.t("shell:summaryCharacters", {
              count: new Intl.NumberFormat(i18n.resolvedLanguage).format(
                Array.from(item.summary).length,
              ),
            })}
          </small>
        </span>
        <Icon name="chevron-down" size={13} />
      </button>
      {expanded ? (
        <div className="context-compaction-detail">
          <div className="compaction-summary-heading">
            <h3>{i18n.t("shell:savedSummary")}</h3>
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                void navigator.clipboard.writeText(item.summary).then(
                  () => setCopyState(i18n.t("shell:summaryCopied")),
                  () =>
                    setCopyState(
                      i18n.t("shell:couldNotCopySelectTheSummaryTextToCopyIt"),
                    ),
                );
              }}
            >
              {i18n.t("shell:copySummary")}
            </button>
          </div>
          <span role="status">{copyState}</span>
          <div className="compaction-summary">
            <Markdown text={item.summary} />
          </div>
          <p>
            {i18n.t("shell:retainedItemsDetail", {
              count: item.retainedItemIds.length,
            })}
          </p>
          <details className="compaction-projection">
            <summary>{i18n.t("shell:retainedContextAndDiagnostics")}</summary>
            {effectiveMessages === null ? (
              <p role="status">
                {i18n.t("shell:retainedContextUnavailable")}
                {projection.snapshotError
                  ? ` ${projection.snapshotError}`
                  : null}
              </p>
            ) : (
              <>
                <p>
                  {i18n.t("shell:projectedHistoryDetail", {
                    count: effectiveMessages.length,
                  })}
                </p>
                <ol>
                  {effectiveMessages.map((message, index) => (
                    <li key={`${item.id}:${String(index)}`}>
                      <span>{modelMessageRole(message)}</span>
                      <pre>{formatModelMessage(message)}</pre>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </details>
        </div>
      ) : null}
    </section>
  );
}

function modelMessageRole(message: ModelMessage): string {
  if (message.role === "tool") return i18n.t("shell:tool");
  if (message.role === "reasoning") return i18n.t("shell:reasoning");
  return message.role === "assistant"
    ? i18n.t("shell:assistant")
    : i18n.t("shell:user");
}

function formatModelMessage(message: ModelMessage): string {
  if (message.role === "reasoning") {
    return [message.summary, message.reasoningContent]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n");
  }
  if (message.role === "tool") {
    return message.modelContent === undefined
      ? message.text
      : `${message.text}\n${JSON.stringify(message.modelContent, null, 2)}`;
  }
  if ("content" in message) return JSON.stringify(message.content, null, 2);
  if ("toolCalls" in message) {
    return `${message.text ?? ""}\n${JSON.stringify(message.toolCalls, null, 2)}`.trim();
  }
  return message.text;
}

function TraceCounts({
  activity,
  terminal = false,
}: {
  activity: TraceActivity;
  terminal?: boolean;
}) {
  return (
    <span className="trace-counts">
      {!terminal && activity.total > 0 ? (
        <small>
          {activity.categories
            .slice(0, 2)
            .map(({ label, count }) => `${label} ${count}`)
            .join(" · ")}
          {activity.categories.length > 2
            ? ` +${activity.categories.length - 2}`
            : ""}
        </small>
      ) : null}
      {activity.failed > 0 ? (
        <small className="trace-failed">
          {i18n.t("shell:toolFailures", { count: activity.failed })}
        </small>
      ) : null}
      {activity.cancelled > 0 ? (
        <small>
          {i18n.t("shell:toolCancelled", { count: activity.cancelled })}
        </small>
      ) : null}
      {terminal && activity.outstanding > 0 ? (
        <small className="trace-pending">
          {i18n.t("shell:lastKnownPending", { count: activity.outstanding })}
        </small>
      ) : null}
    </span>
  );
}
function RunningTurnLabel({
  startedAt,
  activity,
  stopping,
  approval,
}: {
  startedAt: number | null;
  activity: TraceActivity;
  stopping: boolean;
  approval: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const phase = stopping
    ? "stopping"
    : approval
      ? "approval"
      : activity.phase === "idle" && startedAt === null
        ? "admitting"
        : activity.phase;
  const label =
    phase === "stopping"
      ? i18n.t("shell:stopping")
      : phase === "approval"
        ? i18n.t("shell:approvalRequired")
        : phase === "thinking" || phase === "idle"
          ? i18n.t("shell:working")
          : phase === "requested"
            ? i18n.t("shell:awaitingToolResult")
            : commandPhaseLabel(phase);
  const busy = phase === "running" || phase === "thinking" || phase === "idle";
  return (
    <div className="turn-running-label" data-phase={phase}>
      <Icon
        name={
          phase === "approval"
            ? "lock"
            : phase === "stopping"
              ? "stop"
              : "reasoning"
        }
        size={14}
      />
      <span role="status" aria-live="polite" aria-atomic="true">
        <ActivityText active={busy}>{label}</ActivityText>
      </span>
      {startedAt === null ? null : (
        <span className="turn-duration" aria-hidden="true">
          {formatDuration(now - startedAt * 1000)}
        </span>
      )}
    </div>
  );
}
function transcriptHasSelection(element: Element | null): boolean {
  const selection = document.getSelection();
  return (
    !!element &&
    !!selection &&
    !selection.isCollapsed &&
    ((selection.anchorNode !== null &&
      element.contains(selection.anchorNode)) ||
      (selection.focusNode !== null && element.contains(selection.focusNode)))
  );
}
function isNestedTranscriptScroll(
  target: EventTarget | null,
  transcript: HTMLElement,
): boolean {
  for (
    let element = target instanceof Element ? target : null;
    element && element !== transcript;
    element = element.parentElement
  ) {
    if (
      element.scrollHeight > element.clientHeight &&
      /auto|scroll/.test(getComputedStyle(element).overflowY)
    )
      return true;
  }
  return false;
}

function TurnBlock({
  turn,
  stopping,
  approvals,
  confirmedStopped,
  onContinue,
  index,
  wakeups,
  attachments,
  onOpenImage,
  onReadAttachment,
  pluginSnapshot,
  pluginUiRegistry,
  usage,
  failureDetail,
}: {
  turn: Turn;
  stopping: boolean;
  approvals: readonly ApprovalCardState[];
  confirmedStopped: boolean;
  onContinue(): void;
  index: number;
  wakeups: readonly TriggerHistoryEntry[];
  attachments: ZenXThreadAttachmentProjection;
  onOpenImage(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
  usage?: ModelUsageAggregate;
  failureDetail?: FailureItem | null;
}) {
  const { i18n: activeI18n } = useTranslation("shell");
  const observations = useMemo(
    () => createTraceObservationIndex(turn.items),
    [turn.items],
  );
  const projection = useMemo(
    () => projectTurn(turn, observations),
    [turn, observations, activeI18n.resolvedLanguage],
  );
  const activity = useMemo(
    () => summarizeTraceActivity(turn.items, observations),
    [turn.items, observations, activeI18n.resolvedLanguage],
  );
  const sectionRef = useRef<HTMLElement>(null);
  const historyId = useId();
  const [expandedOverride, setExpanded] = useReadingDisclosure(
    disclosureKey("turn", turn.id),
  );
  const [protectedOpen, setProtectedOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const previousStatus = useRef(turn.status);
  // selectionchange is queued by browsers. Observe the still-mounted history
  // before a terminal render could remove the user's selected/focused node.
  if (previousStatus.current !== turn.status) {
    const wasRunning = previousStatus.current === "inProgress";
    previousStatus.current = turn.status;
    const active = document.activeElement;
    if (
      wasRunning &&
      turn.status !== "inProgress" &&
      (transcriptHasSelection(sectionRef.current) ||
        (active instanceof Element &&
          !!active.closest(".turn-history") &&
          !!sectionRef.current?.contains(active)))
    ) {
      setInspecting(true);
      setProtectedOpen(true);
    }
  }
  const expanded =
    protectedOpen ||
    (expandedOverride ??
      (turn.status === "failed" ||
        turn.status === "interrupted" ||
        inspecting));
  const complete = turn.status !== "inProgress";
  useEffect(() => {
    const preserve = () => {
      const active = document.activeElement;
      setInspecting(
        transcriptHasSelection(sectionRef.current) ||
          (active instanceof Element &&
            !!active.closest(".turn-history") &&
            !!sectionRef.current?.contains(active)),
      );
    };
    document.addEventListener("selectionchange", preserve);
    document.addEventListener("focusin", preserve);
    document.addEventListener("focusout", preserve);
    return () => {
      document.removeEventListener("selectionchange", preserve);
      document.removeEventListener("focusin", preserve);
      document.removeEventListener("focusout", preserve);
    };
  }, []);
  const reviewActivity = () => {
    setExpanded(true);
    requestAnimationFrame(() => {
      const section = sectionRef.current;
      const trace =
        section?.querySelector<HTMLElement>('[data-unsettled="true"]') ??
        section?.querySelector<HTMLElement>(".trace-group, .trace-singleton");
      const toggle = trace?.querySelector<HTMLButtonElement>(":scope > button");
      if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
      toggle?.focus({ preventScroll: true });
      toggle?.scrollIntoView?.({ block: "nearest" });
    });
  };
  const renderInputItem = (
    item: Extract<
      ThreadItem,
      { type: "userMessage" | "threadMessage" | "hostMessage" }
    >,
  ) => {
    const wakeup = wakeups.find(
      (entry) =>
        entry.clientUserMessageId === item.clientId &&
        (item.type === "userMessage" ||
          (item.type === "hostMessage" &&
            (item.source === "trigger"
              ? entry.triggerId === item.sourceId
              : item.source === "room" &&
                entry.sourceRoomId === item.sourceId))),
    );
    if (item.type === "hostMessage")
      return (
        <WakeupCard key={item.id} item={item} entry={wakeup} turn={turn} />
      );
    return wakeup === undefined ? (
      <InputMessage
        attachments={attachments[item.id] ?? []}
        item={item}
        key={item.id}
        onOpenImage={onOpenImage}
        onReadAttachment={onReadAttachment}
        turn={turn}
      />
    ) : (
      <WakeupCard entry={wakeup} key={item.id} />
    );
  };
  return (
    <section
      ref={sectionRef}
      className={`turn ${turn.status}`}
      aria-label={i18n.t("shell:turnNumber", { number: index + 1 })}
    >
      {projection.inputItems.map(renderInputItem)}
      {complete ? (
        <button
          className="turn-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={historyId}
          onClick={() => {
            setProtectedOpen(false);
            setExpanded(!expanded);
          }}
        >
          <span>
            {confirmedStopped
              ? i18n.t("shell:stopped")
              : completedTurnLabel(turn)}
          </span>
          <TraceCounts activity={activity} terminal />
          <Icon name="chevron-down" size={14} />
        </button>
      ) : (
        <RunningTurnLabel
          startedAt={turn.startedAt}
          activity={activity}
          stopping={stopping}
          approval={approvals.length > 0}
        />
      )}
      {!complete || expanded ? (
        <div className="turn-history" id={historyId}>
          {projection.history.map((node) =>
            node.kind === "input" ? (
              renderInputItem(node.item)
            ) : (
              <DisplayNode
                key={node.kind === "agent" ? node.item.id : node.id}
                node={node}
                turn={turn}
                observations={observations}
                approvals={approvals}
                usage={usage}
                pluginSnapshot={pluginSnapshot}
                pluginUiRegistry={pluginUiRegistry}
              />
            ),
          )}
          {!complete && projection.finalItem !== null ? (
            <AgentMessage
              item={projection.finalItem}
              showActions={false}
              turn={turn}
              usage={usage}
            />
          ) : null}
        </div>
      ) : null}
      {complete && !expanded
        ? projection.history
            .filter(
              (node): node is Extract<TurnDisplayNode, { kind: "input" }> =>
                node.kind === "input",
            )
            .map((node) => renderInputItem(node.item))
        : null}
      {complete && projection.finalItem !== null ? (
        <div className="turn-final">
          <AgentMessage
            item={projection.finalItem}
            showActions
            turn={turn}
            usage={usage}
          />
        </div>
      ) : projection.terminalFallback === null ? null : (
        <div
          className={`turn-outcome${activity.outstanding > 0 ? " uncertain" : ""}`}
          role="status"
        >
          <div className="turn-outcome-heading">
            <Icon
              name={activity.outstanding > 0 ? "warning" : "stop"}
              size={14}
            />
            <strong>
              {activity.outstanding > 0
                ? i18n.t("shell:stopUnconfirmed")
                : confirmedStopped
                  ? i18n.t("shell:stopped")
                  : turn.status === "failed"
                    ? i18n.t("shell:failed")
                    : i18n.t("shell:interrupted")}
            </strong>
          </div>
          {activity.outstanding > 0 ? (
            <p>{i18n.t("shell:stopUnconfirmedNote")}</p>
          ) : confirmedStopped ? (
            <p>{i18n.t("shell:stoppedNote")}</p>
          ) : turn.status === "failed" ? (
            <TurnFailureOutcome
              text={projection.terminalFallback ?? ""}
              retried={failureDetail?.retried}
              diagnosticId={failureDetail?.diagnosticId}
            />
          ) : (
            <p>{i18n.t("shell:interruptedNote")}</p>
          )}
          {activity.outstanding > 0 && turn.error?.message ? (
            <p className="turn-outcome-error" role="alert">
              {turn.error.message}
            </p>
          ) : null}
          <button
            type="button"
            className="quiet-button"
            onClick={activity.outstanding > 0 ? reviewActivity : onContinue}
          >
            {i18n.t(
              activity.outstanding > 0
                ? "shell:reviewActivity"
                : "shell:continueWriting",
            )}
          </button>
        </div>
      )}
    </section>
  );
}

/** Failed turns show the actionable first line up front; the full provider
 * message, retry count and diagnostics entry stay one click away. */
function TurnFailureOutcome({
  text,
  retried,
  diagnosticId,
}: {
  text: string;
  retried: number | undefined;
  diagnosticId: string | undefined;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState(false);
  const firstLine = text.split("\n", 1)[0] ?? "";
  const summary =
    firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
  const hasMore = text !== summary;
  const hasDetails = hasMore || diagnosticId !== undefined;
  return (
    <div className="turn-outcome-failure">
      <p>
        {summary}
        {hasMore && !showDetails ? " …" : ""}
        {retried !== undefined ? (
          <span className="turn-outcome-retried">
            {` · ${i18n.t("shell:failureRetriedNote", { count: retried })}`}
          </span>
        ) : null}
      </p>
      {showDetails ? (
        <div>
          <p className="turn-outcome-error" role="alert">
            {text}
          </p>
          {diagnosticId !== undefined ? (
            <p>{i18n.t("shell:failureDiagnosticId", { id: diagnosticId })}</p>
          ) : null}
        </div>
      ) : null}
      {diagnosticsError ? (
        <p role="alert">{i18n.t("shell:couldNotOpenModelDiagnostics")}</p>
      ) : null}
      <div className="turn-outcome-actions">
        {hasDetails ? (
          <button
            type="button"
            className="quiet-button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails
              ? i18n.t("shell:hideFailureDetails")
              : i18n.t("shell:showFailureDetails")}
          </button>
        ) : null}
        {diagnosticId !== undefined ? (
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              setDiagnosticsError(false);
              void window.zenx.settings
                .openDiagnosticsFolder("model")
                .catch(() => setDiagnosticsError(true));
            }}
          >
            {i18n.t("shell:openDiagnosticsFolder")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function usageLabel(usage: ModelUsageAggregate, prefix: string): string {
  const cache =
    usage.cacheHitRate === undefined
      ? i18n.t("shell:usageUnknownForPrefix", { prefix })
      : `${prefix} ${String(Math.round(usage.cacheHitRate * 100))}%`;
  return i18n.t("shell:usageWithCache", {
    cache,
    input: formatTokenCount(usage.inputTokens),
    output: formatTokenCount(usage.outputTokens),
  });
}

export function contextUsageLabel(
  context: ModelContextUsageProjection,
): string | null {
  if (context.inputTokens === null && context.contextWindow === null) {
    return null;
  }
  if (context.inputTokens === null) {
    const window = context.contextWindow;
    return window === null
      ? null
      : i18n.t("shell:contextUnknownWindow", {
          window: formatTokenCount(window),
        });
  }
  const input = formatTokenCount(context.inputTokens);
  const source =
    context.inputTokenSource === "estimated"
      ? i18n.t("shell:estimatedNextInput")
      : i18n.t("shell:lastProviderInput");
  if (context.contextWindow === null || context.ratio === null) {
    return i18n.t("shell:contextUnknownInput", { input, source });
  }
  return i18n.t("shell:contextUsageFull", {
    percent: Math.round(context.ratio * 100),
    input,
    source,
    window: formatTokenCount(context.contextWindow),
  });
}

export function threadCacheUsageLabel(
  cacheHitRate: number | undefined,
): string {
  return cacheHitRate === undefined
    ? i18n.t("shell:threadCacheUnknown")
    : i18n.t("shell:threadCachePercent", {
        percent: Math.round(cacheHitRate * 100),
      });
}

export function ContextUsageIndicator({
  context,
  threadCacheHitRate,
  compactDisabled = false,
  onCompact,
}: {
  context?: ModelContextUsageProjection;
  threadCacheHitRate?: number;
  compactDisabled?: boolean;
  onCompact?(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const [popoverPosition, setPopoverPosition] = useState({
    left: 0,
    top: 0,
    width: 286,
    placement: "above" as "above" | "below",
  });
  const [hoverBridge, setHoverBridge] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const root = rootRef.current;
    const boundary = root.closest(".thread-view");
    const place = () => {
      const anchor = root.getBoundingClientRect();
      const bounds = boundary?.getBoundingClientRect();
      const left = Math.max(0, bounds?.left ?? 0) + 8;
      const right =
        Math.min(
          window.innerWidth,
          bounds?.width ? bounds.right : window.innerWidth,
        ) - 8;
      const width = Math.min(286, Math.max(0, right - left));
      // Keep the fixed popover inside the viewport even when the indicator is
      // near the top edge. The CSS transform places an above popover entirely
      // above its anchor, so choose below before clamping rather than allowing
      // the panel to be clipped out of view.
      const estimatedHeight =
        popoverRef.current?.getBoundingClientRect().height ?? 190;
      const canPlaceAbove = anchor.top - 8 >= estimatedHeight;
      const panelLeft = Math.max(
        left,
        Math.min(anchor.right - width, right - width),
      );
      const panelTop = canPlaceAbove
        ? anchor.top - 8
        : Math.max(
            8,
            Math.min(
              window.innerHeight - estimatedHeight - 8,
              anchor.bottom + 8,
            ),
          );
      setPopoverPosition({
        left: panelLeft,
        top: panelTop,
        width,
        placement: canPlaceAbove ? "above" : "below",
      });
      // A real transparent hit area connects the full panel edge to the ring.
      // It covers only the vertical gap, so neighboring composer controls keep
      // their own pointer targets. A pseudo-element is clipped by panel overflow.
      setHoverBridge({
        left: Math.min(panelLeft, anchor.left),
        top: canPlaceAbove ? panelTop : anchor.bottom,
        width:
          Math.max(panelLeft + width, anchor.right) -
          Math.min(panelLeft, anchor.left),
        height: Math.max(
          0,
          canPlaceAbove ? anchor.top - panelTop : panelTop - anchor.bottom,
        ),
      });
    };
    place();
    window.addEventListener("resize", place);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(place);
    observer?.observe(root);
    if (boundary) observer?.observe(boundary);
    if (popoverRef.current) observer?.observe(popoverRef.current);
    return () => {
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [open]);
  if (context?.ratio === null || context?.ratio === undefined) return null;
  const percent = Math.round(context.ratio * 100);
  const visualRatio = Math.max(0, Math.min(1, context.ratio));
  const visualPercent = Math.round(visualRatio * 100);
  const tokenUsage =
    context.inputTokens === null
      ? i18n.t("shell:usageUnknown")
      : i18n.t("shell:tokenCount", {
          count: `${formatTokenCount(context.inputTokens)}${context.contextWindow === null ? "" : ` / ${formatTokenCount(context.contextWindow)}`}`,
        });
  const contextLabel = i18n.t("shell:contextPercentUsage", {
    percent,
    usage: tokenUsage,
  });
  const tooltip = `${contextLabel}\n${threadCacheUsageLabel(threadCacheHitRate)}`;
  const radius = 7;
  return (
    <div
      className="context-usage-indicator"
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement))
          setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        className="context-usage-trigger"
        type="button"
        aria-controls={popoverId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={i18n.t("shell:openContextDetails", { details: tooltip })}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <circle className="context-usage-track" cx="10" cy="10" r={radius} />
          <circle
            className="context-usage-progress"
            cx="10"
            cy="10"
            r={radius}
            pathLength="1"
            strokeDasharray={`${visualRatio} 1`}
          />
        </svg>
      </button>
      {open ? (
        <>
          <div
            className="context-usage-hover-bridge"
            aria-hidden="true"
            style={{ position: "fixed", zIndex: 55, ...hoverBridge }}
          />
          <div
            className="context-usage-popover"
            ref={popoverRef}
            style={popoverPosition}
            data-placement={popoverPosition.placement}
            id={popoverId}
            role="dialog"
            aria-label={i18n.t("shell:contextDetails")}
          >
            <div className="context-usage-heading">
              <span>{i18n.t("shell:contextWindowUsed")}</span>
              <strong>{String(percent)}%</strong>
            </div>
            <div
              className="context-usage-meter"
              role="progressbar"
              aria-label={contextLabel}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={visualPercent}
              aria-valuetext={contextLabel}
            >
              <span style={{ width: `${String(visualPercent)}%` }} />
            </div>
            <p>{tokenUsage}</p>
            <p>{threadCacheUsageLabel(threadCacheHitRate)}</p>
            <button
              className="context-usage-compact"
              type="button"
              disabled={compactDisabled || onCompact === undefined}
              onClick={() => {
                setOpen(false);
                void onCompact?.();
              }}
            >
              {i18n.t("shell:compactContext")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  return new Intl.NumberFormat(i18n.resolvedLanguage, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function DisplayNode({
  node,
  observations,
  approvals,
  turn,
  usage,
  pluginSnapshot,
  pluginUiRegistry,
}: {
  node: Exclude<TurnDisplayNode, { kind: "input" }>;
  observations: TraceObservationIndex;
  approvals: readonly ApprovalCardState[];
  turn: Turn;
  usage?: ModelUsageAggregate;
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
}) {
  return node.kind === "agent" ? (
    <AgentMessage
      item={node.item}
      showActions={
        (turn.status === "failed" || turn.status === "interrupted") &&
        turn.items
          .filter(
            (item) => item.type === "agentMessage" && item.text.length > 0,
          )
          .at(-1)?.id === node.item.id
      }
      turn={turn}
      usage={usage}
    />
  ) : (
    <TraceSequence
      node={node}
      turn={turn}
      observations={observations}
      approvals={approvals}
      pluginSnapshot={pluginSnapshot}
      pluginUiRegistry={pluginUiRegistry}
    />
  );
}

/** Keep content mounted for a height-independent transition; inert removes hidden controls from tab order. */
function TraceReveal({
  open,
  id,
  children,
}: {
  open: boolean;
  id?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className="trace-reveal"
      data-open={open}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="trace-reveal-inner">{children}</div>
    </div>
  );
}

function TraceSequence({
  node,
  turn,
  observations,
  approvals,
  pluginSnapshot,
  pluginUiRegistry,
}: {
  node: Extract<TurnDisplayNode, { kind: "traceItem" | "traceGroup" }>;
  turn: Turn;
  observations: TraceObservationIndex;
  approvals: readonly ApprovalCardState[];
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
}) {
  const [expandedChoice, setExpanded] = useReadingDisclosure(
    disclosureKey("trace", turn.id, node.id),
  );
  const expanded = expandedChoice ?? false;
  const { choices, set: setChoice } = useReadingDisclosures();
  const sectionRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [visited, setVisited] = useState(expanded);
  const [visitedItems, setVisitedItems] = useState<Set<string>>(new Set());
  const grouped = node.kind === "traceGroup";
  const activity = summarizeTraceActivity(
    node.kind === "traceGroup" ? node.items : [node.item],
    observations,
  );
  const busy =
    turn.status === "inProgress" &&
    (activity.phase === "running" || activity.phase === "thinking");
  const detailsId = useId();
  const singleton = node.kind === "traceItem" ? node.item : null;
  const singletonExpandable =
    singleton !== null && traceItemExpandable(singleton);
  const toggleExpanded = () => {
    if (expanded && sectionRef.current?.contains(document.activeElement)) {
      toggleRef.current?.focus();
    }
    setVisited(true);
    if (!expanded && singleton !== null && singletonExpandable) {
      setVisitedItems((seen) => new Set(seen).add(singleton.id));
      setChoice(disclosureKey("item", turn.id, singleton.id), true);
    }
    setExpanded((current) => !current);
  };
  return (
    <section
      ref={sectionRef}
      data-unsettled={activity.active > 0}
      className={grouped ? "trace-group" : "trace-item trace-singleton"}
    >
      {grouped ? (
        <button
          ref={toggleRef}
          className="trace-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={toggleExpanded}
        >
          <Icon
            name={(() => {
              const command = node.items.findLast(
                (item) => item.type === "commandExecution",
              );
              return command?.type === "commandExecution"
                ? toolPresentation(command.toolName ?? command.command).icon
                : "reasoning";
            })()}
            size={15}
          />
          <span className="trace-activity-title">
            <ActivityText active={busy}>
              {traceSummary(node.items, observations)}
            </ActivityText>
          </span>
          <TraceCounts activity={activity} />
          <small className="sr-only">
            {i18n.t("shell:executionItems", { count: node.items.length })}
          </small>
          <Icon name="chevron-down" size={13} />
        </button>
      ) : singletonExpandable ? (
        <button
          ref={toggleRef}
          className="trace-item-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={toggleExpanded}
        >
          <TraceItemHeader
            turnRunning={turn.status === "inProgress"}
            item={singleton}
            expandable
            observations={observations}
            approvalPending={approvals.some(
              (approval) => approval.params.itemId === singleton.id,
            )}
          />
        </button>
      ) : (
        <div className="trace-item-static">
          <TraceItemHeader
            turnRunning={turn.status === "inProgress"}
            item={singleton!}
            expandable={false}
            observations={observations}
            approvalPending={approvals.some(
              (approval) => approval.params.itemId === singleton!.id,
            )}
          />
        </div>
      )}
      {!grouped && singletonExpandable ? (
        <TraceReveal open={expanded} id={detailsId}>
          {visited || expanded ? (
            <TraceDetail
              item={singleton}
              pluginSnapshot={pluginSnapshot}
              pluginUiRegistry={pluginUiRegistry}
            />
          ) : null}
        </TraceReveal>
      ) : null}
      {grouped ? (
        <TraceReveal open={expanded} id={detailsId}>
          {visited || expanded ? (
            <div
              className="trace-items"
              role="region"
              aria-label={i18n.t("shell:executionDetails")}
              tabIndex={0}
            >
              {groupReasoningWithoutDetailsRows(traceDisplayRows(node.items))
                // Models that do not expose reasoning should leave no
                // completed "Think" heading behind in the transcript.
                .filter((row) => {
                  if ("kind" in row) {
                    return node.items.some(
                      (item) =>
                        row.ids.includes(item.id) &&
                        item.type === "reasoning" &&
                        item.status === "inProgress",
                    );
                  }
                  const item = row.item;
                  return !(
                    item.type === "reasoning" &&
                    item.status !== "inProgress" &&
                    item.status !== "interrupted" &&
                    item.summary.every((part) => part.trim().length === 0) &&
                    item.content.every((part) => part.trim().length === 0)
                  );
                })
                .map((row) => {
                  if ("kind" in row) {
                    return (
                      <div
                        className="trace-item trace-reasoning-without-details"
                        key={row.ids[0]}
                      >
                        <div className="trace-item-static">
                          <Icon name="reasoning" size={14} />
                          <span>{i18n.t("shell:thinking")}</span>
                        </div>
                      </div>
                    );
                  }
                  const { item, nested, parentToolName } = row;
                  const open =
                    choices.get(disclosureKey("item", turn.id, item.id)) ??
                    false;
                  const expandable = traceItemExpandable(item);
                  return (
                    <div
                      className={`trace-item${nested ? " trace-item-nested" : ""}`}
                      aria-label={
                        nested
                          ? i18n.t("shell:nestedToolInvokedBy", {
                              tool:
                                parentToolName ?? i18n.t("shell:parentCode"),
                            })
                          : undefined
                      }
                      key={item.id}
                    >
                      {expandable ? (
                        <button
                          className="trace-item-toggle"
                          type="button"
                          aria-expanded={open}
                          onClick={() => {
                            setVisitedItems((current) =>
                              new Set(current).add(item.id),
                            );
                            setChoice(
                              disclosureKey("item", turn.id, item.id),
                              (current) => !current,
                            );
                          }}
                        >
                          <TraceItemHeader
                            turnRunning={turn.status === "inProgress"}
                            item={item}
                            expandable
                            observations={observations}
                            approvalPending={approvals.some(
                              (approval) => approval.params.itemId === item.id,
                            )}
                          />
                        </button>
                      ) : (
                        <div className="trace-item-static">
                          <TraceItemHeader
                            turnRunning={turn.status === "inProgress"}
                            item={item}
                            expandable={false}
                            observations={observations}
                            approvalPending={approvals.some(
                              (approval) => approval.params.itemId === item.id,
                            )}
                          />
                        </div>
                      )}
                      {expandable ? (
                        <TraceReveal open={open}>
                          {visitedItems.has(item.id) || open ? (
                            <TraceDetail
                              item={item}
                              pluginSnapshot={pluginSnapshot}
                              pluginUiRegistry={pluginUiRegistry}
                            />
                          ) : null}
                        </TraceReveal>
                      ) : null}
                    </div>
                  );
                })}
            </div>
          ) : null}
        </TraceReveal>
      ) : null}
    </section>
  );
}

function TraceItemHeader({
  turnRunning,
  item,
  observations,
  expandable,
  approvalPending,
}: {
  item: Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>;
  expandable: boolean;
  observations: TraceObservationIndex;
  approvalPending: boolean;
  turnRunning: boolean;
}) {
  const active =
    turnRunning &&
    !approvalPending &&
    (item.type === "reasoning"
      ? item.status === "inProgress"
      : observedCommandPhase(item, observations) === "running");
  return (
    <>
      <Icon
        name={
          item.type === "reasoning"
            ? "reasoning"
            : toolPresentation(item.toolName ?? item.command).icon
        }
        size={14}
      />
      {item.type === "reasoning" ? null : (
        <strong>
          {toolPresentation(item.toolName ?? item.command).category}
        </strong>
      )}
      <span title={traceItemLabel(item)}>
        <ActivityText active={active}>{traceItemLabel(item)}</ActivityText>
      </span>
      <span className="trace-item-status">
        {approvalPending ? (
          <small className="tool-status">
            {i18n.t("shell:approvalRequired")}
          </small>
        ) : (
          <StatusMark item={item} observations={observations} />
        )}
      </span>
      <span className="trace-item-chevron">
        {expandable ? <Icon name="chevron-down" size={13} /> : null}
      </span>
    </>
  );
}

function traceItemExpandable(
  item: Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>,
): boolean {
  return (
    item.type !== "reasoning" || reasoningContentText(item).trim().length > 0
  );
}

function StatusMark({
  item,
  observations,
}: {
  item: ThreadItem;
  observations: TraceObservationIndex;
}) {
  if (item.type === "reasoning") {
    if (item.status === "inProgress")
      return (
        <span className="mini-spinner" aria-label={i18n.t("shell:thinking")} />
      );
    if (item.status === "interrupted")
      return (
        <small className="tool-status interrupted">
          {i18n.t("shell:interrupted")}
        </small>
      );
    return null;
  }
  if (item.type !== "commandExecution") return null;
  const phase = observedCommandPhase(item, observations);
  const status =
    phase === commandPhase(item)
      ? commandStatus(item)
      : commandPhaseLabel(phase);
  if (status === i18n.t("shell:completed")) return null;
  return (
    <small
      className={`tool-status ${phase === "imported" ? "imported" : item.status}`}
    >
      {status}
    </small>
  );
}

function TraceDetail({
  item,
  pluginSnapshot,
  pluginUiRegistry,
}: {
  item: ThreadItem;
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
}) {
  if (item.type === "reasoning") {
    return (
      <div className="trace-detail trace-detail-markdown">
        <Markdown text={reasoningContentText(item)} />
      </div>
    );
  }
  if (item.type !== "commandExecution") return null;
  return (
    <div className="trace-detail trace-tool-detail">
      <ToolImages itemId={item.id} />
      <div className="trace-tool-card">
        <ToolInput command={item.command} />
        <div
          className="trace-output"
          role="region"
          aria-label={i18n.t("shell:toolOutput")}
          tabIndex={0}
        >
          <ToolResultRenderer
            item={item}
            snapshot={pluginSnapshot}
            registry={pluginUiRegistry}
            theme={
              document.documentElement.dataset.appearance === "dark"
                ? "dark"
                : "light"
            }
          />
        </div>
      </div>
    </div>
  );
}

function ToolInput({ command }: { command: string }) {
  const preview = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = preview.current;
    if (!element) return;
    const measure = () => {
      const next = element.scrollHeight > element.clientHeight + 1;
      setOverflows(next);
      if (!next) setExpanded(false);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [command, overflows]);

  const Heading = overflows ? "summary" : "div";
  const content = (
    <>
      <Heading className="trace-input-summary">
        <span className="trace-input-heading">
          {i18n.t("shell:input")}
          {overflows ? <Icon name="chevron-down" size={13} /> : null}
        </span>
        <span
          className="trace-input-preview"
          ref={preview}
          aria-hidden={expanded || undefined}
        >
          <code>{command}</code>
        </span>
      </Heading>
      {overflows ? (
        <pre className="trace-command">
          <code>{command}</code>
        </pre>
      ) : null}
    </>
  );
  return overflows ? (
    <details
      className="trace-input"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      {content}
    </details>
  ) : (
    <div className="trace-input">{content}</div>
  );
}

function reasoningContentText(
  item: Extract<ThreadItem, { type: "reasoning" }>,
): string {
  return item.content.join("\n");
}

function InputMessage({
  item,
  attachments,
  turn,
  onOpenImage,
  onReadAttachment,
}: {
  item: Extract<ThreadItem, { type: "userMessage" | "threadMessage" }>;
  attachments: readonly AttachmentRef[];
  turn: Turn;
  onOpenImage(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
}) {
  const text = item.content.map((content) => content.text).join("\n");
  return (
    <article
      className={
        item.type === "threadMessage"
          ? "user-row thread-message-row"
          : "user-row"
      }
    >
      {item.type === "threadMessage" ? (
        <small
          className="thread-message-sender"
          title={`${item.sender.deviceId === undefined ? "" : `${i18n.t("shell:threadMessageRemoteDetails")}\n`}${JSON.stringify(item.sender)}`}
        >
          {i18n.t(
            item.sender.deviceId === undefined
              ? "shell:threadMessageFrom"
              : "shell:remoteThreadMessageFrom",
            {
              name:
                item.sender.threadName ?? i18n.t("shell:threadMessageUnnamed"),
            },
          )}
        </small>
      ) : null}
      {attachments.length === 0 ? null : (
        <div
          className="message-images"
          aria-label={i18n.t("shell:attachedImages")}
        >
          {attachments.map((attachment, index) => (
            <AttachmentImage
              attachment={attachment}
              key={`${attachment.sha256}-${String(index)}`}
              name={i18n.t("shell:attachedImageName", { number: index + 1 })}
              onOpen={onOpenImage}
              onReadAttachment={onReadAttachment}
            />
          ))}
        </div>
      )}
      {text.length === 0 ? null : (
        <div className="user-bubble">
          <Markdown text={text} />
        </div>
      )}
      <MessageActions
        className="user-message-actions"
        copyLabel={i18n.t(
          item.type === "threadMessage"
            ? "shell:copyThreadMessage"
            : "shell:copyUserMessage",
        )}
        copiedLabel={i18n.t(
          item.type === "threadMessage"
            ? "shell:copiedThreadMessage"
            : "shell:copiedUserMessage",
        )}
        text={text}
        turn={turn}
      />
    </article>
  );
}

function DraftImage({
  image,
  onOpen,
  onReadAttachment,
  onRemove,
}: {
  image: ComposerDraftImage;
  onOpen(trigger: HTMLButtonElement): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  onRemove(): void;
}) {
  return (
    <div className="draft-image">
      <AttachmentImage
        attachment={image.attachment}
        name={image.name}
        onOpen={(_attachment, _name, trigger) => onOpen(trigger)}
        onReadAttachment={onReadAttachment}
      />
      <button
        className="remove-draft-image"
        type="button"
        aria-label={i18n.t("shell:removeImageName", { name: image.name })}
        title={i18n.t("shell:removeImageName", { name: image.name })}
        onClick={onRemove}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

function imageFiles(files: FileList): File[] {
  return Array.from(files).filter((file) =>
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type),
  );
}

function hasImageFiles(files: FileList): boolean {
  return imageFiles(files).length > 0;
}

function AgentMessage({
  item,
  showActions,
  turn,
  usage,
}: {
  item: Extract<ThreadItem, { type: "agentMessage" }>;
  showActions: boolean;
  turn: Turn;
  usage?: ModelUsageAggregate;
}) {
  const source = useContext(CanonicalMessageForkContext);
  const onFork = useContext(MessageForkContext);
  const forkTarget =
    source !== null && onFork !== null && source.items.get(item.id) === turn.id
      ? { sourceThreadId: source.threadId, itemId: item.id }
      : undefined;
  return (
    <article className="agent-copy" data-read-message-id={item.id}>
      <Markdown text={item.text} />
      {item.text.length === 0 ? <span className="stream-cursor" /> : null}
      {showActions || forkTarget !== undefined ? (
        <MessageActions
          className="assistant-message-actions"
          copyLabel={i18n.t("shell:copyAssistantMessage")}
          copiedLabel={i18n.t("shell:copiedAssistantMessage")}
          text={item.text}
          turn={turn}
          usage={showActions ? usage : undefined}
          showMetadata={showActions}
          forkTarget={forkTarget}
        />
      ) : null}
    </article>
  );
}

function MessageActions({
  className,
  copyLabel,
  copiedLabel,
  text,
  turn,
  usage,
  showMetadata = true,
  forkTarget,
}: {
  className: string;
  copyLabel: string;
  copiedLabel: string;
  text: string;
  turn: Turn;
  usage?: ModelUsageAggregate;
  showMetadata?: boolean;
  forkTarget?: MessageForkTarget;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={`message-actions ${className}`}>
      {!showMetadata || turn.completedAt === null ? null : (
        <time
          className="message-time"
          dateTime={new Date(turn.completedAt * 1_000).toISOString()}
        >
          {formatCompletedAt(turn.completedAt)}
        </time>
      )}
      {usage === undefined ? null : (
        <span
          className="message-cache"
          title={i18n.t("shell:turnCacheTelemetry")}
        >
          {usageLabel(usage, i18n.t("shell:cache"))}
        </span>
      )}
      <button
        className="message-copy"
        type="button"
        aria-label={copied ? copiedLabel : copyLabel}
        title={copied ? i18n.t("shell:copied") : i18n.t("shell:copy")}
        onClick={() => void copy()}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </button>
      {forkTarget === undefined ? null : (
        <MessageForkButton target={forkTarget} />
      )}
    </div>
  );
}

function MessageForkButton({ target }: { target: MessageForkTarget }) {
  const fork = useContext(MessageForkContext);
  const source = useContext(CanonicalMessageForkContext);
  const busy = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const run = async () => {
    if (busy.current || fork === null) return;
    const trigger = button.current;
    const stillVisible = () =>
      trigger !== null && trigger === button.current && trigger.isConnected;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await fork(target, {
        isCurrent: () => source?.isCurrent(target.itemId) ?? false,
        isVisible: stillVisible,
      });
    } catch (cause) {
      if (stillVisible())
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      if (stillVisible()) setPending(false);
    }
  };
  const label = i18n.t(
    pending ? "shell:forkingMessage" : "shell:forkFromMessage",
  );
  return (
    <>
      <button
        ref={button}
        className="message-fork"
        type="button"
        disabled={pending}
        aria-label={label}
        title={label}
        aria-busy={pending}
        aria-describedby={error === null ? undefined : errorId}
        onClick={() => void run()}
      >
        <Icon name="fork" size={14} />
      </button>
      {error === null ? null : (
        <span className="message-fork-error" role="alert" id={errorId}>
          {i18n.t("shell:messageForkFailed", { error })}
        </span>
      )}
    </>
  );
}

function WakeupCard(
  props:
    | { entry: TriggerHistoryEntry }
    | {
        item: Extract<ThreadItem, { type: "hostMessage" }>;
        entry?: TriggerHistoryEntry;
        turn: Turn;
      },
) {
  if ("item" in props) {
    const { item, entry, turn } = props;
    return (
      <article className="wakeup-card host-message-row">
        <HostMessageContent
          source={item.source}
          sourceId={item.sourceId}
          text={item.text}
          prompt={entry?.prompt}
          copyAction={false}
        />
        <MessageActions
          className="host-message-actions"
          copyLabel={i18n.t("shell:copyHostMessage")}
          copiedLabel={i18n.t("shell:copiedHostMessage")}
          text={item.text}
          turn={turn}
        />
      </article>
    );
  }
  const { entry } = props;
  return (
    <article className={`wakeup-card ${entry.status}`}>
      <header>
        <Icon name="trigger" size={14} />
        <strong>{i18n.t("shell:triggerWakeup")}</strong>
        <span>{entry.kind}</span>
      </header>
      <p>{entry.reason}</p>
      <Markdown text={entry.prompt} />
      {entry.error ? <small>{entry.error}</small> : null}
    </article>
  );
}

function traceItemLabel(item: ThreadItem): string {
  if (item.type === "reasoning") {
    const summary = item.summary.join("\n").trim();
    return summary.length > 0
      ? summary
      : item.status === "inProgress"
        ? i18n.t("shell:thinking")
        : i18n.t("shell:thought");
  }
  return item.type === "commandExecution"
    ? commandTitle(item)
    : i18n.t("shell:itemDetails");
}

function completedTurnLabel(turn: Turn): string {
  const duration = turn.durationMs;
  const result =
    turn.status === "completed"
      ? i18n.t("shell:worked")
      : turn.status === "interrupted"
        ? i18n.t("shell:interrupted")
        : i18n.t("shell:failed");
  if (duration === null) return result;
  return i18n.t("shell:statusForDuration", {
    status: result,
    duration: formatDuration(duration),
  });
}

function formatCompletedAt(seconds: number): string {
  const completed = new Date(seconds * 1_000);
  const now = new Date();
  const time = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(completed);
  if (
    completed.getFullYear() === now.getFullYear() &&
    completed.getMonth() === now.getMonth() &&
    completed.getDate() === now.getDate()
  ) {
    return time;
  }
  const date = new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    completed.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  ).format(completed);
  return `${date} ${time}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return i18n.t("shell:secondsDuration", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return i18n.t("shell:minutesDuration", { minutes, seconds: seconds % 60 });
  return i18n.t("shell:hoursDuration", {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
    seconds: seconds % 60,
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
