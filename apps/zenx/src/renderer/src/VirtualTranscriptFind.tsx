import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { Turn } from "../../protocol-client/index.js";
import type { VirtualTranscriptHandle } from "./ExperimentalTranscriptViewport.js";
import type { TurnCanonicalPresentation } from "./turn-canonical-presentation.js";
import type { createThreadReadingState } from "./thread-reading-state.js";
import {
  createTranscriptFindIndexer,
  normalizeFindText,
  searchTranscript,
  stepTranscriptFind,
} from "./transcript-find-index.js";
import {
  paintTranscriptFindRange,
  transcriptFindRange,
} from "./transcript-find-ranges.js";
import { Icon } from "./icons.js";

interface Props {
  threadId: string;
  turns: readonly Turn[];
  canonical: ReadonlyMap<string, TurnCanonicalPresentation>;
  view: RefObject<HTMLElement | null>;
  viewport: RefObject<HTMLDivElement | null>;
  controller: RefObject<VirtualTranscriptHandle | null>;
  reading: ReturnType<typeof createThreadReadingState>;
  pauseFollowing(): void;
}

/** Separate default-off WIP. Like T3, data matches precede row materialization and DOM Range paint. */
export function VirtualTranscriptFind({
  threadId,
  turns,
  canonical,
  view,
  viewport,
  controller,
  reading,
  pauseFollowing,
}: Props) {
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState({ index: 0, request: 0 });
  const [focusRequest, setFocusRequest] = useState(0);
  const [status, setStatus] = useState<"missing" | "unsupported" | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const owner = useRef({});
  const request = useRef(0);
  const [indexText] = useState(() => createTranscriptFindIndexer());
  const entries = useMemo(
    () => (open ? indexText(turns, canonical) : []),
    [open, turns, canonical, indexText],
  );
  const matches = useMemo(
    () => searchTranscript(entries, query),
    [entries, query],
  );
  const activeIndex = Math.min(
    selection.index,
    Math.max(0, matches.length - 1),
  );
  const match = matches[activeIndex];
  const matchKey = match
    ? JSON.stringify([
        threadId,
        normalizeFindText(query),
        match.entry.itemId,
        match.entry.field,
        match.occurrence,
      ])
    : null;
  const latest = useRef({ open, matches, activeIndex, match, query });
  latest.current = { open, matches, activeIndex, match, query };
  const label = useId();
  const close = () => {
    const restore = bar.current?.contains(document.activeElement);
    request.current++;
    setOpen(false);
    if (restore && returnFocus.current?.isConnected)
      returnFocus.current.focus({ preventScroll: true });
    returnFocus.current = null;
  };
  const step = (direction: -1 | 1) =>
    setSelection((previous) => ({
      index: stepTranscriptFind(
        latest.current.activeIndex,
        latest.current.matches.length,
        direction,
      ),
      request: previous.request + 1,
    }));
  const callbacks = useRef({ close, step });
  callbacks.current = { close, step };

  useEffect(() => {
    const node = view.current;
    if (!node) return;
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      const document = node.ownerDocument;
      const pageTarget =
        target === document.body || target === document.documentElement;
      if (pageTarget) {
        const primary = [
          ...document.querySelectorAll<HTMLElement>(".thread-view"),
        ].find((view) => !view.closest("[hidden],[aria-hidden='true']"));
        if (primary && primary !== node) return;
      } else if (!target || !node.contains(target)) return;
      if (node.closest("[hidden],[aria-hidden='true']")) return;
      // Editors own their file/composer search before the transcript shortcut.
      if (
        target?.closest(".cm-editor,[data-thread-find-ignore],[role='dialog']")
      )
        return;
      const modified = event.metaKey || event.ctrlKey;
      if (modified && !event.shiftKey && event.key.toLowerCase() === "f") {
        if (!latest.current.open)
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        setOpen(true);
        setFocusRequest((value) => value + 1);
      } else if (
        latest.current.open &&
        ((event.key === "Enter" && bar.current?.contains(target)) ||
          event.key === "F3" ||
          (modified && event.key.toLowerCase() === "g"))
      )
        callbacks.current.step(event.shiftKey ? -1 : 1);
      else if (
        latest.current.open &&
        event.key === "Escape" &&
        bar.current?.contains(target)
      )
        callbacks.current.close();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    node.ownerDocument.addEventListener("keydown", keyboard);
    return () => node.ownerDocument.removeEventListener("keydown", keyboard);
  }, [threadId, view]);
  useLayoutEffect(() => {
    if (open) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [open, focusRequest]);

  useEffect(() => {
    const node = viewport.current;
    const handle = controller.current;
    const selected = latest.current.match;
    const paintOwner = owner.current;
    const version = ++request.current;
    setStatus(null);
    if (!node || !handle || !open || !selected || !matchKey) return;
    let active = true;
    let revealOwner:
      ReturnType<VirtualTranscriptHandle["captureReveal"]> | undefined;
    const current = () =>
      active &&
      request.current === version &&
      (!revealOwner || revealOwner.isCurrent());
    const cancel = (event: Event) => {
      if (event.target instanceof Node && bar.current?.contains(event.target))
        return;
      active = false;
      revealOwner?.cancel();
      paintTranscriptFindRange(node.ownerDocument, paintOwner, null);
    };
    const document = node.ownerDocument;
    let repaintFrame = 0;
    const observer = new MutationObserver(() => {
      if (repaintFrame || !current()) return;
      repaintFrame = requestAnimationFrame(() => {
        repaintFrame = 0;
        if (current())
          paintTranscriptFindRange(
            document,
            paintOwner,
            transcriptFindRange(node, selected, latest.current.query),
          );
      });
    });
    // Repaint after streamed Markdown or list mounts change the real text nodes, without another jump.
    observer.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("wheel", cancel, {
      capture: true,
      passive: true,
    });
    document.addEventListener("keydown", cancel, true);
    // Legend's public scroll command may flush layout synchronously. Start outside React's lifecycle.
    queueMicrotask(() => {
      if (!current()) return;
      pauseFollowing();
      for (const key of selected.entry.disclosures) reading.set(key, true);
      const pending = handle.reveal(
        JSON.stringify([threadId, "turn", selected.entry.turnId]),
        () => {
          if (!current()) return;
          // ToolInput's existing details disclosure must be open before locating its full command.
          if (selected.entry.field === "command")
            for (const scope of node.querySelectorAll<HTMLElement>(
              "[data-thread-find-item-id]",
            )) {
              if (scope.dataset.threadFindItemId !== selected.entry.itemId)
                continue;
              const details = scope.closest("details");
              if (details) details.open = true;
            }
          const range = transcriptFindRange(
            node,
            selected,
            latest.current.query,
          );
          if (
            !range ||
            !current() ||
            !range.startContainer.isConnected ||
            !range.endContainer.isConnected
          ) {
            if (current()) setStatus("missing");
            return;
          }
          if (!paintTranscriptFindRange(document, paintOwner, range))
            setStatus("unsupported");
          const rect = range.getBoundingClientRect();
          const bounds = node.getBoundingClientRect();
          const bottomZone = view.current
            ?.querySelector(".bottom-zone")
            ?.getBoundingClientRect();
          const bottom = bottomZone
            ? Math.min(bounds.bottom, bottomZone.top)
            : bounds.bottom;
          const margin = Math.min(
            72,
            Math.max(0, (bottom - bounds.top - rect.height) / 2),
          );
          const delta =
            rect.top < bounds.top + margin
              ? rect.top - bounds.top - margin
              : rect.bottom > bottom - margin
                ? rect.bottom - bottom + margin
                : 0;
          if (delta && current()) node.scrollTop += delta;
          const pre = range.startContainer.parentElement?.closest("pre");
          if (pre && current()) {
            const box = pre.getBoundingClientRect();
            if (rect.left < box.left)
              pre.scrollLeft += rect.left - box.left - 16;
            else if (rect.right > box.right)
              pre.scrollLeft += rect.right - box.right + 16;
          }
          if (current()) pauseFollowing(); // Save the exact final reading position without taking focus.
        },
      );
      revealOwner = handle.captureReveal();
      void pending.then((revealed) => {
        if (!revealed && current()) setStatus("missing");
      });
    });
    return () => {
      active = false;
      observer.disconnect();
      cancelAnimationFrame(repaintFrame);
      // Cancelling may issue Legend's synchronous offset command; never run it inside React cleanup.
      const previousOwner = revealOwner;
      queueMicrotask(() => previousOwner?.cancel());
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("wheel", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      paintTranscriptFindRange(document, paintOwner, null);
    };
  }, [
    open,
    query,
    matchKey,
    selection.request,
    threadId,
    controller,
    viewport,
    reading,
    pauseFollowing,
    view,
  ]);

  if (!open) return null;
  return (
    <div
      className="virtual-transcript-find"
      ref={bar}
      role="search"
      aria-labelledby={label}
    >
      <div className="virtual-transcript-find-controls">
        <label id={label} className="sr-only" htmlFor={`${label}-input`}>
          {t("findInThread")}
        </label>
        <input
          id={`${label}-input`}
          ref={input}
          type="text"
          value={query}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("findInThread")}
          onChange={(event) => {
            request.current++;
            setQuery(event.target.value);
            setSelection((previous) => ({
              index: 0,
              request: previous.request + 1,
            }));
          }}
        />
        <span role="status" aria-live="polite" aria-atomic="true">
          {query.trim()
            ? matches.length
              ? t("threadFindCount", {
                  current: activeIndex + 1,
                  total: matches.length,
                })
              : t("threadFindNoMatches")
            : ""}
        </span>
        <button
          type="button"
          className="icon-button"
          disabled={!matches.length}
          aria-label={t("previousThreadMatch")}
          title={t("previousThreadMatch")}
          onClick={() => step(-1)}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={!matches.length}
          aria-label={t("nextThreadMatch")}
          title={t("nextThreadMatch")}
          onClick={() => step(1)}
        >
          <Icon name="chevron-down" size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t("closeThreadFind")}
          title={t("closeThreadFind")}
          onClick={close}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <p className="virtual-transcript-find-note">
        {t(
          status === "missing"
            ? "threadFindRevealFailed"
            : status === "unsupported"
              ? "threadFindHighlightUnsupported"
              : "threadFindScope",
        )}
      </p>
    </div>
  );
}
