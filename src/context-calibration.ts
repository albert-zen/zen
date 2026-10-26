import { createHash } from "node:crypto";
import type { CanonicalItem, CanonicalProviderSelection } from "./item.js";
import type { ModelAdapter, ModelMessage, ModelTool } from "./model.js";
import { estimateModelInput, type ModelInputEstimate } from "./model-usage.js";

export interface ContextEstimateRequest {
  threadId: string;
  items: readonly CanonicalItem[];
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
  adapter: ModelAdapter;
  selection: CanonicalProviderSelection;
  inputModalities?: readonly string[] | null;
}
interface Receipt {
  adapter: number;
  scope: string;
  prefix: string;
  messageCount: number;
  rawTotal: number;
}
interface Anchor extends Receipt {
  measured: number;
}
const categories = [
  "instructions",
  "toolDefinitions",
  "pluginContext",
  "conversation",
] as const;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One ephemeral receipt per thread, containing only hashes/counts, never prompt payloads.
 * A restarted/reconfigured adapter falls back to the local estimate until its next usage receipt.
 */
export class ContextCalibration {
  readonly #anchors = new Map<string, Anchor>();
  readonly #adapterIds = new WeakMap<ModelAdapter, number>();
  #nextAdapterId = 1;

  prepare(request: ContextEstimateRequest): {
    estimate: ModelInputEstimate;
    receipt: Receipt;
  } {
    const raw = estimateModelInput(
      request.messages,
      request.tools,
      request.adapter.contextInstructions,
    );
    let adapterId = this.#adapterIds.get(request.adapter);
    if (adapterId === undefined) {
      adapterId = this.#nextAdapterId++;
      this.#adapterIds.set(request.adapter, adapterId);
    }
    const receipt: Receipt = {
      adapter: adapterId,
      scope: digest({
        selection: request.selection,
        protocol: request.adapter.provider,
        tools: request.tools,
        instructions: request.adapter.contextInstructions ?? "",
        modalities: request.inputModalities ?? null,
        boundary:
          request.items.findLast((item) => item.type === "context_compaction")
            ?.id ?? null,
      }),
      prefix: digest(request.messages),
      messageCount: request.messages.length,
      rawTotal: raw.total,
    };
    const anchor = this.#anchors.get(request.threadId);
    if (
      !anchor ||
      anchor.adapter !== receipt.adapter ||
      anchor.scope !== receipt.scope ||
      request.messages.length < anchor.messageCount ||
      raw.total < anchor.rawTotal ||
      digest(request.messages.slice(0, anchor.messageCount)) !== anchor.prefix
    ) {
      return { estimate: raw, receipt };
    }
    const total = anchor.measured + (raw.total - anchor.rawTotal);
    if (!Number.isSafeInteger(total) || total < 0)
      return { estimate: raw, receipt };
    return { estimate: allocate(raw, total), receipt };
  }

  record(threadId: string, receipt: Receipt, measured: number): void {
    if (
      !Number.isSafeInteger(measured) ||
      measured <= 0 ||
      receipt.rawTotal <= 0
    )
      return;
    this.#anchors.set(threadId, { ...receipt, measured });
  }
}

/** Categories are a local proportional allocation, not a provider-reported breakdown.
 * Largest-remainder allocation keeps integer categories additive to the one product total.
 */
function allocate(raw: ModelInputEstimate, total: number): ModelInputEstimate {
  if (raw.total <= 0) return raw;
  const result = { ...raw, total };
  const divisor = BigInt(raw.total);
  const fractions = categories
    .map((category) => {
      const numerator = BigInt(total) * BigInt(raw[category]);
      result[category] = Number(numerator / divisor);
      return { category, remainder: numerator % divisor };
    })
    .sort((a, b) =>
      a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1,
    );
  let remainder =
    total - categories.reduce((sum, category) => sum + result[category], 0);
  for (const entry of fractions) {
    if (remainder-- <= 0) break;
    result[entry.category]++;
  }
  return result;
}
