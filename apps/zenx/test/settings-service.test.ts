import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXCredentialVault,
  type LocalEncryption,
} from "../src/main/credential-vault.js";
import {
  structuredLegacyModelCatalog,
  type ZenXHostProfile,
  ZenXHostProfileStore,
} from "../src/main/host-profile.js";
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
    assert.equal(await vault.readApiKey("example"), "migration-secret");
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
      (await second.publicSettings()).profile.defaultModel.modelId,
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

test("persists Sidebar Project and per-Project Thread order across reload", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-sidebar-order-"),
  );
  try {
    const first = settingsFor(directory, inactiveSubscription());
    await first.initialize({});
    await first.setSidebarOrder({
      projectKeys: ["/work/b", "/work/a"],
      threadIdsByProject: {
        "/work/a": ["thread-2", "thread-1"],
      },
    });

    const reloaded = settingsFor(directory, inactiveSubscription());
    await reloaded.initialize({});
    assert.deepEqual((await reloaded.publicSettings()).profile.sidebarOrder, {
      projectKeys: ["/work/b", "/work/a"],
      threadIdsByProject: {
        "/work/a": ["thread-2", "thread-1"],
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes repeated Sidebar reorders so the latest invocation wins", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-sidebar-order-latest-"),
  );
  const initial = settingsFor(directory, inactiveSubscription());
  await initial.initialize({});
  const store = new InverseCompletionProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    profileStore: store,
    vault: new ZenXCredentialVault(
      path.join(directory, "credentials.vault"),
      encryption,
    ),
  });
  try {
    await service.initialize({});
    const first = service.setSidebarOrder({
      projectKeys: ["first", "second"],
      threadIdsByProject: {},
    });
    await store.firstWriteStarted;
    const second = service.setSidebarOrder({
      projectKeys: ["second", "first"],
      threadIdsByProject: { first: ["thread-b", "thread-a"] },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.writeCalls, 1);
    store.releaseFirstWrite();
    await Promise.all([first, second]);

    const expected = {
      projectKeys: ["second", "first"],
      threadIdsByProject: { first: ["thread-b", "thread-a"] },
    };
    assert.deepEqual(
      (await service.publicSettings()).profile.sidebarOrder,
      expected,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(directory, "host-profile.json"), "utf8"),
      ).sidebarOrder,
      expected,
    );
  } finally {
    store.releaseFirstWrite();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps inverse-completing initialize and save writes in invocation order", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-inverse-profile-writes-"),
  );
  const store = new InverseCompletionProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    profileStore: store,
    vault: new ZenXCredentialVault(
      path.join(directory, "credentials.vault"),
      encryption,
    ),
  });
  try {
    const initialization = service.initialize({ ZENX_PROVIDER: "fake" });
    await store.firstWriteStarted;
    const saved = fakeProfile("saved-model");
    const save = service.save(saved);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const writesBeforeRelease = store.writeCalls;
    store.releaseFirstWrite();
    const results = await Promise.allSettled([initialization, save]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );

    assert.equal(writesBeforeRelease, 1);
    assert.equal(
      (await service.publicSettings()).profile.defaultModel.modelId,
      "saved-model",
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(directory, "host-profile.json"), "utf8"),
      ).defaultModel.modelId,
      "saved-model",
    );
  } finally {
    store.releaseFirstWrite();
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes initialize followed by save across vault and profile persistence", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-initialize-save-"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    vault,
  });
  try {
    const initialization = service.initialize(compatibleEnvironment("first"));
    const save = service.save(compatibleProfile("second"), "second-key");

    const results = await Promise.allSettled([initialization, save]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );

    assert.equal(await vault.readApiKey("second"), "second-key");
    assert.equal(
      (await service.publicSettings()).profile.defaultModel.modelId,
      "second-model",
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(directory, "host-profile.json"), "utf8"),
      ).defaultModel.modelId,
      "second-model",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent initialize calls so the first migration remains authoritative", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-initialize-initialize-"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    vault,
  });
  try {
    const results = await Promise.allSettled([
      service.initialize(compatibleEnvironment("first")),
      service.initialize(compatibleEnvironment("second")),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );

    assert.equal(await vault.readApiKey("first"), "first-key");
    assert.equal(
      (await service.publicSettings()).profile.defaultModel.modelId,
      "first-model",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("merges stale Settings fields without overwriting a newer Project mutation", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-stale-settings-"),
  );
  const workspace = path.join(directory, "project");
  try {
    const service = settingsFor(directory, inactiveSubscription());
    await service.initialize({});
    const stale = (await service.publicSettings()).profile;
    await service.addWorkspace(workspace);
    await service.setSidebarOrder({
      projectKeys: ["newest-project", "older-project"],
      threadIdsByProject: { "newest-project": ["thread-2", "thread-1"] },
    });

    await service.save({
      ...stale,
      providerProfiles: stale.providerProfiles.map((provider) => ({
        ...provider,
        models: structuredLegacyModelCatalog(provider.type, ["saved-model"]),
      })),
      defaultModel: {
        providerProfileId: stale.defaultModel.providerProfileId,
        modelId: "saved-model",
      },
      titleModel: {
        providerProfileId: stale.defaultModel.providerProfileId,
        modelId: "saved-model",
      },
    });

    const profile = (await service.publicSettings()).profile;
    assert.equal(profile.defaultModel.modelId, "saved-model");
    assert.equal(profile.workspace, path.resolve(workspace));
    assert.deepEqual(profile.workspaces, [path.resolve(workspace)]);
    assert.deepEqual(profile.sidebarOrder, {
      projectKeys: ["newest-project", "older-project"],
      threadIdsByProject: { "newest-project": ["thread-2", "thread-1"] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists and clears the optional maximum tool round setting", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-tool-round-settings-"),
  );
  try {
    const service = settingsFor(directory, inactiveSubscription());
    await service.initialize({});
    const initial = (await service.publicSettings()).profile;
    assert.equal(initial.maxToolRounds, undefined);

    await service.save({ ...initial, maxToolRounds: 12 });
    assert.equal((await service.publicSettings()).profile.maxToolRounds, 12);
    assert.equal((await service.hostConfig()).maxToolRounds, 12);

    const restarted = settingsFor(directory, inactiveSubscription());
    await restarted.initialize({});
    const persisted = (await restarted.publicSettings()).profile;
    assert.equal(persisted.maxToolRounds, 12);

    const unlimited = { ...persisted };
    delete unlimited.maxToolRounds;
    await restarted.save(unlimited);
    assert.equal(
      (await restarted.publicSettings()).profile.maxToolRounds,
      undefined,
    );
    assert.equal((await restarted.hostConfig()).maxToolRounds, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists explicit foreground computer consent across restart and allows revocation", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-foreground-setting-"),
  );
  try {
    const service = settingsFor(directory, inactiveSubscription());
    await service.initialize({});
    const initial = (await service.publicSettings()).profile;
    assert.equal(initial.computerForegroundControlEnabled, false);

    await service.save({
      ...initial,
      computerForegroundControlEnabled: true,
    });
    const restarted = settingsFor(directory, inactiveSubscription());
    await restarted.initialize({});
    const persisted = (await restarted.publicSettings()).profile;
    assert.equal(persisted.computerForegroundControlEnabled, true);

    await restarted.save({
      ...persisted,
      computerForegroundControlEnabled: false,
    });
    const revoked = settingsFor(directory, inactiveSubscription());
    await revoked.initialize({});
    assert.equal(
      (await revoked.publicSettings()).profile.computerForegroundControlEnabled,
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores the previous credential when profile persistence fails", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-persistence-failure-"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    vault,
  });
  try {
    await service.initialize(compatibleEnvironment("first"));
    const before = (await service.publicSettings()).profile;
    const profilePath = path.join(directory, "host-profile.json");
    await rm(profilePath);
    await mkdir(profilePath);

    await assert.rejects(
      service.save(compatibleProfile("second"), "second-key"),
    );

    assert.deepEqual((await service.publicSettings()).profile, before);
    assert.equal(await vault.readApiKey("first"), "first-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports an explicit partial save when credential compensation fails", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-credential-compensation-failure-"),
  );
  const vault = new FailingCompensationVault(
    path.join(directory, "credentials.vault"),
  );
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    vault,
  });
  try {
    await service.initialize(compatibleEnvironment("first"));
    const before = (await service.publicSettings()).profile;
    const profilePath = path.join(directory, "host-profile.json");
    await rm(profilePath);
    await mkdir(profilePath);
    vault.failCompensation = true;

    await assert.rejects(
      service.save(compatibleProfile("second"), "second-key"),
      (error: unknown) =>
        error instanceof AggregateError &&
        /partially saved/u.test(error.message) &&
        error.errors.length === 2,
    );

    assert.deepEqual((await service.publicSettings()).profile, before);
    assert.equal(await vault.readApiKey("second"), "second-key");
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

test(
  "POSIX queued mutations resolve aliases after a symlink retarget",
  { skip: process.platform === "win32" },
  async () => await exerciseQueuedAliasRetarget("dir"),
);

test(
  "Windows queued mutations resolve aliases after a junction retarget",
  { skip: process.platform !== "win32" },
  async () => await exerciseQueuedAliasRetarget("junction"),
);

test("adds an absolute target-platform workspace without host conversion", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-target-platform-"),
  );
  const projectPlatform = process.platform === "win32" ? "linux" : "win32";
  const workspace =
    projectPlatform === "win32" ? "C:\\Work\\Second" : "/work/second";
  const resolved: string[] = [];
  try {
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault: new ZenXCredentialVault(
        path.join(directory, "credentials.vault"),
        encryption,
      ),
      subscription: idleSubscription(),
      projectPlatform,
      projectRealpath: async (candidate) => {
        resolved.push(candidate);
        return candidate;
      },
    });
    await service.initialize({});

    assert.equal(await service.addWorkspace(workspace), true);
    await service.markWorkspaceUsed(workspace);
    assert.equal((await service.publicSettings()).profile.workspace, workspace);
    assert.equal(
      (await service.publicSettings()).profile.lastUsedWorkspace,
      workspace,
    );
    assert.equal(resolved.includes(workspace), true);

    const reloaded = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault: new ZenXCredentialVault(
        path.join(directory, "credentials.vault"),
        encryption,
      ),
      subscription: idleSubscription(),
      projectPlatform,
      projectRealpath: async (candidate) => candidate,
    });
    await reloaded.initialize({});
    assert.equal(
      (await reloaded.publicSettings()).profile.workspace,
      workspace,
    );
    assert.equal(
      (await reloaded.publicSettings()).profile.lastUsedWorkspace,
      workspace,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace mutations retry one filesystem identity change", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-identity-retry-"),
  );
  const first = "/work/first";
  const second = "/work/second";
  const alias = "/work/alias";
  let aliasResolutions = 0;
  try {
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault: new ZenXCredentialVault(
        path.join(directory, "credentials.vault"),
        encryption,
      ),
      subscription: idleSubscription(),
      projectPlatform: "linux",
      projectRealpath: async (candidate) => {
        if (candidate !== alias) return candidate;
        aliasResolutions += 1;
        return aliasResolutions === 1 ? first : second;
      },
    });
    await service.initialize({});
    assert.equal(await service.addWorkspace(second), true);

    await service.markWorkspaceUsed(alias);

    assert.equal(
      (await service.publicSettings()).profile.lastUsedWorkspace,
      second,
    );
    assert.equal(aliasResolutions, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace mutations fail after bounded identity revalidation", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-identity-unstable-"),
  );
  const first = "/work/first";
  const second = "/work/second";
  const alias = "/work/alias";
  let aliasResolutions = 0;
  try {
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault: new ZenXCredentialVault(
        path.join(directory, "credentials.vault"),
        encryption,
      ),
      subscription: idleSubscription(),
      projectPlatform: "linux",
      projectRealpath: async (candidate) => {
        if (candidate !== alias) return candidate;
        aliasResolutions += 1;
        return aliasResolutions % 2 === 1 ? first : second;
      },
    });
    await service.initialize({});
    assert.equal(await service.addWorkspace(second), true);

    await assert.rejects(
      async () => await service.markWorkspaceUsed(alias),
      /filesystem identity changed/u,
    );

    assert.equal(
      (await service.publicSettings()).profile.lastUsedWorkspace,
      null,
    );
    assert.equal(aliasResolutions, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists bounded local Thread Pins in explicit Sidebar order", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-pins-"));
  try {
    const first = settingsFor(directory, {
      login: async () => undefined,
      logout: async () => undefined,
      status: async () => ({ authenticated: false, expired: false }),
    });
    await first.initialize({});
    await first.setPinnedThreadIds(["thread-b", "thread-a", "thread-b"]);
    assert.deepEqual((await first.publicSettings()).profile.pinnedThreadIds, [
      "thread-b",
      "thread-a",
    ]);

    const second = settingsFor(directory, {
      login: async () => undefined,
      logout: async () => undefined,
      status: async () => ({ authenticated: false, expired: false }),
    });
    await second.initialize({});
    assert.deepEqual((await second.publicSettings()).profile.pinnedThreadIds, [
      "thread-b",
      "thread-a",
    ]);
    assert.match(
      await readFile(path.join(directory, "host-profile.json"), "utf8"),
      /"pinnedThreadIds": \[\s*"thread-b",\s*"thread-a"/u,
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

test("title inference renews a subscription lease rejected after acquisition", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-title-auth-"));
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  await profileStore.write({
    version: 3,
    onboardingComplete: true,
    providerProfiles: [
      {
        providerProfileId: "openai-codex",
        type: "openai-subscription",
        displayName: "OpenAI subscription",
        models: structuredLegacyModelCatalog("openai-subscription", [
          "gpt-5.6-terra",
          "gpt-5.6-luna",
        ]),
      },
    ],
    defaultModel: {
      providerProfileId: "openai-codex",
      modelId: "gpt-5.6-terra",
    },
    titleModel: {
      providerProfileId: "openai-codex",
      modelId: "gpt-5.6-luna",
    },
    workspace: directory,
    workspaces: [directory],
    lastUsedWorkspace: directory,
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
    approvalPolicy: "never",
  });
  const rejected = subscriptionJwt("rejected");
  const renewed = subscriptionJwt("renewed");
  let renewals = 0;
  const subscription = {
    login: async () => undefined,
    logout: async () => undefined,
    status: async () => ({ authenticated: true, expired: false }),
    acquireAccessLease: async () => ({ accessToken: rejected }),
    renewAccessLease: async (rejectedAccessToken: string) => {
      assert.equal(rejectedAccessToken, rejected);
      renewals += 1;
      return { accessToken: renewed };
    },
  };
  const authorizations: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization")!;
    authorizations.push(authorization);
    return authorization === `Bearer ${rejected}`
      ? new Response(null, { status: 401 })
      : new Response(
          'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\r\n\r\ndata: [DONE]\r\n\r\n',
          { status: 200 },
        );
  };
  try {
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault: new ZenXCredentialVault(
        path.join(directory, "credentials.vault"),
        encryption,
      ),
      profileStore,
      subscription,
    });
    await service.initialize({});
    const configured = await service.titleModel();
    assert.equal(configured.model, "gpt-5.6-luna");
    const adapter = configured.adapter;
    assert.notEqual(adapter, null);
    if (adapter === null) throw new Error("expected a title model adapter");
    for await (const _event of adapter.stream({
      model: configured.model,
      reasoningEffort: "medium",
      messages: [{ role: "user", text: "Name this Thread" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // Completion without content is sufficient to prove the retry boundary.
    }
    assert.equal(renewals, 1);
    assert.deepEqual(authorizations, [
      `Bearer ${rejected}`,
      `Bearer ${renewed}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes subscription account operations by its configured opaque profile id", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-oauth-profile-"),
  );
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const subscriptionProfileId = "subscription-opaque-7f4d";
  await profileStore.write({
    version: 3,
    onboardingComplete: true,
    providerProfiles: [
      {
        providerProfileId: "fake",
        type: "fake",
        displayName: "Local demo",
        models: structuredLegacyModelCatalog("fake", ["fake"]),
      },
      {
        providerProfileId: subscriptionProfileId,
        type: "openai-subscription",
        displayName: "Work subscription",
        models: structuredLegacyModelCatalog("openai-subscription", [
          "gpt-5.6-terra",
        ]),
      },
    ],
    defaultModel: { providerProfileId: "fake", modelId: "fake" },
    titleModel: { providerProfileId: "fake", modelId: "fake" },
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
    approvalPolicy: "never",
  });
  let loginCount = 0;
  let logoutCount = 0;
  const scopedSubscription = {
    login: async () => {
      loginCount += 1;
    },
    logout: async () => {
      logoutCount += 1;
    },
    status: async () => ({ authenticated: true, expired: false }),
  };
  const factoryPaths: string[] = [];
  try {
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault: new ZenXCredentialVault(
        path.join(directory, "credentials.vault"),
        encryption,
      ),
      profileStore,
      subscription: inactiveSubscription(),
      subscriptionFactory: (profilePath) => {
        factoryPaths.push(profilePath);
        return scopedSubscription;
      },
    });
    await service.initialize({});
    const publicSettings = await service.publicSettings();
    assert.equal(
      publicSettings.subscriptionProviderProfileId,
      subscriptionProfileId,
    );
    assert.equal(publicSettings.subscription.authenticated, true);
    await service.login(
      () => undefined,
      () => undefined,
    );
    await service.logout();
    assert.equal(loginCount, 1);
    assert.equal(logoutCount, 1);
    await service.deleteProviderProfile(subscriptionProfileId);
    assert.equal(logoutCount, 2);
    assert.ok(
      factoryPaths.every((value) =>
        value.includes("openai-subscription-auth."),
      ),
    );
    assert.equal(
      (await service.publicSettings()).subscriptionProviderProfileId,
      null,
    );
    assert.equal(
      (await service.publicSettings()).profile.providerProfiles.some(
        (provider) => provider.providerProfileId === subscriptionProfileId,
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates a persisted v1 profile and vault together and restarts from durable v3", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-paired-v1-"));
  const profilePath = path.join(directory, "host-profile.json");
  const vaultPath = path.join(directory, "credentials.vault");
  try {
    await writeFile(
      profilePath,
      JSON.stringify({
        version: 1,
        onboardingComplete: true,
        provider: {
          type: "openai-compatible",
          name: "legacy-adapter",
          displayName: "Legacy",
          baseUrl: "https://legacy.example.test/v1",
        },
        defaultModel: "shared-model",
        titleModel: "title-model",
        models: ["shared-model"],
        workspace: null,
        workspaces: [],
        lastUsedWorkspace: null,
        approvalPolicy: "never",
        pinnedThreadIds: ["old-thread"],
        sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      vaultPath,
      JSON.stringify({
        version: 1,
        apiKey: encryption.encryptString("legacy-key").toString("base64"),
      }),
      { mode: 0o600 },
    );
    const vault = new ZenXCredentialVault(vaultPath, encryption);
    const first = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault,
      subscription: inactiveSubscription(),
    });
    await first.initialize({});
    assert.equal(await vault.readApiKey("legacy-adapter"), "legacy-key");
    const firstProfile = await readFile(profilePath, "utf8");
    const firstVault = await readFile(vaultPath, "utf8");
    assert.equal(JSON.parse(firstProfile).version, 3);
    assert.equal(JSON.parse(firstVault).version, 2);
    assert.doesNotMatch(firstProfile + firstVault, /legacy-key/u);

    const second = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault: new ZenXCredentialVault(vaultPath, encryption),
      subscription: inactiveSubscription(),
    });
    await second.initialize({ ZENX_PROVIDER: "fake" });
    assert.equal(await readFile(profilePath, "utf8"), firstProfile);
    assert.equal(await readFile(vaultPath, "utf8"), firstVault);
    assert.equal(
      (await second.publicSettings()).profile.defaultModel.providerProfileId,
      "legacy-adapter",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a vault migration failure publishes no settings and succeeds on explicit restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-v1-restart-"));
  const profilePath = path.join(directory, "host-profile.json");
  const vaultPath = path.join(directory, "credentials.vault");
  const legacyProfile = {
    version: 1,
    onboardingComplete: true,
    provider: {
      type: "openai-compatible",
      name: "legacy",
      displayName: "Legacy",
      baseUrl: "https://legacy.example.test/v1",
    },
    defaultModel: "legacy-model",
    titleModel: "legacy-model",
    models: ["legacy-model"],
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    approvalPolicy: "never",
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  };
  try {
    await writeFile(profilePath, JSON.stringify(legacyProfile), {
      mode: 0o600,
    });
    await mkdir(vaultPath);
    const failed = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault: new ZenXCredentialVault(vaultPath, encryption),
      subscription: inactiveSubscription(),
    });
    await assert.rejects(failed.initialize({}), /not a regular file/u);
    await assert.rejects(failed.publicSettings(), /not initialized/u);
    assert.equal(JSON.parse(await readFile(profilePath, "utf8")).version, 3);

    await rm(vaultPath, { recursive: true });
    await writeFile(
      vaultPath,
      JSON.stringify({
        version: 1,
        apiKey: encryption.encryptString("legacy-key").toString("base64"),
      }),
      { mode: 0o600 },
    );
    const restarted = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault: new ZenXCredentialVault(vaultPath, encryption),
      subscription: inactiveSubscription(),
    });
    await restarted.initialize({});
    assert.equal((await restarted.publicSettings()).profile.version, 3);
    assert.equal(
      await restarted
        .hostConfig()
        .then((config) => config.defaultSelection?.providerProfileId),
      "legacy",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adds, edits, and deletes Provider profiles with atomic replacements and isolated credential clearing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profiles-"));
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  try {
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault,
      subscription: inactiveSubscription(),
    });
    await service.initialize({ ZENX_PROVIDER: "fake" });
    const first = compatibleProfile("first").providerProfiles[0]!;
    const second = compatibleProfile("second").providerProfiles[0]!;
    await service.addProviderProfile(first, "first-key");
    await service.addProviderProfile(second, "second-key");
    await service.editProviderProfile(
      "first",
      { ...first, displayName: "First edited" },
      {
        defaultModel: { providerProfileId: "first", modelId: "first-model" },
        titleModel: { providerProfileId: "first", modelId: "first-model" },
      },
    );
    await assert.rejects(
      service.deleteProviderProfile("first"),
      /requires a replacement default model/u,
    );
    await service.deleteProviderProfile("first", {
      defaultModel: { providerProfileId: "second", modelId: "second-model" },
      titleModel: { providerProfileId: "second", modelId: "second-model" },
    });
    const reloaded = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault,
      subscription: inactiveSubscription(),
    });
    await reloaded.initialize({});
    const publicSettings = await reloaded.publicSettings();
    assert.deepEqual(
      publicSettings.profile.providerProfiles.map(
        (provider) => provider.providerProfileId,
      ),
      ["fake", "second"],
    );
    assert.deepEqual(publicSettings.profile.defaultModel, {
      providerProfileId: "second",
      modelId: "second-model",
    });
    assert.equal(await vault.readApiKey("first"), undefined);
    assert.equal(await vault.readApiKey("second"), "second-key");
    assert.deepEqual(publicSettings.apiKeyProviderProfileIds, ["second"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("title inference resolves the selected profile's adapter and credential", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-profile-"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const first = compatibleProfile("first").providerProfiles[0]!;
  const secondBase = compatibleProfile("second").providerProfiles[0]!;
  const second = {
    ...secondBase,
    models: secondBase.models.map((model) => ({
      ...model,
      source: "manual" as const,
      supportedReasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    })),
  };
  const profile: ZenXHostProfile = {
    ...fakeProfile("fake"),
    providerProfiles: [first, second],
    defaultModel: { providerProfileId: "first", modelId: "first-model" },
    titleModel: { providerProfileId: "second", modelId: "second-model" },
  };
  const originalFetch = globalThis.fetch;
  let authorization: string | null = null;
  let requestUrl = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization");
    return new Response(
      'data: {"choices":[{"delta":{"content":"Title second-key"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    await profileStore.write(profile);
    await vault.writeApiKey("first", "first-key");
    await vault.writeApiKey("second", "second-key");
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      vault,
      profileStore,
      subscription: inactiveSubscription(),
    });
    await service.initialize({});
    const configured = await service.titleModel();
    assert.equal(configured.reasoningEffort, "high");
    let output = "";
    for await (const event of configured.adapter!.stream({
      model: configured.model,
      reasoningEffort: "medium",
      messages: [{ role: "user", text: "title me" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      if (event.type === "text_delta") output += event.delta;
    }
    assert.equal(output, "Title second-key");
    assert.equal(configured.model, "second-model");
    assert.equal(authorization, "Bearer second-key");
    assert.match(requestUrl, /^https:\/\/second\.example\.test/u);
  } finally {
    globalThis.fetch = originalFetch;
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

async function exerciseQueuedAliasRetarget(
  type: "dir" | "junction",
): Promise<void> {
  for (const operation of ["mark-used", "default", "remove"] as const) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `zenx-settings-retarget-${operation}-`),
    );
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    const other = path.join(directory, "other");
    const alias = path.join(directory, "alias");
    try {
      await Promise.all([mkdir(first), mkdir(second), mkdir(other)]);
      await symlink(first, alias, type);
      const vault = new BlockingCredentialVault(
        path.join(directory, "credentials.vault"),
        encryption,
      );
      const service = new ZenXSettingsService({
        userDataDirectory: directory,
        zenDataDirectory: path.join(directory, "zen"),
        vault,
        subscription: idleSubscription(),
      });
      await service.initialize({ ZENX_CWD: other });
      await service.addWorkspace(second);
      const profile = (await service.publicSettings()).profile;

      const blocker = vault.blockNextWrite();
      const queuedSave = service.save(profile, "queued-secret");
      await blocker.started;
      const mutation =
        operation === "mark-used"
          ? service.markWorkspaceUsed(alias)
          : operation === "default"
            ? service.setDefaultWorkspace(alias)
            : service.removeWorkspace(alias);
      await unlink(alias);
      await symlink(second, alias, type);
      blocker.release();
      await queuedSave;
      await mutation;

      const updated = (await service.publicSettings()).profile;
      if (operation === "mark-used") {
        assert.equal(updated.lastUsedWorkspace, second);
      } else if (operation === "default") {
        assert.equal(updated.workspace, second);
      } else {
        assert.deepEqual(updated.workspaces, [other]);
        assert.equal(updated.workspace, other);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

class BlockingCredentialVault extends ZenXCredentialVault {
  #nextWrite:
    | {
        readonly started: () => void;
        readonly gate: Promise<void>;
      }
    | undefined;

  blockNextWrite(): { started: Promise<void>; release(): void } {
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#nextWrite = { started: announceStarted, gate };
    return { started, release };
  }

  override async writeApiKey(
    providerProfileId: string,
    apiKey: string,
  ): Promise<void> {
    const blocker = this.#nextWrite;
    this.#nextWrite = undefined;
    if (blocker !== undefined) {
      blocker.started();
      await blocker.gate;
    }
    await super.writeApiKey(providerProfileId, apiKey);
  }
}

function idleSubscription(): Pick<
  OpenAiSubscriptionAuthProfile,
  "login" | "logout" | "status"
> {
  return {
    login: async () => undefined,
    logout: async () => undefined,
    status: async () => ({ authenticated: false, expired: false }),
  };
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

function inactiveSubscription(): Pick<
  OpenAiSubscriptionAuthProfile,
  "login" | "logout" | "status"
> {
  return {
    login: async () => undefined,
    logout: async () => undefined,
    status: async () => ({ authenticated: false, expired: false }),
  };
}

function fakeProfile(model: string): ZenXHostProfile {
  return {
    version: 3,
    onboardingComplete: true,
    providerProfiles: [
      {
        providerProfileId: "fake",
        type: "fake",
        displayName: "Local demo",
        models: structuredLegacyModelCatalog("fake", [model]),
      },
    ],
    defaultModel: { providerProfileId: "fake", modelId: model },
    titleModel: { providerProfileId: "fake", modelId: model },
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
    approvalPolicy: "always",
  };
}

function compatibleProfile(name: string): ZenXHostProfile {
  return {
    ...fakeProfile(`${name}-model`),
    providerProfiles: [
      {
        providerProfileId: name,
        type: "openai-compatible",
        name,
        displayName: name,
        baseUrl: `https://${name}.example.test/v1`,
        models: structuredLegacyModelCatalog("openai-compatible", [
          `${name}-model`,
        ]),
      },
    ],
    defaultModel: { providerProfileId: name, modelId: `${name}-model` },
    titleModel: { providerProfileId: name, modelId: `${name}-model` },
  };
}

function compatibleEnvironment(name: string): NodeJS.ProcessEnv {
  return {
    ZENX_PROVIDER: "openai-compatible",
    ZENX_API_KEY_ENV: `${name.toUpperCase()}_KEY`,
    [`${name.toUpperCase()}_KEY`]: `${name}-key`,
    ZENX_BASE_URL: `https://${name}.example.test/v1`,
    ZENX_PROVIDER_NAME: name,
    ZENX_MODEL: `${name}-model`,
    ZENX_MODELS: `${name}-model`,
  };
}

function subscriptionJwt(marker: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", marker })}.${encode({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_zenx_settings_test",
    },
  })}.signature`;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

class InverseCompletionProfileStore extends ZenXHostProfileStore {
  readonly #firstWriteStarted = deferred();
  readonly #releaseFirstWrite = deferred();
  writeCalls = 0;

  get firstWriteStarted(): Promise<void> {
    return this.#firstWriteStarted.promise;
  }

  releaseFirstWrite(): void {
    this.#releaseFirstWrite.resolve();
  }

  override async write(profile: ZenXHostProfile): Promise<void> {
    this.writeCalls += 1;
    if (this.writeCalls === 1) {
      this.#firstWriteStarted.resolve();
      await this.#releaseFirstWrite.promise;
    }
    await super.write(profile);
  }
}

class FailingCompensationVault extends ZenXCredentialVault {
  failCompensation = false;

  constructor(filePath: string) {
    super(filePath, encryption);
  }

  override async clearApiKey(providerProfileId: string): Promise<void> {
    if (this.failCompensation && providerProfileId === "second") {
      throw new Error("credential compensation failed");
    }
    await super.clearApiKey(providerProfileId);
  }
}
