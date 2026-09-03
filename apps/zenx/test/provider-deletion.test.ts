import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import { ZenXCredentialVault } from "../src/main/credential-vault.js";
import {
  structuredLegacyModelCatalog,
  type ZenXHostProfile,
  ZenXHostProfileStore,
} from "../src/main/host-profile.js";
import {
  ZenXProviderDeletionCleanupError,
  ZenXSettingsService,
} from "../src/main/settings-service.js";
import { deleteProviderProfileWithHostRestart } from "../src/main/provider-deletion.js";

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`secure:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^secure:/u, ""),
};

test("committed Provider deletion restarts Host before reporting cleanup failure", async () => {
  const fixture = await deletionFixture({
    logout: async () => {
      throw new Error("cleanup failed at /secret/path with token-123");
    },
  });
  let restarts = 0;
  try {
    await assert.rejects(
      deleteProviderProfileWithHostRestart(
        fixture.service,
        "subscription",
        {},
        async () => {
          restarts += 1;
        },
      ),
      (error: unknown) => {
        const inspected = inspect(error, { depth: 5, showHidden: true });
        return (
          error instanceof ZenXProviderDeletionCleanupError &&
          error.committed === true &&
          !("cause" in error) &&
          !inspected.includes("token-123") &&
          !inspected.includes("/secret/path")
        );
      },
    );
    assert.equal(restarts, 1);
    assert.equal(
      (await fixture.service.publicSettings()).profile.providerProfiles.some(
        (provider) => provider.providerProfileId === "subscription",
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("committed cleanup and Host restart failures preserve both causes", async () => {
  const fixture = await deletionFixture({
    logout: async () => {
      throw new Error("cleanup rejected with credential secret-cleanup");
    },
  });
  try {
    await assert.rejects(
      deleteProviderProfileWithHostRestart(
        fixture.service,
        "subscription",
        {},
        async () => {
          throw new Error("restart rejected with secret-restart");
        },
      ),
      (error: unknown) =>
        error instanceof AggregateError &&
        /subscription cleanup and Host restart both failed/u.test(
          error.message,
        ) &&
        !error.message.includes("secret-cleanup") &&
        !error.message.includes("secret-restart") &&
        error.errors.length === 2 &&
        error.errors[0] instanceof ZenXProviderDeletionCleanupError &&
        error.errors[1] instanceof Error &&
        error.errors[1].message === "restart rejected with secret-restart",
    );
  } finally {
    await fixture.close();
  }
});

test("pre-commit Provider deletion failure does not restart Host", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-delete-precommit-"),
  );
  const store = new FailNextWriteProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const profile = deletionProfile();
  await store.write(profile);
  let logoutCount = 0;
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    profileStore: store,
    vault: new ZenXCredentialVault(
      path.join(directory, "credentials.vault"),
      encryption,
    ),
    subscriptionFactory: () => ({
      login: async () => undefined,
      logout: async () => {
        logoutCount += 1;
      },
      status: async () => ({ authenticated: true, expired: false }),
    }),
  });
  let restarts = 0;
  try {
    await service.initialize({});
    store.failNextWrite = true;
    await assert.rejects(
      deleteProviderProfileWithHostRestart(
        service,
        "subscription",
        {},
        async () => {
          restarts += 1;
        },
      ),
      /profile write rejected/u,
    );
    assert.equal(restarts, 0);
    assert.equal(logoutCount, 0);
    assert.equal(
      (await service.publicSettings()).profile.providerProfiles.some(
        (provider) => provider.providerProfileId === "subscription",
      ),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function deletionFixture(subscription: { logout(): Promise<void> }) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-delete-commit-"),
  );
  const store = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  await store.write(deletionProfile());
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    profileStore: store,
    vault: new ZenXCredentialVault(
      path.join(directory, "credentials.vault"),
      encryption,
    ),
    subscriptionFactory: () => ({
      login: async () => undefined,
      logout: subscription.logout,
      status: async () => ({ authenticated: true, expired: false }),
    }),
  });
  await service.initialize({});
  return {
    service,
    close: async () => await rm(directory, { recursive: true, force: true }),
  };
}

function deletionProfile(): ZenXHostProfile {
  return {
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
        providerProfileId: "subscription",
        type: "openai-subscription",
        displayName: "Subscription",
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
    approvalPolicy: "never",
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  };
}

class FailNextWriteProfileStore extends ZenXHostProfileStore {
  failNextWrite = false;

  override async write(profile: ZenXHostProfile): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("profile write rejected");
    }
    await super.write(profile);
  }
}
