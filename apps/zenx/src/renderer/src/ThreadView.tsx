import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { AttachmentRef } from "../../../../../src/attachment.js";
import type {
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
  type ComposerDraftImage,
  type ComposerIntent,
  type ComposerState,
} from "./composer-state.js";
import type { ZenXThreadAttachmentProjection } from "../../main/image-attachments.js";
import { ComposerModelMenu } from "./ComposerModelMenu.js";
import { Icon } from "./icons.js";
import { Markdown } from "./Markdown.js";
import { activeTurn } from "./thread-view-state.js";
import type { PluginUiRegistry } from "./plugin-ui-host.js";
import { ToolResultRenderer } from "./ToolResultRenderer.js";
import {
  commandLabel,
  projectTurn,
  type TurnDisplayNode,
} from "./turn-projection.js";

interface ThreadViewProps {
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
  providerProfiles?: readonly ZenXProviderProfile[];
  selectedModel?: string;
  selectedReasoningEffort?: string | null;
  switchingModel?: boolean;
  thread: Thread | null;
  threadAttachments?: ZenXThreadAttachmentProjection;
  threadUsage?: ModelUsageProjection;
  wakeups?: readonly TriggerHistoryEntry[];
  watching?: boolean;
  pluginSnapshot?: ZenXPluginSnapshot | null;
  pluginUiRegistry?: PluginUiRegistry | null;
  onDraftChange(draft: string): void;
  onImportImages?(files: readonly File[]): Promise<void>;
  onPickImages?(): Promise<void>;
  onRemoveImage?(imageId: string): void;
  onReadAttachment?(attachment: AttachmentRef): Promise<Uint8Array>;
  onInterrupt(turnId: string): Promise<void>;
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
  providerProfiles = [],
  selectedModel,
  selectedReasoningEffort = null,
  switchingModel = false,
  thread,
  threadAttachments = {},
  threadUsage,
  wakeups = [],
  watching = false,
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
  onModelChange,
  onReasoningChange,
  onRespondToApproval,
  onSubmit,
}: ThreadViewProps) {
  const [interrupting, setInterrupting] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingImages, setDraggingImages] = useState(false);
  const [preview, setPreview] = useState<{
    attachment: AttachmentRef;
    name: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  const [atLive, setAtLive] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const runningTurn = thread === null ? null : activeTurn(thread);
  const turns = thread?.turns ?? [];
  const pendingApprovals = approvals.filter(
    (approval) => approval.status === "pending",
  );
  const submitting = composer.submission?.status === "pending";
  const hasDraft = composerDraftHasContent(composer.draft);
  const blockedByImageCapability =
    composer.draft.images.length > 0 && imageCapabilityError !== null;

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll !== null && shouldFollowRef.current) {
      scroll.scrollTop = scroll.scrollHeight;
      setAtLive(true);
    }
  }, [thread?.turns, approvals]);

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

  const primaryMode =
    runningTurn === null ? "send" : !hasDraft ? "stop" : "replace";
  const primaryLabel =
    primaryMode === "send"
      ? "Send"
      : primaryMode === "stop"
        ? "Stop"
        : "Interrupt and send";
  const primary = () => {
    if (primaryMode === "stop") void interrupt();
    else submit(primaryMode === "replace" ? "replace" : "start");
  };

  return (
    <div
      className={`thread-view${draggingImages ? " image-dragging" : ""}`}
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
        <div className="messages-inner">
          {threadUsage === undefined ||
          threadUsage.thread.responseCount === 0 ? null : (
            <div className="thread-usage">
              {usageLabel(threadUsage.thread, "Thread cache")}
            </div>
          )}
          {turns.length === 0
            ? (emptyContent ?? (
                <div className="thread-empty">
                  <div className="empty-glyph" aria-hidden="true">
                    <Icon name="compose" size={20} />
                  </div>
                  <h2>Start a new thread</h2>
                  <p>
                    Describe the outcome you want. ZenX will use this Thread’s
                    workspace, model, and permission policy.
                  </p>
                </div>
              ))
            : turns.map((turn, index) => (
                <TurnBlock
                  index={index}
                  key={turn.id}
                  turn={turn}
                  usage={threadUsage?.turns[turn.id]}
                  wakeups={wakeups}
                  attachments={threadAttachments}
                  onOpenImage={(attachment, name, trigger) =>
                    setPreview({ attachment, name, trigger })
                  }
                  onReadAttachment={onReadAttachment}
                  pluginSnapshot={pluginSnapshot}
                  pluginUiRegistry={pluginUiRegistry}
                />
              ))}
        </div>
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

      <div className="bottom-zone">
        {composerContext}
        {pendingApprovals.map((approval) => (
          <ApprovalBar
            approval={approval}
            key={approval.requestId}
            onRespond={onRespondToApproval}
          />
        ))}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            primary();
          }}
        >
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
            disabled={composerDisabled}
            onChange={(event) => onDraftChange(event.target.value)}
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
              if (event.key !== "Enter" || event.shiftKey) return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (event.repeat) return;
              submit(runningTurn === null ? "start" : "steer");
            }}
            placeholder={
              runningTurn === null
                ? watching
                  ? "Send a message to wake this thread…"
                  : "Ask ZenX anything…"
                : "Steer the current run…"
            }
            rows={1}
            value={composer.draft.text}
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
              {permissionLabel === null ? null : (
                <button
                  className="composer-tool permission-control"
                  type="button"
                  aria-label={`Permission policy: ${permissionLabel}`}
                  disabled
                >
                  <Icon name="lock" size={14} />
                  <span>{permissionLabel}</span>
                </button>
              )}
            </div>
            <div className="composer-actions">
              {runningTurn !== null && hasDraft ? (
                <button
                  className="steer-button"
                  type="button"
                  disabled={
                    composerDisabled || submitting || blockedByImageCapability
                  }
                  onClick={() => submit("steer")}
                >
                  {submitting && composer.submission?.intent === "steer"
                    ? "Steering…"
                    : "Steer"}
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
          {composer.submission?.status === "failed" ||
          interruptError !== null ||
          attachmentError !== null ||
          blockedByImageCapability ||
          modelError !== null ? (
            <p
              className="composer-error"
              id={modelError === null ? undefined : "composer-model-error"}
              role="alert"
            >
              {interruptError ??
                attachmentError ??
                (blockedByImageCapability ? imageCapabilityError : null) ??
                composer.submission?.error ??
                modelError}
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
  const [expanded, setExpanded] = useState(false);
  const complete = turn.status !== "inProgress";
  return (
    <section className={`turn ${turn.status}`} aria-label={`Turn ${index + 1}`}>
      {projection.userItems.map((item) => {
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
      })}
      {complete ? (
        <button
          className="turn-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{completedTurnLabel(turn)}</span>
          {usage === undefined ? null : (
            <small className="turn-usage">{usageLabel(usage, "Cache")}</small>
          )}
          <Icon name="chevron-down" size={14} />
        </button>
      ) : (
        <div className="turn-running-label" aria-live="polite">
          <span className="mini-spinner" aria-hidden="true" />
          <span>Working</span>
          {usage === undefined ? null : (
            <small className="turn-usage">{usageLabel(usage, "Cache")}</small>
          )}
        </div>
      )}
      {!complete || expanded ? (
        <div className="turn-history">
          {projection.history.map((node) => (
            <DisplayNode
              key={node.kind === "agent" ? node.item.id : node.id}
              node={node}
              turn={turn}
              usage={usage}
              pluginSnapshot={pluginSnapshot}
              pluginUiRegistry={pluginUiRegistry}
            />
          ))}
          {!complete && projection.finalItem !== null ? (
            <AgentMessage item={projection.finalItem} turn={turn} usage={usage} />
          ) : null}
        </div>
      ) : null}
      {complete && projection.finalItem !== null ? (
        <div className="turn-final">
          <AgentMessage item={projection.finalItem} turn={turn} usage={usage} />
        </div>
      ) : projection.terminalFallback === null ? null : (
        <div className="turn-terminal" role="status">
          {projection.terminalFallback}
        </div>
      )}
    </section>
  );
}

function usageLabel(usage: ModelUsageAggregate, prefix: string): string {
  const cache =
    usage.cacheHitRate === undefined
      ? `${prefix} unknown`
      : `${prefix} ${String(Math.round(usage.cacheHitRate * 100))}%`;
  return `${cache} · ${formatTokenCount(usage.inputTokens)} in · ${formatTokenCount(usage.outputTokens)} out`;
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
  node: TurnDisplayNode;
  turn: Turn;
  usage?: ModelUsageAggregate;
  pluginSnapshot: ZenXPluginSnapshot | null;
  pluginUiRegistry: PluginUiRegistry | null;
}) {
  return node.kind === "agent" ? (
    <AgentMessage item={node.item} turn={turn} usage={usage} />
  ) : (
    <TraceSequence
      node={node}
      pluginSnapshot={pluginSnapshot}
      pluginUiRegistry={pluginUiRegistry}
    />
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
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const grouped = node.kind === "traceGroup";
  const singleton = node.kind === "traceItem" ? node.item : null;
  const singletonExpandable =
    singleton !== null && traceItemExpandable(singleton);
  const toggleExpanded = () => {
    setExpanded((current) => {
      if (current) setOpenItems(new Set());
      else if (singleton !== null && singletonExpandable) {
        setOpenItems(new Set([singleton.id]));
      }
      return !current;
    });
  };
  return (
    <section className={grouped ? "trace-group" : "trace-item trace-singleton"}>
      {grouped ? (
        <button
          className="trace-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <Icon name="layers" size={15} />
          <span>{node.summary}</span>
          <small>{node.items.length} items</small>
          <Icon name="chevron-down" size={13} />
        </button>
      ) : singletonExpandable ? (
        <button
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
      {!grouped && expanded && singletonExpandable ? (
        <TraceDetail
          item={singleton}
          pluginSnapshot={pluginSnapshot}
          pluginUiRegistry={pluginUiRegistry}
        />
      ) : null}
      {grouped && expanded ? (
        <div className="trace-items">
          {node.items.map((item) => {
            const open = openItems.has(item.id);
            const expandable = traceItemExpandable(item);
            return (
              <div className="trace-item" key={item.id}>
                {expandable ? (
                  <button
                    className="trace-item-toggle"
                    type="button"
                    aria-expanded={open}
                    onClick={() =>
                      setOpenItems((current) => {
                        const next = new Set(current);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  >
                    <TraceItemHeader item={item} expandable />
                  </button>
                ) : (
                  <div className="trace-item-static">
                    <TraceItemHeader item={item} expandable={false} />
                  </div>
                )}
                {open && expandable ? (
                  <TraceDetail
                    item={item}
                    pluginSnapshot={pluginSnapshot}
                    pluginUiRegistry={pluginUiRegistry}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
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
        name={item.type === "reasoning" ? "reasoning" : "terminal"}
        size={14}
      />
      <strong>{item.type === "reasoning" ? "Think" : "Tool"}</strong>
      <span>{traceItemLabel(item)}</span>
      <StatusMark item={item} />
      {expandable ? <Icon name="chevron-down" size={13} /> : null}
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
  if (item.type !== "commandExecution") return null;
  return item.status === "inProgress" ? (
    <span className="mini-spinner" aria-label="Running" />
  ) : (
    <small className={`tool-status ${item.status}`}>
      {commandStatus(item.status)}
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
    <div className="trace-detail">
      <code>{item.command}</code>
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
      <div className="user-bubble">
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
        {text.length === 0 ? null : <Markdown text={text} />}
      </div>
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

function AttachmentImage({
  attachment,
  name,
  onOpen,
  onReadAttachment,
}: {
  attachment: AttachmentRef;
  name: string;
  onOpen(
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
}) {
  const { url, error } = useAttachmentUrl(attachment, onReadAttachment);
  return (
    <button
      className="image-thumbnail"
      type="button"
      aria-label={`Preview ${name}`}
      disabled={url === null}
      onClick={(event) => onOpen(attachment, name, event.currentTarget)}
    >
      {url === null ? (
        <span className="image-placeholder" role={error ? "alert" : undefined}>
          {error ? "Image unavailable" : "Loading image"}
        </span>
      ) : (
        <img alt={name} src={url} />
      )}
    </button>
  );
}

function ImagePreview({
  attachment,
  name,
  onClose,
  onReadAttachment,
  trigger,
}: {
  attachment: AttachmentRef;
  name: string;
  onClose(): void;
  onReadAttachment(attachment: AttachmentRef): Promise<Uint8Array>;
  trigger: HTMLButtonElement;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { url, error } = useAttachmentUrl(attachment, onReadAttachment);
  useEffect(() => {
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      trigger.focus();
    };
  }, [onClose, trigger]);
  return (
    <div
      className="image-preview-layer"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="image-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-preview-title"
      >
        <header>
          <strong id="image-preview-title">{name}</strong>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            aria-label="Close image preview"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="image-preview-content">
          {url === null ? (
            <p role={error ? "alert" : "status"}>{error ?? "Loading image…"}</p>
          ) : (
            <img alt={name} src={url} />
          )}
        </div>
      </section>
    </div>
  );
}

function useAttachmentUrl(
  attachment: AttachmentRef,
  read: (attachment: AttachmentRef) => Promise<Uint8Array>,
): { url: string | null; error: string | null } {
  const [state, setState] = useState<{
    url: string | null;
    error: string | null;
  }>({ url: null, error: null });
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setState({ url: null, error: null });
    void read(attachment)
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(
          new Blob([bytes.slice().buffer], { type: attachment.mediaType }),
        );
        setState({ url: objectUrl, error: null });
      })
      .catch((error: unknown) => {
        if (active) setState({ url: null, error: describeError(error) });
      });
    return () => {
      active = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment, read]);
  return state;
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
  turn,
  usage,
}: {
  item: Extract<ThreadItem, { type: "agentMessage" }>;
  turn: Turn;
  usage?: ModelUsageAggregate;
}) {
  return (
    <article className="agent-copy">
      <Markdown text={item.text} />
      {item.text.length === 0 ? <span className="stream-cursor" /> : null}
      <MessageActions
        className="assistant-message-actions"
        copyLabel="Copy assistant message"
        text={item.text}
        turn={turn}
        usage={usage}
      />
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
          {terminalTimeLabel(turn.status)} {formatCompletedAt(turn.completedAt)}
        </time>
      )}
      {usage === undefined ? null : (
        <span className="message-cache" title="Turn cache telemetry">
          {usageLabel(usage, "Cache")}
        </span>
      )}
      <button type="button" aria-label={copyLabel} onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
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
    } catch (reason) {
      setError(describeError(reason));
    }
  };
  return (
    <div className="approval-bar">
      <span className="approval-icon" aria-hidden="true">
        <Icon name="warning" size={15} />
      </span>
      <div>
        <strong>Allow this command for the current step?</strong>
        <span title={approval.params.command}>{approval.params.command}</span>
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
          Allow once
        </button>
      </div>
    </div>
  );
}

function traceItemLabel(item: ThreadItem): string {
  if (item.type === "reasoning") {
    const summary = item.summary.join("\n").trim();
    return summary.length > 0 ? summary : "Reasoning details";
  }
  return item.type === "commandExecution"
    ? commandLabel(item.command)
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

function terminalTimeLabel(status: Turn["status"]): string {
  return status === "completed"
    ? "Completed"
    : status === "interrupted"
      ? "Interrupted"
      : status === "failed"
        ? "Failed"
        : "Ended";
}

function formatCompletedAt(seconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(seconds * 1_000));
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function commandStatus(
  status: Extract<ThreadItem, { type: "commandExecution" }>["status"],
): string {
  return {
    inProgress: "Running",
    completed: "Done",
    failed: "Failed",
    declined: "Declined",
  }[status];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
