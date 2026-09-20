import {
  compileModelMessages,
  type ModelMessage,
} from "../../../../../src/model.js";
import type {
  CanonicalItem,
  CanonicalProviderSelection,
  ContextCompactionItem,
} from "../../../../../src/item.js";

export interface ContextCompactionProjection {
  item: ContextCompactionItem;
  canonicalIndex: number;
  effectiveMessages: readonly ModelMessage[];
}

/** Derives the exact model-message projection immediately after each reset. */
export function projectContextCompactions(
  items: readonly CanonicalItem[] | undefined,
): ContextCompactionProjection[] {
  if (items === undefined) return [];
  return items.flatMap((item, canonicalIndex) => {
    if (item.type !== "context_compaction") return [];
    return [
      {
        item,
        canonicalIndex,
        effectiveMessages: compileModelMessages(
          items.slice(0, canonicalIndex + 1),
          compactionSelection(items, item, canonicalIndex),
        ),
      },
    ];
  });
}

export function compactionInitiatorLabel(item: ContextCompactionItem): string {
  const initiator =
    item.initiator ?? (item.provenance === "agentic" ? "agent" : undefined);
  if (initiator === "human") return "Human initiated";
  if (initiator === "agent") return "Agent initiated";
  if (initiator === "automatic") return "Automatic";
  return "Initiator unavailable";
}

function compactionSelection(
  items: readonly CanonicalItem[],
  item: ContextCompactionItem,
  canonicalIndex: number,
): CanonicalProviderSelection | undefined {
  if (item.provenance !== "agentic") {
    return {
      providerProfileId: item.providerProfileId,
      modelId: item.modelId,
      reasoningEffort: item.reasoningEffort,
    };
  }
  const started = items
    .slice(0, canonicalIndex + 1)
    .findLast(
      (candidate) =>
        candidate.type === "turn_started" && candidate.turnId === item.turnId,
    );
  return started?.type === "turn_started" ? started.selection : undefined;
}
