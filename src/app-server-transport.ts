import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerRequestInput,
  AppServerSubscription
} from "./app-server.js";
import type {
  AppServerNotification,
  AppServerResponse
} from "./app-server-protocol.js";
import { assertLoopbackBindAllowed } from "./app-server-config.js";

export type AppServerHttpTransportOptions = {
  readonly allowRemoteBind?: boolean;
  readonly appServer: AppServerClient;
  readonly capability?: string;
  readonly host?: string;
  readonly port?: number;
};

export type AppServerHttpTransport = {
  readonly capability: string;
  readonly url: string;
  close(): Promise<void>;
};

export type HttpAppServerClientOptions = {
  readonly baseUrl: string | URL;
  readonly capability: string;
  readonly onSubscriptionError?: (error: AppServerTransportError) => void;
};

export class AppServerTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "AppServerTransportError";
  }
}

const REQUEST_PATH = "/request";
const EVENTS_PATH = "/events";
const MAX_REQUEST_BODY_BYTES = 1_000_000;
const MIN_CAPABILITY_BYTES = 32;

export function createAppServerHttpProxy(
  target: string,
  capability: string
) {
  const headers = { authorization: `Bearer ${capability}` };

  return {
    [REQUEST_PATH]: {
      target,
      changeOrigin: true as const,
      headers
    },
    [EVENTS_PATH]: {
      target,
      changeOrigin: true as const,
      headers
    }
  };
}

export async function serveAppServerHttpTransport(
  options: AppServerHttpTransportOptions
): Promise<AppServerHttpTransport> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  assertLoopbackBindAllowed(
    host,
    options.allowRemoteBind ?? false,
    "Non-loopback App Server"
  );
  const capability = resolveCapability(options.capability);
  const capabilityDigest = digestCapability(capability);
  const eventStreams = new Map<ServerResponse, AppServerSubscription>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);

    if (
      (url.pathname === REQUEST_PATH || url.pathname === EVENTS_PATH) &&
      !hasCapability(request, capabilityDigest)
    ) {
      sendUnauthorized(response);
      return;
    }

    if (request.method === "POST" && url.pathname === REQUEST_PATH) {
      await handleRequest(options.appServer, request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === EVENTS_PATH) {
      const unsubscribe = handleEventStream(
        options.appServer,
        response,
        (streamResponse) => {
          const streamUnsubscribe = eventStreams.get(streamResponse);
          eventStreams.delete(streamResponse);
          streamUnsubscribe?.();
        }
      );
      eventStreams.set(response, unsubscribe);
      request.on("close", () => {
        eventStreams.delete(response);
        unsubscribe();
      });
      return;
    }

    sendJson(response, 404, {
      method: "transport/request",
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Unknown App Server transport route: ${request.method ?? "GET"} ${url.pathname}`
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    capability,
    url: `http://${formatUrlHost(address.address)}:${address.port}`,
    async close() {
      for (const [streamResponse, unsubscribe] of eventStreams) {
        unsubscribe();
        streamResponse.end();
      }
      eventStreams.clear();

      await new Promise<void>((resolve, reject) => {
        server.close((cause) => {
          if (cause) {
            reject(cause);
            return;
          }

          resolve();
        });
      });
    }
  };
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function resolveCapability(provided: string | undefined): string {
  if (provided === undefined) {
    return randomBytes(MIN_CAPABILITY_BYTES).toString("base64url");
  }

  if (
    Buffer.byteLength(provided, "utf8") < MIN_CAPABILITY_BYTES ||
    /[\u0000-\u0020\u007f]/u.test(provided)
  ) {
    throw new Error(
      "App Server capability must be at least 32 bytes without whitespace or control characters"
    );
  }

  return provided;
}

function hasCapability(
  request: IncomingMessage,
  expectedDigest: Buffer
): boolean {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const candidateDigest = digestCapability(authorization.slice("Bearer ".length));
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function digestCapability(capability: string): Buffer {
  return createHash("sha256").update(capability, "utf8").digest();
}

function sendUnauthorized(response: ServerResponse): void {
  sendJson(response, 401, {
    method: "transport/request",
    ok: false,
    error: {
      code: "UNAUTHORIZED",
      message: "App Server capability is missing or invalid"
    }
  });
}

export class HttpAppServerClient implements AppServerClient {
  private readonly authorization: string;
  private readonly baseUrl: URL;
  private readonly onSubscriptionError?: (error: AppServerTransportError) => void;
  private readonly pendingSubscriptionConnections = new Set<Promise<void>>();

  constructor(options: HttpAppServerClientOptions) {
    this.authorization = `Bearer ${options.capability}`;
    this.baseUrl = new URL(options.baseUrl);
    this.onSubscriptionError = options.onSubscriptionError;
  }

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    await Promise.allSettled(this.pendingSubscriptionConnections);

    const response = await fetch(new URL(REQUEST_PATH, this.baseUrl), {
      method: "POST",
      headers: {
        "accept": "application/json",
        "authorization": this.authorization,
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new AppServerTransportError(
        "HTTP_REQUEST_FAILED",
        `App Server transport request failed with HTTP ${response.status}`,
        await readResponseBody(response)
      );
    }

    return readAppServerResponse(await response.text());
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    const controller = new AbortController();
    const connected = createDeferred<void>();
    const connection = connected.promise.finally(() => {
      this.pendingSubscriptionConnections.delete(connection);
    });

    this.pendingSubscriptionConnections.add(connection);

    void this.consumeEventStream(listener, controller.signal, connected.resolve).finally(
      connected.resolve
    );

    return () => {
      controller.abort();
    };
  }

  private async consumeEventStream(
    listener: AppServerNotificationListener,
    signal: AbortSignal,
    onConnected: () => void
  ): Promise<void> {
    try {
      const response = await fetch(new URL(EVENTS_PATH, this.baseUrl), {
        headers: {
          accept: "text/event-stream",
          authorization: this.authorization
        },
        signal
      });

      if (!response.ok) {
        throw new AppServerTransportError(
          "SSE_CONNECT_FAILED",
          `App Server event stream failed with HTTP ${response.status}`,
          await readResponseBody(response)
        );
      }

      if (!response.body) {
        throw new AppServerTransportError(
          "SSE_BODY_MISSING",
          "App Server event stream response did not include a body"
        );
      }

      onConnected();
      await readServerSentEvents(response.body, listener, signal);
    } catch (cause) {
      if (isAbortError(cause)) {
        return;
      }

      const error =
        cause instanceof AppServerTransportError
          ? cause
          : new AppServerTransportError(
              "SSE_READ_FAILED",
              readErrorMessage(cause),
              cause
            );
      this.onSubscriptionError?.(error);
    }
  }
}

async function handleRequest(
  appServer: AppServerClient,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const parsed = await readRequestJson(request);

  if (!parsed.ok) {
    sendJson(response, parsed.status, {
      method: "transport/request",
      ok: false,
      error: {
        code: parsed.code,
        message: parsed.message
      }
    });
    return;
  }

  try {
    const result = await appServer.request(parsed.value as AppServerRequestInput);

    sendJson(response, 200, result);
  } catch {
    sendJson(response, 500, {
      method: "transport/request",
      ok: false,
      error: {
        code: "UPSTREAM_REQUEST_FAILED",
        message: "App Server request failed"
      }
    });
  }
}

function handleEventStream(
  appServer: AppServerClient,
  response: ServerResponse,
  onClose: (response: ServerResponse) => void
): AppServerSubscription {
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8"
  });
  response.write(": connected\n\n");

  const unsubscribe = appServer.subscribe((notification) => {
    response.write(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
  });

  response.on("close", () => onClose(response));

  return unsubscribe;
}

async function readRequestJson(
  request: IncomingMessage
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
> {
  let body = "";

  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);

    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      return {
        ok: false,
        status: 413,
        code: "REQUEST_TOO_LARGE",
        message: "App Server transport request body is too large"
      };
    }
  }

  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return {
      ok: false,
      status: 400,
      code: "INVALID_JSON",
      message: "App Server transport request body must be valid JSON"
    };
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function readAppServerResponse(body: string): AppServerResponse {
  try {
    const value = JSON.parse(body) as unknown;

    if (
      typeof value === "object" &&
      value !== null &&
      "method" in value &&
      "ok" in value &&
      typeof value.ok === "boolean"
    ) {
      return value as AppServerResponse;
    }
  } catch (cause) {
    throw new AppServerTransportError(
      "INVALID_RESPONSE_JSON",
      "App Server transport response body must be valid JSON",
      cause
    );
  }

  throw new AppServerTransportError(
    "INVALID_RESPONSE",
    "App Server transport response did not match the protocol envelope"
  );
}

async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  listener: AppServerNotificationListener,
  signal: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const result = await reader.read();

      if (result.done) {
        return;
      }

      buffer += decoder.decode(result.value, { stream: true });
      buffer = consumeServerSentEventBuffer(buffer, listener);
    }
  } finally {
    reader.releaseLock();
  }
}

function consumeServerSentEventBuffer(
  buffer: string,
  listener: AppServerNotificationListener
): string {
  let remaining = buffer.replaceAll("\r\n", "\n");
  let separatorIndex = remaining.indexOf("\n\n");

  while (separatorIndex >= 0) {
    const rawEvent = remaining.slice(0, separatorIndex);
    remaining = remaining.slice(separatorIndex + 2);
    separatorIndex = remaining.indexOf("\n\n");

    const data = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");

    if (data.length === 0) {
      continue;
    }

    listener(JSON.parse(data) as AppServerNotification);
  }

  return remaining;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");

  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isAbortError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === "AbortError" || cause.message === "This operation was aborted")
  );
}

function readErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
