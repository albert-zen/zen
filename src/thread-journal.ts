import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Item } from "./item-list.js";

const JOURNAL_VERSION = 1;

export type ThreadJournalReplay =
  | { readonly type: "success"; readonly threadId: string; readonly path: string; readonly items: readonly Item[] }
  | { readonly type: "failure"; readonly path: string; readonly threadId?: string; readonly error: ThreadJournalCorruptionError };

export interface ThreadJournal {
  create(threadId: string, item: Item): Promise<void>;
  append(threadId: string, item: Item): Promise<void>;
  flush(threadId: string): Promise<void>;
  replay(): Promise<readonly ThreadJournalReplay[]>;
  close(): Promise<void>;
}

export class ThreadJournalError extends Error {
  constructor(
    readonly threadId: string,
    readonly operation: "create" | "append" | "flush" | "close",
    cause: unknown
  ) {
    super(`Thread journal ${operation} failed for ${threadId}: ${readMessage(cause)}`, { cause });
    this.name = "ThreadJournalError";
  }
}

export class ThreadJournalCorruptionError extends Error {
  constructor(readonly path: string, readonly recordNumber: number, message: string) {
    super(`Thread journal corruption at ${path}, record ${recordNumber}: ${message}`);
    this.name = "ThreadJournalCorruptionError";
  }
}

type FileHandle = {
  write(buffer: Buffer, position?: number | null): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
  truncate(len?: number): Promise<void>;
};

export type ThreadJournalFileSystem = {
  mkdir(path: string, options: { readonly recursive: true }): Promise<string | undefined>;
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<readonly { readonly name: string; isFile(): boolean }[]>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  open(path: string, flags: string): Promise<FileHandle>;
};

export type FileThreadJournalOptions = {
  readonly dir?: string;
  readonly fileSystem?: ThreadJournalFileSystem;
};

type ThreadWriter = {
  tail: Promise<void>;
  handle?: FileHandle;
  failure?: ThreadJournalError;
};

export class FileThreadJournal implements ThreadJournal {
  private readonly dir: string;
  private readonly fileSystem: ThreadJournalFileSystem;
  private readonly writers = new Map<string, ThreadWriter>();
  private closed = false;

  constructor(options: FileThreadJournalOptions = {}) {
    this.dir = options.dir ?? join(homedir(), ".zen", "threads");
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
  }

  create(threadId: string, item: Item): Promise<void> {
    assertCreatedItem(threadId, item);
    const line = encodeRecord(item);
    return this.enqueue(threadId, "create", async (writer) => {
      await this.fileSystem.mkdir(this.dir, { recursive: true });
      writer.handle = await this.fileSystem.open(this.pathFor(threadId), "wx");
      await writeAll(writer.handle, line);
      await writer.handle.sync();
    });
  }

  append(threadId: string, item: Item): Promise<void> {
    const line = encodeRecord(item);
    return this.enqueue(threadId, "append", async (writer) => {
      if (!writer.handle) {
        writer.handle = await this.fileSystem.open(this.pathFor(threadId), "a");
      }
      await writeAll(writer.handle, line);
    });
  }

  flush(threadId: string): Promise<void> {
    return this.enqueue(threadId, "flush", async (writer) => {
      if (writer.handle) await writer.handle.sync();
    });
  }

  async replay(): Promise<readonly ThreadJournalReplay[]> {
    let entries: readonly { readonly name: string; isFile(): boolean }[];
    try {
      entries = await this.fileSystem.readdir(this.dir, { withFileTypes: true });
    } catch (cause) {
      if (isMissing(cause)) return [];
      throw cause;
    }

    return await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => this.replayFile(entry.name)));
  }

  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.writers.entries()].map(async ([threadId, writer]) => {
      await writer.tail;
      if (writer.failure) throw writer.failure;
      if (!writer.handle) return;
      await writer.handle.sync();
      await writer.handle.close();
      writer.handle = undefined;
    }));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Failed to close one or more thread journals");
  }

  private enqueue(threadId: string, operation: ThreadJournalError["operation"], action: (writer: ThreadWriter) => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new ThreadJournalError(threadId, operation, new Error("Journal is closed")));
    const writer = this.writers.get(threadId) ?? { tail: Promise.resolve() };
    this.writers.set(threadId, writer);
    if (writer.failure) return Promise.reject(writer.failure);

    const operationPromise = writer.tail.then(async () => {
      if (writer.failure) throw writer.failure;
      try {
        await action(writer);
      } catch (cause) {
        const failure = cause instanceof ThreadJournalError ? cause : new ThreadJournalError(threadId, operation, cause);
        writer.failure = failure;
        throw failure;
      }
    });
    writer.tail = operationPromise.catch(() => undefined);
    return operationPromise;
  }

  private async replayFile(name: string): Promise<ThreadJournalReplay> {
    const path = join(this.dir, name);
    const threadId = decodeFileName(name);
    if (!threadId) return { type: "failure", path, error: new ThreadJournalCorruptionError(path, 0, "invalid journal filename") };
    try {
      const text = await this.fileSystem.readFile(path, "utf8");
      const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
      if (complete.length !== text.length) await this.repairTail(path, Buffer.byteLength(complete));
      const items = complete.length === 0 ? [] : complete.slice(0, -1).split("\n").map((line, index) => decodeRecord(line, path, index + 1));
      if (items[0]?.type !== "thread.created" || items[0]?.payload === undefined) {
        throw new ThreadJournalCorruptionError(path, 1, "first record must be thread.created");
      }
      if (!isCreatedForThread(items[0], threadId)) throw new ThreadJournalCorruptionError(path, 1, "thread.created does not match filename thread id");
      return { type: "success", threadId, path, items };
    } catch (cause) {
      return { type: "failure", path, threadId, error: cause instanceof ThreadJournalCorruptionError ? cause : new ThreadJournalCorruptionError(path, 0, readMessage(cause)) };
    }
  }

  private async repairTail(path: string, length: number): Promise<void> {
    const handle = await this.fileSystem.open(path, "r+");
    try { await handle.truncate(length); await handle.sync(); } finally { await handle.close(); }
  }

  private pathFor(threadId: string): string { return join(this.dir, fileNameFor(threadId)); }
}

const nodeFileSystem: ThreadJournalFileSystem = { mkdir, readdir, readFile, open };

function encodeRecord(item: Item): Buffer { return Buffer.from(`${JSON.stringify({ version: JOURNAL_VERSION, item })}\n`, "utf8"); }
function decodeRecord(line: string, path: string, recordNumber: number): Item {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new ThreadJournalCorruptionError(path, recordNumber, "invalid JSON"); }
  if (!isRecord(value) || value.version !== JOURNAL_VERSION || !isItem(value.item)) throw new ThreadJournalCorruptionError(path, recordNumber, "invalid versioned Item envelope");
  return value.item;
}
function assertCreatedItem(threadId: string, item: Item): void {
  if (item.type !== "thread.created" || !isCreatedForThread(item, threadId)) throw new Error("Thread journal creation requires a matching thread.created Item");
}
function isCreatedForThread(item: Item, threadId: string): boolean { return isRecord(item.payload) && item.payload.threadId === threadId; }
function isItem(value: unknown): value is Item { return isRecord(value) && typeof value.id === "string" && typeof value.type === "string" && typeof value.createdAtMs === "number" && typeof value.seq === "number" && typeof value.runId === "string" && typeof value.turnId === "string" && "payload" in value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fileNameFor(threadId: string): string { if (threadId.length === 0) throw new Error("Thread id must not be empty"); return `thread-${Buffer.from(threadId, "utf8").toString("base64url")}.jsonl`; }
function decodeFileName(name: string): string | undefined { const match = /^thread-([A-Za-z0-9_-]+)\.jsonl$/.exec(name); if (!match) return undefined; const id = Buffer.from(match[1], "base64url").toString("utf8"); return id.length > 0 && fileNameFor(id) === name ? id : undefined; }
async function writeAll(handle: FileHandle, line: Buffer): Promise<void> { let offset = 0; while (offset < line.byteLength) { const { bytesWritten } = await handle.write(line.subarray(offset), null); if (bytesWritten <= 0) throw new Error("File write accepted zero bytes"); offset += bytesWritten; } }
function isMissing(cause: unknown): boolean { return isRecord(cause) && cause.code === "ENOENT"; }
function readMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
