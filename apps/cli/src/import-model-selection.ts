import { decodeModelKey } from "../../../src/protocol/model-key.js";
import type { ProviderSelectionInput } from "../../../src/provider-registry.js";

/** Resolve an explicit CLI choice against the actual target Host catalog. */
export function importModelSelection(
  catalog: unknown,
  requested: string,
): ProviderSelectionInput {
  const data = (catalog as { data?: unknown } | null)?.data;
  if (!Array.isArray(data))
    throw new Error("App Server returned an invalid model list");
  const models = data.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.id === "string",
  );
  const exact = models.filter((entry) => entry.id === requested);
  const matches = exact.length
    ? exact
    : models.filter((entry) => {
        try {
          return decodeModelKey(entry.id as string).modelId === requested;
        } catch {
          return false;
        }
      });
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Import model name is ambiguous; use its full catalog ID"
        : `Import model is unavailable: ${requested}`,
    );
  const selected = matches[0]!;
  const identity = decodeModelKey(selected.id as string);
  const effort = selected.defaultReasoningEffort;
  return {
    ...identity,
    ...(typeof effort === "string" || effort === null
      ? { reasoningEffort: effort }
      : {}),
  };
}
