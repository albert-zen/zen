import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import {
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
  CredentialStorageError,
  ZenXCredentialVault,
  type LocalEncryption,
} from "../src/main/credential-vault.js";

import { secureLocalEncryption } from "../src/main/secure-local-encryption.js";

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
      (error: unknown) =>
        error instanceof CredentialStorageError &&
        error.code === "credential-storage-unavailable",
    );
    assert.deepEqual(await readdir(directory), []);
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
    await assert.rejects(vault.readApiKey("profile"), {
      code: "credential-read-failed",
    });
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
        error instanceof CredentialStorageError &&
        error.code === "credential-read-failed" &&
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
    // Obstruct the destination only after the read and encryption stages.
    // This exercises the actual atomic rename failure, not a read failure.
    const vault = new ZenXCredentialVault(file, {
      ...encryption,
      encryptString(value) {
        mkdirSync(file);
        return encryption.encryptString(value);
      },
    });
    await assert.rejects(vault.writeApiKey("profile-a", "secret"), {
      code: "credential-write-failed",
    });
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const failure of ["availability", "encrypt", "decrypt"] as const) {
  test(`native ${failure} failures keep fixed summaries and retain the native local cause`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-vault-native-"),
    );
    const file = path.join(directory, "private-vault-path");
    const secret = "synthetic-key-native-error-must-not-escape";
    try {
      await new ZenXCredentialVault(file, encryption).writeApiKey(
        "profile",
        secret,
      );
      const before = await readFile(file, "utf8");
      const fail = () => {
        throw new Error(`${secret} ${file}`);
      };
      const vault = new ZenXCredentialVault(file, {
        ...encryption,
        ...(failure === "availability"
          ? { isEncryptionAvailable: fail }
          : failure === "encrypt"
            ? { encryptString: fail }
            : { decryptString: fail }),
      });
      await assert.rejects(
        failure === "decrypt"
          ? vault.readApiKey("profile")
          : vault.writeApiKey("profile", secret),
        (error: unknown) => {
          assert.ok(error instanceof CredentialStorageError);
          assert.equal(
            error.code,
            failure === "availability"
              ? "credential-storage-unavailable"
              : failure === "encrypt"
                ? "credential-encryption-failed"
                : "credential-decryption-failed",
          );
          assert.equal(JSON.stringify(error).includes(secret), false);
          assert.equal(error.message.includes(secret), false);
          assert.equal(error.message.includes(file), false);
          assert.ok(error.cause instanceof Error);
          assert.equal(error.cause.message, `${secret} ${file}`);
          return true;
        },
      );
      assert.equal(await readFile(file, "utf8"), before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("credential availability changes remain typed unavailable at the final encryption boundary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-vault-race-"));
  try {
    let checks = 0;
    let encrypted = false;
    const vault = new ZenXCredentialVault(
      path.join(directory, "vault"),
      secureLocalEncryption(
        {
          ...encryption,
          isEncryptionAvailable: () => ++checks === 1,
          getSelectedStorageBackend: () => "gnome_libsecret",
          encryptString(value) {
            encrypted = true;
            return encryption.encryptString(value);
          },
        },
        "linux",
      ),
    );
    await assert.rejects(vault.writeApiKey("profile", "synthetic-key"), {
      code: "credential-storage-unavailable",
    });
    assert.equal(checks, 2);
    assert.equal(encrypted, false);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
