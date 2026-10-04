import type { Turn } from "../../protocol-client/index.js";
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
  /** A partial display history cannot reconstruct the original snapshot. */
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
      return [
        {
          item,
          canonicalIndex,
          effectiveMessages: null,
          snapshotError: `Retained context snapshot is unavailable in this view. ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  });
}

/** Associate a committed reset with its exact displayed call, never by nearby text or timing. */
export function groupContextCompactions(
  compactions: readonly ContextCompactionProjection[],
  turns: readonly Turn[],
): {
  independent: ContextCompactionProjection[];
  byToolItemId: ReadonlyMap<string, readonly ContextCompactionProjection[]>;
} {
  const independent: ContextCompactionProjection[] = [];
  const byToolItemId = new Map<string, ContextCompactionProjection[]>();
  for (const projection of compactions) {
    const { item } = projection;
    const tool =
      item.provenance === "agentic"
        ? turns
            .find((turn) => turn.id === item.turnId)
            ?.items.find(
              (candidate) =>
                candidate.type === "commandExecution" &&
                candidate.callId === item.callId,
            )
        : undefined;
    if (tool === undefined) {
      independent.push(projection);
      continue;
    }
    const entries = byToolItemId.get(tool.id) ?? [];
    entries.push(projection);
    byToolItemId.set(tool.id, entries);
  }
  return { independent, byToolItemId };
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
