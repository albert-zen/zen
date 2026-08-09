import path from "node:path";

import { OpenAiSubscriptionAuthProfile } from "../../../../apps/cli/src/subscription-auth.js";
import type { ZenXHostConfig } from "./host-messages.js";
import {
  hostConfigFromProfile,
  type PublicHostSettings,
  type ZenXHostProfile,
  ZenXHostProfileStore,
  validateHostProfile,
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
  >;
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
    const legacy = resolveZenXHostConfig(environment);
    const fallback = profileFromLegacy(legacy);
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
      apiKey: await this.#vault.readApiKey(),
    });
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

function profileFromLegacy(config: ZenXHostConfig): ZenXHostProfile {
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
    models: [...(config.models ?? [config.model])],
    workspace: config.cwd,
    approvalPolicy: config.approvalPolicy,
  };
}
