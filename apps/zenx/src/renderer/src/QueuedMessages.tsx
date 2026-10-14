import { HostMessageContent } from "./HostMessageContent.js";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QueuedCancellationTarget } from "../../../../../src/app-server.js";
import type { AttachmentRef } from "../../../../../src/attachment.js";
import { AttachmentImage } from "./ImagePresentation.js";
import { Icon } from "./icons.js";

export interface QueuedMessagePreview {
  id: string;
  clientId: string;
  text: string;
  imageCount: number;
  revision?: number;
  sender?: import("../../../../../src/item.js").ThreadMessageSender;
  hostSource?: Pick<
    import("../../../../../src/item.js").HostWakeupInput,
    "source" | "sourceId"
  >;
}

export interface QueuedMessagesProps {
  threadId: string;
  messages: readonly QueuedMessagePreview[];
  attachments?: Readonly<Record<string, readonly AttachmentRef[]>>;
  onReadAttachment?(attachment: AttachmentRef): Promise<Uint8Array>;
  onOpenImage?(
    message: Pick<QueuedMessagePreview, "id" | "clientId">,
    attachment: AttachmentRef,
    name: string,
    trigger: HTMLButtonElement,
  ): void;
  queueFailure?: {
    queuedItemId: string;
    code: string;
    message: string;
  } | null;
  pendingIds?: ReadonlySet<string>;
  steeringIds?: ReadonlySet<string>;
  running?: boolean;
  onSteer?(message: QueuedMessagePreview): void;
  steerError?: {
    queuedItemId: string;
    revision: number;
    message: string;
  } | null;
  busy?: boolean;
  resuming?: boolean;
  /** Transport failure for the current resume attempt, not a row failure. */
  resumeError?: string | null;
  compact?: boolean;
  editableIds?: ReadonlySet<string>;
  /** Saving rows may reopen their existing read-only edit session. */
  editingIds?: ReadonlySet<string>;
  onEdit?(
    message: Pick<QueuedMessagePreview, "id" | "clientId">,
    trigger: HTMLButtonElement,
  ): void;
  onCancel?(target: QueuedCancellationTarget): void;
  onCancelAll?(trigger: HTMLButtonElement): void;
  onResume?(): void;
  focusComposer?(): void;
}

function containsSelection(element: HTMLElement | null): boolean {
  if (element === null) return false;
  const selection = element.ownerDocument.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    (element.contains(selection.anchorNode) ||
      element.contains(selection.focusNode))
  );
}

/** Presentation of the native queue only; admission/removal remain with ZAS. */
export function QueuedMessages(props: QueuedMessagesProps) {
  return <QueueShelf key={props.threadId} {...props} />;
}

function QueueShelf({
  messages,
  attachments = {},
  onReadAttachment,
  onOpenImage,
  queueFailure = null,
  pendingIds,
  steeringIds,
  running = false,
  onSteer,
  steerError = null,
  busy = false,
  resuming = false,
  resumeError = null,
  compact = false,
  editableIds,
  editingIds,
  onEdit,
  onCancel,
  onCancelAll,
  onResume,
  focusComposer,
}: QueuedMessagesProps) {
  const { t } = useTranslation("shell");
  const listId = useId();
  const resumeErrorId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const focusedRowIndex = useRef(0);
  const revealFailure = useRef<string | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const hasMessages = messages.length > 0;
  const root = rootRef.current;
  const interacting =
    root !== null &&
    (root.contains(root.ownerDocument.activeElement) ||
      containsSelection(root));
  const readingCurrentMessage = messages.some((message) =>
    reading.has(message.id),
  );
  const detailsOpen =
    open ?? (!compact || showAll || readingCurrentMessage || interacting);
  const visibleMessages = showAll ? messages : messages.slice(0, 2);
  const failureHidden =
    queueFailure !== null &&
    messages.some((message) => message.id === queueFailure.queuedItemId) &&
    (!detailsOpen ||
      !visibleMessages.some(
        (message) => message.id === queueFailure.queuedItemId,
      ));

  // An approval may arrive while someone is reading, selecting or using a row.
  // Preserve that disclosure until the user explicitly closes it.
  useLayoutEffect(() => {
    if (
      compact &&
      open === null &&
      (interacting || readingCurrentMessage || showAll)
    )
      setOpen(true);
  }, [compact, interacting, open, readingCurrentMessage, showAll]);

  useEffect(() => {
    const document = rootRef.current?.ownerDocument;
    if (document === undefined) return;
    const releaseFocus = (event: Event) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      )
        focusedControl.current = null;
    };
    const leaveWindow = () => {
      focusedControl.current = null;
    };
    document.addEventListener("pointerdown", releaseFocus, true);
    document.addEventListener("focusin", releaseFocus, true);
    document.defaultView?.addEventListener("blur", leaveWindow);
    return () => {
      document.removeEventListener("pointerdown", releaseFocus, true);
      document.removeEventListener("focusin", releaseFocus, true);
      document.defaultView?.removeEventListener("blur", leaveWindow);
    };
  }, [hasMessages]);

  useLayoutEffect(() => {
    const requested = revealFailure.current;
    if (requested === null || !detailsOpen) return;
    revealFailure.current = null;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>(".queue-row");
    const row = Array.from(rows ?? []).find(
      (entry) => entry.dataset.queueId === requested,
    );
    const error = row?.querySelector<HTMLElement>(".queue-row-error");
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      ".queue-shelf-details",
    );
    if (!error || !viewport) return;
    error.focus({ preventScroll: true });
    // Scroll only this shelf, never the transcript or the Composer's parent.
    viewport.scrollTop +=
      error.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  });

  useLayoutEffect(() => {
    const previous = focusedControl.current;
    if (previous === null || previous.isConnected) return;
    const document = previous.ownerDocument;
    focusedControl.current = null;
    // Never move someone who has left the queue to read or edit elsewhere.
    const selection = document.getSelection();
    if (selection !== null && !selection.isCollapsed) return;
    if (
      document.activeElement !== document.body &&
      document.activeElement !== null
    )
      return;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>(".queue-row");
    const row = rows?.[Math.min(focusedRowIndex.current, rows.length - 1)];
    const next =
      row?.querySelector<HTMLElement>("[data-queue-control]:not(:disabled)") ??
      rootRef.current?.querySelector<HTMLElement>(
        "[data-queue-control]:not(:disabled)",
      );
    if (next) next.focus({ preventScroll: true });
    else focusComposer?.();
  });

  if (!hasMessages) return null;

  return (
    <section
      ref={rootRef}
      className={`queue-shelf${detailsOpen ? " is-open" : " is-collapsed"}${compact ? " is-compact" : ""}`}
      aria-label={t("messageQueue")}
      onFocusCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        focusedControl.current = target;
        const index =
          target.closest<HTMLElement>("[data-queue-index]")?.dataset.queueIndex;
        focusedRowIndex.current = index === undefined ? 0 : Number(index);
        if (target.closest(".queue-image-gallery")) setOpen(true);
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        // Explicit blur releases ownership. A removed control (or a control
        // disabled while cancellation is pending) may still need a safe return.
        if (event.target.isConnected && !event.target.matches(":disabled"))
          focusedControl.current = null;
      }}
    >
      <div className="queue-shelf-header">
        <button
          type="button"
          className="queue-shelf-toggle"
          data-queue-control="toggle"
          aria-controls={listId}
          aria-expanded={detailsOpen}
          aria-label={t(
            detailsOpen ? "queueHideMessages" : "queueShowMessages",
          )}
          onClick={() => setOpen(!detailsOpen)}
        >
          <Icon name="clock" size={14} />
          <span role="status" aria-live="polite" aria-atomic="true">
            {t(running ? "queueWaitForTurnCount" : "queuePendingCount", {
              count: messages.length,
            })}
          </span>
          <Icon name="chevron-down" size={12} className="queue-shelf-chevron" />
        </button>
        <div className="queue-shelf-actions">
          {onCancelAll !== undefined && messages.length > 1 ? (
            <button
              type="button"
              className="queue-header-action"
              data-queue-control="cancel-all"
              disabled={busy || resuming || messages.length > 128}
              title={
                messages.length > 128
                  ? t(
                      "tooManyMessagesForOneCancellationCancelIndividualMessages",
                    )
                  : t("cancelTheseQueuedMessages", { count: messages.length })
              }
              onClick={(event) => onCancelAll(event.currentTarget)}
            >
              {t("queueCancelAll")}
            </button>
          ) : null}
          {onResume !== undefined ? (
            <button
              type="button"
              className="queue-header-action queue-resume"
              data-queue-control="resume"
              aria-describedby={resumeError ? resumeErrorId : undefined}
              disabled={busy || resuming}
              onClick={onResume}
            >
              {t(resuming ? "queueResuming" : "continueQueue")}
            </button>
          ) : null}
        </div>
      </div>
      {resumeError ? (
        <p className="queue-resume-error" id={resumeErrorId} role="alert">
          {resumeError}
        </p>
      ) : null}
      {failureHidden ? (
        <div role="status" aria-live="polite" aria-atomic="true">
          <button
            type="button"
            className="queue-hidden-failure"
            data-queue-control="failure"
            onClick={() => {
              revealFailure.current = queueFailure.queuedItemId;
              focusedControl.current = null;
              setShowAll(true);
              setOpen(true);
            }}
          >
            <Icon name="warning" size={14} />
            {t("notDelivered", { code: queueFailure.code })}{" "}
            {queueFailure.message}
          </button>
        </div>
      ) : null}
      <div
        className="queue-shelf-details"
        id={listId}
        hidden={!detailsOpen}
        tabIndex={0}
        role="group"
        aria-label={t("messageQueue")}
        onPointerDown={() => {
          if (open === null) setOpen(true);
        }}
        onWheel={() => {
          if (open === null) setOpen(true);
        }}
      >
        <ul className="queue-shelf-list">
          {messages.map((message, index) => (
            <QueuedMessageRow
              key={JSON.stringify([message.id, message.clientId])}
              message={message}
              index={index}
              hidden={!showAll && index >= 2}
              imagesVisible={detailsOpen && (showAll || index < 2)}
              compact={compact}
              attachments={attachments[message.id] ?? []}
              onReadAttachment={onReadAttachment}
              onOpenImage={onOpenImage}
              pending={pendingIds?.has(message.id) ?? false}
              steering={steeringIds?.has(message.id) ?? false}
              running={running}
              onSteer={onSteer}
              steerError={
                steerError?.queuedItemId === message.id &&
                steerError.revision === (message.revision ?? 0)
                  ? steerError.message
                  : null
              }
              disabled={busy || resuming}
              failure={
                queueFailure?.queuedItemId === message.id ? queueFailure : null
              }
              onCancel={onCancel}
              onEdit={onEdit}
              editable={editableIds?.has(message.id) ?? false}
              editing={editingIds?.has(message.id) ?? false}
              onReadingChange={(expanded) => {
                setReading((previous) => {
                  const next = new Set(previous);
                  if (expanded) next.add(message.id);
                  else next.delete(message.id);
                  return next;
                });
              }}
            />
          ))}
        </ul>
        {messages.length > 2 ? (
          <button
            type="button"
            className="queue-view-all"
            data-queue-control="view-all"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            {t(showAll ? "queueShowLess" : "queueViewAll", {
              count: messages.length,
            })}
            <Icon name="chevron-down" size={12} />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function QueuedMessageRow({
  message,
  index,
  hidden,
  imagesVisible,
  compact,
  attachments,
  onReadAttachment,
  onOpenImage,
  pending,
  steering,
  running,
  onSteer,
  steerError,
  disabled,
  failure,
  onCancel,
  onEdit,
  editable,
  editing,
  onReadingChange,
}: {
  message: QueuedMessagePreview;
  index: number;
  hidden: boolean;
  imagesVisible: boolean;
  compact: boolean;
  attachments: readonly AttachmentRef[];
  onReadAttachment: QueuedMessagesProps["onReadAttachment"];
  onOpenImage: QueuedMessagesProps["onOpenImage"];
  pending: boolean;
  steering: boolean;
  running: boolean;
  onSteer: QueuedMessagesProps["onSteer"];
  steerError: string | null;
  disabled: boolean;
  failure: QueuedMessagesProps["queueFailure"];
  onCancel: QueuedMessagesProps["onCancel"];
  onEdit: QueuedMessagesProps["onEdit"];
  editable: boolean;
  editing: boolean;
  onReadingChange(expanded: boolean): void;
}) {
  const { t } = useTranslation("shell");
  const textRef = useRef<HTMLSpanElement>(null);
  const textId = useId();
  const imagesId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const hasText = message.text.trim().length > 0;
  const expandable = hasText && (expanded || overflow);
  const availableImages =
    onReadAttachment && onOpenImage
      ? attachments.slice(0, message.imageCount)
      : [];
  const unavailableImages = Math.max(
    0,
    message.imageCount - availableImages.length,
  );

  useLayoutEffect(() => {
    const text = textRef.current;
    if (text === null || expanded || hidden) return;
    const measure = () =>
      setOverflow(text.scrollHeight > text.clientHeight + 1);
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(text);
    text.ownerDocument.defaultView?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      text.ownerDocument.defaultView?.removeEventListener("resize", measure);
    };
  }, [compact, expanded, hidden, message.text]);

  const toggle = () => {
    if (!expandable || containsSelection(textRef.current)) return;
    setExpanded(!expanded);
    onReadingChange(!expanded);
  };

  return (
    <li
      className={`queue-row${pending ? " is-pending" : ""}`}
      data-queue-id={message.id}
      data-queue-index={index}
      hidden={hidden}
    >
      <div className="queue-row-main">
        <div
          className={`queue-row-content${message.imageCount > 0 ? " has-images" : ""}`}
        >
          {message.hostSource !== undefined ? (
            <HostMessageContent
              source={message.hostSource.source}
              sourceId={message.hostSource.sourceId}
              text={message.text}
              onReadingChange={onReadingChange}
            />
          ) : (
            <div
              className={`queue-preview${expanded ? " is-expanded" : ""}${expandable ? " is-expandable" : ""}`}
              role={expandable ? "button" : undefined}
              tabIndex={expandable ? 0 : undefined}
              data-queue-control={expandable ? "preview" : undefined}
              aria-expanded={expandable ? expanded : undefined}
              aria-controls={expandable ? textId : undefined}
              aria-describedby={
                expandable
                  ? [textId, message.imageCount > 0 ? imagesId : null]
                      .filter(Boolean)
                      .join(" ")
                  : undefined
              }
              aria-label={
                expandable
                  ? t(
                      expanded
                        ? "queueCollapseMessage"
                        : "queueReadFullMessage",
                      {
                        number: index + 1,
                      },
                    )
                  : undefined
              }
              onClick={toggle}
              onKeyDown={(event) => {
                if (
                  expandable &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  toggle();
                }
              }}
            >
              {hasText ? (
                <span ref={textRef} id={textId} className="queue-preview-text">
                  {message.sender === undefined ? null : (
                    <small
                      className="thread-message-sender"
                      title={`${message.sender.deviceId === undefined ? "" : `${t("threadMessageRemoteDetails")}\n`}${JSON.stringify(message.sender)}`}
                    >
                      {t(
                        message.sender.deviceId === undefined
                          ? "threadMessageFrom"
                          : "remoteThreadMessageFrom",
                        {
                          name:
                            message.sender.threadName ??
                            t("threadMessageUnnamed"),
                        },
                      )}
                      <br />
                    </small>
                  )}
                  {message.text}
                </span>
              ) : null}
              {message.imageCount > 0 ? (
                <span
                  id={imagesId}
                  className={`queue-images${hasText ? "" : " is-only-content"}`}
                  title={
                    unavailableImages > 0
                      ? t("queueUnavailablePreviews", {
                          count: unavailableImages,
                        })
                      : undefined
                  }
                >
                  {compact || availableImages.length === 0 ? (
                    <Icon name="image" size={14} />
                  ) : null}
                  {compact ? (
                    <>
                      <span aria-hidden="true">{message.imageCount}</span>
                      <span className="sr-only">
                        {t("imageCount", { count: message.imageCount })}
                      </span>
                    </>
                  ) : (
                    t("imageCount", { count: message.imageCount })
                  )}
                  {unavailableImages > 0 && compact ? (
                    <Icon name="warning" size={12} />
                  ) : null}
                </span>
              ) : null}
              {unavailableImages > 0 ? (
                <span
                  className={`queue-image-unavailable${compact ? " sr-only" : ""}`}
                >
                  {t("queueUnavailablePreviews", { count: unavailableImages })}
                </span>
              ) : null}
              {!hasText && message.imageCount === 0 ? (
                <span className="queue-preview-text">{t("queueWaiting")}</span>
              ) : null}
              {expandable ? (
                <Icon
                  name="chevron-down"
                  size={12}
                  className="queue-preview-chevron"
                />
              ) : null}
            </div>
          )}
          {message.imageCount > 0 ? (
            <QueuedImageStrip
              message={message}
              attachments={attachments}
              visible={imagesVisible}
              compact={compact}
              hasText={hasText}
              onReadAttachment={onReadAttachment}
              onOpenImage={onOpenImage}
            />
          ) : null}
        </div>
        <div className="queue-row-actions">
          {onSteer === undefined ? null : (
            <button
              type="button"
              className={`queue-row-steer${steering ? " is-pending" : ""}`}
              data-queue-control="steer"
              disabled={disabled || pending || editing || steering}
              aria-label={t(
                steering
                  ? "queueSteeringMessage"
                  : running
                    ? "queueSteerMessage"
                    : "queueSendMessageNow",
                { number: index + 1 },
              )}
              title={t(
                steering
                  ? "queueSteering"
                  : running
                    ? "queueSteerHint"
                    : "queueSendNow",
              )}
              onClick={() => onSteer(message)}
            >
              {steering ? (
                <span role="status">{t("queueSteering")}</span>
              ) : (
                <Icon name="send" size={15} />
              )}
            </button>
          )}
          {onEdit === undefined ||
          message.sender !== undefined ||
          message.hostSource !== undefined ? null : (
            <button
              type="button"
              className={`queue-row-edit${editing ? " is-pending" : ""}`}
              data-queue-control="edit"
              disabled={
                steering || pending || !editable || (disabled && !editing)
              }
              aria-label={
                editing
                  ? `${t("editQueuedMessage", { number: index + 1 })}: ${t("saving")}`
                  : editable
                    ? t("editQueuedMessage", { number: index + 1 })
                    : `${t("editQueuedMessage", { number: index + 1 })}: ${t("queueEditUnavailable")}`
              }
              title={
                editing
                  ? t("saving")
                  : editable
                    ? t("editQueuedMessage", { number: index + 1 })
                    : t("queueEditUnavailable")
              }
              onClick={(event) =>
                onEdit(
                  { id: message.id, clientId: message.clientId },
                  event.currentTarget,
                )
              }
            >
              {editing ? (
                <span role="status">{t("saving")}</span>
              ) : (
                <Icon name="compose" size={14} />
              )}
            </button>
          )}
          {onCancel === undefined ? null : (
            <button
              type="button"
              className={`queue-row-cancel${pending ? " is-pending" : ""}`}
              data-queue-control="cancel"
              disabled={disabled || pending || editing || steering}
              aria-label={
                pending
                  ? `${t("cancelQueuedMessage", { number: index + 1 })}: ${t("queueCancelling")}`
                  : t("cancelQueuedMessage", { number: index + 1 })
              }
              title={t("cancelThisPendingMessageOnly")}
              onClick={() =>
                onCancel({
                  queuedItemId: message.id,
                  clientId: message.clientId,
                })
              }
            >
              {pending ? (
                <span role="status">{t("queueCancelling")}</span>
              ) : (
                <Icon name="x" size={14} />
              )}
            </button>
          )}
        </div>
      </div>
      {steerError ? (
        <p className="queue-row-error" role="alert">
          {steerError}
        </p>
      ) : null}
      {failure ? (
        <p className="queue-row-error" role="alert" tabIndex={-1}>
          {t("notDelivered", { code: failure.code })} {failure.message}
        </p>
      ) : null}
    </li>
  );
}

function QueuedImageStrip({
  message,
  attachments,
  visible,
  compact,
  hasText,
  onReadAttachment,
  onOpenImage,
}: {
  message: QueuedMessagePreview;
  attachments: readonly AttachmentRef[];
  visible: boolean;
  compact: boolean;
  hasText: boolean;
  onReadAttachment: QueuedMessagesProps["onReadAttachment"];
  onOpenImage: QueuedMessagesProps["onOpenImage"];
}) {
  const { t } = useTranslation("shell");
  const galleryId = useId();
  const [expanded, setExpanded] = useState(false);
  // The native count remains authoritative even if some legacy/unavailable
  // image sources cannot be represented by an addressable attachment.
  const images =
    onReadAttachment && onOpenImage
      ? attachments.slice(0, message.imageCount)
      : [];
  const previewLimit = compact ? 1 : 3;
  const shownImages = expanded ? images : images.slice(0, previewLimit);
  if (images.length === 0) return null;
  return (
    <div className={`queue-image-strip${hasText ? "" : " is-only-content"}`}>
      {images.length > 0 ? (
        <div className="queue-image-gallery" id={galleryId}>
          {visible && onReadAttachment && onOpenImage
            ? shownImages.map((attachment, index) => (
                <AttachmentImage
                  key={`${attachment.mediaType}:${attachment.sha256}:${index}`}
                  attachment={attachment}
                  name={t("attachedImageName", { number: index + 1 })}
                  onReadAttachment={onReadAttachment}
                  onOpen={(ref, name, trigger) =>
                    onOpenImage(
                      { id: message.id, clientId: message.clientId },
                      ref,
                      name,
                      trigger,
                    )
                  }
                  lazy
                  retryOnError
                  compact
                />
              ))
            : null}
          {images.length > previewLimit ? (
            <button
              type="button"
              className="queue-images-more"
              data-queue-control="images"
              aria-expanded={expanded}
              aria-controls={galleryId}
              aria-label={t(
                expanded ? "queueHideExtraImages" : "queueShowAllImages",
                { count: images.length },
              )}
              title={t(
                expanded ? "queueHideExtraImages" : "queueShowAllImages",
                {
                  count: images.length,
                },
              )}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <Icon name="chevron-down" size={14} />
              ) : (
                `+${images.length - previewLimit}`
              )}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
