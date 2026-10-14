import type { JsonRpcMessage, SendJson } from "../codex/wire.js";
import { AppServerError, type ZenAppServer } from "../../app-server.js";
import type { ApprovalHandler } from "../../tool.js";
import { ThreadJournalAppendOutcomeUnknownError } from "../../journal.js";
import { prepareNativeInput } from "./input.js";
import { isRecord, isRequest } from "../codex/wire.js";
import {
  NativeRecoveryProjection,
  type NativeProjectedThreadEvent,
} from "./recovery.js";
import {
  NATIVE_MODEL_CATALOG_UPDATED_METHOD,
  NATIVE_QUEUED_INPUT_ADMISSION_CAPABILITY,
  NATIVE_INLINE_IMAGE_INPUT_CAPABILITY,
  NATIVE_THREAD_DELETE_METHOD,
  NATIVE_THREAD_DELETED_LIST_METHOD,
  NATIVE_THREAD_RESTORE_METHOD,
  NATIVE_INITIALIZE_METHOD,
  NATIVE_THREAD_EVENT_METHOD,
  NATIVE_THREAD_RESUME_METHOD,
  NATIVE_THREAD_READ_METHOD,
  NATIVE_THREAD_CREATE_CHILD_METHOD,
  NATIVE_QUEUE_CANCEL_METHOD,
  NATIVE_QUEUE_EDIT_METHOD,
  type NativeQueueEditParams,
  NATIVE_TURN_SEND_UNARCHIVED_METHOD,
  NATIVE_TURN_WAKE_METHOD,
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
      if (
        !this.#subscriptions.has(event.threadId) &&
        !(event.event.type === "thread_deleted_updated" && this.#nativeSession)
      )
        return;
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
      message.method === NATIVE_THREAD_DELETE_METHOD ||
      message.method === NATIVE_THREAD_DELETED_LIST_METHOD ||
      message.method === NATIVE_THREAD_RESTORE_METHOD
    ) {
      if (!this.#initialized && !this.#isInitialized()) {
        this.#send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
      try {
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Native Thread deletion is unavailable",
          );
        const params = message.params;
        if (!isRecord(params))
          throw new AppServerError(
            "invalid_request",
            "Thread parameters are required",
          );
        let result: unknown;
        if (message.method === NATIVE_THREAD_DELETED_LIST_METHOD) {
          if (Object.keys(params).length > 0)
            throw new AppServerError(
              "invalid_request",
              "Deleted listing takes no parameters",
            );
          result = { data: await this.#appServer.listDeletedThreads() };
        } else {
          const field =
            message.method === NATIVE_THREAD_DELETE_METHOD
              ? "expectedLastItemId"
              : "deletionItemId";
          if (
            Object.keys(params).some(
              (key) => key !== "threadId" && key !== field,
            ) ||
            typeof params.threadId !== "string" ||
            !params.threadId.trim() ||
            params.threadId.length > 512 ||
            typeof params[field] !== "string" ||
            !params[field].trim() ||
            params[field].length > 512
          )
            throw new AppServerError(
              "invalid_request",
              `threadId and ${field} are required`,
            );
          result =
            message.method === NATIVE_THREAD_DELETE_METHOD
              ? await this.#appServer.deleteThread(
                  params.threadId,
                  params[field],
                )
              : {
                  thread: await this.#appServer.restoreThread(
                    params.threadId,
                    params[field],
                  ),
                };
        }
        if (!this.#closed) this.#send({ id: message.id, result });
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
    if (message.method === NATIVE_THREAD_CREATE_CHILD_METHOD) {
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
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Native child creation is unavailable",
          );
        const thread = await this.#appServer.createChildThread({
          parentThreadId: params.parentThreadId,
          mode: params.mode,
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
    if (message.method === NATIVE_TURN_WAKE_METHOD) {
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
          !params.threadId.trim() ||
          typeof params.clientId !== "string" ||
          !params.clientId.trim() ||
          typeof params.text !== "string" ||
          !params.text.trim() ||
          params.source !== "bootstrap" ||
          (params.mode !== "start" && params.mode !== "steer") ||
          (params.mode === "steer" &&
            (typeof params.expectedTurnId !== "string" ||
              !params.expectedTurnId.trim())) ||
          (params.requireUnarchived !== undefined &&
            typeof params.requireUnarchived !== "boolean")
        )
          throw new AppServerError(
            "invalid_request",
            "Host bootstrap input, client ID and start/steer mode are required",
          );
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Native Host wakeup is unavailable",
          );
        this.#subscriptions.add(params.threadId);
        const turn = await this.#appServer.wakeTurn(
          params.threadId,
          {
            clientId: params.clientId,
            text: params.text,
            source: "bootstrap",
          },
          {
            mode: params.mode,
            ...(params.mode === "steer"
              ? { expectedTurnId: params.expectedTurnId as string }
              : {}),
            ...(params.requireUnarchived === undefined
              ? {}
              : { requireUnarchived: params.requireUnarchived }),
            ...(this.#requestApproval === undefined
              ? {}
              : { requestApproval: this.#requestApproval }),
          },
        );
        void turn.done.catch(() => undefined);
        if (!this.#closed)
          this.#send({
            id: message.id,
            result: { turnId: turn.id, mode: turn.mode },
          });
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
                      "Host wakeup outcome is unconfirmed. Read the Thread or retry the same client ID before sending another wakeup.",
                  },
          });
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
        const input = await prepareNativeInput(params.input, this.#appServer);
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
        if (params.mode === "queue" || params.mode === "batch-next") {
          result = {
            admission: await this.#appServer.queueMessage(
              params.threadId,
              input,
              options.clientId,
              {
                ...options,
                waitForTurnAdmission: false,
                ...(params.mode === "batch-next"
                  ? { deliveryMode: "batch-next" as const }
                  : {}),
              },
            ),
          };
        } else if (params.mode === "start") {
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
            code:
              error instanceof ThreadJournalAppendOutcomeUnknownError
                ? -32603
                : -32602,
            message:
              error instanceof ThreadJournalAppendOutcomeUnknownError
                ? "Input admission outcome is unconfirmed. Read the Thread before retrying."
                : error instanceof Error
                  ? error.message
                  : String(error),
            ...(error instanceof ThreadJournalAppendOutcomeUnknownError
              ? { data: { zenCode: "admission_outcome_unknown" } }
              : error instanceof AppServerError
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
        result: {
          processEpoch: this.#projection.processEpoch,
          capabilities:
            this.#appServer === undefined
              ? []
              : [
                  NATIVE_QUEUED_INPUT_ADMISSION_CAPABILITY,
                  NATIVE_INLINE_IMAGE_INPUT_CAPABILITY,
                ],
        },
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
      if (
        buffered.some(
          (entry) =>
            entry.event.type === "thread_deleted_updated" &&
            entry.event.deleted,
        )
      )
        throw new AppServerError(
          "thread_deleted",
          "Thread was deleted during resume; refresh before opening it",
        );
      this.#send({ id: message.id, result: snapshot });
      for (const event of buffered) {
        if (
          event.event.type !== "thread_deleted_updated" &&
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
      // A failed resume must still deliver lifecycle discovery to this client.
      if (!this.#closed)
        for (const event of buffered)
          if (event.event.type === "thread_deleted_updated")
            this.#sendEvent(event);
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
