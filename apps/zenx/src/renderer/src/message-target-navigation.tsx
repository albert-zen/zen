import type { SentMessageQuote } from "./reference-draft.js";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import type { Thread } from "../../protocol-client/index.js";
import { ThreadReadingContext, disclosureKey } from "./thread-reading-state.js";
export interface MessageTargetRequest {
  threadId: string;
  itemId: string;
  requestId: number;
  excerpt?: string;
}
export const MessageTargetNavigationContext = createContext<{
  request: MessageTargetRequest | null;
  consumed(requestId: number): void;
} | null>(null);

/** Focus is renderer-local reading intent; it never changes the destination's transcript. */
export function useMessageTargetNavigation(
  thread: Thread | null,
  viewport: RefObject<HTMLElement | null>,
  pauseFollowing: () => void,
  materializeTurn?: (
    turnId: string,
    onRevealed: () => void,
  ) => Promise<boolean>,
  navigateQuote?: (quote: SentMessageQuote) => boolean,
) {
  const navigation = useContext(MessageTargetNavigationContext);
  const reading = useContext(ThreadReadingContext);
  const consumed = useRef<string | null>(null);
  const retired = useRef(new Set<string>());
  const request = navigation?.request;
  useLayoutEffect(() => {
    if (!request || request.threadId !== thread?.id) return;
    const identity = JSON.stringify([request.threadId, request.requestId]);
    if (consumed.current === identity || retired.current.has(identity)) return;
    if (request.excerpt !== undefined && navigateQuote) {
      let active = true;
      // Virtual materialization uses flushSync and must run outside React's layout commit.
      queueMicrotask(() => {
        if (!active) return;
        if (
          navigateQuote({
            threadId: request.threadId,
            id: request.itemId,
            excerpt: request.excerpt!,
          })
        ) {
          consumed.current = identity;
          navigation?.consumed(request.requestId);
        }
      });
      return () => {
        active = false;
      };
    }
    const turn = thread.turns.find((turn) =>
      turn.items.some(
        (item) =>
          item.id === request.itemId &&
          ["threadMessage", "userMessage"].includes(item.type),
      ),
    );
    if (!turn) return; // Await the target viewport's authoritative resume, not a title/text lookup.
    reading?.set(disclosureKey("turn", turn.id), true);
    pauseFollowing();
    let active = true;
    let frame = 0;
    const focusTarget = () => {
      if (!active) return;
      const element = Array.from(
        viewport.current?.querySelectorAll<HTMLElement>(
          "[data-sent-message-id]",
        ) ?? [],
      ).find((element) => element.dataset.sentMessageId === request.itemId);
      if (!element || element.closest("[hidden], [aria-hidden='true']")) return;
      consumed.current = identity;
      element.dataset.messageTarget = "true";
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "center", behavior: "auto" });
      // Persist the exact newly selected reading position, not the previous live position.
      pauseFollowing();
      element.addEventListener(
        "blur",
        () => delete element.dataset.messageTarget,
        { once: true },
      );
      navigation?.consumed(request.requestId);
    };
    if (materializeTurn)
      queueMicrotask(() => {
        if (!active) return;
        const retireIfOwned = () => {
          // Snapshot cleanup may supersede this attempt without cancelling the
          // still-current request. Only its live effect may retire that identity.
          if (active) retired.current.add(identity);
        };
        void materializeTurn(turn.id, focusTarget).then((revealed) => {
          if (!revealed) retireIfOwned();
        }, retireIfOwned);
      });
    else frame = requestAnimationFrame(focusTarget);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [
    request,
    thread?.id,
    thread?.turns,
    reading,
    pauseFollowing,
    viewport,
    navigation,
    materializeTurn,
    navigateQuote,
  ]);
}
