import { createHash, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import {
  REMOTE_HOST_VERSION,
  REMOTE_METHODS,
  isConfirmedRemoteRejection,
  type RemoteEventView,
  type RemoteItemView,
  type RemoteRecoveryPage,
  type RemoteThreadSummary,
  type RemoteThreadView,
  type RemoteTurnStatus,
  type RemoteWorkspaceView,
} from "../../../../src/protocol/native/remote-wire.js";
import {
  fleetReadTools,
  fleetTools,
  normalizeFleetEndpoint,
  type FleetRequest,
  type NativeFleetDevice,
  type NativeFleetPort,
} from "./fleet.js";

export interface NativeFleetCredential {
  hostId: string;
  endpoint: string;
  deviceId: string;
  token: string;
}
/** Implemented by Host encrypted storage; secrets never enter Fleet configuration. */
export interface NativeFleetCredentialStore {
  get(deviceId: string): Promise<NativeFleetCredential | null>;
  set(deviceId: string, credential: NativeFleetCredential): Promise<void>;
  delete(deviceId: string): Promise<void>;
}
export interface NativeFleetClientOptions {
  credentials: NativeFleetCredentialStore;
  /** Explicit trust root for integration fixtures, never a skip-validation flag. */
  ca?: string | Buffer;
}
export class NativeFleetRejectedError extends Error {
  readonly confirmedRejection = true;
  constructor(readonly code: string) {
    super(`Fleet remote error: ${code}`);
  }
}
class NativeFleetCancelledError extends Error {
  constructor(
    message: string,
    readonly reason: unknown,
  ) {
    super(message);
  }
}
class NativeFleetConnectionError extends Error {
  constructor(
    message: string,
    readonly reconnectable: boolean,
  ) {
    super(message);
  }
}
function connectionError(error: unknown): NativeFleetConnectionError {
  const code = record(error) ? error.code : undefined;
  const reconnectable = [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
  ].includes(String(code));
  return new NativeFleetConnectionError(
    "Fleet TLS connection failed. Check the trusted certificate and Host address.",
    reconnectable,
  );
}
const SOURCE = "zenx.remote-host";
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BUFFER_BYTES = 512 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, name: string, maximum = 256): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    throw new Error(`Invalid Fleet ${name}`);
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768)
    throw new Error(
      "Fleet text must be non-empty and at most 32768 characters",
    );
  return value;
};
const only = (args: Record<string, unknown>, supported: readonly string[]) => {
  for (const key of Object.keys(args))
    if (!supported.includes(key))
      throw new Error(`Fleet native Host does not support option: ${key}`);
};
const integer = (
  value: unknown,
  name: string,
  fallback: number,
  max: number,
) => {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > max
  )
    throw new Error(`${name} must be between 1 and ${max}`);
  return value as number;
};
const statuses = new Set<unknown>([
  "inProgress",
  "completed",
  "failed",
  "interrupted",
]);
function item(value: unknown, threadId: string): RemoteItemView {
  if (
    !record(value) ||
    value.threadId !== threadId ||
    ![
      "user_message",
      "agent_message",
      "turn_started",
      "turn_completed",
      "turn_aborted",
    ].includes(String(value.type)) ||
    (value.text !== undefined && typeof value.text !== "string")
  )
    throw new Error("Invalid Fleet public item");
  return {
    id: string(value.id, "item ID"),
    threadId,
    createdAt: string(value.createdAt, "item date", 128),
    type: value.type as RemoteItemView["type"],
    ...(value.turnId === undefined
      ? {}
      : { turnId: string(value.turnId, "turn ID") }),
    ...(value.text === undefined ? {} : { text: value.text as string }),
  };
}
function nativeEvent(value: unknown, threadId: string): RemoteEventView {
  if (
    !record(value) ||
    value.threadId !== threadId ||
    !Number.isSafeInteger(value.watermark) ||
    (value.watermark as number) < 0 ||
    !record(value.event)
  )
    throw new Error("Invalid Fleet remote event");
  const event = value.event;
  let view: RemoteEventView["event"];
  switch (event.type) {
    case "redacted":
      view = { type: "redacted" };
      break;
    case "item_completed":
      view = { type: "item_completed", item: item(event.item, threadId) };
      break;
    case "turn_started":
      view = { type: "turn_started", turnId: string(event.turnId, "turn ID") };
      break;
    case "turn_completed":
      if (!statuses.has(event.status) || event.status === "inProgress")
        throw new Error("Invalid Fleet terminal event");
      view = {
        type: "turn_completed",
        turnId: string(event.turnId, "turn ID"),
        status: event.status as RemoteTurnStatus,
      };
      break;
    default:
      throw new Error("Invalid Fleet remote event type");
  }
  return {
    processEpoch: string(value.processEpoch, "process epoch"),
    threadId,
    watermark: value.watermark as number,
    event: view,
  };
}
interface Notification {
  method: string;
  params: unknown;
}
class NativeSession {
  readonly #pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      dispose(): void;
      mutation: boolean;
    }
  >();
  readonly #observers = new Set<(notification: Notification) => void>();
  #closed: Error | undefined;
  #nextId = 0;
  epoch = "";
  capabilities: string[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Fleet Host returned a binary frame");
        const message: unknown = JSON.parse(data.toString());
        if (!record(message)) throw new Error("Invalid Fleet native response");
        if (message.id !== undefined) {
          if (typeof message.id !== "string")
            throw new Error("Invalid Fleet response ID");
          const pending = this.#pending.get(message.id);
          if (!pending) return; // late response to an already cancelled request
          let rejection: Error | undefined;
          if (message.error !== undefined) {
            const error = message.error;
            if (
              !record(error) ||
              !record(error.data) ||
              typeof error.data.code !== "string"
            )
              throw new Error("Invalid Fleet native error");
            const code = string(error.data.code, "error code");
            // A temporary empty authorization scope is not permanent removal.
            // Only reads may reconnect; writes remain confirmed rejections and
            // never enter the subscription's retry path or replay admission.
            rejection =
              code === "scope_refreshing" && !pending.mutation
                ? new NativeFleetConnectionError(
                    "Fleet workspace scope_refreshing; read-only recovery is temporarily unavailable",
                    true,
                  )
                : isConfirmedRemoteRejection(code)
                  ? new NativeFleetRejectedError(code)
                  : new Error(
                      "Remote operation outcome unknown; inspect the target before retrying. No automatic retry.",
                    );
          } else if (!Object.hasOwn(message, "result"))
            throw new Error("Invalid Fleet native response");
          this.#pending.delete(message.id);
          pending.dispose();
          if (rejection) pending.reject(rejection);
          else pending.resolve(message.result);
        } else if (typeof message.method === "string") {
          if (
            message.method !== REMOTE_METHODS.event &&
            message.method !== REMOTE_METHODS.reset
          )
            throw new Error("Unexpected Fleet Host notification");
          for (const observer of this.#observers)
            observer({ method: message.method, params: message.params });
        } else throw new Error("Invalid Fleet native response");
      } catch {
        this.fail(
          new Error(
            "Invalid Fleet native response; remote admission may be unknown. No automatic retry.",
          ),
        );
      }
    });
    socket.on("error", (error) => this.fail(connectionError(error)));
    socket.on("close", (code) =>
      this.fail(
        code === 4003
          ? new NativeFleetRejectedError("revoked")
          : new NativeFleetConnectionError(
              "Fleet Host disconnected",
              code === 1006 ||
                code === 1001 ||
                code === 1011 ||
                code === 1012 ||
                code === 1013,
            ),
      ),
    );
  }
  static async connect(
    peer: NativeFleetDevice,
    credential: NativeFleetCredential,
    options: NativeFleetClientOptions,
    signal: AbortSignal,
  ): Promise<NativeSession> {
    signal.throwIfAborted();
    const url = new URL("/remote", peer.endpoint);
    url.protocol = "wss:";
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${credential.token}`,
        "x-zen-device-id": credential.deviceId,
        "x-zen-host-id": peer.hostId,
      },
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      handshakeTimeout: 10_000,
      maxPayload: 2 * 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
    });
    const session = new NativeSession(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const clean = () => {
          signal.removeEventListener("abort", abort);
          socket.removeListener("open", open);
          socket.removeListener("error", error);
          socket.removeListener("close", close);
          socket.removeListener("unexpected-response", rejected);
        };
        const abort = () => {
          clean();
          reject(signal.reason ?? new Error("Fleet connection cancelled"));
          socket.terminate();
        };
        const open = () => {
          clean();
          resolve();
        };
        const error = (error: Error) => {
          clean();
          reject(connectionError(error));
        };
        const close = () => {
          clean();
          reject(
            new NativeFleetConnectionError(
              "Fleet Host rejected or closed the connection",
              true,
            ),
          );
        };
        const rejected = (
          _request: unknown,
          response: import("node:http").IncomingMessage,
        ) => {
          const status = response.statusCode;
          clean();
          response.resume();
          const error =
            status === 401 || status === 403
              ? new NativeFleetRejectedError(
                  status === 401 ? "unauthorized" : "operation_forbidden",
                )
              : new NativeFleetConnectionError(
                  `Fleet Host connection rejected (${status})`,
                  status === 503,
                );
          reject(error);
          session.fail(error);
        };
        signal.addEventListener("abort", abort, { once: true });
        socket.once("open", open);
        socket.once("error", error);
        socket.once("close", close);
        socket.once("unexpected-response", rejected);
        if (signal.aborted) abort();
      });
      const hello = await session.request(
        REMOTE_METHODS.hello,
        { version: REMOTE_HOST_VERSION, hostId: peer.hostId },
        signal,
      );
      if (
        !record(hello) ||
        hello.version !== REMOTE_HOST_VERSION ||
        hello.hostId !== peer.hostId ||
        !Array.isArray(hello.capabilities) ||
        hello.capabilities.some((v) => typeof v !== "string")
      )
        throw new Error(
          "Fleet Host identity or protocol mismatch; re-pair required",
        );
      session.epoch = string(hello.processEpoch, "process epoch");
      session.capabilities = hello.capabilities as string[];
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }
  observe(observer: (notification: Notification) => void): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }
  fail(error: Error) {
    if (this.#closed) return;
    this.#closed = error;
    for (const pending of this.#pending.values()) {
      pending.dispose();
      pending.reject(
        pending.mutation
          ? new Error(
              `${error.message}; remote admission may be unknown. Inspect the target before retrying. No automatic retry.`,
            )
          : error,
      );
    }
    this.#pending.clear();
    for (const observer of this.#observers)
      observer({ method: "offline", params: error });
    this.socket.terminate();
  }
  close() {
    this.fail(new Error("Fleet connection closed"));
  }
  request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    mutation = false,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (this.#closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        this.#closed ?? new Error("Fleet Host disconnected"),
      );
    const id = String(++this.#nextId);
    const payload = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(payload) > 64 * 1024)
      throw new Error("Fleet native request exceeds limit");
    return new Promise((resolve, reject) => {
      const finish = (error: Error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.dispose();
        reject(error);
      };
      const uncertain = mutation
        ? "; remote admission may be unknown. Inspect the target before retrying. No automatic retry."
        : "";
      const abort = () =>
        finish(
          new NativeFleetCancelledError(
            `Fleet request cancelled${uncertain}`,
            signal.reason,
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            mutation
              ? new Error(`Fleet request timed out${uncertain}`)
              : new NativeFleetConnectionError("Fleet request timed out", true),
          ),
        10_000,
      );
      const dispose = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      this.#pending.set(id, { resolve, reject, dispose, mutation });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      this.socket.send(payload, (error) => {
        if (error)
          this.fail(new Error("Fleet Host connection closed while sending"));
      });
    });
  }
}
interface Recovery {
  thread: RemoteThreadView;
  epoch: string;
  watermark: number;
}
/** Reassembles only public wire values. Fragment metadata/offsets and the page boundary are validated before publishing. */
async function recover(
  session: NativeSession,
  workspaceId: string,
  threadId: string,
  signal: AbortSignal,
): Promise<Recovery> {
  let raw = await session.request(
    REMOTE_METHODS.resume,
    { workspaceId, threadId },
    signal,
  );
  const items: RemoteItemView[] = [];
  const turns = new Map<string, RemoteTurnStatus>();
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let boundary:
    | { epoch: string; watermark: number; name?: string; archived: boolean }
    | undefined;
  let fragment:
    { item: Omit<RemoteItemView, "text">; text: string } | undefined;
  let bytes = 0;
  for (let pages = 0; ; pages++) {
    if (
      pages > 4096 ||
      !record(raw) ||
      raw.threadId !== threadId ||
      raw.processEpoch !== session.epoch ||
      !Number.isSafeInteger(raw.watermark) ||
      (raw.watermark as number) < 0 ||
      !record(raw.thread) ||
      raw.thread.id !== threadId ||
      typeof raw.thread.archived !== "boolean" ||
      !Array.isArray(raw.entries) ||
      (raw.nextCursor !== null && typeof raw.nextCursor !== "string")
    )
      throw new Error("Invalid Fleet recovery page");
    const page = raw as unknown as RemoteRecoveryPage;
    const name =
      page.thread.name === undefined
        ? undefined
        : string(page.thread.name, "Thread name", 32768);
    if (!boundary)
      boundary = {
        epoch: page.processEpoch,
        watermark: page.watermark,
        archived: page.thread.archived,
        ...(name === undefined ? {} : { name }),
      };
    else if (
      page.processEpoch !== boundary.epoch ||
      page.watermark !== boundary.watermark ||
      page.thread.archived !== boundary.archived ||
      name !== boundary.name
    )
      throw new Error("Fleet recovery boundary changed; resync required");
    bytes += Buffer.byteLength(JSON.stringify(raw));
    if (bytes > MAX_SNAPSHOT_BYTES)
      throw new Error("Fleet public history exceeds recovery limit");
    for (const entry of page.entries) {
      if (!record(entry)) throw new Error("Invalid Fleet recovery entry");
      const view = item(entry.item, threadId);
      if (entry.kind === "item") {
        if (fragment || ids.has(view.id))
          throw new Error("Invalid Fleet recovery item sequence");
        ids.add(view.id);
        items.push(view);
        if (entry.turn !== undefined) {
          if (
            !record(entry.turn) ||
            view.type !== "turn_started" ||
            entry.turn.id !== view.turnId ||
            !statuses.has(entry.turn.status) ||
            turns.has(entry.turn.id)
          )
            throw new Error("Invalid Fleet recovery turn");
          turns.set(entry.turn.id, entry.turn.status as RemoteTurnStatus);
        }
      } else if (entry.kind === "text_fragment") {
        if (
          view.text !== undefined ||
          typeof entry.text !== "string" ||
          !entry.text.length ||
          !Number.isSafeInteger(entry.offset) ||
          typeof entry.complete !== "boolean"
        )
          throw new Error("Invalid Fleet text fragment");
        if (!fragment) {
          if (entry.offset !== 0 || ids.has(view.id))
            throw new Error("Invalid Fleet fragment offset");
          fragment = { item: view, text: "" };
        }
        if (
          JSON.stringify(fragment.item) !== JSON.stringify(view) ||
          entry.offset !== fragment.text.length
        )
          throw new Error("Invalid Fleet fragment sequence");
        fragment.text += entry.text;
        if (entry.complete) {
          ids.add(view.id);
          items.push({ ...fragment.item, text: fragment.text });
          fragment = undefined;
        }
      } else throw new Error("Invalid Fleet recovery entry kind");
    }
    if (page.nextCursor === null) {
      if (fragment) throw new Error("Incomplete Fleet public item");
      return {
        thread: {
          id: threadId,
          ...(boundary.name === undefined ? {} : { name: boundary.name }),
          archived: boundary.archived,
          items,
          turns: [...turns].map(([id, status]) => ({ id, status })),
        },
        epoch: boundary.epoch,
        watermark: boundary.watermark,
      };
    }
    const cursor = string(page.nextCursor, "recovery cursor", 32768);
    if (cursors.has(cursor))
      throw new Error("Fleet Host repeated a recovery cursor");
    cursors.add(cursor);
    raw = await session.request(REMOTE_METHODS.resumePage, { cursor }, signal);
  }
}

export interface NativeFleetTurnResult {
  source: string;
  threadId: string;
  turnId: string;
  status: RemoteTurnStatus;
  timedOut: boolean;
  error: null;
}
export interface NativeFleetSubscriptionOptions {
  onTurn(value: {
    threadId: string;
    turnId: string;
    status: RemoteTurnStatus;
  }): void;
  onError(error: Error): void;
  onReady?(): void;
  includeCurrentTerminal?: boolean;
}
/** Desktop controller only: the remote Host remains the sole Thread/Turn authority. */
export class NativeFleetClient implements NativeFleetPort {
  constructor(readonly options: NativeFleetClientOptions) {}
  #peer(peer: NativeFleetDevice): NativeFleetDevice {
    if (peer.transport !== "https")
      throw new Error("Native Fleet requires an HTTPS device");
    string(peer.id, "device ID", 64);
    string(peer.hostId, "Host ID", 128);
    if (peer.workspace !== undefined)
      string(peer.workspace, "workspace ID", 128);
    if (peer.access !== "read" && peer.access !== "control")
      throw new Error("Invalid Fleet access mode");
    return { ...peer, endpoint: normalizeFleetEndpoint(peer.endpoint) };
  }
  async #credential(peer: NativeFleetDevice): Promise<NativeFleetCredential> {
    let saved: NativeFleetCredential | null;
    try {
      saved = await this.options.credentials.get(peer.id);
    } catch {
      throw new Error("Fleet credential vault is unavailable or unreadable");
    }
    if (!saved)
      throw new Error("Fleet Host is unpaired; pair with a fresh Host code");
    if (saved.hostId !== peer.hostId || saved.endpoint !== peer.endpoint)
      throw new Error(
        "Fleet Host address or identity changed; re-pair required",
      );
    const deviceId = string(saved.deviceId, "paired device ID");
    // Token is an opaque header value, never echoed in errors or responses.
    if (
      typeof saved.token !== "string" ||
      !saved.token ||
      saved.token.length >= 512 ||
      /[^\x21-\x7e]/u.test(saved.token)
    )
      throw new Error("Invalid stored Fleet credential; re-pair required");
    return {
      hostId: peer.hostId,
      endpoint: peer.endpoint,
      deviceId,
      token: saved.token,
    };
  }
  async #connect(
    peer: NativeFleetDevice,
    signal: AbortSignal,
  ): Promise<NativeSession> {
    const credential = await this.#credential(peer);
    signal.throwIfAborted();
    return await NativeSession.connect(peer, credential, this.options, signal);
  }
  async pair(
    input: NativeFleetDevice,
    code: string,
    signal: AbortSignal = AbortSignal.timeout(10_000),
  ) {
    const peer = this.#peer(input);
    const deviceId = randomUUID();
    const payload = JSON.stringify({
      hostId: peer.hostId,
      deviceId,
      code: string(code, "pair code", 256).trim(),
      access: peer.access,
    });
    const raw: unknown = await new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const req = httpsRequest(
        new URL("/pair", peer.endpoint),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            "x-zen-host-id": peer.hostId,
          },
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
            if (Buffer.byteLength(body) > 32 * 1024)
              req.destroy(new Error("Fleet pairing response exceeds limit"));
          });
          res.on("error", () =>
            req.destroy(
              new Error("Fleet pairing response closed; code may be consumed"),
            ),
          );
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(
                new Error(
                  `Fleet pairing rejected (${res.statusCode}); verify the Host identity and fresh code`,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(
                new Error(
                  "Invalid Fleet pairing response; code may be consumed",
                ),
              );
            }
          });
        },
      );
      const abort = () =>
        req.destroy(
          new Error(
            "Fleet pairing cancelled; code may be consumed. No automatic retry.",
          ),
        );
      const timer = setTimeout(
        () =>
          req.destroy(
            new Error(
              "Fleet pairing timed out; code may be consumed. No automatic retry.",
            ),
          ),
        10_000,
      );
      req.on("close", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      });
      req.on("error", () =>
        reject(
          new Error(
            "Fleet TLS pairing failed or cancelled; verify the trusted certificate and Host address. Code consumption may be unknown; no automatic retry.",
          ),
        ),
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else req.end(payload);
    });
    if (
      !record(raw) ||
      raw.hostId !== peer.hostId ||
      raw.deviceId !== deviceId ||
      typeof raw.token !== "string" ||
      !raw.token ||
      raw.token.length >= 512 ||
      /[^\x21-\x7e]/u.test(raw.token)
    )
      throw new Error("Fleet pairing identity mismatch; code may be consumed");
    signal.throwIfAborted();
    await this.options.credentials.set(peer.id, {
      hostId: peer.hostId,
      endpoint: peer.endpoint,
      deviceId,
      token: raw.token,
    });
    return { hostId: peer.hostId, deviceId, paired: true };
  }
  async forget(peer: NativeFleetDevice) {
    await this.options.credentials.delete(this.#peer(peer).id);
  }
  async test(
    input: NativeFleetDevice,
    signal: AbortSignal = AbortSignal.timeout(10_000),
  ) {
    const peer = this.#peer(input);
    const session = await this.#connect(peer, signal);
    try {
      return {
        hostId: peer.hostId,
        endpoint: peer.endpoint,
        processEpoch: session.epoch,
        capabilities: session.capabilities,
        workspaces: await this.#workspaces(session, signal),
        status: "connected",
      };
    } finally {
      session.close();
    }
  }
  async #workspaces(
    session: NativeSession,
    signal: AbortSignal,
  ): Promise<RemoteWorkspaceView[]> {
    const result = await session.request(REMOTE_METHODS.workspaces, {}, signal);
    if (
      !record(result) ||
      !Array.isArray(result.workspaces) ||
      result.workspaces.length > 1024
    )
      throw new Error("Invalid Fleet workspace list");
    const ids = new Set<string>();
    return result.workspaces.map((value) => {
      if (!record(value)) throw new Error("Invalid Fleet workspace");
      const id = string(value.id, "workspace ID", 128);
      if (ids.has(id)) throw new Error("Duplicate Fleet workspace ID");
      ids.add(id);
      return { id, label: string(value.label, "workspace label", 32768) };
    });
  }
  async #workspace(
    session: NativeSession,
    peer: NativeFleetDevice,
    requested: unknown,
    signal: AbortSignal,
  ) {
    const workspaces = await this.#workspaces(session, signal);
    const target =
      requested === undefined
        ? peer.workspace
        : string(requested, "workspace", 128);
    const exact =
      target === undefined
        ? undefined
        : workspaces.find((view) => view.id === target);
    const matches = exact
      ? [exact]
      : target === undefined
        ? workspaces
        : workspaces.filter((view) => view.label === target);
    if (matches.length !== 1)
      throw new Error(
        target === undefined
          ? "Choose a remote workspace using projects_list"
          : "Remote workspace is unknown or ambiguous",
      );
    return matches[0]!.id;
  }
  async #threads(
    session: NativeSession,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<RemoteThreadSummary[]> {
    const result = await session.request(
      REMOTE_METHODS.threads,
      { workspaceId },
      signal,
    );
    if (
      !record(result) ||
      !Array.isArray(result.threads) ||
      result.threads.length > 100_000
    )
      throw new Error("Invalid Fleet Thread list");
    const ids = new Set<string>();
    return result.threads.map((value) => {
      if (
        !record(value) ||
        (value.status !== "idle" && value.status !== "active")
      )
        throw new Error("Invalid Fleet Thread summary");
      const threadId = string(value.threadId, "Thread ID");
      if (ids.has(threadId)) throw new Error("Duplicate Fleet Thread ID");
      ids.add(threadId);
      return {
        threadId,
        status: value.status,
        ...(value.name === undefined
          ? {}
          : { name: string(value.name, "Thread name", 32768) }),
      };
    });
  }
  async invoke(
    input: NativeFleetDevice,
    request: FleetRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const peer = this.#peer(input);
    if (
      request.version !== 1 ||
      !fleetTools.has(request.name) ||
      !record(request.arguments)
    )
      throw new Error("Unsupported Fleet request");
    if (peer.access !== "control" && !fleetReadTools.has(request.name))
      throw new Error(`Fleet device ${peer.id} is read-only`);
    string(request.callId, "call ID", 512);
    const args = request.arguments;
    // Validate before connecting or admitting any mutation.
    const supported: Record<string, string[]> = {
      zenx_projects_list: ["limit"],
      zenx_models_list: [],
      zenx_threads_list: [
        "workspace",
        "cwd",
        "query",
        "archived",
        "limit",
        "cursor",
      ],
      zenx_threads_create: ["workspace", "cwd", "project", "model", "effort"],
      zenx_threads_read: [
        "target",
        "threadId",
        "workspace",
        "granularity",
        "turnId",
        "itemId",
        "cursor",
        "maxTurns",
        "maxItemsPerTurn",
      ],
      zenx_threads_status: ["target", "threadId", "workspace"],
      zenx_threads_send: [
        "target",
        "threadId",
        "workspace",
        "text",
        "messageType",
      ],
      zenx_self_control_threads_wait: [
        "target",
        "threadId",
        "workspace",
        "turnId",
        "timeoutSeconds",
      ],
    };
    only(args, supported[request.name] ?? []);
    const waitDeadline =
      request.name === "zenx_self_control_threads_wait"
        ? AbortSignal.timeout(
            integer(args.timeoutSeconds, "timeoutSeconds", 30, 30) * 1000,
          )
        : undefined;
    const requestSignal = waitDeadline
      ? AbortSignal.any([signal, waitDeadline])
      : signal;
    requestSignal.throwIfAborted();
    const session = await this.#connect(peer, requestSignal);
    try {
      if (request.name === "zenx_projects_list") {
        const limit = integer(args.limit, "limit", 50, 100);
        const workspaces = await this.#workspaces(session, requestSignal);
        return {
          source: SOURCE,
          projects: workspaces.slice(0, limit).map(({ id, label }) => ({
            id,
            project: id,
            name: label,
            workspace: id,
            cwd: id,
            configured: true,
            isDefault: id === peer.workspace,
          })),
          truncated: workspaces.length > limit,
        };
      }
      if (request.name === "zenx_models_list") {
        if (!session.capabilities.includes("models"))
          throw new Error("Remote Host does not support model discovery");
        const result = await session.request(
          REMOTE_METHODS.models,
          {},
          requestSignal,
        );
        if (!record(result) || !Array.isArray(result.models))
          throw new Error("Invalid Fleet model catalog");
        return { source: SOURCE, models: result.models };
      }
      const selectors = [args.workspace, args.cwd, args.project].filter(
        (v) => v !== undefined,
      );
      if (selectors.length > 1 && selectors.some((v) => v !== selectors[0]))
        throw new Error(
          "Fleet workspace selectors must identify the same workspace",
        );
      const workspaceId = await this.#workspace(
        session,
        peer,
        selectors[0],
        requestSignal,
      );
      const binding = createHash("sha256")
        .update(JSON.stringify([peer.hostId, peer.endpoint, workspaceId]))
        .digest("hex");
      if (request.name === "zenx_threads_create") {
        const params = {
          workspaceId,
          ...(args.model === undefined
            ? {}
            : { model: string(args.model, "model", 256) }),
          ...(args.effort === undefined
            ? {}
            : { effort: string(args.effort, "effort", 64) }),
        };
        const result = await session.request(
          REMOTE_METHODS.create,
          params,
          requestSignal,
          true,
        );
        if (!record(result))
          throw new Error(
            "Invalid Fleet create receipt; remote admission may be unknown",
          );
        let threadId: string;
        try {
          threadId = string(result.id, "created Thread ID");
        } catch {
          throw new Error(
            "Invalid Fleet create receipt; remote admission may be unknown. No automatic retry.",
          );
        }
        return {
          source: SOURCE,
          threadId,
          cwd: workspaceId,
          workspace: workspaceId,
          status: "idle",
        };
      }
      const threads = await this.#threads(session, workspaceId, requestSignal);
      if (request.name === "zenx_threads_list") {
        if (args.archived !== undefined && args.archived !== false)
          throw new Error(
            "Remote Host does not support archived Thread filtering",
          );
        const query =
          args.query === undefined
            ? undefined
            : string(args.query, "query", 32768).toLocaleLowerCase();
        const limit = integer(args.limit, "limit", 50, 100);
        const listed = threads.filter(
          (view) =>
            query === undefined ||
            [view.threadId, view.name ?? ""].some((value) =>
              value.toLocaleLowerCase().includes(query),
            ),
        );
        const listBinding = createHash("sha256")
          .update(JSON.stringify([binding, query, listed]))
          .digest("hex");
        const offset = decodeOffset(args.cursor, listBinding, listed.length);
        const end = Math.min(listed.length, offset + limit);
        return {
          source: SOURCE,
          threads: listed.slice(offset, end).map((view) => ({
            ...view,
            id: view.threadId,
            shortId: shortId(view.threadId, threads),
            cwd: workspaceId,
            workspace: workspaceId,
          })),
          truncated: end < listed.length,
          nextCursor:
            end < listed.length ? encodeOffset(listBinding, end) : null,
        };
      }
      if (args.target !== undefined && args.threadId !== undefined)
        throw new Error("Specify only target");
      const target = string(args.target ?? args.threadId, "Thread target");
      const exact = threads.find((view) => view.threadId === target);
      const candidates = exact
        ? [exact]
        : threads.filter(
            (view) => view.threadId.startsWith(target) || view.name === target,
          );
      if (candidates.length !== 1)
        return {
          source: SOURCE,
          status: candidates.length ? "ambiguous" : "not_found",
          candidates: candidates.map((view) => ({
            ...view,
            shortId: shortId(view.threadId, threads),
            cwd: workspaceId,
          })),
        };
      const threadId = candidates[0]!.threadId;
      if (request.name === "zenx_threads_send") {
        const messageType = args.messageType ?? "guidance";
        if (
          !["guidance", "follow_up", "replacement"].includes(
            String(messageType),
          )
        )
          throw new Error("Unsupported Fleet messageType");
        const clientUserMessageId = `fleet:${createHash("sha256")
          .update(
            JSON.stringify([
              peer.hostId,
              request.threadId ?? null,
              request.canonicalToolCallId ?? request.callId,
            ]),
          )
          .digest("hex")}`;
        const result = await session.request(
          REMOTE_METHODS.send,
          {
            workspaceId,
            threadId,
            clientId: clientUserMessageId,
            text: text(args.text),
            messageType,
          },
          requestSignal,
          true,
        );
        if (
          !record(result) ||
          (result.turnId === undefined && result.queued !== true) ||
          (result.turnId !== undefined &&
            (typeof result.turnId !== "string" || !result.turnId)) ||
          (result.queued !== undefined && typeof result.queued !== "boolean")
        )
          throw new Error(
            "Invalid Fleet send receipt; remote admission may be unknown. No automatic retry.",
          );
        return {
          source: SOURCE,
          threadId,
          clientUserMessageId,
          turnId: result.turnId ?? null,
          queued: result.queued === true,
        };
      }
      if (request.name === "zenx_self_control_threads_wait")
        return await this.#watch(
          session,
          workspaceId,
          threadId,
          string(args.turnId, "turn ID"),
          signal,
          integer(args.timeoutSeconds, "timeoutSeconds", 30, 30),
          undefined,
          waitDeadline,
        );
      const recovered = await recover(
        session,
        workspaceId,
        threadId,
        requestSignal,
      );
      if (request.name === "zenx_threads_status") {
        const active = recovered.thread.turns.findLast(
          (turn) => turn.status === "inProgress",
        );
        const last = recovered.thread.turns.at(-1);
        return {
          source: SOURCE,
          threadId,
          cwd: workspaceId,
          status: active ? "active" : "idle",
          activeTurnId: active?.id ?? null,
          lastTurn: last
            ? { turnId: last.id, status: last.status, error: null }
            : null,
        };
      }
      return readHistory(recovered.thread, workspaceId, binding, args);
    } finally {
      session.close();
    }
  }
  /** Ephemeral observation of future canonical completions for the existing Trigger registry. */
  async subscribeThread(
    input: NativeFleetDevice,
    requestedWorkspace: string | undefined,
    target: string,
    options: NativeFleetSubscriptionOptions,
    signal: AbortSignal,
  ): Promise<() => void> {
    const peer = this.#peer(input);
    string(target, "Thread target");
    if (requestedWorkspace !== undefined)
      string(requestedWorkspace, "workspace", 128);
    const controller = new AbortController();
    const bounded = AbortSignal.any([signal, controller.signal]);
    let liveStop: (() => void) | undefined;
    const stop = () => {
      controller.abort();
      liveStop?.();
    };
    const establish = async () => {
      const session = await this.#connect(peer, bounded);
      liveStop = await this.#subscribeConnected(
        peer,
        requestedWorkspace,
        target,
        options,
        bounded,
        session,
      );
      if (bounded.aborted) liveStop();
    };
    try {
      await establish();
      return stop;
    } catch (error) {
      if (bounded.aborted) {
        stop();
        throw error;
      }
      if (
        !(error instanceof NativeFleetConnectionError) ||
        !error.reconnectable
      ) {
        stop();
        throw error;
      }
      options.onError(error);
    }
    // A stored Trigger can start while its selected Host is offline. Only reads
    // reconnect; no local fallback, input resend or historical completion replay.
    void (async () => {
      let retryDelay = 1000;
      try {
        while (!bounded.aborted) {
          await delay(retryDelay, undefined, { signal: bounded });
          try {
            await establish();
            return;
          } catch (error) {
            if (bounded.aborted) return;
            if (
              !(error instanceof NativeFleetConnectionError) ||
              !error.reconnectable
            ) {
              options.onError(
                error instanceof Error
                  ? error
                  : new Error("Fleet subscription failed"),
              );
              stop();
              return;
            }
            retryDelay = Math.min(30_000, retryDelay * 2);
          }
        }
      } catch (error) {
        if (!bounded.aborted)
          options.onError(
            error instanceof Error
              ? error
              : new Error("Fleet subscription failed"),
          );
      }
    })();
    return stop;
  }
  async #subscribeConnected(
    peer: NativeFleetDevice,
    requestedWorkspace: string | undefined,
    target: string,
    options: NativeFleetSubscriptionOptions,
    signal: AbortSignal,
    initialSession: NativeSession,
  ): Promise<() => void> {
    const controller = new AbortController();
    const bounded = AbortSignal.any([signal, controller.signal]);
    let session = initialSession;
    let workspaceId: string;
    let threadId: string;
    try {
      workspaceId = await this.#workspace(
        session,
        peer,
        requestedWorkspace,
        bounded,
      );
      const threads = await this.#threads(session, workspaceId, bounded);
      const exact = threads.find((view) => view.threadId === target);
      const matches = exact
        ? [exact]
        : threads.filter(
            (view) => view.threadId.startsWith(target) || view.name === target,
          );
      if (matches.length !== 1)
        throw new Error(
          matches.length
            ? "Remote Trigger target is ambiguous"
            : "Remote Trigger target not found",
        );
      threadId = matches[0]!.threadId;
    } catch (error) {
      session.close();
      throw error;
    }
    // These identities are observation fences, never a transcript or command ledger.
    const active = new Set<string>();
    const hinted = new Set<string>();
    let notifications: Notification[] = [];
    let bytes = 0;
    let overflow = false;
    let wake: (() => void) | undefined;
    let unsubscribe = () => {};
    let current: Recovery;
    const attach = () =>
      session.observe((notification) => {
        if (overflow) {
          wake?.();
          return;
        }
        bytes += Buffer.byteLength(JSON.stringify(notification));
        if (bytes > MAX_EVENT_BUFFER_BYTES) {
          notifications = [];
          overflow = true;
        } else notifications.push(notification);
        wake?.();
      });
    const emit = (turn: RemoteThreadView["turns"][number]) => {
      active.delete(turn.id);
      hinted.delete(turn.id);
      options.onTurn({ threadId, turnId: turn.id, status: turn.status });
    };
    const reconcile = (snapshot: Recovery) => {
      for (const turn of snapshot.thread.turns) {
        if (turn.status === "inProgress") active.add(turn.id);
        else if (active.has(turn.id) || hinted.has(turn.id)) emit(turn);
      }
      // A finite Host history can only have one active turn, but bound malicious views too.
      if (active.size + hinted.size > 1024)
        throw new Error("Fleet active Turn observation exceeds limit");
    };
    unsubscribe = attach();
    try {
      current = await recover(session, workspaceId, threadId, bounded);
      reconcile(current);
      if (options.includeCurrentTerminal) {
        const last = current.thread.turns.at(-1);
        if (last && last.status !== "inProgress") emit(last);
      }
      options.onReady?.();
    } catch (error) {
      unsubscribe();
      session.close();
      controller.abort();
      throw error;
    }
    const stop = () => {
      controller.abort();
      unsubscribe();
      session.close();
      wake?.();
      notifications = [];
      active.clear();
      hinted.clear();
    };
    // The owner receives immediate offline/error information. Read-only reconnect
    // does not resend any command or replay completions from unrelated history.
    void (async () => {
      let retryDelay = 1000;
      try {
        for (;;) {
          bounded.throwIfAborted();
          try {
            let resync = overflow;
            overflow = false;
            for (const notification of notifications.splice(0)) {
              if (notification.method === "offline") throw notification.params;
              if (notification.method === REMOTE_METHODS.reset) {
                if (
                  !record(notification.params) ||
                  notification.params.threadId !== threadId ||
                  notification.params.reason !== "resync_required"
                )
                  throw new Error("Invalid Fleet reset notification");
                resync = true;
                continue;
              }
              const event = nativeEvent(notification.params, threadId);
              if (event.processEpoch !== current.epoch) {
                resync = true;
                continue;
              }
              if (event.watermark <= current.watermark) continue;
              if (event.event.type === "turn_started")
                active.add(event.event.turnId);
              if (event.event.type === "turn_completed")
                hinted.add(event.event.turnId);
              if (active.size + hinted.size > 1024)
                throw new Error("Fleet active Turn observation exceeds limit");
              // Any gap or accepted event leads to canonical recovery, rather than
              // admitting a completion from a speculative event-only view.
              if (event.watermark === current.watermark + 1)
                current.watermark = event.watermark;
              resync = true;
            }
            bytes = 0;
            if (resync) {
              current = await recover(session, workspaceId, threadId, bounded);
              reconcile(current);
              continue;
            }
            await new Promise<void>((resolve, reject) => {
              const clean = () => {
                bounded.removeEventListener("abort", abort);
                wake = undefined;
              };
              const abort = () => {
                clean();
                reject(new Error("Fleet subscription cancelled"));
              };
              wake = () => {
                clean();
                resolve();
              };
              bounded.addEventListener("abort", abort, { once: true });
              if (bounded.aborted) abort();
              else if (notifications.length || overflow) wake();
            });
          } catch (error) {
            if (bounded.aborted) return;
            const failure =
              error instanceof Error
                ? error
                : new Error("Fleet observation failed");
            options.onError(failure);
            if (
              !(failure instanceof NativeFleetConnectionError) ||
              !failure.reconnectable
            )
              return;
            unsubscribe();
            session.close();
            notifications = [];
            bytes = 0;
            overflow = false;
            for (;;) {
              await delay(retryDelay, undefined, { signal: bounded });
              try {
                session = await this.#connect(peer, bounded);
                unsubscribe = attach();
                current = await recover(
                  session,
                  workspaceId,
                  threadId,
                  bounded,
                );
                reconcile(current);
                options.onReady?.();
                retryDelay = 1000;
                break;
              } catch (error) {
                unsubscribe();
                session.close();
                notifications = [];
                bytes = 0;
                overflow = false;
                if (bounded.aborted) return;
                const failure =
                  error instanceof Error
                    ? error
                    : new Error("Fleet reconnect failed");
                if (
                  !(failure instanceof NativeFleetConnectionError) ||
                  !failure.reconnectable
                ) {
                  options.onError(failure);
                  return;
                }
                retryDelay = Math.min(30_000, retryDelay * 2);
              }
            }
          }
        }
      } catch (error) {
        if (!bounded.aborted)
          options.onError(
            error instanceof Error
              ? error
              : new Error("Fleet observation failed"),
          );
      } finally {
        stop();
      }
    })();
    return stop;
  }
  async watchTurn(
    input: NativeFleetDevice,
    workspaceId: string,
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    onEvent?: (event: RemoteEventView) => void,
    timeoutSeconds = 30,
  ): Promise<NativeFleetTurnResult> {
    const peer = this.#peer(input);
    string(workspaceId, "workspace ID", 128);
    string(threadId, "Thread ID");
    string(turnId, "turn ID");
    integer(timeoutSeconds, "timeoutSeconds", 30, 30);
    const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
    const session = await this.#connect(
      peer,
      AbortSignal.any([signal, deadline]),
    );
    try {
      return await this.#watch(
        session,
        workspaceId,
        threadId,
        turnId,
        signal,
        timeoutSeconds,
        onEvent,
        deadline,
      );
    } finally {
      session.close();
    }
  }
  async #watch(
    session: NativeSession,
    workspaceId: string,
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    seconds: number,
    onEvent?: (event: RemoteEventView) => void,
    providedDeadline?: AbortSignal,
  ): Promise<NativeFleetTurnResult> {
    const deadline = providedDeadline ?? AbortSignal.timeout(seconds * 1000);
    const bounded = AbortSignal.any([signal, deadline]);
    let current: Recovery | undefined;
    let notifications: Notification[] = [];
    let pendingBytes = 0;
    let overflow = false;
    let wake: (() => void) | undefined;
    const unsubscribe = session.observe((notification) => {
      pendingBytes += Buffer.byteLength(JSON.stringify(notification));
      if (pendingBytes > MAX_EVENT_BUFFER_BYTES) {
        notifications = [];
        overflow = true;
      } else if (!overflow) notifications.push(notification);
      wake?.();
    });
    const result = (
      status: RemoteTurnStatus,
      timedOut: boolean,
    ): NativeFleetTurnResult => ({
      source: SOURCE,
      threadId,
      turnId,
      status,
      timedOut,
      error: null,
    });
    try {
      current = await recover(session, workspaceId, threadId, bounded);
      for (;;) {
        bounded.throwIfAborted();
        const turn = current.thread.turns.find((view) => view.id === turnId);
        if (!turn) throw new Error("Turn not found on target remote Thread");
        if (turn.status !== "inProgress") return result(turn.status, false);
        let resync = overflow;
        overflow = false;
        for (const notification of notifications.splice(0)) {
          if (notification.method === "offline") throw notification.params;
          if (notification.method === REMOTE_METHODS.reset) {
            if (
              !record(notification.params) ||
              notification.params.threadId !== threadId ||
              notification.params.reason !== "resync_required"
            )
              throw new Error("Invalid Fleet reset notification");
            resync = true;
            continue;
          }
          const event = nativeEvent(notification.params, threadId);
          if (event.processEpoch !== current.epoch) {
            resync = true;
            continue;
          }
          if (event.watermark <= current.watermark) continue;
          if (event.watermark !== current.watermark + 1) {
            resync = true;
            continue;
          }
          current.watermark = event.watermark;
          if (
            ((event.event.type === "turn_started" ||
              event.event.type === "turn_completed") &&
              event.event.turnId === turnId) ||
            (event.event.type === "item_completed" &&
              event.event.item.turnId === turnId)
          )
            onEvent?.(event);
          // Contiguous nonterminal events advance the observation fence without polling.
          // A terminal hint is always confirmed by canonical recovery.
          if (
            event.event.type === "turn_completed" &&
            event.event.turnId === turnId
          )
            resync = true;
        }
        pendingBytes = 0;
        if (resync) {
          current = await recover(session, workspaceId, threadId, bounded);
          continue;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clean();
            reject(
              new NativeFleetCancelledError(
                "Fleet wait cancelled or expired",
                bounded.reason,
              ),
            );
          };
          const clean = () => {
            bounded.removeEventListener("abort", abort);
            wake = undefined;
          };
          wake = () => {
            clean();
            resolve();
          };
          bounded.addEventListener("abort", abort, { once: true });
          if (bounded.aborted) abort();
          else if (notifications.length || overflow) wake();
        });
      }
    } catch (error) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (
        deadline.aborted &&
        current &&
        (error === deadline.reason ||
          (error instanceof NativeFleetCancelledError &&
            error.reason === deadline.reason))
      ) {
        const turn = current.thread.turns.find((view) => view.id === turnId);
        if (turn) return result(turn.status, turn.status === "inProgress");
      }
      throw error;
    } finally {
      unsubscribe();
    }
  }
}
function shortId(id: string, threads: RemoteThreadSummary[]) {
  let length = Math.min(8, id.length);
  while (
    length < id.length &&
    threads.some(
      (other) =>
        other.threadId !== id &&
        (other.threadId.startsWith(id.slice(0, length)) ||
          other.name === id.slice(0, length)),
    )
  )
    length++;
  return id.slice(0, length);
}
const encodeOffset = (
  binding: string,
  offset: number,
  boundary?: string | null,
) =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      binding,
      offset,
      ...(boundary === undefined ? {} : { boundary }),
    }),
  ).toString("base64url");
function decodeOffset(
  value: unknown,
  binding: string,
  maximum: number,
): number {
  if (value === undefined) return 0;
  const cursor = decodeCursor(value, binding);
  if (
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    cursor.offset > maximum
  )
    throw new Error("Invalid Fleet cursor offset");
  return cursor.offset;
}
function decodeCursor(
  value: unknown,
  binding: string,
): { offset: number; boundary?: string | null } {
  try {
    const cursor: unknown = JSON.parse(
      Buffer.from(string(value, "cursor", 16384), "base64url").toString("utf8"),
    );
    if (
      !record(cursor) ||
      cursor.version !== 1 ||
      cursor.binding !== binding ||
      !Number.isSafeInteger(cursor.offset) ||
      (cursor.boundary !== undefined &&
        cursor.boundary !== null &&
        typeof cursor.boundary !== "string")
    )
      throw new Error();
    return cursor as unknown as { offset: number; boundary?: string | null };
  } catch {
    throw new Error("Invalid Fleet cursor; target, filters or listing changed");
  }
}
function readHistory(
  thread: RemoteThreadView,
  workspaceId: string,
  peerBinding: string,
  args: Record<string, unknown>,
) {
  const granularity = args.granularity ?? "turns";
  if (
    !["turns", "items", "agent_messages", "item"].includes(String(granularity))
  )
    throw new Error("Invalid Fleet history granularity");
  const turnId =
    args.turnId === undefined ? undefined : string(args.turnId, "turn ID");
  const itemId =
    args.itemId === undefined ? undefined : string(args.itemId, "item ID");
  if (granularity === "turns" && turnId !== undefined)
    throw new Error(
      "turnId requires items, agent_messages or item granularity",
    );
  if ((granularity === "item") !== (itemId !== undefined))
    throw new Error("itemId requires item granularity and is mandatory for it");
  const maxTurns = integer(args.maxTurns, "maxTurns", 5, 20);
  const maxItems = integer(args.maxItemsPerTurn, "maxItemsPerTurn", 20, 25);
  const binding = createHash("sha256")
    .update(
      JSON.stringify([peerBinding, thread.id, granularity, turnId, itemId]),
    )
    .digest("hex");
  const cursor =
    args.cursor === undefined
      ? { offset: 0, boundary: thread.items.at(-1)?.id ?? null }
      : decodeCursor(args.cursor, binding);
  if (cursor.boundary === undefined)
    throw new Error("Invalid Fleet history cursor boundary");
  const boundaryIndex =
    cursor.boundary === null
      ? -1
      : thread.items.findIndex((view) => view.id === cursor.boundary);
  if (cursor.boundary !== null && boundaryIndex < 0)
    throw new Error("Fleet history boundary no longer exists");
  const snapshot = thread.items.slice(0, boundaryIndex + 1);
  if (
    turnId !== undefined &&
    !snapshot.some(
      (view) => view.type === "turn_started" && view.turnId === turnId,
    )
  )
    throw new Error("Unknown remote turnId");
  const filtered = snapshot.filter(
    (view) => turnId === undefined || view.turnId === turnId,
  );
  const base = {
    source: SOURCE,
    threadId: thread.id,
    cwd: workspaceId,
    granularity,
    snapshotThroughItemId: cursor.boundary,
  };
  const preview = (view: RemoteItemView) => ({
    ...view,
    ...(view.text === undefined
      ? {}
      : {
          text: view.text.slice(0, 1000),
          textTruncated: view.text.length > 1000,
        }),
  });
  if (granularity === "item") {
    const view = filtered.find((view) => view.id === itemId);
    if (!view) throw new Error("Unknown remote itemId");
    const raw = JSON.stringify(view);
    if (cursor.offset < 0 || cursor.offset > raw.length)
      throw new Error("Invalid Fleet item cursor offset");
    const end = Math.min(raw.length, cursor.offset + 8000);
    return {
      ...base,
      itemId,
      format: "public_item_json",
      content: raw.slice(cursor.offset, end),
      offset: cursor.offset,
      totalLength: raw.length,
      truncated: end < raw.length,
      nextCursor:
        end < raw.length ? encodeOffset(binding, end, cursor.boundary) : null,
    };
  }
  const entries =
    granularity === "turns"
      ? thread.turns
          .filter((turn) =>
            snapshot.some(
              (view) => view.type === "turn_started" && view.turnId === turn.id,
            ),
          )
          .map((turn) => ({
            ...turn,
            status: snapshot.some(
              (view) =>
                view.turnId === turn.id &&
                (view.type === "turn_completed" ||
                  view.type === "turn_aborted"),
            )
              ? turn.status
              : ("inProgress" as const),
          }))
      : filtered.filter(
          (view) =>
            granularity !== "agent_messages" || view.type === "agent_message",
        );
  if (cursor.offset < 0 || cursor.offset > entries.length)
    throw new Error("Invalid Fleet history cursor offset");
  const end = entries.length - cursor.offset;
  const start = Math.max(
    0,
    end - (granularity === "turns" ? maxTurns : maxItems),
  );
  const nextCursor =
    start > 0
      ? encodeOffset(binding, entries.length - start, cursor.boundary)
      : null;
  if (granularity === "turns")
    return {
      ...base,
      turns: (entries as RemoteThreadView["turns"])
        .slice(start, end)
        .map((turn) => {
          const views = snapshot.filter((view) => view.turnId === turn.id);
          const itemLimit = Math.min(
            maxItems,
            Math.max(1, Math.floor(100 / maxTurns)),
          );
          return {
            turnId: turn.id,
            status: turn.status,
            items: views.slice(-itemLimit).map(preview),
            itemsTruncated: views.length > itemLimit,
            readItems: {
              target: thread.id,
              granularity: "items",
              turnId: turn.id,
            },
          };
        }),
      turnsTruncated: start > 0,
      nextCursor,
    };
  return {
    ...base,
    items: (entries as RemoteItemView[]).slice(start, end).map(preview),
    truncated: start > 0,
    nextCursor,
  };
}
