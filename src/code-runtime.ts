import { statSync } from "node:fs";
import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import {
  UnawaitedNestedToolCallError,
  MAX_STRUCTURED_TOOL_RESULT_BYTES,
  type CompositeToolRuntime,
  type NestedToolObservation,
  type NestedToolInvocationPort,
  type ToolExecutionResult,
  type ToolInvocation,
} from "./tool.js";
import type { JsonValue, UserInput } from "./item.js";
import { createRunCodeModelTool } from "./tool-presentation.js";

export interface CodeRuntimeLimits {
  wallTimeMs?: number;
  maxOldGenerationSizeMb: number;
  maxStackSizeMb: number;
  maxTextBytes: number;
  maxToolCalls: number;
  maxStateValueBytes: number;
  maxStateBytes: number;
  maxStateKeys: number;
  maxStateWrites: number;
  maxMediaBytes: number;
}

const DEFAULT_LIMITS: CodeRuntimeLimits = {
  maxOldGenerationSizeMb: 128,
  maxStackSizeMb: 4,
  maxTextBytes: 64 * 1024 * 1024,
  maxToolCalls: 64,
  maxStateValueBytes: 256 * 1024,
  maxStateBytes: 2 * 1024 * 1024,
  maxStateKeys: 128,
  maxStateWrites: 1024,
  maxMediaBytes: 4 * 1024 * 1024,
};

const NESTED_ABORT_SETTLEMENT_GRACE_MS = 350;

export interface CodeMediaDescriptor {
  type: "image" | "audio";
  value: JsonValue;
}
export interface CodeExecutionResult {
  text: string;
  stateWrites: Record<string, JsonValue>;
  media: CodeMediaDescriptor[];
  outputTruncated: boolean;
}
export interface CodeExecutionOptions {
  code: string;
  signal: AbortSignal;
  nested: NestedToolInvocationPort;
  tools?: readonly { name: string; description: string }[];
  storedValues?: Record<string, JsonValue>;
  onOutput?: (text: string) => void;
  onMedia?: (media: CodeMediaDescriptor) => Promise<void>;
  onStore?: (key: string, value: JsonValue) => Promise<void>;
  onYield?: () => void;
}
export class CodeRuntimeError extends Error {
  result?: CodeExecutionResult;
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
      ...(options.wallTimeMs === undefined
        ? {}
        : { wallTimeMs: positiveInteger(options.wallTimeMs, 1) }),
      maxStateValueBytes: positiveInteger(
        options.maxStateValueBytes,
        DEFAULT_LIMITS.maxStateValueBytes,
      ),
      maxStateWrites: positiveInteger(
        options.maxStateWrites,
        DEFAULT_LIMITS.maxStateWrites,
      ),
      maxStateKeys: positiveInteger(
        options.maxStateKeys,
        DEFAULT_LIMITS.maxStateKeys,
      ),
      maxStateBytes: positiveInteger(
        options.maxStateBytes,
        DEFAULT_LIMITS.maxStateBytes,
      ),
      maxMediaBytes: positiveInteger(
        options.maxMediaBytes,
        DEFAULT_LIMITS.maxMediaBytes,
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

  /** Fail before Host startup succeeds when its exact Worker entry is unusable. */
  assertReady(): void {
    try {
      const workerPath = fileURLToPath(this.#workerUrl);
      if (!statSync(workerPath).isFile()) {
        throw new Error("entry is not a regular file");
      }
    } catch (error) {
      throw new CodeRuntimeError(
        "CODE_RUNTIME_INITIALIZATION_FAILED",
        `Code Runtime Worker entry ${this.#workerUrl.href} is unavailable: ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  async execute(options: CodeExecutionOptions): Promise<CodeExecutionResult> {
    options.signal.throwIfAborted();
    const result: CodeExecutionResult = {
      text: "",
      stateWrites: {},
      media: [],
      outputTruncated: false,
    };
    let hostOperations = Promise.resolve();
    let hostFailure = false;
    let textBytes = 0;
    let mediaBytes = 0;
    let stateWrites = 0;
    const storedValues = new Map(Object.entries(options.storedValues ?? {}));

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", forwardAbort, { once: true });
    const timeout =
      this.#limits.wallTimeMs === undefined
        ? undefined
        : setTimeout(
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
          code: options.code,
          tools: options.tools ?? [],
          storedValues: options.storedValues ?? {},
          maxStateValueBytes: this.#limits.maxStateValueBytes,
          maxStateBytes: this.#limits.maxStateBytes,
          maxStateKeys: this.#limits.maxStateKeys,
          maxStateWrites: this.#limits.maxStateWrites,
          maxMediaBytes: this.#limits.maxMediaBytes,
          maxTextBytes: this.#limits.maxTextBytes,
          port: channel.port2,
        },
        transferList: [channel.port2],
        env: {},
        argv: [],
        execArgv: ["--experimental-vm-modules"],
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
      | { type: "completed"; unawaitedRequestIds: string[] }
      | {
          type: "failed";
          code: string;
          message: string;
          unawaitedRequestIds: string[];
        }
      | undefined;

    try {
      return await new Promise<CodeExecutionResult>((resolve, reject) => {
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
            await Promise.all([
              settleNestedOperations(nestedOperations),
              hostOperations,
            ]);
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
          if (settled || controller.signal.aborted) return;
          if (message.type === "text") {
            const available = this.#limits.maxTextBytes - textBytes;
            const delta = utf8Prefix(message.delta, available);
            textBytes += Buffer.byteLength(delta);
            result.text += delta;
            result.outputTruncated ||=
              message.truncated || delta !== message.delta;
            try {
              if (delta) options.onOutput?.(delta);
            } catch (error) {
              controller.abort(error);
            }
            return;
          }
          if (message.type === "media") {
            mediaBytes += Buffer.byteLength(JSON.stringify(message.value));
            if (mediaBytes > this.#limits.maxMediaBytes) {
              controller.abort(
                new CodeRuntimeError(
                  "MEDIA_OUTPUT_LIMIT",
                  "Media descriptors exceed byte limit",
                ),
              );
              return;
            }
            result.media.push({ type: message.kind, value: message.value });
            hostOperations = hostOperations.then(async () => {
              try {
                await options.onMedia?.({
                  type: message.kind,
                  value: message.value,
                });
              } catch (error) {
                controller.abort(
                  new CodeRuntimeError(
                    "MEDIA_COMMIT_FAILED",
                    describeError(error),
                  ),
                );
              }
            });
            return;
          }
          if (message.type === "yield") {
            hostOperations = hostOperations.then(() => {
              try {
                options.onYield?.();
              } catch (error) {
                controller.abort(error);
              }
            });
            return;
          }
          if (message.type === "store") {
            if (++stateWrites > this.#limits.maxStateWrites) {
              controller.abort(
                new CodeRuntimeError(
                  "STATE_WRITE_LIMIT",
                  "Stored state exceeds write limit",
                ),
              );
              return;
            }
            const { key, value } = message;
            storedValues.set(key, value);
            if (
              key.length < 1 ||
              key.length > 160 ||
              Buffer.byteLength(JSON.stringify(value)) >
                this.#limits.maxStateValueBytes ||
              storedValues.size > this.#limits.maxStateKeys ||
              Buffer.byteLength(
                JSON.stringify(Object.fromEntries(storedValues)),
              ) > this.#limits.maxStateBytes
            ) {
              controller.abort(
                new CodeRuntimeError(
                  "STATE_LIMIT",
                  "Stored state exceeds key or byte limit",
                ),
              );
              return;
            }
            hostOperations = hostOperations.then(async () => {
              if (hostFailure) return;
              try {
                await options.onStore?.(key, value);
                Object.defineProperty(result.stateWrites, key, {
                  value,
                  enumerable: true,
                  configurable: true,
                  writable: true,
                });
              } catch (error) {
                hostFailure = true;
                controller.abort(
                  new CodeRuntimeError(
                    "STATE_COMMIT_FAILED",
                    describeError(error),
                    { cause: error },
                  ),
                );
              }
            });
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
          await Promise.all([
            settleNestedOperations(nestedOperations),
            hostOperations,
          ]);
          const message = finalMessage;
          if (message === undefined || settled || controller.signal.aborted)
            return;
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
          finish(() => resolve(result));
        };
      });
    } catch (error) {
      await worker.terminate().catch(() => undefined);
      await Promise.all([
        hostOperations,
        settleNestedOperations(nestedOperations),
      ]);
      const failure =
        error instanceof CodeRuntimeError
          ? error
          : new CodeRuntimeError(
              options.signal.aborted ? "ABORTED" : "EXECUTION_FAILED",
              describeError(error),
              { cause: error },
            );
      failure.result = result;
      throw failure;
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", forwardAbort);
      channel.port1.close();
      await worker.terminate().catch(() => undefined);
    }
  }
}

export const EMPTY_CODE_OUTPUT = "Code completed without explicit text output.";

export class RunCodeToolRuntime implements CompositeToolRuntime {
  readonly name = "run_code";
  readonly taskPolicy = {
    resourceScope: "independent",
    cancellation: "confirmed-on-settle",
  } as const;
  readonly specification = createRunCodeModelTool([]);

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
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      keys.some((key) => key !== "code")
    ) {
      return {
        output: "run_code requires exactly a non-empty string code",
        exitCode: 1,
      };
    }
    const context = nested.codeContext;
    const taskContext = invocation.taskContext;
    let result: CodeExecutionResult;
    let failure: unknown;
    const streamedMedia: UserInput[number][] = [];
    const streamMedia =
      context !== undefined && taskContext?.onModelContent !== undefined;
    try {
      result = await this.#runtime.execute({
        code,
        signal: invocation.signal,
        nested,
        ...(streamMedia
          ? {
              onMedia: async (media: CodeMediaDescriptor) => {
                try {
                  const content = await context.resolveMedia([media]);
                  streamedMedia.push(...content);
                  taskContext.onModelContent!(content);
                } catch (error) {
                  failure ??= error;
                }
              },
            }
          : {}),
        ...(context === undefined
          ? {}
          : {
              tools: context.tools,
              storedValues: context.storedValues,
              onStore: (key: string, value: JsonValue) =>
                context.store(key, value),
            }),
        ...(taskContext === undefined
          ? {}
          : { onOutput: (text: string) => taskContext.onOutput(text) }),
        ...(taskContext?.requestYield === undefined
          ? {}
          : { onYield: () => taskContext.requestYield!() }),
      });
    } catch (error) {
      failure = error;
      result =
        error instanceof CodeRuntimeError && error.result !== undefined
          ? error.result
          : {
              text: "",
              stateWrites: {},
              media: [],
              outputTruncated: false,
            };
    }
    let modelContent: UserInput | undefined = streamMedia
      ? streamedMedia
      : undefined;
    if (
      !streamMedia &&
      context?.resolveMedia !== undefined &&
      result.media.length > 0
    ) {
      const resolved: UserInput[number][] = [];
      for (const media of result.media) {
        try {
          resolved.push(...(await context.resolveMedia([media])));
        } catch (error) {
          failure ??= error;
        }
      }
      modelContent = resolved;
    }
    const structuredContent: Record<string, JsonValue> = {
      media:
        modelContent === undefined
          ? result.media.map(({ type, value }) => ({ type, value }))
          : (JSON.parse(JSON.stringify(modelContent)) as JsonValue),
      outputTruncated: result.outputTruncated,
    };
    if (
      Buffer.byteLength(JSON.stringify(structuredContent)) >
      MAX_STRUCTURED_TOOL_RESULT_BYTES
    ) {
      structuredContent.media = [];
      structuredContent.mediaDescriptorsOmitted = true;
      failure ??= new Error(
        "Unresolved media descriptors exceed the structured result limit; a Host media resolver is required",
      );
    }
    const diagnostic =
      failure === undefined
        ? ""
        : `run_code failed [${failure instanceof CodeRuntimeError ? failure.code : "EXECUTION_FAILED"}]: ${describeError(failure)}`;
    const prefix = taskContext === undefined ? result.text : "";
    return {
      output:
        prefix + (diagnostic ? (result.text ? "\n" : "") + diagnostic : "") ||
        (result.text ? "" : EMPTY_CODE_OUTPUT),
      exitCode: failure === undefined ? 0 : invocation.signal.aborted ? 130 : 1,
      sourceTruncated: result.outputTruncated,
      contentType: "application/json",
      structuredContent,
      ...(streamMedia || modelContent === undefined ? {} : { modelContent }),
    };
  }
}

function post(port: MessagePort, message: unknown): void {
  port.postMessage(JSON.stringify(message));
}

type WorkerBridgeMessage =
  | { type: "text"; delta: string; truncated: boolean }
  | { type: "media"; kind: "image" | "audio"; value: JsonValue }
  | { type: "store"; key: string; value: JsonValue }
  | { type: "yield" }
  | {
      type: "tool_call";
      requestId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: "tool_observed"; requestId: string }
  | { type: "completed"; unawaitedRequestIds: string[] }
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
  if (
    message.type === "text" &&
    typeof message.delta === "string" &&
    typeof message.truncated === "boolean"
  )
    return { type: "text", delta: message.delta, truncated: message.truncated };
  if (
    message.type === "media" &&
    (message.kind === "image" || message.kind === "audio") &&
    message.value !== undefined
  )
    return {
      type: "media",
      kind: message.kind,
      value: message.value as JsonValue,
    };
  if (
    message.type === "store" &&
    typeof message.key === "string" &&
    message.value !== undefined
  )
    return {
      type: "store",
      key: message.key,
      value: message.value as JsonValue,
    };
  if (message.type === "yield") return { type: "yield" };
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
      !Array.isArray(message.unawaitedRequestIds) ||
      !message.unawaitedRequestIds.every(
        (requestId) => typeof requestId === "string",
      )
    ) {
      throw new Error("Worker completion message is invalid");
    }
    return {
      type: "completed",
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

function utf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let prefix = "",
    bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    prefix += char;
    bytes += size;
  }
  return prefix;
}
