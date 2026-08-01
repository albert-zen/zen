import { WebSocket, type RawData } from "ws";

import {
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcMessage,
  type RequestId,
} from "../../../../src/protocol/codex/wire.js";
import { readBearerTokenFile } from "./auth.js";
import type {
  ClientInfo,
  ClientRequestMethod,
  ClientRequestParams,
  ClientRequestResults,
  ConnectionStatus,
  ServerNotificationMethod,
  ServerNotificationParams,
  ServerRequestMethod,
  ServerRequestParams,
  ServerRequestResults,
} from "./types.js";

type UnknownNotificationHandler = (params: unknown) => void | Promise<void>;
type UnknownServerRequestHandler = (
  params: unknown,
) => unknown | Promise<unknown>;

export interface ZenXProtocolClientOptions {
  url: string;
  clientInfo: ClientInfo;
  bearerToken?: string;
  bearerTokenFile?: string;
  reconnect?: {
    maxAttempts?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
  };
}

interface ReconnectPolicy {
  maxAttempts: number;
  minDelayMs: number;
  maxDelayMs: number;
}

const defaultReconnectPolicy: ReconnectPolicy = {
  maxAttempts: 8,
  minDelayMs: 150,
  maxDelayMs: 3_000,
};

export class ZenXProtocolClient {
  readonly #url: string;
  readonly #clientInfo: ClientInfo;
  readonly #bearerToken: string | undefined;
  readonly #reconnectPolicy: ReconnectPolicy;
  readonly #pending = new Map<
    RequestId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #notificationHandlers = new Map<
    string,
    Set<UnknownNotificationHandler>
  >();
  readonly #serverRequestHandlers = new Map<
    string,
    UnknownServerRequestHandler
  >();
  readonly #statusHandlers = new Set<
    (status: ConnectionStatus) => void | Promise<void>
  >();
  readonly #subscribedThreads = new Set<string>();
  #socket: WebSocket | undefined;
  #nextRequestId = 1;
  #ready = false;
  #establishedOnce = false;
  #manualClose = false;
  #reconnectTask: Promise<void> | undefined;

  private constructor(
    options: ZenXProtocolClientOptions,
    bearerToken: string | undefined,
  ) {
    this.#url = options.url;
    this.#clientInfo = options.clientInfo;
    this.#bearerToken = bearerToken;
    this.#reconnectPolicy = {
      ...defaultReconnectPolicy,
      ...options.reconnect,
    };
    validateReconnectPolicy(this.#reconnectPolicy);
  }

  static async connect(
    options: ZenXProtocolClientOptions,
  ): Promise<ZenXProtocolClient> {
    assertLoopbackWebSocketUrl(options.url);
    if (
      options.bearerToken !== undefined &&
      options.bearerTokenFile !== undefined
    ) {
      throw new Error("Provide bearerToken or bearerTokenFile, not both");
    }
    const bearerToken =
      options.bearerTokenFile === undefined
        ? options.bearerToken
        : await readBearerTokenFile(options.bearerTokenFile);
    if (bearerToken !== undefined && bearerToken.length === 0) {
      throw new Error("WebSocket bearer token must not be empty");
    }
    const client = new ZenXProtocolClient(options, bearerToken);
    await client.#connectInitial();
    return client;
  }

  get connected(): boolean {
    return this.#ready;
  }

  get subscriptions(): readonly string[] {
    return [...this.#subscribedThreads];
  }

  async request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]> {
    if (method === "initialize") {
      throw new Error(
        "initialize is managed by ZenXProtocolClient.connect() and cannot be repeated",
      );
    }
    if (!this.#ready) {
      throw new Error("App Server connection is not ready");
    }
    const result = await this.#rawRequest(method, params);
    this.#recordSubscription(method, params, result);
    return result;
  }

  onNotification<M extends ServerNotificationMethod>(
    method: M,
    handler: (params: ServerNotificationParams[M]) => void | Promise<void>,
  ): () => void {
    const wrapped: UnknownNotificationHandler = async (params) => {
      await handler(params as ServerNotificationParams[M]);
    };
    const handlers = this.#notificationHandlers.get(method) ?? new Set();
    handlers.add(wrapped);
    this.#notificationHandlers.set(method, handlers);
    return () => handlers.delete(wrapped);
  }

  onServerRequest<M extends ServerRequestMethod>(
    method: M,
    handler: (
      params: ServerRequestParams[M],
    ) => ServerRequestResults[M] | Promise<ServerRequestResults[M]>,
  ): () => void {
    const wrapped: UnknownServerRequestHandler = async (params) =>
      await handler(params as ServerRequestParams[M]);
    this.#serverRequestHandlers.set(method, wrapped);
    return () => {
      if (this.#serverRequestHandlers.get(method) === wrapped) {
        this.#serverRequestHandlers.delete(method);
      }
    };
  }

  onStatus(
    handler: (status: ConnectionStatus) => void | Promise<void>,
  ): () => void {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }

  close(): void {
    if (this.#manualClose) return;
    this.#manualClose = true;
    this.#ready = false;
    this.#rejectPending(new Error("App Server connection closed"));
    const socket = this.#socket;
    this.#socket = undefined;
    if (
      socket !== undefined &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close(1000, "ZenX client closed");
    }
    this.#emitStatus({ type: "closed" });
  }

  async #connectInitial(): Promise<void> {
    this.#emitStatus({ type: "connecting" });
    try {
      await this.#openAndInitialize();
      this.#establishedOnce = true;
      this.#ready = true;
      this.#emitStatus({ type: "ready", reconnected: false });
    } catch (error) {
      this.#manualClose = true;
      const socket = this.#socket;
      this.#socket = undefined;
      if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
      this.#rejectPending(asError(error));
      this.#emitStatus({ type: "closed" });
      throw asError(error);
    }
  }

  async #openAndInitialize(): Promise<void> {
    const socket = new WebSocket(this.#url, {
      ...(this.#bearerToken === undefined
        ? {}
        : { headers: { Authorization: `Bearer ${this.#bearerToken}` } }),
    });
    this.#socket = socket;
    socket.on("message", (data, isBinary) => {
      void this.#receive(data, isBinary).catch((error: unknown) => {
        this.#emitStatus({ type: "protocolError", error: asError(error) });
      });
    });
    socket.on("error", (error) => {
      if (socket.readyState === WebSocket.OPEN) {
        this.#emitStatus({ type: "protocolError", error });
      }
    });
    socket.once("close", (code, reason) => {
      this.#handleSocketClose(socket, code, reason.toString());
    });

    await waitForOpen(socket);
    await this.#rawRequest("initialize", {
      clientInfo: this.#clientInfo,
      capabilities: null,
    });
    this.#send({ method: "initialized" });
  }

  async #rawRequest<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]> {
    const id = this.#nextRequestId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      this.#send({ id, method, params });
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return (await response) as ClientRequestResults[M];
  }

  async #receive(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.#socket?.close(1003, "JSON text frames required");
      throw new Error("App Server sent a binary WebSocket frame");
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch {
      this.#socket?.close(1003, "Invalid JSON");
      throw new Error("App Server sent invalid JSON");
    }

    if (isResponse(message)) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if ("error" in message) {
        pending.reject(
          new ZenXProtocolError(
            message.error.code,
            message.error.message,
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isRequest(message)) {
      const handler = this.#serverRequestHandlers.get(message.method);
      if (handler === undefined) {
        this.#send({
          id: message.id,
          error: {
            code: -32601,
            message: `Method not found: ${message.method}`,
          },
        });
        return;
      }
      try {
        const result = await handler(message.params);
        this.#send({ id: message.id, result });
      } catch (error) {
        this.#send({
          id: message.id,
          error: { code: -32603, message: asError(error).message },
        });
      }
      return;
    }

    if (isNotification(message)) {
      const handlers = this.#notificationHandlers.get(message.method);
      if (handlers === undefined) return;
      for (const handler of handlers) await handler(message.params);
    }
  }

  #send(message: JsonRpcMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new Error("App Server connection is not open");
    }
    this.#socket.send(JSON.stringify(message));
  }

  #handleSocketClose(socket: WebSocket, code: number, reason: string): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#ready = false;
    this.#rejectPending(
      new Error(
        `App Server connection closed (${String(code)}${reason.length === 0 ? "" : `: ${reason}`})`,
      ),
    );
    if (!this.#manualClose && this.#establishedOnce) {
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTask !== undefined || this.#manualClose) return;
    this.#reconnectTask = this.#reconnect().finally(() => {
      this.#reconnectTask = undefined;
    });
  }

  async #reconnect(): Promise<void> {
    let lastError = new Error("App Server reconnect failed");
    for (
      let attempt = 1;
      attempt <= this.#reconnectPolicy.maxAttempts;
      attempt += 1
    ) {
      const delayMs = Math.min(
        this.#reconnectPolicy.maxDelayMs,
        this.#reconnectPolicy.minDelayMs * 2 ** (attempt - 1),
      );
      this.#emitStatus({ type: "reconnecting", attempt, delayMs });
      await delay(delayMs);
      if (this.#manualClose) return;
      try {
        await this.#openAndInitialize();
        await this.#restoreSubscriptions();
        this.#ready = true;
        this.#emitStatus({ type: "ready", reconnected: true });
        return;
      } catch (error) {
        lastError = asError(error);
        const socket = this.#socket;
        this.#socket = undefined;
        if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
          socket.terminate();
        }
      }
    }
    this.#emitStatus({ type: "protocolError", error: lastError });
    this.close();
  }

  async #restoreSubscriptions(): Promise<void> {
    for (const threadId of this.#subscribedThreads) {
      try {
        const result = await this.#rawRequest("thread/resume", { threadId });
        this.#emitStatus({
          type: "resubscribed",
          threadId,
          thread: result.thread,
        });
      } catch (error) {
        if (this.#socket?.readyState !== WebSocket.OPEN) throw error;
        this.#emitStatus({
          type: "resubscribeFailed",
          threadId,
          error: asError(error),
        });
      }
    }
  }

  #recordSubscription<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
    result: ClientRequestResults[M],
  ): void {
    if (method === "thread/start") {
      this.#subscribedThreads.add(
        (result as ClientRequestResults["thread/start"]).thread.id,
      );
      return;
    }
    if (method === "thread/resume" || method === "turn/start") {
      this.#subscribedThreads.add(
        (params as ClientRequestParams["thread/resume"]).threadId,
      );
      return;
    }
    if (method === "thread/unsubscribe") {
      this.#subscribedThreads.delete(
        (params as ClientRequestParams["thread/unsubscribe"]).threadId,
      );
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #emitStatus(status: ConnectionStatus): void {
    for (const handler of this.#statusHandlers) {
      void Promise.resolve(handler(status)).catch(() => undefined);
    }
  }
}

export class ZenXProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ZenXProtocolError";
    this.code = code;
    this.data = data;
  }
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const opened = (): void => {
      socket.off("error", failed);
      resolve();
    };
    const failed = (error: Error): void => {
      socket.off("open", opened);
      reject(error);
    };
    socket.once("open", opened);
    socket.once("error", failed);
  });
}

function assertLoopbackWebSocketUrl(rawUrl: string): void {
  const url = new URL(rawUrl);
  if (url.protocol !== "ws:") {
    throw new Error("ZenX supports ws:// App Server connections only");
  }
  if (
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost" &&
    url.hostname !== "::1" &&
    url.hostname !== "[::1]"
  ) {
    throw new Error(`Refusing non-loopback App Server: ${url.hostname}`);
  }
}

function validateReconnectPolicy(policy: ReconnectPolicy): void {
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    !Number.isFinite(policy.minDelayMs) ||
    policy.minDelayMs < 0 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.minDelayMs
  ) {
    throw new Error("Invalid App Server reconnect policy");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
