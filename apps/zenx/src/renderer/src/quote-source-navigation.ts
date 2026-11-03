import type { Turn } from "../../protocol-client/index.js";
import type { TurnCanonicalPresentationIndex } from "./turn-canonical-presentation.js";
import { projectTurn } from "./turn-projection.js";
import { disclosureKey } from "./thread-reading-state.js";

export interface QuoteSourceIdentity {
  threadId: string;
  id: string;
}
export function findMessageQuoteSource(
  viewport: Element | null,
  quote: QuoteSourceIdentity,
): HTMLElement | null {
  return (
    Array.from(
      viewport?.querySelectorAll<HTMLElement>(
        "[data-quote-thread-id][data-quote-item-id]",
      ) ?? [],
    ).find((element) => {
      if (element.dataset.quoteThreadId !== quote.threadId) return false;
      if (element.dataset.quoteItemId === quote.id) return true;
      try {
        const ids: unknown = JSON.parse(element.dataset.quoteItemIds ?? "null");
        return Array.isArray(ids) && ids.includes(quote.id);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** Resolve on explicit navigation, using the full canonical projection, not mounted text. */
export function quoteSourceTarget(
  scope: string,
  turns: readonly Turn[],
  presentation: TurnCanonicalPresentationIndex,
  quote: QuoteSourceIdentity,
) {
  const canonical = presentation.source.quoteItems
    .get(quote.id)
    ?.find((item) => item.id === quote.id && item.threadId === quote.threadId);
  if (!canonical || !("turnId" in canonical) || !canonical.turnId) return null;
  const turn = turns.find((turn) => turn.id === canonical.turnId);
  const metadata = turn && presentation.turns.get(turn.id);
  if (!turn || !metadata) return null;
  const entry = [...metadata.quoteItems].find(([, items]) =>
    items.some(
      (item) => item.id === quote.id && item.threadId === quote.threadId,
    ),
  );
  if (!entry) return null;
  const [renderItemId] = entry;
  const projection = projectTurn(turn);
  const disclosures: string[] = [];
  if (
    projection.finalItem?.id !== renderItemId &&
    !projection.inputItems.some((item) => item.id === renderItemId)
  )
    disclosures.push(disclosureKey("turn", turn.id));
  for (const node of projection.history) {
    if (node.kind !== "traceItem" && node.kind !== "traceGroup") continue;
    const items = node.kind === "traceItem" ? [node.item] : node.items;
    if (items.some((item) => item.id === renderItemId)) {
      disclosures.push(
        disclosureKey("trace", turn.id, node.id),
        disclosureKey("item", turn.id, renderItemId),
      );
      break;
    }
  }
  return {
    rowKey: JSON.stringify([scope, "turn", turn.id]),
    renderItemId,
    disclosures,
  };
}
