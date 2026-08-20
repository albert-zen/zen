import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXCredentialVault,
  type LocalEncryption,
} from "../src/main/credential-vault.js";
import { ZenXSettingsService } from "../src/main/settings-service.js";
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

test("adds, defaults, and removes workspace entries without touching their contents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-workspaces-"));
  const firstWorkspace = path.join(directory, "first");
  const secondWorkspace = path.join(directory, "second");
  const marker = path.join(secondWorkspace, "keep-me.txt");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([
      mkdir(firstWorkspace, { recursive: true }),
      mkdir(secondWorkspace, { recursive: true }),
    ]),
  );
  await writeFile(marker, "keep");
  try {
    const service = settingsFor(directory, {
      login: async () => undefined,
      logout: async () => undefined,
      status: async () => ({ authenticated: false, expired: false }),
    });
    await service.initialize({ ZENX_CWD: firstWorkspace });
    await service.addWorkspace(secondWorkspace);
    await service.markWorkspaceUsed(secondWorkspace);
    assert.equal(
      (await service.publicSettings()).profile.lastUsedWorkspace,
      path.resolve(secondWorkspace),
    );
    assert.equal(await service.setDefaultWorkspace(secondWorkspace), true);
    assert.equal(
      (await service.publicSettings()).profile.workspace,
      path.resolve(secondWorkspace),
    );
    assert.equal(await service.removeWorkspace(secondWorkspace), true);
    assert.equal(
      (await service.publicSettings()).profile.lastUsedWorkspace,
      null,
    );
    assert.equal(await readFile(marker, "utf8"), "keep");
    assert.deepEqual((await service.publicSettings()).profile.workspaces, [
      path.resolve(firstWorkspace),
    ]);
    assert.equal(await service.removeWorkspace(firstWorkspace), true);
    assert.equal((await service.publicSettings()).profile.workspace, null);
    assert.deepEqual((await service.publicSettings()).profile.workspaces, []);
    assert.equal(await readFile(marker, "utf8"), "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("starts with no implicit Project and activates the first added workspace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-no-project-"));
  const workspace = path.join(directory, "chosen");
  try {
    const service = settingsFor(directory, {
      login: async () => undefined,
      logout: async () => undefined,
      status: async () => ({ authenticated: false, expired: false }),
    });
    await service.initialize({});
    const initial = await service.publicSettings();
    assert.equal(initial.profile.workspace, null);
    assert.deepEqual(initial.profile.workspaces, []);
    assert.equal(initial.profile.lastUsedWorkspace, null);
    assert.equal((await service.hostConfig()).cwd, path.join(directory, "zen"));
    assert.equal(await service.addWorkspace(workspace), true);
    const added = await service.publicSettings();
    assert.equal(added.profile.workspace, path.resolve(workspace));
    assert.deepEqual(added.profile.workspaces, [path.resolve(workspace)]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent workspace mutations without losing either update", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-concurrent-workspaces-"),
  );
  const firstWorkspace = path.join(directory, "first");
  const secondWorkspace = path.join(directory, "second");
  try {
    const service = settingsFor(directory, {
      login: async () => undefined,
      logout: async () => undefined,
      status: async () => ({ authenticated: false, expired: false }),
    });
    await service.initialize({});

    await Promise.all([
      service.addWorkspace(firstWorkspace),
      service.addWorkspace(secondWorkspace),
    ]);

    assert.deepEqual(
      new Set((await service.publicSettings()).profile.workspaces),
      new Set([path.resolve(firstWorkspace), path.resolve(secondWorkspace)]),
    );
    const persisted = JSON.parse(
      await readFile(path.join(directory, "host-profile.json"), "utf8"),
    ) as { workspaces: string[] };
    assert.deepEqual(
      new Set(persisted.workspaces),
      new Set([path.resolve(firstWorkspace), path.resolve(secondWorkspace)]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists profile-local pinned Thread ids across service instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-pins-"));
  const subscription = {
    login: async () => undefined,
    logout: async () => undefined,
    status: async () => ({ authenticated: false, expired: false }),
  };
  try {
    const first = settingsFor(directory, subscription);
    await first.initialize({});
    await Promise.all([
      first.setThreadPinned("thread-b", true),
      first.setThreadPinned("thread-a", true),
    ]);
    await first.setThreadPinned("thread-b", true);
    assert.deepEqual((await first.publicSettings()).profile.pinnedThreadIds, [
      "thread-b",
      "thread-a",
    ]);

    const second = settingsFor(directory, subscription);
    await second.initialize({});
    assert.deepEqual((await second.publicSettings()).profile.pinnedThreadIds, [
      "thread-b",
      "thread-a",
    ]);
    await second.setThreadPinned("thread-b", false);
    assert.deepEqual((await second.publicSettings()).profile.pinnedThreadIds, [
      "thread-a",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings save preserves pins added after its profile draft was read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-stale-pins-"));
  const subscription = {
    login: async () => undefined,
    logout: async () => undefined,
    status: async () => ({ authenticated: false, expired: false }),
  };
  try {
    const service = settingsFor(directory, subscription);
    await service.initialize({});
    const staleDraft = (await service.publicSettings()).profile;

    await service.setThreadPinned("thread-91", true);
    await service.save({ ...staleDraft, onboardingComplete: true });

    const saved = (await service.publicSettings()).profile;
    assert.equal(saved.onboardingComplete, true);
    assert.deepEqual(saved.pinnedThreadIds, ["thread-91"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "POSIX symlink aliases drive add, mark-used, default, and remove by one canonical key",
  { skip: process.platform === "win32" },
  async () => await exerciseAliasWorkspaceMutations("dir"),
);

test(
  "Windows junction aliases drive add, mark-used, default, and remove by one canonical key",
  { skip: process.platform !== "win32" },
  async () => await exerciseAliasWorkspaceMutations("junction"),
);

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
    status: async () => ({ authenticated: false, expired: false }),
  };
  try {
    const service = settingsFor(directory, subscription);
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

async function exerciseAliasWorkspaceMutations(
  type: "dir" | "junction",
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-alias-"),
  );
  const physical = path.join(directory, "physical");
  const alias = path.join(directory, "alias");
  const other = path.join(directory, "other");
  const marker = path.join(physical, "keep-me.txt");
  try {
    await Promise.all([mkdir(physical), mkdir(other)]);
    await symlink(physical, alias, type);
    await writeFile(marker, "keep");
    const service = settingsFor(directory, {
      login: async () => undefined,
      logout: async () => undefined,
      status: async () => ({ authenticated: false, expired: false }),
    });
    await service.initialize({ ZENX_CWD: physical });

    assert.equal(await service.addWorkspace(alias), false);
    await service.addWorkspace(other);
    assert.equal(await service.setDefaultWorkspace(other), true);
    await service.markWorkspaceUsed(alias);
    let profile = (await service.publicSettings()).profile;
    assert.equal(profile.lastUsedWorkspace, path.resolve(physical));
    assert.equal(await service.setDefaultWorkspace(alias), true);
    profile = (await service.publicSettings()).profile;
    assert.equal(profile.workspace, path.resolve(physical));

    assert.equal(await service.removeWorkspace(alias), true);
    profile = (await service.publicSettings()).profile;
    assert.deepEqual(profile.workspaces, [path.resolve(other)]);
    assert.equal(profile.workspace, path.resolve(other));
    assert.equal(profile.lastUsedWorkspace, null);
    assert.equal(await readFile(marker, "utf8"), "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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
    status: async () => ({ authenticated: false, expired: false }),
  };
  try {
    const service = settingsFor(directory, subscription);
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
    status: async () => ({ authenticated: false, expired: false }),
  };
  try {
    const service = settingsFor(directory, subscription);
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

function settingsFor(
  directory: string,
  subscription: Pick<
    OpenAiSubscriptionAuthProfile,
    "login" | "logout" | "status"
  >,
): ZenXSettingsService {
  return new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    vault: new ZenXCredentialVault(
      path.join(directory, "credentials.vault"),
      encryption,
    ),
    subscription,
  });
}
