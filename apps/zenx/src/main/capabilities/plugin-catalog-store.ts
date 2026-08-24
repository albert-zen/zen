import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ZenXPluginCatalogState,
  ZenXPluginCatalogStore,
} from "./types.js";

type PluginCatalogFile = {
  version: 5;
  disabled: string[];
  uninstalled: string[];
  packages: ZenXPluginCatalogState["packages"];
  profileGeneration?: string;
};

/**
 * Reads the historical capability-grants.json location so existing enablement,
 * uninstall, package, and generation facts survive profile adoption. Legacy
 * permission grants are validated and discarded; runtime admission ignores them.
 */
export class JsonZenXPluginCatalogStore implements ZenXPluginCatalogStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async load(): Promise<ZenXPluginCatalogState> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyCatalog();
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isCatalogFile(parsed)) {
      throw new Error("ZenX plugin catalog file is invalid");
    }
    if (parsed.version === 1) return emptyCatalog();
    if (parsed.version === 2) {
      return { disabled: [...parsed.disabled], uninstalled: [], packages: {} };
    }
    return {
      disabled: [...parsed.disabled],
      uninstalled: [...parsed.uninstalled],
      packages: structuredClone(parsed.packages),
      ...(parsed.version >= 4 && parsed.profileGeneration !== undefined
        ? { profileGeneration: parsed.profileGeneration }
        : {}),
    };
  }

  async save(configuration: ZenXPluginCatalogState): Promise<void> {
    await mkdir(path.dirname(this.#filePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.#filePath}.${String(process.pid)}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          version: 5,
          disabled: configuration.disabled,
          uninstalled: configuration.uninstalled ?? [],
          packages: configuration.packages ?? {},
          ...(configuration.profileGeneration === undefined
            ? {}
            : { profileGeneration: configuration.profileGeneration }),
        } satisfies PluginCatalogFile,
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.#filePath);
  }
}

export class MemoryZenXPluginCatalogStore implements ZenXPluginCatalogStore {
  #configuration: ZenXPluginCatalogState;

  constructor(initial: ZenXPluginCatalogState = emptyCatalog()) {
    this.#configuration = structuredClone(initial);
  }

  async load(): Promise<ZenXPluginCatalogState> {
    return structuredClone(this.#configuration);
  }

  async save(configuration: ZenXPluginCatalogState): Promise<void> {
    this.#configuration = structuredClone(configuration);
  }
}

function emptyCatalog(): ZenXPluginCatalogState {
  return { disabled: [], uninstalled: [], packages: {} };
}

function isCatalogFile(value: unknown): value is
  | { version: 1; grants: Record<string, unknown[]> }
  | {
      version: 2;
      grants: Record<string, unknown[]>;
      disabled: string[];
    }
  | {
      version: 3 | 4;
      grants: Record<string, unknown[]>;
      disabled: string[];
      uninstalled: string[];
      packages: ZenXPluginCatalogState["packages"];
      profileGeneration?: string;
    }
  | PluginCatalogFile {
  if (!isRecord(value) || ![1, 2, 3, 4, 5].includes(Number(value.version))) {
    return false;
  }
  if (Number(value.version) <= 4 && !isLegacyGrantMap(value.grants)) {
    return false;
  }
  if (
    Number(value.version) >= 2 &&
    (!Array.isArray(value.disabled) || !value.disabled.every(nonEmptyString))
  ) {
    return false;
  }
  if (
    Number(value.version) >= 3 &&
    (!Array.isArray(value.uninstalled) ||
      !value.uninstalled.every(nonEmptyString) ||
      !isRecord(value.packages))
  ) {
    return false;
  }
  return !(
    Number(value.version) >= 4 &&
    value.profileGeneration !== undefined &&
    (typeof value.profileGeneration !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(value.profileGeneration))
  );
}

function isLegacyGrantMap(value: unknown): value is Record<string, unknown[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (grants) =>
        Array.isArray(grants) &&
        grants.every(
          (grant) =>
            isRecord(grant) &&
            typeof grant.permissionId === "string" &&
            ["browser-session", "local-device", "workspace"].includes(
              String(grant.scope),
            ),
        ),
    )
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
