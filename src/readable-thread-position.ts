import type { AgentMessageItem, CanonicalItem } from "./item.js";

/** Append-only position of the latest completed readable answer, not a read receipt.
 * Only the last Agent message of a successful Turn is its final answer. Failed,
 * aborted, tool-only and unfinished Turns do not advance this projection.
 */
export interface CompletedAnswer {
  itemId: string;
  position: number;
}

export function completedAnswer(
  items: readonly CanonicalItem[],
): CompletedAnswer | null {
  const lastMessages = new Map<
    string,
    { item: AgentMessageItem; position: number }
  >();
  let answer: CompletedAnswer | null = null;
  for (const [index, item] of items.entries()) {
    if (item.type === "agent_message") {
      lastMessages.set(item.turnId, { item, position: index + 1 });
    } else if (item.type === "turn_completed" || item.type === "turn_aborted") {
      const final = lastMessages.get(item.turnId);
      if (
        item.type === "turn_completed" &&
        item.status === "completed" &&
        final !== undefined &&
        final.item.text.trim().length > 0 &&
        !("incomplete" in final.item && final.item.incomplete === true)
      ) {
        if (final.position > (answer?.position ?? 0))
          answer = { itemId: final.item.id, position: final.position };
      }
      lastMessages.delete(item.turnId);
    }
  }
  return answer;
}
