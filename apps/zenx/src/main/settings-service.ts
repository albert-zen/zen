import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  createProviderFetch,
  type ProviderFetch,
  type ProviderTransport,
} from "../../../../apps/cli/src/host.js";
import { builtInModelCatalogPreset } from "../../../../apps/cli/src/model-presets.js";
import { OpenAiSubscriptionAuthProfile } from "../../../../apps/cli/src/subscription-auth.js";
import type { ModelAdapter } from "../../../../src/model.js";
import { OpenAiCompatibleModel } from "../../../../src/model/openai-compatible.js";
import {
  extractChatGptAccountId,
  OpenAiSubscriptionModel,
} from "../../../../src/model/openai-subscription.js";
import type {
  ZenXHostConfig,
  HostConfigurationCandidate,
  HostConfigurationCurrent,
  ZenXSingleProviderHostConfig,
} from "./host-messages.js";
import {
  applyBuiltInModelCatalogPresets,
  hostConfigFromProfile,
  type PublicHostSettings,
  type ConfigurationSaveResult,
  type ZenXHostProfile,
  type ZenXModelCatalogEntry,
  type ZenXProviderDeleteReplacements,
  type ZenXProviderEditOptions,
  type ZenXProviderProfile,
  ZenXHostProfileStore,
  type ZenXSidebarOrder,
  type ZenXSettingsUpdate,
  structuredLegacyModelCatalog,
  validateConfiguredModelContexts,
  validateHostProfile,
} from "./host-profile.js";
import { ZenXCredentialVault } from "./credential-vault.js";
import {
  discoverOpenAiCompatibleModels,
  discoverOpenAiSubscriptionModels,
  type DiscoveredModelCatalogEntry,
  ModelDiscoveryHttpError,
  OpenAiSubscriptionModelCache,
} from "./model-discovery.js";
import { resolveZenXHostConfig } from "./host-config.js";
import {
  probeOpenAiCompatibleImage,
  type ImageCapabilityProbeOutcome,
} from "./image-capability-probe.js";
import {
  type ProjectPathIdentity,
  type ProjectPathSnapshot,
  type ProjectRealpath,
  projectPathSnapshot,
  resolveProjectPath,
} from "./project-projection.js";

const MAX_WORKSPACE_IDENTITY_ATTEMPTS = 2;

type SubscriptionAuth = Pick<
  OpenAiSubscriptionAuthProfile,
  "login" | "logout" | "status"
> &
  Partial<
    Pick<
      OpenAiSubscriptionAuthProfile,
      "acquireAccessLease" | "renewAccessLease"
    >
  >;

interface CanonicalWorkspaceSnapshot {
  readonly profile: ZenXHostProfile;
  readonly entries: readonly ProjectPathIdentity[];
  readonly requested: readonly ProjectPathIdentity[];
  readonly identities: ProjectPathSnapshot;
  readonly defaultKey: string | null;
  readonly lastUsedKey: string | null;
}

export interface ZenXProviderCatalogSnapshot {
  providerProfileId: string;
  models: ZenXModelCatalogEntry[];
  source?: "remote" | "cache" | "fallback";
  warning?: string;
}

export interface ZenXImageCapabilityProbeResult {
  outcome: ImageCapabilityProbeOutcome;
  model: ZenXModelCatalogEntry;
}

type OpenAiCompatibleProviderProfile = Extract<
  ZenXProviderProfile,
  { type: "openai-compatible" }
>;

type ProviderOperationTransportResolver = (
  provider: OpenAiCompatibleProviderProfile,
) => Promise<ProviderTransport | undefined>;

interface ProviderOperationSnapshot {
  readonly provider: OpenAiCompatibleProviderProfile;
  readonly model: ZenXModelCatalogEntry | undefined;
  readonly apiKey: string;
  readonly providerFingerprint: string;
}

interface SubscriptionDiscoverySnapshot {
  readonly provider: Extract<
    ZenXProviderProfile,
    { type: "openai-subscription" }
  >;
  readonly providerFingerprint: string;
}

type SettingsConfigurationCandidate = HostConfigurationCandidate;
type SettingsConfigurationCurrent = HostConfigurationCurrent;
export interface SettingsConfigurationControl {
  prepare(
    config: ZenXHostConfig,
    revision: number,
  ): Promise<SettingsConfigurationCandidate>;
  publish(
    candidate: SettingsConfigurationCandidate,
  ): Promise<SettingsConfigurationCurrent>;
  discard(candidate: SettingsConfigurationCandidate): Promise<void>;
  current(): Promise<SettingsConfigurationCurrent>;
}
export class ZenXSettingsService {
  #configurationControl: SettingsConfigurationControl | undefined;
  #configurationResult: ConfigurationSaveResult | undefined;
  #pendingConfiguration: SettingsConfigurationCandidate | undefined;
  #appliedProfile: ZenXHostProfile | undefined;
  #auxiliaryOperations = 0;
  #profileInFlight = 0;
  #maintenance = false;
  #retiredCredentials = new Set<string>();
  configurationRevision(): number {
    return this.#requireProfile().revision ?? 0;
  }
  activeConfigurationOperations(): number {
    return this.#auxiliaryOperations;
  }
  tryBeginMaintenance(): boolean {
    if (
      this.#maintenance ||
      this.#auxiliaryOperations > 0 ||
      this.#profileInFlight > 0 ||
      this.#pendingConfiguration
    )
      return false;
    this.#maintenance = true;
    return true;
  }
  endMaintenance(): void {
    this.#maintenance = false;
  }
  #beginAuxiliaryOperation(): () => Promise<void> {
    if (this.#maintenance) throw new Error("host_restarting");
    this.#auxiliaryOperations++;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.#auxiliaryOperations--;
      await this.#cleanupRetiredCredentials();
    };
  }
  async #cleanupRetiredCredentials(): Promise<void> {
    if (this.#auxiliaryOperations || this.#pendingConfiguration) return;
    for (const reference of this.#retiredCredentials) {
      try {
        await this.#vault.clearApiKey(reference);
        this.#retiredCredentials.delete(reference);
      } catch (error) {
        console.error("Retired credential cleanup failed", error);
      }
    }
  }

  setConfigurationControl(control: SettingsConfigurationControl): void {
    this.#configurationControl = control;
    this.#appliedProfile = this.#requireProfile();
  }
  async reconcileConfiguration(
    retry = false,
  ): Promise<ConfigurationSaveResult | undefined> {
    return this.#queueProfileOperation(async () => {
      const candidate = this.#pendingConfiguration;
      if (!this.#configurationControl) return this.#configurationResult;
      if (!candidate) {
        const current = await this.#configurationControl.current();
        if (current.revision === this.configurationRevision())
          this.#acceptConfiguration(current);
        await this.#cleanupRetiredCredentials();
        return this.#configurationResult;
      }
      let current = await this.#configurationControl.current();
      if (current.revision !== candidate.revision && retry) {
        const prepared =
          current.processEpoch === candidate.processEpoch
            ? candidate
            : await this.#configurationControl.prepare(
                await this.#hostConfigForProfile(this.#requireProfile()),
                candidate.revision,
              );
        this.#pendingConfiguration = prepared;
        current = await this.#configurationControl.publish(prepared);
      }
      if (current.revision === candidate.revision)
        this.#acceptConfiguration(current);
      await this.#cleanupRetiredCredentials();
      return this.#configurationResult;
    });
  }
  #acceptConfiguration(current: SettingsConfigurationCurrent): void {
    this.#pendingConfiguration = undefined;
    this.#appliedProfile = this.#profile;
    this.#configurationResult = {
      status: current.pendingRestart.length ? "pending-restart" : "applied",
      revision: current.revision,
      processEpoch: current.processEpoch,
      pendingRestart: current.pendingRestart,
    };
  }
  #assertBaseRevision(baseRevision: number | undefined): void {
    if (this.#pendingConfiguration)
      throw new Error(
        "Configuration application is unconfirmed; check or retry its application before saving again",
      );
    if (
      baseRevision !== undefined &&
      baseRevision !== (this.#requireProfile().revision ?? 0)
    )
      throw new Error(
        "Configuration conflict: another window saved changes. Your draft was preserved; reload before applying it",
      );
  }
  #credentialReference(id: string, profile = this.#requireProfile()): string {
    return profile.credentialReferences?.[id] ?? id;
  }

  readonly #dataDirectory: string;
  readonly #profilePath: string;
  readonly #profileStore: ZenXHostProfileStore;
  readonly #subscription: SubscriptionAuth;
  readonly #subscriptionFactory: (profilePath: string) => SubscriptionAuth;
  readonly #subscriptionModelCache: OpenAiSubscriptionModelCache;
  readonly #vault: ZenXCredentialVault;
  readonly #projectPlatform: NodeJS.Platform;
  readonly #projectRealpath: ProjectRealpath | undefined;
  readonly #providerFetchFactory: (
    transport: ProviderTransport | undefined,
  ) => ProviderFetch;
  #profile: ZenXHostProfile | undefined;
  #profileOperations: Promise<void> = Promise.resolve();
  #loginInProgress = false;
  #manualCode:
    | {
        resolve(value: string): void;
        reject(error: Error): void;
        signal: AbortSignal;
        aborted(): void;
      }
    | undefined;

  constructor(options: {
    userDataDirectory: string;
    zenDataDirectory: string;
    vault: ZenXCredentialVault;
    profileStore?: ZenXHostProfileStore;
    subscription?: SubscriptionAuth;
    subscriptionFactory?: (profilePath: string) => SubscriptionAuth;
    subscriptionModelCache?: OpenAiSubscriptionModelCache;
    projectPlatform?: NodeJS.Platform;
    projectRealpath?: ProjectRealpath;
    providerFetchFactory?: (
      transport: ProviderTransport | undefined,
    ) => ProviderFetch;
  }) {
    this.#dataDirectory = options.zenDataDirectory;
    this.#profilePath = path.join(
      options.userDataDirectory,
      "openai-subscription-auth.json",
    );
    this.#projectPlatform = options.projectPlatform ?? process.platform;
    this.#profileStore =
      options.profileStore ??
      new ZenXHostProfileStore(
        path.join(options.userDataDirectory, "host-profile.json"),
        this.#projectPlatform,
      );
    this.#subscription =
      options.subscription ??
      new OpenAiSubscriptionAuthProfile(this.#profilePath);
    this.#subscriptionFactory =
      options.subscriptionFactory ??
      ((profilePath) => new OpenAiSubscriptionAuthProfile(profilePath));
    this.#subscriptionModelCache =
      options.subscriptionModelCache ??
      new OpenAiSubscriptionModelCache(
        path.join(
          options.userDataDirectory,
          "openai-subscription-models-cache.json",
        ),
      );
    this.#vault = options.vault;
    this.#projectRealpath = options.projectRealpath;
    this.#providerFetchFactory =
      options.providerFetchFactory ?? createProviderFetch;
  }

  async initialize(environment: NodeJS.ProcessEnv): Promise<void> {
    await this.#queueProfileOperation(async () => {
      const existing = await this.#profileStore.readOptional();
      if (existing !== undefined) {
        if (existing.providerProfiles.length === 1) {
          await this.#vault.migrateLegacyApiKey(
            existing.providerProfiles[0]!.providerProfileId,
          );
        }
        const normalized = await normalizeCanonicalWorkspaces(
          existing,
          this.#projectPlatform,
          this.#projectRealpath,
        );
        if (JSON.stringify(normalized) !== JSON.stringify(existing)) {
          await this.#profileStore.write(normalized);
        }
        this.#profile = normalized;
        return;
      }
      const configureWorkspace = environment.ZENX_CWD !== undefined;
      const legacy = resolveZenXHostConfig(environment);
      const fallback = await normalizeCanonicalWorkspaces(
        profileFromLegacy(legacy, configureWorkspace),
        this.#projectPlatform,
        this.#projectRealpath,
      );
      await this.#persistProfile(
        fallback,
        legacy.provider.type === "openai-compatible"
          ? {
              providerProfileId: fallback.defaultModel.providerProfileId,
              apiKey: legacy.provider.apiKey,
            }
          : undefined,
      );
      this.#profile = fallback;
    });
  }

  async publicSettings(): Promise<PublicHostSettings> {
    await this.#profileOperations;
    const profile = this.#requireProfile();
    const compatibleIds = profile.providerProfiles
      .filter((candidate) => candidate.type === "openai-compatible")
      .map((candidate) => candidate.providerProfileId);
    const apiKeyPresence = await Promise.all(
      compatibleIds.map(
        async (id) =>
          [
            id,
            await this.#vault.hasApiKey(this.#credentialReference(id, profile)),
          ] as const,
      ),
    );
    const subscriptionProviderProfileId =
      this.#configuredSubscriptionProfileId(profile);
    return {
      ...(this.#configurationResult
        ? { configuration: this.#configurationResult }
        : {}),
      profile: structuredClone(profile),
      hasApiKey: await this.#vault.hasApiKey(
        this.#credentialReference(
          profile.defaultModel.providerProfileId,
          profile,
        ),
      ),
      apiKeyProviderProfileIds: apiKeyPresence.flatMap(([id, present]) =>
        present ? [id] : [],
      ),
      subscriptionProviderProfileId: subscriptionProviderProfileId ?? null,
      subscription:
        subscriptionProviderProfileId === undefined
          ? { authenticated: false, expired: false }
          : await this.#subscriptionForProfile(
              subscriptionProviderProfileId,
            ).status(),
    };
  }

  async hostConfig(): Promise<ZenXHostConfig> {
    await this.#profileOperations;
    return this.#hostConfigForProfile(this.#requireProfile());
  }

  async #hostConfigForProfile(
    profile: ZenXHostProfile,
  ): Promise<ZenXHostConfig> {
    const apiKeyProfileIds = profile.providerProfiles
      .filter((candidate) => candidate.type === "openai-compatible")
      .map((candidate) => candidate.providerProfileId);
    return {
      configurationRevision: profile.revision ?? 0,
      ...hostConfigFromProfile(profile, {
        dataDirectory: this.#dataDirectory,
        subscriptionProfilePath: this.#profilePath,
        subscriptionProfilePaths: Object.fromEntries(
          profile.providerProfiles
            .filter((candidate) => candidate.type === "openai-subscription")
            .map((candidate) => [
              candidate.providerProfileId,
              this.#subscriptionProfilePath(candidate.providerProfileId),
            ]),
        ),
        fallbackWorkspace: this.#dataDirectory,
        apiKeys: Object.fromEntries(
          await Promise.all(
            apiKeyProfileIds.map(async (id) => [
              id,
              await this.#vault.readApiKey(
                this.#credentialReference(id, profile),
              ),
            ]),
          ),
        ),
      }),
    };
  }

  async discoverProviderModels(
    providerProfileId: string,
    options: {
      resolveTransport?: ProviderOperationTransportResolver;
      signal?: AbortSignal;
    } = {},
  ): Promise<ZenXProviderCatalogSnapshot> {
    const release = this.#beginAuxiliaryOperation();
    try {
      return await this.#discoverProviderModels(providerProfileId, options);
    } finally {
      await release();
    }
  }
  async #discoverProviderModels(
    providerProfileId: string,
    options: {
      resolveTransport?: ProviderOperationTransportResolver;
      signal?: AbortSignal;
    } = {},
  ): Promise<ZenXProviderCatalogSnapshot> {
    const subscriptionTarget =
      await this.#captureSubscriptionDiscovery(providerProfileId);
    if (subscriptionTarget !== undefined) {
      return await this.#discoverSubscriptionModels(
        subscriptionTarget,
        options.signal,
      );
    }
    const target = await this.#captureProviderOperation(
      providerProfileId,
      "model discovery",
    );
    const transport = await options.resolveTransport?.(target.provider);
    await this.#assertProviderOperationCurrent(target, "model discovery");
    const fetch = this.#providerFetchFactory(transport);
    let models: ZenXModelCatalogEntry[];
    try {
      const discovered = await discoverOpenAiCompatibleModels({
        baseUrl: target.provider.baseUrl,
        apiKey: target.apiKey,
        fetch,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const discoveredById = new Map(
        discovered.map((entry) => [entry.id, entry]),
      );
      const configuredIds = new Set(
        target.provider.models.map((entry) => entry.id),
      );
      models = [
        ...target.provider.models.map((entry) =>
          enrichConfiguredModel(entry, discoveredById.get(entry.id)),
        ),
        ...discovered.filter((entry) => !configuredIds.has(entry.id)),
      ];
    } finally {
      await fetch.close?.();
    }
    await this.#assertProviderOperationCurrent(target, "model discovery");
    return {
      providerProfileId: target.provider.providerProfileId,
      models,
    };
  }

  async #discoverSubscriptionModels(
    target: SubscriptionDiscoverySnapshot,
    requestSignal: AbortSignal | undefined,
  ): Promise<ZenXProviderCatalogSnapshot> {
    const signal = requestSignal ?? new AbortController().signal;
    const subscription = this.#subscriptionForProfile(
      target.provider.providerProfileId,
    );
    const fallback = builtInModelCatalogPreset("openai-subscription").map(
      (entry) => {
        const normalized = structuredLegacyModelCatalog("openai-subscription", [
          entry.id,
        ])[0]!;
        return normalized;
      },
    );
    const merge = (
      discovered: readonly DiscoveredModelCatalogEntry[],
    ): ZenXModelCatalogEntry[] => {
      const discoveredById = new Map(
        discovered.map((entry) => [entry.id, entry]),
      );
      const configuredIds = new Set(
        target.provider.models.map((entry) => entry.id),
      );
      return [
        ...target.provider.models.map((entry) =>
          replaceSubscriptionCatalogModel(entry, discoveredById.get(entry.id)),
        ),
        ...discovered.filter((entry) => !configuredIds.has(entry.id)),
      ];
    };
    const fallbackSnapshot = async (
      warning: string,
      accountId?: string,
    ): Promise<ZenXProviderCatalogSnapshot> => {
      signal.throwIfAborted();
      if (accountId !== undefined) {
        await assertAccountCurrent(accountId);
        const cached = await this.#subscriptionModelCache.load(accountId);
        if (cached !== undefined) {
          await this.#assertSubscriptionDiscoveryCurrent(target);
          await assertAccountCurrent(accountId);
          return {
            providerProfileId: target.provider.providerProfileId,
            models: merge(cached.models),
            source: "cache",
            warning,
          };
        }
      }
      await this.#assertSubscriptionDiscoveryCurrent(target);
      if (accountId !== undefined) await assertAccountCurrent(accountId);
      return {
        providerProfileId: target.provider.providerProfileId,
        models: merge(fallback),
        source: "fallback",
        warning,
      };
    };
    const assertAccountCurrent = async (
      expectedAccountId: string,
    ): Promise<void> => {
      signal.throwIfAborted();
      const current = await subscription.status();
      signal.throwIfAborted();
      if (!current.authenticated || current.accountId !== expectedAccountId) {
        throw new Error(
          "OpenAI subscription account changed during model discovery; try again",
        );
      }
    };
    if (subscription.acquireAccessLease === undefined) {
      const status = await subscription.status();
      return await fallbackSnapshot(
        "OpenAI subscription model discovery is unavailable; using the local catalog",
        status.accountId,
      );
    }
    let lease;
    try {
      lease = await subscription.acquireAccessLease(signal);
    } catch (error) {
      signal.throwIfAborted();
      const status = await subscription.status();
      return await fallbackSnapshot(
        describeDiscoveryError(error),
        status.accountId,
      );
    }
    let accessToken = lease.accessToken;
    const accountId = extractChatGptAccountId(accessToken);
    let cached = await this.#subscriptionModelCache.load(accountId);
    const fetch = this.#providerFetchFactory(undefined);
    try {
      let result;
      try {
        result = await discoverOpenAiSubscriptionModels({
          accessToken,
          etag: cached?.etag,
          fetch,
          signal,
        });
      } catch (error) {
        if (
          error instanceof ModelDiscoveryHttpError &&
          error.status === 401 &&
          subscription.renewAccessLease !== undefined
        ) {
          lease = await subscription.renewAccessLease(accessToken, signal);
          accessToken = lease.accessToken;
          if (extractChatGptAccountId(accessToken) !== accountId) {
            throw new Error(
              "OpenAI subscription account changed during model discovery; try again",
            );
          }
          await assertAccountCurrent(accountId);
          cached = await this.#subscriptionModelCache.load(accountId);
          result = await discoverOpenAiSubscriptionModels({
            accessToken,
            etag: cached?.etag,
            fetch,
            signal,
          });
        } else {
          throw error;
        }
      }
      if (result.notModified) {
        if (cached === undefined) {
          throw new Error(
            "OpenAI subscription model discovery returned not modified without a local cache",
          );
        }
        await this.#assertSubscriptionDiscoveryCurrent(target);
        await assertAccountCurrent(accountId);
        return {
          providerProfileId: target.provider.providerProfileId,
          models: merge(cached.models),
          source: "cache",
        };
      }
      const catalog = {
        accountId: result.accountId,
        fetchedAt: Date.now(),
        ...(result.etag === undefined ? {} : { etag: result.etag }),
        models: result.models,
      };
      await assertAccountCurrent(accountId);
      await this.#subscriptionModelCache.store(catalog).catch(() => undefined);
      await this.#assertSubscriptionDiscoveryCurrent(target);
      await assertAccountCurrent(accountId);
      return {
        providerProfileId: target.provider.providerProfileId,
        models: merge(result.models),
        source: "remote",
      };
    } catch (error) {
      signal.throwIfAborted();
      return await fallbackSnapshot(describeDiscoveryError(error), accountId);
    } finally {
      await fetch.close?.();
    }
  }

  async probeProviderModelImage(
    providerProfileId: string,
    modelId: string,
    options: {
      resolveTransport?: ProviderOperationTransportResolver;
      signal?: AbortSignal;
    } = {},
  ): Promise<ZenXImageCapabilityProbeResult> {
    const release = this.#beginAuxiliaryOperation();
    try {
      return await this.#probeProviderModelImage(
        providerProfileId,
        modelId,
        options,
      );
    } finally {
      await release();
    }
  }
  async #probeProviderModelImage(
    providerProfileId: string,
    modelId: string,
    options: {
      resolveTransport?: ProviderOperationTransportResolver;
      signal?: AbortSignal;
    } = {},
  ): Promise<ZenXImageCapabilityProbeResult> {
    const target = await this.#captureProviderOperation(
      providerProfileId,
      "image capability probe",
      modelId,
    );
    const transport = await options.resolveTransport?.(target.provider);
    await this.#assertProviderOperationCurrent(
      target,
      "image capability probe",
    );
    const fetch = this.#providerFetchFactory(transport);
    let outcome: ImageCapabilityProbeOutcome;
    try {
      outcome = await probeOpenAiCompatibleImage({
        baseUrl: target.provider.baseUrl,
        apiKey: target.apiKey,
        provider: target.provider.name,
        model: target.model!.id,
        fetch,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } finally {
      await fetch.close?.();
    }
    if (outcome === "inconclusive") {
      await this.#assertProviderOperationCurrent(
        target,
        "image capability probe",
      );
      return { outcome, model: target.model! };
    }
    const updated = await this.#queueProfileOperation(async () => {
      await this.#assertProviderOperationCurrentInQueue(
        target,
        "image capability probe",
      );
      const current = this.#requireProfile();
      const providerIndex = current.providerProfiles.findIndex(
        (candidate) => candidate.providerProfileId === providerProfileId,
      );
      if (providerIndex < 0) {
        throw new Error(
          `Provider profile ${providerProfileId} is not configured`,
        );
      }
      const currentProvider = current.providerProfiles[providerIndex]!;
      const modelIndex = currentProvider.models.findIndex(
        (entry) => entry.id === modelId,
      );
      if (modelIndex < 0) {
        throw new Error(
          `Model ${modelId} is not configured for Provider profile ${providerProfileId}`,
        );
      }
      const currentModel = currentProvider.models[modelIndex]!;
      const nextModel: ZenXModelCatalogEntry = {
        ...currentModel,
        inputModalities: outcome === "supported" ? ["text", "image"] : ["text"],
        source: "probe",
      };
      const models = [...currentProvider.models];
      models[modelIndex] = nextModel;
      const providers = [...current.providerProfiles];
      providers[providerIndex] = { ...currentProvider, models };
      const next = validateHostProfile({
        ...current,
        providerProfiles: providers,
      });
      await this.#persistProfile(next);
      this.#profile = next;
      return nextModel;
    });
    return { outcome, model: updated };
  }

  configuredTitleModel(): string {
    return (this.#appliedProfile ?? this.#requireProfile()).titleModel.modelId;
  }

  computerForegroundControlEnabled(): boolean {
    return this.#requireProfile().computerForegroundControlEnabled === true;
  }

  async titleModel() {
    const release = this.#beginAuxiliaryOperation();
    try {
      return { ...(await this.#titleModel()), release };
    } catch (error) {
      await release();
      throw error;
    }
  }
  async #titleModel(): Promise<{
    adapter: ModelAdapter | null;
    model: string;
    reasoningEffort: string | null;
  }> {
    await this.#profileOperations;
    const profile = this.#appliedProfile ?? this.#requireProfile();
    const titleReference = profile.titleModel;
    const provider = profile.providerProfiles.find(
      (candidate) =>
        candidate.providerProfileId === titleReference.providerProfileId,
    )!;
    const modelMetadata = provider.models.find(
      (model) => model.id === titleReference.modelId,
    )!;
    if (modelMetadata.contextWindow === null) {
      throw new Error(
        `ZenX title model ${modelMetadata.id} requires a positive context window`,
      );
    }
    const reasoningEffort = modelMetadata.defaultReasoningEffort;
    if (provider.type === "fake") {
      return { adapter: null, model: titleReference.modelId, reasoningEffort };
    }
    if (provider.type === "openai-subscription") {
      const subscription = this.#subscriptionForProfile(
        provider.providerProfileId,
      );
      const acquireAccessLease = subscription.acquireAccessLease;
      if (acquireAccessLease === undefined) {
        throw new Error("Title model subscription is unavailable");
      }
      const renewAccessLease = subscription.renewAccessLease;
      return {
        adapter: new OpenAiSubscriptionModel({
          acquireAccessLease: async (signal) =>
            await acquireAccessLease.call(subscription, signal),
          ...(renewAccessLease === undefined
            ? {}
            : {
                renewAccessLease: async (rejectedAccessToken, signal) =>
                  await renewAccessLease.call(
                    subscription,
                    rejectedAccessToken,
                    signal,
                  ),
              }),
          instructions:
            "Return only a concise display title of at most 64 characters. Do not include quotes, IDs, labels, or punctuation boilerplate.",
        }),
        model: titleReference.modelId,
        reasoningEffort,
      };
    }
    const apiKey = await this.#vault.readApiKey(
      this.#credentialReference(provider.providerProfileId, profile),
    );
    if (apiKey === undefined)
      throw new Error(
        `Title model Provider profile ${provider.providerProfileId} has no API key`,
      );
    return {
      adapter: new OpenAiCompatibleModel({
        baseUrl: provider.baseUrl,
        apiKey,
        provider: provider.name,
        // Reasoning and visible output share this budget on compatible providers.
        // A 40-token cap can end with finish_reason=length before any title.
        defaultParams: { temperature: 0.2, max_tokens: 4096 },
      }),
      model: titleReference.modelId,
      reasoningEffort,
    };
  }

  async save(settings: ZenXSettingsUpdate, apiKey?: string): Promise<void> {
    await this.#queueProfileOperation(async () => {
      this.#assertBaseRevision(settings.baseRevision);
      const current = this.#requireProfile();
      const validated = (
        await this.#stableWorkspaceSnapshot(
          validateHostProfile({
            ...current,
            onboardingComplete: settings.onboardingComplete,
            computerForegroundControlEnabled:
              settings.computerForegroundControlEnabled === true,
            providerProfiles: settings.providerProfiles,
            defaultModel: settings.defaultModel,
            titleModel: settings.titleModel,
            approvalPolicy: settings.approvalPolicy,
            toolPresentation: settings.toolPresentation ?? "both",
            composerSendMode:
              settings.composerSendMode ?? current.composerSendMode ?? "queue",
            maxToolRounds: settings.maxToolRounds,
            contextCompaction: settings.contextCompaction,
          }),
          [],
        )
      ).profile;
      validateConfiguredModelContexts(validated);
      const credentialProfileId = validated.defaultModel.providerProfileId;
      for (const provider of validated.providerProfiles) {
        if (provider.type !== "openai-compatible") continue;
        const suppliedForProvider =
          provider.providerProfileId === credentialProfileId &&
          apiKey !== undefined &&
          apiKey.length > 0;
        if (
          !suppliedForProvider &&
          !(await this.#vault.hasApiKey(
            this.#credentialReference(provider.providerProfileId),
          ))
        ) {
          throw new Error(
            `Provider profile ${provider.providerProfileId} has no API key`,
          );
        }
      }
      await this.#persistProfile(
        validated,
        apiKey === undefined || apiKey.length === 0
          ? undefined
          : { providerProfileId: credentialProfileId, apiKey },
        current.providerProfiles
          .filter(
            (provider) =>
              !validated.providerProfiles.some(
                (candidate) =>
                  candidate.providerProfileId === provider.providerProfileId,
              ),
          )
          .map((provider) => provider.providerProfileId),
      );
      this.#profile = validated;
    });
  }

  async addProviderProfile(
    provider: ZenXProviderProfile,
    apiKey?: string,
    baseRevision?: number,
  ): Promise<void> {
    await this.#queueProfileOperation(async () => {
      this.#assertBaseRevision(baseRevision);
      const current = this.#requireProfile();
      const next = validateHostProfile({
        ...current,
        providerProfiles: [...current.providerProfiles, provider],
      });
      validateConfiguredModelContexts(next, [
        next.providerProfiles.find(
          (candidate) =>
            candidate.providerProfileId === provider.providerProfileId,
        )!,
      ]);
      if (
        provider.type === "openai-compatible" &&
        (apiKey === undefined || apiKey.length === 0)
      ) {
        throw new Error(
          `Provider profile ${provider.providerProfileId} has no API key`,
        );
      }
      await this.#persistProfile(
        next,
        apiKey === undefined
          ? undefined
          : { providerProfileId: provider.providerProfileId, apiKey },
      );
      this.#profile = next;
    });
  }

  async editProviderProfile(
    providerProfileId: string,
    provider: ZenXProviderProfile,
    options: ZenXProviderEditOptions = {},
  ): Promise<void> {
    await this.#queueProfileOperation(async () => {
      this.#assertBaseRevision(options.baseRevision);
      const current = this.#requireProfile();
      const index = current.providerProfiles.findIndex(
        (candidate) => candidate.providerProfileId === providerProfileId,
      );
      if (index < 0)
        throw new Error(
          `Provider profile ${providerProfileId} is not configured`,
        );
      if (provider.providerProfileId !== providerProfileId) {
        throw new Error("Provider profile id cannot be changed by edit");
      }
      const providerProfiles = [...current.providerProfiles];
      providerProfiles[index] = provider;
      const next = validateHostProfile({
        ...current,
        providerProfiles,
        defaultModel: options.defaultModel ?? current.defaultModel,
        titleModel: options.titleModel ?? current.titleModel,
      });
      validateConfiguredModelContexts(next, [next.providerProfiles[index]!]);
      if (
        provider.type === "openai-compatible" &&
        (options.apiKey === undefined || options.apiKey.length === 0) &&
        !(await this.#vault.hasApiKey(
          this.#credentialReference(providerProfileId),
        ))
      ) {
        throw new Error(`Provider profile ${providerProfileId} has no API key`);
      }
      await this.#persistProfile(
        next,
        options.apiKey === undefined || options.apiKey.length === 0
          ? undefined
          : { providerProfileId, apiKey: options.apiKey },
      );
      this.#profile = next;
    });
  }

  async deleteProviderProfile(
    providerProfileId: string,
    replacements: ZenXProviderDeleteReplacements = {},
  ): Promise<void> {
    await this.#queueProfileOperation(async () => {
      this.#assertBaseRevision(replacements.baseRevision);
      const current = this.#requireProfile();
      if (
        !current.providerProfiles.some(
          (candidate) => candidate.providerProfileId === providerProfileId,
        )
      ) {
        throw new Error(
          `Provider profile ${providerProfileId} is not configured`,
        );
      }
      const defaultReferenced =
        current.defaultModel.providerProfileId === providerProfileId;
      const titleReferenced =
        current.titleModel.providerProfileId === providerProfileId;
      if (defaultReferenced && replacements.defaultModel === undefined) {
        throw new Error(
          "Deleting the default Provider profile requires a replacement default model",
        );
      }
      if (titleReferenced && replacements.titleModel === undefined) {
        throw new Error(
          "Deleting the title Provider profile requires a replacement title model",
        );
      }
      const next = validateHostProfile({
        ...current,
        providerProfiles: current.providerProfiles.filter(
          (candidate) => candidate.providerProfileId !== providerProfileId,
        ),
        defaultModel: replacements.defaultModel ?? current.defaultModel,
        titleModel: replacements.titleModel ?? current.titleModel,
      });
      await this.#persistProfile(next, undefined, [providerProfileId]);
      this.#profile = next;
      // Removing a catalog entry must not revoke an in-flight OAuth identity.
      // Explicit sign-out remains the separate credential revocation action.
    });
  }

  async addWorkspace(workspace: string): Promise<boolean> {
    const candidate = workspace.trim();
    if (candidate.length === 0) throw new Error("Workspace is required");
    const resolved = resolveProjectPath(candidate, this.#projectPlatform);
    return await this.#queueProfileOperation(async () => {
      const snapshot = await this.#stableWorkspaceSnapshot(
        this.#requireProfile(),
        [resolved],
      );
      const current = snapshot.profile;
      const candidateIdentity = snapshot.requested[0]!;
      const candidateKey = candidateIdentity.key;
      const entries = snapshot.entries;
      if (entries.some((entry) => entry.key === candidateKey)) return false;
      const isFirst = current.workspace === null;
      const next = validateHostProfile(
        {
          ...current,
          workspace: isFirst
            ? candidateIdentity.displayPath
            : current.workspace,
          workspaces: [...current.workspaces, candidateIdentity.displayPath],
        },
        this.#projectPlatform,
      );
      await this.#persistProfile(next);
      this.#profile = next;
      return isFirst;
    });
  }

  async editWorkspace(
    workspace: string,
    name: string,
    nextWorkspace: string,
  ): Promise<boolean> {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 200)
      throw new Error("Project name must contain 1–200 characters");
    if (typeof nextWorkspace !== "string" || !nextWorkspace.trim())
      throw new Error("Project folder is required");
    const resolved = resolveProjectPath(nextWorkspace, this.#projectPlatform);
    return await this.#queueProfileOperation(async () => {
      const snapshot = await this.#stableWorkspaceSnapshot(
        this.#requireProfile(),
        [workspace, resolved],
      );
      const oldKey = snapshot.requested[0]!.key;
      const selected = snapshot.entries.find((entry) => entry.key === oldKey);
      if (!selected) throw new Error("Project is not configured");
      const target = snapshot.requested[1]!;
      if (
        target.key !== oldKey &&
        snapshot.entries.some((entry) => entry.key === target.key)
      )
        throw new Error("That folder already belongs to another project");
      const targetPath =
        target.key === oldKey ? selected.displayPath : target.displayPath;
      const names = { ...snapshot.profile.projectNames };
      delete names[selected.displayPath];
      names[targetPath] = name.trim();
      const isDefault = snapshot.defaultKey === oldKey;
      const next = validateHostProfile(
        {
          ...snapshot.profile,
          workspaces: snapshot.entries.map((entry) =>
            entry.key === oldKey ? targetPath : entry.displayPath,
          ),
          workspace: isDefault ? targetPath : snapshot.profile.workspace,
          lastUsedWorkspace:
            snapshot.profile.lastUsedWorkspace === selected.displayPath
              ? targetPath
              : snapshot.profile.lastUsedWorkspace,
          projectNames: names,
          sidebarOrder: {
            ...snapshot.profile.sidebarOrder,
            ...(snapshot.profile.sidebarOrder.pinnedProjectKeys === undefined
              ? {}
              : {
                  pinnedProjectKeys:
                    snapshot.profile.sidebarOrder.pinnedProjectKeys.map(
                      (key) => (key === oldKey ? target.key : key),
                    ),
                }),
            projectKeys: snapshot.profile.sidebarOrder.projectKeys.map((key) =>
              key === oldKey ? target.key : key,
            ),
          },
        },
        this.#projectPlatform,
      );
      await this.#persistProfile(next);
      this.#profile = next;
      return isDefault && target.key !== oldKey;
    });
  }

  async removeWorkspace(workspace: string): Promise<boolean> {
    return await this.#queueProfileOperation(async () => {
      const snapshot = await this.#stableWorkspaceSnapshot(
        this.#requireProfile(),
        [workspace],
      );
      const current = snapshot.profile;
      const key = snapshot.requested[0]!.key;
      const entries = snapshot.entries;
      const nextWorkspaces = entries
        .filter((entry) => entry.key !== key)
        .map((entry) => entry.displayPath);
      if (nextWorkspaces.length === current.workspaces.length) return false;
      const defaultRemoved =
        current.workspace !== null && snapshot.defaultKey === key;
      const next = validateHostProfile(
        {
          ...current,
          workspace: defaultRemoved
            ? (nextWorkspaces[0] ?? null)
            : current.workspace,
          workspaces: nextWorkspaces,
        },
        this.#projectPlatform,
      );
      await this.#persistProfile(next);
      this.#profile = next;
      return defaultRemoved;
    });
  }

  async setDefaultWorkspace(workspace: string): Promise<boolean> {
    return await this.#queueProfileOperation(async () => {
      const snapshot = await this.#stableWorkspaceSnapshot(
        this.#requireProfile(),
        [workspace],
      );
      const current = snapshot.profile;
      const key = snapshot.requested[0]!.key;
      const selected = snapshot.entries.find(
        (entry) => entry.key === key,
      )?.displayPath;
      if (selected === undefined)
        throw new Error("Workspace is not configured");
      if (current.workspace !== null && snapshot.defaultKey === key)
        return false;
      const next = validateHostProfile(
        { ...current, workspace: selected },
        this.#projectPlatform,
      );
      await this.#persistProfile(next);
      this.#profile = next;
      return true;
    });
  }

  async markWorkspaceUsed(workspace: string): Promise<void> {
    await this.#queueProfileOperation(async () => {
      const snapshot = await this.#stableWorkspaceSnapshot(
        this.#requireProfile(),
        [workspace],
      );
      const current = snapshot.profile;
      const key = snapshot.requested[0]!.key;
      const selected = snapshot.entries.find(
        (entry) => entry.key === key,
      )?.displayPath;
      if (selected === undefined)
        throw new Error("Workspace is not configured");
      if (current.lastUsedWorkspace !== null && snapshot.lastUsedKey === key)
        return;
      const next = validateHostProfile(
        {
          ...current,
          lastUsedWorkspace: selected,
        },
        this.#projectPlatform,
      );
      await this.#persistProfile(next);
      this.#profile = next;
    });
  }

  async setPinnedThreadIds(threadIds: readonly string[]): Promise<void> {
    await this.#queueProfileOperation(async () => {
      const current = this.#requireProfile();
      const next = validateHostProfile({
        ...current,
        pinnedThreadIds: [...threadIds],
      });
      if (
        next.pinnedThreadIds.length === current.pinnedThreadIds.length &&
        next.pinnedThreadIds.every(
          (threadId, index) => threadId === current.pinnedThreadIds[index],
        )
      )
        return;
      await this.#persistProfile(next);
      this.#profile = next;
    });
  }

  async setSidebarOrder(order: ZenXSidebarOrder): Promise<void> {
    await this.#queueProfileOperation(async () => {
      const current = this.#requireProfile();
      const next = validateHostProfile({
        ...current,
        sidebarOrder: order,
      });
      if (
        JSON.stringify(next.sidebarOrder) ===
        JSON.stringify(current.sidebarOrder)
      )
        return;
      await this.#persistProfile(next);
      this.#profile = next;
    });
  }

  async login(
    openBrowser: (url: string) => void,
    manualCodeRequested: () => void,
  ): Promise<void> {
    if (this.#loginInProgress)
      throw new Error("OpenAI login is already in progress");
    this.#loginInProgress = true;
    try {
      await this.#activeSubscription().login({
        notifyAuthUrl: openBrowser,
        readManualCode: async ({ signal }) =>
          await new Promise<string>((resolve, reject) => {
            const waiter = {
              resolve,
              reject: (error: Error) => reject(error),
              signal,
              aborted: () => {
                if (this.#manualCode !== waiter) return;
                this.#manualCode = undefined;
                reject(new Error("OpenAI login was cancelled"));
              },
            };
            this.#manualCode = waiter;
            signal.addEventListener("abort", waiter.aborted, { once: true });
            manualCodeRequested();
          }),
      });
    } finally {
      const waiter = this.#manualCode;
      this.#manualCode = undefined;
      this.#loginInProgress = false;
      if (waiter !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.aborted);
        waiter.reject(new Error("OpenAI login ended before a code was used"));
      }
    }
  }

  submitManualCode(value: string): void {
    const waiter = this.#manualCode;
    if (waiter === undefined)
      throw new Error("No OpenAI login is waiting for a code");
    this.#manualCode = undefined;
    waiter.signal.removeEventListener("abort", waiter.aborted);
    waiter.resolve(value);
  }

  async logout(): Promise<void> {
    await this.#activeSubscription().logout();
  }

  #subscriptionForProfile(providerProfileId: string): SubscriptionAuth {
    if (providerProfileId === "openai-codex") return this.#subscription;
    return this.#subscriptionFactory(
      this.#subscriptionProfilePath(providerProfileId),
    );
  }

  #configuredSubscriptionProfileId(
    profile = this.#profile,
  ): string | undefined {
    if (profile === undefined) return undefined;
    const ids = profile.providerProfiles
      .filter((candidate) => candidate.type === "openai-subscription")
      .map((candidate) => candidate.providerProfileId);
    if (ids.length > 1) {
      throw new Error(
        "ZenX supports at most one OpenAI subscription Provider profile",
      );
    }
    return ids[0];
  }

  #activeSubscription(): SubscriptionAuth {
    const providerProfileId = this.#configuredSubscriptionProfileId();
    return providerProfileId === undefined
      ? this.#subscription
      : this.#subscriptionForProfile(providerProfileId);
  }

  #subscriptionProfilePath(providerProfileId: string): string {
    if (providerProfileId === "openai-codex") return this.#profilePath;
    const profileDigest = createHash("sha256")
      .update(providerProfileId)
      .digest("hex")
      .slice(0, 24);
    return path.join(
      path.dirname(this.#profilePath),
      `openai-subscription-auth.${profileDigest}.json`,
    );
  }

  #requireProfile(): ZenXHostProfile {
    if (this.#profile === undefined)
      throw new Error("ZenX settings are not initialized");
    return this.#profile;
  }

  async #captureSubscriptionDiscovery(
    providerProfileId: string,
  ): Promise<SubscriptionDiscoverySnapshot | undefined> {
    return await this.#queueProfileOperation(async () => {
      const provider = this.#requireProfile().providerProfiles.find(
        (candidate) => candidate.providerProfileId === providerProfileId,
      );
      if (provider === undefined) {
        throw new Error(
          `Provider profile ${providerProfileId} is not configured`,
        );
      }
      if (provider.type === "openai-compatible") return undefined;
      if (provider.type !== "openai-subscription") {
        throw new Error(
          `Provider profile ${providerProfileId} does not support model discovery`,
        );
      }
      const snapshot = deepFreeze(structuredClone(provider));
      return Object.freeze({
        provider: snapshot,
        providerFingerprint: JSON.stringify(snapshot),
      });
    });
  }

  async #assertSubscriptionDiscoveryCurrent(
    target: SubscriptionDiscoverySnapshot,
  ): Promise<void> {
    await this.#queueProfileOperation(async () => {
      const current = this.#requireProfile().providerProfiles.find(
        (candidate) =>
          candidate.providerProfileId === target.provider.providerProfileId,
      );
      if (
        current === undefined ||
        current.type !== "openai-subscription" ||
        JSON.stringify(current) !== target.providerFingerprint
      ) {
        throw new Error(
          `Provider profile ${target.provider.providerProfileId} changed during model discovery; try again`,
        );
      }
    });
  }

  async #captureProviderOperation(
    providerProfileId: string,
    operation: "model discovery" | "image capability probe",
    modelId?: string,
  ): Promise<ProviderOperationSnapshot> {
    return await this.#queueProfileOperation(async () => {
      const provider = this.#requireProfile().providerProfiles.find(
        (candidate) => candidate.providerProfileId === providerProfileId,
      );
      if (provider === undefined) {
        throw new Error(
          `Provider profile ${providerProfileId} is not configured`,
        );
      }
      if (provider.type !== "openai-compatible") {
        throw new Error(
          operation === "model discovery"
            ? `Provider profile ${providerProfileId} does not support GET /models discovery`
            : `Provider profile ${providerProfileId} does not support image probing`,
        );
      }
      const providerSnapshot = deepFreeze(structuredClone(provider));
      const model =
        modelId === undefined
          ? undefined
          : providerSnapshot.models.find((entry) => entry.id === modelId);
      if (modelId !== undefined && model === undefined) {
        throw new Error(
          `Model ${modelId} is not configured for Provider profile ${providerProfileId}`,
        );
      }
      const apiKey = await this.#vault.readApiKey(
        this.#credentialReference(providerProfileId),
      );
      if (apiKey === undefined) {
        throw new Error(`Provider profile ${providerProfileId} has no API key`);
      }
      return Object.freeze({
        provider: providerSnapshot,
        model,
        apiKey,
        providerFingerprint: JSON.stringify(providerSnapshot),
      });
    });
  }

  async #assertProviderOperationCurrent(
    target: ProviderOperationSnapshot,
    operation: "model discovery" | "image capability probe",
  ): Promise<void> {
    await this.#queueProfileOperation(
      async () =>
        await this.#assertProviderOperationCurrentInQueue(target, operation),
    );
  }

  async #assertProviderOperationCurrentInQueue(
    target: ProviderOperationSnapshot,
    operation: "model discovery" | "image capability probe",
  ): Promise<void> {
    const current = this.#requireProfile().providerProfiles.find(
      (candidate) =>
        candidate.providerProfileId === target.provider.providerProfileId,
    );
    const apiKey = await this.#vault.readApiKey(
      this.#credentialReference(target.provider.providerProfileId),
    );
    if (
      current === undefined ||
      current.type !== "openai-compatible" ||
      JSON.stringify(current) !== target.providerFingerprint ||
      apiKey !== target.apiKey
    ) {
      throw new Error(
        `Provider profile ${target.provider.providerProfileId} changed during ${operation}; try again`,
      );
    }
  }

  #queueProfileOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#profileOperations.then(async () => {
      if (this.#maintenance) throw new Error("host_restarting");
      this.#profileInFlight++;
      try {
        return await operation();
      } finally {
        this.#profileInFlight--;
      }
    });
    this.#profileOperations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #stableWorkspaceSnapshot(
    profile: ZenXHostProfile,
    requested: readonly string[],
  ): Promise<CanonicalWorkspaceSnapshot> {
    for (
      let attempt = 0;
      attempt < MAX_WORKSPACE_IDENTITY_ATTEMPTS;
      attempt += 1
    ) {
      const snapshot = await canonicalWorkspaceSnapshot(
        profile,
        requested,
        this.#projectPlatform,
        this.#projectRealpath,
      );
      const revalidated = await projectPathSnapshot(
        snapshot.identities.map((identity) => identity.displayPath),
        this.#projectPlatform,
        this.#projectRealpath,
      );
      if (
        revalidated.every(
          (identity, index) => identity.key === snapshot.identities[index]?.key,
        )
      ) {
        return snapshot;
      }
    }
    throw new Error(
      "Workspace filesystem identity changed during the operation; try again",
    );
  }

  async #persistProfile(
    profile: ZenXHostProfile,
    credential?: { providerProfileId: string; apiKey: string },
    clearCredentialProfileIds: readonly string[] = [],
  ): Promise<void> {
    const previous = this.#profile;
    if (this.#pendingConfiguration)
      throw new Error(
        "Configuration application is unconfirmed; check or retry before saving again",
      );
    const oldKey = credential
      ? await this.#vault.readApiKey(
          this.#credentialReference(
            credential.providerProfileId,
            previous ?? profile,
          ),
        )
      : undefined;
    const keyChanged = credential !== undefined && credential.apiKey !== oldKey;
    if (previous && !keyChanged && isDeepStrictEqual(profile, previous)) {
      this.#configurationResult = {
        status: "unchanged",
        revision: previous.revision ?? 0,
        pendingRestart: this.#configurationResult?.pendingRestart ?? [],
      };
      return;
    }
    const revision = (previous?.revision ?? 0) + 1;
    profile.revision = revision;
    profile.credentialReferences = { ...previous?.credentialReferences };
    for (const id of clearCredentialProfileIds)
      delete profile.credentialReferences[id];
    const newReference = keyChanged
      ? oldKey === undefined
        ? credential!.providerProfileId
        : `credential-${randomUUID()}`
      : undefined;
    if (newReference && credential)
      profile.credentialReferences[credential.providerProfileId] = newReference;
    let candidate: SettingsConfigurationCandidate | undefined;
    try {
      if (newReference && credential)
        await this.#vault.writeApiKey(newReference, credential.apiKey);
      if (this.#configurationControl)
        candidate = await this.#configurationControl.prepare(
          await this.#hostConfigForProfile(profile),
          revision,
        );
      await this.#profileStore.write(profile);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (candidate)
        await this.#configurationControl
          ?.discard(candidate)
          .catch((reason) => cleanupErrors.push(reason));
      if (newReference)
        await this.#vault
          .clearApiKey(newReference)
          .catch((reason) => cleanupErrors.push(reason));
      if (cleanupErrors.length)
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Settings were not saved; unused candidate cleanup failed. Previous configuration and credentials are unchanged",
        );
      throw error;
    }
    this.#profile = profile;
    if (candidate && this.#configurationControl) {
      this.#pendingConfiguration = candidate;
      this.#configurationResult = {
        status: "unconfirmed",
        revision,
        processEpoch: candidate.processEpoch,
        pendingRestart: candidate.pendingRestart,
      };
      try {
        const current = await this.#configurationControl.publish(candidate);
        if (
          current.processEpoch === candidate.processEpoch &&
          current.revision === revision
        )
          this.#acceptConfiguration(current);
      } catch {
        try {
          const current = await this.#configurationControl.current();
          if (current.revision === revision) this.#acceptConfiguration(current);
        } catch {
          /* A lost acknowledgement is not proof of failure. */
        }
      }
    } else {
      this.#appliedProfile = profile;
      this.#configurationResult = {
        status: "pending-restart",
        revision,
        pendingRestart: ["host"],
      };
    }
    for (const id of clearCredentialProfileIds)
      this.#retiredCredentials.add(
        this.#credentialReference(id, previous ?? profile),
      );
    if (keyChanged && credential && oldKey !== undefined)
      this.#retiredCredentials.add(
        this.#credentialReference(
          credential.providerProfileId,
          previous ?? profile,
        ),
      );
    await this.#cleanupRetiredCredentials();
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function enrichConfiguredModel(
  configured: ZenXModelCatalogEntry,
  discovered: DiscoveredModelCatalogEntry | undefined,
): ZenXModelCatalogEntry {
  if (discovered === undefined || configured.source === "manual") {
    return configured;
  }
  return {
    ...configured,
    displayName:
      configured.displayName === configured.id
        ? discovered.displayName
        : configured.displayName,
    description: configured.description || discovered.description,
    supportedReasoningEfforts:
      configured.supportedReasoningEfforts ??
      discovered.supportedReasoningEfforts,
    defaultReasoningEffort:
      configured.defaultReasoningEffort ?? discovered.defaultReasoningEffort,
    inputModalities: configured.inputModalities ?? discovered.inputModalities,
    contextWindow: configured.contextWindow ?? discovered.contextWindow,
    source: discovered.source,
  };
}

function replaceSubscriptionCatalogModel(
  configured: ZenXModelCatalogEntry,
  discovered: DiscoveredModelCatalogEntry | undefined,
): ZenXModelCatalogEntry {
  if (discovered === undefined || configured.source === "manual") {
    return configured;
  }
  return discovered;
}

function describeDiscoveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function normalizeCanonicalWorkspaces(
  profile: ZenXHostProfile,
  platform: NodeJS.Platform,
  resolveRealpath: ProjectRealpath | undefined,
): Promise<ZenXHostProfile> {
  return (
    await canonicalWorkspaceSnapshot(profile, [], platform, resolveRealpath)
  ).profile;
}

async function canonicalWorkspaceSnapshot(
  profile: ZenXHostProfile,
  requested: readonly string[],
  platform: NodeJS.Platform,
  resolveRealpath: ProjectRealpath | undefined,
): Promise<CanonicalWorkspaceSnapshot> {
  const validated = validateHostProfile(profile, platform);
  const candidates =
    validated.workspace === null
      ? validated.workspaces
      : [validated.workspace, ...validated.workspaces];
  const defaultIndex = validated.workspace === null ? undefined : 0;
  const lastUsedIndex =
    validated.lastUsedWorkspace === null ? undefined : candidates.length;
  const requestedOffset =
    candidates.length + (lastUsedIndex === undefined ? 0 : 1);
  const identities = await projectPathSnapshot(
    [
      ...candidates,
      ...(validated.lastUsedWorkspace === null
        ? []
        : [validated.lastUsedWorkspace]),
      ...requested,
    ],
    platform,
    resolveRealpath,
  );
  const unique = new Map<string, ProjectPathIdentity>();
  for (const entry of identities.slice(0, candidates.length)) {
    if (!unique.has(entry.key)) unique.set(entry.key, entry);
  }
  const entries = Object.freeze([...unique.values()]);
  const defaultKey =
    defaultIndex === undefined ? null : (identities[defaultIndex]?.key ?? null);
  const lastUsedKey =
    lastUsedIndex === undefined
      ? null
      : (identities[lastUsedIndex]?.key ?? null);
  const normalized = validateHostProfile(
    {
      ...validated,
      workspace:
        defaultKey === null
          ? null
          : (unique.get(defaultKey)?.displayPath ?? null),
      workspaces: entries.map((entry) => entry.displayPath),
      lastUsedWorkspace:
        lastUsedKey === null
          ? null
          : (unique.get(lastUsedKey)?.displayPath ?? null),
    },
    platform,
  );
  return Object.freeze({
    profile: normalized,
    entries,
    requested: Object.freeze(identities.slice(requestedOffset)),
    identities,
    defaultKey,
    lastUsedKey,
  });
}

function profileFromLegacy(
  config: ZenXSingleProviderHostConfig,
  configureWorkspace: boolean,
): ZenXHostProfile {
  const providerConnection =
    config.provider.type === "fake"
      ? { type: "fake" as const, displayName: "Local demo" }
      : config.provider.type === "openai-subscription"
        ? {
            type: "openai-subscription" as const,
            displayName: "OpenAI subscription",
          }
        : {
            type: "openai-compatible" as const,
            name: config.provider.name ?? "openai",
            displayName: config.provider.name ?? "OpenAI compatible",
            baseUrl: config.provider.baseUrl,
          };
  const providerProfileId =
    config.provider.type === "fake"
      ? "fake"
      : config.provider.type === "openai-subscription"
        ? "openai-codex"
        : (config.provider.name ?? "openai-compatible");
  const models = [...(config.models ?? [config.model])];
  const titleModel = "gpt-5.6-luna";
  if (!models.includes(titleModel)) models.push(titleModel);
  return applyBuiltInModelCatalogPresets({
    version: 3,
    onboardingComplete: false,
    computerForegroundControlEnabled: false,
    providerProfiles: [
      {
        ...providerConnection,
        providerProfileId,
        models: structuredLegacyModelCatalog(providerConnection.type, models),
      },
    ],
    defaultModel: { providerProfileId, modelId: config.model },
    titleModel: { providerProfileId, modelId: titleModel },
    workspace: configureWorkspace ? config.cwd : null,
    workspaces: configureWorkspace ? [config.cwd] : [],
    lastUsedWorkspace: null,
    approvalPolicy: config.approvalPolicy,
    toolPresentation: config.toolPresentation ?? "both",
    ...(config.contextCompaction === undefined
      ? {}
      : { contextCompaction: config.contextCompaction }),
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  });
}
