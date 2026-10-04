import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ModelSummary,
  FilePermissionMode,
} from "../../protocol-client/types.js";
import type {
  AgentProviderAdapter,
  AgentProvidersApi,
  AgentProviderCapabilities,
  AgentProviderEvent,
  AgentProviderInstance,
  AgentSessionBinding,
  AgentSessionSnapshot,
} from "./types.js";

interface Configuration {
  version: 1;
  hostId: string;
  instances: AgentProviderInstance[];
  sessions: AgentSessionBinding[];
}
const ZEN: AgentProviderInstance = { id: "zen", kind: "zen", name: "Zen" };
const KINDS = new Set(["codex", "opencode"]);
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 4096): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
export function parseAgentProviderInstance(
  value: unknown,
): AgentProviderInstance {
  const row = object(value);
  const id = string(row.id, "provider ID", 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || id === "zen")
    throw new Error("Invalid or reserved provider ID");
  if (!KINDS.has(String(row.kind)))
    throw new Error("Unsupported Agent Provider kind");
  const result: AgentProviderInstance = {
    id,
    kind: row.kind as AgentProviderInstance["kind"],
    name: string(row.name, "provider name", 100),
  };
  if (row.executable !== undefined)
    result.executable = string(row.executable, "executable");
  if (row.defaultModel !== undefined)
    result.defaultModel = string(row.defaultModel, "default model", 512);
  return result;
}
function parseConfiguration(value: unknown): Configuration {
  const row = object(value);
  if (
    row.version !== 1 ||
    !Array.isArray(row.instances) ||
    !Array.isArray(row.sessions) ||
    row.instances.length > 64 ||
    row.sessions.length > 10000
  )
    throw new Error("Invalid Agent Provider configuration");
  const hostId = string(row.hostId, "Host ID", 128);
  const instances = row.instances.map(parseAgentProviderInstance);
  const ids = new Set(instances.map((i) => i.id));
  if (ids.size !== instances.length)
    throw new Error("Duplicate Agent Provider ID");
  const sessions = row.sessions.map((value) => {
    const r = object(value);
    const binding: AgentSessionBinding = {
      id: string(r.id, "session ID", 100),
      hostId: string(r.hostId, "Host ID", 128),
      providerInstanceId: string(r.providerInstanceId, "provider ID", 100),
      nativeSessionId: string(r.nativeSessionId, "native session ID", 512),
      cwd: string(r.cwd, "workspace"),
    };
    if (
      binding.hostId !== hostId ||
      !ids.has(binding.providerInstanceId) ||
      !path.isAbsolute(binding.cwd)
    )
      throw new Error("Invalid Agent session binding");
    return binding;
  });
  if (new Set(sessions.map((s) => s.id)).size !== sessions.length)
    throw new Error("Duplicate Agent session ID");
  return { version: 1, hostId, instances, sessions };
}

/** Saves configuration and locators only. Session state is always read from its engine. */
export class AgentProviderService {
  readonly #filename: string;
  readonly #factory: (instance: AgentProviderInstance) => AgentProviderAdapter;
  readonly #zenModels: () => Promise<ModelSummary[]>;
  #configuration: Promise<Configuration>;
  readonly #hostIdentity?: () => Promise<string>;
  #writes: Promise<unknown> = Promise.resolve();
  #adapters = new Map<string, AgentProviderAdapter>();
  #listeners = new Set<(event: AgentProviderEvent) => void>();
  #disposed = false;
  #creating = new Map<string, number>();
  #approvals = new Map<
    string,
    Extract<AgentProviderEvent, { type: "approval" }>
  >();
  constructor(
    directory: string,
    factory: (instance: AgentProviderInstance) => AgentProviderAdapter,
    zenModels: () => Promise<ModelSummary[]>,
    hostIdentity?: () => Promise<string>,
  ) {
    this.#filename = path.join(directory, "agent-providers.json");
    this.#factory = factory;
    this.#zenModels = zenModels;
    this.#hostIdentity = hostIdentity;
    this.#configuration = this.#load();
    // Preserve the rejected result for callers without a startup-time unhandled rejection.
    void this.#configuration.catch(() => {});
  }
  async #load(): Promise<Configuration> {
    try {
      const text = await readFile(this.#filename, "utf8");
      if (Buffer.byteLength(text) > 4 * 1024 * 1024)
        throw new Error("Agent Provider configuration is too large");
      const config = parseConfiguration(JSON.parse(text));
      if (this.#hostIdentity && config.hostId !== (await this.#hostIdentity()))
        throw new Error("Agent Provider configuration belongs to another Host");
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        version: 1,
        hostId: this.#hostIdentity ? await this.#hostIdentity() : randomUUID(),
        instances: [],
        sessions: [],
      };
    }
  }
  async #write(next: Configuration): Promise<void> {
    const file = `${this.#filename}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true });
    const contents = JSON.stringify(next, null, 2) + "\n";
    if (Buffer.byteLength(contents) > 4 * 1024 * 1024)
      throw new Error("Agent Provider configuration is too large");
    try {
      await writeFile(file, contents, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(file, this.#filename);
    } finally {
      await unlink(file).catch(() => {});
    }
    this.#configuration = Promise.resolve(next);
  }
  #mutate<T>(action: (current: Configuration) => Promise<T>): Promise<T> {
    const run = this.#writes.then(async () => {
      this.#assertOpen();
      const configuration = await this.#configuration;
      this.#assertOpen();
      return action(configuration);
    });
    this.#writes = run.catch(() => {});
    return run;
  }
  #assertOpen() {
    if (this.#disposed) throw new Error("Agent Provider Host has stopped");
  }
  async list(): Promise<AgentProviderInstance[]> {
    return [ZEN, ...(await this.#configuration).instances].map((i) => ({
      ...i,
    }));
  }
  async save(value: unknown): Promise<AgentProviderInstance> {
    const instance = parseAgentProviderInstance(value);
    return this.#mutate(async (config) => {
      const old = config.instances.find((i) => i.id === instance.id);
      if (old && old.kind !== instance.kind)
        throw new Error(
          "An Agent Provider instance kind cannot change; add a new instance",
        );
      if (
        old &&
        old.executable !== instance.executable &&
        (config.sessions.some((s) => s.providerInstanceId === instance.id) ||
          (this.#creating.get(instance.id) ?? 0) > 0)
      )
        throw new Error(
          "This instance has sessions. Add another instance to change its executable",
        );
      if (!old && config.instances.length >= 64)
        throw new Error("Too many Agent Provider instances");
      await this.#write({
        ...config,
        instances: old
          ? config.instances.map((i) => (i.id === instance.id ? instance : i))
          : [...config.instances, instance],
      });
      if (old && old.executable !== instance.executable) {
        const adapter = this.#adapters.get(instance.id);
        this.#adapters.delete(instance.id);
        await adapter?.dispose();
      }
      return { ...instance };
    });
  }
  async #adapter(instanceId: string): Promise<AgentProviderAdapter> {
    this.#assertOpen();
    const instance = (await this.#configuration).instances.find(
      (i) => i.id === instanceId,
    );
    this.#assertOpen();
    if (!instance) throw new Error(`Unknown Agent Provider: ${instanceId}`);
    let adapter = this.#adapters.get(instanceId);
    if (!adapter) {
      adapter = this.#factory(instance);
      this.#adapters.set(instanceId, adapter);
      adapter.onEvent((event) => {
        void this.#forward(instanceId, event);
      });
    }
    return adapter;
  }
  async #forward(instanceId: string, event: AgentProviderEvent) {
    if (this.#disposed) return;
    const config = await this.#configuration;
    if (this.#disposed) return;
    const binding =
      event.sessionId === undefined
        ? undefined
        : config.sessions.find(
            (s) =>
              s.providerInstanceId === instanceId &&
              s.nativeSessionId === event.sessionId,
          );
    if (event.type !== "error" && !binding) return;
    if (event.type === "approvalResolved")
      this.#approvals.delete(`${instanceId}:${event.requestId}`);
    if (event.type === "approval" && binding)
      this.#approvals.set(`${instanceId}:${event.requestId}`, {
        ...event,
        sessionId: binding.id,
      });
    const projected = binding
      ? { ...event, sessionId: binding.id }
      : { ...event };
    if (projected.type === "error") {
      projected.providerInstanceId = instanceId;
      const name =
        config.instances.find((instance) => instance.id === instanceId)?.name ??
        instanceId;
      projected.message = `${name}: ${projected.message}`;
    }
    for (const listener of this.#listeners) {
      try {
        listener(projected);
      } catch {
        /* one observer cannot block others */
      }
    }
  }
  onEvent(listener: (event: AgentProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async capabilities(instanceId: string): Promise<AgentProviderCapabilities> {
    if (instanceId === "zen")
      return {
        models: true,
        interrupt: true,
        resume: true,
        changeModel: true,
        approvals: true,
      };
    return { ...(await this.#adapter(instanceId)).capabilities };
  }
  async models(instanceId: string): Promise<ModelSummary[]> {
    this.#assertOpen();
    return instanceId === "zen"
      ? this.#zenModels()
      : (await this.#adapter(instanceId)).models();
  }
  async approvals(sessionId: string) {
    await this.#bound(sessionId);
    return [...this.#approvals.values()]
      .filter((a) => a.sessionId === sessionId)
      .map((a) => ({ ...a }));
  }
  async sessions(): Promise<AgentSessionBinding[]> {
    return (await this.#configuration).sessions.map((s) => ({ ...s }));
  }
  async create(
    input: Parameters<AgentProvidersApi["create"]>[0],
  ): Promise<AgentSessionSnapshot> {
    string(input.providerInstanceId, "provider ID", 100);
    const id = input.providerInstanceId;
    this.#creating.set(id, (this.#creating.get(id) ?? 0) + 1);
    try {
      return await this.createNative(input);
    } finally {
      const count = (this.#creating.get(id) ?? 1) - 1;
      if (count === 0) this.#creating.delete(id);
      else this.#creating.set(id, count);
    }
  }
  private async createNative(input: {
    providerInstanceId: string;
    cwd: string;
    model?: string;
    permissionMode: FilePermissionMode;
  }): Promise<AgentSessionSnapshot> {
    string(input.providerInstanceId, "provider ID", 100);
    string(input.cwd, "workspace");
    if (!path.isAbsolute(input.cwd))
      throw new Error("Workspace must be an absolute path");
    if (input.model !== undefined) string(input.model, "model", 512);
    if (
      !["read-only", "workspace-write", "danger-full-access"].includes(
        input.permissionMode,
      )
    )
      throw new Error("Invalid permission mode");
    const adapter = await this.#adapter(input.providerInstanceId);
    if (
      adapter.capabilities.permissionModes &&
      !adapter.capabilities.permissionModes.includes(input.permissionMode)
    )
      throw new Error(
        "This Agent Provider does not support the selected filesystem permission mode",
      );
    const instance = (await this.#configuration).instances.find(
      (i) => i.id === input.providerInstanceId,
    )!;
    const native = await adapter.create({
      ...input,
      model: input.model ?? instance.defaultModel,
    });
    string(native.nativeSessionId, "native session ID", 512);
    const binding = await this.#mutate(async (config) => {
      if (
        config.sessions.some(
          (s) =>
            s.providerInstanceId === input.providerInstanceId &&
            s.nativeSessionId === native.nativeSessionId,
        )
      )
        throw new Error("Engine returned an already-bound session ID");
      if (config.sessions.length >= 10000)
        throw new Error("Agent session locator limit reached");
      const binding: AgentSessionBinding = {
        id: `agent-${randomUUID()}`,
        hostId: config.hostId,
        providerInstanceId: input.providerInstanceId,
        nativeSessionId: native.nativeSessionId,
        cwd: input.cwd,
      };
      await this.#write({ ...config, sessions: [...config.sessions, binding] });
      return binding;
    }).catch((error) => {
      throw new Error(
        `The engine created session ${native.nativeSessionId}, but its locator could not be saved: ${error instanceof Error ? error.message : String(error)}. Do not resend blindly.`,
      );
    });
    return {
      binding,
      thread: { ...native.thread, id: binding.id },
      model: native.model,
    };
  }
  async #bound(sessionId: string) {
    string(sessionId, "session ID", 100);
    const binding = (await this.#configuration).sessions.find(
      (s) => s.id === sessionId,
    );
    if (!binding) throw new Error(`Unknown Agent session: ${sessionId}`);
    return {
      binding,
      adapter: await this.#adapter(binding.providerInstanceId),
    };
  }
  async read(sessionId: string): Promise<AgentSessionSnapshot> {
    const { binding, adapter } = await this.#bound(sessionId);
    const native = await adapter.read(binding.nativeSessionId);
    return {
      binding: { ...binding },
      thread: { ...native.thread, id: binding.id },
      model: native.model,
    };
  }
  async send(
    sessionId: string,
    input: { text: string; model?: string },
  ): Promise<void> {
    string(input.text, "message", 1_000_000);
    if (input.model !== undefined) string(input.model, "model", 512);
    const { binding, adapter } = await this.#bound(sessionId);
    await adapter.send(binding.nativeSessionId, input);
  }
  async interrupt(sessionId: string): Promise<void> {
    const { binding, adapter } = await this.#bound(sessionId);
    await adapter.interrupt(binding.nativeSessionId);
  }
  async respondApproval(
    sessionId: string,
    requestId: string,
    decision: "accept" | "decline",
  ): Promise<void> {
    string(requestId, "approval ID", 512);
    if (decision !== "accept" && decision !== "decline")
      throw new Error("Invalid approval decision");
    const { binding, adapter } = await this.#bound(sessionId);
    const key = `${binding.providerInstanceId}:${requestId}`;
    if (this.#approvals.get(key)?.sessionId !== sessionId)
      throw new Error(
        "Approval does not belong to this session or is no longer pending",
      );
    await adapter.respondApproval(requestId, decision);
    this.#approvals.delete(key);
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#writes;
    const results = await Promise.allSettled(
      [...this.#adapters.values()].map((a) => a.dispose()),
    );
    this.#adapters.clear();
    this.#listeners.clear();
    this.#approvals.clear();
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
