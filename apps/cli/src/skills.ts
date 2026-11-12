import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  normalizeUserInput,
  type UserInput,
  type UserInputPart,
} from "../../../src/item.js";
import type {
  SkillInputLoader,
  SkillReference,
} from "../../../src/skill-input.js";

export type SkillMode = "manual" | "auto" | "disabled";
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  directory: string;
  source: string;
  mode: SkillMode;
  configurationSource: "default" | "package" | "user";
}
export interface SkillsSnapshot {
  skills: SkillEntry[];
  errors: string[];
  catalogBudgetBytes: number;
}
interface Registration {
  id: string;
  source: string;
  mode?: SkillMode;
}
interface Configuration {
  version: 1;
  entries: Registration[];
}
export const SKILL_CATALOG_BUDGET = 16 * 1024;
export const SKILL_BODY_BUDGET = 128 * 1024;
const IMPORT_BYTES = 64 * 1024 * 1024;

/** Host resource configuration. The only loaded conversation state lives in Items. */
export class SkillsService implements SkillInputLoader {
  readonly #root: string;
  #writes: Promise<unknown> = Promise.resolve();
  constructor(dataDirectory: string) {
    this.#root = path.join(dataDirectory, "skills");
  }
  async #configuration(): Promise<Configuration> {
    let text: string;
    try {
      text = await readFile(path.join(this.#root, "config.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, entries: [] };
      throw error;
    }
    const value = JSON.parse(text) as Configuration;
    if (
      value.version !== 1 ||
      !Array.isArray(value.entries) ||
      value.entries.length > 1000 ||
      value.entries.some(
        (entry) =>
          !/^[a-f0-9-]{36}$/u.test(entry.id) ||
          typeof entry.source !== "string" ||
          (entry.mode !== undefined && !isMode(entry.mode)),
      )
    )
      throw new Error("Invalid Skills configuration");
    return value;
  }
  async #save(config: Configuration): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const temporary = path.join(this.#root, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2));
      await rename(temporary, path.join(this.#root, "config.json"));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(operation);
    this.#writes = result.catch(() => undefined);
    return result;
  }
  async #entry(registration: Registration): Promise<SkillEntry> {
    const directory = path.join(this.#root, registration.id);
    const text = await boundedRead(
      path.join(directory, "SKILL.md"),
      SKILL_BODY_BUDGET,
    );
    const metadata = skillMetadata(text);
    let packageMode: SkillMode | undefined;
    try {
      const value = yamlObject(
        await boundedRead(path.join(directory, "agents", "zen.yaml"), 8192),
      );
      const policy = value.policy;
      if (policy !== undefined) {
        if (
          typeof policy !== "object" ||
          policy === null ||
          Array.isArray(policy)
        )
          throw new Error("Skill policy must be an object");
        const p = policy as Record<string, unknown>;
        if (
          p.model_visible !== undefined &&
          typeof p.model_visible !== "boolean"
        )
          throw new Error("policy.model_visible must be boolean");
        if (p.enabled !== undefined && typeof p.enabled !== "boolean")
          throw new Error("policy.enabled must be boolean");
        packageMode =
          p.enabled === false
            ? "disabled"
            : p.model_visible === true
              ? "auto"
              : "manual";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      ...metadata,
      id: registration.id,
      directory,
      source: registration.source,
      mode: registration.mode ?? packageMode ?? "manual",
      configurationSource:
        registration.mode !== undefined
          ? "user"
          : packageMode !== undefined
            ? "package"
            : "default",
    };
  }
  async list(): Promise<SkillsSnapshot> {
    const config = await this.#configuration();
    const skills: SkillEntry[] = [],
      errors: string[] = [];
    for (const entry of config.entries) {
      try {
        skills.push(await this.#entry(entry));
      } catch (error) {
        errors.push(`${entry.source} (${entry.id}): ${String(error)}`);
      }
    }
    return { skills, errors, catalogBudgetBytes: SKILL_CATALOG_BUDGET };
  }
  async importDirectory(source: string): Promise<SkillEntry> {
    return await this.#mutate(async () => {
      if (typeof source !== "string" || !path.isAbsolute(source))
        throw new Error("Choose an absolute Skill directory");
      await validateTree(source);
      skillMetadata(
        await boundedRead(path.join(source, "SKILL.md"), SKILL_BODY_BUDGET),
      );
      const config = await this.#configuration();
      if (config.entries.length >= 1000)
        throw new Error("Skills import limit is 1000 directories");
      const registration = { id: randomUUID(), source: path.resolve(source) };
      const destination = path.join(this.#root, registration.id);
      await mkdir(this.#root, { recursive: true });
      try {
        await cp(source, destination, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        });
        await validateTree(destination);
        const entry = await this.#entry(registration);
        await this.#save({
          version: 1,
          entries: [...config.entries, registration],
        });
        return entry;
      } catch (error) {
        await rm(destination, { recursive: true, force: true });
        throw error;
      }
    });
  }
  async setMode(id: string, mode: SkillMode | null): Promise<void> {
    await this.#mutate(async () => {
      if (mode !== null && !isMode(mode)) throw new Error("Invalid Skill mode");
      const config = await this.#configuration();
      const entry = config.entries.find((entry) => entry.id === id);
      if (entry === undefined) throw new Error("Skill not found");
      if (mode === null) delete entry.mode;
      else entry.mode = mode;
      await this.#save(config);
    });
  }
  async prepare(
    input: readonly (UserInputPart | SkillReference)[],
  ): Promise<UserInput> {
    const snapshot = await this.list();
    // Broken registered packages must not silently disappear from a send.
    if (snapshot.errors.length > 0) throw new Error(snapshot.errors.join("\n"));
    const result: UserInputPart[] = [];
    let loadedBytes = 0;
    for (const part of input) {
      if (part.type !== "skill") {
        result.push(part);
        continue;
      }
      const entry = snapshot.skills.find((entry) => entry.id === part.id);
      if (entry === undefined) throw new Error(`Skill not found: ${part.id}`);
      if (entry.mode === "disabled")
        throw new Error(`Skill is disabled: ${entry.name}`);
      const filename = path.join(entry.directory, "SKILL.md");
      const text = await boundedRead(filename, SKILL_BODY_BUDGET);
      loadedBytes += Buffer.byteLength(text);
      if (loadedBytes > SKILL_BODY_BUDGET)
        throw new Error(
          `Selected Skills exceed the ${SKILL_BODY_BUDGET}-byte loading budget`,
        );
      const sha256 = createHash("sha256").update(text).digest("hex");
      result.push({
        type: "text",
        text: `Explicitly selected Skill: ${entry.name}\nSource: ${filename}\nOriginal import: ${entry.source}\nSHA-256: ${sha256}\nResolve associated resources relative to: ${entry.directory}\n\n${text}`,
        skillSource: {
          kind: "instruction",
          id: entry.id,
          path: filename,
          sha256,
        },
      });
    }
    const automatic = snapshot.skills.filter((entry) => entry.mode === "auto");
    if (automatic.length > 0) {
      const text =
        "Available Skills (metadata only). Read SKILL.md with a file tool when relevant; resolve resources relative to its directory.\n" +
        automatic
          .map((entry) =>
            JSON.stringify({
              name: entry.name,
              description: entry.description,
              path: path.join(entry.directory, "SKILL.md"),
            }),
          )
          .join("\n");
      if (Buffer.byteLength(text) > SKILL_CATALOG_BUDGET)
        throw new Error(
          `Automatic Skills directory exceeds the ${SKILL_CATALOG_BUDGET}-byte budget; set fewer Skills to automatic`,
        );
      result.push({ type: "text", text, skillSource: { kind: "catalog" } });
    }
    return normalizeUserInput(result);
  }
}
function isMode(value: unknown): value is SkillMode {
  return value === "manual" || value === "auto" || value === "disabled";
}
function yamlObject(text: string): Record<string, unknown> {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
  const value: unknown = document.toJS({ maxAliasCount: 20 });
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected YAML object");
  return value as Record<string, unknown>;
}
function skillMetadata(text: string): { name: string; description: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (match === null)
    throw new Error(
      "SKILL.md requires YAML frontmatter with name and description",
    );
  const value = yamlObject(match[1]!);
  if (
    typeof value.name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value.name)
  )
    throw new Error(
      "Skill name must contain 1–64 letters, digits, hyphens or underscores",
    );
  if (
    typeof value.description !== "string" ||
    value.description.trim().length === 0 ||
    value.description.length > 4096
  )
    throw new Error("Skill description must contain 1–4096 characters");
  return { name: value.name, description: value.description.trim() };
}
async function boundedRead(filename: string, maximum: number): Promise<string> {
  const handle = await open(filename, "r");
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Expected regular file");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > maximum)
      throw new Error(`${filename} exceeds ${maximum}-byte budget`);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, size),
    );
  } finally {
    await handle.close();
  }
}
async function validateTree(root: string): Promise<void> {
  let bytes = 0,
    files = 0;
  async function visit(filename: string, depth: number): Promise<void> {
    if (++files > 4096 || depth > 32)
      throw new Error(
        "Skill import exceeds 4096 entries or 32 directory levels",
      );
    const stat = await lstat(filename);
    if (stat.isSymbolicLink())
      throw new Error(
        "Skill imports cannot contain symbolic links; copy linked resources into the directory first",
      );
    if (stat.isDirectory()) {
      for (const child of await readdir(filename))
        await visit(path.join(filename, child), depth + 1);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > IMPORT_BYTES) throw new Error("Skill import exceeds 64 MiB");
    } else throw new Error("Skill import contains a non-regular file");
  }
  if (!(await lstat(root)).isDirectory())
    throw new Error("Select a Skill directory");
  await visit(root, 0);
}
