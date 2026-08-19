import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ZenXCapabilityConfiguration,
  ZenXCapabilityConfigurationStore,
  ZenXCapabilityGrant,
} from "./types.js";

interface CapabilityConfigurationFile {
  version: 2;
  grants: Record<string, ZenXCapabilityGrant[]>;
  disabled: string[];
}

export class JsonZenXCapabilityGrantStore implements ZenXCapabilityConfigurationStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async load(): Promise<ZenXCapabilityConfiguration> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { grants: {}, disabled: [] };
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isCapabilityConfigurationFile(parsed)) {
      throw new Error("ZenX capability grant file is invalid");
    }
    if (parsed.version === 1) {
      return { grants: structuredClone(parsed.grants), disabled: [] };
    }
    return {
      grants: structuredClone(parsed.grants),
      disabled: [...parsed.disabled],
    };
  }

  async save(configuration: ZenXCapabilityConfiguration): Promise<void> {
    await mkdir(path.dirname(this.#filePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.#filePath}.${String(process.pid)}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          version: 2,
          grants: configuration.grants,
          disabled: configuration.disabled,
        } satisfies CapabilityConfigurationFile,
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.#filePath);
  }
}

export class MemoryZenXCapabilityGrantStore implements ZenXCapabilityConfigurationStore {
  #configuration: ZenXCapabilityConfiguration = { grants: {}, disabled: [] };

  async load(): Promise<ZenXCapabilityConfiguration> {
    return structuredClone(this.#configuration);
  }

  async save(configuration: ZenXCapabilityConfiguration): Promise<void> {
    this.#configuration = structuredClone(configuration);
  }
}

function isCapabilityConfigurationFile(
  value: unknown,
): value is
  | { version: 1; grants: Record<string, ZenXCapabilityGrant[]> }
  | CapabilityConfigurationFile {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !isRecord(value.grants)
  ) {
    return false;
  }
  if (
    value.version === 2 &&
    (!Array.isArray(value.disabled) ||
      value.disabled.some((id) => typeof id !== "string" || id.length === 0))
  ) {
    return false;
  }
  return Object.values(value.grants).every(
    (grants) =>
      Array.isArray(grants) &&
      grants.every(
        (grant) =>
          isRecord(grant) &&
          typeof grant.permissionId === "string" &&
          (grant.scope === "browser-session" ||
            grant.scope === "local-device" ||
            grant.scope === "workspace"),
      ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
