import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { ProxyOptions } from 'vite';

import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerRequestInput,
  AppServerSubscription,
} from '../../product/app-server.js';
import type {
  AppServerNotification,
  AppServerResponse,
} from '../../product/app-server-protocol.js';
import { assertLoopbackBindAllowed } from './app-server-config.js';

export type AppServerHttpTransportOptions = {
  readonly allowRemoteBind?: boolean;
  readonly appServer: AppServerClient;
  readonly capability?: string;
  readonly host?: string;
  readonly port?: number;
  readonly eventReplayLimit?: number;
  readonly eventSubscriberBufferLimit?: number;
  /** Optional protocol parser used before dispatch.  Transport stays protocol-neutral. */
  readonly parseRequest?: (value: unknown) => unknown;
};

export type AppServerHttpTransport = {
  readonly capability: string;
  readonly url: string;
  quiesce(): Promise<void>;
  close(): Promise<void>;
};

export type HttpAppServerClientOptions = {
  readonly baseUrl: string | URL;
  readonly capability: string;
  readonly fetch?: typeof fetch;
  readonly onSubscriptionError?: (error: AppServerTransportError) => void;
};

export class AppServerTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppServerTransportError';
  }
}

const REQUEST_PATH = '/request';
const EVENTS_PATH = '/events';
const MAX_REQUEST_BODY_BYTES = 1_000_000;
const MIN_CAPABILITY_BYTES = 32;

type TransportRequestState = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  phase: 'ingress' | 'dispatched' | 'stream';
};

export function createAppServerHttpProxy(
  target: string,
  capability: string
): Record<string, ProxyOptions> {
  return {
    [REQUEST_PATH]: createAuthenticatedProxyOptions(target, capability),
    [EVENTS_PATH]: createAuthenticatedProxyOptions(target, capability),
  };
}

function createAuthenticatedProxyOptions(target: string, capability: string): ProxyOptions {
  const authorization = `Bearer ${capability}`;

  return {
    target,
    changeOrigin: true,
    bypass: rejectUntrustedProxyRequest,
    configure(proxy) {
      proxy.on('proxyReq', (proxyRequest) => {
        proxyRequest.setHeader('authorization', authorization);
      });
    },
  };
}

function rejectUntrustedProxyRequest(
  request: IncomingMessage,
  response: ServerResponse | undefined
): string | undefined {
  if (isTrustedSameOriginRequest(request)) {
    return undefined;
  }

  response?.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
  });
  response?.end(`${JSON.stringify({ error: 'Forbidden proxy request' })}\n`);

  // Vite stops before proxying when bypass returns a path after ending the response.
  return request.url ?? '/';
}

function isTrustedSameOriginRequest(request: IncomingMessage): boolean {
  if (request.method === 'OPTIONS') {
    return false;
  }

  const fetchSite = request.headers['sec-fetch-site'];

  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    return false;
  }

  const origin = request.headers.origin;

  if (origin === undefined) {
    return fetchSite === 'same-origin';
  }

  if (typeof origin !== 'string' || !request.headers.host) {
    return false;
  }

  try {
    const encrypted = 'encrypted' in request.socket && request.socket.encrypted;
    const expectedOrigin = `${encrypted ? 'https' : 'http'}://${request.headers.host}`;
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export async function serveAppServerHttpTransport(
  options: AppServerHttpTransportOptions
): Promise<AppServerHttpTransport> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  assertLoopbackBindAllowed(host, options.allowRemoteBind ?? false, 'Non-loopback App Server');
  const capability = resolveCapability(options.capability);
  const capabilityDigest = digestCapability(capability);
  const notificationStream = new NotificationReplayStream(
    options.appServer,
    options.eventReplayLimit ?? 1_024
  );
  const eventStreams = new Map<ServerResponse, AppServerSubscription>();
  const requests = new Set<TransportRequestState>();
  const sockets = new Set<Socket>();
  let accepting = true;
  const server = createServer((request, response) => {
    const requestState: TransportRequestState = { request, response, phase: 'ingress' };
    requests.add(requestState);
    const releaseRequest = () => requests.delete(requestState);
    response.once('finish', releaseRequest);
    response.once('close', releaseRequest);
    void (async () => {
      if (!accepting) {
        response.shouldKeepAlive = false;
        response.once('finish', () => request.socket.destroy());
        sendJson(response, 503, {
          method: 'transport/request',
          ok: false,
          error: {
            code: 'SERVER_QUIESCING',
            message: 'App Server transport is shutting down',
          },
        });
        return;
      }

      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);

      if (
        (url.pathname === REQUEST_PATH || url.pathname === EVENTS_PATH) &&
        !hasCapability(request, capabilityDigest)
      ) {
        sendUnauthorized(response);
        return;
      }

      if (request.method === 'POST' && url.pathname === REQUEST_PATH) {
        await handleRequest(
          options.appServer,
          request,
          response,
          () => {
            requestState.phase = 'dispatched';
          },
          options.parseRequest
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === EVENTS_PATH) {
        requestState.phase = 'stream';
        const unsubscribe = handleEventStream(
          notificationStream,
          request,
          response,
          (streamResponse) => {
            const streamUnsubscribe = eventStreams.get(streamResponse);
            eventStreams.delete(streamResponse);
            streamUnsubscribe?.();
          },
          options.eventSubscriberBufferLimit ?? 128
        );
        eventStreams.set(response, unsubscribe);
        request.on('close', () => {
          eventStreams.delete(response);
          unsubscribe();
        });
        return;
      }

      sendJson(response, 404, {
        method: 'transport/request',
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `Unknown App Server transport route: ${request.method ?? 'GET'} ${url.pathname}`,
        },
      });
    })().catch((cause: unknown) => {
      response.destroy(cause instanceof Error ? cause : new Error(String(cause)));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (cause) {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => notificationStream.close()),
      ...(server.listening ? [closeHttpServer(server)] : []),
    ]);
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError([cause, ...cleanupFailures], 'App Server transport startup failed', {
        cause,
      });
    }
    throw cause;
  }

  const address = server.address() as AddressInfo;
  let closePromise: Promise<void> | undefined;

  const quiesce = (): Promise<void> => {
    accepting = false;
    abortIncompleteIngress(requests, sockets);
    return Promise.resolve();
  };

  const close = (): Promise<void> => {
    closePromise ??= closeTransport();
    return closePromise;
  };

  const closeTransport = async (): Promise<void> => {
    await quiesce();
    const streamTasks: Promise<void>[] = [];

    for (const [streamResponse, unsubscribe] of eventStreams) {
      streamTasks.push(Promise.resolve().then(() => unsubscribe()));
      streamTasks.push(
        Promise.resolve().then(() => {
          streamResponse.end();
        })
      );
    }
    eventStreams.clear();
    streamTasks.push(Promise.resolve().then(() => notificationStream.close()));

    const streamResults = await Promise.allSettled(streamTasks);
    abortIncompleteIngress(requests, sockets);
    server.closeIdleConnections();
    const serverResult = await Promise.allSettled([
      closeHttpServer(server),
      waitForSocketSetToDrain(sockets),
    ]);
    const failures = [...streamResults, ...serverResult].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );

    if (failures.length > 0) {
      throw new AggregateError(failures, 'App Server HTTP transport close failed');
    }
  };

  return {
    capability,
    url: `http://${formatUrlHost(address.address)}:${address.port}`,
    quiesce,
    close,
  };
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause) {
        reject(cause);
        return;
      }
      resolve();
    });
  });
}

function formatUrlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function resolveCapability(provided: string | undefined): string {
  if (provided === undefined) {
    return randomBytes(MIN_CAPABILITY_BYTES).toString('base64url');
  }

  if (
    Buffer.byteLength(provided, 'utf8') < MIN_CAPABILITY_BYTES ||
    /[\u0000-\u0020\u007f]/u.test(provided)
  ) {
    throw new Error(
      'App Server capability must be at least 32 bytes without whitespace or control characters'
    );
  }

  return provided;
}

function hasCapability(request: IncomingMessage, expectedDigest: Buffer): boolean {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith('Bearer ')) {
    return false;
  }

  const candidateDigest = digestCapability(authorization.slice('Bearer '.length));
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function digestCapability(capability: string): Buffer {
  return createHash('sha256').update(capability, 'utf8').digest();
}

function sendUnauthorized(response: ServerResponse): void {
  sendJson(response, 401, {
    method: 'transport/request',
    ok: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'App Server capability is missing or invalid',
    },
  });
}

export class HttpAppServerClient implements AppServerClient {
  private readonly authorization: string;
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly onSubscriptionError?: (error: AppServerTransportError) => void;
  private readonly subscriptions = new Set<HttpSubscriptionState>();

  constructor(options: HttpAppServerClientOptions) {
    this.authorization = `Bearer ${options.capability}`;
    this.baseUrl = new URL(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onSubscriptionError = options.onSubscriptionError;
  }

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    return await this.withSubscriptionsReady(() => this.requestDirect(request));
  }

  private async requestDirect(request: AppServerRequestInput): Promise<AppServerResponse> {
    const response = await this.fetchImpl(new URL(REQUEST_PATH, this.baseUrl), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: this.authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new AppServerTransportError(
        'HTTP_REQUEST_FAILED',
        `App Server transport request failed with HTTP ${response.status}`,
        await readResponseBody(response)
      );
    }

    return readAppServerResponse(await response.text());
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    const subscription: HttpSubscriptionState = {
      active: true,
      controller: new AbortController(),
      generation: 0,
      gate: createSubscriptionGate(),
      phase: 'connecting',
      pendingNotifications: [],
      needsReset: false,
    };
    this.subscriptions.add(subscription);
    void this.consumeEventStreams(listener, subscription);

    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      subscription.generation += 1;
      subscription.phase = 'closed';
      subscription.gate.reject(new Error('HTTP event subscription disconnected'));
      subscription.controller.abort();
      this.subscriptions.delete(subscription);
    };
  }

  private async consumeEventStreams(
    listener: AppServerNotificationListener,
    subscription: HttpSubscriptionState
  ): Promise<void> {
    while (subscription.active) {
      try {
        await this.consumeEventStream(listener, subscription);
        if (!subscription.active) return;
        this.beginHttpReconnect(
          subscription,
          new AppServerTransportError('SSE_DISCONNECTED', 'App Server event stream disconnected')
        );
      } catch (cause) {
        if (isAbortError(cause) || !subscription.active) return;
        const error =
          cause instanceof AppServerTransportError
            ? cause
            : new AppServerTransportError('SSE_READ_FAILED', readErrorMessage(cause), cause);
        this.beginHttpReconnect(subscription, error);
      }
      await waitForReconnect(subscription.controller.signal);
    }
  }

  private async consumeEventStream(
    listener: AppServerNotificationListener,
    subscription: HttpSubscriptionState
  ): Promise<void> {
    const response = await this.fetchImpl(new URL(EVENTS_PATH, this.baseUrl), {
      headers: {
        accept: 'text/event-stream',
        authorization: this.authorization,
        ...(subscription.lastEventId ? { 'last-event-id': subscription.lastEventId } : {}),
      },
      signal: subscription.controller.signal,
    });

    if (!response.ok) {
      throw new AppServerTransportError(
        'SSE_CONNECT_FAILED',
        `App Server event stream failed with HTTP ${response.status}`,
        await readResponseBody(response)
      );
    }

    if (!response.body) {
      throw new AppServerTransportError(
        'SSE_BODY_MISSING',
        'App Server event stream response did not include a body'
      );
    }

    if (subscription.phase === 'reconnecting') subscription.phase = 'recovering';
    await readServerSentEvents(
      response.body,
      async (event) => await this.consumeHttpEvent(event, listener, subscription),
      subscription.controller.signal
    );
  }

  private async consumeHttpEvent(
    event: ParsedServerSentEvent,
    listener: AppServerNotificationListener,
    subscription: HttpSubscriptionState
  ): Promise<void> {
    if (event.id) subscription.lastEventId = event.id;
    if (event.event === 'notification') {
      const notification = JSON.parse(event.data) as AppServerNotification;
      if (
        subscription.phase === 'open' ||
        (subscription.phase === 'recovering' && !subscription.needsReset)
      ) {
        listener(notification);
      } else {
        subscription.pendingNotifications.push(notification);
      }
      return;
    }
    if (event.event === 'reset') {
      subscription.needsReset = true;
      return;
    }
    if (event.event !== 'sync') return;

    const generation = subscription.generation;
    let resetThreads: readonly import('../../product/index.js').ThreadSnapshot[] | undefined;
    if (subscription.needsReset) {
      const result = await this.requestDirect({ method: 'thread/list' });
      if (!result.ok || result.method !== 'thread/list') {
        throw new AppServerTransportError(
          'SSE_RESNAPSHOT_FAILED',
          result.ok ? `Unexpected ${result.method}` : result.error.message
        );
      }
      resetThreads = result.result.threads;
    }
    if (!subscription.active || subscription.generation !== generation) return;
    if (resetThreads) listener({ type: 'sync/reset', threads: resetThreads });
    for (const notification of subscription.pendingNotifications) listener(notification);
    subscription.pendingNotifications = [];
    subscription.needsReset = false;
    subscription.phase = 'open';
    subscription.gate.resolve();
  }

  private beginHttpReconnect(
    subscription: HttpSubscriptionState,
    error: AppServerTransportError
  ): void {
    subscription.gate.reject(error);
    subscription.generation += 1;
    subscription.phase = 'reconnecting';
    subscription.gate = createSubscriptionGate();
    if (!subscription.needsReset) subscription.pendingNotifications = [];
    this.onSubscriptionError?.(error);
  }

  private async withSubscriptionsReady<T>(operation: () => Promise<T>): Promise<T> {
    const authorization = [...this.subscriptions].map((subscription) => ({
      subscription,
      generation: subscription.generation,
      gate: subscription.gate,
    }));
    await Promise.all(authorization.map(({ gate }) => gate.promise));
    await Promise.resolve();
    if (
      authorization.some(
        ({ subscription, generation, gate }) =>
          !subscription.active ||
          subscription.phase !== 'open' ||
          subscription.generation !== generation ||
          subscription.gate !== gate
      )
    ) {
      throw new AppServerTransportError(
        'SSE_GENERATION_CHANGED',
        'HTTP event subscription changed before request'
      );
    }
    return await operation();
  }
}

type HttpSubscriptionPhase = 'connecting' | 'open' | 'reconnecting' | 'recovering' | 'closed';

type SubscriptionGate = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: Error) => void;
};

type HttpSubscriptionState = {
  active: boolean;
  readonly controller: AbortController;
  generation: number;
  gate: SubscriptionGate;
  phase: HttpSubscriptionPhase;
  lastEventId?: string;
  needsReset: boolean;
  pendingNotifications: AppServerNotification[];
};

function createSubscriptionGate(): SubscriptionGate {
  const deferred = createDeferred<void>();
  void deferred.promise.catch(() => undefined);
  return { promise: deferred.promise, resolve: deferred.resolve, reject: deferred.reject };
}

async function waitForReconnect(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = setTimeout(finish, 100);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function handleRequest(
  appServer: AppServerClient,
  request: IncomingMessage,
  response: ServerResponse,
  onDispatch: () => void,
  parseRequest?: (value: unknown) => unknown
): Promise<void> {
  const parsed = await readRequestJson(request);

  if (!parsed.ok) {
    sendJson(response, parsed.status, {
      method: 'transport/request',
      ok: false,
      error: {
        code: parsed.code,
        message: parsed.message,
      },
    });
    return;
  }

  let input = parsed.value;
  try {
    input = parseRequest?.(input) ?? input;
  } catch (cause) {
    sendJson(response, 400, {
      method: 'transport/request',
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: cause instanceof Error ? cause.message : 'Invalid transport request',
      },
    });
    return;
  }

  onDispatch();
  try {
    const result = await appServer.request(input as AppServerRequestInput);

    sendJson(response, 200, result);
  } catch {
    sendJson(response, 500, {
      method: 'transport/request',
      ok: false,
      error: {
        code: 'UPSTREAM_REQUEST_FAILED',
        message: 'App Server request failed',
      },
    });
  }
}

function abortIncompleteIngress(
  requests: ReadonlySet<TransportRequestState>,
  sockets: ReadonlySet<Socket>
): void {
  const productOwnedSockets = new Set(
    [...requests]
      .filter((state) => state.phase === 'dispatched' || state.phase === 'stream')
      .map((state) => state.request.socket)
  );
  for (const state of requests) {
    if (
      state.phase !== 'ingress' ||
      state.response.writableEnded ||
      productOwnedSockets.has(state.request.socket)
    ) {
      continue;
    }
    state.request.socket.destroy();
  }
  for (const socket of sockets) {
    if (!productOwnedSockets.has(socket)) socket.destroy();
  }
}

async function waitForSocketSetToDrain(sockets: ReadonlySet<Socket>): Promise<void> {
  while (sockets.size > 0) {
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once('close', resolve);
          })
      )
    );
  }
}

function handleEventStream(
  notificationStream: NotificationReplayStream,
  request: IncomingMessage,
  response: ServerResponse,
  onClose: (response: ServerResponse) => void,
  bufferLimit: number
): AppServerSubscription {
  if (!Number.isSafeInteger(bufferLimit) || bufferLimit < 1) {
    throw new Error('SSE subscriber buffer limit must be a positive integer');
  }
  response.writeHead(200, {
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
  });
  let unsubscribe: AppServerSubscription = () => undefined;
  const writer = new BoundedSseWriter(response, bufferLimit, () => {
    queueMicrotask(() => {
      unsubscribe();
      onClose(response);
      response.destroy(new Error('SSE slow consumer disconnected'));
    });
  });
  writer.write(': connected\n\n');

  unsubscribe = notificationStream.subscribe(request.headers['last-event-id'], (event) => {
    writer.write(toServerSentEvent(event));
  });

  response.on('close', () => onClose(response));

  return () => {
    writer.close();
    unsubscribe();
  };
}

export class BoundedSseWriter {
  private readonly pending: string[] = [];
  private blocked = false;
  private closed = false;

  constructor(
    private readonly response: ServerResponse,
    private readonly limit: number,
    private readonly onOverflow: () => void
  ) {}

  write(value: string): void {
    if (this.closed) return;
    if (this.blocked) {
      this.pending.push(value);
      if (this.pending.length > this.limit) {
        this.closed = true;
        this.pending.length = 0;
        this.onOverflow();
      }
      return;
    }
    if (!this.response.write(value)) {
      this.blocked = true;
      this.response.once('drain', () => this.flush());
    }
  }

  close(): void {
    this.closed = true;
    this.pending.length = 0;
  }

  private flush(): void {
    if (this.closed) return;
    this.blocked = false;
    while (this.pending.length > 0 && !this.blocked) {
      const next = this.pending.shift();
      if (next !== undefined) this.write(next);
    }
  }
}

type NotificationStreamRecord = {
  readonly type: 'notification';
  readonly id: string;
  readonly cursor: number;
  readonly notification: AppServerNotification;
};

type NotificationStreamControl = {
  readonly type: 'reset' | 'sync';
  readonly id: string;
  readonly streamId: string;
  readonly cursor: number;
};

type NotificationStreamEvent = NotificationStreamRecord | NotificationStreamControl;

class NotificationReplayStream {
  private readonly streamId = randomBytes(16).toString('base64url');
  private readonly records: NotificationStreamRecord[] = [];
  private readonly listeners = new Set<(record: NotificationStreamRecord) => void>();
  private readonly unsubscribe: AppServerSubscription;
  private cursor = 0;

  constructor(
    appServer: AppServerClient,
    private readonly replayLimit: number
  ) {
    if (!Number.isInteger(replayLimit) || replayLimit < 1) {
      throw new Error('App Server event replay limit must be a positive integer');
    }
    this.unsubscribe = appServer.subscribe((notification) => this.append(notification));
  }

  subscribe(
    lastEventId: string | readonly string[] | undefined,
    listener: (event: NotificationStreamEvent) => void
  ): AppServerSubscription {
    const checkpoint = parseNotificationCursor(lastEventId);
    const reset = this.requiresReset(checkpoint);
    const liveListener = (record: NotificationStreamRecord) => listener(record);
    this.listeners.add(liveListener);

    if (reset) {
      listener(this.control('reset'));
    } else if (checkpoint) {
      for (const record of this.records) {
        if (record.cursor > checkpoint.cursor) listener(record);
      }
    }
    listener(this.control('sync'));

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(liveListener);
    };
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private append(notification: AppServerNotification): void {
    const cursor = ++this.cursor;
    const record: NotificationStreamRecord = {
      type: 'notification',
      id: `${this.streamId}:${cursor}`,
      cursor,
      notification,
    };
    this.records.push(record);
    if (this.records.length > this.replayLimit) this.records.shift();
    this.listeners.forEach((listener) => listener(record));
  }

  private requiresReset(checkpoint: NotificationCursor | undefined): boolean {
    if (!checkpoint) return false;
    if (checkpoint.streamId !== this.streamId || checkpoint.cursor > this.cursor) return true;
    if (checkpoint.cursor === this.cursor) return false;
    const earliest = this.records[0]?.cursor;
    return earliest === undefined || checkpoint.cursor < earliest - 1;
  }

  private control(type: NotificationStreamControl['type']): NotificationStreamControl {
    return {
      type,
      id: `${this.streamId}:${this.cursor}`,
      streamId: this.streamId,
      cursor: this.cursor,
    };
  }
}

type NotificationCursor = {
  readonly streamId: string;
  readonly cursor: number;
};

function parseNotificationCursor(
  value: string | readonly string[] | undefined
): NotificationCursor | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const separator = value.lastIndexOf(':');
  const streamId = value.slice(0, separator);
  const cursor = Number(value.slice(separator + 1));
  if (!streamId || separator < 1 || !Number.isSafeInteger(cursor) || cursor < 0) {
    return { streamId: '', cursor: -1 };
  }
  return { streamId, cursor };
}

function toServerSentEvent(event: NotificationStreamEvent): string {
  const data =
    event.type === 'notification'
      ? event.notification
      : { streamId: event.streamId, cursor: event.cursor };
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readRequestJson(request: IncomingMessage): Promise<
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
> {
  let body = '';

  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'REQUEST_TOO_LARGE',
        message: 'App Server transport request body is too large',
      };
    }
  }

  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_JSON',
      message: 'App Server transport request body must be valid JSON',
    };
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function readAppServerResponse(body: string): AppServerResponse {
  try {
    const value = JSON.parse(body) as unknown;

    if (
      typeof value === 'object' &&
      value !== null &&
      'method' in value &&
      'ok' in value &&
      typeof value.ok === 'boolean'
    ) {
      return value as AppServerResponse;
    }
  } catch (cause) {
    throw new AppServerTransportError(
      'INVALID_RESPONSE_JSON',
      'App Server transport response body must be valid JSON',
      cause
    );
  }

  throw new AppServerTransportError(
    'INVALID_RESPONSE',
    'App Server transport response did not match the protocol envelope'
  );
}

async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  listener: (event: ParsedServerSentEvent) => void | Promise<void>,
  signal: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const result = await reader.read();

      if (result.done) {
        return;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const consumed = consumeServerSentEventBuffer(buffer);
      buffer = consumed.remaining;
      for (const event of consumed.events) await listener(event);
    }
  } finally {
    reader.releaseLock();
  }
}

type ParsedServerSentEvent = {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
};

function consumeServerSentEventBuffer(buffer: string): {
  readonly remaining: string;
  readonly events: readonly ParsedServerSentEvent[];
} {
  let remaining = buffer.replaceAll('\r\n', '\n');
  const events: ParsedServerSentEvent[] = [];
  let separatorIndex = remaining.indexOf('\n\n');

  while (separatorIndex >= 0) {
    const rawEvent = remaining.slice(0, separatorIndex);
    remaining = remaining.slice(separatorIndex + 2);
    separatorIndex = remaining.indexOf('\n\n');

    const eventType =
      rawEvent
        .split('\n')
        .find((line) => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim() ?? 'message';
    const id = rawEvent
      .split('\n')
      .find((line) => line.startsWith('id:'))
      ?.slice('id:'.length)
      .trim();
    const data = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');

    if (data.length === 0) {
      continue;
    }

    events.push({ event: eventType, data, ...(id ? { id } : {}) });
  }

  return { remaining, events };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');

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
    (cause.name === 'AbortError' || cause.message === 'This operation was aborted')
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
