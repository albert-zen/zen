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
) {
  const navigation = useContext(MessageTargetNavigationContext);
  const reading = useContext(ThreadReadingContext);
  const consumed = useRef<number | null>(null);
  const request = navigation?.request;
  useLayoutEffect(() => {
    if (
      !request ||
      request.threadId !== thread?.id ||
      consumed.current === request.requestId
    )
      return;
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
    const frame = requestAnimationFrame(() => {
      const element = Array.from(
        viewport.current?.querySelectorAll<HTMLElement>(
          "[data-sent-message-id]",
        ) ?? [],
      ).find((element) => element.dataset.sentMessageId === request.itemId);
      if (!element || element.closest("[hidden], [aria-hidden='true']")) return;
      consumed.current = request.requestId;
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
    });
    return () => cancelAnimationFrame(frame);
  }, [
    request,
    thread?.id,
    thread?.turns,
    reading,
    pauseFollowing,
    viewport,
    navigation,
  ]);
}
