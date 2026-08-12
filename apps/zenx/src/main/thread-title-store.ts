import { realpathSync } from "node:fs";
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
 * ownership domain and stable `ownershipDomain` identity, predecessor
 * retirement rejection is observed before the read, and `commit` never
 * publishes a non-current owner.
 */
export interface ZenXThreadTitleOwnershipStore {
  readonly ownershipDomain: ZenXThreadTitleOwnershipDomain;
  claim(
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<ThreadTitleSnapshot>;
  commit(
    snapshot: ThreadTitleSnapshot,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<boolean>;
}

export interface ZenXThreadTitleOwnershipDomain {
  failure(): Error | undefined;
  onFailure(listener: (failure: Error) => void): () => void;
}

const nodeFileSystem: ZenXThreadTitleStoreFileSystem = {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
};

const MAX_OWNERSHIP_DOMAINS_PER_BACKEND = 64;
const MAX_OWNERSHIP_DOMAIN_FAILURE_LISTENERS = 128;
const nodeFileSystemBackendIdentity = {};
const protocolRegistries = new WeakMap<
  object,
  Map<string, ZenXThreadTitleStoreProtocol>
>();

export interface CanonicalTitleProjectionKeyOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
  realpath?: (candidate: string) => string;
}

/**
 * Resolves aliases through the nearest existing ancestor so the key is stable
 * even before the projection file itself exists.
 */
export function canonicalTitleProjectionKey(
  filePath: string,
  options: CanonicalTitleProjectionKeyOptions = {},
): string {
  return canonicalProjectionPath(filePath, options).key;
}

export class ZenXThreadTitleStore implements ZenXThreadTitleOwnershipStore {
  readonly #protocol: ZenXThreadTitleStoreProtocol;

  get ownershipDomain(): ZenXThreadTitleOwnershipDomain {
    return this.#protocol;
  }

  constructor(
    filePath: string,
    options: {
      fileSystem?: ZenXThreadTitleStoreFileSystem;
      backendIdentity?: object;
    } = {},
  ) {
    if (
      options.fileSystem !== undefined &&
      options.backendIdentity === undefined
    ) {
      throw new Error(
        "Injected title-store fileSystem requires an explicit stable backendIdentity",
      );
    }
    if (
      options.fileSystem === undefined &&
      options.backendIdentity !== undefined
    ) {
      throw new Error(
        "backendIdentity is only valid with an injected title-store fileSystem",
      );
    }
    const backendIdentity =
      options.backendIdentity ?? nodeFileSystemBackendIdentity;
    const canonical = canonicalProjectionPath(filePath);
    this.#protocol = protocolFor(
      backendIdentity,
      canonical.key,
      () =>
        new ZenXThreadTitleStoreProtocol(
          canonical.filePath,
          options.fileSystem ?? nodeFileSystem,
        ),
    );
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

function protocolFor(
  backendIdentity: object,
  projectionKey: string,
  create: () => ZenXThreadTitleStoreProtocol,
): ZenXThreadTitleStoreProtocol {
  let registry = protocolRegistries.get(backendIdentity);
  if (registry === undefined) {
    registry = new Map();
    protocolRegistries.set(backendIdentity, registry);
  }
  const existing = registry.get(projectionKey);
  if (existing !== undefined) return existing;
  if (registry.size >= MAX_OWNERSHIP_DOMAINS_PER_BACKEND) {
    throw new Error(
      `Title ownership-domain registry reached its bounded capacity of ${String(
        MAX_OWNERSHIP_DOMAINS_PER_BACKEND,
      )}`,
    );
  }
  const protocol = create();
  registry.set(projectionKey, protocol);
  return protocol;
}

function canonicalProjectionPath(
  filePath: string,
  options: CanonicalTitleProjectionKeyOptions = {},
): { readonly filePath: string; readonly key: string } {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path;
  const cwd = options.cwd ?? process.cwd();
  const resolveRealpath = options.realpath ?? realpathSync.native;
  const unresolved: string[] = [];
  let cursor = pathApi.resolve(cwd, filePath);
  let canonical: string | undefined;

  while (canonical === undefined) {
    try {
      canonical = resolveRealpath(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = pathApi.dirname(cursor);
      if (parent === cursor) {
        canonical = cursor;
        break;
      }
      unresolved.unshift(pathApi.basename(cursor));
      cursor = parent;
    }
  }
  const physicalPath = pathApi.normalize(
    pathApi.join(canonical, ...unresolved),
  );
  return {
    filePath: physicalPath,
    key: platform === "win32" ? physicalPath.toLowerCase() : physicalPath,
  };
}

class ZenXThreadTitleStoreProtocol {
  readonly #filePath: string;
  readonly #fileSystem: ZenXThreadTitleStoreFileSystem;
  readonly #failureListeners = new Set<(failure: Error) => void>();
  #currentRoot: ZenXThreadTitleOwnershipTransaction | undefined;
  #tail = Promise.resolve();
  #failure: Error | undefined;
  #temporarySequence = 0;

  constructor(filePath: string, fileSystem: ZenXThreadTitleStoreFileSystem) {
    this.#filePath = filePath;
    this.#fileSystem = fileSystem;
  }

  failure(): Error | undefined {
    return this.#failure;
  }

  onFailure(listener: (failure: Error) => void): () => void {
    if (this.#failureListeners.size >= MAX_OWNERSHIP_DOMAIN_FAILURE_LISTENERS) {
      const failure = this.#poisonRetirement(
        new Error(
          `Title ownership domain reached its bounded capacity of ${String(
            MAX_OWNERSHIP_DOMAIN_FAILURE_LISTENERS,
          )} failure listeners`,
        ),
      );
      this.#notifyFailureListener(listener, failure);
      return () => undefined;
    }
    this.#failureListeners.add(listener);
    if (this.#failure !== undefined)
      this.#notifyFailureListener(listener, this.#failure);
    return () => this.#failureListeners.delete(listener);
  }

  claim(
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<ThreadTitleSnapshot> {
    const root = owner.root;
    let retirement: Promise<RetirementOutcome> | undefined;
    if (this.#currentRoot !== root) {
      const previous = this.#currentRoot;
      this.#currentRoot = root;
      root.onRetirementFailure((error) => this.#poisonRetirement(error));
      if (previous !== undefined) retirement = observeRetirement(previous);
    }
    const operation = this.#serial(async () => {
      if (retirement !== undefined) {
        const outcome = await retirement;
        if (!outcome.ok) {
          throw this.#poisonRetirement(outcome.error);
        }
      }
      this.#assertHealthy();
      if (!this.#owns(owner))
        throw new Error("Title ownership changed before the store read");
      const snapshot = await this.#readSnapshot();
      this.#assertHealthy();
      if (!this.#owns(owner))
        throw new Error("Title ownership changed during the store read");
      return snapshot;
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
    return (
      this.#failure === undefined &&
      this.#currentRoot === owner.root &&
      owner.isCurrent()
    );
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

  #poisonRetirement(error: unknown): Error {
    this.#failure ??= new Error(
      `ZenX title-store ownership retirement failed: ${describeError(error)}`,
      { cause: error },
    );
    for (const listener of this.#failureListeners)
      this.#notifyFailureListener(listener, this.#failure);
    return this.#failure;
  }

  #notifyFailureListener(
    listener: (failure: Error) => void,
    failure: Error,
  ): void {
    try {
      listener(failure);
    } catch {
      // The domain remains poisoned even if a transient observer is gone.
    }
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

type RetirementOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error: unknown };

function observeRetirement(
  owner: ZenXThreadTitleOwnershipTransaction,
): Promise<RetirementOutcome> {
  try {
    return owner.retire().then(
      () => {
        const lateFailure = owner.retirementFailure();
        return lateFailure === undefined
          ? { ok: true }
          : { ok: false, error: lateFailure };
      },
      (error: unknown) => ({ ok: false, error }),
    );
  } catch (error) {
    return Promise.resolve({ ok: false, error });
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
