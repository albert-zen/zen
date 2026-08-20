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
      (await service.publicSettings()).profile.defaultModel,
      "saved-model",
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(directory, "host-profile.json"), "utf8"),
      ).defaultModel,
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

    assert.equal(await vault.readApiKey(), "second-key");
    assert.equal(
      (await service.publicSettings()).profile.defaultModel,
      "second-model",
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(directory, "host-profile.json"), "utf8"),
      ).defaultModel,
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

    assert.equal(await vault.readApiKey(), "first-key");
    assert.equal(
      (await service.publicSettings()).profile.defaultModel,
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

    await service.save({
      ...stale,
      defaultModel: "saved-model",
      models: ["saved-model"],
    });

    const profile = (await service.publicSettings()).profile;
    assert.equal(profile.defaultModel, "saved-model");
    assert.equal(profile.workspace, path.resolve(workspace));
    assert.deepEqual(profile.workspaces, [path.resolve(workspace)]);
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
    assert.equal(await vault.readApiKey(), "first-key");
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
    assert.equal(await vault.readApiKey(), "second-key");
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

test("workspace mutations retry one filesystem identity change", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-identity-retry-"),
  );
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  const alias = path.join(directory, "alias");
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
    await service.initialize({ ZENX_CWD: second });

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
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  const alias = path.join(directory, "alias");
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
    await service.initialize({ ZENX_CWD: second });

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

  override async writeApiKey(apiKey: string): Promise<void> {
    const blocker = this.#nextWrite;
    this.#nextWrite = undefined;
    if (blocker !== undefined) {
      blocker.started();
      await blocker.gate;
    }
    await super.writeApiKey(apiKey);
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
    version: 1,
    onboardingComplete: true,
    provider: { type: "fake", displayName: "Local demo" },
    defaultModel: model,
    titleModel: model,
    models: [model],
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    approvalPolicy: "always",
  };
}

function compatibleProfile(name: string): ZenXHostProfile {
  return {
    ...fakeProfile(`${name}-model`),
    provider: {
      type: "openai-compatible",
      name,
      displayName: name,
      baseUrl: `https://${name}.example.test/v1`,
    },
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

  override async writeApiKey(apiKey: string): Promise<void> {
    if (this.failCompensation && apiKey === "first-key") {
      throw new Error("credential compensation failed");
    }
    await super.writeApiKey(apiKey);
  }
}
