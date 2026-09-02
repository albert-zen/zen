import { type MessagePort, workerData } from "node:worker_threads";

interface WorkerInput {
  code: string;
  maxTextBytes: number;
  port: MessagePort;
}

type HostMessage =
  | {
      type: "tool_result";
      requestId: string;
      result: unknown;
    }
  | {
      type: "tool_error";
      requestId: string;
      code: string;
      message: string;
    };

type WorkerMessage =
  | {
      type: "tool_call";
      requestId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: "completed"; text: string; unawaitedRequestIds: string[] }
  | { type: "failed"; code: string; message: string };

const input = workerData as WorkerInput;
const port = input.port;
delete (input as Partial<WorkerInput>).port;
const pending = new Map<
  string,
  {
    observed: boolean;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();
const requests = new Map<string, { observed: boolean }>();
const textParts: string[] = [];
let textBytes = 0;
let sequence = 0;

class WorkerExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

port.on("message", (encoded: unknown) => {
  try {
    if (typeof encoded !== "string") {
      throw new Error("Host message must be JSON text");
    }
    const message = parsePlainJson(encoded) as HostMessage;
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    pending.delete(message.requestId);
    if (message.type === "tool_result") {
      request.resolve(message.result);
    } else if (message.type === "tool_error") {
      const error = new Error(message.message);
      error.name = message.code;
      request.reject(error);
    } else {
      request.reject(new Error("Unknown host message"));
    }
  } catch (error) {
    send({
      type: "failed",
      code: "INVALID_BRIDGE_MESSAGE",
      message: describeError(error),
    });
  }
});

const tools = new Proxy(Object.create(null) as Record<string, unknown>, {
  get(_target, property) {
    if (typeof property !== "string" || property === "then") return undefined;
    return (arguments_: unknown): PromiseLike<unknown> => {
      const args = clonePlainRecord(arguments_, `tools.${property} arguments`);
      const requestId = `nested-${String(++sequence)}`;
      let resolvePromise!: (value: unknown) => void;
      let rejectPromise!: (error: Error) => void;
      const promise = new Promise<unknown>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      const record = {
        observed: false,
        resolve: resolvePromise,
        reject: rejectPromise,
      };
      pending.set(requestId, record);
      requests.set(requestId, record);
      send({
        type: "tool_call",
        requestId,
        name: property,
        arguments: args,
      });
      const observe = (): void => {
        record.observed = true;
      };
      return {
        then(onFulfilled, onRejected) {
          observe();
          return promise.then(onFulfilled, onRejected);
        },
        catch(onRejected: (reason: unknown) => unknown) {
          observe();
          return promise.catch(onRejected);
        },
        finally(onFinally: () => void) {
          observe();
          return promise.finally(onFinally);
        },
      } as Promise<unknown>;
    };
  },
});

const text = (value: unknown): void => {
  const encoded = encodePlainJson(value, "text value");
  const part = typeof value === "string" ? value : encoded;
  const nextBytes =
    textBytes +
    Buffer.byteLength(part, "utf8") +
    (textParts.length > 0 ? 1 : 0);
  if (nextBytes > input.maxTextBytes) {
    throw new WorkerExecutionError(
      "TEXT_OUTPUT_LIMIT",
      `Explicit text exceeded ${String(input.maxTextBytes)} bytes`,
    );
  }
  textBytes = nextBytes;
  textParts.push(part);
};

void execute();

async function execute(): Promise<void> {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor as new (
      ...args: string[]
    ) => (...values: unknown[]) => Promise<unknown>;
    const body = new AsyncFunction("tools", "text", input.code);
    await body(tools, text);
    const unawaitedRequestIds = [...requests]
      .filter(([, request]) => !request.observed)
      .map(([requestId]) => requestId);
    send({
      type: "completed",
      text: textParts.join("\n"),
      unawaitedRequestIds,
    });
  } catch (error) {
    send({
      type: "failed",
      code:
        error instanceof WorkerExecutionError ? error.code : "EXECUTION_FAILED",
      message: describeError(error),
    });
  }
}

function send(message: WorkerMessage): void {
  port.postMessage(encodePlainJson(message, "Worker message"));
}

function clonePlainRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const cloned = parsePlainJson(encodePlainJson(value, label));
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new Error(`${label} must be an object`);
  }
  return cloned as Record<string, unknown>;
}

function encodePlainJson(value: unknown, label: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${label} is not JSON-compatible`);
  const decoded = JSON.parse(encoded) as unknown;
  if (!sameJsonValue(value, decoded)) {
    throw new Error(`${label} is not lossless JSON`);
  }
  return encoded;
}

function parsePlainJson(encoded: string): unknown {
  return JSON.parse(encoded) as unknown;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => sameJsonValue(entry, right[index]))
    );
  }
  if (
    typeof left === "object" &&
    left !== null &&
    !Array.isArray(left) &&
    typeof right === "object" &&
    right !== null &&
    !Array.isArray(right)
  ) {
    const leftEntries = Object.entries(left);
    const rightRecord = right as Record<string, unknown>;
    return (
      leftEntries.length === Object.keys(rightRecord).length &&
      leftEntries.every(([key, value]) =>
        sameJsonValue(value, rightRecord[key]),
      )
    );
  }
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
