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
  validateHostProfile,
  workspaceKey,
} from "./host-profile.js";
import { ZenXCredentialVault } from "./credential-vault.js";
import { resolveZenXHostConfig } from "./host-config.js";

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
    this.#profileStore = new ZenXHostProfileStore(
      path.join(options.userDataDirectory, "host-profile.json"),
    );
    this.#subscription =
      options.subscription ??
      new OpenAiSubscriptionAuthProfile(this.#profilePath);
    this.#vault = options.vault;
  }

  async initialize(environment: NodeJS.ProcessEnv): Promise<void> {
    const existing = await this.#profileStore.readOptional();
    if (existing !== undefined) {
      this.#profile = existing;
      return;
    }
    const configureWorkspace = environment.ZENX_CWD !== undefined;
    const legacy = resolveZenXHostConfig(environment);
    for (const variable of legacy.secretEnvironmentVariables ?? []) {
      delete environment[variable];
    }
    const fallback = profileFromLegacy(legacy, configureWorkspace);
    if (legacy.provider.type === "openai-compatible") {
      await this.#vault.writeApiKey(legacy.provider.apiKey);
    }
    this.#profile = fallback;
    await this.#profileStore.write(this.#profile);
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

  async save(profile: ZenXHostProfile, apiKey?: string): Promise<void> {
    const validated = validateHostProfile(profile);
    if (apiKey !== undefined && apiKey.length > 0)
      await this.#vault.writeApiKey(apiKey);
    if (
      validated.provider.type === "openai-compatible" &&
      !(await this.#vault.hasApiKey())
    ) {
      throw new Error("Add an API key before activating this provider");
    }
    await this.#profileStore.write(validated);
    this.#profile = validated;
  }

  async addWorkspace(workspace: string): Promise<boolean> {
    const current = this.#requireProfile();
    const candidate = workspace.trim();
    if (candidate.length === 0) throw new Error("Workspace is required");
    const resolved = path.resolve(candidate);
    if (
      current.workspaces.some(
        (entry) => workspaceKey(entry) === workspaceKey(resolved),
      )
    )
      return false;
    const isFirst = current.workspace === null;
    const next = validateHostProfile({
      ...current,
      workspace: isFirst ? resolved : current.workspace,
      workspaces: [...current.workspaces, resolved],
    });
    await this.#profileStore.write(next);
    this.#profile = next;
    return isFirst;
  }

  async removeWorkspace(workspace: string): Promise<boolean> {
    const current = this.#requireProfile();
    const key = workspaceKey(workspace);
    const nextWorkspaces = current.workspaces.filter(
      (entry) => workspaceKey(entry) !== key,
    );
    if (nextWorkspaces.length === current.workspaces.length) return false;
    const defaultRemoved =
      current.workspace !== null && workspaceKey(current.workspace) === key;
    const next = validateHostProfile({
      ...current,
      workspace: defaultRemoved
        ? (nextWorkspaces[0] ?? null)
        : current.workspace,
      workspaces: nextWorkspaces,
    });
    await this.#profileStore.write(next);
    this.#profile = next;
    return defaultRemoved;
  }

  async setDefaultWorkspace(workspace: string): Promise<boolean> {
    const current = this.#requireProfile();
    const key = workspaceKey(workspace);
    const selected = current.workspaces.find(
      (entry) => workspaceKey(entry) === key,
    );
    if (selected === undefined) throw new Error("Workspace is not configured");
    if (
      current.workspace !== null &&
      workspaceKey(selected) === workspaceKey(current.workspace)
    )
      return false;
    const next = validateHostProfile({ ...current, workspace: selected });
    await this.#profileStore.write(next);
    this.#profile = next;
    return true;
  }

  async markWorkspaceUsed(workspace: string): Promise<void> {
    const current = this.#requireProfile();
    const key = workspaceKey(workspace);
    const selected = current.workspaces.find(
      (entry) => workspaceKey(entry) === key,
    );
    if (selected === undefined) throw new Error("Workspace is not configured");
    if (
      current.lastUsedWorkspace !== null &&
      workspaceKey(current.lastUsedWorkspace) === key
    )
      return;
    const next = validateHostProfile({
      ...current,
      lastUsedWorkspace: selected,
    });
    await this.#profileStore.write(next);
    this.#profile = next;
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
