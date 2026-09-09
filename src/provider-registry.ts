import type { CanonicalProviderSelection } from "./item.js";
import {
  StaticModelCatalog,
  type ModelCatalog,
  type ModelCatalogEntry,
} from "./model-catalog.js";
import type { ModelAdapter } from "./model.js";

export type ProviderSelection = CanonicalProviderSelection;

export interface ProviderSelectionInput {
  providerProfileId: string;
  modelId: string;
  reasoningEffort?: string | null;
}

export interface ProviderProfile {
  providerProfileId: string;
  adapter: ModelAdapter;
  modelCatalog: ModelCatalog;
  /** Releases the adapter/transport after its last snapshot and execution lease retire. */
  close?: () => Promise<void> | void;
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

export interface ProviderSelectionLease extends ResolvedProviderSelection {
  readonly revision: number;
  release(): void;
}

export interface ProviderRegistrySnapshot {
  readonly revision: number;
  listModels(): readonly ProviderModel[];
  resolve(
    selection: ProviderSelectionInput,
    fallbackReasoningEffort?: string | null,
  ): ResolvedProviderSelection;
}

interface ProviderResource {
  readonly adapter: ModelAdapter;
  close: (() => Promise<void> | void) | undefined;
  references: number;
  closePromise: Promise<void> | undefined;
  readonly retirementWaiters: Array<{
    resolve(): void;
    reject(error: unknown): void;
  }>;
}

interface SnapshotState {
  status: "prepared" | "current" | "retired" | "discarded";
  activeLeases: number;
  readonly resources: ReadonlySet<ProviderResource>;
}

interface NormalizedProviderProfile {
  readonly providerProfileId: string;
  readonly adapter: ModelAdapter;
  readonly modelCatalog: ModelCatalog;
}

export interface ProviderRegistryOptions {
  revision?: number;
  onRetirementError?: (error: unknown) => void;
}

class ImmutableProviderRegistrySnapshot implements ProviderRegistrySnapshot {
  readonly revision: number;
  readonly #profiles: ReadonlyMap<string, NormalizedProviderProfile>;
  readonly #models: readonly ProviderModel[];

  constructor(
    revision: number,
    profiles: readonly NormalizedProviderProfile[],
  ) {
    this.revision = revision;
    this.#profiles = new Map(
      profiles.map((profile) => [profile.providerProfileId, profile]),
    );
    this.#models = Object.freeze(
      profiles.flatMap((profile) =>
        profile.modelCatalog.list().map((model) =>
          Object.freeze({
            providerProfileId: profile.providerProfileId,
            model,
          }),
        ),
      ),
    );
    Object.freeze(this);
  }

  listModels(): readonly ProviderModel[] {
    return this.#models;
  }

  resolve(
    selection: ProviderSelectionInput,
    fallbackReasoningEffort?: string | null,
  ): ResolvedProviderSelection {
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
    if (model.contextWindow === null) {
      throw new ProviderRegistryError(
        "context_window_unknown",
        `Context window is missing for model ${selection.modelId} from provider profile ${selection.providerProfileId}; configure a positive context window before using this model`,
      );
    }
    const supportedReasoningEfforts = model.supportedReasoningEfforts;
    const hasExplicitReasoningEffort = Object.prototype.hasOwnProperty.call(
      selection,
      "reasoningEffort",
    );
    const explicitReasoningEffort = selection.reasoningEffort;
    if (supportedReasoningEfforts === null) {
      throw new ProviderRegistryError(
        "reasoning_effort_unknown",
        `Reasoning capability is unknown for model ${selection.modelId} from provider profile ${selection.providerProfileId}; configure a manual capability override`,
      );
    }
    if (
      hasExplicitReasoningEffort &&
      explicitReasoningEffort !== null &&
      explicitReasoningEffort !== undefined &&
      !supportedReasoningEfforts.includes(explicitReasoningEffort)
    ) {
      throw new ProviderRegistryError(
        "reasoning_effort_unavailable",
        `Reasoning effort ${explicitReasoningEffort} is not available for model ${selection.modelId} from provider profile ${selection.providerProfileId}`,
      );
    }
    if (hasExplicitReasoningEffort && explicitReasoningEffort === null) {
      if (supportedReasoningEfforts.length !== 0) {
        throw new ProviderRegistryError(
          "reasoning_effort_unavailable",
          `Model ${selection.modelId} from provider profile ${selection.providerProfileId} requires an explicit supported reasoning effort`,
        );
      }
      return {
        selection: {
          providerProfileId: selection.providerProfileId,
          modelId: selection.modelId,
          reasoningEffort: null,
        },
        adapter: profile.adapter,
        model,
      };
    }
    const canPreserveFallback =
      fallbackReasoningEffort !== undefined &&
      fallbackReasoningEffort !== null &&
      supportedReasoningEfforts.includes(fallbackReasoningEffort);
    const reasoningEffort =
      explicitReasoningEffort ??
      (canPreserveFallback
        ? fallbackReasoningEffort
        : model.defaultReasoningEffort);
    if (reasoningEffort === null && supportedReasoningEfforts.length === 0) {
      return {
        selection: {
          providerProfileId: selection.providerProfileId,
          modelId: selection.modelId,
          reasoningEffort: null,
        },
        adapter: profile.adapter,
        model,
      };
    }
    if (reasoningEffort === null || reasoningEffort === undefined) {
      throw new ProviderRegistryError(
        "reasoning_effort_unavailable",
        `Model ${selection.modelId} from provider profile ${selection.providerProfileId} has no supported default reasoning effort`,
      );
    }
    return {
      selection: {
        providerProfileId: selection.providerProfileId,
        modelId: selection.modelId,
        reasoningEffort,
      },
      adapter: profile.adapter,
      model,
    };
  }
}

export class ProviderRegistry {
  readonly #resources = new WeakMap<ModelAdapter, ProviderResource>();
  readonly #allResources = new Set<ProviderResource>();
  readonly #states = new WeakMap<ProviderRegistrySnapshot, SnapshotState>();
  readonly #prepared = new Set<ProviderRegistrySnapshot>();
  readonly #onRetirementError: (error: unknown) => void;
  #current: ProviderRegistrySnapshot;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    profiles: readonly ProviderProfile[],
    options: ProviderRegistryOptions = {},
  ) {
    this.#onRetirementError =
      options.onRetirementError ??
      ((error) => console.warn("Could not retire Provider resource", error));
    const initial = this.prepareSnapshot(profiles, options.revision ?? 0);
    this.#states.get(initial)!.status = "current";
    this.#prepared.delete(initial);
    this.#current = initial;
  }

  currentSnapshot(): ProviderRegistrySnapshot {
    return this.#current;
  }

  prepareSnapshot(
    profiles: readonly ProviderProfile[],
    revision: number,
  ): ProviderRegistrySnapshot {
    if (this.#closed) throw new Error("Provider registry is closed");
    assertRevision(revision);
    const normalized = normalizeProfiles(profiles);
    const resources = new Set<ProviderResource>();
    for (const profile of profiles) {
      let resource = this.#resources.get(profile.adapter);
      if (resource === undefined) {
        resource = {
          adapter: profile.adapter,
          close: profile.close,
          references: 0,
          closePromise: undefined,
          retirementWaiters: [],
        };
        this.#resources.set(profile.adapter, resource);
        this.#allResources.add(resource);
      } else if (resource.closePromise !== undefined) {
        throw new Error("A closed Provider adapter cannot be prepared again");
      } else if (resource.close === undefined && profile.close !== undefined) {
        resource.close = profile.close;
      }
      resources.add(resource);
    }
    for (const resource of resources) resource.references += 1;
    const snapshot = new ImmutableProviderRegistrySnapshot(
      revision,
      normalized,
    );
    this.#states.set(snapshot, {
      status: "prepared",
      activeLeases: 0,
      resources,
    });
    this.#prepared.add(snapshot);
    return snapshot;
  }

  publishSnapshot(snapshot: ProviderRegistrySnapshot): void {
    if (this.#closed) throw new Error("Provider registry is closed");
    const state = this.#requireState(snapshot);
    if (state.status !== "prepared") {
      throw new Error("Only a prepared Provider snapshot can be published");
    }
    const previous = this.#current;
    const previousState = this.#requireState(previous);
    state.status = "current";
    this.#prepared.delete(snapshot);
    this.#current = snapshot;
    previousState.status = "retired";
    this.#releaseSnapshotResources(previousState);
  }

  async discardSnapshot(snapshot: ProviderRegistrySnapshot): Promise<void> {
    const state = this.#requireState(snapshot);
    if (state.status !== "prepared") {
      throw new Error("Only a prepared Provider snapshot can be discarded");
    }
    state.status = "discarded";
    this.#prepared.delete(snapshot);
    await this.#releaseSnapshotResources(state, true);
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= (async () => {
      const states: SnapshotState[] = [];
      const currentState = this.#requireState(this.#current);
      if (currentState.status === "current") {
        currentState.status = "retired";
        states.push(currentState);
      }
      for (const snapshot of this.#prepared) {
        const state = this.#requireState(snapshot);
        if (state.status === "prepared") {
          state.status = "discarded";
          states.push(state);
        }
      }
      this.#prepared.clear();
      await Promise.all(
        states.map(async (state) =>
          this.#releaseSnapshotResources(state, true),
        ),
      );
      await Promise.all(
        [...this.#allResources].map(async (resource) =>
          this.#waitForResourceRetirement(resource),
        ),
      );
      this.#allResources.clear();
    })();
    return this.#closePromise;
  }

  listModels(): readonly ProviderModel[] {
    return this.#current.listModels();
  }

  resolve(
    selection: ProviderSelectionInput,
    fallbackReasoningEffort?: string | null,
  ): ResolvedProviderSelection {
    return this.#current.resolve(selection, fallbackReasoningEffort);
  }

  acquire(
    selection: ProviderSelectionInput,
    fallbackReasoningEffort?: string | null,
  ): ProviderSelectionLease {
    if (this.#closed) throw new Error("Provider registry is closed");
    const snapshot = this.#current;
    const state = this.#requireState(snapshot);
    const resolved = snapshot.resolve(selection, fallbackReasoningEffort);
    const resource = this.#resources.get(resolved.adapter);
    if (resource === undefined) {
      throw new Error("Provider snapshot resolved an unowned adapter");
    }
    state.activeLeases += 1;
    resource.references += 1;
    let released = false;
    return Object.freeze({
      revision: snapshot.revision,
      ...resolved,
      release: () => {
        if (released) return;
        released = true;
        state.activeLeases -= 1;
        void this.#releaseResource(resource).catch(this.#onRetirementError);
      },
    });
  }

  #requireState(snapshot: ProviderRegistrySnapshot): SnapshotState {
    const state = this.#states.get(snapshot);
    if (state === undefined) {
      throw new Error("Provider snapshot belongs to a different registry");
    }
    return state;
  }

  #releaseSnapshotResources(
    state: SnapshotState,
    observeErrors = false,
  ): Promise<void> {
    const release = Promise.all(
      [...state.resources].map(async (resource) =>
        this.#releaseResource(resource),
      ),
    ).then(() => undefined);
    if (!observeErrors) void release.catch(this.#onRetirementError);
    return release;
  }

  #releaseResource(resource: ProviderResource): Promise<void> {
    resource.references -= 1;
    if (resource.references < 0) {
      throw new Error("Provider resource reference count underflow");
    }
    if (resource.references !== 0) return Promise.resolve();
    resource.closePromise ??= Promise.resolve()
      .then(async () => resource.close?.())
      .then(
        () => {
          for (const waiter of resource.retirementWaiters.splice(0)) {
            waiter.resolve();
          }
        },
        (error: unknown) => {
          for (const waiter of resource.retirementWaiters.splice(0)) {
            waiter.reject(error);
          }
          throw error;
        },
      );
    return resource.closePromise;
  }

  #waitForResourceRetirement(resource: ProviderResource): Promise<void> {
    if (resource.closePromise !== undefined) return resource.closePromise;
    return new Promise<void>((resolve, reject) => {
      resource.retirementWaiters.push({ resolve, reject });
    });
  }
}

function normalizeProfiles(
  profiles: readonly ProviderProfile[],
): readonly NormalizedProviderProfile[] {
  if (profiles.length === 0) {
    throw new Error("Provider registry must contain at least one profile");
  }
  const ids = new Set<string>();
  return Object.freeze(
    profiles.map((profile) => {
      const providerProfileId = profile.providerProfileId.trim();
      if (providerProfileId.length === 0) {
        throw new Error("Provider profile ids must not be empty");
      }
      if (ids.has(providerProfileId)) {
        throw new Error(`Duplicate provider profile id: ${providerProfileId}`);
      }
      ids.add(providerProfileId);
      const modelCatalog = new StaticModelCatalog(profile.modelCatalog.list());
      return Object.freeze({
        providerProfileId,
        adapter: profile.adapter,
        modelCatalog,
      });
    }),
  );
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(
      "Provider snapshot revision must be a non-negative integer",
    );
  }
}

export class ProviderRegistryError extends Error {
  readonly code:
    | "provider_unavailable"
    | "model_unavailable"
    | "context_window_unknown"
    | "reasoning_effort_unavailable"
    | "reasoning_effort_unknown";

  constructor(code: ProviderRegistryError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
