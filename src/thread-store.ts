import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThreadSnapshot } from "./app-server-protocol.js";

const THREAD_STORE_SCHEMA_VERSION = 1;

export interface ThreadStore {
  list(): Promise<readonly ThreadSnapshot[]>;
  save(thread: ThreadSnapshot): Promise<void>;
}

export type FileThreadStoreOptions = {
  readonly dir?: string;
};

export class FileThreadStore implements ThreadStore {
  private readonly dir: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(options: FileThreadStoreOptions = {}) {
    this.dir = options.dir ?? join(homedir(), ".zen", "threads");
  }

  async list(): Promise<readonly ThreadSnapshot[]> {
    await this.pendingWrite;

    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      const snapshots = (
        await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => readSnapshotFile(join(this.dir, entry.name)))
        )
      ).filter((thread): thread is ThreadSnapshot => Boolean(thread));

      return snapshots.sort((left, right) => latestMs(right) - latestMs(left));
    } catch (cause) {
      if (isMissingFile(cause)) {
        return [];
      }

      throw cause;
    }
  }

  async save(thread: ThreadSnapshot): Promise<void> {
    const write = this.pendingWrite.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const target = join(this.dir, `${safeFileName(thread.id)}.json`);
      const temp = join(
        this.dir,
        `${safeFileName(thread.id)}.${randomUUID()}.tmp`
      );

      try {
        await writeFile(
          temp,
          `${JSON.stringify(encodeThreadFile(thread), null, 2)}\n`,
          "utf8"
        );
        await replaceFile(temp, target);
      } catch (cause) {
        await unlink(temp).catch(() => undefined);
        throw cause;
      }
    });
    this.pendingWrite = write.catch(() => undefined);

    await write;
  }
}

async function replaceFile(temp: string, target: string): Promise<void> {
  try {
    await rename(temp, target);
  } catch (cause) {
    if (!isWindowsReplaceError(cause)) {
      throw cause;
    }

    await replaceFileWithBackup(temp, target);
  }
}

async function replaceFileWithBackup(
  temp: string,
  target: string
): Promise<void> {
  const backup = `${target}.${randomUUID()}.backup.tmp`;

  // Some Windows filesystems reject rename-over-existing. Moving the previous
  // target aside lets a failed final replacement restore the last good snapshot
  // before same-store callers can observe the result.
  try {
    await rename(target, backup);
  } catch (cause) {
    if (!isMissingFile(cause)) {
      throw cause;
    }

    await rename(temp, target);
    return;
  }

  try {
    await rename(temp, target);
  } catch (cause) {
    await rename(backup, target).catch((restoreCause: unknown) => {
      throw new AggregateError(
        [cause, restoreCause],
        "Failed to replace thread snapshot and restore previous snapshot"
      );
    });
    throw cause;
  }

  await unlink(backup).catch(() => undefined);
}

async function readSnapshotFile(
  path: string
): Promise<ThreadSnapshot | undefined> {
  try {
    return decodeThreadFile(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

function encodeThreadFile(thread: ThreadSnapshot): StoredThreadFile {
  return { schemaVersion: THREAD_STORE_SCHEMA_VERSION, thread };
}

type StoredThreadFile = {
  readonly schemaVersion: typeof THREAD_STORE_SCHEMA_VERSION;
  readonly thread: ThreadSnapshot;
};

function decodeThreadFile(value: unknown): ThreadSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.schemaVersion === THREAD_STORE_SCHEMA_VERSION) {
    return isThreadSnapshot(value.thread) ? value.thread : undefined;
  }

  return isThreadSnapshot(value) ? value : undefined;
}

function isThreadSnapshot(value: unknown): value is ThreadSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.status === "idle" ||
      value.status === "running" ||
      value.status === "failed") &&
    Array.isArray(value.turns) &&
    Array.isArray(value.items)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function latestMs(thread: ThreadSnapshot): number {
  return thread.items.reduce(
    (latest, item) => Math.max(latest, item.createdAtMs),
    0
  );
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

function isWindowsReplaceError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause.code === "EPERM" || cause.code === "EEXIST")
  );
}
