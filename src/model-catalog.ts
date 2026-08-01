export interface ModelCatalogEntry {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
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

  constructor(entries: readonly ModelCatalogEntry[]) {
    if (entries.length === 0) {
      throw new Error("Model catalog must contain at least one model");
    }
    const normalized = entries.map((entry) => normalizeEntry(entry));
    const byId = new Map<string, ModelCatalogEntry>();
    for (const entry of normalized) {
      if (byId.has(entry.id)) {
        throw new Error(`Duplicate model catalog entry: ${entry.id}`);
      }
      byId.set(entry.id, entry);
    }
    const defaults = normalized.filter((entry) => entry.isDefault === true);
    if (defaults.length !== 1) {
      throw new Error("Model catalog must contain exactly one default model");
    }
    const defaultEntry = defaults[0]!;
    if (defaultEntry.hidden === true) {
      throw new Error("Model catalog default must be visible");
    }
    const frozenEntries = normalized.map((entry) =>
      Object.freeze({
        ...entry,
        isDefault: entry.id === defaultEntry.id,
      }),
    );
    this.#entries = Object.freeze(frozenEntries);
    this.#byId = new Map(this.#entries.map((entry) => [entry.id, entry]));
    this.#default = this.#byId.get(defaultEntry.id)!;
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

function normalizeEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
  const id = entry.id.trim();
  if (id.length === 0) {
    throw new Error("Model catalog ids must not be empty");
  }
  const displayName = entry.displayName?.trim();
  const description = entry.description?.trim();
  return {
    id,
    ...(displayName === undefined || displayName.length === 0
      ? {}
      : { displayName }),
    ...(description === undefined || description.length === 0
      ? {}
      : { description }),
    ...(entry.hidden === undefined ? {} : { hidden: entry.hidden }),
    ...(entry.isDefault === undefined ? {} : { isDefault: entry.isDefault }),
  };
}
