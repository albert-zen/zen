import {
  normalizeInlineReferences,
  insertInlineReference,
} from "./reference-draft.js";
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
import type {
  MessageQuoteReference,
  QuoteReference,
} from "./composer-selector.js";
import { Icon } from "./icons.js";
import { parseSkillDraft, withSkillDraft } from "./skill-draft.js";

export interface MessageSelection {
  threadId?: string;
  id?: string;
  excerpt: string;
  sources?: Array<{ threadId: string; id: string }>;
}

function elementFor(node: Node | null): Element | null {
  return node?.nodeType === 1
    ? (node as Element)
    : (node?.parentElement ?? null);
}

/** Preserve native selected text; provenance is optional and never gates quoting. */
export function readMessageSelection(
  viewport: HTMLElement,
  selection: Selection | null,
): MessageSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  const start = elementFor(range.startContainer);
  const end = elementFor(range.endContainer);
  if (!start || !end || !viewport.contains(start) || !viewport.contains(end))
    return null;
  const excerpt = selection.toString();
  if (!excerpt.trim()) return null;
  const selector = "[data-quote-thread-id][data-quote-item-id]";
  const startOwner = start.closest<HTMLElement>(selector);
  const endOwner = end.closest<HTMLElement>(selector);
  const chrome =
    "button, input, textarea, select, .markdown-code-header, [data-message-quote-ignore]";
  const owners =
    start.closest(chrome) && end.closest(chrome)
      ? []
      : startOwner && startOwner === endOwner
        ? [startOwner]
        : [...viewport.querySelectorAll<HTMLElement>(selector)].filter(
            (owner) => range.intersectsNode(owner),
          );
  const sources = owners
    .flatMap((owner) => {
      const threadId = owner.dataset.quoteThreadId!;
      const ids: string[] = owner.dataset.quoteItemIds
        ? JSON.parse(owner.dataset.quoteItemIds)
        : [owner.dataset.quoteItemId!];
      return ids.map((id) => ({ threadId, id }));
    })
    .filter(
      (source, index, all) =>
        all.findIndex(
          (other) =>
            other.threadId === source.threadId && other.id === source.id,
        ) === index,
    );
  return sources.length === 1 && startOwner === endOwner
    ? { ...sources[0]!, excerpt }
    : { excerpt, sources };
}

export function selectionReference(
  selection: MessageSelection,
  cwd: string,
): QuoteReference {
  return selection.threadId && selection.id
    ? {
        kind: "message",
        name: "",
        cwd,
        threadId: selection.threadId,
        id: selection.id,
        excerpt: selection.excerpt,
      }
    : {
        kind: "text",
        name: "",
        cwd,
        sources: selection.sources ?? [],
        excerpt: selection.excerpt,
      };
}

export function addMessageQuote(
  draft: string,
  quote: QuoteReference,
  start?: number,
  end = start,
): string {
  const { text, skills, references } = parseSkillDraft(draft);
  if (start !== undefined) {
    const normalized = normalizeInlineReferences(text, references);
    const inserted = insertInlineReference(
      normalized.text,
      normalized.references,
      quote,
      start,
      end ?? start,
    );
    return withSkillDraft(inserted.text, skills, inserted.references);
  }
  if (
    references.some(
      (reference) =>
        (reference.kind === "message" || reference.kind === "text") &&
        reference.kind === quote.kind &&
        reference.excerpt === quote.excerpt &&
        JSON.stringify(
          reference.kind === "message"
            ? [reference.threadId, reference.id]
            : reference.sources,
        ) ===
          JSON.stringify(
            quote.kind === "message"
              ? [quote.threadId, quote.id]
              : quote.sources,
          ),
    )
  )
    return draft;
  return withSkillDraft(text, skills, [...references, quote]);
}

type SelectionSnapshot = MessageSelection & {
  range: Range;
  field?: HTMLInputElement | HTMLTextAreaElement;
};
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
    JSON.stringify(left.sources) === JSON.stringify(right.sources) &&
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
  onAddToSideChat,
  pageSelection = false,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  threadId?: string;
  disabled: boolean;
  pageSelection?: boolean;
  onQuote(selection: MessageSelection): void;
  onAddToSideChat?(selection: MessageSelection): void;
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
    const document = element.ownerDocument;
    const selection = document.getSelection();
    const surface = element.closest(".thread-view") ?? element;
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      const start = elementFor(selection.anchorNode);
      const selectedSurface = start?.closest(".thread-view");
      if (
        selectedSurface
          ? selectedSurface !== surface
          : !pageSelection && !surface.contains(start)
      )
        return null;
      const message = readMessageSelection(
        pageSelection || selectedSurface ? document.body : element,
        selection,
      );
      return message
        ? { ...message, range: selection.getRangeAt(0).cloneRange() }
        : null;
    }
    const field = toolbar.current?.contains(document.activeElement)
      ? active.current?.field
      : document.activeElement;
    if (
      field instanceof document.defaultView!.HTMLTextAreaElement ||
      field instanceof document.defaultView!.HTMLInputElement
    ) {
      if (
        field.type === "password" ||
        field.selectionStart === null ||
        field.selectionEnd === null
      )
        return null;
      const fieldSurface = field.closest(".thread-view");
      if (
        fieldSurface
          ? fieldSurface !== surface
          : !pageSelection && !surface.contains(field)
      )
        return null;
      const excerpt = field.value.slice(
        field.selectionStart,
        field.selectionEnd,
      );
      if (!excerpt.trim()) return null;
      const range = document.createRange();
      range.selectNode(field);
      return { excerpt, sources: [], range, field };
    }
    return null;
  }

  function dismiss() {
    dismissed.current = active.current ?? dismissed.current;
    active.current = null;
    setSnapshot(null);
    setPosition(null);
    setCopyStatus(null);
  }

  function quote(toSideChat = false) {
    const current = read();
    if (!sameSelection(active.current, current) || !current) {
      dismiss();
      return;
    }
    dismiss();
    const action = toSideChat ? onAddToSideChat : latestOnQuote.current;
    action?.({
      threadId: current.threadId,
      id: current.id,
      excerpt: current.excerpt,
      ...(current.sources === undefined ? {} : { sources: current.sources }),
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
    const scroll = (event: Event) => {
      if (active.current?.field === event.target) return;
      dismiss();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("select", update);
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", pointerUp);
    document.addEventListener("keydown", keyDown);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("scroll", dismiss);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("select", update);
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("pointercancel", pointerUp);
      document.removeEventListener("keydown", keyDown);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("scroll", dismiss);
      active.current = null;
    };
    // onQuote is read below from the latest render, not a reason to retire a selection.
  }, [viewport, threadId, disabled, pageSelection]);

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
    const bounds = element.contains(snapshot.range.startContainer)
      ? element.getBoundingClientRect()
      : {
          left: 0,
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
        };
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

  if (!snapshot || disabled || !viewport.current) return null;
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
        onClick={() => quote()}
        title={t("quoteSelectionShortcut")}
        aria-label={t("quoteSelection")}
        aria-keyshortcuts="Alt+Enter"
      >
        <Icon name="quote" size={14} />
        <span>{t("quoteSelection")}</span>
      </button>
      {onAddToSideChat ? (
        <button
          type="button"
          onClick={() => quote(true)}
          aria-label={t("addToSideChat")}
        >
          <Icon name="users" size={14} />
          <span>{t("addToSideChat")}</span>
        </button>
      ) : null}
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
          <Icon name="quote" size={12} />
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
            <Icon name="chevron-down" size={12} />
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
            <Icon name="x" size={10} />
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
