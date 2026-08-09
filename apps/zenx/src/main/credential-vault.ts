import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LocalEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface StoredVault {
  version: 1;
  apiKey: string;
}

export class ZenXCredentialVault {
  readonly #filePath: string;
  readonly #encryption: LocalEncryption;

  constructor(filePath: string, encryption: LocalEncryption) {
    this.#filePath = path.resolve(filePath);
    this.#encryption = encryption;
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.readApiKey()) !== undefined;
  }

  async readApiKey(): Promise<string | undefined> {
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
      const stored = JSON.parse(await handle.readFile("utf8")) as unknown;
      if (!isStoredVault(stored))
        throw new Error("ZenX credential vault is invalid");
      if (!this.#encryption.isEncryptionAvailable()) {
        throw new Error(
          "Operating-system credential encryption is unavailable",
        );
      }
      const value = this.#encryption.decryptString(
        Buffer.from(stored.apiKey, "base64"),
      );
      if (value.length === 0)
        throw new Error("ZenX credential vault contained an empty API key");
      return value;
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("ZenX credential vault is invalid");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async writeApiKey(apiKey: string): Promise<void> {
    if (apiKey.trim().length === 0) throw new Error("API key cannot be empty");
    if (!this.#encryption.isEncryptionAvailable()) {
      throw new Error(
        "Operating-system credential encryption is unavailable; unlock the system keychain and try again",
      );
    }
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stored: StoredVault = {
      version: 1,
      apiKey: this.#encryption.encryptString(apiKey).toString("base64"),
    };
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, {
      mode: 0o600,
      encoding: "utf8",
    });
    await rename(temporary, this.#filePath);
  }

  async clearApiKey(): Promise<void> {
    await unlink(this.#filePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

function isStoredVault(value: unknown): value is StoredVault {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { apiKey?: unknown }).apiKey === "string"
  );
}
