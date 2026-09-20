import type { JsonRpcMessage, SendJson } from "../codex/wire.js";
import type { ZenAppServer } from "../../app-server.js";
import type { ApprovalHandler } from "../../tool.js";
import { validateUserInput, type UserInputPart } from "../../item.js";
import type { SkillReference } from "../../skill-input.js";
import { isRecord, isRequest } from "../codex/wire.js";
import {
  NativeRecoveryProjection,
  type NativeProjectedThreadEvent,
} from "./recovery.js";
import {
  NATIVE_MODEL_CATALOG_UPDATED_METHOD,
  NATIVE_INITIALIZE_METHOD,
  NATIVE_THREAD_EVENT_METHOD,
  NATIVE_THREAD_RESUME_METHOD,
  NATIVE_THREAD_READ_METHOD,
} from "./wire.js";

export class NativeConnection {
  readonly #projection: NativeRecoveryProjection;
  readonly #send: SendJson;
  readonly #subscriptions = new Set<string>();
  readonly #barriers = new Map<string, NativeProjectedThreadEvent[]>();
  readonly #unsubscribe: () => void;
  #closed = false;
  #nativeSession = false;
  readonly #appServer: ZenAppServer | undefined;
  readonly #requestApproval: ApprovalHandler | undefined;

  constructor(options: {
    projection: NativeRecoveryProjection;
    send: SendJson;
    appServer?: ZenAppServer;
    requestApproval?: ApprovalHandler;
  }) {
    this.#projection = options.projection;
    this.#send = options.send;
    this.#appServer = options.appServer;
    this.#requestApproval = options.requestApproval;
    this.#unsubscribe = this.#projection.subscribe((projected) => {
      if (this.#closed) return;
      if (projected.type === "model_catalog_updated") {
        if (!this.#nativeSession) return;
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
    if (message.method === "zen/turn/send") {
      try {
        const params = message.params;
        if (this.#appServer === undefined)
          throw new Error("Native send is unavailable");
        if (
          !isRecord(params) ||
          typeof params.threadId !== "string" ||
          typeof params.clientUserMessageId !== "string" ||
          params.clientUserMessageId.length === 0 ||
          !Array.isArray(params.input) ||
          params.input.length === 0
        )
          throw new Error(
            "threadId, clientUserMessageId and input are required",
          );
        const input: (UserInputPart | SkillReference)[] = params.input.map(
          (part: unknown) => {
            if (!isRecord(part)) throw new Error("Invalid input part");
            if (
              part.type === "skill" &&
              typeof part.id === "string" &&
              part.id.length > 0
            )
              return { type: "skill", id: part.id };
            if (part.skillSource !== undefined)
              throw new Error("Skill provenance is Host-owned");
            validateUserInput([part], "input");
            return part as unknown as UserInputPart;
          },
        );
        const options = {
          clientId: params.clientUserMessageId,
          ...(this.#requestApproval === undefined
            ? {}
            : { requestApproval: this.#requestApproval }),
        };
        this.#nativeSession = true;
        this.#subscriptions.add(params.threadId);
        let result: { turnId?: string } = {};
        if (params.mode === "queue")
          await this.#appServer.queueMessage(
            params.threadId,
            input,
            options.clientId,
            options,
          );
        else if (params.mode === "start") {
          const turn = await this.#appServer.startTurn(
            params.threadId,
            input,
            options,
          );
          result = { turnId: turn.id };
          void turn.done.catch(() => undefined);
        } else {
          if (typeof params.expectedTurnId !== "string")
            throw new Error("expectedTurnId is required");
          if (params.mode === "steer") {
            const turn = await this.#appServer.steerTurn(
              params.threadId,
              params.expectedTurnId,
              input,
              options,
            );
            result = { turnId: turn.id };
            void turn.done.catch(() => undefined);
          } else if (params.mode === "replace") {
            const replacement = await this.#appServer.replaceTurn(
              params.threadId,
              params.expectedTurnId,
              input,
              options,
            );
            result = { turnId: replacement.turn.id };
            void replacement.turn.done.catch(() => undefined);
          } else throw new Error("Invalid send mode");
        }
        this.#send({ id: message.id, result });
      } catch (error) {
        this.#send({
          id: message.id,
          error: {
            code: -32602,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }
    if (message.method === NATIVE_INITIALIZE_METHOD) {
      this.#nativeSession = true;
      this.#send({
        id: message.id,
        result: { processEpoch: this.#projection.processEpoch },
      });
      return;
    }
    if (
      message.method !== NATIVE_THREAD_RESUME_METHOD &&
      message.method !== NATIVE_THREAD_READ_METHOD
    ) {
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
    if (message.method === NATIVE_THREAD_READ_METHOD) {
      try {
        const thread = await this.#projection.read(threadId);
        if (!this.#closed) this.#send({ id: message.id, result: { thread } });
      } catch (error) {
        if (!this.#closed)
          this.#send({
            id: message.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          });
      }
      return;
    }
    this.#nativeSession = true;
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
