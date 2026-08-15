import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXCredentialVault,
  type LocalEncryption,
} from "../src/main/credential-vault.js";
import {
  resolveSafeWorkspace,
  ZenXSettingsService,
} from "../src/main/settings-service.js";
import type { OpenAiSubscriptionAuthProfile } from "../../cli/src/subscription-auth.js";

const encryption: LocalEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`secure:${value}`),
  decryptString: (value) => value.toString().replace(/^secure:/u, ""),
};

test("migrates legacy environment config once without persisting or inheriting its key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-settings-"));
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const first = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    vault,
  });
  const environment: NodeJS.ProcessEnv = {
    ZENX_PROVIDER: "openai-compatible",
    ZENX_API_KEY_ENV: "MIGRATION_KEY",
    MIGRATION_KEY: "migration-secret",
    ZENX_BASE_URL: "https://models.example.test/v1",
    ZENX_PROVIDER_NAME: "example",
    ZENX_MODEL: "model-a",
    ZENX_MODELS: "model-a,model-b",
    ZENX_CWD: directory,
  };
  try {
    await first.initialize(environment);
    assert.equal(environment.MIGRATION_KEY, undefined);
    assert.equal(await vault.readApiKey(), "migration-secret");
    assert.doesNotMatch(
      await readFile(path.join(directory, "host-profile.json"), "utf8"),
      /migration-secret/u,
    );

    const second = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault,
    });
    await second.initialize({ ZENX_PROVIDER: "openai-compatible" });
    assert.equal(
      (await second.publicSettings()).profile.defaultModel,
      "model-a",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clears the OAuth concurrency guard after failure so login can retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-oauth-retry-"));
  let attempts = 0;
  const subscription: Pick<
    OpenAiSubscriptionAuthProfile,
    "login" | "logout" | "status"
  > = {
    login: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("token exchange failed");
    },
    logout: async () => undefined,
    status: async () => ({ authenticated: true, expired: false }),
  };
  try {
    const service = await settingsFor(directory, subscription);
    await assert.rejects(
      async () =>
        await service.login(
          () => undefined,
          () => undefined,
        ),
      /token exchange failed/u,
    );
    await service.login(
      () => undefined,
      () => undefined,
    );
    assert.equal(attempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans an aborted manual OAuth wait and accepts a later login", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-oauth-abort-"));
  let attempts = 0;
  const subscription: Pick<
    OpenAiSubscriptionAuthProfile,
    "login" | "logout" | "status"
  > = {
    login: async (interaction) => {
      attempts += 1;
      if (attempts !== 1) return;
      const controller = new AbortController();
      const manual = interaction.readManualCode({
        message: "code",
        signal: controller.signal,
      });
      controller.abort();
      await manual;
    },
    logout: async () => undefined,
    status: async () => ({ authenticated: true, expired: false }),
  };
  try {
    const service = await settingsFor(directory, subscription);
    await assert.rejects(
      async () =>
        await service.login(
          () => undefined,
          () => undefined,
        ),
      /cancelled/u,
    );
    assert.throws(
      () => service.submitManualCode("stale"),
      /No OpenAI login is waiting/u,
    );
    await service.login(
      () => undefined,
      () => undefined,
    );
    assert.equal(attempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects concurrent OAuth login while allowing manual completion", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-oauth-concurrent-"),
  );
  let manualRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    manualRequested = resolve;
  });
  let attempts = 0;
  const subscription: Pick<
    OpenAiSubscriptionAuthProfile,
    "login" | "logout" | "status"
  > = {
    login: async (interaction) => {
      attempts += 1;
      if (attempts > 1) return;
      const code = await interaction.readManualCode({
        message: "code",
        signal: new AbortController().signal,
      });
      assert.equal(code, "manual-code");
    },
    logout: async () => undefined,
    status: async () => ({ authenticated: true, expired: false }),
  };
  try {
    const service = await settingsFor(directory, subscription);
    const first = service.login(() => undefined, manualRequested);
    await requested;
    await assert.rejects(
      async () =>
        await service.login(
          () => undefined,
          () => undefined,
        ),
      /already in progress/u,
    );
    service.submitManualCode("manual-code");
    await first;
    await service.login(
      () => undefined,
      () => undefined,
    );
    assert.equal(attempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful subscription login activates the real catalog atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-login-apply-"));
  const subscription: Pick<
    OpenAiSubscriptionAuthProfile,
    "login" | "logout" | "status"
  > = {
    login: async () => undefined,
    logout: async () => undefined,
    status: async () => ({
      authenticated: true,
      expired: false,
      accountId: "account-1",
    }),
  };
  try {
    const service = await settingsFor(directory, subscription);
    await service.login(
      () => undefined,
      () => undefined,
    );

    const settings = await service.publicSettings();
    assert.equal(settings.profile.onboardingComplete, true);
    assert.deepEqual(settings.profile.provider, {
      type: "openai-subscription",
      displayName: "OpenAI subscription",
    });
    assert.equal(settings.profile.defaultModel, "gpt-5.6-terra");
    assert.equal(settings.profile.titleModel, "gpt-5.6-terra");
    assert.deepEqual(settings.profile.models, ["gpt-5.6-terra", "gpt-5.6-sol"]);
    assert.equal(settings.subscription.accountId, "account-1");

    const persisted = JSON.parse(
      await readFile(path.join(directory, "host-profile.json"), "utf8"),
    ) as { provider: { type: string }; defaultModel: string };
    assert.equal(persisted.provider.type, "openai-subscription");
    assert.equal(persisted.defaultModel, "gpt-5.6-terra");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a login result that is not authenticated without changing provider", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-login-status-"));
  const subscription: Pick<
    OpenAiSubscriptionAuthProfile,
    "login" | "logout" | "status"
  > = {
    login: async () => undefined,
    logout: async () => undefined,
    status: async () => ({ authenticated: false, expired: false }),
  };
  try {
    const service = await settingsFor(directory, subscription);
    await assert.rejects(
      service.login(
        () => undefined,
        () => undefined,
      ),
      /without an authenticated account/u,
    );
    assert.equal(
      (await service.publicSettings()).profile.provider.type,
      "fake",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unauthenticated subscription apply without changing onboarding or provider", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-save-status-"));
  const subscription: Pick<
    OpenAiSubscriptionAuthProfile,
    "login" | "logout" | "status"
  > = {
    login: async () => undefined,
    logout: async () => undefined,
    status: async () => ({ authenticated: false, expired: false }),
  };
  try {
    const service = await settingsFor(directory, subscription);
    const before = (await service.publicSettings()).profile;
    await assert.rejects(
      service.save({
        ...before,
        onboardingComplete: true,
        provider: {
          type: "openai-subscription",
          displayName: "OpenAI subscription",
        },
        defaultModel: "gpt-5.6-terra",
        titleModel: "gpt-5.6-terra",
        models: ["gpt-5.6-terra", "gpt-5.6-sol"],
      }),
      /Sign in with OpenAI/u,
    );
    const after = (await service.publicSettings()).profile;
    assert.deepEqual(after, before);
    assert.equal(after.onboardingComplete, false);
    assert.equal(after.provider.type, "fake");
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(directory, "host-profile.json"), "utf8"),
      ),
      before,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies an API provider profile and exposes its catalog to the Host", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-api-apply-"));
  try {
    const service = settingsForWithoutSubscription(directory);
    await service.initialize({ ZENX_CWD: directory });
    const current = (await service.publicSettings()).profile;
    await service.save(
      {
        ...current,
        onboardingComplete: true,
        provider: {
          type: "openai-compatible",
          name: "openai",
          displayName: "OpenAI API",
          baseUrl: "https://api.openai.com/v1",
        },
        defaultModel: "gpt-5.6-terra",
        titleModel: "gpt-5.6-terra",
        models: ["gpt-5.6-terra", "gpt-5.6-sol"],
      },
      "api-secret",
    );

    const host = await service.hostConfig();
    assert.equal(host.provider.type, "openai-compatible");
    assert.equal(host.model, "gpt-5.6-terra");
    assert.deepEqual(host.models, ["gpt-5.6-terra", "gpt-5.6-sol"]);
    if (host.provider.type === "openai-compatible") {
      assert.equal(host.provider.apiKey, "api-secret");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace mutations preserve directories and report host restart needs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-workspaces-"));
  const firstWorkspace = path.join(directory, "first");
  const secondWorkspace = path.join(directory, "second");
  try {
    await mkdir(secondWorkspace, { recursive: true });
    const marker = path.join(secondWorkspace, "keep.txt");
    await writeFile(marker, "keep", "utf8");
    const service = settingsForWithoutSubscription(directory);
    await service.initialize({ ZENX_CWD: firstWorkspace });

    await assert.rejects(service.addWorkspace("   "), /Workspace is required/u);
    await service.addWorkspace(secondWorkspace);
    await service.addWorkspace(secondWorkspace);
    assert.deepEqual((await service.publicSettings()).profile.workspaces, [
      path.resolve(firstWorkspace),
      path.resolve(secondWorkspace),
    ]);

    assert.equal(await service.setDefaultWorkspace(secondWorkspace), true);
    assert.equal(await service.setDefaultWorkspace(secondWorkspace), false);
    assert.equal(await service.removeWorkspace(secondWorkspace), true);
    const profile = (await service.publicSettings()).profile;
    assert.equal(profile.workspace, path.resolve(firstWorkspace));
    assert.deepEqual(profile.workspaces, [path.resolve(firstWorkspace)]);
    assert.equal(await readFile(marker, "utf8"), "keep");
    await assert.rejects(
      service.removeWorkspace(firstWorkspace),
      /Keep at least one workspace/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe first-launch workspace selection uses the first explicit candidate", () => {
  const documents = path.join("D:\\Users\\person", "Documents");
  const home = path.join("D:\\Users", "person");
  assert.equal(
    resolveSafeWorkspace([documents, home]),
    path.resolve(documents),
  );
  assert.throws(
    () => resolveSafeWorkspace([]),
    /No safe workspace is available/u,
  );
});

async function settingsFor(
  directory: string,
  subscription: Pick<
    OpenAiSubscriptionAuthProfile,
    "login" | "logout" | "status"
  >,
): Promise<ZenXSettingsService> {
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    vault: new ZenXCredentialVault(
      path.join(directory, "credentials.vault"),
      encryption,
    ),
    subscription,
  });
  await service.initialize({ ZENX_PROVIDER: "fake", ZENX_CWD: directory });
  return service;
}

function settingsForWithoutSubscription(
  directory: string,
): ZenXSettingsService {
  return new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    vault: new ZenXCredentialVault(
      path.join(directory, "credentials.vault"),
      encryption,
    ),
  });
}
