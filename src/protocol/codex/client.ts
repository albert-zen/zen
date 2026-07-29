import { WebSocket } from "ws";

import {
  isNotification,
  isRecord,
  isRequest,
  isResponse,
  type JsonRpcMessage,
  type RequestId,
} from "./wire.js";

export type NotificationHandler = (
  params: unknown,
  method: string,
) => void | Promise<void>;

export type ServerRequestHandler = (
  params: unknown,
  method: string,
) => unknown | Promise<unknown>;

export class CodexClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    RequestId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #notificationHandlers = new Map<string, Set<NotificationHandler>>();
  readonly #serverRequestHandlers = new Map<string, ServerRequestHandler>();
  #nextRequestId = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.close();
        return;
      }
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(data.toString()) as JsonRpcMessage;
      } catch {
        this.close();
        return;
      }
      void this.#receive(message);
    });
    socket.once("close", () => {
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("App Server connection closed"));
      }
      this.#pending.clear();
    });
  }

  static async connect(
    url: string,
    options: { bearerToken?: string } = {},
  ): Promise<CodexClient> {
    const socket = new WebSocket(url, {
      ...(options.bearerToken === undefined
        ? {}
        : { headers: { Authorization: `Bearer ${options.bearerToken}` } }),
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new CodexClient(socket);
  }

  async initialize(clientInfo: {
    name: string;
    title: string;
    version: string;
  }): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo,
      capabilities: null,
    });
    this.notify("initialized");
    return result;
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("App Server connection is closed"));
    }
    const id = this.#nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ id, method, params });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.#send(params === undefined ? { method } : { method, params });
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.#notificationHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.#notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
    };
  }

  onServerRequest(method: string, handler: ServerRequestHandler): () => void {
    this.#serverRequestHandlers.set(method, handler);
    return () => {
      if (this.#serverRequestHandlers.get(method) === handler) {
        this.#serverRequestHandlers.delete(method);
      }
    };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#socket.close(1000, "Client closed");
  }

  async #receive(message: JsonRpcMessage): Promise<void> {
    if (isResponse(message)) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(message.id);
      if ("error" in message) {
        pending.reject(
          new CodexClientError(message.error.code, message.error.message),
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
        const result = await handler(message.params, message.method);
        this.#send({ id: message.id, result });
      } catch (error) {
        this.#send({
          id: message.id,
          error: { code: -32603, message: describeError(error) },
        });
      }
      return;
    }
    if (isNotification(message)) {
      const handlers = this.#notificationHandlers.get(message.method);
      if (handlers === undefined) {
        return;
      }
      for (const handler of handlers) {
        await handler(message.params, message.method);
      }
    }
  }

  #send(message: JsonRpcMessage): void {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("App Server connection is not open");
    }
    this.#socket.send(JSON.stringify(message));
  }
}

export class CodexClientError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "CodexClientError";
    this.code = code;
  }
}

export function responseResult<T extends Record<string, unknown>>(
  value: unknown,
  key: string,
): T {
  if (!isRecord(value) || !isRecord(value[key])) {
    throw new Error(`App Server response omitted ${key}`);
  }
  return value[key] as T;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
