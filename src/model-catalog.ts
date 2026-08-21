import type { ReasoningEffort } from "./model.js";

export const MODEL_CATALOG_SOURCES = [
  "preset",
  "discovered",
  "manual",
  "legacy",
] as const;

export type ModelCatalogSource = (typeof MODEL_CATALOG_SOURCES)[number];
export type ModelInputModality = "text" | "image";

export interface ModelCatalogEntryInput {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: readonly ReasoningEffort[] | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  inputModalities?: readonly ModelInputModality[] | null;
  contextWindow?: number | null;
  source?: ModelCatalogSource;
}

export interface ModelCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  /** null means Unknown; [] means known to support no selectable effort. */
  supportedReasoningEfforts: readonly ReasoningEffort[] | null;
  /** null means the Provider default is Unknown or absent. */
  defaultReasoningEffort: ReasoningEffort | null;
  /** null means Unknown; [] means known to accept no supported input modality. */
  inputModalities: readonly ModelInputModality[] | null;
  /** null means Unknown. */
  contextWindow: number | null;
  source: ModelCatalogSource;
}

export interface ModelCatalog {
  list(): readonly ModelCatalogEntry[];
  get(model: string): ModelCatalogEntry | undefined;
  defaultModel(): ModelCatalogEntry;
}

export class StaticModelCatalog implements ModelCatalog {
  readonly #entries: readonly ModelCatalogEntry[];
  readonly #byId: ReadonlyMap<string, ModelCatalogEntry>;
  readonly #default: ModelCatalogEntry;

  constructor(entries: readonly ModelCatalogEntryInput[]) {
    if (entries.length === 0) {
      throw new Error("Model catalog must contain at least one model");
    }
    const normalized = entries.map((entry) =>
      normalizeModelCatalogEntry(entry),
    );
    const byId = new Map<string, ModelCatalogEntry>();
    for (const entry of normalized) {
      if (byId.has(entry.id)) {
        throw new Error(`Duplicate model catalog entry: ${entry.id}`);
      }
      byId.set(entry.id, entry);
    }
    const defaults = normalized.filter((entry) => entry.isDefault);
    if (defaults.length !== 1) {
      throw new Error("Model catalog must contain exactly one default model");
    }
    const defaultEntry = defaults[0]!;
    if (defaultEntry.hidden) {
      throw new Error("Model catalog default must be visible");
    }
    this.#entries = Object.freeze(normalized);
    this.#byId = byId;
    this.#default = defaultEntry;
  }

  list(): readonly ModelCatalogEntry[] {
    return this.#entries;
  }

  get(model: string): ModelCatalogEntry | undefined {
    return this.#byId.get(model);
  }

  defaultModel(): ModelCatalogEntry {
    return this.#default;
  }
}

export function normalizeModelCatalogEntry(
  entry: ModelCatalogEntryInput,
): ModelCatalogEntry {
  const id = entry.id.trim();
  if (id.length === 0) {
    throw new Error("Model catalog ids must not be empty");
  }
  const source = entry.source ?? "legacy";
  if (!(MODEL_CATALOG_SOURCES as readonly unknown[]).includes(source)) {
    throw new Error(`Model catalog source is invalid for model ${id}`);
  }
  const legacy = source === "legacy";
  const supportedReasoningEfforts = normalizeReasoningEfforts(
    entry.supportedReasoningEfforts === undefined
      ? legacy
        ? ["medium"]
        : null
      : entry.supportedReasoningEfforts,
  );
  const defaultReasoningEffort = normalizeOptionalText(
    entry.defaultReasoningEffort === undefined
      ? legacy
        ? "medium"
        : null
      : entry.defaultReasoningEffort,
    "Default reasoning effort",
  );
  if (
    defaultReasoningEffort !== null &&
    supportedReasoningEfforts !== null &&
    !supportedReasoningEfforts.includes(defaultReasoningEffort)
  ) {
    throw new Error(
      `Model ${id} default reasoning effort ${defaultReasoningEffort} is not supported`,
    );
  }
  const inputModalities = normalizeInputModalities(
    entry.inputModalities === undefined
      ? legacy
        ? ["text"]
        : null
      : entry.inputModalities,
  );
  const contextWindow = entry.contextWindow ?? null;
  if (
    contextWindow !== null &&
    (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
  ) {
    throw new Error(`Model ${id} context window must be a positive integer`);
  }
  const displayName = entry.displayName?.trim() || id;
  const description = entry.description?.trim() ?? "";
  return Object.freeze({
    id,
    displayName,
    description,
    hidden: entry.hidden ?? false,
    isDefault: entry.isDefault ?? false,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    inputModalities,
    contextWindow,
    source,
  });
}

function normalizeReasoningEfforts(
  efforts: readonly ReasoningEffort[] | null,
): readonly ReasoningEffort[] | null {
  if (efforts === null) return null;
  const normalized = efforts.map((effort) => {
    const value = effort.trim();
    if (value.length === 0) {
      throw new Error("Reasoning efforts must not be empty");
    }
    return value;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Reasoning efforts must be unique per model");
  }
  return Object.freeze(normalized);
}

function normalizeInputModalities(
  modalities: readonly ModelInputModality[] | null,
): readonly ModelInputModality[] | null {
  if (modalities === null) return null;
  if (modalities.some((value) => value !== "text" && value !== "image")) {
    throw new Error("Model input modalities contain an unsupported value");
  }
  if (new Set(modalities).size !== modalities.length) {
    throw new Error("Model input modalities must be unique");
  }
  return Object.freeze([...modalities]);
}

function normalizeOptionalText(
  value: string | null,
  label: string,
): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  return normalized;
}
