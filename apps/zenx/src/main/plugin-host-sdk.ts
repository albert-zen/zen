import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { writeJournalPayload } from "../../../../src/journal-write.js";
import { syncDirectory } from "../../../../src/storage-files.js";

import type { CanonicalItem, UserInput } from "../../../../src/item.js";
import type { ZenXProjectProjectionEntry } from "./project-projection.js";

export const ZENX_PLUGIN_HOST_SDK_VERSION = 1 as const;
const MAX_STORAGE_VERSION = 1_000;
const MAX_STORAGE_BYTES = 1024 * 1024;

export class PluginStorageReplacementPendingError extends Error {
  constructor() {
    super(
      "Plugin storage replacement is being prepared; this storage operation was not performed",
    );
  }
}

export type PluginStorageValue = Readonly<Record<string, unknown>>;

export interface PluginStorageMigration {
  fromVersion: number;
  toVersion: number;
  migrate(
    value: PluginStorageValue,
  ): PluginStorageValue | Promise<PluginStorageValue>;
}

export interface PluginHostAppServerPort {
  completeTurn(
    threadId: string,
    input: string | UserInput,
  ): Promise<{
    threadId: string;
    turnId: string;
    items: readonly CanonicalItem[];
  }>;
}

export interface ZenXPluginHostSdkV1 {
  readonly version: typeof ZENX_PLUGIN_HOST_SDK_VERSION;
  readonly pluginId: string;
  readonly query: {
    readonly projects: {
      list(): Promise<readonly ZenXProjectProjectionEntry[]>;
    };
  };
  readonly actions: {
    readonly threads: {
      startTurn(input: {
        threadId: string;
        input: string | UserInput;
      }): Promise<{
        threadId: string;
        turnId: string;
        items: readonly CanonicalItem[];
      }>;
    };
  };
  readonly ui: {
    readonly panels: {
      open(input: { panelId: string; threadId: string }): Promise<void>;
    };
    readonly handles: {
      read(handleId: string): Promise<unknown>;
    };
    readonly commands: {
      execute(commandId: string, input?: unknown): Promise<unknown>;
    };
  };
  readonly storage: {
    readonly version: number;
    get(): Promise<PluginStorageValue>;
    set(value: PluginStorageValue): Promise<void>;
  };
}

export type PluginHostSdkRequest =
  | { operation: "ui.panels.open"; panelId: string; threadId: string }
  | { operation: "query.projects.list" }
  | { operation: "storage.get" }
  | { operation: "storage.set"; value: PluginStorageValue }
  | {
      operation: "actions.threads.startTurn";
      threadId: string;
      input: string | UserInput;
    }
  | { operation: "ui.handles.read"; handleId: string }
  | { operation: "ui.commands.execute"; commandId: string; input?: unknown };

export async function executePluginHostSdkRequest(
  sdk: ZenXPluginHostSdkV1,
  request: PluginHostSdkRequest,
): Promise<unknown> {
  switch (request.operation) {
    case "ui.panels.open":
      await sdk.ui.panels.open(request);
      return null;
    case "query.projects.list":
      return await sdk.query.projects.list();
    case "storage.get":
      return await sdk.storage.get();
    case "storage.set":
      await sdk.storage.set(request.value);
      return null;
    case "actions.threads.startTurn":
      return await sdk.actions.threads.startTurn({
        threadId: request.threadId,
        input: request.input,
      });
    case "ui.handles.read":
      return await sdk.ui.handles.read(request.handleId);
    case "ui.commands.execute":
      return await sdk.ui.commands.execute(request.commandId, request.input);
  }
}

export function validatePluginHostSdkRequest(
  value: unknown,
): PluginHostSdkRequest {
  if (!isRecord(value) || typeof value.operation !== "string")
    throw new Error("Plugin Host SDK request is invalid");
  switch (value.operation) {
    case "ui.panels.open":
      if (
        typeof value.panelId !== "string" ||
        !value.panelId ||
        value.panelId.length > 256 ||
        typeof value.threadId !== "string" ||
        !value.threadId ||
        value.threadId.length > 512
      )
        throw new Error("Plugin panel request is invalid");
      return {
        operation: value.operation,
        panelId: value.panelId,
        threadId: value.threadId,
      };
    case "query.projects.list":
    case "storage.get":
      return { operation: value.operation };
    case "storage.set":
      return {
        operation: value.operation,
        value: cloneAndValidate(value.value),
      };
    case "actions.threads.startTurn":
      if (
        typeof value.threadId !== "string" ||
        value.threadId.length === 0 ||
        (typeof value.input !== "string" && !Array.isArray(value.input))
      )
        throw new Error("Plugin Host SDK startTurn request is invalid");
      return {
        operation: value.operation,
        threadId: value.threadId,
        input: structuredClone(value.input) as string | UserInput,
      };
    case "ui.handles.read":
      if (typeof value.handleId !== "string" || value.handleId.length === 0)
        throw new Error("Plugin Host SDK handle request is invalid");
      return { operation: value.operation, handleId: value.handleId };
    case "ui.commands.execute":
      if (typeof value.commandId !== "string" || value.commandId.length === 0)
        throw new Error("Plugin Host SDK command request is invalid");
      return {
        operation: value.operation,
        commandId: value.commandId,
        input: structuredClone(value.input),
      };
    default:
      throw new Error(
        `Unsupported Plugin Host SDK operation: ${value.operation}`,
      );
  }
}

export interface PluginHostUiPort {
  openPanel?(input: { panelId: string; threadId: string }): Promise<void>;
  readHandle(handleId: string): Promise<unknown>;
  executeCommand(commandId: string, input?: unknown): Promise<unknown>;
}

export interface CreateZenXPluginHostSdkOptions {
  pluginId: string;
  storageRoot: string;
  storageVersion: number;
  migrations?: readonly PluginStorageMigration[];
  initialStorage?: PluginStorageValue;
  queryProjects(): Promise<readonly ZenXProjectProjectionEntry[]>;
  appServer: PluginHostAppServerPort;
  ui?: PluginHostUiPort;
  storage?: JsonPluginStorage;
  /** Host-owned format markers may be read, never rewritten by a plugin. */
  storageReadOnly?: boolean;
}

export async function createZenXPluginHostSdk(
  options: CreateZenXPluginHostSdkOptions,
): Promise<ZenXPluginHostSdkV1> {
  const storage =
    options.storage ??
    (await JsonPluginStorage.open({
      pluginId: options.pluginId,
      root: options.storageRoot,
      version: options.storageVersion,
      migrations: options.migrations,
      initialValue: options.initialStorage,
      bindGeneration: true,
    }));
  const ui = options.ui ?? unavailableUiPort;
  return Object.freeze({
    version: ZENX_PLUGIN_HOST_SDK_VERSION,
    pluginId: options.pluginId,
    query: Object.freeze({
      projects: Object.freeze({
        list: async () => structuredClone(await options.queryProjects()),
      }),
    }),
    actions: Object.freeze({
      threads: Object.freeze({
        startTurn: async ({
          threadId,
          input,
        }: {
          threadId: string;
          input: string | UserInput;
        }) => {
          const result = await options.appServer.completeTurn(threadId, input);
          return Object.freeze(structuredClone(result));
        },
      }),
    }),
    ui: Object.freeze({
      panels: Object.freeze({
        open: async (input: { panelId: string; threadId: string }) => {
          const request = validatePluginHostSdkRequest({
            ...input,
            operation: "ui.panels.open",
          });
          if (request.operation !== "ui.panels.open" || !ui.openPanel)
            throw new Error("Plugin panels are unavailable");
          await ui.openPanel(request);
        },
      }),
      handles: Object.freeze({
        read: async (handleId: string) => await ui.readHandle(handleId),
      }),
      commands: Object.freeze({
        execute: async (commandId: string, input?: unknown) =>
          await ui.executeCommand(commandId, input),
      }),
    }),
    storage: Object.freeze({
      version: storage.version,
      get: async () => await storage.get(),
      set: async (value: PluginStorageValue) => {
        if (options.storageReadOnly)
          throw new Error(
            "Host-managed storage is read-only; use the automation service",
          );
        await storage.set(value);
      },
    }),
  });
}

interface StoredPluginData {
  version: number;
  value: PluginStorageValue;
}

export interface PluginStorageFileSystem {
  readFile(filename: string, encoding: "utf8"): Promise<string>;
  mkdir(
    directory: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>;
  writeFile(
    filename: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ): Promise<unknown>;
  rename(source: string, destination: string): Promise<void>;
  unlink(filename: string): Promise<void>;
  /** Required together only for opt-in synced marker writes. */
  openFile?: typeof open;
  syncDirectory?: typeof syncDirectory;
}

const nodeStorageFileSystem: PluginStorageFileSystem = {
  readFile,
  mkdir,
  writeFile,
  rename,
  unlink,
  openFile: open,
  syncDirectory,
};

interface StorageAuthority {
  tail: Promise<void>;
  data: StoredPluginData | undefined;
  generation: symbol;
  staging?: symbol;
  replacementListeners: Set<() => void>;
  writeOutcomeUnknown?: Error;
}

// Host process owns one namespace queue. Weak values do not retain dead test or
// unloaded-plugin namespaces; every live storage handle retains its authority.
const storageAuthorities = new WeakMap<
  PluginStorageFileSystem,
  Map<string, WeakRef<StorageAuthority>>
>();
function storageAuthority(
  fileSystem: PluginStorageFileSystem,
  filename: string,
): StorageAuthority {
  let namespaces = storageAuthorities.get(fileSystem);
  if (!namespaces) storageAuthorities.set(fileSystem, (namespaces = new Map()));
  let authority = namespaces.get(filename)?.deref();
  if (!authority) {
    authority = {
      tail: Promise.resolve(),
      data: undefined,
      generation: Symbol("plugin storage"),
      replacementListeners: new Set(),
    };
    namespaces.set(filename, new WeakRef(authority));
  }
  return authority;
}
function notifyStorageReplacement(authority: StorageAuthority): void {
  for (const listener of authority.replacementListeners) {
    try {
      listener();
    } catch (error) {
      console.error("Plugin storage replacement observer failed", error);
    }
  }
}
function queueStorage<T>(
  authority: StorageAuthority,
  operation: () => Promise<T>,
): Promise<T> {
  const result = authority.tail.then(operation);
  authority.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
interface OpenPluginStorageOptions {
  pluginId: string;
  root: string;
  version: number;
  migrations?: readonly PluginStorageMigration[];
  initialValue?: PluginStorageValue;
  fileSystem?: PluginStorageFileSystem;
  bindGeneration?: boolean;
  /** File sync + repository platform directory-sync contract; default unchanged. */
  syncWrites?: boolean;
}

export class JsonPluginStorage {
  readonly version: number;
  readonly #filename: string;
  readonly #fileSystem: PluginStorageFileSystem;
  readonly #authority: StorageAuthority;
  readonly #generation: symbol | undefined;
  readonly #candidate: symbol | undefined;
  readonly #syncWrites: boolean;

  private constructor(
    filename: string,
    fileSystem: PluginStorageFileSystem,
    authority: StorageAuthority,
    version: number,
    generation?: symbol,
    candidate?: symbol,
    syncWrites = false,
  ) {
    this.#filename = filename;
    this.#fileSystem = fileSystem;
    this.#authority = authority;
    this.version = version;
    this.#generation = generation;
    this.#candidate = candidate;
    this.#syncWrites = syncWrites;
  }

  get replacementPending(): boolean {
    return this.#authority.staging !== undefined;
  }

  onReplacementChange(listener: () => void): () => void {
    this.#authority.replacementListeners.add(listener);
    return () => this.#authority.replacementListeners.delete(listener);
  }

  static async open(
    options: OpenPluginStorageOptions,
  ): Promise<JsonPluginStorage> {
    const { filename, fileSystem, authority } = this.#location(options);
    if (authority.staging)
      throw new Error("Plugin storage replacement is being prepared");
    return await queueStorage(authority, async () => {
      if (authority.writeOutcomeUnknown) throw authority.writeOutcomeUnknown;
      if (authority.staging)
        throw new Error("Plugin storage replacement is being prepared");
      let data: StoredPluginData;
      try {
        ({ data } = await this.#readAndMigrate(options, filename, fileSystem));
      } catch (error) {
        if (error instanceof PluginStorageWriteOutcomeUnknownError)
          authority.writeOutcomeUnknown = error;
        throw error;
      }
      authority.data = data;
      return new JsonPluginStorage(
        filename,
        fileSystem,
        authority,
        data.version,
        options.bindGeneration ? authority.generation : undefined,
        undefined,
        options.syncWrites,
      );
    });
  }

  /** Fence old writers before snapshot/migration; never await a runtime's own lease. */
  static async prepare(options: OpenPluginStorageOptions): Promise<{
    storage: JsonPluginStorage;
    publish(): void;
    rollback(): Promise<void>;
  }> {
    const { filename, fileSystem, authority } = this.#location(options);
    if (authority.staging)
      throw new Error("Plugin storage replacement is already being prepared");
    const candidate = Symbol("candidate plugin storage");
    let published = false;
    let previous: StoredPluginData | undefined;
    let previousBytes: string | undefined;
    let oldGeneration = authority.generation;
    const rollback = async () => {
      await queueStorage(authority, async () => {
        if (authority.staging !== candidate) return;
        if (previousBytes === undefined) {
          await fileSystem.unlink(filename).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
          if (options.syncWrites)
            await fileSystem.syncDirectory!(path.dirname(filename));
        } else {
          await atomicWriteBytes(
            filename,
            previousBytes,
            fileSystem,
            options.syncWrites,
          );
        }
        authority.data = previous;
        authority.generation = oldGeneration;
        delete authority.writeOutcomeUnknown;
        delete authority.staging;
        notifyStorageReplacement(authority);
      });
    };
    try {
      await queueStorage(authority, async () => {
        if (authority.writeOutcomeUnknown) throw authority.writeOutcomeUnknown;
        if (authority.staging)
          throw new Error(
            "Plugin storage replacement is already being prepared",
          );
        try {
          previousBytes = await fileSystem.readFile(filename, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        oldGeneration = authority.generation;
        previous =
          previousBytes === undefined
            ? undefined
            : decodeStoredPluginData(previousBytes);
        authority.staging = candidate;
        notifyStorageReplacement(authority);
        const { data } = await this.#readAndMigrate(
          options,
          filename,
          fileSystem,
        );
        authority.data = data;
      });
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Plugin storage rollback failed; replacement remains fenced",
        );
      }
      throw error;
    }
    return {
      storage: new JsonPluginStorage(
        filename,
        fileSystem,
        authority,
        options.version,
        candidate,
        candidate,
        options.syncWrites,
      ),
      publish() {
        if (authority.writeOutcomeUnknown) throw authority.writeOutcomeUnknown;
        if (published) return;
        if (authority.staging !== candidate)
          throw new Error("Plugin storage candidate is no longer current");
        authority.generation = candidate;
        delete authority.staging;
        published = true;
        notifyStorageReplacement(authority);
      },
      rollback,
    };
  }

  static #location(options: OpenPluginStorageOptions) {
    validatePluginId(options.pluginId);
    validateStorageVersion(options.version);
    const fileSystem = options.fileSystem ?? nodeStorageFileSystem;
    if (
      options.syncWrites &&
      (!fileSystem.openFile || !fileSystem.syncDirectory)
    )
      throw new Error(
        "Synced plugin storage requires openFile and syncDirectory IO primitives",
      );
    const filename = path.join(
      path.resolve(options.root),
      options.pluginId,
      "storage.json",
    );
    const authority = storageAuthority(fileSystem, filename);
    if (authority.writeOutcomeUnknown) throw authority.writeOutcomeUnknown;
    return { filename, fileSystem, authority };
  }

  static async #readAndMigrate(
    options: OpenPluginStorageOptions,
    filename: string,
    fileSystem: PluginStorageFileSystem,
  ) {
    let current: StoredPluginData;
    let exists = true;
    try {
      current = decodeStoredPluginData(
        await fileSystem.readFile(filename, "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
      current = {
        version: 1,
        value: cloneAndValidate(options.initialValue ?? {}),
      };
    }
    if (current.version > options.version)
      throw new Error(
        `Plugin storage cannot downgrade from version ${String(current.version)} to ${String(options.version)}`,
      );
    const migrations = validateMigrations(options.migrations ?? []);
    let migrated = current.value;
    for (let version = current.version; version < options.version; version++) {
      const migration = migrations.get(version);
      if (!migration)
        throw new Error(
          `Plugin storage migration ${String(version)} -> ${String(version + 1)} is missing`,
        );
      migrated = cloneAndValidate(
        await migration.migrate(structuredClone(migrated)),
      );
    }
    const data = { version: options.version, value: migrated };
    if (!exists || current.version !== options.version)
      await atomicWrite(filename, data, fileSystem, options.syncWrites);
    return { data };
  }

  #checkOwnership(): StoredPluginData {
    const authority = this.#authority;
    if (authority.writeOutcomeUnknown) throw authority.writeOutcomeUnknown;
    const candidateActive =
      this.#candidate !== undefined && authority.staging === this.#candidate;
    if (authority.staging !== undefined && !candidateActive)
      throw new PluginStorageReplacementPendingError();
    if (
      this.#generation !== undefined &&
      authority.generation !== this.#generation &&
      !candidateActive
    )
      throw new Error(
        "Plugin storage generation was replaced; this runtime cannot access current storage",
      );
    if (authority.data === undefined || authority.data.version !== this.version)
      throw new Error("Plugin storage version changed while running");
    return authority.data;
  }

  async get(): Promise<PluginStorageValue> {
    this.#checkOwnership();
    return await queueStorage(this.#authority, async () =>
      structuredClone(this.#checkOwnership().value),
    );
  }

  async reload(): Promise<void> {
    this.#checkOwnership();
    await queueStorage(this.#authority, async () => {
      this.#checkOwnership();
      const data = decodeStoredPluginData(
        await this.#fileSystem.readFile(this.#filename, "utf8"),
      );
      if (data.version !== this.version)
        throw new Error("Plugin storage version changed while running");
      this.#authority.data = data;
    });
  }

  async set(value: PluginStorageValue): Promise<void> {
    this.#checkOwnership();
    const validated = cloneAndValidate(value);
    await queueStorage(this.#authority, async () => {
      this.#checkOwnership();
      try {
        await atomicWrite(
          this.#filename,
          { version: this.version, value: validated },
          this.#fileSystem,
          this.#syncWrites,
        );
      } catch (error) {
        if (error instanceof PluginStorageWriteOutcomeUnknownError)
          this.#authority.writeOutcomeUnknown = error;
        throw error;
      }
      this.#authority.data = { version: this.version, value: validated };
    });
  }
}

class PluginStorageWriteOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      "Synced plugin storage write outcome is unknown; reopen the Host before continuing",
      { cause },
    );
  }
}

async function atomicWrite(
  filename: string,
  data: StoredPluginData,
  fileSystem: PluginStorageFileSystem,
  syncWrites = false,
): Promise<void> {
  await atomicWriteBytes(
    filename,
    `${JSON.stringify(data, null, 2)}\n`,
    fileSystem,
    syncWrites,
  );
}

async function atomicWriteBytes(
  filename: string,
  encoded: string,
  fileSystem: PluginStorageFileSystem,
  syncWrites = false,
): Promise<void> {
  if (Buffer.byteLength(encoded, "utf8") > MAX_STORAGE_BYTES)
    throw new Error("Plugin storage exceeds its byte limit");
  await fileSystem.mkdir(path.dirname(filename), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${filename}.${String(process.pid)}.${randomUUID()}.tmp`;
  let failure: unknown;
  let committed = false;
  let publicationAttempted = false;
  try {
    if (syncWrites) {
      const file = await fileSystem.openFile!(temporary, "wx", 0o600);
      try {
        await writeJournalPayload(file, encoded);
        await file.sync();
      } finally {
        await file.close();
      }
    } else {
      await fileSystem.writeFile(temporary, encoded, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    publicationAttempted = true;
    await fileSystem.rename(temporary, filename);
    committed = true;
    if (syncWrites) await fileSystem.syncDirectory!(path.dirname(filename));
  } catch (error) {
    failure = error;
    if (syncWrites && publicationAttempted)
      throw new PluginStorageWriteOutcomeUnknownError(error);
    throw error;
  } finally {
    await fileSystem.unlink(temporary).catch((error: unknown) => {
      if (
        !committed &&
        failure === undefined &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
    });
  }
}

function decodeStoredPluginData(raw: string): StoredPluginData {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORAGE_BYTES)
    throw new Error("Plugin storage exceeds its byte limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Plugin storage contains invalid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Plugin storage document is invalid");
  validateStorageVersion(parsed.version);
  return { version: parsed.version, value: cloneAndValidate(parsed.value) };
}

function cloneAndValidate(value: unknown): PluginStorageValue {
  if (!isRecord(value))
    throw new Error("Plugin storage value must be a JSON-compatible object");
  validateJsonValue(value, new Set<object>());
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    /* handled below */
  }
  if (encoded === undefined)
    throw new Error("Plugin storage value must be a JSON-compatible object");
  const decoded = JSON.parse(encoded) as unknown;
  if (!isRecord(decoded))
    throw new Error("Plugin storage value must be a JSON-compatible object");
  if (JSON.stringify(decoded) !== encoded)
    throw new Error("Plugin storage value must be a JSON-compatible object");
  return decoded;
}

function validateJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object")
    throw new Error("Plugin storage value must be a JSON-compatible object");
  if (ancestors.has(value))
    throw new Error("Plugin storage value must be a JSON-compatible object");
  ancestors.add(value);
  const values = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const entry of values) validateJsonValue(entry, ancestors);
  ancestors.delete(value);
}

function validateMigrations(
  migrations: readonly PluginStorageMigration[],
): Map<number, PluginStorageMigration> {
  const result = new Map<number, PluginStorageMigration>();
  for (const migration of migrations) {
    validateStorageVersion(migration.fromVersion);
    validateStorageVersion(migration.toVersion);
    if (migration.toVersion !== migration.fromVersion + 1)
      throw new Error(
        "Plugin storage migrations must advance exactly one version",
      );
    if (result.has(migration.fromVersion))
      throw new Error(
        `Duplicate plugin storage migration from version ${String(migration.fromVersion)}`,
      );
    result.set(migration.fromVersion, migration);
  }
  return result;
}

function validateStorageVersion(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_STORAGE_VERSION
  ) {
    throw new Error(
      `Plugin storage version must be between 1 and ${String(MAX_STORAGE_VERSION)}`,
    );
  }
}

function validatePluginId(pluginId: string): void {
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(pluginId))
    throw new Error("Plugin storage namespace is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const unavailableUiPort: PluginHostUiPort = {
  readHandle: async () => {
    throw new Error("Plugin UI handles are not available");
  },
  executeCommand: async () => {
    throw new Error("Plugin UI commands are not available");
  },
};
