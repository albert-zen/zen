import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { MessageQuoteReference } from "./composer-selector.js";
import { Icon } from "./icons.js";
import { parseSkillDraft, withSkillDraft } from "./skill-draft.js";

export interface MessageSelection {
  threadId: string;
  id: string;
  excerpt: string;
}

const bodySelector = "[data-message-quote-body]";
const ownerSelector = "[data-quote-thread-id][data-quote-item-id]";
const excludedSelector =
  'button, input, textarea, select, [role="button"], [contenteditable]:not([contenteditable="false"]), .markdown-code-header, [data-message-quote-ignore]';

function elementFor(node: Node | null): Element | null {
  return node?.nodeType === 1
    ? (node as Element)
    : (node?.parentElement ?? null);
}

/** Only canonical, single-message body selections become references. */
export function readMessageSelection(
  viewport: HTMLElement,
  selection: Selection | null,
): MessageSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  const start = elementFor(range.startContainer);
  const end = elementFor(range.endContainer);
  const body = start?.closest(bodySelector);
  if (
    !body ||
    !viewport.contains(body) ||
    end?.closest(bodySelector) !== body ||
    start?.closest(excludedSelector) ||
    end?.closest(excludedSelector)
  )
    return null;
  const owner = body.closest<HTMLElement>(ownerSelector);
  if (!owner || !viewport.contains(owner)) return null;
  // Endpoints alone do not exclude a code header/control inside a larger range.
  for (const excluded of body.querySelectorAll(excludedSelector)) {
    if (range.intersectsNode(excluded)) return null;
  }
  const threadId = owner.dataset.quoteThreadId;
  const id = owner.dataset.quoteItemId;
  const excerpt = selection.toString();
  if (!threadId || !id || !excerpt.trim()) return null;
  return { threadId, id, excerpt };
}

export function addMessageQuote(
  draft: string,
  quote: MessageQuoteReference,
): string {
  const { text, skills, references } = parseSkillDraft(draft);
  if (
    references.some(
      (reference) =>
        reference.kind === "message" &&
        reference.threadId === quote.threadId &&
        reference.id === quote.id &&
        reference.excerpt === quote.excerpt,
    )
  )
    return draft;
  return withSkillDraft(text, skills, [...references, quote]);
}

type SelectionSnapshot = MessageSelection & { range: Range };
type ToolbarPosition = { left: number; top: number };

function sameSelection(
  left: SelectionSnapshot | null,
  right: SelectionSnapshot | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.threadId === right.threadId &&
    left.id === right.id &&
    left.excerpt === right.excerpt &&
    left.range.startContainer === right.range.startContainer &&
    left.range.startOffset === right.range.startOffset &&
    left.range.endContainer === right.range.endContainer &&
    left.range.endOffset === right.range.endOffset
  );
}

/** A selection-local affordance. Quoting only hands the exact selection to the composer. */
export function MessageSelectionActions({
  viewport,
  threadId,
  disabled,
  onQuote,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  threadId?: string;
  disabled: boolean;
  onQuote(selection: MessageSelection): void;
}) {
  const { t } = useTranslation("shell");
  const toolbar = useRef<HTMLDivElement>(null);
  const active = useRef<SelectionSnapshot | null>(null);
  const dismissed = useRef<SelectionSnapshot | null>(null);
  const selecting = useRef(false);
  const latestOnQuote = useRef(onQuote);
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null);
  const [position, setPosition] = useState<ToolbarPosition | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );

  function read(): SelectionSnapshot | null {
    const element = viewport.current;
    if (!element || disabled) return null;
    const selection = element.ownerDocument.getSelection();
    const message = readMessageSelection(element, selection);
    if (!message || (threadId && message.threadId !== threadId)) return null;
    return { ...message, range: selection!.getRangeAt(0).cloneRange() };
  }

  function dismiss() {
    dismissed.current = active.current ?? dismissed.current;
    active.current = null;
    setSnapshot(null);
    setPosition(null);
    setCopyStatus(null);
  }

  function quote() {
    const current = read();
    if (!sameSelection(active.current, current) || !current) {
      dismiss();
      return;
    }
    dismiss();
    latestOnQuote.current({
      threadId: current.threadId,
      id: current.id,
      excerpt: current.excerpt,
    });
  }

  useEffect(() => {
    const element = viewport.current;
    const document = element?.ownerDocument;
    const window = document?.defaultView;
    if (!element || !document || !window) return;
    // Changing Thread or admission invalidates the entire old selection intent.
    dismiss();
    dismissed.current = read();
    selecting.current = false;
    const update = () => {
      if (selecting.current) return;
      const next = read();
      if (sameSelection(dismissed.current, next)) return;
      if (sameSelection(active.current, next)) return;
      dismissed.current = null;
      active.current = next;
      setSnapshot(next);
      setPosition(null);
      setCopyStatus(null);
    };
    const pointerDown = (event: PointerEvent) => {
      if (toolbar.current?.contains(event.target as Node)) return;
      selecting.current = true;
      dismiss();
    };
    const pointerUp = () => {
      selecting.current = false;
      update();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape" && active.current) {
        event.preventDefault();
        dismiss();
      } else if (
        event.key === "Enter" &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.repeat &&
        !disabled
      ) {
        if (!sameSelection(active.current, read())) return;
        event.preventDefault();
        quote();
      }
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", pointerUp);
    document.addEventListener("keydown", keyDown);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("scroll", dismiss);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("pointercancel", pointerUp);
      document.removeEventListener("keydown", keyDown);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("scroll", dismiss);
      active.current = null;
    };
    // onQuote is read below from the latest render, not a reason to retire a selection.
  }, [viewport, threadId, disabled]);

  // Event listeners use the latest callback without making parent rerenders dismiss selection.
  useLayoutEffect(() => {
    latestOnQuote.current = onQuote;
  }, [onQuote]);

  useLayoutEffect(() => {
    const root = toolbar.current;
    const element = viewport.current;
    const window = element?.ownerDocument.defaultView;
    if (!snapshot || !root || !element || !window) return;
    const range = snapshot.range;
    if (typeof range.getBoundingClientRect !== "function") return;
    const rects = Array.from(range.getClientRects());
    const first = rects[0] ?? range.getBoundingClientRect();
    const last = rects[rects.length - 1] ?? first;
    const bounds = element.getBoundingClientRect();
    const visual = window.visualViewport;
    const windowLeft = visual?.offsetLeft ?? 0;
    const windowTop = visual?.offsetTop ?? 0;
    const windowRight = windowLeft + (visual?.width ?? window.innerWidth);
    const windowBottom = windowTop + (visual?.height ?? window.innerHeight);
    const left = Math.max(windowLeft, bounds.left) + 8;
    const right = Math.min(windowRight, bounds.right) - 8;
    const top = Math.max(windowTop, bounds.top) + 8;
    const bottom = Math.min(windowBottom, bounds.bottom) - 8;
    root.style.maxWidth = `${Math.max(0, right - left)}px`;
    const size = root.getBoundingClientRect();
    const above = first.top - size.height - 8;
    const desiredTop = above >= top ? above : last.bottom + 8;
    setPosition({
      left: Math.max(left, Math.min(first.left, right - size.width)),
      top: Math.max(top, Math.min(desiredTop, bottom - size.height)),
    });
  }, [snapshot, copyStatus, viewport]);

  async function copy() {
    const current = read();
    const intent = active.current;
    if (!current || !sameSelection(intent, current)) {
      dismiss();
      return;
    }
    try {
      await viewport.current!.ownerDocument.defaultView!.navigator.clipboard.writeText(
        current.excerpt,
      );
      if (active.current === intent) setCopyStatus("copied");
    } catch {
      if (active.current === intent) setCopyStatus("failed");
    }
  }

  if (
    !snapshot ||
    disabled ||
    (threadId && snapshot.threadId !== threadId) ||
    !viewport.current
  )
    return null;
  return createPortal(
    <div
      ref={toolbar}
      className="message-selection-actions"
      role="group"
      aria-label={t("quoteSelectionActions")}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={() => void copy()}
        title={t(
          copyStatus === "failed" ? "selectionCopyFailed" : "copySelection",
        )}
        aria-label={t("copySelection")}
      >
        <Icon name={copyStatus === "copied" ? "check" : "copy"} size={14} />
        <span role={copyStatus ? "status" : undefined}>
          {t(
            copyStatus === "copied"
              ? "selectionCopied"
              : copyStatus === "failed"
                ? "selectionCopyFailed"
                : "copySelection",
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={quote}
        title={t("quoteSelectionShortcut")}
        aria-label={t("quoteSelection")}
        aria-keyshortcuts="Alt+Enter"
      >
        <Icon name="quote" size={14} />
        <span>{t("quoteSelection")}</span>
      </button>
    </div>,
    viewport.current.ownerDocument.body,
  );
}

/** The same exact quote is used in the draft and the canonical sent presentation. */
export function MessageQuoteCard({
  reference,
  onRemove,
  onSource,
}: {
  reference: MessageQuoteReference;
  onRemove?(): void;
  onSource(): boolean;
}) {
  const { t } = useTranslation("shell");
  const text = useRef<HTMLSpanElement>(null);
  const excerptId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [sourceUnavailable, setSourceUnavailable] = useState(false);

  useLayoutEffect(() => {
    setExpanded(false);
    setSourceUnavailable(false);
  }, [reference.threadId, reference.id, reference.excerpt]);

  useLayoutEffect(() => {
    const excerpt = text.current;
    const window = excerpt?.ownerDocument.defaultView;
    if (!excerpt || !window || expanded) return;
    const measure = () =>
      setOverflow(
        excerpt.scrollWidth > excerpt.clientWidth + 1 ||
          excerpt.scrollHeight > excerpt.clientHeight + 1,
      );
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(excerpt);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [expanded, reference.excerpt]);

  function source() {
    try {
      setSourceUnavailable(!onSource());
    } catch {
      setSourceUnavailable(true);
    }
  }

  return (
    <div
      className="message-quote-card"
      role="group"
      aria-label={t("quoteSelection")}
      data-expanded={expanded || undefined}
      data-message-quote-ignore=""
    >
      <div className="message-quote-pill">
        <button
          className="message-quote-source"
          type="button"
          title={t("showQuoteSource")}
          aria-label={t("showQuoteSource")}
          onClick={source}
        >
          <Icon name="quote" size={14} />
        </button>
        <span className="message-quote-excerpt" id={excerptId} ref={text}>
          {reference.excerpt}
        </span>
        {overflow || expanded ? (
          <button
            className="message-quote-expand"
            type="button"
            title={t(expanded ? "collapseQuote" : "expandQuote")}
            aria-label={t(expanded ? "collapseQuote" : "expandQuote")}
            aria-expanded={expanded}
            aria-controls={excerptId}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon name="chevron-down" size={14} />
          </button>
        ) : null}
        {onRemove ? (
          <button
            className="message-quote-remove"
            type="button"
            title={t("removeQuote")}
            aria-label={t("removeQuote")}
            onClick={onRemove}
          >
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </div>
      {sourceUnavailable ? (
        <span className="message-quote-error" role="status">
          {t("quoteSourceUnavailable")}
        </span>
      ) : null}
    </div>
  );
}
