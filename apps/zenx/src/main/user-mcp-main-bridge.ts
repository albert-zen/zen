import { validateBoardOwner, type BoardOwner } from "../board-host.js";
import type { ApprovalHandler } from "../../../../src/tool.js";
import type {
  UserMcpHostCommand,
  UserMcpHostEvent,
} from "./user-mcp-messages.js";

export interface UserMcpOwnerPort {
  readOwner(owner: BoardOwner): Promise<BoardOwner>;
  onChange?(listener: () => void): () => void;
}
interface Binding {
  owner: BoardOwner;
  controller: AbortController;
  requestApproval: ApprovalHandler;
  current(): boolean;
  dispose?(): void;
  requests: Map<string, AbortController>;
}
/** Main's disposable connection bindings; never a policy or approval registry. */
export class UserMcpMainBridge {
  readonly #bindings = new Map<string, Binding>();
  #closed = false;
  constructor(
    readonly options: {
      owners?: UserMcpOwnerPort;
      captureApproval(): {
        requestApproval: ApprovalHandler;
        current(): boolean;
      };
      send(command: UserMcpHostCommand): void;
    },
  ) {}
  async receive(event: UserMcpHostEvent): Promise<void> {
    if (this.#closed) return;
    if (event.type === "user-mcp/close") {
      this.#retire(event.connectionId, "MCP connection closed");
      return;
    }
    if (event.type === "user-mcp/cancel") {
      this.#bindings
        .get(event.connectionId)
        ?.requests.get(event.requestId)
        ?.abort(new Error("MCP request cancelled"));
      return;
    }
    try {
      if (!this.options.owners)
        throw new Error("Desktop MCP owner validation is unavailable");
      if (event.type === "user-mcp/open") {
        if (this.#bindings.has(event.connectionId))
          throw new Error("MCP binding already exists");
        if (this.#bindings.size >= 64)
          throw new Error("Desktop MCP connection limit reached");
        const owner = Object.freeze(validateBoardOwner(event.owner));
        const binding: Binding = {
          owner,
          controller: new AbortController(),
          ...this.options.captureApproval(),
          requests: new Map(),
        };
        this.#bindings.set(event.connectionId, binding);
        if (owner.kind === "room") {
          if (!this.options.owners.onChange)
            throw new Error("Room MCP requires live owner observation");
          binding.dispose = this.options.owners.onChange(() => {
            // readOwner checks membership synchronously before any await. Loss is one-way.
            void this.#assertOwner(binding).catch((error) =>
              this.#retire(event.connectionId, detail(error)),
            );
          });
        }
        await this.#assertOwner(binding);
        this.options.send({
          type: "user-mcp/result",
          requestId: event.requestId,
        });
        return;
      }
      const binding = this.#bindings.get(event.connectionId);
      if (!binding) throw new Error("MCP binding is unavailable or retired");
      if (event.type === "user-mcp/check-owner") {
        await this.#assertOwner(binding);
        this.options.send({
          type: "user-mcp/result",
          requestId: event.requestId,
        });
        return;
      }
      if (event.request.threadId !== binding.owner.threadId)
        throw new Error("Approval Thread differs from the fixed MCP owner");
      const controller = new AbortController();
      if (binding.requests.has(event.requestId))
        throw new Error("MCP request identity already in use");
      if (binding.requests.size >= 128)
        throw new Error("Desktop MCP pending approval limit reached");
      // Correlate before owner I/O so cancellation cannot race approval creation.
      binding.requests.set(event.requestId, controller);
      try {
        await this.#assertOwner(binding);
        const signal = AbortSignal.any([
          controller.signal,
          binding.controller.signal,
        ]);
        signal.throwIfAborted();
        const decision = await binding.requestApproval({
          ...event.request,
          signal,
        });
        signal.throwIfAborted();
        await this.#assertOwner(binding);
        this.options.send({
          type: "user-mcp/result",
          requestId: event.requestId,
          decision,
        });
      } finally {
        binding.requests.delete(event.requestId);
      }
    } catch (error) {
      if (event.type === "user-mcp/open")
        this.#retire(event.connectionId, detail(error));
      this.options.send({
        type: "user-mcp/result",
        requestId: event.requestId,
        error: detail(error),
      });
    }
  }
  async #assertOwner(binding: Binding) {
    binding.controller.signal.throwIfAborted();
    if (!binding.current())
      throw new Error("Desktop approval connection generation retired");
    await this.options.owners!.readOwner(binding.owner);
    binding.controller.signal.throwIfAborted();
    if (!binding.current())
      throw new Error("Desktop approval connection generation retired");
  }
  #retire(connectionId: string, reason: string) {
    const binding = this.#bindings.get(connectionId);
    if (!binding) return;
    this.#bindings.delete(connectionId);
    binding.controller.abort(new Error(reason));
    binding.requests.clear();
    binding.dispose?.();
    this.options.send({
      type: "user-mcp/revoked",
      connectionId,
      error: reason,
    });
  }
  retireAll() {
    for (const id of this.#bindings.keys())
      this.#retire(id, "Desktop Host connection generation retired");
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of this.#bindings.keys())
      this.#retire(id, "Desktop Host connection closed");
  }
}
function detail(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
