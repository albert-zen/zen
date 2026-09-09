import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXCredentialVault } from "../src/main/credential-vault.js";
import {
  structuredLegacyModelCatalog,
  type ZenXHostProfile,
  ZenXHostProfileStore,
} from "../src/main/host-profile.js";
import { ZenXSettingsService } from "../src/main/settings-service.js";

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`secure:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^secure:/u, ""),
};

test("Provider deletion withdraws its catalog without revoking an in-flight subscription identity", async () => {
  let logouts = 0;
  const fixture = await deletionFixture({
    logout: async () => {
      logouts++;
    },
  });
  try {
    await fixture.service.deleteProviderProfile("subscription");
    assert.equal(logouts, 0);
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

test("Provider deletion prepare failure preserves the catalog and credentials", async () => {
  let logouts = 0;
  const fixture = await deletionFixture({
    logout: async () => {
      logouts++;
    },
  });
  try {
    fixture.service.setConfigurationControl({
      prepare: async () => {
        throw new Error("prepare rejected");
      },
      publish: async () => {
        throw new Error("unexpected publish");
      },
      discard: async () => {},
      current: async () => ({
        processEpoch: "epoch",
        revision: 0,
        pendingRestart: [],
      }),
    });
    await assert.rejects(
      fixture.service.deleteProviderProfile("subscription"),
      /prepare rejected/,
    );
    assert.equal(logouts, 0);
    assert.equal(
      (await fixture.service.publicSettings()).profile.providerProfiles.some(
        (provider) => provider.providerProfileId === "subscription",
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("pre-commit Provider deletion failure preserves profile and subscription identity", async () => {
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
  try {
    await service.initialize({});
    store.failNextWrite = true;
    await assert.rejects(
      service.deleteProviderProfile("subscription"),
      /profile write rejected/u,
    );
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
