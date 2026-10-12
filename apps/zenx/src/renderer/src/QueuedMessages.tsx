import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QueuedCancellationTarget } from "../../../../../src/app-server.js";
import { Icon } from "./icons.js";

export interface QueuedMessagePreview {
  id: string;
  clientId: string;
  text: string;
  imageCount: number;
}

export interface QueuedMessagesProps {
  threadId: string;
  messages: readonly QueuedMessagePreview[];
  queueFailure?: {
    queuedItemId: string;
    code: string;
    message: string;
  } | null;
  pendingIds?: ReadonlySet<string>;
  busy?: boolean;
  resuming?: boolean;
  /** Transport failure for the current resume attempt, not a row failure. */
  resumeError?: string | null;
  compact?: boolean;
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
  queueFailure = null,
  pendingIds,
  busy = false,
  resuming = false,
  resumeError = null,
  compact = false,
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
      className={`queue-shelf${detailsOpen ? " is-open" : " is-collapsed"}`}
      aria-label={t("messageQueue")}
      onFocusCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        focusedControl.current = target;
        const index =
          target.closest<HTMLElement>("[data-queue-index]")?.dataset.queueIndex;
        focusedRowIndex.current = index === undefined ? 0 : Number(index);
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
          <Icon name="layers" size={14} />
          <span role="status" aria-live="polite" aria-atomic="true">
            {t("queuePendingCount", { count: messages.length })}
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
              pending={pendingIds?.has(message.id) ?? false}
              disabled={busy || resuming}
              failure={
                queueFailure?.queuedItemId === message.id ? queueFailure : null
              }
              onCancel={onCancel}
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
  pending,
  disabled,
  failure,
  onCancel,
  onReadingChange,
}: {
  message: QueuedMessagePreview;
  index: number;
  hidden: boolean;
  pending: boolean;
  disabled: boolean;
  failure: QueuedMessagesProps["queueFailure"];
  onCancel: QueuedMessagesProps["onCancel"];
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
  }, [expanded, hidden, message.text]);

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
              ? t(expanded ? "queueCollapseMessage" : "queueReadFullMessage", {
                  number: index + 1,
                })
              : undefined
          }
          onClick={toggle}
          onKeyDown={(event) => {
            if (expandable && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              toggle();
            }
          }}
        >
          {hasText ? (
            <span ref={textRef} id={textId} className="queue-preview-text">
              {message.text}
            </span>
          ) : null}
          {message.imageCount > 0 ? (
            <span
              id={imagesId}
              className={`queue-images${hasText ? "" : " is-only-content"}`}
            >
              <Icon name="image" size={14} />
              {t("imageCount", { count: message.imageCount })}
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
        {onCancel === undefined ? null : (
          <button
            type="button"
            className={`queue-row-cancel${pending ? " is-pending" : ""}`}
            data-queue-control="cancel"
            disabled={disabled || pending}
            aria-label={
              pending
                ? `${t("cancelQueuedMessage", { number: index + 1 })}: ${t("queueCancelling")}`
                : t("cancelQueuedMessage", { number: index + 1 })
            }
            title={t("cancelThisPendingMessageOnly")}
            onClick={() =>
              onCancel({ queuedItemId: message.id, clientId: message.clientId })
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
      {failure ? (
        <p className="queue-row-error" role="alert" tabIndex={-1}>
          {t("notDelivered", { code: failure.code })} {failure.message}
        </p>
      ) : null}
    </li>
  );
}
