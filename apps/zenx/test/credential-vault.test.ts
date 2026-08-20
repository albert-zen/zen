import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
    await vault.writeApiKey("sk-super-secret");
    assert.equal(await vault.readApiKey(), "sk-super-secret");
    assert.doesNotMatch(await readFile(file, "utf8"), /sk-super-secret/u);
    if (process.platform !== "win32")
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    await vault.clearApiKey();
    assert.equal(await vault.readApiKey(), undefined);
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
      vault.writeApiKey("secret"),
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
      vault.writeApiKey("first-secret"),
      vault.writeApiKey("second-secret"),
    ]);
    assert.ok(
      ["first-secret", "second-secret"].includes(
        (await vault.readApiKey()) ?? "",
      ),
    );
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
      [],
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
    await assert.rejects(vault.writeApiKey("secret"));
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
