import { createHash } from "node:crypto";
import path from "node:path";

import {
  createProviderFetch,
  type ProviderFetch,
  type ProviderTransport,
} from "../../../../apps/cli/src/host.js";
import { OpenAiSubscriptionAuthProfile } from "../../../../apps/cli/src/subscription-auth.js";
import type { ModelAdapter } from "../../../../src/model.js";
import { OpenAiCompatibleModel } from "../../../../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../../../../src/model/openai-subscription.js";
import type {
  ZenXHostConfig,
  ZenXSingleProviderHostConfig,
} from "./host-messages.js";
import {
  applyBuiltInModelCatalogPresets,
  hostConfigFromProfile,
  type PublicHostSettings,
  type ZenXHostProfile,
  type ZenXModelCatalogEntry,
  type ZenXProviderDeleteReplacements,
  type ZenXProviderEditOptions,
  type ZenXProviderProfile,
  ZenXHostProfileStore,
  type ZenXSidebarOrder,
  type ZenXSettingsUpdate,
  structuredLegacyModelCatalog,
  validateHostProfile,
} from "./host-profile.js";
import { ZenXCredentialVault } from "./credential-vault.js";
import {
  discoverOpenAiCompatibleModels,
  type DiscoveredModelCatalogEntry,
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
}

export interface ZenXImageCapabilityProbeResult {
  outcome: ImageCapabilityProbeOutcome;
  model: ZenXModelCatalogEntry;
}

export class ZenXSettingsService {
  readonly #dataDirectory: string;
  readonly #profilePath: string;
  readonly #profileStore: ZenXHostProfileStore;
  readonly #subscription: SubscriptionAuth;
  readonly #subscriptionFactory: (profilePath: string) => SubscriptionAuth;
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
        async (id) => [id, await this.#vault.hasApiKey(id)] as const,
      ),
    );
    const subscriptionProviderProfileId =
      this.#configuredSubscriptionProfileId(profile);
    return {
      profile,
      hasApiKey: await this.#vault.hasApiKey(
        profile.defaultModel.providerProfileId,
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
    const profile = this.#requireProfile();
    const apiKeyProfileIds = profile.providerProfiles
      .filter((candidate) => candidate.type === "openai-compatible")
      .map((candidate) => candidate.providerProfileId);
    return hostConfigFromProfile(profile, {
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
      apiKeys: await this.#vault.readApiKeys(apiKeyProfileIds),
    });
  }

  async discoverProviderModels(
    providerProfileId: string,
    options: { transport?: ProviderTransport; signal?: AbortSignal } = {},
  ): Promise<ZenXProviderCatalogSnapshot> {
    await this.#profileOperations;
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
        `Provider profile ${providerProfileId} does not support GET /models discovery`,
      );
    }
    const apiKey = await this.#vault.readApiKey(provider.providerProfileId);
    if (apiKey === undefined) {
      throw new Error(
        `Provider profile ${provider.providerProfileId} has no API key`,
      );
    }
    const fetch = this.#providerFetchFactory(options.transport);
    try {
      const discovered = await discoverOpenAiCompatibleModels({
        baseUrl: provider.baseUrl,
        apiKey,
        fetch,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const discoveredById = new Map(
        discovered.map((entry) => [entry.id, entry]),
      );
      const configuredIds = new Set(provider.models.map((entry) => entry.id));
      return {
        providerProfileId: provider.providerProfileId,
        models: [
          ...provider.models.map((entry) =>
            enrichConfiguredModel(entry, discoveredById.get(entry.id)),
          ),
          ...discovered.filter((entry) => !configuredIds.has(entry.id)),
        ],
      };
    } finally {
      await fetch.close?.();
    }
  }

  async probeProviderModelImage(
    providerProfileId: string,
    modelId: string,
    options: { transport?: ProviderTransport; signal?: AbortSignal } = {},
  ): Promise<ZenXImageCapabilityProbeResult> {
    await this.#profileOperations;
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
        `Provider profile ${providerProfileId} does not support image probing`,
      );
    }
    const model = provider.models.find((entry) => entry.id === modelId);
    if (model === undefined) {
      throw new Error(
        `Model ${modelId} is not configured for Provider profile ${providerProfileId}`,
      );
    }
    const apiKey = await this.#vault.readApiKey(providerProfileId);
    if (apiKey === undefined) {
      throw new Error(`Provider profile ${providerProfileId} has no API key`);
    }
    const fetch = this.#providerFetchFactory(options.transport);
    let outcome: ImageCapabilityProbeOutcome;
    try {
      outcome = await probeOpenAiCompatibleImage({
        baseUrl: provider.baseUrl,
        apiKey,
        provider: provider.name,
        model: model.id,
        fetch,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } finally {
      await fetch.close?.();
    }
    if (outcome === "inconclusive") return { outcome, model };
    const updated = await this.#queueProfileOperation(async () => {
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
    return this.#requireProfile().titleModel.modelId;
  }

  async titleModel(): Promise<{
    adapter: ModelAdapter | null;
    model: string;
    reasoningEffort: string;
  }> {
    await this.#profileOperations;
    const profile = this.#requireProfile();
    const titleReference = profile.titleModel;
    const provider = profile.providerProfiles.find(
      (candidate) =>
        candidate.providerProfileId === titleReference.providerProfileId,
    )!;
    const modelMetadata = provider.models.find(
      (model) => model.id === titleReference.modelId,
    )!;
    const reasoningEffort = modelMetadata.defaultReasoningEffort;
    if (reasoningEffort === null) {
      throw new Error(
        `Title model ${titleReference.modelId} from Provider profile ${provider.providerProfileId} requires a manual default reasoning effort override`,
      );
    }
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
    const apiKey = await this.#vault.readApiKey(provider.providerProfileId);
    if (apiKey === undefined)
      throw new Error(
        `Title model Provider profile ${provider.providerProfileId} has no API key`,
      );
    return {
      adapter: new OpenAiCompatibleModel({
        baseUrl: provider.baseUrl,
        apiKey,
        provider: provider.name,
        defaultParams: { temperature: 0.2, max_tokens: 40 },
      }),
      model: titleReference.modelId,
      reasoningEffort,
    };
  }

  async save(settings: ZenXSettingsUpdate, apiKey?: string): Promise<void> {
    await this.#queueProfileOperation(async () => {
      const current = this.#requireProfile();
      const validated = (
        await this.#stableWorkspaceSnapshot(
          validateHostProfile({
            ...current,
            onboardingComplete: settings.onboardingComplete,
            providerProfiles: settings.providerProfiles,
            defaultModel: settings.defaultModel,
            titleModel: settings.titleModel,
            approvalPolicy: settings.approvalPolicy,
          }),
          [],
        )
      ).profile;
      const credentialProfileId = validated.defaultModel.providerProfileId;
      for (const provider of validated.providerProfiles) {
        if (provider.type !== "openai-compatible") continue;
        const suppliedForProvider =
          provider.providerProfileId === credentialProfileId &&
          apiKey !== undefined &&
          apiKey.length > 0;
        if (
          !suppliedForProvider &&
          !(await this.#vault.hasApiKey(provider.providerProfileId))
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
  ): Promise<void> {
    await this.#queueProfileOperation(async () => {
      const current = this.#requireProfile();
      const next = validateHostProfile({
        ...current,
        providerProfiles: [...current.providerProfiles, provider],
      });
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
      if (
        provider.type === "openai-compatible" &&
        (options.apiKey === undefined || options.apiKey.length === 0) &&
        !(await this.#vault.hasApiKey(providerProfileId))
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
      const deletedProvider = current.providerProfiles.find(
        (candidate) => candidate.providerProfileId === providerProfileId,
      )!;
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
      if (deletedProvider.type === "openai-subscription") {
        await this.#subscriptionForProfile(providerProfileId).logout();
      }
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
      await this.#profileStore.write(next);
      this.#profile = next;
      return isFirst;
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
      await this.#profileStore.write(next);
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
      await this.#profileStore.write(next);
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
      await this.#profileStore.write(next);
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
      await this.#profileStore.write(next);
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
      await this.#profileStore.write(next);
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

  #queueProfileOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#profileOperations.then(operation);
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
    const affectedProfileIds = [
      ...new Set([
        ...clearCredentialProfileIds,
        ...(credential === undefined ? [] : [credential.providerProfileId]),
      ]),
    ];
    const previousApiKeys = new Map<string, string | undefined>();
    for (const providerProfileId of affectedProfileIds) {
      previousApiKeys.set(
        providerProfileId,
        await this.#vault.readApiKey(providerProfileId),
      );
    }
    try {
      for (const providerProfileId of clearCredentialProfileIds) {
        await this.#vault.clearApiKey(providerProfileId);
      }
      if (credential !== undefined) {
        await this.#vault.writeApiKey(
          credential.providerProfileId,
          credential.apiKey,
        );
      }
      await this.#profileStore.write(profile);
    } catch (persistenceError) {
      const compensationErrors: unknown[] = [];
      for (const providerProfileId of affectedProfileIds) {
        try {
          const previousApiKey = previousApiKeys.get(providerProfileId);
          if (previousApiKey === undefined)
            await this.#vault.clearApiKey(providerProfileId);
          else await this.#vault.writeApiKey(providerProfileId, previousApiKey);
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
      }
      if (compensationErrors.length > 0) {
        throw new AggregateError(
          [persistenceError, ...compensationErrors],
          "ZenX settings were partially saved: persistence failed and the previous credential state could not be restored",
        );
      }
      throw persistenceError;
    }
  }
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
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  });
}
