import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  observeOwnedChild,
  type OwnedChildObservation,
} from "../owned-child-process.js";
import type {
  ModelSummary,
  Thread,
  ThreadItem,
  Turn,
} from "../../protocol-client/types.js";
import type {
  AgentNativeSession,
  AgentProviderAdapter,
  AgentProviderCapabilities,
  AgentProviderEvent,
} from "./types.js";

/** This boundary speaks Codex's installed app-server protocol, not Zen's CAS facade.
 * Wire verified against codex-cli 0.159.2 generate-ts and the pinned T3 reference.
 * Native rollouts remain authoritative; only uncommitted live display tails are retained.
 */
export interface CodexAgentAdapterOptions {
  binaryPath?: string;
  /** Complete argv override, primarily for a controlled protocol peer in tests. */
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  terminationGraceMs?: number;
}

type JsonRecord = Record<string, unknown>;
type WireId = string | number;
interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Approval {
  wireId: WireId;
  sessionId: string;
  turnId: string | undefined;
}
interface LiveTurn {
  turn: Turn;
  items: Map<string, ThreadItem>;
  bytes: number;
}
interface Connection {
  child: ChildProcessWithoutNullStreams;
  observation: OwnedChildObservation;
  ready: boolean;
  closing: boolean;
  failed: boolean;
  buffer: string;
  nextId: number;
  pending: Map<string, PendingRequest>;
  approvals: Map<string, Approval>;
  loaded: Map<string, { model: string; cwd: string }>;
  loading: Map<string, Promise<void>>;
  live: Map<string, Map<string, LiveTurn>>;
  closePromise?: Promise<void>;
}
const MAX_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 1024;
const MAX_APPROVALS = 256;
const MAX_LIVE_TURNS = 64;

export class CodexAgentAdapter implements AgentProviderAdapter {
  readonly capabilities: AgentProviderCapabilities = {
    models: true,
    interrupt: true,
    resume: true,
    changeModel: true,
    approvals: true,
    permissionModes: ["read-only", "workspace-write", "danger-full-access"],
  };
  readonly #options: CodexAgentAdapterOptions;
  readonly #listeners = new Set<(event: AgentProviderEvent) => void>();
  #connection: Connection | undefined;
  #starting: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  #disposed = false;

  constructor(options: CodexAgentAdapterOptions = {}) {
    this.#options = options;
  }

  onEvent(listener: (event: AgentProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new Error("Codex adapter has been disposed");
    if (this.#stopping) await this.#stopping;
    if (this.#disposed) throw new Error("Codex adapter has been disposed");
    if (this.#connection?.ready && !this.#connection.failed) return;
    if (this.#starting) return this.#starting;
    // A failed child must actually close before a replacement can own its transport.
    if (this.#connection) await this.stop();
    const starting = this.#launch();
    this.#starting = starting;
    try {
      await starting;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }

  async models(): Promise<ModelSummary[]> {
    const connection = await this.#ready();
    const rows = await this.#pages(connection, "model/list", { limit: 100 });
    return rows.map(projectModel);
  }

  async create(input: {
    cwd: string;
    model?: string;
    permissionMode: "read-only" | "workspace-write" | "danger-full-access";
  }): Promise<AgentNativeSession> {
    requireText(input.cwd, "Working directory");
    if (
      !["read-only", "workspace-write", "danger-full-access"].includes(
        input.permissionMode,
      )
    ) {
      throw new Error("Unsupported Codex file permission mode");
    }
    const connection = await this.#ready();
    const result = record(
      await this.#request(connection, "thread/start", {
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        sandbox: input.permissionMode,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      }),
    );
    const thread = record(result.thread);
    const id = requireText(thread.id, "Codex thread id");
    connection.loaded.set(id, {
      model: text(result.model) ?? text(thread.model) ?? "",
      cwd: input.cwd,
    });
    return this.#project(connection, thread);
  }

  async read(nativeSessionId: string): Promise<AgentNativeSession> {
    const connection = await this.#ready();
    await this.#load(connection, nativeSessionId);
    // New Codex rollouts can be paginated. Never guess a missing history is empty.
    const metadata = record(
      await this.#request(connection, "thread/read", {
        threadId: nativeSessionId,
        includeTurns: false,
      }),
    );
    let thread = record(metadata.thread);
    if (thread.historyMode === "paginated") {
      const turns = await this.#pages(connection, "thread/turns/list", {
        threadId: nativeSessionId,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
      });
      thread = { ...thread, turns };
    } else {
      const result = record(
        await this.#request(connection, "thread/read", {
          threadId: nativeSessionId,
          includeTurns: true,
        }),
      );
      thread = record(result.thread);
    }
    if (thread.id !== nativeSessionId)
      throw new Error("Codex returned a different thread identity");
    return this.#project(connection, thread);
  }

  async send(
    nativeSessionId: string,
    input: { text: string; model?: string },
  ): Promise<void> {
    requireText(input.text, "Message");
    const connection = await this.#ready();
    await this.#load(connection, nativeSessionId);
    const result = record(
      await this.#request(connection, "turn/start", {
        threadId: nativeSessionId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
        ...(input.model ? { model: input.model } : {}),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      }),
    );
    const turn = record(result.turn);
    // The response may trail streaming notifications; do not regress their items/status.
    if (
      !connection.live
        .get(nativeSessionId)
        ?.has(requireText(turn.id, "Codex turn id"))
    ) {
      this.#updateTurn(connection, nativeSessionId, turn);
    }
    const loaded = connection.loaded.get(nativeSessionId);
    if (input.model && loaded) loaded.model = input.model;
    this.#emit({ type: "changed", sessionId: nativeSessionId });
  }

  async interrupt(nativeSessionId: string): Promise<void> {
    const connection = await this.#ready();
    await this.#load(connection, nativeSessionId);
    let active = [
      ...(connection.live.get(nativeSessionId)?.values() ?? []),
    ].findLast((entry) => entry.turn.status === "inProgress")?.turn;
    if (!active) {
      const snapshot = await this.read(nativeSessionId);
      active = snapshot.thread.turns.findLast(
        (turn) => turn.status === "inProgress",
      );
    }
    if (!active)
      throw new Error("Codex thread has no active turn to interrupt");
    await this.#request(connection, "turn/interrupt", {
      threadId: nativeSessionId,
      turnId: active.id,
    });
    // The interrupt receipt does not prove completion; native turn/completed does.
  }

  async respondApproval(
    requestId: string,
    decision: "accept" | "decline",
  ): Promise<void> {
    if (decision !== "accept" && decision !== "decline")
      throw new Error("Invalid approval decision");
    const connection = this.#connection;
    const approval = connection?.approvals.get(requestId);
    if (!connection || !approval || connection.closing || connection.failed) {
      throw new Error("Codex approval is no longer pending in this process");
    }
    // One exact process + wire request identity. No session-wide or future grant.
    this.#resolveApproval(connection, requestId, approval);
    await this.#write(connection, {
      id: approval.wireId,
      result: { decision },
    });
    this.#emit({ type: "changed", sessionId: approval.sessionId });
  }

  async stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const connection = this.#connection;
    if (!connection) return;
    const stopping = Promise.resolve().then(() => this.#close(connection));
    this.#stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopping === stopping) this.#stopping = undefined;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.stop();
    this.#listeners.clear();
  }

  async #ready(): Promise<Connection> {
    await this.start();
    const connection = this.#connection;
    if (!connection?.ready || connection.closing || connection.failed) {
      throw new Error("Codex app-server is unavailable");
    }
    return connection;
  }

  async #launch(): Promise<void> {
    const child = spawn(
      this.#options.binaryPath ?? "codex",
      [...(this.#options.args ?? ["app-server"])],
      {
        cwd: this.#options.cwd,
        env: { ...process.env, ...this.#options.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      },
    );
    const connection: Connection = {
      child,
      observation: observeOwnedChild(child),
      ready: false,
      closing: false,
      failed: false,
      buffer: "",
      nextId: 1,
      pending: new Map(),
      approvals: new Map(),
      loaded: new Map(),
      loading: new Map(),
      live: new Map(),
    };
    this.#connection = connection;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) =>
      this.#incoming(connection, chunk),
    );
    child.stdout.on("error", (error) => this.#fail(connection, error));
    child.stdin.on("error", (error) => this.#fail(connection, error));
    // Consume stderr, but never mirror potential credentials/configuration into UI events.
    child.stderr.resume();
    child.stderr.on("error", (error) => this.#fail(connection, error));
    child.on("error", (error) =>
      this.#fail(
        connection,
        new Error(`Codex app-server process error: ${error.message}`),
      ),
    );
    void connection.observation.terminal.then((outcome) => {
      if (!connection.closing) {
        const suffix =
          outcome.type === "spawn_error"
            ? outcome.error.message
            : `exit ${outcome.code ?? outcome.signal ?? "unknown"}`;
        this.#fail(
          connection,
          new Error(`Codex app-server closed (${suffix})`),
        );
      }
      this.#rejectPending(connection, new Error("Codex app-server closed"));
      this.#clearApprovals(connection);
      connection.live.clear();
      connection.loaded.clear();
      if (this.#connection === connection) this.#connection = undefined;
    });
    try {
      await this.#request(connection, "initialize", {
        clientInfo: { name: "zenx", title: "ZenX", version: "0.1.0" },
        capabilities: null,
      });
      await this.#write(connection, { method: "initialized" });
      connection.ready = true;
    } catch (error) {
      await this.#close(connection);
      throw error;
    }
  }

  #incoming(connection: Connection, chunk: string): void {
    if (connection.closing || connection.failed) return;
    connection.buffer += chunk;
    try {
      let newline: number;
      while ((newline = connection.buffer.indexOf("\n")) >= 0) {
        const line = connection.buffer.slice(0, newline);
        connection.buffer = connection.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_WIRE_BYTES)
          throw new Error("Codex protocol line exceeded the safety limit");
        if (line.trim()) this.#message(connection, JSON.parse(line));
      }
      if (Buffer.byteLength(connection.buffer) > MAX_WIRE_BYTES)
        throw new Error("Codex protocol line exceeded the safety limit");
    } catch (error) {
      this.#fail(
        connection,
        new Error(`Codex protocol error: ${asError(error).message}`),
      );
      connection.child.kill("SIGTERM");
    }
  }

  #message(connection: Connection, value: unknown): void {
    const message = record(value);
    if (typeof message.method === "string") {
      if (isWireId(message.id))
        this.#serverRequest(
          connection,
          message.id,
          message.method,
          record(message.params),
        );
      else if (!("id" in message))
        this.#notification(connection, message.method, record(message.params));
      else throw new Error("Invalid Codex server request id");
      return;
    }
    if (!isWireId(message.id) || "result" in message === "error" in message)
      throw new Error("Invalid Codex response envelope");
    const key = wireKey(message.id);
    const pending = connection.pending.get(key);
    if (!pending) return; // A timed-out request can have a late native receipt.
    connection.pending.delete(key);
    clearTimeout(pending.timer);
    if ("error" in message) {
      const error = record(message.error);
      pending.reject(
        new Error(
          `Codex ${pending.method}: ${text(error.message) ?? "request failed"}`,
        ),
      );
    } else pending.resolve(message.result);
  }

  async #request(
    connection: Connection,
    method: string,
    params: JsonRecord,
  ): Promise<unknown> {
    if (connection.closing || connection.failed)
      throw new Error("Codex app-server is unavailable");
    if (connection.pending.size >= MAX_PENDING_REQUESTS)
      throw new Error("Too many pending Codex requests");
    const id = connection.nextId++;
    const key = wireKey(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(key);
        reject(
          new Error(
            `Codex ${method} timed out; its native outcome may be unknown`,
          ),
        );
      }, this.#options.requestTimeoutMs ?? 30_000);
      timer.unref();
      connection.pending.set(key, { method, resolve, reject, timer });
      void this.#write(connection, { id, method, params }).catch(
        (error: unknown) => {
          const pending = connection.pending.get(key);
          if (!pending) return;
          connection.pending.delete(key);
          clearTimeout(pending.timer);
          reject(asError(error));
        },
      );
    });
  }

  async #write(connection: Connection, message: JsonRecord): Promise<void> {
    if (
      connection.closing ||
      connection.failed ||
      connection.observation.outcome()
    )
      throw new Error("Codex app-server is unavailable");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_WIRE_BYTES)
      throw new Error("Codex request exceeded the safety limit");
    return new Promise((resolve, reject) => {
      connection.child.stdin.write(line, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async #pages(
    connection: Connection,
    method: string,
    params: JsonRecord,
  ): Promise<unknown[]> {
    const rows: unknown[] = [];
    const cursors = new Set<string | null>();
    let cursor: string | null = null;
    do {
      if (cursors.has(cursor))
        throw new Error(`Codex ${method} repeated a pagination cursor`);
      cursors.add(cursor);
      const page = record(
        await this.#request(connection, method, { ...params, cursor }),
      );
      if (!Array.isArray(page.data))
        throw new Error(`Codex ${method} returned invalid data`);
      rows.push(...page.data);
      if (page.nextCursor !== null && typeof page.nextCursor !== "string")
        throw new Error(`Codex ${method} returned an invalid cursor`);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return rows;
  }

  async #load(connection: Connection, id: string): Promise<void> {
    requireText(id, "Codex thread id");
    if (connection.loaded.has(id)) return;
    const pending = connection.loading.get(id);
    if (pending) return pending;
    const loading = (async () => {
      const result = record(
        await this.#request(connection, "thread/resume", {
          threadId: id,
          excludeTurns: true,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        }),
      );
      const thread = record(result.thread);
      if (thread.id !== id)
        throw new Error("Codex resumed a different thread identity");
      connection.loaded.set(id, {
        model: text(result.model) ?? text(thread.model) ?? "",
        cwd: text(thread.cwd) ?? "",
      });
    })();
    connection.loading.set(id, loading);
    try {
      await loading;
    } finally {
      connection.loading.delete(id);
    }
  }

  #serverRequest(
    connection: Connection,
    wireId: WireId,
    method: string,
    params: JsonRecord,
  ): void {
    const sessionId = text(params.threadId);
    if (
      sessionId &&
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(method)
    ) {
      if (connection.approvals.size >= MAX_APPROVALS)
        throw new Error("Too many pending Codex approvals");
      if (
        [...connection.approvals.values()].some(
          (entry) => wireKey(entry.wireId) === wireKey(wireId),
        )
      )
        throw new Error("Duplicate Codex approval request id");
      const requestId = randomUUID();
      connection.approvals.set(requestId, {
        wireId,
        sessionId,
        turnId: text(params.turnId),
      });
      this.#emit({
        type: "approval",
        sessionId,
        requestId,
        title: method.includes("commandExecution")
          ? "Codex command approval"
          : "Codex file change approval",
        detail: approvalDetail(method, params),
      });
      return;
    }
    // Asking questions, issuing credential refreshes or granting permission objects
    // cannot be represented by a yes/no approval. Fail closed, visibly and explicitly.
    const message = `Unsupported Codex server request: ${method}`;
    void this.#write(connection, {
      id: wireId,
      error: { code: -32601, message },
    }).catch((error: unknown) => this.#fail(connection, asError(error)));
    this.#emit({ type: "error", ...(sessionId ? { sessionId } : {}), message });
  }

  #notification(
    connection: Connection,
    method: string,
    params: JsonRecord,
  ): void {
    const sessionId = text(params.threadId) ?? text(record(params.thread).id);
    if (method === "error") {
      this.#emit({
        type: "error",
        ...(sessionId ? { sessionId } : {}),
        message:
          text(record(params.error).message) ?? "Codex reported an error",
      });
    }
    if (!sessionId) return;
    if (method === "serverRequest/resolved" && isWireId(params.requestId)) {
      for (const [id, approval] of connection.approvals) {
        if (
          approval.sessionId === sessionId &&
          wireKey(approval.wireId) === wireKey(params.requestId)
        )
          this.#resolveApproval(connection, id, approval);
      }
    }
    if (method === "turn/started" || method === "turn/completed") {
      this.#updateTurn(connection, sessionId, record(params.turn));
      if (method === "turn/completed") {
        for (const [id, approval] of connection.approvals) {
          if (
            approval.sessionId === sessionId &&
            approval.turnId === record(params.turn).id
          )
            this.#resolveApproval(connection, id, approval);
        }
      }
    } else if (method === "item/started" || method === "item/completed") {
      const live = this.#liveTurn(
        connection,
        sessionId,
        requireText(params.turnId, "Codex turn id"),
      );
      const item = projectItem(
        params.item,
        connection.loaded.get(sessionId)?.cwd ?? "",
      );
      live.items.set(item.id, item);
    } else if (
      method.startsWith("item/") &&
      (method.endsWith("Delta") || method.endsWith("/delta"))
    ) {
      this.#delta(connection, sessionId, method, params);
    }
    if (
      method.startsWith("thread/") ||
      method.startsWith("turn/") ||
      method.startsWith("item/") ||
      method === "serverRequest/resolved" ||
      method === "error"
    ) {
      this.#emit({ type: "changed", sessionId });
    }
  }

  #liveTurn(
    connection: Connection,
    sessionId: string,
    turnId: string,
  ): LiveTurn {
    let turns = connection.live.get(sessionId);
    if (!turns) {
      turns = new Map();
      connection.live.set(sessionId, turns);
    }
    let live = turns.get(turnId);
    if (!live) {
      if (turns.size >= MAX_LIVE_TURNS)
        throw new Error(
          "Codex live display tail exceeded the safety limit; read native history before continuing",
        );
      live = {
        turn: projectTurn({ id: turnId, status: "inProgress", items: [] }, ""),
        items: new Map(),
        bytes: 0,
      };
      turns.set(turnId, live);
    }
    return live;
  }

  #updateTurn(
    connection: Connection,
    sessionId: string,
    value: JsonRecord,
  ): void {
    const turnId = requireText(value.id, "Codex turn id");
    const live = this.#liveTurn(connection, sessionId, turnId);
    live.turn = projectTurn(value, connection.loaded.get(sessionId)?.cwd ?? "");
    for (const item of live.turn.items) live.items.set(item.id, item);
  }

  #delta(
    connection: Connection,
    sessionId: string,
    method: string,
    params: JsonRecord,
  ): void {
    if (
      !text(params.turnId) ||
      !text(params.itemId) ||
      typeof params.delta !== "string"
    )
      return;
    const live = this.#liveTurn(connection, sessionId, params.turnId as string);
    live.bytes += Buffer.byteLength(params.delta);
    if (live.bytes > MAX_WIRE_BYTES)
      throw new Error("Codex live output exceeded the safety limit");
    const id = params.itemId as string;
    let item = live.items.get(id);
    if (method === "item/agentMessage/delta") {
      if (!item)
        item = {
          type: "agentMessage",
          id,
          text: "",
          phase: "final_answer",
          memoryCitation: null,
        };
      if (item.type === "agentMessage") item.text += params.delta;
    } else if (
      method === "item/reasoning/summaryTextDelta" ||
      method === "item/reasoning/textDelta"
    ) {
      if (!item)
        item = {
          type: "reasoning",
          id,
          summary: [],
          content: [],
          status: "inProgress",
        };
      if (item.type === "reasoning") {
        const summary = method.includes("summary");
        const index = summary ? params.summaryIndex : params.contentIndex;
        const target = summary ? item.summary : item.content;
        const slot =
          typeof index === "number" &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < 4096
            ? index
            : 0;
        while (target.length <= slot) target.push("");
        target[slot] = (target[slot] ?? "") + params.delta;
      }
    } else if (
      method === "item/commandExecution/outputDelta" ||
      method === "item/fileChange/outputDelta"
    ) {
      if (!item)
        item = commandItem(
          id,
          method.includes("fileChange") ? "fileChange" : "commandExecution",
          "",
          connection.loaded.get(sessionId)?.cwd ?? "",
          "inProgress",
        );
      if (item.type === "commandExecution")
        item.aggregatedOutput = (item.aggregatedOutput ?? "") + params.delta;
    }
    if (item) live.items.set(id, item);
  }

  #project(connection: Connection, value: JsonRecord): AgentNativeSession {
    const id = requireText(value.id, "Codex thread id");
    const loaded = connection.loaded.get(id);
    const cwd = text(value.cwd) ?? loaded?.cwd ?? "";
    const turns = array(value.turns).map((turn) =>
      projectTurn(record(turn), cwd),
    );
    const tail = connection.live.get(id);
    if (tail) {
      for (const [turnId, live] of tail) {
        const existing = turns.findIndex((turn) => turn.id === turnId);
        const native = turns[existing];
        // A full terminal native snapshot supersedes every retained display tail,
        // even if the final native content differs from a streamed preview.
        if (native && native.status !== "inProgress") {
          tail.delete(turnId);
          continue;
        }
        const items = new Map(
          (native?.items ?? []).map((item) => [item.id, item]),
        );
        for (const [itemId, item] of live.items)
          items.set(itemId, structuredClone(item));
        // Native terminal history wins over an older in-progress live receipt.
        const turn = {
          ...(native?.status !== "inProgress" && native ? native : live.turn),
          items: [...items.values()],
        };
        if (existing >= 0) turns[existing] = turn;
        else turns.push(turn);
      }
      if (tail.size === 0) connection.live.delete(id);
    }
    const status = record(value.status).type;
    const active = turns.some((turn) => turn.status === "inProgress");
    const model = text(value.model) ?? loaded?.model ?? "";
    if (loaded) loaded.model = model;
    return {
      nativeSessionId: id,
      model,
      thread: {
        id,
        sessionId: text(value.sessionId) ?? id,
        forkedFromId: text(value.forkedFromId) ?? null,
        parentThreadId: text(value.parentThreadId) ?? null,
        preview: text(value.preview) ?? "",
        ephemeral: false,
        isPinned: false,
        modelProvider: text(value.modelProvider) ?? "codex",
        createdAt: number(value.createdAt) ?? 0,
        updatedAt: number(value.updatedAt) ?? 0,
        recencyAt: null,
        status:
          active || status === "active"
            ? { type: "active", activeFlags: [] }
            : status === "systemError"
              ? { type: "systemError" }
              : { type: "idle" },
        path: null,
        cwd,
        cliVersion: text(value.cliVersion) ?? "codex",
        source: "appServer",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: text(value.name) ?? null,
        turns,
      },
    };
  }

  #resolveApproval(
    connection: Connection,
    requestId: string,
    approval: Approval,
  ): void {
    connection.approvals.delete(requestId);
    this.#emit({
      type: "approvalResolved",
      sessionId: approval.sessionId,
      requestId,
    });
  }

  #clearApprovals(connection: Connection): void {
    for (const [id, approval] of connection.approvals)
      this.#resolveApproval(connection, id, approval);
  }

  #fail(connection: Connection, error: Error): void {
    if (connection.failed || connection.closing) return;
    connection.failed = true;
    connection.ready = false;
    this.#rejectPending(connection, error);
    this.#clearApprovals(connection);
    this.#emit({ type: "error", message: error.message });
    for (const sessionId of connection.loaded.keys())
      this.#emit({ type: "changed", sessionId });
  }

  #rejectPending(connection: Connection, error: Error): void {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
  }

  #close(connection: Connection): Promise<void> {
    connection.closePromise ??= Promise.resolve().then(() =>
      this.#stopChild(connection),
    );
    return connection.closePromise;
  }

  async #stopChild(connection: Connection): Promise<void> {
    connection.closing = true;
    connection.ready = false;
    this.#rejectPending(
      connection,
      new Error(
        "Codex app-server stopped; native request outcome may be unknown",
      ),
    );
    for (const sessionId of connection.loaded.keys())
      this.#emit({ type: "changed", sessionId });
    this.#clearApprovals(connection);
    connection.live.clear();
    connection.loaded.clear();
    connection.child.stdin.end();
    if (
      await settledWithin(
        connection.observation,
        this.#options.shutdownGraceMs ?? 1000,
      )
    )
      return;
    connection.child.kill("SIGTERM");
    if (
      await settledWithin(
        connection.observation,
        this.#options.terminationGraceMs ?? 3000,
      )
    )
      return;
    connection.child.kill("SIGKILL");
    if (
      !(await settledWithin(
        connection.observation,
        this.#options.terminationGraceMs ?? 3000,
      ))
    ) {
      throw new Error(
        "Codex app-server did not close after termination; replacement is blocked",
      );
    }
  }

  #emit(event: AgentProviderEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* A UI observer cannot break the process transport. */
      }
    }
  }
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is missing`);
  return value;
}
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
function isWireId(value: unknown): value is WireId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
function wireKey(id: WireId): string {
  return `${typeof id}:${id}`;
}
async function settledWithin(
  observation: OwnedChildObservation,
  ms: number,
): Promise<boolean> {
  if (observation.outcome()) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observation.terminal.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function approvalDetail(method: string, params: JsonRecord): string {
  return (
    [
      text(params.reason),
      method.includes("commandExecution") ? text(params.command) : undefined,
      text(params.cwd) ? `Working directory: ${params.cwd}` : undefined,
      text(params.grantRoot)
        ? `Requested write root: ${params.grantRoot}`
        : undefined,
      params.networkApprovalContext
        ? `Network request: ${JSON.stringify(params.networkApprovalContext)}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n") || "Codex is waiting for your decision"
  );
}
function projectModel(value: unknown): ModelSummary {
  const model = record(value);
  const id = requireText(model.id, "Codex model id");
  return {
    id,
    model: text(model.model) ?? id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: text(model.displayName) ?? id,
    description: text(model.description) ?? "",
    hidden: model.hidden === true,
    supportedReasoningEfforts: array(model.supportedReasoningEfforts).map(
      (entry) => ({
        reasoningEffort: requireText(
          record(entry).reasoningEffort,
          "Reasoning effort",
        ),
        description: text(record(entry).description) ?? "",
      }),
    ),
    defaultReasoningEffort: text(model.defaultReasoningEffort) ?? null,
    inputModalities: array(model.inputModalities).filter(
      (entry): entry is "text" | "image" =>
        entry === "text" || entry === "image",
    ),
    supportsPersonality: false,
    additionalSpeedTiers: array(model.additionalSpeedTiers),
    serviceTiers: array(model.serviceTiers),
    defaultServiceTier: null,
    isDefault: model.isDefault === true,
  };
}
function projectTurn(value: JsonRecord, cwd: string): Turn {
  const error = record(value.error);
  const status = value.status;
  return {
    id: requireText(value.id, "Codex turn id"),
    items: array(value.items).map((item) => projectItem(item, cwd)),
    itemsView: "full",
    status:
      status === "completed" || status === "interrupted" || status === "failed"
        ? status
        : "inProgress",
    error: text(error.message)
      ? {
          message: error.message as string,
          codexErrorInfo: null,
          additionalDetails: null,
        }
      : null,
    startedAt: number(value.startedAt) ?? null,
    completedAt: number(value.completedAt) ?? null,
    durationMs: number(value.durationMs) ?? null,
  };
}
function commandItem(
  id: string,
  type: string,
  command: string,
  cwd: string,
  status: unknown,
): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command,
    cwd,
    processId: null,
    source: "agent",
    status:
      status === "completed" || status === "failed" || status === "declined"
        ? status
        : "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...(type !== "commandExecution" ? { toolName: type } : {}),
  };
}
function projectItem(value: unknown, cwd: string): ThreadItem {
  const item = record(value);
  const id = requireText(item.id, "Codex item id");
  if (item.type === "userMessage") {
    return {
      type: "userMessage",
      id,
      clientId: text(item.clientId) ?? null,
      content: array(item.content).map((part) => {
        const content = record(part);
        const label =
          content.type === "text"
            ? (text(content.text) ?? "")
            : `[${text(content.type) ?? "attachment"}: ${text(content.path) ?? text(content.url) ?? ""}]`;
        return { type: "text", text: label, text_elements: [] };
      }),
    };
  }
  if (item.type === "agentMessage" || item.type === "plan")
    return {
      type: "agentMessage",
      id,
      text: text(item.text) ?? "",
      phase: "final_answer",
      memoryCitation: null,
    };
  if (item.type === "reasoning")
    return {
      type: "reasoning",
      id,
      summary: array(item.summary).filter(
        (entry): entry is string => typeof entry === "string",
      ),
      content: array(item.content).filter(
        (entry): entry is string => typeof entry === "string",
      ),
    };
  const type = text(item.type) ?? "unknown";
  const tool = commandItem(
    id,
    type,
    text(item.command) ??
      (type === "mcpToolCall"
        ? `${text(item.server) ?? "mcp"}.${text(item.tool) ?? "tool"}`
        : (text(item.tool) ?? type)),
    text(item.cwd) ?? cwd,
    item.status,
  );
  tool.aggregatedOutput =
    text(item.aggregatedOutput) ??
    (item.result !== undefined ||
    item.error !== undefined ||
    item.changes !== undefined
      ? JSON.stringify(item.result ?? item.error ?? item.changes)
      : null);
  tool.exitCode = number(item.exitCode) ?? null;
  if (item.arguments && typeof item.arguments === "object")
    tool.toolArguments = record(item.arguments);
  return tool;
}
