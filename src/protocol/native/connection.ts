import { normalizeTimeZone } from "../../message-timezone.js";
import { randomUUID } from "node:crypto";
import { traceClock } from "../../trace.js";
import { parseClientSendObservation } from "../../client-observation.js";
import {
  readOriginalThreadHistory,
  type OriginalHistoryOptions,
} from "../../thread-history.js";
import { parseSessionImport, previewSessionImport } from "../session-import.js";
import { resolveModelKey } from "../model-key.js";
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
  NATIVE_THREAD_ORIGINAL_READ_METHOD,
  NATIVE_THREAD_CREATE_CHILD_METHOD,
  NATIVE_THREAD_FORK_METHOD,
  NATIVE_THREAD_CREATE_CHILD_CONFIGURED_METHOD,
  NATIVE_QUEUE_CANCEL_METHOD,
  NATIVE_STEER_RECALL_METHOD,
  type NativeSteerRecallParams,
  NATIVE_QUEUE_EDIT_METHOD,
  NATIVE_QUEUE_STEER_METHOD,
  NATIVE_THREAD_MESSAGE_METHOD,
  NATIVE_TURN_WAKE_METHOD,
  type NativeQueueEditParams,
  NATIVE_TURN_SEND_UNARCHIVED_METHOD,
  NATIVE_TURN_RETRY_METHOD,
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
    const params = isRecord(message.params) ? message.params : {};
    const observed =
      this.#appServer !== undefined &&
      (this.#initialized || this.#isInitialized()) &&
      [
        "zen/turn/send",
        NATIVE_TURN_SEND_UNARCHIVED_METHOD,
        NATIVE_TURN_RETRY_METHOD,
        NATIVE_QUEUE_CANCEL_METHOD,
        NATIVE_STEER_RECALL_METHOD,
        NATIVE_QUEUE_EDIT_METHOD,
        NATIVE_QUEUE_STEER_METHOD,
      ].includes(message.method) &&
      typeof params.threadId === "string" &&
      /^[A-Za-z0-9_-]{1,200}$/u.test(params.threadId);
    if (!observed) return await this.#receive(message, this.#send);
    // Captured before awaiting observation or input preparation. Neither this
    // receipt nor the client clock proves input admission or a human actor.
    const hostReceived = traceClock();
    const requestId = randomUUID();
    const clientObservation = parseClientSendObservation(
      params.clientObservation,
    );
    const facts = {
      requestId,
      operation: message.method,
      source: "native-client",
      clientId:
        typeof params.clientUserMessageId === "string"
          ? params.clientUserMessageId
          : typeof params.clientId === "string"
            ? params.clientId
            : null,
      requestedMode: typeof params.mode === "string" ? params.mode : "auto",
      expectedTurnId:
        typeof params.expectedTurnId === "string"
          ? params.expectedTurnId
          : null,
      clientObservationStatus:
        params.clientObservation === undefined
          ? "unobserved"
          : clientObservation === undefined
            ? "invalid"
            : "client-reported",
      ...(clientObservation === undefined ? {} : { clientObservation }),
    };
    const threadId = params.threadId as string;
    await this.#appServer!.observeTrace({
      threadId,
      type: "client_request_received",
      data: { ...facts, hostReceived },
    });
    let reply: JsonRpcMessage | undefined;
    try {
      await this.#receive(message, (value) => {
        if ("id" in value && value.id === message.id) reply = value;
        this.#send(value);
      });
    } finally {
      const result =
        reply && "result" in reply && isRecord(reply.result)
          ? reply.result
          : undefined;
      const error = reply && "error" in reply ? reply.error : undefined;
      const unknown =
        reply === undefined || (error !== undefined && error.code === -32603);
      await this.#appServer!.observeTrace({
        threadId,
        ...(typeof result?.turnId === "string"
          ? { turnId: result.turnId }
          : {}),
        type: "client_request_finished",
        data: {
          requestId,
          operation: message.method,
          clientId: facts.clientId,
          outcome: unknown ? "unknown" : error ? "rejected" : "accepted",
          // Admission/edit/cancel receipts only. No model or tool completion claim.
          ...(result === undefined ? {} : { result }),
          ...(error === undefined ? {} : { error }),
        },
      });
    }
  }

  async #receive(message: JsonRpcMessage, send: SendJson): Promise<void> {
    if (this.#closed || !isRequest(message)) return;
    if (message.method === "zen/trace/client-activation") {
      const params = isRecord(message.params) ? message.params : {};
      const observation = parseClientSendObservation(params.observation);
      if (
        !this.#appServer ||
        (!this.#initialized && !this.#isInitialized()) ||
        !observation ||
        (params.threadId !== undefined &&
          (typeof params.threadId !== "string" ||
            !/^[A-Za-z0-9_-]{1,200}$/u.test(params.threadId)))
      ) {
        send({
          id: message.id,
          error: {
            code: -32602,
            message: "Valid initialized client observation required",
          },
        });
        return;
      }
      const receipt = await this.#appServer.observeTrace({
        threadId:
          typeof params.threadId === "string"
            ? params.threadId
            : "ui-activations",
        type: "client_send_activated",
        data: { source: "client-reported-ui", clientObservation: observation },
      });
      send({
        id: message.id,
        result: { observed: receipt?.durability === "durable" },
      });
      return;
    }

    if (message.method === NATIVE_TURN_WAKE_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
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
          typeof params.text !== "string" ||
          !["bootstrap", "trigger", "room"].includes(params.source as string) ||
          (params.sourceId !== undefined &&
            typeof params.sourceId !== "string") ||
          (params.mode !== undefined &&
            !["start", "steer", "queue"].includes(params.mode as string)) ||
          (params.expectedTurnId !== undefined &&
            (typeof params.expectedTurnId !== "string" ||
              !params.expectedTurnId.trim())) ||
          (params.requireUnarchived !== undefined &&
            typeof params.requireUnarchived !== "boolean") ||
          Object.keys(params).some(
            (key) =>
              ![
                "threadId",
                "clientId",
                "text",
                "source",
                "sourceId",
                "mode",
                "expectedTurnId",
                "requireUnarchived",
              ].includes(key),
          )
        )
          throw new AppServerError(
            "invalid_request",
            "Invalid Host wakeup input",
          );
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Native Host wakeup is unavailable",
          );
        this.#subscriptions.add(params.threadId);
        const result = await this.#appServer.wakeTurn(
          params.threadId,
          {
            clientId: params.clientId,
            text: params.text,
            source: params.source as "bootstrap" | "trigger" | "room",
            ...(params.sourceId === undefined
              ? {}
              : { sourceId: params.sourceId }),
          },
          {
            ...(params.mode === undefined
              ? {}
              : { mode: params.mode as "start" | "steer" | "queue" }),
            ...(params.expectedTurnId === undefined
              ? {}
              : { expectedTurnId: params.expectedTurnId }),
            ...(params.requireUnarchived === undefined
              ? {}
              : { requireUnarchived: params.requireUnarchived }),
            ...(this.#requestApproval === undefined
              ? {}
              : { requestApproval: this.#requestApproval }),
          },
        );
        send({ id: message.id, result });
      } catch (error) {
        send({
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
    if (message.method === NATIVE_THREAD_MESSAGE_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
      try {
        const params = message.params;
        if (
          !this.#appServer ||
          !isRecord(params) ||
          Object.keys(params).some(
            (key) =>
              ![
                "threadId",
                "sourceThreadId",
                "sourceToolCallId",
                "sourceCallId",
                "text",
                "messageType",
              ].includes(key),
          ) ||
          ![
            params.threadId,
            params.sourceThreadId,
            params.sourceToolCallId,
            params.sourceCallId,
            params.text,
          ].every(
            (value) => typeof value === "string" && value.trim().length > 0,
          ) ||
          (params.messageType !== undefined &&
            !["guidance", "follow_up", "replacement"].includes(
              String(params.messageType),
            ))
        )
          throw new AppServerError(
            "invalid_request",
            "Thread message requires Host-captured source identity, target and text",
          );
        this.#subscriptions.add(params.threadId as string);
        const result = await this.#appServer.sendThreadMessage(
          params.threadId as string,
          {
            sender: {
              threadId: params.sourceThreadId as string,
              toolCallId: params.sourceToolCallId as string,
              callId: params.sourceCallId as string,
            },
            text: params.text as string,
            ...(params.messageType === undefined
              ? {}
              : {
                  messageType: params.messageType as
                    "guidance" | "follow_up" | "replacement",
                }),
          },
          this.#requestApproval === undefined
            ? {}
            : { requestApproval: this.#requestApproval },
        );
        send({ id: message.id, result });
      } catch (error) {
        send({
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
    if (
      message.method === "zen/thread/import/preview" ||
      message.method === "zen/thread/import"
    ) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
      try {
        const params = message.params;
        if (
          !isRecord(params) ||
          typeof params.format !== "string" ||
          typeof params.contents !== "string"
        )
          throw new AppServerError(
            "invalid_import",
            "Import format and selected file contents are required",
          );
        const history = parseSessionImport({
          format: params.format,
          contents: params.contents,
        });
        let result: unknown;
        if (message.method === "zen/thread/import/preview")
          result = previewSessionImport(history);
        else {
          const config = params.configuration;
          if (
            params.expectedSha256 !== history.source.sha256 ||
            !isRecord(config) ||
            typeof config.cwd !== "string" ||
            Object.keys(config).some(
              (key) => !["cwd", "sandbox", "selection"].includes(key),
            ) ||
            (config.sandbox !== undefined &&
              !["read-only", "workspace-write", "danger-full-access"].includes(
                String(config.sandbox),
              ))
          )
            throw new AppServerError(
              "invalid_import",
              "Review the exact file and choose a valid local working directory and permissions",
            );
          if (
            config.selection !== undefined &&
            (!isRecord(config.selection) ||
              typeof config.selection.providerProfileId !== "string" ||
              typeof config.selection.modelId !== "string" ||
              (config.selection.reasoningEffort !== undefined &&
                config.selection.reasoningEffort !== null &&
                typeof config.selection.reasoningEffort !== "string"))
          )
            throw new AppServerError(
              "invalid_import",
              "Invalid local provider selection",
            );
          if (!this.#appServer)
            throw new AppServerError("unavailable", "Import is unavailable");
          result = await this.#appServer.importThread(history, {
            cwd: config.cwd,
            ...(config.sandbox === undefined
              ? {}
              : {
                  sandbox: config.sandbox as
                    "read-only" | "workspace-write" | "danger-full-access",
                }),
            ...(config.selection === undefined
              ? {}
              : {
                  selection:
                    config.selection as unknown as import("../../provider-registry.js").ProviderSelectionInput,
                }),
          });
        }
        if (!this.#closed) send({ id: message.id, result });
      } catch (error) {
        if (!this.#closed)
          send({
            id: message.id,
            error: {
              code: -32602,
              message: error instanceof Error ? error.message : String(error),
              data: {
                zenCode:
                  error instanceof AppServerError
                    ? error.code
                    : "invalid_import",
              },
            },
          });
      }
      return;
    }
    if (
      message.method === NATIVE_THREAD_DELETE_METHOD ||
      message.method === NATIVE_THREAD_DELETED_LIST_METHOD ||
      message.method === NATIVE_THREAD_RESTORE_METHOD
    ) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
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
        if (!this.#closed) send({ id: message.id, result });
      } catch (error) {
        if (!this.#closed)
          send({
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
    if (message.method === NATIVE_THREAD_FORK_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
      try {
        const params = message.params;
        if (
          !isRecord(params) ||
          Object.keys(params).some(
            (key) => !["sourceThreadId", "through", "workspace"].includes(key),
          ) ||
          typeof params.sourceThreadId !== "string" ||
          !params.sourceThreadId.trim() ||
          params.sourceThreadId.length > 512 ||
          !isRecord(params.through) ||
          (params.through.type !== "latest-complete" &&
            params.through.type !== "item") ||
          (params.through.type === "item"
            ? Object.keys(params.through).some(
                (key) => key !== "type" && key !== "itemId",
              )
            : Object.keys(params.through).some((key) => key !== "type")) ||
          (params.through.type === "item" &&
            typeof params.through.itemId !== "string") ||
          !isRecord(params.workspace) ||
          params.workspace.type !== "same-directory" ||
          Object.keys(params.workspace).some((key) => key !== "type")
        )
          throw new AppServerError(
            "invalid_request",
            "An exact Thread, copy boundary and same-directory workspace are required",
          );
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Native Thread copies are unavailable",
          );
        const through =
          params.through.type === "latest-complete"
            ? { type: "latest-complete" as const }
            : {
                type: "item" as const,
                itemId: params.through.itemId as string,
              };
        const thread = await this.#appServer.forkThread({
          sourceThreadId: params.sourceThreadId,
          through,
          workspace: { type: "same-directory" },
        });
        if (!this.#closed) send({ id: message.id, result: { thread } });
      } catch (error) {
        if (!this.#closed)
          send({
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
    if (
      message.method === NATIVE_THREAD_CREATE_CHILD_METHOD ||
      message.method === NATIVE_THREAD_CREATE_CHILD_CONFIGURED_METHOD
    ) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
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
          if (
            !["parentThreadId", "mode", "model", "effort", "snapshot"].includes(
              key,
            )
          )
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
          ...(params.snapshot === undefined
            ? {}
            : {
                snapshot:
                  params.snapshot as import("../../app-server.js").CreateChildThreadInput["snapshot"] & {},
              }),
          ...(selection === undefined
            ? params.effort === undefined
              ? {}
              : { reasoningEffort: params.effort as string }
            : { selection }),
        });
        if (!this.#closed) send({ id: message.id, result: { thread } });
      } catch (error) {
        if (!this.#closed)
          send({
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
    if (message.method === NATIVE_QUEUE_STEER_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
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
          typeof params.queuedItemId !== "string" ||
          typeof params.clientId !== "string" ||
          typeof params.expectedRevision !== "number"
        )
          throw new AppServerError(
            "invalid_request",
            "Thread, queue identity and expected revision are required",
          );
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Native queue steering is unavailable",
          );
        this.#subscriptions.add(params.threadId);
        const result = await this.#appServer.steerQueuedMessage(
          params.threadId,
          {
            queuedItemId: params.queuedItemId,
            clientId: params.clientId,
            expectedRevision: params.expectedRevision,
          },
          this.#requestApproval === undefined
            ? {}
            : { requestApproval: this.#requestApproval },
        );
        if (!this.#closed) send({ id: message.id, result });
      } catch (error) {
        if (!this.#closed)
          send({
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
                      "Queue steering outcome is unconfirmed. Read the Thread before retrying the same queued identity.",
                  },
          });
      }
      return;
    }
    if (message.method === NATIVE_QUEUE_EDIT_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
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
        if (!this.#closed) send({ id: message.id, result });
      } catch (error) {
        if (!this.#closed)
          send({
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
    if (message.method === NATIVE_STEER_RECALL_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
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
          typeof params.recallId !== "string" ||
          !Array.isArray(params.targets)
        )
          throw new AppServerError(
            "invalid_request",
            "Thread, recall ID and exact pending snapshot are required",
          );
        if (this.#appServer === undefined)
          throw new AppServerError(
            "unavailable",
            "Steer recall is unavailable",
          );
        const request = params as unknown as NativeSteerRecallParams;
        this.#subscriptions.add(request.threadId);
        const result = await this.#appServer.recallSteerMessages(
          request.threadId,
          request,
        );
        if (!this.#closed) send({ id: message.id, result });
      } catch (error) {
        if (!this.#closed)
          send({
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
                      "Steer recall outcome is unconfirmed. Read the Thread and exact recall ID; do not automatically replay.",
                  },
          });
      }
      return;
    }
    if (message.method === NATIVE_QUEUE_CANCEL_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
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
        send({ id: message.id, result: { results } });
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
        send({ id: message.id, error: reason });
      }
      return;
    }
    if (message.method === NATIVE_TURN_RETRY_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
      try {
        const params = message.params;
        if (
          this.#appServer === undefined ||
          !isRecord(params) ||
          typeof params.threadId !== "string" ||
          !params.threadId ||
          typeof params.expectedTurnId !== "string" ||
          !params.expectedTurnId ||
          typeof params.clientUserMessageId !== "string" ||
          !params.clientUserMessageId ||
          (params.language !== "zh-CN" && params.language !== "en") ||
          Object.keys(params).some(
            (key) =>
              ![
                "threadId",
                "expectedTurnId",
                "clientUserMessageId",
                "language",
                "clientObservation",
                "clientTimezone",
              ].includes(key),
          )
        )
          throw new AppServerError(
            "invalid_request",
            "Retry requires exact thread, terminal Turn, client message identity and language",
          );
        const clientTimezone = normalizeTimeZone(params.clientTimezone);
        const turn = await this.#appServer.retryTurn(
          params.threadId,
          params.expectedTurnId,
          params.language,
          {
            clientId: params.clientUserMessageId,
            ...(clientTimezone === undefined ? {} : { clientTimezone }),
            ...(this.#requestApproval === undefined
              ? {}
              : { requestApproval: this.#requestApproval }),
          },
        );
        this.#subscriptions.add(params.threadId);
        void turn.done.catch(() => undefined);
        send({ id: message.id, result: { turnId: turn.id } });
      } catch (error) {
        const unknown = error instanceof ThreadJournalAppendOutcomeUnknownError;
        send({
          id: message.id,
          error: {
            code: unknown ? -32603 : -32602,
            message: unknown
              ? "Input admission outcome is unconfirmed. Read the Thread before retrying."
              : error instanceof Error
                ? error.message
                : String(error),
            ...(unknown
              ? { data: { zenCode: "admission_outcome_unknown" } }
              : error instanceof AppServerError
                ? { data: { zenCode: error.code } }
                : {}),
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
        send({
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
        const clientTimezone = normalizeTimeZone(params.clientTimezone);
        const options = {
          clientId: params.clientUserMessageId,
          ...(clientTimezone === undefined ? {} : { clientTimezone }),
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
        if (params.mode === undefined) {
          const turn = await this.#appServer.sendMessage(
            params.threadId,
            input,
            { ...options, recallableSteer: true },
          );
          result = {
            turnId: turn.id,
            ...(turn.admission === undefined
              ? {}
              : { admission: turn.admission }),
          };
          void turn.done.catch(() => undefined);
        } else if (params.mode === "queue" || params.mode === "batch-next") {
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
            const turn = await this.#appServer.stageSteerMessage(
              params.threadId,
              params.expectedTurnId,
              input,
              options,
            );
            result = {
              turnId: turn.id,
              ...(turn.admission === undefined
                ? {}
                : { admission: turn.admission }),
            };
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
        send({ id: message.id, result });
      } catch (error) {
        send({
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
    if (message.method === NATIVE_THREAD_ORIGINAL_READ_METHOD) {
      if (!this.#initialized && !this.#isInitialized()) {
        send({
          id: message.id,
          error: { code: -32600, message: "Not initialized" },
        });
        return;
      }
      try {
        if (
          !isRecord(message.params) ||
          typeof message.params.threadId !== "string" ||
          !message.params.threadId.trim()
        )
          throw new Error("threadId is required");
        const { threadId, ...options } = message.params;
        const thread = await this.#projection.read(threadId);
        const result = readOriginalThreadHistory(
          thread,
          options as unknown as OriginalHistoryOptions,
        );
        if (!this.#closed) send({ id: message.id, result });
      } catch (error) {
        if (!this.#closed)
          send({
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
      this.#initialized = true;
      this.#nativeSession = true;
      send({
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
      send({
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
      return;
    }
    if (
      !isRecord(message.params) ||
      typeof message.params.threadId !== "string"
    ) {
      send({
        id: message.id,
        error: { code: -32602, message: "threadId is required" },
      });
      return;
    }
    const threadId = message.params.threadId;
    if (message.method === NATIVE_THREAD_READ_METHOD) {
      try {
        const thread = await this.#projection.read(threadId);
        if (!this.#closed) send({ id: message.id, result: { thread } });
      } catch (error) {
        if (!this.#closed)
          send({
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
      send({
        id: message.id,
        error: {
          code: -32600,
          message: "Thread resume is already in progress",
        },
      });
      return;
    }
    const wasSubscribed = this.#subscriptions.has(threadId);
    const processEpoch = this.#projection.processEpoch;
    let resumedWatermark: number | undefined;
    const buffered: NativeProjectedThreadEvent[] = [];
    this.#barriers.set(threadId, buffered);
    this.#subscriptions.add(threadId);
    try {
      const snapshot = await this.#projection.resume(threadId);
      if (this.#closed) return;
      if (this.#barriers.get(threadId) !== buffered)
        throw new Error("Thread subscription changed during resume");
      if (snapshot.processEpoch !== processEpoch)
        throw new Error("Host epoch changed during resume");
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
      send({ id: message.id, result: snapshot });
      resumedWatermark = snapshot.watermark;
    } catch (error) {
      if (!this.#closed) {
        send({
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } finally {
      // Keep the barrier installed while draining, so reentrant observations
      // cannot overtake its tail. Never retire a replacement subscription's gate.
      if (this.#barriers.get(threadId) === buffered) {
        const failed = resumedWatermark === undefined;
        const deleted = buffered.some(
          (entry) =>
            entry.event.type === "thread_deleted_updated" &&
            entry.event.deleted,
        );
        if (failed && !wasSubscribed) this.#subscriptions.delete(threadId);
        try {
          for (const event of buffered) {
            if (this.#closed || this.#barriers.get(threadId) !== buffered)
              break;
            if (event.processEpoch !== processEpoch) continue;
            // Failed snapshots do not replace an existing consumer's live
            // stream. Deletion still fences ordinary replay, while lifecycle
            // discovery remains visible even without a Thread subscription.
            if (
              event.event.type === "thread_deleted_updated" ||
              (this.#subscriptions.has(threadId) &&
                (resumedWatermark === undefined
                  ? wasSubscribed && !deleted
                  : event.watermark > resumedWatermark))
            )
              this.#sendEvent(event);
          }
        } finally {
          if (this.#barriers.get(threadId) === buffered)
            this.#barriers.delete(threadId);
        }
      }
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
