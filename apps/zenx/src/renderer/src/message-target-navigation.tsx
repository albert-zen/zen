import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import type { Thread } from "../../protocol-client/index.js";
import {
  ThreadReadingContext,
  disclosureKey,
  readingIdentitySelector,
  readingViewportBounds,
  type ReadingAnchor,
} from "./thread-reading-state.js";
import type { SentMessageQuote } from "./reference-draft.js";

export interface MessageTargetRequest {
  threadId: string;
  itemId: string;
  requestId: number;
}
export const MessageTargetNavigationContext = createContext<{
  request: MessageTargetRequest | null;
  consumed(requestId: number): void;
} | null>(null);
export const MessageQuoteNavigationContext = createContext<
  ((quote: SentMessageQuote, afterClose?: Promise<void>) => boolean) | null
>(null);

export interface ReadingTargetPosition {
  turnId: string;
  target(): HTMLElement | null;
  offset?: number;
  /** Exact source-popup/dialog lifecycle, not a delay or a permission grant. */
  afterClose?: Promise<void>;
  focus?: boolean;
  isCurrent(): boolean;
  onComplete?(anchor: ReadingAnchor): void;
}

/** One reveal, one position, one correction, then a fresh geometry check. No retry loop. */
export function revealAndPositionReadingTarget({
  viewport,
  turnId,
  target,
  offset,
  afterClose,
  focus = false,
  isCurrent,
  onPosition,
  onCloseComplete,
  onComplete,
  onFinish,
}: ReadingTargetPosition & {
  viewport: HTMLElement;
  onPosition?(top: number): void;
  onCloseComplete?(top: number): void;
  onFinish?(): void;
}): () => void {
  const turn = viewport.querySelector<HTMLElement>(
    readingIdentitySelector("data-turn-id", turnId),
  );
  let frame: number | undefined;
  let finished = false;
  let waitingForClose = afterClose !== undefined;
  let expectedTop = viewport.scrollTop;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (turn) delete turn.dataset.readingReveal;
    for (const event of ["wheel", "pointerdown", "keydown", "focusin"])
      document.removeEventListener(event, cancel, true);
    viewport.removeEventListener("scroll", scrolled);
    document.removeEventListener("selectionchange", selected);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("visibilitychange", cancel);
    onFinish?.();
  };
  const cancel = () => finish();
  const scrolled = () => {
    // Source disclosure / popup removal can move the viewport before its exact
    // close callback. Explicit input still cancels throughout this short phase.
    if (waitingForClose) expectedTop = viewport.scrollTop;
    else if (Math.abs(viewport.scrollTop - expectedTop) > 0.5) finish();
  };
  const selected = () => {
    if (document.getSelection()?.isCollapsed === false) finish();
  };
  const current = () =>
    !finished &&
    isCurrent() &&
    viewport.isConnected &&
    !!turn?.isConnected &&
    viewport.contains(turn) &&
    !viewport.closest("[hidden], [aria-hidden='true'], [inert]");
  const available = () =>
    !focus ||
    (document.visibilityState === "visible" &&
      document.hasFocus() &&
      !document.querySelector(
        '[role="dialog"][aria-modal="true"], dialog[open]',
      ));
  const geometry = () => {
    if (!current() || !available()) return;
    const element = target();
    if (
      !element ||
      !turn?.contains(element) ||
      element.closest("[hidden], [aria-hidden='true'], [inert]")
    )
      return;
    const bounds = readingViewportBounds(viewport);
    const rect = element.getBoundingClientRect();
    const height = bounds.bottom - bounds.top;
    if (
      height <= 0 ||
      bounds.right <= bounds.left ||
      rect.height <= 0 ||
      rect.width <= 0
    )
      return;
    const desiredTop =
      offset === undefined
        ? bounds.top +
          (rect.height <= height
            ? (height - rect.height) / 2
            : Math.min(8, height / 4))
        : bounds.top - Math.min(offset, Math.max(0, rect.height - 1));
    return { element, bounds, rect, desiredTop };
  };
  const position = () => {
    const measured = geometry();
    if (!measured) {
      finish();
      return false;
    }
    viewport.scrollTop += measured.rect.top - measured.desiredTop;
    expectedTop = viewport.scrollTop;
    onPosition?.(expectedTop);
    return true;
  };
  const validate = () => {
    const measured = geometry();
    if (!measured) {
      finish();
      return;
    }
    const { element, rect, bounds, desiredTop } = measured;
    const top = Math.max(rect.top, bounds.top);
    const bottom = Math.min(rect.bottom, bounds.bottom);
    const left = Math.max(rect.left, bounds.left);
    const right = Math.min(rect.right, bounds.right);
    const uncovered = (y: number) => {
      const hit = document.elementFromPoint?.((left + right) / 2, y);
      return !!hit && element.contains(hit);
    };
    const inset = Math.min(2, (bottom - top) / 2);
    const aligned =
      offset === undefined
        ? rect.height > bounds.bottom - bounds.top
          ? Math.abs(rect.top - desiredTop) <= 2
          : rect.top >= bounds.top - 2 && rect.bottom <= bounds.bottom + 2
        : Math.abs(rect.top - desiredTop) <= 2 ||
          viewport.scrollTop <= 0.5 ||
          viewport.scrollTop >=
            viewport.scrollHeight - viewport.clientHeight - 0.5;
    const visible =
      bottom > top &&
      right > left &&
      aligned &&
      (!focus || (uncovered(top + inset) && uncovered(bottom - inset)));
    if (!visible || !current()) {
      finish();
      return;
    }
    finish(); // Focus's own events must not be mistaken for newer reader intent.
    if (!isCurrent()) return;
    if (focus) {
      element.dataset.messageTarget = "true";
      element.focus({ preventScroll: true });
      if (document.activeElement !== element || !isCurrent()) {
        delete element.dataset.messageTarget;
        return;
      }
      element.addEventListener(
        "blur",
        () => delete element.dataset.messageTarget,
        { once: true },
      );
    }
    if (isCurrent()) {
      const itemId =
        element.dataset.quoteItemId ?? element.dataset.sentMessageId;
      onComplete?.({
        turnId,
        ...(itemId === undefined ? {} : { itemId }),
        offset: bounds.top - rect.top,
      });
    }
  };
  // A queue-reference action starts while its dialog still hides the view;
  // first-frame validation happens only after the close has committed.
  if (!turn || !isCurrent() || !viewport.isConnected) {
    finish();
    return cancel;
  }
  for (const event of ["wheel", "pointerdown", "keydown", "focusin"])
    document.addEventListener(event, cancel, true);
  viewport.addEventListener("scroll", scrolled);
  document.addEventListener("selectionchange", selected);
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", cancel);
  const start = () => {
    if (!current()) {
      finish();
      return;
    }
    if (waitingForClose) {
      waitingForClose = false;
      expectedTop = viewport.scrollTop;
      onCloseComplete?.(expectedTop);
    }
    turn.dataset.readingReveal = "true";
    frame = requestAnimationFrame(() => {
      if (position())
        frame = requestAnimationFrame(() => {
          if (position()) frame = requestAnimationFrame(validate);
        });
    });
  };
  if (afterClose) void afterClose.then(start, finish);
  else start();
  return cancel;
}

/** Focus is renderer-local reading intent; it never changes the destination's transcript. */
export function useMessageTargetNavigation(
  thread: Thread | null,
  viewport: RefObject<HTMLElement | null>,
  position: (target: ReadingTargetPosition) => () => void,
) {
  const navigation = useContext(MessageTargetNavigationContext);
  const reading = useContext(ThreadReadingContext);
  const attempted = useRef<string | null>(null);
  const owner = useRef<string | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const request = navigation?.request;
  const requestKey = request
    ? JSON.stringify([request.threadId, request.itemId, request.requestId])
    : null;
  useLayoutEffect(() => {
    owner.current = requestKey;
    return () => {
      owner.current = null;
      cancel.current?.();
      cancel.current = null;
    };
  }, [requestKey, thread?.id]);
  useLayoutEffect(() => {
    if (
      !request ||
      request.threadId !== thread?.id ||
      attempted.current === requestKey
    )
      return;
    const turn = thread.turns.find((turn) =>
      turn.items.some(
        (item) =>
          item.id === request.itemId &&
          ["threadMessage", "userMessage"].includes(item.type),
      ),
    );
    if (!turn) return; // Await authoritative resume, not a title/text lookup.
    attempted.current = requestKey;
    reading?.set(disclosureKey("turn", turn.id), true);
    cancel.current = position({
      turnId: turn.id,
      target: () =>
        viewport.current?.querySelector<HTMLElement>(
          readingIdentitySelector("data-sent-message-id", request.itemId),
        ) ?? null,
      focus: true,
      isCurrent: () => owner.current === requestKey,
      onComplete: () => navigation?.consumed(request.requestId),
    });
  }, [
    request,
    requestKey,
    thread?.id,
    thread?.turns,
    reading,
    position,
    viewport,
    navigation,
  ]);
}
