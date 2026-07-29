import os from "node:os";

import {
  AppServerError,
  type ThreadSnapshot,
  ZenAppServer,
} from "../../app-server.js";
import type {
  ApprovalDecision,
  CanonicalItem,
  ToolCallItem,
} from "../../item.js";
import type { RuntimeEvent } from "../../runtime.js";
import type { ApprovalRequest } from "../../tool.js";
import {
  projectCommandCompleted,
  projectCommandStarted,
  projectCompletedItem,
  projectThread,
  projectTurn,
  threadSettings,
} from "./mapper.js";
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
  readonly #subscribedThreads = new Set<string>();
  readonly #unsubscribe: () => void;
  #initializedRequest = false;
  #initializedNotification = false;
  #closed = false;
  #nextServerRequest = 1;
  #acceptCommandsForSession = false;
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
      case "thread/start": {
        const sandbox = optionalString(params.sandbox);
        const cwd = optionalString(params.cwd);
        const model = optionalString(params.model);
        const approvalPolicy = readApprovalPolicy(params.approvalPolicy);
        if (sandbox !== undefined && sandbox !== "danger-full-access") {
          throw new InvalidParamsError(`Unsupported sandbox mode: ${sandbox}`);
        }
        const snapshot = await this.#appServer.startThread({
          ...(cwd === undefined ? {} : { cwd }),
          ...(model === undefined ? {} : { model }),
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
        rejectOverrides(params, ["model", "cwd", "approvalPolicy", "sandbox"]);
        const snapshot = await this.#appServer.readThread(threadId);
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
        const snapshots = await this.#appServer.listThreads();
        const limit =
          typeof params.limit === "number" && params.limit >= 0
            ? params.limit
            : snapshots.length;
        this.#send({
          id: request.id,
          result: {
            data: snapshots
              .slice(0, limit)
              .map((snapshot) =>
                projectThread(snapshot, { includeTurns: false }),
              ),
            nextCursor: null,
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
        rejectOverrides(params, [
          "cwd",
          "approvalPolicy",
          "sandboxPolicy",
          "model",
          "serviceTier",
          "effort",
          "summary",
          "personality",
          "outputSchema",
        ]);
        const threadId = requiredString(params, "threadId");
        const text = readTextInput(params.input);
        this.#subscribedThreads.add(threadId);
        const handle = await this.#appServer.startTurn(threadId, text, {
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

  async #projectEvent(event: RuntimeEvent): Promise<void> {
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
    if (event.type === "token_usage") {
      return;
    }
    if (event.type === "item_completed") {
      await this.#projectCompletedItem(event.item);
      return;
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
    if (this.#acceptCommandsForSession) {
      return "accept";
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
      this.#acceptCommandsForSession = true;
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

  #sendErrorNotification(error: unknown, event: RuntimeEvent): void {
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

function readTextInput(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidParamsError("input must be a non-empty array");
  }
  const text: string[] = [];
  for (const input of value) {
    if (
      !isRecord(input) ||
      input.type !== "text" ||
      typeof input.text !== "string"
    ) {
      throw new InvalidParamsError("Zen currently supports text input only");
    }
    text.push(input.text);
  }
  return text.join("\n");
}

function rejectOverrides(
  params: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    if (params[key] !== undefined && params[key] !== null) {
      throw new InvalidParamsError(`${key} overrides are not supported`);
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
