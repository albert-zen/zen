import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXCredentialVault,
  type LocalEncryption,
} from "../src/main/credential-vault.js";
import { ZenXSettingsService } from "../src/main/settings-service.js";

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
