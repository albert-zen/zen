import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ZenXThreadTitleOwnershipTransaction } from "./thread-title-ownership-transaction.js";
import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "./thread-title-types.js";

export interface ZenXThreadTitleStoreFileSystem {
  mkdir(
    directory: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
  writeFile(
    file: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(file: string, options: { force: true }): Promise<void>;
}

/**
 * Custom title stores must implement this ownership-aware contract. `claim`
 * synchronously supersedes the prior root owner before its serialized read;
 * every instance for the same durable projection shares that serialized
 * ownership domain, and `commit` never publishes a non-current owner.
 */
export interface ZenXThreadTitleOwnershipStore {
  claim(
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<ThreadTitleSnapshot>;
  commit(
    snapshot: ThreadTitleSnapshot,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<boolean>;
}

const nodeFileSystem: ZenXThreadTitleStoreFileSystem = {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
};

const protocols = new Map<string, ZenXThreadTitleStoreProtocol>();

export class ZenXThreadTitleStore implements ZenXThreadTitleOwnershipStore {
  readonly #protocol: ZenXThreadTitleStoreProtocol;

  constructor(
    filePath: string,
    options: { fileSystem?: ZenXThreadTitleStoreFileSystem } = {},
  ) {
    const resolved = path.resolve(filePath);
    const existing = protocols.get(resolved);
    if (existing !== undefined) {
      this.#protocol = existing;
      return;
    }
    this.#protocol = new ZenXThreadTitleStoreProtocol(
      resolved,
      options.fileSystem ?? nodeFileSystem,
    );
    protocols.set(resolved, this.#protocol);
  }

  claim(
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<ThreadTitleSnapshot> {
    return this.#protocol.claim(owner);
  }

  commit(
    snapshot: ThreadTitleSnapshot,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<boolean> {
    return this.#protocol.commit(snapshot, owner);
  }
}

class ZenXThreadTitleStoreProtocol {
  readonly #filePath: string;
  readonly #fileSystem: ZenXThreadTitleStoreFileSystem;
  #currentRoot: ZenXThreadTitleOwnershipTransaction | undefined;
  #tail = Promise.resolve();
  #failure: Error | undefined;
  #temporarySequence = 0;

  constructor(filePath: string, fileSystem: ZenXThreadTitleStoreFileSystem) {
    this.#filePath = filePath;
    this.#fileSystem = fileSystem;
  }

  claim(
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<ThreadTitleSnapshot> {
    const root = owner.root;
    if (this.#currentRoot !== root) {
      const previous = this.#currentRoot;
      this.#currentRoot = root;
      if (previous !== undefined) void previous.retire();
    }
    const operation = this.#serial(async () => {
      this.#assertHealthy();
      if (!this.#owns(owner))
        throw new Error("Title ownership changed before the store read");
      return await this.#readSnapshot();
    });
    return owner.track(operation);
  }

  commit(
    snapshot: ThreadTitleSnapshot,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<boolean> {
    const operation = this.#serial(async () => {
      this.#assertHealthy();
      if (!this.#owns(owner)) return false;
      return await this.#commitSnapshot(snapshot, owner);
    });
    return owner.track(operation);
  }

  async #commitSnapshot(
    snapshot: ThreadTitleSnapshot,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<boolean> {
    const directory = path.dirname(this.#filePath);
    const temporary = this.#temporaryPath(owner, "stage");
    let staged = false;
    let primaryError: unknown;
    try {
      await this.#fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
      if (!this.#owns(owner)) return false;
      const previous = await this.#readRaw();
      if (!this.#owns(owner)) return false;
      staged = true;
      await this.#fileSystem.writeFile(
        temporary,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      if (!this.#owns(owner)) return false;
      await this.#fileSystem.rename(temporary, this.#filePath);
      staged = false;
      if (this.#owns(owner)) return true;
      try {
        await this.#restore(previous, owner);
      } catch (error) {
        const failure = new Error(
          `ZenX title-store ownership compensation failed: ${describeError(error)}`,
          { cause: error },
        );
        this.#failure = failure;
        throw failure;
      }
      return false;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (staged) {
        try {
          await this.#fileSystem.rm(temporary, { force: true });
        } catch (cleanupError) {
          if (primaryError === undefined) throw cleanupError;
          this.#failure = new AggregateError(
            [primaryError, cleanupError],
            "ZenX title-store write and staged-file cleanup failed",
          );
        }
      }
    }
  }

  async #restore(
    previous: string | undefined,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<void> {
    if (previous === undefined) {
      await this.#fileSystem.rm(this.#filePath, { force: true });
      return;
    }
    const temporary = this.#temporaryPath(owner, "compensate");
    let staged = false;
    try {
      staged = true;
      await this.#fileSystem.writeFile(temporary, previous, {
        encoding: "utf8",
        mode: 0o600,
      });
      await this.#fileSystem.rename(temporary, this.#filePath);
      staged = false;
    } finally {
      if (staged) await this.#fileSystem.rm(temporary, { force: true });
    }
  }

  async #readSnapshot(): Promise<ThreadTitleSnapshot> {
    const raw = await this.#readRaw();
    if (raw === undefined) return {};
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value))
        throw new Error("ZenX thread title store is invalid");
      return Object.fromEntries(
        Object.entries(value).map(([threadId, projection]) => [
          threadId,
          validateProjection(threadId, projection),
        ]),
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("ZenX thread title store contains invalid JSON");
      throw error;
    }
  }

  async #readRaw(): Promise<string | undefined> {
    try {
      return await this.#fileSystem.readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  #owns(owner: ZenXThreadTitleOwnershipTransaction): boolean {
    return this.#currentRoot === owner.root && owner.isCurrent();
  }

  #temporaryPath(
    owner: ZenXThreadTitleOwnershipTransaction,
    phase: string,
  ): string {
    this.#temporarySequence += 1;
    return `${this.#filePath}.${process.pid}.${owner.id}.${String(
      this.#temporarySequence,
    )}.${phase}.tmp`;
  }

  #assertHealthy(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function validateProjection(
  threadId: string,
  value: unknown,
): ThreadTitleProjection {
  if (
    !isRecord(value) ||
    value.threadId !== threadId ||
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    typeof value.source !== "string" ||
    value.source.length === 0 ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    !["provisional", "generating", "generated", "manual", "failed"].includes(
      String(value.status),
    ) ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new Error(`ZenX thread title projection ${threadId} is invalid`);
  }
  return value as unknown as ThreadTitleProjection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
