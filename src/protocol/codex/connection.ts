import os from "node:os";
import path from "node:path";

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  AttachmentStoreError,
  decodeImageDataUri,
  type AttachmentRef,
} from "../../attachment.js";
import {
  AppServerError,
  type AppServerEvent,
  type ListedProviderModel,
  type ThreadSnapshot,
  ZenAppServer,
} from "../../app-server.js";
import type {
  ApprovalDecision,
  CanonicalItem,
  ToolCallItem,
  UserInput,
} from "../../item.js";
import type { ApprovalRequest } from "../../tool.js";
import type {
  ProviderSelection,
  ProviderSelectionInput,
} from "../../provider-registry.js";
import {
  projectCommandCompleted,
  projectCommandStarted,
  projectCompletedItem,
  projectThread,
  projectThreadSummary,
  projectTurn,
  threadSettings,
  threadSettingsUpdated,
} from "./mapper.js";
import { decodeModelKey, encodeModelKey } from "./model-key.js";
import {
  isNotification,
  isRecord,
  isRequest,
  isResponse,
  type JsonRpcFailure,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type RequestId,
  type SendJson,
} from "./wire.js";

export interface CodexConnectionOptions {
  appServer: ZenAppServer;
  send: SendJson;
  zenHome: string;
}

export class CodexConnection {
  readonly #appServer: ZenAppServer;
  readonly #send: SendJson;
  readonly #zenHome: string;
  readonly #pending = new Map<
    RequestId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly #toolCalls = new Map<string, ToolCallItem>();
  readonly #reasoningSummaryParts = new Set<string>();
  readonly #subscribedThreads = new Set<string>();
  readonly #unsubscribe: () => void;
  #initializedRequest = false;
  #initializedNotification = false;
  #closed = false;
  #nextServerRequest = 1;
  readonly #acceptedCommandThreads = new Set<string>();
  #eventChain: Promise<void> = Promise.resolve();

  constructor(options: CodexConnectionOptions) {
    this.#appServer = options.appServer;
    this.#send = options.send;
    this.#zenHome = options.zenHome;
    this.#unsubscribe = this.#appServer.subscribe((event) => {
      this.#eventChain = this.#eventChain
        .then(async () => {
          await this.#projectEvent(event);
        })
        .catch((error: unknown) => {
          this.#sendErrorNotification(error, event);
        });
    });
  }

  async receive(message: unknown): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (isResponse(message)) {
      this.#resolveServerRequest(message);
      return;
    }
    if (isNotification(message)) {
      this.#handleNotification(message.method);
      return;
    }
    if (!isRequest(message)) {
      this.#sendFailure(null, -32600, "Invalid Request");
      return;
    }

    if (message.method === "initialize") {
      if (this.#initializedRequest) {
        this.#sendFailure(message.id, -32600, "Already initialized");
        return;
      }
      this.#initializedRequest = true;
      this.#send({
        id: message.id,
        result: {
          userAgent: "zen/0.1.0",
          codexHome: this.#zenHome,
          platformFamily: process.platform === "win32" ? "windows" : "unix",
          platformOs: platformOs(),
        },
      });
      return;
    }

    if (!this.#initializedRequest || !this.#initializedNotification) {
      this.#sendFailure(message.id, -32600, "Not initialized");
      return;
    }

    try {
      await this.#dispatch(message);
    } catch (error) {
      if (error instanceof MethodNotFoundError) {
        this.#sendFailure(message.id, -32601, error.message);
      } else if (error instanceof InvalidParamsError) {
        this.#sendFailure(message.id, -32602, error.message);
      } else if (error instanceof AppServerError) {
        this.#sendFailure(message.id, -32000, error.message, {
          zenCode: error.code,
        });
      } else {
        this.#sendFailure(message.id, -32603, describeError(error));
      }
    }
  }

  close(reason = "Connection closed"): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#unsubscribe();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  async #dispatch(request: JsonRpcRequest): Promise<void> {
    const params = recordParams(request);
    switch (request.method) {
      case "account/read": {
        rejectUnsupportedValues(params, []);
        this.#send({
          id: request.id,
          result: { account: null, requiresOpenaiAuth: false },
        });
        return;
      }
      case "skills/list": {
        const cwds = requiredStringArray(params, "cwds");
        rejectUnsupportedValues(params, ["cwds"]);
        this.#send({
          id: request.id,
          result: {
            data: cwds.map((cwd) => ({ cwd, skills: [], errors: [] })),
          },
        });
        return;
      }
      case "model/list": {
        rejectUnsupportedValues(params, ["cursor"]);
        if (params.cursor !== undefined && params.cursor !== null) {
          throw new InvalidParamsError("model/list cursor is not supported");
        }
        const catalog = this.#appServer.listModels();
        const unavailableDefault = catalog.find(
          (entry) => entry.isDefault && !isCodexModelListRunnable(entry),
        );
        if (unavailableDefault !== undefined) {
          throw new Error(
            `Default model ${unavailableDefault.model.id} from provider profile ${unavailableDefault.providerProfileId} cannot be represented as a runnable codex-cli 0.146.0 model/list entry; configure a manual capability override`,
          );
        }
        const models = catalog.filter(isCodexModelListRunnable);
        this.#send({
          id: request.id,
          result: {
            data: models.map((entry) => ({
              id: encodeModelKey({
                providerProfileId: entry.providerProfileId,
                modelId: entry.model.id,
              }),
              model: encodeModelKey({
                providerProfileId: entry.providerProfileId,
                modelId: entry.model.id,
              }),
              upgrade: null,
              upgradeInfo: null,
              availabilityNux: null,
              displayName: entry.model.displayName ?? entry.model.id,
              description:
                entry.model.description || "Model configured by the Zen host",
              hidden: entry.model.hidden ?? false,
              supportedReasoningEfforts:
                entry.model.supportedReasoningEfforts!.map(
                  (reasoningEffort) => ({
                    reasoningEffort,
                    description: reasoningEffort,
                  }),
                ),
              defaultReasoningEffort: entry.model.defaultReasoningEffort!,
              inputModalities: entry.model.inputModalities!,
              supportsPersonality: false,
              additionalSpeedTiers: [],
              serviceTiers: [],
              defaultServiceTier: null,
              isDefault: entry.isDefault,
            })),
            nextCursor: null,
          },
        });
        return;
      }
      case "thread/start": {
        rejectUnsupportedValues(params, [
          "cwd",
          "model",
          "approvalPolicy",
          "sandbox",
          "approvalsReviewer",
        ]);
        const sandbox = optionalString(params.sandbox);
        const cwd = optionalString(params.cwd);
        const model = optionalNonEmptyString(params.model, "model");
        const approvalPolicy = readApprovalPolicy(params.approvalPolicy);
        readApprovalsReviewer(params.approvalsReviewer);
        if (sandbox !== undefined && sandbox !== "danger-full-access") {
          throw new InvalidParamsError(`Unsupported sandbox mode: ${sandbox}`);
        }
        const snapshot = await this.#appServer.startThread({
          ...(cwd === undefined ? {} : { cwd }),
          ...(model === undefined
            ? {}
            : { selection: this.#selectionForWireModel(model, undefined) }),
          ...(sandbox === undefined
            ? {}
            : { sandbox: "danger-full-access" as const }),
          ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
        });
        this.#subscribedThreads.add(snapshot.id);
        const thread = projectThread(snapshot, { includeTurns: false });
        this.#send({
          id: request.id,
          result: { thread, ...threadSettings(snapshot) },
        });
        this.#send({ method: "thread/started", params: { thread } });
        return;
      }
      case "thread/resume": {
        const threadId = requiredString(params, "threadId");
        let snapshot = await this.#appServer.readThread(threadId);
        const requestedModel = optionalNonEmptyString(params.model, "model");
        const requestedSelectionInput = this.#selectionForExistingThread(
          snapshot,
          requestedModel,
          undefined,
        );
        const requestedSelection =
          requestedSelectionInput === undefined
            ? undefined
            : this.#appServer.completeProviderSelection(
                snapshot,
                requestedSelectionInput,
              );
        validateMatchingThreadConfiguration(
          params,
          snapshot,
          requestedSelection,
          [
            "threadId",
            "cwd",
            "model",
            "approvalPolicy",
            "sandbox",
            "sandboxPolicy",
            "approvalsReviewer",
          ],
        );
        if (requestedSelectionInput !== undefined) {
          snapshot = await this.#appServer.updateThreadSettings(threadId, {
            selection: requestedSelectionInput,
          });
        }
        this.#subscribedThreads.add(threadId);
        this.#send({
          id: request.id,
          result: {
            thread: projectThread(snapshot, { includeTurns: true }),
            ...threadSettings(snapshot),
          },
        });
        return;
      }
      case "thread/name/set": {
        rejectUnsupportedValues(params, ["threadId", "name"]);
        const threadId = requiredString(params, "threadId");
        await this.#appServer.setThreadName(
          threadId,
          requiredString(params, "name"),
        );
        this.#send({ id: request.id, result: {} });
        return;
      }
      case "thread/archive": {
        rejectUnsupportedValues(params, ["threadId"]);
        await this.#appServer.setThreadArchived(
          requiredString(params, "threadId"),
          true,
        );
        this.#send({ id: request.id, result: {} });
        return;
      }
      case "thread/unarchive": {
        rejectUnsupportedValues(params, ["threadId"]);
        const snapshot = await this.#appServer.setThreadArchived(
          requiredString(params, "threadId"),
          false,
        );
        this.#send({
          id: request.id,
          result: {
            thread: projectThread(snapshot, { includeTurns: false }),
          },
        });
        return;
      }
      case "thread/settings/update": {
        rejectUnsupportedValues(params, ["threadId", "model", "effort"]);
        const threadId = requiredString(params, "threadId");
        const snapshot = await this.#appServer.readThread(threadId);
        const model = requiredString(params, "model");
        const effort = optionalNonEmptyString(params.effort, "effort");
        await this.#appServer.updateThreadSettings(threadId, {
          selection: this.#selectionForWireModel(
            model,
            effort,
            snapshot.providerProfileId,
          ),
        });
        this.#send({ id: request.id, result: {} });
        return;
      }
      case "thread/compact": {
        rejectUnsupportedValues(params, ["threadId"]);
        const result = await this.#appServer.compactThread(
          requiredString(params, "threadId"),
        );
        this.#send({ id: request.id, result });
        return;
      }
      case "thread/read": {
        const snapshot = await this.#appServer.readThread(
          requiredString(params, "threadId"),
        );
        const includeTurns = params.includeTurns === true;
        this.#send({
          id: request.id,
          result: {
            thread: projectThread(snapshot, { includeTurns }),
          },
        });
        return;
      }
      case "thread/list": {
        rejectUnsupportedValues(params, ["archived", "cursor", "limit"]);
        const archived = optionalBoolean(params.archived, "archived") ?? false;
        const requestedCursor = optionalNonEmptyString(params.cursor, "cursor");
        const decodedCursor =
          requestedCursor === undefined
            ? undefined
            : decodeThreadListCursor(requestedCursor);
        const summaries = await this.#appServer.listThreadSummaries({
          archived,
        });
        const limit = optionalListLimit(params.limit, summaries.length);
        const snapshotIds = summaries.map((summary) => summary.threadId);
        const cursor =
          decodedCursor === undefined
            ? {
                version: 1 as const,
                archived,
                offset: 0,
                threadIds: snapshotIds,
              }
            : decodedCursor;
        if (cursor.archived !== archived) {
          throw new InvalidParamsError(
            "thread/list cursor does not match the requested archived filter",
          );
        }
        if (!sameStrings(cursor.threadIds, snapshotIds)) {
          throw new InvalidParamsError(
            "thread/list cursor expired because the filtered Thread snapshot changed",
          );
        }
        const page = summaries.slice(cursor.offset, cursor.offset + limit);
        const nextOffset = cursor.offset + page.length;
        this.#send({
          id: request.id,
          result: {
            data: page.map(projectThreadSummary),
            nextCursor:
              limit > 0 && nextOffset < summaries.length
                ? encodeThreadListCursor({ ...cursor, offset: nextOffset })
                : null,
            backwardsCursor: null,
          },
        });
        return;
      }
      case "thread/unsubscribe": {
        const removed = this.#subscribedThreads.delete(
          requiredString(params, "threadId"),
        );
        this.#send({
          id: request.id,
          result: { status: removed ? "unsubscribed" : "notSubscribed" },
        });
        return;
      }
      case "turn/start": {
        const threadId = requiredString(params, "threadId");
        const snapshot = await this.#appServer.readThread(threadId);
        const requestedModel = optionalNonEmptyString(params.model, "model");
        const requestedEffort = optionalNonEmptyString(params.effort, "effort");
        const requestedSelectionInput = this.#selectionForExistingThread(
          snapshot,
          requestedModel,
          requestedEffort,
        );
        const requestedSelection =
          requestedSelectionInput === undefined
            ? undefined
            : this.#appServer.completeProviderSelection(
                snapshot,
                requestedSelectionInput,
              );
        validateMatchingThreadConfiguration(
          params,
          snapshot,
          requestedSelection,
          [
            "threadId",
            "input",
            "cwd",
            "model",
            "approvalPolicy",
            "sandbox",
            "sandboxPolicy",
            "approvalsReviewer",
            "collaborationMode",
            "clientUserMessageId",
            "effort",
          ],
        );
        const input = await readUserInput(params.input, this.#appServer);
        const clientId = optionalNonEmptyString(
          params.clientUserMessageId,
          "clientUserMessageId",
        );
        this.#subscribedThreads.add(threadId);
        const handle = await this.#appServer.startTurn(threadId, input, {
          ...(clientId === undefined ? {} : { clientId }),
          ...(requestedSelectionInput === undefined
            ? {}
            : { selection: requestedSelectionInput }),
          requestApproval: async (approval) =>
            await this.#requestApproval(approval),
        });
        const now = Math.floor(Date.now() / 1000);
        this.#send({
          id: request.id,
          result: {
            turn: {
              id: handle.id,
              items: [],
              itemsView: "full",
              status: "inProgress",
              error: null,
              startedAt: now,
              completedAt: null,
              durationMs: null,
            },
          },
        });
        void handle.done.catch((error: unknown) => {
          this.#sendTurnExecutionFailure(threadId, handle.id, error);
        });
        return;
      }
      case "turn/steer": {
        rejectUnsupportedValues(params, [
          "threadId",
          "expectedTurnId",
          "input",
          "clientUserMessageId",
        ]);
        const threadId = requiredString(params, "threadId");
        const expectedTurnId = requiredString(params, "expectedTurnId");
        const input = await readUserInput(params.input, this.#appServer);
        const clientId = optionalNonEmptyString(
          params.clientUserMessageId,
          "clientUserMessageId",
        );
        this.#subscribedThreads.add(threadId);
        const handle = await this.#appServer.steerTurn(
          threadId,
          expectedTurnId,
          input,
          clientId === undefined ? {} : { clientId },
        );
        this.#send({ id: request.id, result: { turnId: handle.id } });
        return;
      }
      case "turn/replace": {
        rejectUnsupportedValues(params, [
          "threadId",
          "expectedTurnId",
          "input",
          "clientUserMessageId",
        ]);
        const threadId = requiredString(params, "threadId");
        const expectedTurnId = requiredString(params, "expectedTurnId");
        const input = await readUserInput(params.input, this.#appServer);
        const clientId = requiredString(params, "clientUserMessageId");
        this.#subscribedThreads.add(threadId);
        const replacement = await this.#appServer.replaceTurn(
          threadId,
          expectedTurnId,
          input,
          {
            clientId,
            requestApproval: async (approval) =>
              await this.#requestApproval(approval),
          },
        );
        this.#send({
          id: request.id,
          result: {
            interruptedTurnId: replacement.interruptedTurnId,
            turnId: replacement.turn.id,
          },
        });
        void replacement.turn.done.catch((error: unknown) => {
          this.#sendTurnExecutionFailure(threadId, replacement.turn.id, error);
        });
        return;
      }
      case "turn/interrupt": {
        await this.#appServer.interruptTurn(
          requiredString(params, "threadId"),
          requiredString(params, "turnId"),
        );
        this.#send({ id: request.id, result: {} });
        return;
      }
      default:
        throw new MethodNotFoundError(request.method);
    }
  }

  #handleNotification(method: string): void {
    if (method === "initialized" && this.#initializedRequest) {
      this.#initializedNotification = true;
    }
  }

  #selectionForExistingThread(
    snapshot: ThreadSnapshot,
    model: string | undefined,
    effort: string | undefined,
  ): ProviderSelectionInput | undefined {
    if (model === undefined) {
      return effort === undefined
        ? undefined
        : {
            providerProfileId: snapshot.providerProfileId,
            modelId: snapshot.modelId,
            reasoningEffort: effort,
          };
    }
    return this.#selectionForWireModel(
      model,
      effort,
      snapshot.providerProfileId,
    );
  }

  #selectionForWireModel(
    model: string,
    effort: string | undefined,
    fallbackProviderProfileId?: string,
  ): ProviderSelectionInput {
    let identity: ReturnType<typeof decodeModelKey>;
    if (model.startsWith("zen-model-v1:")) {
      try {
        identity = decodeModelKey(model);
      } catch (error) {
        throw new InvalidParamsError(describeError(error));
      }
    } else {
      const matches = this.#appServer
        .listModels()
        .filter((entry) => entry.model.id === model);
      if (matches.length > 1) {
        throw new InvalidParamsError(
          `Model id ${model} is ambiguous; use the opaque key from model/list`,
        );
      }
      const matched = matches[0];
      identity = {
        providerProfileId:
          matched?.providerProfileId ??
          fallbackProviderProfileId ??
          this.#appServer.listModels().find((entry) => entry.isDefault)
            ?.providerProfileId ??
          "",
        modelId: model,
      };
    }
    return {
      ...identity,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
  }

  async #projectEvent(event: AppServerEvent): Promise<void> {
    if (event.type === "thread_archived_updated") {
      this.#send({
        method: event.archived ? "thread/archived" : "thread/unarchived",
        params: { threadId: event.threadId },
      });
      return;
    }
    if (event.type === "thread_name_updated") {
      if (this.#subscribedThreads.has(event.threadId)) {
        this.#send({
          method: "thread/name/updated",
          params: {
            threadId: event.threadId,
            threadName: event.name,
          },
        });
      }
      return;
    }
    if (event.type === "thread_settings_updated") {
      if (this.#subscribedThreads.has(event.threadId)) {
        this.#send({
          method: "thread/settings/updated",
          params: {
            threadId: event.threadId,
            threadSettings: threadSettingsUpdated(event.settings),
          },
        });
      }
      return;
    }
    const eventThreadId =
      event.type === "item_completed" ? event.item.threadId : event.threadId;
    if (!this.#subscribedThreads.has(eventThreadId)) {
      return;
    }
    if (event.type === "turn_started") {
      this.#send({
        method: "turn/started",
        params: {
          threadId: event.threadId,
          turn: {
            id: event.turnId,
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: Math.floor(Date.now() / 1000),
            completedAt: null,
            durationMs: null,
          },
        },
      });
      return;
    }
    if (event.type === "item_started") {
      if (event.itemType === "agent_message") {
        this.#send({
          method: "item/started",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            item: {
              type: "agentMessage",
              id: event.itemId,
              text: "",
              phase: "final_answer",
              memoryCitation: null,
            },
            startedAtMs: Date.now(),
          },
        });
      } else if (event.itemType === "reasoning") {
        this.#send({
          method: "item/started",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            item: {
              type: "reasoning",
              id: event.itemId,
              summary: [],
              content: [],
            },
            startedAtMs: Date.now(),
          },
        });
      }
      return;
    }
    if (event.type === "item_delta") {
      this.#send({
        method: "item/agentMessage/delta",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
        },
      });
      return;
    }
    if (event.type === "reasoning_summary_delta") {
      const key = reasoningItemKey(event.threadId, event.turnId, event.itemId);
      if (!this.#reasoningSummaryParts.has(key)) {
        this.#reasoningSummaryParts.add(key);
        this.#send({
          method: "item/reasoning/summaryPartAdded",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            summaryIndex: 0,
          },
        });
      }
      this.#send({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
          summaryIndex: 0,
        },
      });
      return;
    }
    if (event.type === "reasoning_content_delta") {
      this.#send({
        method: "item/reasoning/textDelta",
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
          contentIndex: 0,
        },
      });
      return;
    }
    if (event.type === "token_usage") {
      return;
    }
    if (event.type === "item_completed") {
      if (event.item.type === "reasoning" && event.item.turnId !== undefined) {
        this.#reasoningSummaryParts.delete(
          reasoningItemKey(
            event.item.threadId,
            event.item.turnId,
            event.item.id,
          ),
        );
      }
      await this.#projectCompletedItem(event.item);
      return;
    }

    for (const key of this.#reasoningSummaryParts) {
      if (key.startsWith(`${event.threadId}\u0000${event.turnId}\u0000`)) {
        this.#reasoningSummaryParts.delete(key);
      }
    }
    const snapshot = await this.#appServer.readThread(event.threadId);
    const turn = snapshot.turns.find(
      (candidate) => candidate.id === event.turnId,
    );
    if (turn === undefined) {
      throw new Error(`Completed turn ${event.turnId} disappeared`);
    }
    this.#send({
      method: "turn/completed",
      params: {
        threadId: event.threadId,
        turn: projectTurn(turn, false, snapshot.cwd),
      },
    });
  }

  async #projectCompletedItem(item: CanonicalItem): Promise<void> {
    if (item.turnId === undefined) {
      return;
    }
    if (item.type === "tool_call") {
      this.#toolCalls.set(
        toolCallKey(item.threadId, item.turnId, item.callId),
        item,
      );
      const snapshot = await this.#appServer.readThread(item.threadId);
      this.#send({
        method: "item/started",
        params: {
          threadId: item.threadId,
          turnId: item.turnId,
          item: projectCommandStarted(item, snapshot.cwd),
          startedAtMs: new Date(item.createdAt).getTime(),
        },
      });
      return;
    }
    if (item.type === "tool_result") {
      const key = toolCallKey(item.threadId, item.turnId, item.callId);
      const snapshot = await this.#appServer.readThread(item.threadId);
      const call =
        this.#toolCalls.get(key) ??
        [...snapshot.items]
          .reverse()
          .find(
            (candidate): candidate is ToolCallItem =>
              candidate.type === "tool_call" &&
              candidate.turnId === item.turnId &&
              candidate.callId === item.callId,
          );
      if (call === undefined) {
        throw new Error(`Missing tool call for result ${item.callId}`);
      }
      if (item.output.length > 0) {
        this.#send({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: item.threadId,
            turnId: item.turnId,
            itemId: call.id,
            delta: item.output,
          },
        });
      }
      this.#send({
        method: "item/completed",
        params: {
          threadId: item.threadId,
          turnId: item.turnId,
          item: projectCommandCompleted(call, item, snapshot.cwd),
          completedAtMs: new Date(item.createdAt).getTime(),
        },
      });
      this.#toolCalls.delete(key);
      return;
    }
    if (item.type === "failure") {
      this.#send({
        method: "error",
        params: {
          error: {
            message: item.message,
            codexErrorInfo: null,
            additionalDetails: null,
          },
          willRetry: false,
          threadId: item.threadId,
          turnId: item.turnId,
        },
      });
      return;
    }
    const projected = projectCompletedItem(item);
    if (projected === null) {
      return;
    }
    if (item.type === "user_message") {
      this.#send({
        method: "item/started",
        params: {
          threadId: item.threadId,
          turnId: item.turnId,
          item: projected,
          startedAtMs: new Date(item.createdAt).getTime(),
        },
      });
    }
    this.#send({
      method: "item/completed",
      params: {
        threadId: item.threadId,
        turnId: item.turnId,
        item: projected,
        completedAtMs: new Date(item.createdAt).getTime(),
      },
    });
  }

  async #requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    // The command item must be visible before its approval request, matching Codex.
    await this.#eventChain;
    request.signal.throwIfAborted();
    if (this.#acceptedCommandThreads.has(request.threadId)) {
      return "acceptForSession";
    }
    const requestId = `approval_${String(this.#nextServerRequest++)}`;
    let response: unknown;
    try {
      response = await this.#requestClient(
        requestId,
        {
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: request.threadId,
            turnId: request.turnId,
            itemId: request.itemId,
            startedAtMs: Date.now(),
            environmentId: null,
            reason: null,
            command: request.command,
            ...(request.toolName === undefined
              ? {}
              : { toolName: request.toolName }),
            ...(request.toolArguments === undefined
              ? {}
              : { toolArguments: structuredClone(request.toolArguments) }),
            cwd: request.cwd,
            commandActions: [],
            proposedExecpolicyAmendment: null,
            networkApprovalContext: null,
            proposedNetworkPolicyAmendments: null,
          },
        },
        request.signal,
      );
    } finally {
      this.#send({
        method: "serverRequest/resolved",
        params: { threadId: request.threadId, requestId },
      });
    }
    if (!isRecord(response) || !isApprovalDecision(response.decision)) {
      throw new Error("Client returned an invalid approval decision");
    }
    if (response.decision === "acceptForSession") {
      this.#acceptedCommandThreads.add(request.threadId);
    }
    return response.decision;
  }

  async #requestClient(
    id: RequestId,
    request: { method: string; params: unknown },
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.#pending.has(id)) {
      throw new Error(`Duplicate server request id: ${String(id)}`);
    }
    signal.throwIfAborted();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const abort = (): void => {
      const pending = this.#pending.get(id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(id);
      pending.reject(asError(signal.reason, "Approval was interrupted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.#send({ id, ...request });
      return await promise;
    } finally {
      signal.removeEventListener("abort", abort);
      this.#pending.delete(id);
    }
  }

  #resolveServerRequest(message: {
    id: RequestId;
    result?: unknown;
    error?: unknown;
  }): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.id);
    if ("error" in message && message.error !== undefined) {
      pending.reject(
        new Error(
          `Client rejected server request: ${JSON.stringify(message.error)}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #sendFailure(
    id: RequestId | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const error: JsonRpcFailure["error"] =
      data === undefined ? { code, message } : { code, message, data };
    this.#send({ id, error });
  }

  #sendErrorNotification(error: unknown, event: AppServerEvent): void {
    if (
      event.type === "thread_name_updated" ||
      event.type === "thread_settings_updated" ||
      event.type === "thread_archived_updated"
    ) {
      console.warn(`Could not project ${event.type} notification`, error);
      return;
    }
    const threadId =
      event.type === "item_completed" ? event.item.threadId : event.threadId;
    const turnId =
      event.type === "item_completed" ? event.item.turnId : event.turnId;
    if (turnId === undefined) {
      return;
    }
    this.#send({
      method: "error",
      params: {
        error: {
          message: describeError(error),
          codexErrorInfo: null,
          additionalDetails: null,
        },
        willRetry: false,
        threadId,
        turnId,
      },
    });
  }

  #sendTurnExecutionFailure(
    threadId: string,
    turnId: string,
    error: unknown,
  ): void {
    const message = describeError(error);
    this.#send({
      method: "error",
      params: {
        error: {
          message,
          codexErrorInfo: null,
          additionalDetails: null,
        },
        willRetry: false,
        threadId,
        turnId,
      },
    });
    this.#send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: "full",
          status: "failed",
          error: {
            message,
            codexErrorInfo: null,
            additionalDetails: null,
          },
          startedAt: null,
          completedAt: Math.floor(Date.now() / 1000),
          durationMs: null,
        },
      },
    });
  }
}

function reasoningItemKey(
  threadId: string,
  turnId: string,
  itemId: string,
): string {
  return `${threadId}\u0000${turnId}\u0000${itemId}`;
}

function isCodexModelListRunnable(entry: ListedProviderModel): boolean {
  return (
    entry.model.supportedReasoningEfforts !== null &&
    entry.model.defaultReasoningEffort !== null &&
    entry.model.inputModalities !== null &&
    entry.model.inputModalities.includes("text")
  );
}

class MethodNotFoundError extends Error {
  constructor(method: string) {
    super(`Method not found: ${method}`);
  }
}

class InvalidParamsError extends Error {}

function recordParams(request: JsonRpcRequest): Record<string, unknown> {
  if (request.params === undefined) {
    return {};
  }
  if (!isRecord(request.params)) {
    throw new InvalidParamsError("params must be an object");
  }
  return request.params;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidParamsError(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidParamsError("Expected a string");
  }
  return value;
}

function optionalNonEmptyString(
  value: unknown,
  key: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidParamsError(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new InvalidParamsError(`${key} must be a boolean`);
  }
  return value;
}

interface ThreadListCursor {
  version: 1;
  archived: boolean;
  offset: number;
  threadIds: string[];
}

function optionalListLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 0xffff_ffff
  ) {
    throw new InvalidParamsError("limit must be an unsigned 32-bit integer");
  }
  return value as number;
}

function encodeThreadListCursor(cursor: ThreadListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeThreadListCursor(value: string): ThreadListCursor {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new InvalidParamsError("Invalid thread/list cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new InvalidParamsError("Invalid thread/list cursor");
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.archived !== "boolean" ||
    !Number.isInteger(parsed.offset) ||
    (parsed.offset as number) < 0 ||
    !Array.isArray(parsed.threadIds) ||
    parsed.threadIds.some(
      (threadId) => typeof threadId !== "string" || threadId.length === 0,
    ) ||
    (parsed.offset as number) > parsed.threadIds.length
  ) {
    throw new InvalidParamsError("Invalid thread/list cursor");
  }
  return {
    version: 1,
    archived: parsed.archived,
    offset: parsed.offset as number,
    threadIds: parsed.threadIds as string[],
  };
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requiredStringArray(
  params: Record<string, unknown>,
  key: string,
): string[] {
  const value = params[key];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new InvalidParamsError(
      `${key} must be an array of non-empty strings`,
    );
  }
  return value;
}

function readApprovalPolicy(value: unknown): "always" | "never" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "never") {
    return "never";
  }
  if (value === "on-request") {
    return "always";
  }
  throw new InvalidParamsError(`Unsupported approval policy: ${String(value)}`);
}

function readApprovalsReviewer(value: unknown): "user" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "user") {
    return "user";
  }
  throw new InvalidParamsError(
    `Unsupported approvals reviewer: ${String(value)}`,
  );
}

function readSandboxPolicy(value: unknown): "danger-full-access" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.type !== "dangerFullAccess" ||
    Object.keys(value).some((key) => key !== "type")
  ) {
    throw new InvalidParamsError(
      "Unsupported sandbox policy; Zen currently supports dangerFullAccess only",
    );
  }
  return "danger-full-access";
}

async function readUserInput(
  value: unknown,
  appServer: ZenAppServer,
): Promise<UserInput> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidParamsError("input must be a non-empty array");
  }
  const inputParts: UserInput[number][] = [];
  for (const input of value) {
    if (!isRecord(input)) {
      throw new InvalidParamsError("input contains an invalid item");
    }
    if (input.type === "text" && typeof input.text === "string") {
      inputParts.push({ type: "text", text: input.text });
      continue;
    }
    if (input.type === "localImage" && typeof input.path === "string") {
      inputParts.push({
        type: "image",
        attachment: await appServer.importLocalImage(input.path),
      });
      continue;
    }
    if (input.type === "image" && typeof input.url === "string") {
      let decoded: ReturnType<typeof decodeImageDataUri>;
      try {
        decoded = decodeImageDataUri(input.url);
      } catch (error) {
        if (error instanceof AttachmentStoreError) {
          throw new AppServerError(error.code, error.message);
        }
        throw error;
      }
      inputParts.push({
        type: "image",
        attachment: await appServer.importImageBytes(
          decoded.bytes,
          decoded.mediaType,
        ),
      });
      continue;
    }
    if (input.type === "attachment" && isAttachmentRef(input.attachment)) {
      inputParts.push({ type: "image", attachment: input.attachment });
      continue;
    }
    throw new InvalidParamsError(
      "Zen supports text, localImage, base64 data-URI, and AttachmentRef image input",
    );
  }
  return inputParts;
}

function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const ref = value as Record<string, unknown>;
  return (
    ref.type === "attachment" &&
    typeof ref.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(ref.sha256) &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      String(ref.mediaType),
    ) &&
    Number.isSafeInteger(ref.byteLength) &&
    Number.isSafeInteger(ref.width) &&
    Number.isSafeInteger(ref.height) &&
    Number(ref.byteLength) > 0 &&
    Number(ref.byteLength) <= MAX_IMAGE_BYTES &&
    Number(ref.width) > 0 &&
    Number(ref.width) <= MAX_IMAGE_DIMENSION &&
    Number(ref.height) > 0 &&
    Number(ref.height) <= MAX_IMAGE_DIMENSION &&
    Number(ref.width) * Number(ref.height) <= MAX_IMAGE_PIXELS
  );
}

function validateMatchingThreadConfiguration(
  params: Record<string, unknown>,
  snapshot: ThreadSnapshot,
  requestedSelection: ProviderSelection | undefined,
  supportedKeys: string[],
): void {
  rejectUnsupportedValues(params, supportedKeys);

  const cwd = optionalString(params.cwd);
  if (cwd !== undefined && path.resolve(cwd) !== snapshot.cwd) {
    throw new InvalidParamsError(
      `cwd does not match thread metadata: ${snapshot.cwd}`,
    );
  }

  const approvalPolicy = readApprovalPolicy(params.approvalPolicy);
  if (
    approvalPolicy !== undefined &&
    approvalPolicy !== snapshot.approvalPolicy
  ) {
    throw new InvalidParamsError(
      "approvalPolicy does not match thread metadata",
    );
  }

  const sandbox = optionalString(params.sandbox);
  if (sandbox !== undefined && sandbox !== "danger-full-access") {
    throw new InvalidParamsError(`Unsupported sandbox mode: ${sandbox}`);
  }
  if (sandbox !== undefined && sandbox !== snapshot.sandbox) {
    throw new InvalidParamsError("sandbox does not match thread metadata");
  }

  const sandboxPolicy = readSandboxPolicy(params.sandboxPolicy);
  if (sandboxPolicy !== undefined && sandboxPolicy !== snapshot.sandbox) {
    throw new InvalidParamsError(
      "sandboxPolicy does not match thread metadata",
    );
  }

  readApprovalsReviewer(params.approvalsReviewer);
  readDefaultCollaborationMode(
    params.collaborationMode,
    requestedSelection ?? snapshot,
  );
}

function readDefaultCollaborationMode(
  value: unknown,
  selection: ProviderSelection,
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (
    !isRecord(value) ||
    value.mode !== "default" ||
    !isRecord(value.settings) ||
    Object.keys(value).some((key) => key !== "mode" && key !== "settings") ||
    Object.keys(value.settings).some(
      (key) =>
        key !== "model" &&
        key !== "reasoning_effort" &&
        key !== "developer_instructions",
    ) ||
    (value.settings.model !== encodeModelKey(selection) &&
      value.settings.model !== selection.modelId) ||
    value.settings.reasoning_effort !== selection.reasoningEffort ||
    typeof value.settings.developer_instructions !== "string"
  ) {
    throw new InvalidParamsError(
      "Unsupported collaborationMode; Zen accepts only T3's default envelope for the configured model",
    );
  }
}

function rejectUnsupportedValues(
  params: Record<string, unknown>,
  supportedKeys: string[],
): void {
  const supported = new Set(supportedKeys);
  for (const [key, value] of Object.entries(params)) {
    if (!supported.has(key) && value !== undefined && value !== null) {
      throw new InvalidParamsError(`${key} is not supported`);
    }
  }
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return (
    value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel"
  );
}

function platformOs(): string {
  if (process.platform === "darwin") {
    return "macos";
  }
  if (process.platform === "win32") {
    return "windows";
  }
  return os.platform();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error
    ? value
    : new Error(value === undefined ? fallback : String(value));
}

function toolCallKey(threadId: string, turnId: string, callId: string): string {
  return JSON.stringify([threadId, turnId, callId]);
}
