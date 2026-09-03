import { mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { decodeCanonicalItem, type CanonicalItem } from "./item.js";

const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ThreadJournal {
  append(item: CanonicalItem): Promise<void>;
  listThreadIds(): Promise<string[]>;
  read(threadId: string): Promise<CanonicalItem[]>;
}

export class ThreadJournalAppendOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ThreadJournalAppendOutcomeUnknownError";
  }
}

export class InMemoryThreadJournal implements ThreadJournal {
  readonly #threads = new Map<string, CanonicalItem[]>();

  async append(item: CanonicalItem): Promise<void> {
    const items = this.#threads.get(item.threadId) ?? [];
    items.push(structuredClone(item));
    this.#threads.set(item.threadId, items);
  }

  async listThreadIds(): Promise<string[]> {
    return [...this.#threads.keys()].sort();
  }

  async read(threadId: string): Promise<CanonicalItem[]> {
    return structuredClone(this.#threads.get(threadId) ?? []);
  }
}

export class JsonlThreadJournal implements ThreadJournal {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
  }

  async append(item: CanonicalItem): Promise<void> {
    validateThreadId(item.threadId);
    await mkdir(this.#directory, { recursive: true });
    const file = await open(this.#pathFor(item.threadId), "a", 0o600);
    try {
      await file.write(`${JSON.stringify(item)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async listThreadIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.#directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name.slice(0, -".jsonl".length))
        .filter((threadId) => THREAD_ID_PATTERN.test(threadId))
        .sort();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async read(threadId: string): Promise<CanonicalItem[]> {
    validateThreadId(threadId);
    let contents: string;
    try {
      contents = await readFile(this.#pathFor(threadId), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const items: CanonicalItem[] = [];
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.length === 0) {
        continue;
      }
      try {
        const item = decodeCanonicalItem(JSON.parse(line));
        if (item.threadId !== threadId) {
          throw new Error(
            `Item belongs to Thread ${item.threadId}, not ${threadId}`,
          );
        }
        items.push(item);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(
            `Invalid JSON in ${this.#pathFor(threadId)} at line ${String(index + 1)}`,
          );
        }
        throw new Error(
          `Invalid canonical Item in ${this.#pathFor(threadId)} at line ${String(index + 1)}: ${describeError(error)}`,
        );
      }
    }
    return items;
  }

  #pathFor(threadId: string): string {
    return path.join(this.#directory, `${threadId}.jsonl`);
  }
}

function validateThreadId(threadId: string): void {
  if (!THREAD_ID_PATTERN.test(threadId)) {
    throw new Error(`Invalid thread id: ${threadId}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
