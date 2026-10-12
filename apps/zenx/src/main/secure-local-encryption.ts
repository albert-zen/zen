import type { LocalEncryption } from "./credential-vault.js";

export interface LocalEncryptionBackend extends LocalEncryption {
  getSelectedStorageBackend?(): string;
}

/** Fail closed for Electron's non-OS Linux fallback; grant no new access. */
export function secureLocalEncryption(
  encryption: LocalEncryptionBackend,
  platform: NodeJS.Platform = process.platform,
): LocalEncryption {
  const available = () => {
    try {
      if (!encryption.isEncryptionAvailable()) return false;
      if (platform !== "linux") return true;
      return ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
        encryption.getSelectedStorageBackend?.() ?? "unknown",
      );
    } catch {
      return false;
    }
  };
  const requireAvailable = () => {
    if (!available())
      throw new Error(
        "Operating-system credential encryption is unavailable; no plaintext fallback is used",
      );
  };
  return {
    isEncryptionAvailable: available,
    encryptString: (value) => {
      requireAvailable();
      return encryption.encryptString(value);
    },
    decryptString: (value) => {
      requireAvailable();
      return encryption.decryptString(value);
    },
  };
}
