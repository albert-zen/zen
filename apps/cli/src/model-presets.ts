import type { ModelCatalogEntryInput } from "../../../src/model-catalog.js";

export const BUILTIN_MODEL_CATALOG_PRESET_VERSION = 1;

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
    subscriptionPreset("gpt-5.6-terra"),
    subscriptionPreset("gpt-5.6-luna"),
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

function subscriptionPreset(id: string): ModelCatalogEntryInput {
  return Object.freeze({
    id,
    displayName: id,
    description: "OpenAI subscription model configured by the Zen host",
    hidden: false,
    source: "preset",
    // The repository confirms the one effort currently exposed by this host,
    // but not a Provider context window.
    supportedReasoningEfforts: Object.freeze(["medium"]),
    defaultReasoningEffort: "medium",
    inputModalities: Object.freeze(["text" as const]),
    contextWindow: null,
  });
}
