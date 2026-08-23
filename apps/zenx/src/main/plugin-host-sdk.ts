import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CanonicalItem, UserInput } from "../../../../src/item.js";
import type { TurnHandle } from "../../../../src/app-server.js";
import type { ZenXProjectProjectionEntry } from "./project-projection.js";

export const ZENX_PLUGIN_HOST_SDK_VERSION = 1 as const;
const MAX_STORAGE_VERSION = 1_000;
const MAX_STORAGE_BYTES = 1024 * 1024;

export type PluginStorageValue = Readonly<Record<string, unknown>>;

export interface PluginStorageMigration {
  fromVersion: number;
  toVersion: number;
  migrate(
    value: PluginStorageValue,
  ): PluginStorageValue | Promise<PluginStorageValue>;
}

export interface PluginHostAppServerPort {
  startTurn(threadId: string, input: string | UserInput): Promise<TurnHandle>;
  readThread(threadId: string): Promise<{ items: readonly CanonicalItem[] }>;
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
}

export async function createZenXPluginHostSdk(
  options: CreateZenXPluginHostSdkOptions,
): Promise<ZenXPluginHostSdkV1> {
  const storage = await JsonPluginStorage.open({
    pluginId: options.pluginId,
    root: options.storageRoot,
    version: options.storageVersion,
    migrations: options.migrations,
    initialValue: options.initialStorage,
  });
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
          const turn = await options.appServer.startTurn(threadId, input);
          await turn.done;
          const snapshot = await options.appServer.readThread(threadId);
          return Object.freeze({
            threadId,
            turnId: turn.id,
            items: structuredClone(snapshot.items),
          });
        },
      }),
    }),
    ui: Object.freeze({
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
      set: async (value: PluginStorageValue) => await storage.set(value),
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
}

const nodeStorageFileSystem: PluginStorageFileSystem = {
  readFile,
  mkdir,
  writeFile,
  rename,
  unlink,
};

export class JsonPluginStorage {
  readonly version: number;
  readonly #filename: string;
  readonly #fileSystem: PluginStorageFileSystem;
  #value: PluginStorageValue;
  #mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    filename: string,
    fileSystem: PluginStorageFileSystem,
    data: StoredPluginData,
  ) {
    this.#filename = filename;
    this.#fileSystem = fileSystem;
    this.version = data.version;
    this.#value = data.value;
  }

  static async open(options: {
    pluginId: string;
    root: string;
    version: number;
    migrations?: readonly PluginStorageMigration[];
    initialValue?: PluginStorageValue;
    fileSystem?: PluginStorageFileSystem;
  }): Promise<JsonPluginStorage> {
    validatePluginId(options.pluginId);
    validateStorageVersion(options.version);
    const fileSystem = options.fileSystem ?? nodeStorageFileSystem;
    const filename = path.join(
      path.resolve(options.root),
      options.pluginId,
      "storage.json",
    );
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
    if (current.version > options.version) {
      throw new Error(
        `Plugin storage cannot downgrade from version ${String(current.version)} to ${String(options.version)}`,
      );
    }
    const migrations = validateMigrations(options.migrations ?? []);
    let migrated = current.value;
    for (
      let version = current.version;
      version < options.version;
      version += 1
    ) {
      const migration = migrations.get(version);
      if (migration === undefined) {
        throw new Error(
          `Plugin storage migration ${String(version)} -> ${String(version + 1)} is missing`,
        );
      }
      migrated = cloneAndValidate(
        await migration.migrate(structuredClone(migrated)),
      );
    }
    const next = { version: options.version, value: migrated };
    if (!exists || current.version !== options.version) {
      await atomicWrite(filename, next, fileSystem);
    }
    return new JsonPluginStorage(filename, fileSystem, next);
  }

  async get(): Promise<PluginStorageValue> {
    await this.#mutationTail;
    return structuredClone(this.#value);
  }

  async set(value: PluginStorageValue): Promise<void> {
    const validated = cloneAndValidate(value);
    const operation = this.#mutationTail.then(async () => {
      await atomicWrite(
        this.#filename,
        { version: this.version, value: validated },
        this.#fileSystem,
      );
      this.#value = validated;
    });
    this.#mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }
}

async function atomicWrite(
  filename: string,
  data: StoredPluginData,
  fileSystem: PluginStorageFileSystem,
): Promise<void> {
  const encoded = `${JSON.stringify(data, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_STORAGE_BYTES) {
    throw new Error("Plugin storage exceeds its byte limit");
  }
  await fileSystem.mkdir(path.dirname(filename), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${filename}.${String(process.pid)}.${randomUUID()}.tmp`;
  let failure: unknown;
  let committed = false;
  try {
    await fileSystem.writeFile(temporary, encoded, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fileSystem.rename(temporary, filename);
    committed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await fileSystem.unlink(temporary).catch((error: unknown) => {
      if (
        !committed &&
        failure === undefined &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
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
