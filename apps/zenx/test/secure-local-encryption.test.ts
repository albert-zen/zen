import assert from "node:assert/strict";
import test from "node:test";
import { secureLocalEncryption } from "../src/main/secure-local-encryption.js";

test("Linux requires an OS-protected backend and blocks direct encryption/decryption fallback", () => {
  let calls = 0;
  const base = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      calls++;
      return Buffer.from(value);
    },
    decryptString: (value: Buffer) => {
      calls++;
      return value.toString();
    },
  };
  for (const backend of ["basic_text", "unknown", undefined]) {
    const wrapper = secureLocalEncryption(
      {
        ...base,
        ...(backend === undefined
          ? {}
          : { getSelectedStorageBackend: () => backend }),
      },
      "linux",
    );
    assert.equal(wrapper.isEncryptionAvailable(), false);
    assert.throws(
      () => wrapper.encryptString("synthetic-secret"),
      /no plaintext fallback/,
    );
    assert.throws(
      () => wrapper.decryptString(Buffer.from("synthetic-secret")),
      /no plaintext fallback/,
    );
  }
  assert.equal(calls, 0);
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])
    assert.equal(
      secureLocalEncryption(
        { ...base, getSelectedStorageBackend: () => backend },
        "linux",
      ).isEncryptionAvailable(),
      true,
    );
  for (const platform of ["win32", "darwin"] as const)
    assert.equal(
      secureLocalEncryption(base, platform).isEncryptionAvailable(),
      true,
    );
  assert.equal(
    secureLocalEncryption(
      { ...base, isEncryptionAvailable: () => false },
      "win32",
    ).isEncryptionAvailable(),
    false,
  );
  assert.equal(
    secureLocalEncryption(
      {
        ...base,
        getSelectedStorageBackend: () => {
          throw new Error("unavailable");
        },
      },
      "linux",
    ).isEncryptionAvailable(),
    false,
  );
});
