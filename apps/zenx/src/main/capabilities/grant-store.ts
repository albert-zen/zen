import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ZenXCapabilityGrant, ZenXCapabilityGrantStore } from "./types.js";

interface GrantFile {
  version: 1;
  grants: Record<string, ZenXCapabilityGrant[]>;
}

export class JsonZenXCapabilityGrantStore implements ZenXCapabilityGrantStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async load(): Promise<Record<string, ZenXCapabilityGrant[]>> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isGrantFile(parsed)) {
      throw new Error("ZenX capability grant file is invalid");
    }
    return structuredClone(parsed.grants);
  }

  async save(
    grants: Readonly<Record<string, ZenXCapabilityGrant[]>>,
  ): Promise<void> {
    await mkdir(path.dirname(this.#filePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.#filePath}.${String(process.pid)}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, grants } satisfies GrantFile, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.#filePath);
  }
}

export class MemoryZenXCapabilityGrantStore implements ZenXCapabilityGrantStore {
  #grants: Record<string, ZenXCapabilityGrant[]> = {};

  async load(): Promise<Record<string, ZenXCapabilityGrant[]>> {
    return structuredClone(this.#grants);
  }

  async save(
    grants: Readonly<Record<string, ZenXCapabilityGrant[]>>,
  ): Promise<void> {
    this.#grants = structuredClone(grants);
  }
}

function isGrantFile(value: unknown): value is GrantFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.grants)) {
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
