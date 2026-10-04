import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  FilePermissionMode,
  ModelSummary,
  Thread,
  ThreadItem,
  Turn,
} from "../../protocol-client/types.js";
import type {
  AgentNativeSession,
  AgentProviderAdapter,
  AgentProviderEvent,
} from "./types.js";

type JsonObject = Record<string, unknown>;
interface NativeMessage {
  info: JsonObject;
  parts: JsonObject[];
}
interface Permission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
}

export interface OpenCodeAdapterOptions {
  executable?: string;
  /** Launch directory on this Host; restored sessions supply their own native directory. */
  processCwd?: string;
  defaultModel?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Dependency seam for process tests. No remote URL can be supplied. */
  spawnProcess?: typeof spawn;
}

/** Owns one Host-local OpenCode HTTP/SSE server; OpenCode retains all session history. */
export class OpenCodeAgentProviderAdapter implements AgentProviderAdapter {
  readonly capabilities = {
    models: true,
    interrupt: true,
    resume: true,
    changeModel: true,
    approvals: true,
    permissionModes: ["danger-full-access"] as FilePermissionMode[],
  };
  readonly #options: OpenCodeAdapterOptions;
  readonly #listeners = new Set<(event: AgentProviderEvent) => void>();
  readonly #directories = new Map<string, string>();
  readonly #approvals = new Map<string, Permission>();
  /** Process-local native stream projection, never persisted or used to reconstruct a session. */
  readonly #liveParts = new Map<string, Map<string, JsonObject>>();
  readonly #lifetime = new AbortController();
  #child: ChildProcess | undefined;
  #start: Promise<void> | undefined;
  #url: string | undefined;
  #authorization: string;
  #version = "";
  #disposed = false;
  #failure: Error | undefined;
  #pump: Promise<void> | undefined;
  #dispose: Promise<void> | undefined;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#options = options;
    const executable = options.executable ?? "opencode";
    if (!executable.trim() || executable.includes("\0"))
      throw new Error("Invalid OpenCode executable");
    if (
      options.processCwd !== undefined &&
      !path.isAbsolute(options.processCwd)
    )
      throw new Error("OpenCode launch directory must be absolute");
    this.#authorization = `Basic ${Buffer.from(`opencode:${randomBytes(32).toString("hex")}`).toString("base64")}`;
  }

  onEvent(listener: (event: AgentProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: AgentProviderEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* Observer isolation. */
      }
    }
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("OpenCode Agent Provider has stopped");
    if (this.#failure) throw this.#failure;
  }

  #fail(error: unknown): void {
    if (this.#disposed || this.#failure) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    this.#failure = new Error(
      `${cause.message}. Restart ZenX to reconnect to OpenCode's native sessions.`,
      { cause },
    );
    this.#clearApprovals();
    this.#emit({ type: "error", message: this.#failure.message });
  }

  #resolveApproval(requestId: string, nativeSessionId?: string): void {
    const sessionId =
      this.#approvals.get(requestId)?.sessionID ?? nativeSessionId;
    this.#approvals.delete(requestId);
    if (sessionId)
      this.#emit({ type: "approvalResolved", sessionId, requestId });
  }

  #clearApprovals(): void {
    for (const id of this.#approvals.keys()) this.#resolveApproval(id);
  }

  async #ready(): Promise<void> {
    this.#assertOpen();
    this.#start ??= this.#launch().catch(async (error) => {
      this.#fail(error);
      await this.#terminate();
      throw error;
    });
    await this.#start;
    this.#assertOpen();
  }

  async #launch(): Promise<void> {
    const password = Buffer.from(this.#authorization.slice(6), "base64")
      .toString()
      .slice("opencode:".length);
    const child = (this.#options.spawnProcess ?? spawn)(
      this.#options.executable ?? "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: this.#options.processCwd,
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: "opencode",
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      },
    );
    this.#child = child;
    child.stdout?.on("data", () => {
      /* Keep the pipe drained after the startup listener is removed. */
    });
    child.stderr?.on("data", () => {
      /* Drain without exposing credentials or retaining engine logs. */
    });
    child.on("error", (error) =>
      this.#fail(
        new Error(`OpenCode server could not start: ${error.message}`),
      ),
    );
    child.on("exit", (code, signal) =>
      this.#fail(
        new Error(`OpenCode server exited (${signal ?? code ?? "unknown"})`),
      ),
    );
    this.#url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout?.off("data", data);
        child.off("error", error);
        child.off("exit", exit);
        this.#lifetime.signal.removeEventListener("abort", aborted);
      };
      const error = (cause: Error): void => {
        cleanup();
        reject(new Error(`OpenCode server could not start: ${cause.message}`));
      };
      const exit = (): void => {
        cleanup();
        reject(new Error("OpenCode server stopped before it was ready"));
      };
      const aborted = (): void => {
        cleanup();
        reject(new Error("OpenCode server startup cancelled"));
      };
      const data = (chunk: Buffer): void => {
        output += chunk.toString();
        if (output.length > 65536) {
          cleanup();
          reject(new Error("OpenCode startup output exceeded the limit"));
          return;
        }
        const match = /opencode server listening on (http[^\s]+)(?=\s)/u.exec(
          output,
        );
        if (!match?.[1]) return;
        try {
          const url = new URL(match[1]);
          if (
            url.protocol !== "http:" ||
            url.hostname !== "127.0.0.1" ||
            !url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== "/"
          )
            throw new Error(
              "OpenCode did not bind a private Host-local server",
            );
          cleanup();
          resolve(url.origin);
        } catch (cause) {
          cleanup();
          reject(cause);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("OpenCode server startup timed out"));
      }, this.#options.startupTimeoutMs ?? 15000);
      child.stdout?.on("data", data);
      child.once("error", error);
      child.once("exit", exit);
      this.#lifetime.signal.addEventListener("abort", aborted, { once: true });
      if (this.#lifetime.signal.aborted) aborted();
    });
    const health = object(
      await this.#request("/global/health"),
      "OpenCode health",
    );
    this.#version = requiredString(health.version, "OpenCode version");
    if (health.healthy !== true || !compatibleVersion(this.#version))
      throw new Error(
        `Unsupported OpenCode server version: ${this.#version}; requires 1.15.13 or later in major version 1`,
      );
    const opening = new AbortController();
    const timer = setTimeout(
      () => opening.abort(),
      this.#options.requestTimeoutMs ?? 10000,
    );
    let response: Response;
    try {
      response = await fetch(`${this.#url}/global/event`, {
        headers: { Authorization: this.#authorization },
        signal: AbortSignal.any([this.#lifetime.signal, opening.signal]),
        redirect: "error",
      });
    } finally {
      clearTimeout(timer);
    }
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    )
      throw new Error(`OpenCode event stream failed (HTTP ${response.status})`);
    // The stream owns only the lifetime signal after its headers arrive; do not time out an idle engine.
    this.#pump = this.#consumeEvents(response.body).catch((error) =>
      this.#fail(error),
    );
  }

  async #request(
    endpoint: string,
    options: {
      method?: string;
      body?: unknown;
      cwd?: string;
      query?: Record<string, string>;
    } = {},
  ): Promise<unknown> {
    this.#assertOpen();
    if (!this.#url) throw new Error("OpenCode server is not ready");
    const url = new URL(endpoint, `${this.#url}/`);
    if (options.cwd) url.searchParams.set("directory", options.cwd);
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: this.#authorization,
        "Content-Type": "application/json",
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.any([
        this.#lifetime.signal,
        AbortSignal.timeout(this.#options.requestTimeoutMs ?? 10000),
      ]),
      redirect: "error",
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      const uncertainty =
        options.method === "POST"
          ? "; its native outcome may be unknown. Inspect the session before retrying"
          : "";
      throw new Error(`OpenCode request failed${uncertainty}: ${detail}`);
    });
    if (!response.ok)
      throw new Error(
        `OpenCode ${options.method ?? "GET"} ${endpoint} failed (HTTP ${response.status})`,
      );
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text.length > 32 * 1024 * 1024)
      throw new Error("OpenCode response exceeded the limit");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid OpenCode JSON response from ${endpoint}`);
    }
  }

  async #consumeEvents(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    try {
      while (!this.#disposed) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (!this.#disposed) throw new Error("OpenCode event stream closed");
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 1024 * 1024)
          throw new Error("OpenCode event frame exceeded the limit");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/u, "");
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("data:")) {
            data.push(line.slice(5).trimStart());
            if (
              data.reduce((length, line) => length + line.length, 0) >
              1024 * 1024
            )
              throw new Error("OpenCode event frame exceeded the limit");
          } else if (line === "") {
            if (data.length) this.#receiveEvent(JSON.parse(data.join("\n")));
            data = [];
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  #receiveEvent(value: unknown): void {
    const envelope = object(value, "OpenCode event");
    const event = object(
      envelope.payload ?? envelope,
      "OpenCode event payload",
    );
    const type = requiredString(event.type, "OpenCode event type");
    const properties = object(
      event.properties ?? {},
      "OpenCode event properties",
    );
    const info = optionalObject(properties.info);
    const part = optionalObject(properties.part);
    const nativeSessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : typeof info?.sessionID === "string"
          ? info.sessionID
          : typeof part?.sessionID === "string"
            ? part.sessionID
            : type.startsWith("session.") && typeof info?.id === "string"
              ? info.id
              : undefined;
    if (!nativeSessionId) return;
    if (
      type === "message.part.updated" &&
      part &&
      (part.type === "text" || part.type === "reasoning")
    ) {
      const parts =
        this.#liveParts.get(nativeSessionId) ?? new Map<string, JsonObject>();
      parts.set(requiredString(part.id, "OpenCode live part ID"), { ...part });
      this.#liveParts.set(nativeSessionId, parts);
    } else if (
      type === "message.part.delta" &&
      properties.field === "text" &&
      typeof properties.partID === "string" &&
      typeof properties.delta === "string"
    ) {
      const live = this.#liveParts.get(nativeSessionId)?.get(properties.partID);
      if (live && typeof live.text === "string") live.text += properties.delta;
    } else if (
      type === "message.part.removed" &&
      typeof properties.partID === "string"
    ) {
      this.#liveParts.get(nativeSessionId)?.delete(properties.partID);
    } else if (
      type === "message.removed" &&
      typeof properties.messageID === "string"
    ) {
      for (const [id, live] of this.#liveParts.get(nativeSessionId) ?? [])
        if (live.messageID === properties.messageID)
          this.#liveParts.get(nativeSessionId)?.delete(id);
    } else if (
      type === "session.idle" ||
      (type === "session.status" &&
        optionalObject(properties.status)?.type === "idle")
    ) {
      this.#liveParts.delete(nativeSessionId);
    }
    if (type === "permission.asked") {
      const permission = parsePermission(properties);
      this.#approvals.set(permission.id, permission);
      this.#emitApproval(permission);
    } else if (type === "permission.replied") {
      if (typeof properties.requestID === "string")
        this.#resolveApproval(properties.requestID, nativeSessionId);
      this.#emit({ type: "changed", sessionId: nativeSessionId });
    } else if (type === "question.asked") {
      this.#emit({
        type: "error",
        sessionId: nativeSessionId,
        message:
          "OpenCode requested structured user input. This adapter does not support answering it; use OpenCode’s native UI or interrupt the turn.",
      });
    } else if (type === "session.error") {
      this.#emit({
        type: "error",
        sessionId: nativeSessionId,
        message: nativeError(properties.error),
      });
    } else if (type.startsWith("message.") || type.startsWith("session.")) {
      this.#emit({ type: "changed", sessionId: nativeSessionId });
    }
  }

  #emitApproval(permission: Permission): void {
    this.#emit({
      type: "approval",
      sessionId: permission.sessionID,
      requestId: permission.id,
      title: `OpenCode: ${permission.permission}`,
      detail: permission.patterns.join("\n"),
    });
  }

  async models(): Promise<ModelSummary[]> {
    await this.#ready();
    const providers = object(
      await this.#request("/provider"),
      "OpenCode providers",
    );
    const config = object(await this.#request("/config"), "OpenCode config");
    if (!Array.isArray(providers.all) || !Array.isArray(providers.connected))
      throw new Error("Invalid OpenCode provider catalog");
    const connected = new Set(
      providers.connected.map((value) =>
        requiredString(value, "connected provider"),
      ),
    );
    const defaults = object(providers.default, "OpenCode default models");
    const defaultModel =
      this.#options.defaultModel ??
      (typeof config.model === "string" ? config.model : undefined);
    const models: ModelSummary[] = [];
    for (const providerValue of providers.all) {
      const provider = object(providerValue, "OpenCode provider");
      const providerId = requiredString(provider.id, "provider ID");
      if (!connected.has(providerId)) continue;
      for (const modelValue of Object.values(
        object(provider.models, "OpenCode models"),
      )) {
        const model = object(modelValue, "OpenCode model");
        const id = `${providerId}/${requiredString(model.id, "model ID")}`;
        const capabilities = optionalObject(model.capabilities);
        const input = optionalObject(capabilities?.input);
        models.push({
          id,
          model: id,
          displayName: `${typeof provider.name === "string" ? provider.name : providerId} · ${typeof model.name === "string" ? model.name : model.id}`,
          description: "OpenCode native model",
          hidden: false,
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: input?.image === true ? ["text", "image"] : ["text"],
          supportsPersonality: false,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: defaultModel
            ? id === defaultModel
            : models.length === 0 && defaults[providerId] === model.id,
        });
      }
    }
    if (!models.some((model) => model.isDefault) && !defaultModel && models[0])
      models[0].isDefault = true;
    return models;
  }

  async create(input: {
    cwd: string;
    model?: string;
    permissionMode: FilePermissionMode;
  }): Promise<AgentNativeSession> {
    this.#assertOpen();
    if (input.permissionMode !== "danger-full-access")
      throw new Error(
        "OpenCode has native tool approvals but no equivalent filesystem sandbox. Only danger-full-access is supported; read-only and workspace-write are unavailable.",
      );
    if (!path.isAbsolute(input.cwd) || input.cwd.includes("\0"))
      throw new Error("OpenCode workspace must be absolute");
    const models = await this.models();
    const model =
      input.model ??
      this.#options.defaultModel ??
      models.find((model) => model.isDefault)?.id;
    if (!model || !models.some((entry) => entry.id === model))
      throw new Error("Select an available OpenCode native model");
    const selected = splitModel(model);
    const session = parseSession(
      await this.#request("/session", {
        method: "POST",
        cwd: input.cwd,
        body: {
          agent: "build",
          model: { providerID: selected.providerID, id: selected.modelID },
        },
      }),
    );
    if (!(await sameDirectory(input.cwd, session.directory as string)))
      throw new Error(
        `OpenCode created native session ${String(session.id)} in an unexpected workspace. The native session remains in OpenCode; do not retry creation blindly.`,
      );
    this.#directories.set(session.id as string, session.directory as string);
    return this.read(session.id as string);
  }

  async read(nativeSessionId: string): Promise<AgentNativeSession> {
    validateId(nativeSessionId);
    await this.#ready();
    const session = parseSession(
      await this.#request(`/session/${encodeURIComponent(nativeSessionId)}`, {
        cwd: this.#directories.get(nativeSessionId),
      }),
    );
    if (session.id !== nativeSessionId)
      throw new Error("OpenCode returned a different session");
    const cwd = session.directory as string;
    this.#directories.set(nativeSessionId, cwd);
    const approvalsBeforeRead = new Set(this.#approvals.keys());
    const [history, status, pending] = await Promise.all([
      this.#history(nativeSessionId, cwd),
      this.#request("/session/status", { cwd }),
      this.#request("/permission", { cwd }),
    ]);
    if (!Array.isArray(history) || !Array.isArray(pending))
      throw new Error("Invalid OpenCode session history or permissions");
    const messages = history;
    const statuses = object(status, "OpenCode session status");
    const nativeStatus = optionalObject(statuses[nativeSessionId]);
    const active =
      nativeStatus?.type !== undefined && nativeStatus.type !== "idle";
    // Canonical history always comes from the engine. While active, add only its current native SSE presentation.
    if (active)
      for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        for (const [id, live] of this.#liveParts.get(nativeSessionId) ?? []) {
          if (live.messageID !== message.info.id) continue;
          const index = message.parts.findIndex((part) => part.id === id);
          if (index < 0) message.parts.push({ ...live });
          else message.parts[index] = { ...live };
        }
      }
    for (const permissionValue of pending) {
      const permission = parsePermission(permissionValue);
      if (
        permission.sessionID === nativeSessionId &&
        !this.#approvals.has(permission.id)
      ) {
        this.#approvals.set(permission.id, permission);
        this.#emitApproval(permission);
      }
    }
    for (const [id, approval] of this.#approvals) {
      if (
        approval.sessionID === nativeSessionId &&
        approvalsBeforeRead.has(id) &&
        !pending.some((value) => optionalObject(value)?.id === id)
      )
        this.#resolveApproval(id);
    }
    const nativeModel = optionalObject(session.model);
    const lastModelMessage = [...messages]
      .reverse()
      .find((message) => message.info.role === "assistant");
    const userModel = [...messages]
      .reverse()
      .map((message) => optionalObject(message.info.model))
      .find(Boolean);
    const selected =
      lastModelMessage &&
      typeof lastModelMessage.info.providerID === "string" &&
      typeof lastModelMessage.info.modelID === "string"
        ? `${lastModelMessage.info.providerID}/${lastModelMessage.info.modelID}`
        : userModel &&
            typeof userModel.providerID === "string" &&
            typeof userModel.modelID === "string"
          ? `${userModel.providerID}/${userModel.modelID}`
          : nativeModel &&
              typeof nativeModel.providerID === "string" &&
              typeof nativeModel.id === "string"
            ? `${nativeModel.providerID}/${nativeModel.id}`
            : "";
    return {
      nativeSessionId,
      model: selected,
      thread: projectSession(session, messages, active, this.#version),
    };
  }

  async #history(
    nativeSessionId: string,
    cwd: string,
  ): Promise<NativeMessage[]> {
    const messages: NativeMessage[] = [];
    const seen = new Set<string>();
    let before: string | undefined;
    for (;;) {
      const result = await this.#request(
        `/session/${encodeURIComponent(nativeSessionId)}/message`,
        { cwd, query: { limit: "100", ...(before ? { before } : {}) } },
      );
      if (!Array.isArray(result))
        throw new Error("Invalid OpenCode session history page");
      if (result.length === 0) return messages;
      const page = result.map((value) => parseMessage(value, nativeSessionId));
      // Native message pages are chronological; their first native ID is the backwards cursor.
      const cursor = page[0]!.info.id as string;
      if (
        cursor === before ||
        page.some((message) => seen.has(message.info.id as string))
      )
        throw new Error(
          "OpenCode history pagination made no progress; complete native history could not be loaded",
        );
      for (const message of page) seen.add(message.info.id as string);
      messages.unshift(...page);
      if (messages.length > 100000)
        throw new Error(
          "OpenCode native history exceeds the display limit; no partial history will be shown as complete",
        );
      before = cursor;
    }
  }

  async send(
    nativeSessionId: string,
    input: { text: string; model?: string },
  ): Promise<void> {
    validateId(nativeSessionId);
    if (
      !input.text.trim() ||
      input.text.length > 1_000_000 ||
      input.text.includes("\0")
    )
      throw new Error("Invalid OpenCode prompt");
    const native = await this.read(nativeSessionId);
    if (
      input.model &&
      !(await this.models()).some((model) => model.id === input.model)
    )
      throw new Error("Unknown OpenCode native model");
    await this.#request(
      `/session/${encodeURIComponent(nativeSessionId)}/prompt_async`,
      {
        method: "POST",
        cwd: native.thread.cwd,
        body: {
          agent: "build",
          ...(input.model ? { model: splitModel(input.model) } : {}),
          parts: [{ type: "text", text: input.text }],
        },
      },
    );
    this.#emit({ type: "changed", sessionId: nativeSessionId });
  }

  async interrupt(nativeSessionId: string): Promise<void> {
    validateId(nativeSessionId);
    await this.#ready();
    const native = await this.read(nativeSessionId);
    if (
      (await this.#request(
        `/session/${encodeURIComponent(nativeSessionId)}/abort`,
        { method: "POST", cwd: native.thread.cwd },
      )) !== true
    )
      throw new Error("OpenCode did not acknowledge interruption");
  }

  async respondApproval(
    requestId: string,
    decision: "accept" | "decline",
  ): Promise<void> {
    validateId(requestId);
    await this.#ready();
    if (decision !== "accept" && decision !== "decline")
      throw new Error("Invalid OpenCode approval decision");
    const permission = this.#approvals.get(requestId);
    if (!permission)
      throw new Error("Unknown or resolved OpenCode permission request");
    if (
      (await this.#request(
        `/permission/${encodeURIComponent(requestId)}/reply`,
        {
          method: "POST",
          cwd: this.#directories.get(permission.sessionID),
          body: { reply: decision === "accept" ? "once" : "reject" },
        },
      )) !== true
    )
      throw new Error("OpenCode did not acknowledge the permission response");
    this.#resolveApproval(requestId, permission.sessionID);
    this.#emit({ type: "changed", sessionId: permission.sessionID });
  }

  async #terminate(): Promise<void> {
    this.#lifetime.abort();
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    if (!(await settlesWithin(exited, 1500))) {
      child.kill("SIGKILL");
      if (!(await settlesWithin(exited, 1500)))
        throw new Error("OpenCode server did not stop");
    }
  }

  dispose(): Promise<void> {
    this.#dispose ??= (async () => {
      this.#disposed = true;
      await this.#terminate();
      await this.#pump;
      this.#clearApprovals();
      this.#listeners.clear();
      this.#directories.clear();
      this.#liveParts.clear();
      this.#authorization = "";
    })();
    return this.#dispose;
  }
}

async function settlesWithin(
  promise: Promise<void>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}
function optionalObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error(`Invalid ${label}`);
  return value;
}
function validateId(value: string): void {
  if (!value || value.length > 512 || value.includes("\0"))
    throw new Error("Invalid OpenCode native ID");
}
function compatibleVersion(version: string): boolean {
  const match = /^1\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  return (
    !!match &&
    (Number(match[1]) > 15 ||
      (Number(match[1]) === 15 && Number(match[2]) >= 13))
  );
}
async function sameDirectory(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    realpath(left).catch(() => path.resolve(left)),
    realpath(right).catch(() => path.resolve(right)),
  ]);
  return a === b;
}
function splitModel(value: string): { providerID: string; modelID: string } {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1)
    throw new Error("OpenCode model must be a native provider/model ID");
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}
function parsePermission(value: unknown): Permission {
  const row = object(value, "OpenCode permission");
  if (!Array.isArray(row.patterns))
    throw new Error("Invalid OpenCode permission patterns");
  return {
    id: requiredString(row.id, "permission ID"),
    sessionID: requiredString(row.sessionID, "permission session"),
    permission: requiredString(row.permission, "permission name"),
    patterns: row.patterns.map((pattern) =>
      requiredString(pattern, "permission pattern"),
    ),
  };
}
function parseSession(value: unknown): JsonObject {
  const session = object(value, "OpenCode session");
  requiredString(session.id, "session ID");
  if (!path.isAbsolute(requiredString(session.directory, "session directory")))
    throw new Error("Invalid OpenCode session directory");
  const time = object(session.time, "session timestamps");
  if (
    typeof time.created !== "number" ||
    typeof time.updated !== "number" ||
    !Number.isFinite(time.created) ||
    !Number.isFinite(time.updated)
  )
    throw new Error("Invalid OpenCode session timestamps");
  return session;
}
function parseMessage(value: unknown, sessionId: string): NativeMessage {
  const row = object(value, "OpenCode message");
  const info = object(row.info, "OpenCode message info");
  requiredString(info.id, "message ID");
  if (
    info.sessionID !== sessionId ||
    !["user", "assistant"].includes(String(info.role)) ||
    !Array.isArray(row.parts)
  )
    throw new Error("Invalid OpenCode native message");
  return {
    info,
    parts: row.parts.map((value) => object(value, "OpenCode message part")),
  };
}
function nativeError(value: unknown): string {
  const error = optionalObject(value);
  const data = optionalObject(error?.data);
  return typeof data?.message === "string"
    ? data.message
    : typeof error?.message === "string"
      ? error.message
      : "OpenCode reported an engine error";
}

function projectSession(
  session: JsonObject,
  messages: NativeMessage[],
  active: boolean,
  version: string,
): Thread {
  const id = session.id as string;
  const cwd = session.directory as string;
  const time = session.time as JsonObject;
  const turns: Turn[] = [];
  const userTurns = new Map<string, Turn>();
  let current: Turn | undefined;
  for (const message of messages) {
    const messageTime = optionalObject(message.info.time);
    if (message.info.role === "user") {
      current = {
        id: message.info.id as string,
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt:
          typeof messageTime?.created === "number" ? messageTime.created : null,
        completedAt: null,
        durationMs: null,
      };
      turns.push(current);
      userTurns.set(current.id, current);
      current.items.push({
        type: "userMessage",
        id: current.id,
        clientId: null,
        content: message.parts
          .filter(
            (part) =>
              part.type === "text" &&
              part.ignored !== true &&
              part.synthetic !== true,
          )
          .map((part) => ({
            type: "text",
            text: typeof part.text === "string" ? part.text : "",
            text_elements: [],
          })),
      });
    } else {
      const turn =
        typeof message.info.parentID === "string"
          ? (userTurns.get(message.info.parentID) ?? current)
          : current;
      if (!turn) continue;
      for (const part of message.parts) {
        const item = projectPart(part, cwd);
        if (item) turn.items.push(item);
      }
      if (message.info.error) {
        turn.status =
          optionalObject(message.info.error)?.name === "MessageAbortedError"
            ? "interrupted"
            : "failed";
        turn.error = {
          message: nativeError(message.info.error),
          codexErrorInfo: null,
          additionalDetails: null,
        };
      }
      if (typeof messageTime?.completed === "number") {
        turn.completedAt = messageTime.completed;
        turn.durationMs =
          turn.startedAt === null
            ? null
            : messageTime.completed - turn.startedAt;
      }
    }
  }
  if (active && turns.at(-1)?.status === "completed")
    turns.at(-1)!.status = "inProgress";
  const preview = turns
    .flatMap((turn) => turn.items)
    .find((item) => item.type === "userMessage");
  const model = optionalObject(session.model);
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId:
      typeof session.parentID === "string" ? session.parentID : null,
    preview:
      preview?.type === "userMessage"
        ? preview.content
            .map((part) => part.text)
            .join("\n")
            .slice(0, 300)
        : "",
    ephemeral: false,
    isPinned: false,
    modelProvider:
      typeof model?.providerID === "string" ? model.providerID : "opencode",
    createdAt: Math.floor((time.created as number) / 1000),
    updatedAt: Math.floor((time.updated as number) / 1000),
    recencyAt: null,
    status: active ? { type: "active", activeFlags: [] } : { type: "idle" },
    path: null,
    cwd,
    cliVersion: `opencode/${version}`,
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: typeof session.title === "string" ? session.title : null,
    turns,
  };
}
function projectPart(part: JsonObject, cwd: string): ThreadItem | undefined {
  const id = requiredString(part.id, "OpenCode part ID");
  if (part.type === "text")
    return {
      type: "agentMessage",
      id,
      text: typeof part.text === "string" ? part.text : "",
      phase: "final_answer",
      memoryCitation: null,
    };
  if (part.type === "reasoning")
    return {
      type: "reasoning",
      id,
      summary: [],
      content: [typeof part.text === "string" ? part.text : ""],
    };
  if (part.type !== "tool") return undefined;
  const state = object(part.state, "OpenCode tool state");
  const input = optionalObject(state.input) ?? {};
  const tool = requiredString(part.tool, "OpenCode tool name");
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: typeof input.command === "string" ? input.command : tool,
    cwd,
    processId: null,
    source: "agent",
    status:
      state.status === "completed"
        ? "completed"
        : state.status === "error"
          ? "failed"
          : "inProgress",
    commandActions: [],
    aggregatedOutput:
      typeof state.output === "string"
        ? state.output
        : typeof state.error === "string"
          ? state.error
          : null,
    exitCode: null,
    durationMs: null,
    toolName: tool,
    toolArguments: input,
    ...(typeof part.callID === "string" ? { callId: part.callID } : {}),
  };
}
