import type { SkillEntry } from "../../../../cli/src/skills.js";
import { parseSkillDraft, withSkillDraft } from "./skill-draft.js";
import { commandStatus, toolPresentation } from "./tool-presentation.js";
import { isCompactCommand } from "./compact-command.js";
import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AttachmentRef } from "../../../../../src/attachment.js";
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
} from "./composer-state.js";
import type { ZenXThreadAttachmentProjection } from "../../main/image-attachments.js";
import { ComposerModelMenu } from "./ComposerModelMenu.js";
import { Icon } from "./icons.js";
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
  commandLabel,
  groupReasoningWithoutDetailsRows,
  projectTurn,
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

interface ThreadViewProps {
  composerSendMode?: ComposerSendMode;
  queueFailure?: {
    queuedItemId: string;
    code: string;
    message: string;
  } | null;
  onResumeQueue?(): Promise<void>;
  onCancelQueued?(
    targets: readonly QueuedCancellationTarget[],
  ): Promise<{ results: QueuedCancellationResult[] }>;
  approvals: readonly ApprovalCardState[];
  composer: ComposerState;
  composerContext?: ReactNode;
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

export function ThreadView({
  composerSendMode = "soft",
  queueFailure = null,
  onResumeQueue,
  onCancelQueued,
  approvals,
  composer,
  composerContext = null,
  composerDisabled = false,
  emptyContent = null,
  modelDisabled = false,
  modelError = null,
  imageCapabilityError = null,
  imageCapabilityNotice = null,
  models = [],
  permissionLabel = "Full access",
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
    throw new Error("Image payload reader is unavailable");
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
  const [interrupting, setInterrupting] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [queueResumeError, setQueueResumeError] = useState<{
    threadId: string;
    queuedItemId: string;
    message: string;
  } | null>(null);
  const [cancelingQueue, setCancelingQueue] = useState(false);
  const [cancelConfirmation, setCancelConfirmation] = useState<{
    threadId: string;
    targets: QueuedCancellationTarget[];
    previews: string[];
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
  } | null>(null);
  const [atLive, setAtLive] = useState(true);
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
  const shouldFollowRef = useRef(true);
  const viewRef = useRef<HTMLDivElement>(null);
  const bottomZoneRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const runningTurn = thread === null ? null : activeTurn(thread);
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
    (approval) => approval.status === "pending",
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

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll !== null && shouldFollowRef.current) {
      scroll.scrollTop = scroll.scrollHeight;
      setAtLive(true);
    }
  }, [approvals, composer.compaction, thread?.canonicalItems, thread?.turns]);

  // Keep a newly failed request visible when approvals, queued messages and a
  // long draft overflow the bottom zone. User scrolling afterwards is left
  // alone; focus can still scroll the queue and approval controls into view.
  useLayoutEffect(() => {
    if (composer.compaction?.status !== "failed") return;
    const zone = bottomZoneRef.current;
    if (zone !== null) zone.scrollTop = zone.scrollHeight;
  }, [composer.compaction, thread?.id]);

  // The Composer overlays the bottom of the full-height transcript scroll
  // area. Publish its live height so the list reserves matching virtual
  // space and Back to live can float just above it; growth keeps a live
  // view pinned to the bottom.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const zone = bottomZoneRef.current;
    if (view === null || zone === null) return;
    const publish = () => {
      const height = `${Math.round(zone.getBoundingClientRect().height)}px`;
      if (view.style.getPropertyValue("--bottom-zone-height") === height)
        return;
      view.style.setProperty("--bottom-zone-height", height);
      const scroll = scrollRef.current;
      if (shouldFollowRef.current && scroll !== null)
        scroll.scrollTop = scroll.scrollHeight;
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(zone);
    return () => {
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (textarea === null) return;

    // Reset before measuring so deleting text shrinks the editor as well as
    // adding text grows it. Keep the budget bounded so the transcript remains
    // usable in short windows; the textarea itself scrolls beyond the cap.
    const resize = () => {
      textarea.style.height = "auto";
      const contentHeight = textarea.scrollHeight;
      const style = window.getComputedStyle(textarea);
      const declaredMinHeight = Number.parseFloat(style.minHeight);
      const minHeight = Number.isFinite(declaredMinHeight)
        ? declaredMinHeight
        : 54;
      const declaredMaxHeight = Number.parseFloat(style.maxHeight);
      const maxHeight = Number.isFinite(declaredMaxHeight)
        ? declaredMaxHeight
        : 136;
      const height = Math.min(Math.max(contentHeight, minHeight), maxHeight);
      textarea.style.height = `${height}px`;
      textarea.style.overflowY = contentHeight > height ? "auto" : "hidden";
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [composer.draft.text]);

  const submit = (intent: ComposerIntent) => {
    if (composerDisabled || !hasDraft || submitting || blockedByImageCapability)
      return;
    if (intent === "start" && runningTurn !== null) return;
    if (intent !== "start" && runningTurn === null) return;
    void onSubmit(intent, runningTurn?.id ?? null);
  };

  const interrupt = async () => {
    if (composerDisabled || runningTurn === null || interrupting || submitting)
      return;
    setInterrupting(true);
    setInterruptError(null);
    try {
      await onInterrupt(runningTurn.id);
    } catch (error) {
      setInterruptError(describeError(error));
    } finally {
      setInterrupting(false);
    }
  };

  const sendIntent = defaultComposerIntent(
    runningTurn !== null,
    composerSendMode,
  );
  const alternateIntent = defaultComposerIntent(
    runningTurn !== null,
    composerSendMode,
    true,
  );
  const primaryMode =
    runningTurn === null ? "send" : !hasDraft ? "stop" : sendIntent;
  const intentLabel = (intent: ComposerIntent) =>
    intent === "batch-next"
      ? "Next turn"
      : intent === "queue"
        ? "Each turn"
        : intent === "steer"
          ? "Steer now"
          : intent === "replace"
            ? "Interrupt and send"
            : "Send";
  const primaryLabel = compactRequested
    ? "Compact context"
    : primaryMode === "stop"
      ? "Stop"
      : intentLabel(sendIntent);
  const primary = () => {
    if (primaryMode === "stop") void interrupt();
    else submit(sendIntent);
  };
  const cancelQueued = async (targets: readonly QueuedCancellationTarget[]) => {
    if (thread === null || onCancelQueued === undefined || cancelingQueue)
      return;
    const threadId = thread.id;
    setCancelingQueue(true);
    setCancelNotice(null);
    try {
      const result = await onCancelQueued(targets);
      const started = result.results.filter(
        (entry) => entry.status === "already_started",
      ).length;
      const missing = result.results.filter(
        (entry) => entry.status === "not_found",
      ).length;
      if (started > 0 || missing > 0)
        setCancelNotice({
          threadId,
          message: `${started} message(s) already starting or delivered and cannot be canceled; ${missing} no longer match this Thread. Only still-pending entries were canceled. Use Stop separately if you need to interrupt the active Turn.`,
        });
    } catch (error) {
      setCancelNotice({ threadId, message: describeError(error) });
    } finally {
      setCancelingQueue(false);
    }
  };
  const visibleResumeError =
    queueResumeError !== null &&
    thread !== null &&
    queueResumeError.threadId === thread.id &&
    thread.queuedMessages?.some(
      (entry) => entry.id === queueResumeError.queuedItemId,
    )
      ? queueResumeError.message
      : null;
  const composerError =
    interruptError ??
    (queueFailure === null ? visibleResumeError : null) ??
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
        onScroll={(event) => {
          const target = event.currentTarget;
          const live =
            target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          shouldFollowRef.current = live;
          setAtLive(live);
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
              {transcriptRows.length === 0
                ? (emptyContent ?? (
                    <div className="thread-empty">
                      <h2>Start a new thread</h2>
                      <p>
                        Describe the outcome you want. ZenX will use this
                        Thread’s workspace, model, and permission policy.
                      </p>
                    </div>
                  ))
                : transcriptRows.map((row) =>
                    row.type === "turn" ? (
                      <TurnBlock
                        index={row.index}
                        key={row.turn.id}
                        turn={row.turn}
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
            scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
            setAtLive(true);
          }}
        >
          <Icon name="arrow-down" size={14} />
          Back to live
        </button>
      )}

      <div className="bottom-zone" ref={bottomZoneRef}>
        {composerContext}
        {pendingApprovals.map((approval) => (
          <ApprovalBar
            approval={approval}
            key={approval.requestId}
            onRespond={onRespondToApproval}
          />
        ))}
        {(thread?.queuedMessages?.length ?? 0) > 0 ? (
          <div
            className={`queued-messages${onCancelQueued === undefined ? "" : " cancellable"}`}
            aria-label="Message queue"
          >
            <strong role="status" aria-live="polite" aria-atomic="true">
              {thread!.queuedMessages!.length} queued
            </strong>
            <ol>
              {thread!.queuedMessages!.map((message, index) => (
                <li key={message.id}>
                  {message.text || `${message.imageCount} image(s)`}
                  {onCancelQueued === undefined ? null : (
                    <button
                      className="queued-cancel-button"
                      type="button"
                      aria-label={`Cancel queued message ${index + 1}`}
                      title="Cancel this pending message only"
                      disabled={cancelingQueue || composerDisabled}
                      onClick={() =>
                        void cancelQueued([
                          {
                            queuedItemId: message.id,
                            clientId: message.clientId,
                          },
                        ])
                      }
                    >
                      Cancel
                    </button>
                  )}
                  {queueFailure?.queuedItemId === message.id ? (
                    <p className="queued-failure" role="alert">
                      Not delivered ({queueFailure.code}):{" "}
                      {queueFailure.message}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
            {onCancelQueued !== undefined &&
            thread!.queuedMessages!.length > 1 ? (
              <button
                type="button"
                disabled={
                  cancelingQueue ||
                  composerDisabled ||
                  thread!.queuedMessages!.length > 128
                }
                title={
                  thread!.queuedMessages!.length > 128
                    ? "Too many messages for one cancellation; cancel individual messages"
                    : undefined
                }
                onClick={() =>
                  setCancelConfirmation({
                    threadId: thread!.id,
                    targets: thread!.queuedMessages!.map((message) => ({
                      queuedItemId: message.id,
                      clientId: message.clientId,
                    })),
                    previews: thread!.queuedMessages!.map(
                      (message) =>
                        message.text || `${message.imageCount} image(s)`,
                    ),
                  })
                }
              >
                Cancel these {thread!.queuedMessages!.length} queued messages…
              </button>
            ) : null}
            {runningTurn === null && onResumeQueue !== undefined ? (
              <button
                type="button"
                onClick={() =>
                  void onResumeQueue()
                    .then(() => setQueueResumeError(null))
                    .catch((error: unknown) =>
                      setQueueResumeError({
                        threadId: thread!.id,
                        queuedItemId: thread!.queuedMessages![0]!.id,
                        message: describeError(error),
                      }),
                    )
                }
              >
                Continue queue
              </button>
            ) : null}
          </div>
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
        <form
          className="composer"
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
            <div className="composer-images" aria-label="Skills to send">
              {skillDraft.skills.map((skill) => (
                <button
                  type="button"
                  className="quiet-button"
                  key={skill.id}
                  aria-label={`Remove Skill ${skill.name}`}
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
              aria-label="References to send"
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
                    aria-label={`Remove reference ${reference.name}`}
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
          <WorkflowCommandMenu id={selectorId} selector={selector} />
          <label className="sr-only" htmlFor="thread-composer">
            Message ZenX
          </label>
          {composer.draft.images.length === 0 ? null : (
            <div className="composer-images" aria-label="Images to send">
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
          <textarea
            id="thread-composer"
            aria-label="Message"
            data-autogrow="true"
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
              if (!event.nativeEvent.isComposing && selector.open) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  selector.dismiss();
                  return;
                }
                if (
                  (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                  selector.rows.length
                ) {
                  event.preventDefault();
                  selector.setActive(
                    (selector.active +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      selector.rows.length) %
                      selector.rows.length,
                  );
                  return;
                }
                if (
                  (event.key === "Enter" && !event.shiftKey) ||
                  (event.key === "Tab" &&
                    (selector.rows.length || selector.loading || selector.busy))
                ) {
                  event.preventDefault();
                  if (!event.repeat) void selector.choose(selector.active);
                  return;
                }
              }
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
                  ? "Send a message to wake this thread…"
                  : "Ask ZenX anything…"
                : composerSendMode === "queue" || composerSendMode === "batch"
                  ? "Message for the next turn…"
                  : "Steer the current run…"
            }
            ref={composerTextareaRef}
            rows={1}
            value={skillDraft.text}
          />
          <div className="composer-rail">
            <div className="composer-tools">
              <button
                className="composer-tool icon-only"
                type="button"
                aria-label="Add images"
                title="Add images"
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
                  legacyApproval={permissionLabel === "Approval required"}
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
              {runningTurn === null ? null : (
                <span
                  className="composer-current-mode"
                  aria-label={`Send mode: ${intentLabel(sendIntent)}`}
                >
                  {intentLabel(sendIntent)}
                </span>
              )}
              {runningTurn !== null && hasDraft
                ? (["steer", "batch-next", "queue"] as const)
                    .filter(
                      (intent) =>
                        intent !== sendIntent && intent !== alternateIntent,
                    )
                    .map((intent) => (
                      <button
                        key={intent}
                        className="steer-button"
                        type="button"
                        disabled={
                          composerDisabled ||
                          submitting ||
                          blockedByImageCapability
                        }
                        onClick={() => submit(intent)}
                      >
                        {intentLabel(intent)}
                      </button>
                    ))
                : null}
              {runningTurn !== null && hasDraft ? (
                <button
                  className="steer-button"
                  type="button"
                  disabled={
                    composerDisabled || submitting || blockedByImageCapability
                  }
                  onClick={() => submit(alternateIntent)}
                >
                  {intentLabel(alternateIntent)}
                </button>
              ) : null}
              <button
                className={`action-orb ${primaryMode}`}
                type="button"
                aria-label={primaryLabel}
                title={primaryLabel}
                disabled={
                  composerDisabled ||
                  interrupting ||
                  submitting ||
                  (primaryMode === "send" && !hasDraft) ||
                  blockedByImageCapability
                }
                onClick={primary}
              >
                <Icon
                  name={primaryMode === "stop" ? "stop" : "send"}
                  size={18}
                />
              </button>
            </div>
          </div>
          {composerError !== null ? (
            <p
              className="composer-error"
              id={modelError === null ? undefined : "composer-model-error"}
              role="alert"
            >
              {composerError}
            </p>
          ) : null}
          {composer.confirmedAdmission !== undefined ? (
            <p className="composer-note" role="status">
              {composer.confirmedAdmission.stage === "queued"
                ? "Message was admitted to the queue; delivery is not confirmed."
                : composer.confirmedAdmission.stage === "delivered"
                  ? "Message added to a Turn; execution may still be running."
                  : composer.confirmedAdmission.stage === "completed"
                    ? "The Turn containing this message completed."
                    : "The Turn containing this message ended without completion."}
            </p>
          ) : null}
          {composer.draft.images.length > 0 &&
          imageCapabilityNotice !== null &&
          !blockedByImageCapability ? (
            <p className="composer-note" role="status">
              {imageCapabilityNotice}
            </p>
          ) : null}
        </form>
      </div>
      {cancelConfirmation === null ? null : (
        <Dialog
          open={cancelConfirmation.threadId === thread?.id}
          onOpenChange={(open) => {
            if (!open) setCancelConfirmation(null);
          }}
          title={`Cancel ${cancelConfirmation.targets.length} queued messages?`}
        >
          <div className="queued-cancel-confirmation">
            <h2>Cancel {cancelConfirmation.targets.length} queued messages?</h2>
            <p>
              Only these pending messages are requested. Messages queued later
              are not included. A message already starting or delivered cannot
              be recalled or stopped by this action.
            </p>
            <ol>
              {cancelConfirmation.previews.map((preview, index) => (
                <li key={cancelConfirmation.targets[index]?.queuedItemId}>
                  {preview}
                </li>
              ))}
            </ol>
            <div className="queued-cancel-confirmation-actions">
              <button type="button" onClick={() => setCancelConfirmation(null)}>
                Keep messages
              </button>
              <button
                type="button"
                disabled={cancelingQueue}
                onClick={() => {
                  const targets = cancelConfirmation.targets;
                  setCancelConfirmation(null);
                  void cancelQueued(targets);
                }}
              >
                Confirm cancel {cancelConfirmation.targets.length}
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {preview === null ? null : (
        <ImagePreview
          attachment={preview.attachment}
          name={preview.name}
          onClose={() => setPreview(null)}
          onReadAttachment={onReadAttachment}
          trigger={preview.trigger}
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
                <summary tabIndex={0}>Technical details</summary>
                <p>{state.detail}</p>
              </details>
            ) : null}
            {onDismiss ? (
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss compaction error"
              >
                Dismiss
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
      aria-label="Context compacted"
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
          <strong>Context compacted</strong>
          <small>
            {compactionInitiatorLabel(item)} ·{" "}
            {Array.from(item.summary).length.toLocaleString()} summary
            characters · Full input size unknown
          </small>
        </span>
        <Icon name="chevron-down" size={13} />
      </button>
      {expanded ? (
        <div className="context-compaction-detail">
          <div className="compaction-summary-heading">
            <h3>Saved summary</h3>
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                void navigator.clipboard.writeText(item.summary).then(
                  () => setCopyState("Summary copied"),
                  () =>
                    setCopyState(
                      "Could not copy. Select the summary text to copy it.",
                    ),
                );
              }}
            >
              Copy summary
            </button>
          </div>
          <span role="status">{copyState}</span>
          <div className="compaction-summary">
            <Markdown text={item.summary} />
          </div>
          <p>
            {item.retainedItemIds.length} original items retained alongside the
            summary. This snapshot is from the time of compaction; later
            conversation adds to it.
          </p>
          <details className="compaction-projection">
            <summary>Retained context and diagnostics</summary>
            <p>
              {effectiveMessages.length} projected history messages, not tokens.
              This includes the summary and retained conversation. Rules, tool
              definitions and other request inputs may be added separately. Full
              model input size was not recorded. The summary generation usage is
              not the post-compaction context size.
            </p>
            <ol>
              {effectiveMessages.map((message, index) => (
                <li key={`${item.id}:${String(index)}`}>
                  <span>{modelMessageRole(message)}</span>
                  <pre>{formatModelMessage(message)}</pre>
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function modelMessageRole(message: ModelMessage): string {
  if (message.role === "tool") return "Tool";
  if (message.role === "reasoning") return "Reasoning";
  return message.role === "assistant" ? "Assistant" : "User";
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

function RunningTurnLabel({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const duration = startedAt === null ? null : now - startedAt * 1_000;
  return (
    <div className="turn-running-label" role="status" aria-label="Working">
      <span className="mini-spinner" aria-hidden="true" />
      <span aria-hidden="true">
        {duration === null
          ? "Working"
          : `Working for ${formatDuration(duration)}`}
      </span>
    </div>
  );
}

function TurnBlock({
  turn,
  index,
  wakeups,
  attachments,
  onOpenImage,
  onReadAttachment,
  pluginSnapshot,
  pluginUiRegistry,
  usage,
}: {
  turn: Turn;
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
}) {
  const projection = useMemo(() => projectTurn(turn), [turn]);
  const [expandedOverride, setExpanded] = useState<boolean | null>(null);
  const expanded =
    expandedOverride ??
    (turn.status === "failed" || turn.status === "interrupted");
  const complete = turn.status !== "inProgress";
  const renderUserItem = (
    item: Extract<ThreadItem, { type: "userMessage" }>,
  ) => {
    const wakeup = wakeups.find(
      (entry) => entry.clientUserMessageId === item.clientId,
    );
    return wakeup === undefined ? (
      <UserMessage
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
    <section className={`turn ${turn.status}`} aria-label={`Turn ${index + 1}`}>
      {projection.userItems.map(renderUserItem)}
      {complete ? (
        <button
          className="turn-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span>{completedTurnLabel(turn)}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      ) : (
        <RunningTurnLabel startedAt={turn.startedAt} />
      )}
      {!complete || expanded ? (
        <div className="turn-history">
          {projection.history.map((node) =>
            node.kind === "user" ? (
              renderUserItem(node.item)
            ) : (
              <DisplayNode
                key={node.kind === "agent" ? node.item.id : node.id}
                node={node}
                turn={turn}
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
              (node): node is Extract<TurnDisplayNode, { kind: "user" }> =>
                node.kind === "user",
            )
            .map((node) => renderUserItem(node.item))
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
        <div className="turn-terminal" role="status">
          {projection.terminalFallback}
        </div>
      )}
    </section>
  );
}

export function usageLabel(usage: ModelUsageAggregate, prefix: string): string {
  const cache =
    usage.cacheHitRate === undefined
      ? `${prefix} unknown`
      : `${prefix} ${String(Math.round(usage.cacheHitRate * 100))}%`;
  return `${cache} · ${formatTokenCount(usage.inputTokens)} in · ${formatTokenCount(usage.outputTokens)} out`;
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
      : `Context unknown · ${formatTokenCount(window)} configured window`;
  }
  const input = formatTokenCount(context.inputTokens);
  const source =
    context.inputTokenSource === "estimated"
      ? "estimated next input"
      : "last provider input";
  if (context.contextWindow === null || context.ratio === null) {
    return `Context unknown · ${input} ${source}`;
  }
  return `Context ${String(Math.round(context.ratio * 100))}% · ${input} ${source} / ${formatTokenCount(context.contextWindow)} configured window`;
}

export function threadCacheUsageLabel(
  cacheHitRate: number | undefined,
): string {
  return cacheHitRate === undefined
    ? "Thread cache unknown"
    : `Thread cache ${String(Math.round(cacheHitRate * 100))}%`;
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
      setPopoverPosition({
        left: Math.max(left, Math.min(anchor.right - width, right - width)),
        top: canPlaceAbove
          ? anchor.top - 8
          : Math.max(
              8,
              Math.min(
                window.innerHeight - estimatedHeight - 8,
                anchor.bottom + 8,
              ),
            ),
        width,
        placement: canPlaceAbove ? "above" : "below",
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
  const label = contextUsageLabel(context);
  const contextLabel = label ?? `Context ${String(percent)}%`;
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
        aria-label={`Open context details. ${tooltip}`}
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
        <div
          className="context-usage-popover"
          ref={popoverRef}
          style={popoverPosition}
          data-placement={popoverPosition.placement}
          id={popoverId}
          role="dialog"
          aria-label="Context details"
        >
          <div className="context-usage-heading">
            <span>Configured window</span>
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
          <p>
            {context.inputTokens === null
              ? "Usage unknown"
              : `${formatTokenCount(context.inputTokens)} ${context.inputTokenSource === "estimated" ? "estimated next input" : "last provider input"}`}
            {context.contextWindow === null
              ? " tokens"
              : ` / ${formatTokenCount(context.contextWindow)} configured window tokens`}
          </p>
          <p>{threadCacheUsageLabel(threadCacheHitRate)}</p>
          <p className="context-usage-explanation">
            Condense earlier context for the next reply. Your conversation stays
            available.
          </p>
          <button
            className="context-usage-compact"
            type="button"
            disabled={compactDisabled || onCompact === undefined}
            onClick={() => {
              setOpen(false);
              void onCompact?.();
            }}
          >
            Compact context
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function DisplayNode({
  node,
  turn,
  usage,
  pluginSnapshot,
  pluginUiRegistry,
}: {
  node: Exclude<TurnDisplayNode, { kind: "user" }>;
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
      pluginSnapshot={pluginSnapshot}
      pluginUiRegistry={pluginUiRegistry}
    />
  );
}

/** Keep content mounted for a height-independent transition; inert removes hidden controls from tab order. */
function TraceReveal({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  return (
    <div
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
  pluginSnapshot,
  pluginUiRegistry,
}: {
  node: Extract<TurnDisplayNode, { kind: "traceItem" | "traceGroup" }>;
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const [visited, setVisited] = useState(false);
  const [visitedItems, setVisitedItems] = useState<Set<string>>(new Set());
  const grouped = node.kind === "traceGroup";
  const singleton = node.kind === "traceItem" ? node.item : null;
  const singletonExpandable =
    singleton !== null && traceItemExpandable(singleton);
  const toggleExpanded = () => {
    if (expanded && sectionRef.current?.contains(document.activeElement)) {
      toggleRef.current?.focus();
    }
    setVisited(true);
    if (expanded) setOpenItems(new Set());
    else if (singleton !== null && singletonExpandable) {
      setVisitedItems((seen) => new Set(seen).add(singleton.id));
      setOpenItems(new Set([singleton.id]));
    }
    setExpanded((current) => !current);
  };
  return (
    <section
      ref={sectionRef}
      className={grouped ? "trace-group" : "trace-item trace-singleton"}
    >
      {grouped ? (
        <button
          ref={toggleRef}
          className="trace-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <Icon name="layers" size={15} />
          <span>{node.summary}</span>
          <small className="sr-only">{node.items.length} items</small>
          <Icon name="chevron-down" size={13} />
        </button>
      ) : singletonExpandable ? (
        <button
          ref={toggleRef}
          className="trace-item-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <TraceItemHeader item={singleton} expandable />
        </button>
      ) : (
        <div className="trace-item-static">
          <TraceItemHeader item={singleton!} expandable={false} />
        </div>
      )}
      {!grouped && singletonExpandable ? (
        <TraceReveal open={expanded}>
          {visited ? (
            <TraceDetail
              item={singleton}
              pluginSnapshot={pluginSnapshot}
              pluginUiRegistry={pluginUiRegistry}
            />
          ) : null}
        </TraceReveal>
      ) : null}
      {grouped ? (
        <TraceReveal open={expanded}>
          {visited ? (
            <div
              className="trace-items"
              role="region"
              aria-label="Execution details"
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
                          <strong>Think</strong>
                          <span>
                            {row.ids.length} reasoning items · no public details
                          </span>
                        </div>
                      </div>
                    );
                  }
                  const { item, nested, parentToolName } = row;
                  const open = openItems.has(item.id);
                  const expandable = traceItemExpandable(item);
                  return (
                    <div
                      className={`trace-item${nested ? " trace-item-nested" : ""}`}
                      aria-label={
                        nested
                          ? `Nested tool invoked by ${parentToolName ?? "parent code"}`
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
                            setOpenItems((current) => {
                              const next = new Set(current);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            });
                          }}
                        >
                          <TraceItemHeader item={item} expandable />
                        </button>
                      ) : (
                        <div className="trace-item-static">
                          <TraceItemHeader item={item} expandable={false} />
                        </div>
                      )}
                      {expandable ? (
                        <TraceReveal open={open}>
                          {visitedItems.has(item.id) ? (
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
  item,
  expandable,
}: {
  item: Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>;
  expandable: boolean;
}) {
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
      <strong>
        {item.type === "reasoning"
          ? "Think"
          : toolPresentation(item.toolName ?? item.command).category}
      </strong>
      <span title={traceItemLabel(item)}>{traceItemLabel(item)}</span>
      <span className="trace-item-status">
        <StatusMark item={item} />
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

function StatusMark({ item }: { item: ThreadItem }) {
  if (item.type === "reasoning") {
    if (item.status === "inProgress")
      return <span className="mini-spinner" aria-label="Thinking" />;
    if (item.status === "interrupted")
      return <small className="tool-status interrupted">Interrupted</small>;
    return null;
  }
  if (item.type !== "commandExecution") return null;
  return (
    <small className={`tool-status ${item.status}`}>
      {commandStatus(item)}
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
          aria-label="Tool output"
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
          Input {overflows ? <Icon name="chevron-down" size={13} /> : null}
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

function UserMessage({
  item,
  attachments,
  turn,
  onOpenImage,
  onReadAttachment,
}: {
  item: Extract<ThreadItem, { type: "userMessage" }>;
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
    <article className="user-row">
      {attachments.length === 0 ? null : (
        <div className="message-images" aria-label="Attached images">
          {attachments.map((attachment, index) => (
            <AttachmentImage
              attachment={attachment}
              key={`${attachment.sha256}-${String(index)}`}
              name={`Attached image ${String(index + 1)}`}
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
        copyLabel="Copy user message"
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
        aria-label={`Remove ${image.name}`}
        title={`Remove ${image.name}`}
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
  return (
    <article className="agent-copy">
      <Markdown text={item.text} />
      {item.text.length === 0 ? <span className="stream-cursor" /> : null}
      {showActions ? (
        <MessageActions
          className="assistant-message-actions"
          copyLabel="Copy assistant message"
          text={item.text}
          turn={turn}
          usage={usage}
        />
      ) : null}
    </article>
  );
}

function MessageActions({
  className,
  copyLabel,
  text,
  turn,
  usage,
}: {
  className: string;
  copyLabel: string;
  text: string;
  turn: Turn;
  usage?: ModelUsageAggregate;
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
      {turn.completedAt === null ? null : (
        <time
          className="message-time"
          dateTime={new Date(turn.completedAt * 1_000).toISOString()}
        >
          {formatCompletedAt(turn.completedAt)}
        </time>
      )}
      {usage === undefined ? null : (
        <span className="message-cache" title="Turn cache telemetry">
          {usageLabel(usage, "Cache")}
        </span>
      )}
      <button
        className="message-copy"
        type="button"
        aria-label={copied ? copyLabel.replace(/^Copy/u, "Copied") : copyLabel}
        title={copied ? "Copied" : "Copy"}
        onClick={() => void copy()}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </button>
    </div>
  );
}

function WakeupCard({ entry }: { entry: TriggerHistoryEntry }) {
  return (
    <article className={`wakeup-card ${entry.status}`}>
      <header>
        <Icon name="trigger" size={14} />
        <strong>Trigger wakeup</strong>
        <span>{entry.kind}</span>
      </header>
      <p>{entry.reason}</p>
      <Markdown text={entry.prompt} />
      {entry.error ? <small>{entry.error}</small> : null}
    </article>
  );
}

function ApprovalBar({
  approval,
  onRespond,
}: {
  approval: ApprovalCardState;
  onRespond(requestId: string, decision: ApprovalDecision): Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const respond = async (decision: "accept" | "decline") => {
    setError(null);
    try {
      await onRespond(approval.requestId, decision);
      document.getElementById("thread-composer")?.focus();
    } catch (reason) {
      setError(describeError(reason));
    }
  };
  const once = approval.params.approvalScope === "once";
  const runCode = approval.params.toolName === "run_code";
  const toolName = approval.params.toolName ?? "tool";
  const code =
    runCode && typeof approval.params.toolArguments?.code === "string"
      ? approval.params.toolArguments.code
      : approval.params.command;
  return (
    <section className="approval-bar" aria-label={`${toolName} approval`}>
      <span className="approval-icon" aria-hidden="true">
        <Icon name="warning" size={15} />
      </span>
      <div>
        <strong>
          {once
            ? `Allow ${toolName} with full file access once?`
            : runCode
              ? "Allow the shell-equivalent run_code capability?"
              : `Allow the ${toolName} capability?`}
        </strong>
        <p>
          {once
            ? "This call runs outside the file sandbox. Approval applies only to this call and its nested operations."
            : `Approval is remembered for the stable ${toolName} capability, not granted per command or code segment.`}
        </p>
        <pre className="approval-command">
          <code>{code}</code>
        </pre>
        <code className="approval-cwd">
          Working directory: {approval.params.cwd}
        </code>
        {error ? <small role="alert">{error}</small> : null}
      </div>
      <div className="approval-actions">
        <button type="button" onClick={() => void respond("decline")}>
          Deny
        </button>
        <button
          className="allow"
          type="button"
          onClick={() => void respond("accept")}
        >
          {once ? "Allow once" : "Allow capability"}
        </button>
      </div>
    </section>
  );
}

function traceItemLabel(item: ThreadItem): string {
  if (item.type === "reasoning") {
    const summary = item.summary.join("\n").trim();
    return summary.length > 0
      ? summary
      : reasoningContentText(item).trim().length > 0
        ? "Reasoning"
        : "Reasoning details";
  }
  return item.type === "commandExecution"
    ? item.toolName === "run_code" &&
      typeof item.toolArguments?.description === "string"
      ? item.toolArguments.description
      : (toolPresentation(item.toolName ?? item.command).action ??
        (typeof item.toolArguments?.command === "string"
          ? item.toolArguments.command
          : item.toolName === undefined
            ? item.command
            : commandLabel(item.toolName)))
    : "Item details";
}

function completedTurnLabel(turn: Turn): string {
  const duration = turn.durationMs;
  const result =
    turn.status === "completed"
      ? "Worked"
      : turn.status === "interrupted"
        ? "Interrupted"
        : "Failed";
  if (duration === null) return result;
  return `${result} for ${formatDuration(duration)}`;
}

function formatCompletedAt(seconds: number): string {
  const completed = new Date(seconds * 1_000);
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, {
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
    undefined,
    completed.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  ).format(completed);
  return `${date} ${time}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
