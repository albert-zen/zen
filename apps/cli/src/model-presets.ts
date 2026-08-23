import type { ModelCatalogEntryInput } from "../../../src/model-catalog.js";

export const BUILTIN_MODEL_CATALOG_PRESET_VERSION = 2;

export type BuiltinModelCatalogPresetKind =
  "fake" | "openai-subscription" | "openai-compatible";

const PRESETS: Readonly<
  Record<BuiltinModelCatalogPresetKind, readonly ModelCatalogEntryInput[]>
> = Object.freeze({
  fake: Object.freeze([
    Object.freeze({
      id: "fake",
      displayName: "fake",
      description: "Deterministic local model for offline testing",
      hidden: false,
      source: "preset" as const,
      supportedReasoningEfforts: Object.freeze(["medium"]),
      defaultReasoningEffort: "medium",
      inputModalities: Object.freeze(["text" as const]),
      contextWindow: null,
    }),
  ]),
  "openai-subscription": Object.freeze([
    subscriptionPreset("gpt-5.6-sol", [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]),
    subscriptionPreset(
      "gpt-5.6-terra",
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["text", "image"],
    ),
    subscriptionPreset("gpt-5.6-luna", [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    subscriptionPreset("gpt-5.5", ["low", "medium", "high", "xhigh"]),
    subscriptionPreset("gpt-5.4", ["low", "medium", "high", "xhigh"]),
  ]),
  "openai-compatible": Object.freeze([]),
});

export function builtInModelCatalogPreset(
  kind: BuiltinModelCatalogPresetKind,
): readonly ModelCatalogEntryInput[] {
  return PRESETS[kind];
}

export function legacyModelCatalogEntries(
  kind: BuiltinModelCatalogPresetKind,
  modelIds: readonly string[],
): readonly ModelCatalogEntryInput[] {
  const presetById = new Map(
    builtInModelCatalogPreset(kind).map((entry) => [entry.id, entry]),
  );
  return Object.freeze(
    modelIds.map((id) => {
      const preset = presetById.get(id);
      return preset ?? Object.freeze({ id, source: "legacy" as const });
    }),
  );
}

function subscriptionPreset(
  id: string,
  supportedReasoningEfforts: readonly string[],
  inputModalities: readonly ("text" | "image")[] = ["text"],
): ModelCatalogEntryInput {
  return Object.freeze({
    id,
    displayName: id,
    description: "OpenAI subscription model configured by the Zen host",
    hidden: false,
    source: "preset",
    // These capabilities are the fixed host contract, not guesses from the
    // model id. The Provider context window remains unconfirmed.
    supportedReasoningEfforts: Object.freeze([...supportedReasoningEfforts]),
    defaultReasoningEffort: "medium",
    inputModalities: Object.freeze([...inputModalities]),
    contextWindow: null,
  });
}
