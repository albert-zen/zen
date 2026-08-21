import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXCredentialVault,
  type LocalEncryption,
} from "../src/main/credential-vault.js";

const encryption: LocalEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^protected:/u, ""),
};

test("stores API keys encrypted in a private host-owned vault", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-vault-"));
  const file = path.join(directory, "credentials.vault");
  try {
    const vault = new ZenXCredentialVault(file, encryption);
    await vault.writeApiKey("profile-a", "sk-super-secret");
    assert.equal(await vault.readApiKey("profile-a"), "sk-super-secret");
    assert.doesNotMatch(await readFile(file, "utf8"), /sk-super-secret/u);
    if (process.platform !== "win32")
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    await vault.clearApiKey("profile-a");
    assert.equal(await vault.readApiKey("profile-a"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates a v1 API key to one deterministic profile and restarts idempotently", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-vault-v1-"));
  const file = path.join(directory, "credentials.vault");
  try {
    await writeFile(
      file,
      `${JSON.stringify({
        version: 1,
        apiKey: encryption.encryptString("legacy-secret").toString("base64"),
      })}\n`,
      { mode: 0o600 },
    );
    const vault = new ZenXCredentialVault(file, encryption);
    await assert.rejects(
      vault.readApiKey("legacy-provider"),
      /must be migrated/u,
    );
    await vault.migrateLegacyApiKey("legacy-provider");
    const first = await readFile(file, "utf8");
    assert.equal(await vault.readApiKey("legacy-provider"), "legacy-secret");
    assert.equal(await vault.readApiKey("other-provider"), undefined);
    await vault.migrateLegacyApiKey("legacy-provider");
    assert.equal(await readFile(file, "utf8"), first);
    assert.doesNotMatch(first, /legacy-secret/u);
    assert.equal(JSON.parse(first).version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps credentials isolated by Provider profile and clears only one", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-vault-many-"));
  try {
    const vault = new ZenXCredentialVault(
      path.join(directory, "credentials.vault"),
      encryption,
    );
    await Promise.all([
      vault.writeApiKey("profile-a", "secret-a"),
      vault.writeApiKey("profile-b", "secret-b"),
    ]);
    assert.deepEqual(await vault.readApiKeys(["profile-a", "profile-b"]), {
      "profile-a": "secret-a",
      "profile-b": "secret-b",
    });
    await vault.clearApiKey("profile-a");
    assert.equal(await vault.readApiKey("profile-a"), undefined);
    assert.equal(await vault.readApiKey("profile-b"), "secret-b");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to persist a secret when system encryption is unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-vault-off-"));
  try {
    const vault = new ZenXCredentialVault(path.join(directory, "vault"), {
      ...encryption,
      isEncryptionAvailable: () => false,
    });
    await assert.rejects(
      vault.writeApiKey("profile-a", "secret"),
      /encryption is unavailable/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses independent staging files for concurrent credential writes and cleans them", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-vault-concurrent-"),
  );
  const file = path.join(directory, "credentials.vault");
  try {
    const vault = new ZenXCredentialVault(file, encryption);
    await Promise.all([
      vault.writeApiKey("profile-a", "first-secret"),
      vault.writeApiKey("profile-a", "second-secret"),
    ]);
    assert.equal(await vault.readApiKey("profile-a"), "second-secret");
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects corrupt v1 and v2 vault data without echoing stored material", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-vault-bad-"));
  const file = path.join(directory, "credentials.vault");
  try {
    const vault = new ZenXCredentialVault(file, encryption);
    await writeFile(file, "{not-json", { mode: 0o600 });
    await assert.rejects(vault.readApiKey("profile"), /vault is invalid/u);
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        apiKeys: { profile: "not-base64!private-material" },
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      vault.readApiKey("profile"),
      (error: unknown) =>
        error instanceof Error &&
        /vault is invalid/u.test(error.message) &&
        !error.message.includes("private-material"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans credential staging when atomic replacement fails", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-vault-cleanup-"),
  );
  const file = path.join(directory, "credentials.vault");
  try {
    await mkdir(file);
    const vault = new ZenXCredentialVault(file, encryption);
    await assert.rejects(vault.writeApiKey("profile-a", "secret"));
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
