import type { JsonRpcMessage, SendJson } from "../codex/wire.js";
import { isRecord, isRequest } from "../codex/wire.js";
import {
  NativeRecoveryProjection,
  type NativeProjectedThreadEvent,
} from "./recovery.js";
import {
  NATIVE_MODEL_CATALOG_UPDATED_METHOD,
  NATIVE_THREAD_EVENT_METHOD,
  NATIVE_THREAD_RESUME_METHOD,
} from "./wire.js";

export class NativeConnection {
  readonly #projection: NativeRecoveryProjection;
  readonly #send: SendJson;
  readonly #subscriptions = new Set<string>();
  readonly #barriers = new Map<string, NativeProjectedThreadEvent[]>();
  readonly #unsubscribe: () => void;
  #closed = false;

  constructor(options: {
    projection: NativeRecoveryProjection;
    send: SendJson;
  }) {
    this.#projection = options.projection;
    this.#send = options.send;
    this.#unsubscribe = this.#projection.subscribe((projected) => {
      if (this.#closed) return;
      if (projected.type === "model_catalog_updated") {
        this.#send({
          method: NATIVE_MODEL_CATALOG_UPDATED_METHOD,
          params: {
            processEpoch: projected.processEpoch,
            revision: projected.revision,
          },
        });
        return;
      }
      const event = projected.event;
      if (!this.#subscriptions.has(event.threadId)) return;
      const barrier = this.#barriers.get(event.threadId);
      if (barrier !== undefined) barrier.push(event);
      else this.#sendEvent(event);
    });
  }

  static handles(message: JsonRpcMessage): boolean {
    return isRequest(message) && message.method.startsWith("zen/");
  }

  async receive(message: JsonRpcMessage): Promise<void> {
    if (this.#closed || !isRequest(message)) return;
    if (message.method !== NATIVE_THREAD_RESUME_METHOD) {
      this.#send({
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
      return;
    }
    if (
      !isRecord(message.params) ||
      typeof message.params.threadId !== "string"
    ) {
      this.#send({
        id: message.id,
        error: { code: -32602, message: "threadId is required" },
      });
      return;
    }
    const threadId = message.params.threadId;
    if (this.#barriers.has(threadId)) {
      this.#send({
        id: message.id,
        error: {
          code: -32600,
          message: "Thread resume is already in progress",
        },
      });
      return;
    }
    const buffered: NativeProjectedThreadEvent[] = [];
    this.#barriers.set(threadId, buffered);
    this.#subscriptions.add(threadId);
    try {
      const snapshot = await this.#projection.resume(threadId);
      if (this.#closed) return;
      this.#send({ id: message.id, result: snapshot });
      for (const event of buffered) {
        if (
          event.processEpoch === snapshot.processEpoch &&
          event.watermark > snapshot.watermark
        )
          this.#sendEvent(event);
      }
    } catch (error) {
      if (!this.#closed) {
        this.#send({
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } finally {
      this.#barriers.delete(threadId);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#subscriptions.clear();
    this.#barriers.clear();
  }

  unsubscribe(threadId: string): void {
    this.#subscriptions.delete(threadId);
    this.#barriers.delete(threadId);
  }

  #sendEvent(event: NativeProjectedThreadEvent): void {
    this.#send({ method: NATIVE_THREAD_EVENT_METHOD, params: event });
  }
}
