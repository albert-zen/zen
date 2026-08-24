import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ZenXCapabilityConfiguration,
  ZenXCapabilityConfigurationStore,
  ZenXCapabilityGrant,
} from "./types.js";

type CapabilityConfigurationFile =
  | {
      version: 2;
      grants: Record<string, ZenXCapabilityGrant[]>;
      disabled: string[];
    }
  | {
      version: 3;
      grants: Record<string, ZenXCapabilityGrant[]>;
      disabled: string[];
      uninstalled: string[];
      packages: ZenXCapabilityConfiguration["packages"];
    }
  | {
      version: 4;
      grants: Record<string, ZenXCapabilityGrant[]>;
      disabled: string[];
      uninstalled: string[];
      packages: ZenXCapabilityConfiguration["packages"];
      profileGeneration?: string;
    };

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
        return { grants: {}, disabled: [], uninstalled: [], packages: {} };
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isCapabilityConfigurationFile(parsed)) {
      throw new Error("ZenX capability grant file is invalid");
    }
    if (parsed.version === 1) {
      return {
        grants: structuredClone(parsed.grants),
        disabled: [],
        uninstalled: [],
        packages: {},
      };
    }
    return {
      grants: structuredClone(parsed.grants),
      disabled: [...parsed.disabled],
      uninstalled:
        parsed.version === 3 || parsed.version === 4
          ? [...parsed.uninstalled]
          : [],
      packages:
        parsed.version === 3 || parsed.version === 4
          ? structuredClone(parsed.packages)
          : {},
      ...(parsed.version === 4 && parsed.profileGeneration !== undefined
        ? { profileGeneration: parsed.profileGeneration }
        : {}),
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
          version: 4,
          grants: configuration.grants,
          disabled: configuration.disabled,
          uninstalled: configuration.uninstalled ?? [],
          packages: configuration.packages ?? {},
          ...(configuration.profileGeneration === undefined
            ? {}
            : { profileGeneration: configuration.profileGeneration }),
        } satisfies Extract<CapabilityConfigurationFile, { version: 4 }>,
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.#filePath);
  }
}

export class MemoryZenXCapabilityGrantStore implements ZenXCapabilityConfigurationStore {
  #configuration: ZenXCapabilityConfiguration = {
    grants: {},
    disabled: [],
    uninstalled: [],
    packages: {},
  };

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
    (value.version !== 1 &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4) ||
    !isRecord(value.grants)
  ) {
    return false;
  }
  if (
    (value.version === 2 || value.version === 3 || value.version === 4) &&
    (!Array.isArray(value.disabled) ||
      value.disabled.some((id) => typeof id !== "string" || id.length === 0))
  ) {
    return false;
  }
  if (
    (value.version === 3 || value.version === 4) &&
    (!Array.isArray(value.uninstalled) ||
      value.uninstalled.some(
        (id) => typeof id !== "string" || id.length === 0,
      ) ||
      !isRecord(value.packages))
  ) {
    return false;
  }
  if (
    value.version === 4 &&
    value.profileGeneration !== undefined &&
    (typeof value.profileGeneration !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(value.profileGeneration))
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
