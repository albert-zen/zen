import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThreadSnapshot } from "./app-server-protocol.js";

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
    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const target = join(this.dir, `${safeFileName(thread.id)}.json`);
      await writeFile(target, `${JSON.stringify(thread, null, 2)}\n`, "utf8");
    });

    await this.pendingWrite;
  }
}

async function readSnapshotFile(
  path: string
): Promise<ThreadSnapshot | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ThreadSnapshot;
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      return undefined;
    }

    throw cause;
  }
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
