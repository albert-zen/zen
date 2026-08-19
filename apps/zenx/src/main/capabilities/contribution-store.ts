import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ZenXCapabilityContributionStore {
  load(): Promise<Record<string, boolean>>;
  save(values: Readonly<Record<string, boolean>>): Promise<void>;
}

export class JsonZenXCapabilityContributionStore
  implements ZenXCapabilityContributionStore
{
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async load(): Promise<Record<string, boolean>> {
    let contents: string;
    try {
      contents = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.enabled)) {
      throw new Error("ZenX UI contribution state is invalid");
    }
    const enabled = value.enabled;
    if (!Object.values(enabled).every((item) => typeof item === "boolean")) {
      throw new Error("ZenX UI contribution state is invalid");
    }
    return structuredClone(enabled as Record<string, boolean>);
  }

  async save(values: Readonly<Record<string, boolean>>): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, enabled: values }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.#filePath);
  }
}

export class InMemoryZenXCapabilityContributionStore
  implements ZenXCapabilityContributionStore
{
  #values: Record<string, boolean> = {};

  async load(): Promise<Record<string, boolean>> {
    return structuredClone(this.#values);
  }

  async save(values: Readonly<Record<string, boolean>>): Promise<void> {
    this.#values = structuredClone(values);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
