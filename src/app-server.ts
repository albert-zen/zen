import type {
  AppServerNotification,
  AppServerRequest,
  AppServerResponse,
  JsonValue
} from "./app-server-protocol.js";
import {
  ThreadManager,
  type ThreadManagerEvent,
  type ThreadManagerOptions,
  type TurnStartInput
} from "./thread-manager.js";

export type AppServerRequestInput =
  | AppServerRequest
  | {
      readonly method: string;
      readonly params?: unknown;
    };

export type AppServerOptions = {
  readonly threadManagerOptions?: ThreadManagerOptions;
};

export type AppServerSubscription = () => void;

export interface AppServerClient {
  request(request: AppServerRequestInput): Promise<AppServerResponse>;
  subscribe(listener: AppServerNotificationListener): AppServerSubscription;
}

export type AppServerNotificationListener = (
  notification: AppServerNotification
) => void;

export class AppServer implements AppServerClient {
  private readonly threadManager: ThreadManager;

  constructor(options: AppServerOptions = {}) {
    this.threadManager = new ThreadManager(options.threadManagerOptions);
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    return this.threadManager.observe((event) => listener(event));
  }

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    try {
      return await this.dispatch(request);
    } catch (cause) {
      return {
        method: request.method,
        ok: false,
        error: {
          code: "REQUEST_FAILED",
          message: readErrorMessage(cause)
        }
      };
    }
  }

  private async dispatch(
    request: AppServerRequestInput
  ): Promise<AppServerResponse> {
    if (request.method === "thread/start") {
      return {
        method: "thread/start",
        ok: true,
        result: { thread: this.threadManager.startThread() }
      };
    }

    if (request.method === "thread/read") {
      const params = readParams(request.params);
      const threadId = readRequiredString(params, "threadId");

      return {
        method: "thread/read",
        ok: true,
        result: { thread: this.threadManager.readThread(threadId) }
      };
    }

    if (request.method === "turn/start") {
      const params = readParams(request.params);
      const turnInput: TurnStartInput = {
        threadId: readRequiredString(params, "threadId"),
        input: readJsonValue(params.input),
        modelOptions: isJsonObject(params.modelOptions)
          ? params.modelOptions
          : undefined
      };

      return {
        method: "turn/start",
        ok: true,
        result: { turn: await this.threadManager.startTurn(turnInput) }
      };
    }

    if (request.method === "approval/resolve") {
      return {
        method: "approval/resolve",
        ok: false,
        error: {
          code: "UNSUPPORTED_METHOD",
          message: "approval/resolve is not wired to an ApprovalBroker yet"
        }
      };
    }

    return {
      method: request.method,
      ok: false,
      error: {
        code: "UNKNOWN_METHOD",
        message: `Unknown App Server method: ${request.method}`
      }
    };
  }
}

function readParams(params: unknown): Readonly<Record<string, unknown>> {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    return params as Readonly<Record<string, unknown>>;
  }

  throw new Error("Request params must be an object");
}

function readRequiredString(
  params: Readonly<Record<string, unknown>>,
  key: string
): string {
  const value = params[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string param: ${key}`);
  }

  return value;
}

function readJsonValue(value: unknown): JsonValue {
  if (isJsonValue(value)) {
    return value;
  }

  throw new Error("Request input must be JSON-safe");
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonObject(value);
}

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function readErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
