import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LocalEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface StoredVaultV1 {
  version: 1;
  apiKey: string;
}

interface StoredVaultV2 {
  version: 2;
  apiKeys: Record<string, string>;
}

type StoredVault = StoredVaultV1 | StoredVaultV2;

const MAX_PROFILE_ID_LENGTH = 512;
const MAX_CREDENTIALS = 128;

export class ZenXCredentialVault {
  readonly #filePath: string;
  readonly #encryption: LocalEncryption;
  #operations: Promise<void> = Promise.resolve();

  constructor(filePath: string, encryption: LocalEncryption) {
    this.#filePath = path.resolve(filePath);
    this.#encryption = encryption;
  }

  async migrateLegacyApiKey(providerProfileId: string): Promise<void> {
    const profileId = validateProfileId(providerProfileId);
    await this.#queue(async () => {
      const stored = await this.#readStored();
      if (stored === undefined || stored.version === 2) return;
      await this.#writeStored({
        version: 2,
        apiKeys: { [profileId]: stored.apiKey },
      });
    });
  }

  async hasApiKey(providerProfileId: string): Promise<boolean> {
    return (await this.readApiKey(providerProfileId)) !== undefined;
  }

  async readApiKey(providerProfileId: string): Promise<string | undefined> {
    const profileId = validateProfileId(providerProfileId);
    return await this.#queue(async () => {
      const stored = await this.#readStored();
      if (stored === undefined) return undefined;
      if (stored.version === 1) {
        throw new Error(
          "ZenX credential vault v1 must be migrated before profile-scoped access",
        );
      }
      const encrypted = stored.apiKeys[profileId];
      if (encrypted === undefined) return undefined;
      return this.#decrypt(encrypted);
    });
  }

  async readApiKeys(
    providerProfileIds: readonly string[],
  ): Promise<Record<string, string | undefined>> {
    const ids = providerProfileIds.map(validateProfileId);
    if (new Set(ids).size !== ids.length) {
      throw new Error("Provider profile ids must be unique");
    }
    return await this.#queue(async () => {
      const stored = await this.#readStored();
      if (stored?.version === 1) {
        throw new Error(
          "ZenX credential vault v1 must be migrated before profile-scoped access",
        );
      }
      const output: Record<string, string | undefined> = {};
      for (const id of ids) {
        const encrypted =
          stored?.version === 2 ? stored.apiKeys[id] : undefined;
        output[id] =
          encrypted === undefined ? undefined : this.#decrypt(encrypted);
      }
      return output;
    });
  }

  async writeApiKey(providerProfileId: string, apiKey: string): Promise<void> {
    const profileId = validateProfileId(providerProfileId);
    if (apiKey.trim().length === 0) throw new Error("API key cannot be empty");
    await this.#queue(async () => {
      const stored = await this.#readStored();
      if (stored?.version === 1) {
        throw new Error(
          "ZenX credential vault v1 must be migrated before profile-scoped access",
        );
      }
      const apiKeys: Record<string, string> =
        stored === undefined ? {} : { ...stored.apiKeys };
      if (
        !(profileId in apiKeys) &&
        Object.keys(apiKeys).length >= MAX_CREDENTIALS
      ) {
        throw new Error("ZenX credential vault contains too many profiles");
      }
      apiKeys[profileId] = this.#encrypt(apiKey);
      await this.#writeStored({ version: 2, apiKeys });
    });
  }

  async clearApiKey(providerProfileId: string): Promise<void> {
    const profileId = validateProfileId(providerProfileId);
    await this.#queue(async () => {
      const stored = await this.#readStored();
      if (stored === undefined) return;
      if (stored.version === 1) {
        throw new Error(
          "ZenX credential vault v1 must be migrated before profile-scoped access",
        );
      }
      if (!(profileId in stored.apiKeys)) return;
      const apiKeys = { ...stored.apiKeys };
      delete apiKeys[profileId];
      await this.#writeStored({ version: 2, apiKeys });
    });
  }

  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #encrypt(apiKey: string): string {
    this.#requireEncryption();
    try {
      return this.#encryption.encryptString(apiKey).toString("base64");
    } catch {
      throw new Error("Could not encrypt the Provider API key");
    }
  }

  #decrypt(encrypted: string): string {
    this.#requireEncryption();
    let value: string;
    try {
      value = this.#encryption.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      throw new Error("Could not decrypt a Provider API key");
    }
    if (value.length === 0)
      throw new Error("ZenX credential vault contained an empty API key");
    return value;
  }

  #requireEncryption(): void {
    if (!this.#encryption.isEncryptionAvailable()) {
      throw new Error(
        "Operating-system credential encryption is unavailable; unlock the system keychain and try again",
      );
    }
  }

  async #readStored(): Promise<StoredVault | undefined> {
    let handle;
    try {
      handle = await open(this.#filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile())
        throw new Error("ZenX credential vault is not a regular file");
      if (process.platform !== "win32" && (metadata.mode & 0o044) !== 0) {
        throw new Error("ZenX credential vault permissions are too broad");
      }
      const stored: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!isStoredVault(stored))
        throw new Error("ZenX credential vault is invalid");
      return stored;
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("ZenX credential vault is invalid");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async #writeStored(stored: StoredVaultV2): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(stored)}\n`, {
        mode: 0o600,
        encoding: "utf8",
      });
      await rename(temporary, this.#filePath);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}

function validateProfileId(value: string): string {
  const id = value.trim();
  if (
    id.length === 0 ||
    id.length > MAX_PROFILE_ID_LENGTH ||
    /[\u0000-\u001f]/u.test(id)
  ) {
    throw new Error("Provider profile id is invalid");
  }
  return id;
}

function isStoredVault(value: unknown): value is StoredVault {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.version === 1) return isEncryptedValue(record.apiKey);
  if (
    record.version !== 2 ||
    typeof record.apiKeys !== "object" ||
    record.apiKeys === null ||
    Array.isArray(record.apiKeys)
  ) {
    return false;
  }
  const entries = Object.entries(record.apiKeys);
  return (
    entries.length <= MAX_CREDENTIALS &&
    entries.every(
      ([id, encrypted]) =>
        validateStoredProfileId(id) && isEncryptedValue(encrypted),
    )
  );
}

function validateStoredProfileId(id: string): boolean {
  return (
    id.trim() === id &&
    id.length > 0 &&
    id.length <= MAX_PROFILE_ID_LENGTH &&
    !/[\u0000-\u001f]/u.test(id)
  );
}

function isEncryptedValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 * 1024 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  );
}
