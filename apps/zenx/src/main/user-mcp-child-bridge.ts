import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { OpenNativeBoundMcp } from "../../../../src/protocol/native/bound-mcp.js";
import { validateBoardOwner } from "../board-host.js";
import {
  createBoundUserMcpServer,
  type BoundUserMcpOptions,
} from "./user-mcp.js";
import type {
  UserMcpHostCommand,
  UserMcpHostEvent,
} from "./user-mcp-messages.js";

/** IPC correlations only; the existing child retains ToolEnvironment admission. */
export class UserMcpChildBridge {
  #closed = false;
  readonly #pending = new Map<
    string,
    {
      resolve(
        command: Extract<UserMcpHostCommand, { type: "user-mcp/result" }>,
      ): void;
      reject(error: unknown): void;
    }
  >();
  readonly #bindings = new Map<string, AbortController>();
  readonly #changes = new Set<() => void>();
  constructor(
    readonly options: Omit<
      BoundUserMcpOptions,
      "owner" | "signal" | "board" | "capabilities" | "requestApproval"
    > & { send(event: UserMcpHostEvent): void },
  ) {}
  receive(command: UserMcpHostCommand) {
    if (command.type === "user-mcp/revoked") {
      this.#bindings.get(command.connectionId)?.abort(new Error(command.error));
      return;
    }
    const pending = this.#pending.get(command.requestId);
    if (!pending) return;
    if (command.error) pending.reject(new Error(command.error));
    else pending.resolve(command);
  }
  capabilitiesChanged() {
    for (const change of this.#changes) change();
  }
  readonly open: OpenNativeBoundMcp = async ({ owner: raw, signal, send }) => {
    if (this.#closed) throw new Error("Host MCP bridge is closed");
    if (this.#bindings.size >= 64)
      throw new Error("Host MCP connection limit reached");
    const owner = Object.freeze(validateBoardOwner(raw));
    const connectionId = randomUUID();
    const controller = new AbortController();
    const lifetime = AbortSignal.any([signal, controller.signal]);
    this.#bindings.set(connectionId, controller);
    const rpc = async (
      event:
        | { type: "user-mcp/open"; connectionId: string; owner: typeof owner }
        | { type: "user-mcp/check-owner"; connectionId: string },
      timeout?: number,
    ) => {
      lifetime.throwIfAborted();
      if (this.#pending.size >= 128)
        throw new Error("Host MCP pending transport limit reached");
      const requestId = randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        this.#pending.get(requestId)?.reject(lifetime.reason);
        this.options.send({ type: "user-mcp/cancel", connectionId, requestId });
      };
      try {
        return await new Promise<
          Extract<UserMcpHostCommand, { type: "user-mcp/result" }>
        >((resolve, reject) => {
          this.#pending.set(requestId, { resolve, reject });
          lifetime.addEventListener("abort", abort, { once: true });
          if (timeout)
            timer = setTimeout(
              () => reject(new Error("Desktop MCP owner query timed out")),
              timeout,
            );
          this.options.send({ ...event, requestId } as UserMcpHostEvent);
          if (lifetime.aborted) abort();
        });
      } finally {
        if (timer) clearTimeout(timer);
        lifetime.removeEventListener("abort", abort);
        this.#pending.delete(requestId);
      }
    };
    let connection:
      Awaited<ReturnType<typeof createBoundUserMcpServer>> | undefined;
    let closed = false;
    let transport: Transport;
    const close = async () => {
      if (closed) return;
      closed = true;
      controller.abort(new Error("Bound MCP tunnel closed"));
      this.#bindings.delete(connectionId);
      this.options.send({ type: "user-mcp/close", connectionId });
      await connection?.close();
    };
    try {
      await rpc({ type: "user-mcp/open", connectionId, owner }, 5000);
      connection = await createBoundUserMcpServer({
        ...this.options,
        owner,
        signal: lifetime,
        board: {
          readOwner: async () => {
            await rpc({ type: "user-mcp/check-owner", connectionId }, 5000);
            return owner;
          },
          options: {
            rooms: {
              onChange: (listener) => {
                lifetime.addEventListener("abort", listener);
                return () => lifetime.removeEventListener("abort", listener);
              },
            },
          },
        },
        capabilities: {
          onChange: (listener) => {
            this.#changes.add(listener);
            return () => this.#changes.delete(listener);
          },
        },
        requestApproval: async (request) => {
          const { signal: requestSignal, ...serializable } = request;
          if (this.#pending.size >= 128)
            throw new Error("Host MCP pending transport limit reached");
          // Per-call cancellation is independent of the connection lifetime.
          const requestId = randomUUID();
          const combined = AbortSignal.any([lifetime, requestSignal]);
          const abort = () => {
            this.#pending.get(requestId)?.reject(combined.reason);
            this.options.send({
              type: "user-mcp/cancel",
              connectionId,
              requestId,
            });
          };
          try {
            const response = await new Promise<
              Extract<UserMcpHostCommand, { type: "user-mcp/result" }>
            >((resolve, reject) => {
              combined.throwIfAborted();
              this.#pending.set(requestId, { resolve, reject });
              combined.addEventListener("abort", abort, { once: true });
              this.options.send({
                type: "user-mcp/approval",
                connectionId,
                requestId,
                request: serializable,
              });
              if (combined.aborted) abort();
            });
            return response.decision ?? "cancel";
          } finally {
            combined.removeEventListener("abort", abort);
            this.#pending.delete(requestId);
          }
        },
      });
      transport = {
        start: async () => {},
        send: async (message) => {
          if (!closed && !signal.aborted) send(message);
        },
        close: async () => {
          transport.onclose?.();
        },
      };
      await connection.server.connect(transport);
      return {
        receive: async (message) => {
          // SDK validates the inner wire. Revoked bindings remain available only
          // to return explicit tool failure, never to revive admission.
          if (closed) throw new Error("MCP tunnel is closed");
          const parsed: JSONRPCMessage = JSONRPCMessageSchema.parse(message);
          transport.onmessage?.(parsed);
        },
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  };
  close() {
    this.#closed = true;
    for (const controller of this.#bindings.values())
      controller.abort(new Error("Host MCP bridge closed"));
    this.#bindings.clear();
    for (const pending of this.#pending.values())
      pending.reject(new Error("Host MCP bridge closed"));
    this.#pending.clear();
    this.#changes.clear();
  }
}
