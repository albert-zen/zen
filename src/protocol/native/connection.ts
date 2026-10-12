import { resolveModelKey } from "../model-key.js";
import type { JsonRpcMessage, SendJson } from "../codex/wire.js";
import { AppServerError, type ZenAppServer } from "../../app-server.js";
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
  NATIVE_THREAD_CREATE_CHILD_METHOD,
  NATIVE_THREAD_CREATE_CHILD_CONFIGURED_METHOD,
  NATIVE_QUEUE_CANCEL_METHOD,
  NATIVE_QUEUE_EDIT_METHOD,
  type NativeQueueEditParams,
  NATIVE_TURN_SEND_UNARCHIVED_METHOD,
  type NativeTurnSendResult,
} from "./wire.js";

export class NativeConnection {
  readonly #projection: NativeRecoveryProjection;
  readonly #send: SendJson;
  readonly #subscriptions = new Set<string>();
  readonly #barriers = new Map<string, NativeProjectedThreadEvent[]>();
  readonly #unsubscribe: () => void;
  #closed = false;
  #nativeSession = false;
  #initialized = false;
  readonly #isInitialized: () => boolean;
  readonly #appServer: ZenAppServer | undefined;
  readonly #requestApproval: ApprovalHandler | undefined;

  constructor(options: {
    projection: NativeRecoveryProjection;
    send: SendJson;
    appServer?: ZenAppServer;
    requestApproval?: ApprovalHandler;
    isInitialized?: () => boolean;
  }) {
    this.#projection = options.projection;
    this.#send = options.send;
    this.#appServer = options.appServer;
    this.#requestApproval = options.requestApproval;
    this.#isInitialized = options.isInitialized ?? (() => false);
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
    if (
      message.method === NATIVE_THREAD_CREATE_CHILD_METHOD ||
      message.method === NATIVE_THREAD_CREATE_CHILD_CONFIGURED_METHOD
    ) {
      if (!this.#initialized && !this.#isInitialized()) {
        this.#send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
      try {
        const params = message.params;
        if (
          !isRecord(params) ||
          typeof params.parentThreadId !== "string" ||
          params.parentThreadId.length === 0 ||
          params.parentThreadId.length > 512 ||
          (params.mode !== "fresh" &&
            params.mode !== "fork" &&
            params.mode !== "side-chat")
        )
          throw new AppServerError(
            "invalid_request",
            "parentThreadId and fresh/fork/side-chat mode are required",
          );
        for (const key of Object.keys(params)) {
          if (!["parentThreadId", "mode", "model", "effort"].includes(key))
            throw new AppServerError(
              "invalid_request",
              `Unexpected argument: ${key}`,
            );
        }
        for (const key of ["model", "effort"]) {
          const value = params[key];
          if (
            value !== undefined &&
            (typeof value !== "string" ||
              value.trim().length === 0 ||
              value.length > 4096)
          )
            throw new AppServerError(
              "invalid_request",
              `${key} must be a non-empty string of at most 4096 characters`,
            );
        }
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Native child creation is unavailable",
          );
        let selection;
        if (typeof params.model === "string") {
          try {
            selection = {
              ...resolveModelKey(
                params.model,
                this.#appServer.listModels(),
                this.#appServer.threadStartDefaults().providerProfileId,
              ),
              ...(params.effort === undefined
                ? {}
                : { reasoningEffort: params.effort as string }),
            };
          } catch (error) {
            throw new AppServerError(
              "invalid_request",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        const thread = await this.#appServer.createChildThread({
          parentThreadId: params.parentThreadId,
          mode: params.mode,
          ...(selection === undefined
            ? params.effort === undefined
              ? {}
              : { reasoningEffort: params.effort as string }
            : { selection }),
        });
        if (!this.#closed) this.#send({ id: message.id, result: { thread } });
      } catch (error) {
        if (!this.#closed)
          this.#send({
            id: message.id,
            error: {
              code: error instanceof AppServerError ? -32602 : -32603,
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof AppServerError
                ? { data: { zenCode: error.code } }
                : {}),
            },
          });
      }
      return;
    }
    if (message.method === NATIVE_QUEUE_EDIT_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        this.#send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
      try {
        const params = message.params;
        if (
          !isRecord(params) ||
          typeof params.threadId !== "string" ||
          params.threadId.trim().length === 0 ||
          typeof params.queuedItemId !== "string" ||
          typeof params.clientId !== "string" ||
          typeof params.editId !== "string" ||
          typeof params.expectedRevision !== "number" ||
          !Array.isArray(params.input)
        )
          throw new AppServerError(
            "invalid_request",
            "Thread, queue identity, expected revision, edit ID and input are required",
          );
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Native queue editing is unavailable",
          );
        const request = params as unknown as NativeQueueEditParams;
        this.#subscriptions.add(request.threadId);
        const result = await this.#appServer.editQueuedMessage(
          request.threadId,
          request,
          request.input,
        );
        if (!this.#closed) this.#send({ id: message.id, result });
      } catch (error) {
        if (!this.#closed)
          this.#send({
            id: message.id,
            error:
              error instanceof AppServerError
                ? {
                    code: -32602,
                    message: error.message,
                    data: { zenCode: error.code },
                  }
                : {
                    code: -32603,
                    message:
                      "Queue edit outcome is unconfirmed. Read the Thread or retry the same edit ID before making another edit.",
                  },
          });
      }
      return;
    }
    if (message.method === NATIVE_QUEUE_CANCEL_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        this.#send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
      try {
        const params = message.params;
        if (
          !isRecord(params) ||
          typeof params.threadId !== "string" ||
          !Array.isArray(params.items) ||
          params.items.some(
            (item: unknown) =>
              !isRecord(item) ||
              typeof item.queuedItemId !== "string" ||
              typeof item.clientId !== "string",
          )
        )
          throw new AppServerError(
            "invalid_request",
            "threadId and queued item/client IDs are required",
          );
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Native queue cancellation is unavailable",
          );
        const items = params.items as {
          queuedItemId: string;
          clientId: string;
        }[];
        const results = await this.#appServer.cancelQueuedMessages(
          params.threadId,
          items,
        );
        this.#subscriptions.add(params.threadId);
        this.#send({ id: message.id, result: { results } });
      } catch (error) {
        const reason =
          error instanceof AppServerError
            ? {
                code: -32602,
                message: error.message,
                data: { zenCode: error.code },
              }
            : {
                code: -32603,
                message:
                  "Queue cancellation outcome is unconfirmed. Read the Thread before retrying.",
              };
        this.#send({ id: message.id, error: reason });
      }
      return;
    }
    if (
      message.method === "zen/turn/send" ||
      message.method === NATIVE_TURN_SEND_UNARCHIVED_METHOD
    ) {
      if (!this.#initialized && !this.#isInitialized()) {
        this.#send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
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
        if (
          params.requireUnarchived !== undefined &&
          typeof params.requireUnarchived !== "boolean"
        )
          throw new AppServerError(
            "invalid_request",
            "requireUnarchived must be a boolean",
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
          ...(message.method === NATIVE_TURN_SEND_UNARCHIVED_METHOD
            ? { requireUnarchived: true }
            : params.requireUnarchived === undefined
              ? {}
              : { requireUnarchived: params.requireUnarchived }),
          ...(this.#requestApproval === undefined
            ? {}
            : { requestApproval: this.#requestApproval }),
        };
        this.#subscriptions.add(params.threadId);
        let result: NativeTurnSendResult = {};
        if (params.mode === "queue" || params.mode === "batch-next")
          await this.#appServer.queueMessage(
            params.threadId,
            input,
            options.clientId,
            params.mode === "batch-next"
              ? { ...options, deliveryMode: "batch-next" }
              : options,
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
            result = {
              turnId: replacement.turn.id,
              interruptedTurnId: replacement.interruptedTurnId,
            };
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
            ...(error instanceof AppServerError
              ? { data: { zenCode: error.code } }
              : {}),
          },
        });
      }
      return;
    }
    if (message.method === NATIVE_INITIALIZE_METHOD) {
      this.#initialized = true;
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
