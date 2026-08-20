import path from "node:path";

import { OpenAiSubscriptionAuthProfile } from "../../../../apps/cli/src/subscription-auth.js";
import type { ModelAdapter } from "../../../../src/model.js";
import { OpenAiCompatibleModel } from "../../../../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../../../../src/model/openai-subscription.js";
import type { ZenXHostConfig } from "./host-messages.js";
import {
  hostConfigFromProfile,
  type PublicHostSettings,
  type ZenXHostProfile,
  ZenXHostProfileStore,
  type ZenXSettingsUpdate,
  validateHostProfile,
} from "./host-profile.js";
import { ZenXCredentialVault } from "./credential-vault.js";
import { resolveZenXHostConfig } from "./host-config.js";
import { projectPathKey } from "./project-projection.js";

export class ZenXSettingsService {
  readonly #dataDirectory: string;
  readonly #profilePath: string;
  readonly #profileStore: ZenXHostProfileStore;
  readonly #subscription: Pick<
    OpenAiSubscriptionAuthProfile,
    "login" | "logout" | "status"
  > &
    Partial<Pick<OpenAiSubscriptionAuthProfile, "acquireAccessLease">>;
  readonly #vault: ZenXCredentialVault;
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
    subscription?: Pick<
      OpenAiSubscriptionAuthProfile,
      "login" | "logout" | "status"
    >;
  }) {
    this.#dataDirectory = options.zenDataDirectory;
    this.#profilePath = path.join(
      options.userDataDirectory,
      "openai-subscription-auth.json",
    );
    this.#profileStore =
      options.profileStore ??
      new ZenXHostProfileStore(
        path.join(options.userDataDirectory, "host-profile.json"),
      );
    this.#subscription =
      options.subscription ??
      new OpenAiSubscriptionAuthProfile(this.#profilePath);
    this.#vault = options.vault;
  }

  async initialize(environment: NodeJS.ProcessEnv): Promise<void> {
    await this.#queueProfileOperation(async () => {
      const existing = await this.#profileStore.readOptional();
      if (existing !== undefined) {
        this.#profile = await normalizeCanonicalWorkspaces(existing);
        return;
      }
      const configureWorkspace = environment.ZENX_CWD !== undefined;
      const legacy = resolveZenXHostConfig(environment);
      const fallback = await normalizeCanonicalWorkspaces(
        profileFromLegacy(legacy, configureWorkspace),
      );
      await this.#persistProfile(
        fallback,
        legacy.provider.type === "openai-compatible"
          ? legacy.provider.apiKey
          : undefined,
      );
      this.#profile = fallback;
    });
  }

  async publicSettings(): Promise<PublicHostSettings> {
    const profile = this.#requireProfile();
    return {
      profile,
      hasApiKey: await this.#vault.hasApiKey(),
      subscription: await this.#subscription.status(),
    };
  }

  async hostConfig(): Promise<ZenXHostConfig> {
    const profile = this.#requireProfile();
    return hostConfigFromProfile(profile, {
      dataDirectory: this.#dataDirectory,
      subscriptionProfilePath: this.#profilePath,
      fallbackWorkspace: this.#dataDirectory,
      apiKey: await this.#vault.readApiKey(),
    });
  }

  configuredTitleModel(): string {
    return this.#requireProfile().titleModel;
  }

  async titleModel(): Promise<{ adapter: ModelAdapter | null; model: string }> {
    const profile = this.#requireProfile();
    if (profile.provider.type === "fake") {
      return { adapter: null, model: profile.titleModel };
    }
    if (profile.provider.type === "openai-subscription") {
      const acquireAccessLease = this.#subscription.acquireAccessLease;
      if (acquireAccessLease === undefined) {
        throw new Error("Title model subscription is unavailable");
      }
      return {
        adapter: new OpenAiSubscriptionModel({
          acquireAccessLease: async (signal) =>
            await acquireAccessLease.call(this.#subscription, signal),
          instructions:
            "Return only a concise display title of at most 64 characters. Do not include quotes, IDs, labels, or punctuation boilerplate.",
        }),
        model: profile.titleModel,
      };
    }
    const apiKey = await this.#vault.readApiKey();
    if (apiKey === undefined)
      throw new Error("Title model provider has no API key");
    return {
      adapter: new OpenAiCompatibleModel({
        baseUrl: profile.provider.baseUrl,
        apiKey,
        provider: profile.provider.name,
        defaultParams: { temperature: 0.2, max_tokens: 40 },
      }),
      model: profile.titleModel,
    };
  }

  async save(settings: ZenXSettingsUpdate, apiKey?: string): Promise<void> {
    await this.#queueProfileOperation(async () => {
      const current = this.#requireProfile();
      const validated = await normalizeCanonicalWorkspaces(
        validateHostProfile({
          ...current,
          onboardingComplete: settings.onboardingComplete,
          provider: settings.provider,
          defaultModel: settings.defaultModel,
          titleModel: settings.titleModel,
          models: settings.models,
          approvalPolicy: settings.approvalPolicy,
        }),
      );
      if (
        validated.provider.type === "openai-compatible" &&
        !(apiKey !== undefined && apiKey.length > 0) &&
        !(await this.#vault.hasApiKey())
      ) {
        throw new Error("Add an API key before activating this provider");
      }
      await this.#persistProfile(validated, apiKey);
      this.#profile = validated;
    });
  }

  async addWorkspace(workspace: string): Promise<boolean> {
    const candidate = workspace.trim();
    if (candidate.length === 0) throw new Error("Workspace is required");
    const resolved = path.resolve(candidate);
    return await this.#queueProfileOperation(async () => {
      const current = await normalizeCanonicalWorkspaces(
        this.#requireProfile(),
      );
      const candidateKey = await projectPathKey(resolved);
      const entries = await canonicalWorkspaceEntries(current.workspaces);
      if (entries.some((entry) => entry.key === candidateKey)) return false;
      const isFirst = current.workspace === null;
      const next = await normalizeCanonicalWorkspaces(
        validateHostProfile({
          ...current,
          workspace: isFirst ? resolved : current.workspace,
          workspaces: [...current.workspaces, resolved],
        }),
      );
      await this.#profileStore.write(next);
      this.#profile = next;
      return isFirst;
    });
  }

  async removeWorkspace(workspace: string): Promise<boolean> {
    const key = await projectPathKey(workspace);
    return await this.#queueProfileOperation(async () => {
      const current = await normalizeCanonicalWorkspaces(
        this.#requireProfile(),
      );
      const entries = await canonicalWorkspaceEntries(current.workspaces);
      const nextWorkspaces = entries
        .filter((entry) => entry.key !== key)
        .map((entry) => entry.workspace);
      if (nextWorkspaces.length === current.workspaces.length) return false;
      const defaultRemoved =
        current.workspace !== null &&
        (await projectPathKey(current.workspace)) === key;
      const next = await normalizeCanonicalWorkspaces(
        validateHostProfile({
          ...current,
          workspace: defaultRemoved
            ? (nextWorkspaces[0] ?? null)
            : current.workspace,
          workspaces: nextWorkspaces,
        }),
      );
      await this.#profileStore.write(next);
      this.#profile = next;
      return defaultRemoved;
    });
  }

  async setDefaultWorkspace(workspace: string): Promise<boolean> {
    const key = await projectPathKey(workspace);
    return await this.#queueProfileOperation(async () => {
      const current = await normalizeCanonicalWorkspaces(
        this.#requireProfile(),
      );
      const selected = (
        await canonicalWorkspaceEntries(current.workspaces)
      ).find((entry) => entry.key === key)?.workspace;
      if (selected === undefined)
        throw new Error("Workspace is not configured");
      if (
        current.workspace !== null &&
        (await projectPathKey(current.workspace)) === key
      )
        return false;
      const next = await normalizeCanonicalWorkspaces(
        validateHostProfile({ ...current, workspace: selected }),
      );
      await this.#profileStore.write(next);
      this.#profile = next;
      return true;
    });
  }

  async markWorkspaceUsed(workspace: string): Promise<void> {
    const key = await projectPathKey(workspace);
    await this.#queueProfileOperation(async () => {
      const current = await normalizeCanonicalWorkspaces(
        this.#requireProfile(),
      );
      const selected = (
        await canonicalWorkspaceEntries(current.workspaces)
      ).find((entry) => entry.key === key)?.workspace;
      if (selected === undefined)
        throw new Error("Workspace is not configured");
      if (
        current.lastUsedWorkspace !== null &&
        (await projectPathKey(current.lastUsedWorkspace)) === key
      )
        return;
      const next = await normalizeCanonicalWorkspaces(
        validateHostProfile({
          ...current,
          lastUsedWorkspace: selected,
        }),
      );
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
      await this.#subscription.login({
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
    await this.#subscription.logout();
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

  async #persistProfile(
    profile: ZenXHostProfile,
    apiKey?: string,
  ): Promise<void> {
    const rotatesCredential = apiKey !== undefined && apiKey.length > 0;
    const previousApiKey = rotatesCredential
      ? await this.#vault.readApiKey()
      : undefined;
    if (rotatesCredential) await this.#vault.writeApiKey(apiKey);
    try {
      await this.#profileStore.write(profile);
    } catch (persistenceError) {
      if (!rotatesCredential) throw persistenceError;
      try {
        if (previousApiKey === undefined) await this.#vault.clearApiKey();
        else await this.#vault.writeApiKey(previousApiKey);
      } catch (compensationError) {
        throw new AggregateError(
          [persistenceError, compensationError],
          "ZenX settings were partially saved: host profile persistence failed and the previous credential could not be restored",
        );
      }
      throw persistenceError;
    }
  }
}

async function normalizeCanonicalWorkspaces(
  profile: ZenXHostProfile,
): Promise<ZenXHostProfile> {
  const candidates =
    profile.workspace === null
      ? profile.workspaces
      : [profile.workspace, ...profile.workspaces];
  const unique = new Map<string, string>();
  for (const entry of await canonicalWorkspaceEntries(candidates)) {
    if (!unique.has(entry.key)) unique.set(entry.key, entry.workspace);
  }
  const defaultKey =
    profile.workspace === null ? null : await projectPathKey(profile.workspace);
  const lastUsedKey =
    profile.lastUsedWorkspace === null
      ? null
      : await projectPathKey(profile.lastUsedWorkspace);
  return {
    ...profile,
    workspace: defaultKey === null ? null : (unique.get(defaultKey) ?? null),
    workspaces: [...unique.values()],
    lastUsedWorkspace:
      lastUsedKey === null ? null : (unique.get(lastUsedKey) ?? null),
  };
}

async function canonicalWorkspaceEntries(
  workspaces: readonly string[],
): Promise<Array<{ workspace: string; key: string }>> {
  return await Promise.all(
    workspaces.map(async (workspace) => ({
      workspace: path.resolve(workspace),
      key: await projectPathKey(workspace),
    })),
  );
}

function profileFromLegacy(
  config: ZenXHostConfig,
  configureWorkspace: boolean,
): ZenXHostProfile {
  const provider =
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
  return {
    version: 1,
    onboardingComplete: false,
    provider,
    defaultModel: config.model,
    titleModel: "gpt-5.6-luna",
    models: [...(config.models ?? [config.model])],
    workspace: configureWorkspace ? config.cwd : null,
    workspaces: configureWorkspace ? [config.cwd] : [],
    lastUsedWorkspace: null,
    approvalPolicy: config.approvalPolicy,
  };
}
