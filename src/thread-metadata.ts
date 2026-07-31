import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

export interface ThreadProductMetadata {
  name?: string;
}

export interface ThreadMetadataStore {
  read(threadId: string): Promise<ThreadProductMetadata>;
  setName(threadId: string, name: string): Promise<ThreadProductMetadata>;
}

interface ThreadNameSetEvent {
  type: "thread_name_set";
  threadId: string;
  name: string;
  updatedAt: string;
}

export class InMemoryThreadMetadataStore implements ThreadMetadataStore {
  readonly #metadata = new Map<string, ThreadProductMetadata>();

  async read(threadId: string): Promise<ThreadProductMetadata> {
    return structuredClone(this.#metadata.get(threadId) ?? {});
  }

  async setName(
    threadId: string,
    name: string,
  ): Promise<ThreadProductMetadata> {
    const metadata = { name };
    this.#metadata.set(threadId, metadata);
    return structuredClone(metadata);
  }
}

export class JsonlThreadMetadataStore implements ThreadMetadataStore {
  readonly #filename: string;
  readonly #metadata = new Map<string, ThreadProductMetadata>();
  #loadPromise: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(filename: string) {
    this.#filename = path.resolve(filename);
  }

  async read(threadId: string): Promise<ThreadProductMetadata> {
    await this.#load();
    return structuredClone(this.#metadata.get(threadId) ?? {});
  }

  async setName(
    threadId: string,
    name: string,
  ): Promise<ThreadProductMetadata> {
    await this.#load();
    const event: ThreadNameSetEvent = {
      type: "thread_name_set",
      threadId,
      name,
      updatedAt: new Date().toISOString(),
    };
    const write = this.#writeChain.then(async () => {
      await mkdir(path.dirname(this.#filename), { recursive: true });
      const file = await open(this.#filename, "a", 0o600);
      try {
        await file.write(`${JSON.stringify(event)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      this.#metadata.set(threadId, { name });
    });
    this.#writeChain = write.catch(() => undefined);
    await write;
    return { name };
  }

  async #load(): Promise<void> {
    const load = this.#loadPromise ?? this.#loadFile();
    this.#loadPromise = load;
    try {
      await load;
    } catch (error) {
      if (this.#loadPromise === load) {
        this.#loadPromise = undefined;
      }
      throw error;
    }
  }

  async #loadFile(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.#filename, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const [index, line] of contents.split("\n").entries()) {
      if (line.length === 0) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        console.warn(
          `Ignoring invalid JSON in ${this.#filename} at line ${String(index + 1)}`,
        );
        continue;
      }
      if (!isThreadNameSetEvent(event)) {
        console.warn(
          `Ignoring invalid thread metadata in ${this.#filename} at line ${String(index + 1)}`,
        );
        continue;
      }
      this.#metadata.set(event.threadId, { name: event.name });
    }
  }
}

export function normalizeThreadName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    throw new Error("Thread name must not be empty");
  }
  if (normalized.length > 200) {
    throw new Error("Thread name must not exceed 200 characters");
  }
  return normalized;
}

function isThreadNameSetEvent(value: unknown): value is ThreadNameSetEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "thread_name_set" &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    value.threadId.length > 0 &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
