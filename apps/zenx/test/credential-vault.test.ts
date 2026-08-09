import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
