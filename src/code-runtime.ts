import { stripTypeScriptTypes } from "node:module";
import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";

import {
  UnawaitedNestedToolCallError,
  type BuiltinCompositeToolProvider,
  type NestedToolObservation,
  type NestedToolInvocationPort,
  type ToolExecutionResult,
  type ToolInvocation,
} from "./tool.js";
import { createRunCodeModelTool } from "./tool-presentation.js";

export interface CodeRuntimeLimits {
  wallTimeMs: number;
  maxOldGenerationSizeMb: number;
  maxStackSizeMb: number;
  maxTextBytes: number;
  maxToolCalls: number;
}

const DEFAULT_LIMITS: CodeRuntimeLimits = {
  wallTimeMs: 30_000,
  maxOldGenerationSizeMb: 128,
  maxStackSizeMb: 4,
  maxTextBytes: 256 * 1024,
  maxToolCalls: 64,
};

const NESTED_ABORT_SETTLEMENT_GRACE_MS = 350;

export class CodeRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "CodeRuntimeError";
    this.code = code;
  }
}

export class CodeRuntime {
  readonly #limits: CodeRuntimeLimits;
  readonly #workerUrl: URL;

  constructor(options: Partial<CodeRuntimeLimits> & { workerUrl?: URL } = {}) {
    this.#limits = {
      wallTimeMs: positiveInteger(
        options.wallTimeMs,
        DEFAULT_LIMITS.wallTimeMs,
      ),
      maxOldGenerationSizeMb: positiveInteger(
        options.maxOldGenerationSizeMb,
        DEFAULT_LIMITS.maxOldGenerationSizeMb,
      ),
      maxStackSizeMb: positiveInteger(
        options.maxStackSizeMb,
        DEFAULT_LIMITS.maxStackSizeMb,
      ),
      maxTextBytes: positiveInteger(
        options.maxTextBytes,
        DEFAULT_LIMITS.maxTextBytes,
      ),
      maxToolCalls: positiveInteger(
        options.maxToolCalls,
        DEFAULT_LIMITS.maxToolCalls,
      ),
    };
    this.#workerUrl =
      options.workerUrl ?? new URL("./code-runtime-worker.js", import.meta.url);
  }

  async execute(options: {
    code: string;
    signal: AbortSignal;
    nested: NestedToolInvocationPort;
  }): Promise<string> {
    options.signal.throwIfAborted();
    let stripped: string;
    try {
      stripped = stripGuestBody(options.code);
    } catch (error) {
      throw new CodeRuntimeError(
        "TYPESCRIPT_STRIP_FAILED",
        describeError(error),
        {
          cause: error,
        },
      );
    }

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new CodeRuntimeError(
            "WALL_TIME_LIMIT",
            `Code execution exceeded ${String(this.#limits.wallTimeMs)} ms`,
          ),
        ),
      this.#limits.wallTimeMs,
    );

    const channel = new MessageChannel();
    let worker: Worker;
    try {
      worker = new Worker(this.#workerUrl, {
        workerData: {
          code: stripped,
          maxTextBytes: this.#limits.maxTextBytes,
          port: channel.port2,
        },
        transferList: [channel.port2],
        env: {},
        argv: [],
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: this.#limits.maxOldGenerationSizeMb,
          stackSizeMb: this.#limits.maxStackSizeMb,
        },
      });
    } catch (error) {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", forwardAbort);
      channel.port1.close();
      channel.port2.close();
      throw new CodeRuntimeError("WORKER_START_FAILED", describeError(error), {
        cause: error,
      });
    }
    worker.stdout.resume();
    worker.stderr.resume();

    let toolCalls = 0;
    const nestedOperations = new Set<Promise<void>>();
    const nestedRequests = new Map<string, NestedRequest>();
    const rejectedRequestIds = new Set<string>();
    let finalMessage:
      | { type: "completed"; text: string; unawaitedRequestIds: string[] }
      | {
          type: "failed";
          code: string;
          message: string;
          unawaitedRequestIds: string[];
        }
      | undefined;

    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (operation: () => void): void => {
          if (settled) return;
          settled = true;
          operation();
        };
        const abort = (): void => {
          abandonRequests(nestedRequests, controller.signal.reason);
          void worker.terminate();
          void (async () => {
            await settleNestedOperations(nestedOperations);
            finish(() => reject(controller.signal.reason));
          })();
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();

        channel.port1.on("message", (encoded: unknown) => {
          let message: WorkerBridgeMessage;
          try {
            message = decodeWorkerMessage(encoded);
          } catch (error) {
            abandonRequests(nestedRequests, error);
            void worker.terminate();
            finish(() =>
              reject(
                new CodeRuntimeError(
                  "INVALID_BRIDGE_MESSAGE",
                  describeError(error),
                ),
              ),
            );
            return;
          }
          if (message.type === "tool_call") {
            const { requestId, name, arguments: arguments_ } = message;
            if (nestedRequests.has(requestId)) {
              abandonRequests(
                nestedRequests,
                new CodeRuntimeError(
                  "INVALID_BRIDGE_MESSAGE",
                  `Duplicate nested request id: ${requestId}`,
                ),
              );
              void worker.terminate();
              finish(() =>
                reject(
                  new CodeRuntimeError(
                    "INVALID_BRIDGE_MESSAGE",
                    `Duplicate nested request id: ${requestId}`,
                  ),
                ),
              );
              return;
            }
            toolCalls += 1;
            if (toolCalls > this.#limits.maxToolCalls) {
              rejectedRequestIds.add(requestId);
              post(channel.port1, {
                type: "tool_error",
                requestId,
                code: "TOOL_CALL_LIMIT",
                message: `Code execution exceeded ${String(this.#limits.maxToolCalls)} tool calls`,
              });
              return;
            }
            const request: NestedRequest = {
              controller: new AbortController(),
              observation: deferred<NestedToolObservation>(),
              finished: false,
            };
            nestedRequests.set(requestId, request);
            const operation = (async () => {
              try {
                request.controller.signal.throwIfAborted();
                const result = await options.nested.invoke(
                  name,
                  arguments_,
                  request.controller.signal,
                  request.observation.promise,
                );
                post(channel.port1, {
                  type: "tool_result",
                  requestId,
                  result,
                });
              } catch (error) {
                post(channel.port1, {
                  type: "tool_error",
                  requestId,
                  code:
                    error instanceof CodeRuntimeError
                      ? error.code
                      : "TOOL_INVOCATION_FAILED",
                  message: describeError(error),
                });
              }
            })();
            nestedOperations.add(operation);
            void operation.then(
              () => {
                request.finished = true;
                nestedOperations.delete(operation);
              },
              () => {
                request.finished = true;
                nestedOperations.delete(operation);
              },
            );
            return;
          }
          if (message.type === "tool_observed") {
            const request = nestedRequests.get(message.requestId);
            if (request === undefined) {
              if (rejectedRequestIds.has(message.requestId)) return;
              const error = new CodeRuntimeError(
                "INVALID_BRIDGE_MESSAGE",
                `Unknown nested request id: ${message.requestId}`,
              );
              abandonRequests(nestedRequests, error);
              void worker.terminate();
              finish(() => reject(error));
              return;
            }
            request.observation.resolve("observed");
            return;
          }
          if (message.type === "completed" || message.type === "failed") {
            const unawaitedRequestIds = new Set(message.unawaitedRequestIds);
            for (const [requestId, request] of nestedRequests) {
              if (!request.finished) unawaitedRequestIds.add(requestId);
            }
            abandonRequests(
              nestedRequests,
              new UnawaitedNestedToolCallError(),
              unawaitedRequestIds,
            );
            finalMessage = {
              ...message,
              unawaitedRequestIds: [...unawaitedRequestIds],
            };
            void settleAfterNested();
          }
        });

        worker.once("error", (error) => {
          if (controller.signal.aborted) return;
          abandonRequests(nestedRequests, error);
          finish(() =>
            reject(
              new CodeRuntimeError(
                isWorkerOutOfMemory(error) ? "HEAP_LIMIT" : "WORKER_FAILED",
                error.message,
                { cause: error },
              ),
            ),
          );
        });
        worker.once("exit", (code) => {
          if (
            !settled &&
            finalMessage === undefined &&
            !controller.signal.aborted
          ) {
            abandonRequests(
              nestedRequests,
              new CodeRuntimeError(
                "WORKER_EXITED",
                `Code Worker exited before completion with code ${String(code)}`,
              ),
            );
            finish(() =>
              reject(
                new CodeRuntimeError(
                  "WORKER_EXITED",
                  `Code Worker exited before completion with code ${String(code)}`,
                ),
              ),
            );
          }
        });

        const settleAfterNested = async (): Promise<void> => {
          await settleNestedOperations(nestedOperations);
          const message = finalMessage;
          if (message === undefined || settled) return;
          await worker.terminate();
          if (message.unawaitedRequestIds.length > 0) {
            finish(() =>
              reject(
                new CodeRuntimeError(
                  "UNAWAITED_TOOL_CALL",
                  `Code returned with ${String(message.unawaitedRequestIds.length)} unawaited tool call(s)`,
                ),
              ),
            );
            return;
          }
          if (message.type === "failed") {
            finish(() =>
              reject(new CodeRuntimeError(message.code, message.message)),
            );
            return;
          }
          if (
            Buffer.byteLength(message.text, "utf8") > this.#limits.maxTextBytes
          ) {
            finish(() =>
              reject(
                new CodeRuntimeError(
                  "TEXT_OUTPUT_LIMIT",
                  `Explicit text exceeded ${String(this.#limits.maxTextBytes)} bytes`,
                ),
              ),
            );
            return;
          }
          finish(() =>
            resolve(
              message.text.length === 0 ? EMPTY_CODE_OUTPUT : message.text,
            ),
          );
        };
      });
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", forwardAbort);
      channel.port1.close();
      await worker.terminate().catch(() => undefined);
    }
  }
}

export const EMPTY_CODE_OUTPUT = "Code completed without explicit text output.";

export class RunCodeToolProvider implements BuiltinCompositeToolProvider {
  readonly identity = { kind: "builtin", id: "run-code" } as const;
  readonly definitions = [createRunCodeModelTool([])];

  readonly #runtime: CodeRuntime;

  constructor(runtime: CodeRuntime = new CodeRuntime()) {
    this.#runtime = runtime;
  }

  async execute(_invocation: ToolInvocation): Promise<ToolExecutionResult> {
    throw new Error(
      "run_code requires the AgentRuntime nested invocation port",
    );
  }

  async executeComposite(
    invocation: ToolInvocation,
    nested: NestedToolInvocationPort,
  ): Promise<ToolExecutionResult> {
    const keys = Object.keys(invocation.arguments);
    const code = invocation.arguments.code;
    const description = invocation.arguments.description;
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      typeof description !== "string" ||
      description.length === 0 ||
      description.length > 160 ||
      keys.some((key) => key !== "code" && key !== "description")
    ) {
      return {
        output:
          "run_code requires exactly non-empty string code and a 1-160 character description",
        exitCode: 1,
      };
    }
    try {
      return {
        output: await this.#runtime.execute({
          code,
          signal: invocation.signal,
          nested,
        }),
        exitCode: 0,
      };
    } catch (error) {
      if (invocation.signal.aborted) throw error;
      const codeValue =
        error instanceof CodeRuntimeError ? error.code : "EXECUTION_FAILED";
      return {
        output: `run_code failed [${codeValue}]: ${describeError(error)}`,
        exitCode: 1,
      };
    }
  }
}

function stripGuestBody(code: string): string {
  const prefix = "async function __zen_guest__() {\n";
  const suffix = "\n}";
  const stripped = stripTypeScriptTypes(`${prefix}${code}${suffix}`, {
    mode: "strip",
  });
  return stripped.slice(prefix.length, -suffix.length);
}

function post(port: MessagePort, message: unknown): void {
  port.postMessage(JSON.stringify(message));
}

type WorkerBridgeMessage =
  | {
      type: "tool_call";
      requestId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: "tool_observed"; requestId: string }
  | { type: "completed"; text: string; unawaitedRequestIds: string[] }
  | {
      type: "failed";
      code: string;
      message: string;
      unawaitedRequestIds: string[];
    };

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
}

interface NestedRequest {
  controller: AbortController;
  observation: Deferred<NestedToolObservation>;
  finished: boolean;
}

function decodeWorkerMessage(encoded: unknown): WorkerBridgeMessage {
  if (typeof encoded !== "string")
    throw new Error("Worker message must be JSON text");
  const value = JSON.parse(encoded) as unknown;
  const message = requireRecord(value, "Worker message");
  if (message.type === "tool_call") {
    return {
      type: "tool_call",
      requestId: requireString(message.requestId, "requestId"),
      name: requireString(message.name, "tool name"),
      arguments: requireRecord(message.arguments, "tool arguments"),
    };
  }
  if (message.type === "tool_observed") {
    return {
      type: "tool_observed",
      requestId: requireString(message.requestId, "requestId"),
    };
  }
  if (message.type === "completed") {
    if (
      typeof message.text !== "string" ||
      !Array.isArray(message.unawaitedRequestIds) ||
      !message.unawaitedRequestIds.every(
        (requestId) => typeof requestId === "string",
      )
    ) {
      throw new Error("Worker completion message is invalid");
    }
    return {
      type: "completed",
      text: message.text,
      unawaitedRequestIds: message.unawaitedRequestIds,
    };
  }
  if (message.type === "failed") {
    if (
      typeof message.message !== "string" ||
      !Array.isArray(message.unawaitedRequestIds) ||
      !message.unawaitedRequestIds.every(
        (requestId) => typeof requestId === "string",
      )
    ) {
      throw new Error("Worker failure message is invalid");
    }
    return {
      type: "failed",
      code: requireString(message.code, "failure code"),
      message: message.message,
      unawaitedRequestIds: message.unawaitedRequestIds,
    };
  }
  throw new Error("Worker message type is invalid");
}

function deferred<T>(): Deferred<T> {
  let settle!: (value: T) => void;
  let settled = false;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value: T) {
      if (settled) return;
      settled = true;
      settle(value);
    },
  };
}

function abandonRequests(
  requests: ReadonlyMap<string, NestedRequest>,
  reason: unknown,
  only?: ReadonlySet<string>,
): void {
  for (const [requestId, request] of requests) {
    if (only !== undefined && !only.has(requestId)) continue;
    if (!request.observation.settled) {
      request.observation.resolve("unawaited");
    }
    if (!request.controller.signal.aborted) {
      request.controller.abort(reason);
    }
  }
}

async function settleNestedOperations(
  operations: ReadonlySet<Promise<void>>,
): Promise<void> {
  const settled = Promise.allSettled([...operations]).then(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, NESTED_ABORT_SETTLEMENT_GRACE_MS);
  });
  await Promise.race([settled, grace]);
  if (timer !== undefined) clearTimeout(timer);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Code Runtime limits must be positive safe integers");
  }
  return value;
}

function isWorkerOutOfMemory(error: Error): boolean {
  return "code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
