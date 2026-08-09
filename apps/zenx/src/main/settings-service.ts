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
  readonly #subscription: OpenAiSubscriptionAuthProfile;
  readonly #vault: ZenXCredentialVault;
  #profile: ZenXHostProfile | undefined;
  #manualCode: ((value: string) => void) | undefined;

  constructor(options: {
    userDataDirectory: string;
    zenDataDirectory: string;
    vault: ZenXCredentialVault;
  }) {
    this.#dataDirectory = options.zenDataDirectory;
    this.#profilePath = path.join(
      options.userDataDirectory,
      "openai-subscription-auth.json",
    );
    this.#profileStore = new ZenXHostProfileStore(
      path.join(options.userDataDirectory, "host-profile.json"),
    );
    this.#subscription = new OpenAiSubscriptionAuthProfile(this.#profilePath);
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
    if (this.#manualCode !== undefined)
      throw new Error("OpenAI login is already in progress");
    await this.#subscription.login({
      notifyAuthUrl: openBrowser,
      readManualCode: async ({ signal }) =>
        await new Promise<string>((resolve, reject) => {
          const aborted = () => reject(new Error("OpenAI login was cancelled"));
          signal.addEventListener("abort", aborted, { once: true });
          this.#manualCode = (value) => {
            signal.removeEventListener("abort", aborted);
            this.#manualCode = undefined;
            resolve(value);
          };
          manualCodeRequested();
        }),
    });
    this.#manualCode = undefined;
  }

  submitManualCode(value: string): void {
    const resolve = this.#manualCode;
    if (resolve === undefined)
      throw new Error("No OpenAI login is waiting for a code");
    resolve(value);
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
