import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  ZenXCredentialVault,
  type LocalEncryption,
} from "./credential-vault.js";
import {
  secureLocalEncryption,
  type LocalEncryptionBackend,
} from "./secure-local-encryption.js";
import {
  runTrustedImRuntimeSetup,
  ImRuntimeSetupOwnershipError,
} from "./imzenx-runtime-preparation.js";
import {
  IM_CHANNEL_SCHEMAS,
  normalizeManagedChannel,
} from "../../../../packages/zenx-imzenx-plugin/src/channel-schema.js";

export type ImZenXFieldValue = string | boolean;
export interface ImZenXSecretChange {
  operation: "keep" | "replace" | "clear";
  value?: string;
}
export interface ImZenXChannelSave {
  channelId: string;
  values: Record<string, ImZenXFieldValue>;
  secrets: Record<string, ImZenXSecretChange>;
}
export interface ImZenXSetupView {
  configurationFile: string;
  encryptionAvailable: boolean;
  runtime: {
    projectDirectory: string;
    pythonExecutable: string;
    prepared: boolean;
    preparing: boolean;
    error?: string;
    source: string;
  };
  channels: Array<{
    id: string;
    label: string;
    supported: boolean;
    prerequisite?: string;
    fields: Array<{
      key: string;
      label: string;
      type: "string" | "boolean";
      secret: boolean;
      required: boolean;
      defaultValue?: ImZenXFieldValue;
      options?: readonly string[];
    }>;
    values: Record<string, ImZenXFieldValue>;
    secretConfigured: Record<string, boolean>;
  }>;
}

/** Trusted own-IM configuration: secret-bearing APIs are never model tools. */
export class ImZenXSetupService {
  readonly #directory: string;
  readonly #encryption: LocalEncryption;
  readonly #vault: ZenXCredentialVault;
  readonly #runSetup: (
    projectDirectory: string,
    signal: AbortSignal,
  ) => Promise<void>;
  #projectDirectory: string | undefined;
  #operations: Promise<unknown> = Promise.resolve();
  #preparation: Promise<ImZenXSetupView> | undefined;
  #runtimePreparing = false;
  #runtimeError: string | undefined;
  #runtimeBlocked = false;
  #setupAbort: AbortController | undefined;
  #closed = false;
  #managedEdit:
    | ((configFile: string, action: () => Promise<unknown>) => Promise<unknown>)
    | undefined;

  constructor(options: {
    directory: string;
    encryption: LocalEncryptionBackend;
    runSetup?: (projectDirectory: string, signal: AbortSignal) => Promise<void>;
  }) {
    this.#directory = path.resolve(options.directory);
    this.#encryption = secureLocalEncryption(options.encryption);
    this.#vault = new ZenXCredentialVault(
      path.join(this.#directory, "credentials.vault"),
      this.#encryption,
    );
    this.#runSetup = options.runSetup ?? runTrustedImRuntimeSetup;
  }

  setRuntimeProject(directory: string): void {
    this.#projectDirectory = path.resolve(directory);
  }

  registerManagedEdit(
    edit: (
      configFile: string,
      action: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): () => void {
    this.#managedEdit = edit;
    return () => {
      if (this.#managedEdit === edit) this.#managedEdit = undefined;
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#setupAbort?.abort();
    await this.#preparation?.catch(() => {});
    await this.#operations.catch(() => {});
    if (this.#runtimeBlocked)
      throw new Error(
        "IM runtime setup process termination could not be confirmed",
      );
  }

  get configurationFile(): string {
    return path.join(this.#directory, "channels.managed.json");
  }

  inspect(): Promise<ImZenXSetupView> {
    return this.#serialize(() => this.#inspect());
  }

  saveChannel(value: unknown): Promise<ImZenXSetupView> {
    if (this.#closed || this.#managedEdit === undefined)
      return Promise.reject(
        new Error(
          "IM plugin is not ready for secure configuration. Wait for activation and try again.",
        ),
      );
    const action = () =>
      this.#serialize(async () => {
        try {
          if (!this.#encryption.isEncryptionAvailable())
            throw new Error("encryption unavailable");
          const input = readSave(value);
          const schema = IM_CHANNEL_SCHEMAS.find(
            (entry) => entry.id === input.channelId,
          );
          if (!schema?.supported) throw new Error("unsupported channel");
          const existing = await this.#readChannel(schema.id);
          const nonsecret: Record<string, ImZenXFieldValue> = {};
          const secrets: Record<string, string | undefined> = {};
          for (const field of schema.fields) {
            if (field.secret) {
              const change = input.secrets[field.key] ?? { operation: "keep" };
              const prior = existing?.[field.key];
              if (change.operation === "keep")
                secrets[field.key] =
                  typeof prior === "string" ? prior : undefined;
              else if (change.operation === "clear")
                secrets[field.key] = undefined;
              else {
                if (
                  typeof change.value !== "string" ||
                  !change.value.trim() ||
                  change.value.length > 8192
                )
                  throw new Error("invalid secret replacement");
                secrets[field.key] = change.value;
              }
            } else {
              const prior = existing?.[field.key];
              nonsecret[field.key] =
                input.values[field.key] ??
                (Array.isArray(prior)
                  ? prior.join(", ")
                  : typeof prior === "string" || typeof prior === "boolean"
                    ? prior
                    : (field.defaultValue ?? ""));
            }
          }
          if (
            Object.keys(input.values).some(
              (key) =>
                !schema.fields.some(
                  (field) => field.key === key && !field.secret,
                ),
            ) ||
            Object.keys(input.secrets).some(
              (key) =>
                !schema.fields.some(
                  (field) => field.key === key && field.secret,
                ),
            )
          )
            throw new Error("unknown or misplaced field");
          const configuration = normalizeManagedChannel(
            schema.id,
            nonsecret,
            secrets,
          );
          await mkdir(this.#directory, { recursive: true, mode: 0o700 });
          // This file is a nonsecret selector. The encrypted vault is authoritative.
          const selector = path.join(
            this.#directory,
            `.channels-${randomUUID()}.tmp`,
          );
          try {
            await writeFile(selector, '{"imzenxManaged":1}\n', {
              mode: 0o600,
              flag: "wx",
            });
            await rename(selector, this.configurationFile);
          } finally {
            await unlink(selector).catch(() => {});
          }
          await this.#vault.writeApiKey(
            `channel:${schema.id}`,
            JSON.stringify({ version: 1, configuration }),
          );
          return await this.#inspect();
        } catch {
          throw new Error(
            this.#encryption.isEncryptionAvailable()
              ? "IM channel could not be saved. Check the selected fields and try again. No connection was started."
              : "Operating-system credential encryption is unavailable. Unlock the system keychain before saving IM credentials. No plaintext fallback is used.",
          );
        }
      });
    // Match Connect's lock order: runtime queue first, then secure storage.
    // This callback is registered only by the admitted trusted runtime.
    return this.#managedEdit(
      this.configurationFile,
      action,
    ) as Promise<ImZenXSetupView>;
  }

  async inspectManagedChannels(configFile: string) {
    if (path.resolve(configFile) !== this.configurationFile) return undefined;
    return await this.#serialize(async () => ({
      channels: await Promise.all(
        IM_CHANNEL_SCHEMAS.filter((entry) => entry.supported).map(
          async (schema) => {
            const config = await this.#readChannel(schema.id);
            return {
              id: schema.id,
              enabled: config?.["enabled"] === true,
              credentialsConfigured: schema.fields
                .filter((field) => field.required)
                .every((field) => {
                  const value = config?.[field.key];
                  return typeof value === "string"
                    ? value.trim().length > 0
                    : value !== undefined;
                }),
              accessRestricted: accessRestricted(config),
            };
          },
        ),
      ),
    }));
  }

  async readManagedChannels(
    configFile: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (path.resolve(configFile) !== this.configurationFile) return undefined;
    return await this.#serialize(async () => {
      try {
        const channels: Record<string, unknown> = {};
        for (const schema of IM_CHANNEL_SCHEMAS.filter(
          (entry) => entry.supported,
        )) {
          const config = await this.#readChannel(schema.id);
          if (config?.["enabled"] !== true) continue;
          if (
            !schema.fields
              .filter((field) => field.required)
              .every(
                (field) =>
                  typeof config[field.key] === "string" &&
                  String(config[field.key]).trim(),
              )
          )
            throw new Error("missing credentials");
          channels[schema.id] = config;
        }
        if (Object.keys(channels).length === 0)
          throw new Error("no enabled channels");
        return channels;
      } catch {
        throw new Error(
          "Managed IM configuration is unavailable. Complete the selected channel securely and check readiness before connecting.",
        );
      }
    });
  }

  prepareRuntime(): Promise<ImZenXSetupView> {
    if (this.#closed)
      return Promise.reject(new Error("IM runtime setup is stopped"));
    if (this.#preparation) return this.#preparation;
    if (this.#runtimeBlocked) return this.inspect();
    this.#runtimeError = undefined;
    this.#runtimePreparing = true;
    const abort = new AbortController();
    this.#setupAbort = abort;
    const preparation = (async () => {
      try {
        const project = this.#projectDirectory;
        if (!project) throw new Error("IM plugin not admitted");
        const runtime = await this.#runtimeLocation(project);
        if (!runtime.prepared) {
          await mkdir(runtime.projectDirectory, {
            recursive: true,
            mode: 0o700,
          });
          for (const name of ["src", "pyproject.toml", "uv.lock", "README.md"])
            await cp(
              path.join(project, name),
              path.join(runtime.projectDirectory, name),
              {
                recursive: true,
                filter: (filename) => !filename.includes("__pycache__"),
              },
            );
          abort.signal.throwIfAborted();
          await this.#runSetup(runtime.projectDirectory, abort.signal);
          abort.signal.throwIfAborted();
          if (!(await stat(runtime.pythonExecutable)).isFile())
            throw new Error("missing Python environment");
          await writeFile(
            path.join(runtime.projectDirectory, ".prepared"),
            "ready\n",
            { mode: 0o600 },
          );
        }
      } catch (error) {
        this.#runtimeBlocked = error instanceof ImRuntimeSetupOwnershipError;
        this.#runtimeError = this.#runtimeBlocked
          ? "IM setup process termination could not be confirmed. Further setup is blocked. Stop the remaining IM setup processes using your operating system, then restart ZenX. No IM connection was started."
          : "Runtime preparation could not finish. Install uv from its official source and verify access to the pinned private IM Agent SDK repository, then try again. No IM connection was started.";
      }
      this.#runtimePreparing = false;
      if (this.#setupAbort === abort) this.#setupAbort = undefined;
      return await this.inspect();
    })();
    this.#preparation = preparation;
    void preparation
      .finally(() => {
        if (this.#preparation === preparation) this.#preparation = undefined;
      })
      .catch(() => {});
    return preparation;
  }

  async #runtimeLocation(project = this.#projectDirectory) {
    if (!project)
      return { projectDirectory: "", pythonExecutable: "", prepared: false };
    const lock = await readFile(path.join(project, "uv.lock"));
    const digest = createHash("sha256").update(lock).digest("hex").slice(0, 16);
    const projectDirectory = path.join(this.#directory, "runtimes", digest);
    const pythonExecutable = path.join(
      projectDirectory,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    let prepared = false;
    try {
      prepared =
        (await readFile(path.join(projectDirectory, ".prepared"), "utf8")) ===
          "ready\n" && (await stat(pythonExecutable)).isFile();
    } catch {
      /* Missing is not ready. */
    }
    return { projectDirectory, pythonExecutable, prepared };
  }

  async #inspect(): Promise<ImZenXSetupView> {
    const encryptionAvailable = this.#encryption.isEncryptionAvailable();
    let runtime = {
      projectDirectory: "",
      pythonExecutable: "",
      prepared: false,
    };
    try {
      runtime = await this.#runtimeLocation();
    } catch {
      /* Surface unavailable, never path/parse diagnostics. */
    }
    const channels = await Promise.all(
      IM_CHANNEL_SCHEMAS.map(async (schema) => {
        let config: Record<string, unknown> | undefined;
        if (encryptionAvailable) config = await this.#readChannel(schema.id);
        const values: Record<string, ImZenXFieldValue> = {};
        const secretConfigured: Record<string, boolean> = {};
        for (const field of schema.fields) {
          const value = config?.[field.key];
          if (field.secret)
            secretConfigured[field.key] =
              typeof value === "string" && value.length > 0;
          else
            values[field.key] = Array.isArray(value)
              ? value.join(", ")
              : typeof value === "string" || typeof value === "boolean"
                ? value
                : (field.defaultValue ?? "");
        }
        return {
          ...schema,
          fields: schema.fields.map((field) => ({ ...field })),
          values,
          secretConfigured,
        };
      }),
    );
    return {
      configurationFile: this.configurationFile,
      encryptionAvailable,
      runtime: {
        ...runtime,
        preparing: this.#runtimePreparing,
        ...(this.#runtimeError ? { error: this.#runtimeError } : {}),
        source:
          "Locked IMZen project and pinned private IM Agent SDK; uv may download Python 3.13 and dependencies. Requires private repository access. No IM consumer is started.",
      },
      channels,
    };
  }

  async #readChannel(id: string): Promise<Record<string, unknown> | undefined> {
    try {
      const value = await this.#vault.readApiKey(`channel:${id}`);
      if (value === undefined) return undefined;
      const parsed = JSON.parse(value) as {
        version?: unknown;
        configuration?: unknown;
      };
      if (parsed.version !== 1 || !isRecord(parsed.configuration))
        throw new Error("invalid channel");
      const schema = IM_CHANNEL_SCHEMAS.find((entry) => entry.id === id)!;
      const values: Record<string, ImZenXFieldValue> = {};
      const secrets: Record<string, string | undefined> = {};
      if (
        Object.keys(parsed.configuration).some(
          (key) => !schema.fields.some((field) => field.key === key),
        )
      )
        throw new Error("unknown field");
      for (const field of schema.fields) {
        const item = parsed.configuration[field.key];
        if (field.secret) {
          if (item !== undefined && typeof item !== "string")
            throw new Error("invalid credential");
          secrets[field.key] = item as string | undefined;
        } else if (item !== undefined) {
          if (
            Array.isArray(item) &&
            item.every((entry) => typeof entry === "string")
          )
            values[field.key] = item.join(",");
          else if (typeof item === "string" || typeof item === "boolean")
            values[field.key] = item;
          else throw new Error("invalid field");
        }
      }
      return normalizeManagedChannel(schema.id, values, secrets);
    } catch {
      throw new Error(
        "Encrypted IM configuration could not be read. Unlock the system keychain and check your IM settings.",
      );
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => {});
    return result;
  }
}

function readSave(value: unknown): ImZenXChannelSave {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["channelId", "values", "secrets"].includes(key),
    ) ||
    typeof value["channelId"] !== "string" ||
    !isRecord(value["values"]) ||
    !isRecord(value["secrets"])
  )
    throw new Error("invalid save request");
  for (const field of Object.values(value["values"]))
    if (typeof field !== "string" && typeof field !== "boolean")
      throw new Error("invalid value");
  for (const change of Object.values(value["secrets"])) {
    if (
      !isRecord(change) ||
      !["keep", "replace", "clear"].includes(String(change["operation"])) ||
      Object.keys(change).some(
        (key) => !["operation", "value"].includes(key),
      ) ||
      (change["operation"] !== "replace" && change["value"] !== undefined)
    )
      throw new Error("invalid secret operation");
  }
  return value as unknown as ImZenXChannelSave;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accessRestricted(
  config: Record<string, unknown> | undefined,
): boolean {
  const lists = [
    config?.["allowed_user_ids"],
    config?.["allowed_conversation_ids"],
  ].filter(
    (value): value is string[] => Array.isArray(value) && value.length > 0,
  );
  if (!lists.length) return false;
  // The pinned SDK removes wildcard dimensions before applying any/all.
  return lists.some((list) => !list.includes("*"));
}
