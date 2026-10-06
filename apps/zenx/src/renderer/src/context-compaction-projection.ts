import { i18n } from "./i18n.js";
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
  effectiveMessages: readonly ModelMessage[] | null;
  /** Display history can arrive before the authoritative canonical read. */
  snapshotError?: string;
}

/** Derives the exact model-message projection immediately after each reset. */
export function projectContextCompactions(
  items: readonly CanonicalItem[] | undefined,
): ContextCompactionProjection[] {
  if (items === undefined) return [];
  return items.flatMap<ContextCompactionProjection>((item, canonicalIndex) => {
    if (item.type !== "context_compaction") return [];
    try {
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
    } catch (error) {
      // Core compilation requires a complete canonical prefix. A live event or
      // paged display history may not contain that prefix; keep the committed
      // summary visible without inventing a retained-context snapshot.
      return [
        {
          item,
          canonicalIndex,
          effectiveMessages: null,
          snapshotError: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  });
}

export function compactionInitiatorLabel(item: ContextCompactionItem): string {
  const initiator =
    item.initiator ?? (item.provenance === "agentic" ? "agent" : undefined);
  if (initiator === "human") return i18n.t("shell:humanInitiated");
  if (initiator === "agent") return i18n.t("shell:agentInitiated");
  if (initiator === "automatic") return i18n.t("shell:automatic");
  return i18n.t("shell:initiatorUnavailable");
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
