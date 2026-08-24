import type {
  PluginProject,
  PluginStorageValue,
  ZenXPluginHostSdkV1,
} from "./types.js";

export interface FixturePluginHostOptions {
  pluginId: string;
  storageVersion?: number;
  initialStorage?: PluginStorageValue;
  projects?: readonly PluginProject[];
  handles?: Readonly<Record<string, unknown>>;
  executeCommand?(
    commandId: string,
    input?: unknown,
  ): Promise<unknown> | unknown;
}

export interface FixturePluginHost {
  readonly sdk: ZenXPluginHostSdkV1;
}

/** In-memory SDK fixture for plugin tests; it deliberately has no session authority. */
export function createFixturePluginHost(
  options: FixturePluginHostOptions,
): FixturePluginHost {
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(options.pluginId)) {
    throw new Error(`Invalid ZenX plugin id: ${options.pluginId}`);
  }
  const storageVersion = options.storageVersion ?? 1;
  if (
    !Number.isSafeInteger(storageVersion) ||
    storageVersion < 1 ||
    storageVersion > 1000
  ) {
    throw new Error(
      "Fixture Host storageVersion must be an integer from 1 to 1000",
    );
  }
  let storage = jsonObject(options.initialStorage ?? {});
  const projects = immutableClone(options.projects ?? []);
  const handles = immutableClone(options.handles ?? {});
  const sdk: ZenXPluginHostSdkV1 = Object.freeze({
    version: 1,
    pluginId: options.pluginId,
    query: Object.freeze({
      projects: Object.freeze({
        list: async () => immutableClone(projects),
      }),
    }),
    actions: Object.freeze({
      threads: Object.freeze({
        startTurn: async () => {
          throw new Error(
            "Fixture Host does not own Agent, Thread, or Turn authority",
          );
        },
      }),
    }),
    ui: Object.freeze({
      handles: Object.freeze({
        read: async (handleId: string) => {
          if (!(handleId in handles)) {
            throw new Error(`Fixture Host handle is unavailable: ${handleId}`);
          }
          return immutableClone(handles[handleId]);
        },
      }),
      commands: Object.freeze({
        execute: async (commandId: string, input?: unknown) => {
          if (options.executeCommand === undefined) {
            throw new Error("Fixture Host UI commands are unavailable");
          }
          return await options.executeCommand(commandId, immutableClone(input));
        },
      }),
    }),
    storage: Object.freeze({
      version: storageVersion,
      get: async () => immutableClone(storage),
      set: async (value: PluginStorageValue) => {
        storage = jsonObject(value);
      },
    }),
  });
  return Object.freeze({ sdk });
}

function jsonObject(value: PluginStorageValue): PluginStorageValue {
  const cloned = immutableClone(value);
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new Error("Plugin storage must be a JSON object");
  }
  return cloned;
}

function immutableClone<T>(value: T): T {
  if (value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    throw new Error("Fixture Host values must be JSON-compatible");
  }
}
