import type { CanonicalProviderSelection } from "./item.js";
import type { ModelCatalog, ModelCatalogEntry } from "./model-catalog.js";
import type { ModelAdapter } from "./model.js";

export type ProviderSelection = CanonicalProviderSelection;

export interface ProviderProfile {
  providerProfileId: string;
  adapter: ModelAdapter;
  modelCatalog: ModelCatalog;
}

export interface ProviderModel {
  providerProfileId: string;
  model: ModelCatalogEntry;
}

export interface ResolvedProviderSelection {
  selection: ProviderSelection;
  adapter: ModelAdapter;
  model: ModelCatalogEntry;
}

export class ProviderRegistry {
  readonly #profiles: ReadonlyMap<string, ProviderProfile>;

  constructor(profiles: readonly ProviderProfile[]) {
    if (profiles.length === 0) {
      throw new Error("Provider registry must contain at least one profile");
    }
    const byId = new Map<string, ProviderProfile>();
    for (const profile of profiles) {
      const providerProfileId = profile.providerProfileId.trim();
      if (providerProfileId.length === 0) {
        throw new Error("Provider profile ids must not be empty");
      }
      if (byId.has(providerProfileId)) {
        throw new Error(`Duplicate provider profile id: ${providerProfileId}`);
      }
      byId.set(
        providerProfileId,
        Object.freeze({ ...profile, providerProfileId }),
      );
    }
    this.#profiles = byId;
  }

  listModels(): readonly ProviderModel[] {
    return Object.freeze(
      [...this.#profiles.values()].flatMap((profile) =>
        profile.modelCatalog.list().map((model) =>
          Object.freeze({
            providerProfileId: profile.providerProfileId,
            model,
          }),
        ),
      ),
    );
  }

  resolve(selection: ProviderSelection): ResolvedProviderSelection {
    const profile = this.#profiles.get(selection.providerProfileId);
    if (profile === undefined) {
      throw new ProviderRegistryError(
        "provider_unavailable",
        `Provider profile is not available from this Zen host: ${selection.providerProfileId}`,
      );
    }
    const model = profile.modelCatalog.get(selection.modelId);
    if (model === undefined) {
      throw new ProviderRegistryError(
        "model_unavailable",
        `Model ${selection.modelId} is not available from provider profile ${selection.providerProfileId}`,
      );
    }
    const supportedReasoningEfforts = model.supportedReasoningEfforts ?? [
      model.defaultReasoningEffort ?? "medium",
    ];
    if (!supportedReasoningEfforts.includes(selection.reasoningEffort)) {
      throw new ProviderRegistryError(
        "reasoning_effort_unavailable",
        `Reasoning effort ${selection.reasoningEffort} is not available for model ${selection.modelId} from provider profile ${selection.providerProfileId}`,
      );
    }
    return {
      selection: structuredClone(selection),
      adapter: profile.adapter,
      model,
    };
  }
}

export class ProviderRegistryError extends Error {
  readonly code:
    | "provider_unavailable"
    | "model_unavailable"
    | "reasoning_effort_unavailable";

  constructor(code: ProviderRegistryError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
