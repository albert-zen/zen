import { describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';

import {
  AggregateProductionShutdown,
  AppServer,
  type AppServerClient,
  type AppServerNotification,
  type AppServerNotificationListener,
  type AppServerResponse,
  type AppServerSubscription,
  HttpAppServerClient,
  serveAppServerHttpTransport,
  type ModelGateway,
  type ToolRuntime,
} from './test-exports.js';

const TEST_CAPABILITY = 'test-capability-0123456789-abcdef-0123456789';

describe('App Server HTTP transport', () => {
  it('rejects requests without a matching capability before dispatch', async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({
      appServer: server,
      capability: TEST_CAPABILITY,
    });

    try {
      for (const authorization of [undefined, 'Bearer mismatched-capability-0123456789-abcdef']) {
        const unauthorized = await fetch(new URL('/request', transport.url), {
          method: 'POST',
          headers: {
            ...(authorization ? { authorization } : {}),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ method: 'thread/start' }),
        });
        const unauthorizedBody = await unauthorized.text();

        expect(unauthorized.status).toBe(401);
        expect(JSON.parse(unauthorizedBody)).toEqual({
          method: 'transport/request',
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'App Server capability is missing or invalid',
          },
        });
        expect(unauthorizedBody).not.toContain(TEST_CAPABILITY);
      }

      const authorized = await fetch(new URL('/request', transport.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_CAPABILITY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'thread/list' }),
      });

      await expect(authorized.json()).resolves.toEqual({
        method: 'thread/list',
        ok: true,
        result: { threads: [], persistenceFailures: [] },
      });
    } finally {
      await transport.close();
    }
  });

  it('quiesces new ingress and closes idempotently', async () => {
    let requestCount = 0;
    const appServer = {
      async request() {
        requestCount += 1;
        return {
          method: 'thread/list',
          ok: true as const,
          result: { threads: [], persistenceFailures: [] },
        };
      },
      subscribe() {
        return () => undefined;
      },
    } satisfies AppServerClient;
    const transport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY,
    });

    await transport.quiesce();
    const response = await fetch(new URL('/request', transport.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_CAPABILITY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'thread/list' }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SERVER_QUIESCING' },
    });
    expect(requestCount).toBe(0);
    const firstClose = transport.close();
    const secondClose = transport.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
  });

  it('closes a partial authenticated request body within the transport shutdown budget', async () => {
    let requestCount = 0;
    const appServer = {
      async request() {
        requestCount += 1;
        return {
          method: 'thread/list',
          ok: true as const,
          result: { threads: [], persistenceFailures: [] },
        };
      },
      subscribe() {
        return () => undefined;
      },
    } satisfies AppServerClient;
    const transport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY,
    });
    const target = new URL(transport.url);
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    const socketErrors: Error[] = [];
    socket.on('error', (error) => socketErrors.push(error));
    let shutdownSettled = false;

    try {
      await once(socket, 'connect');
      socket.write(
        [
          'POST /request HTTP/1.1',
          `Host: ${target.host}`,
          `Authorization: Bearer ${TEST_CAPABILITY}`,
          'Content-Type: application/json',
          'Content-Length: 128',
          '',
          '{"method":"thread/list"',
        ].join('\r\n')
      );
      await new Promise((resolve) => setImmediate(resolve));

      const shutdown = new AggregateProductionShutdown({
        ingress: [{ name: 'transport ingress', close: () => transport.quiesce() }],
        edge: [{ name: 'transport edge', close: () => transport.close() }],
      });
      await expect(settlesWithin(shutdown.close(), 250)).resolves.toBeUndefined();
      shutdownSettled = true;
      if (!socket.destroyed) await once(socket, 'close');

      expect(socket.destroyed).toBe(true);
      expect(socketErrors.every((error) => 'code' in error && error.code === 'ECONNRESET')).toBe(
        true
      );
      expect(requestCount).toBe(0);
    } finally {
      if (!shutdownSettled) socket.destroy();
      await transport.close();
    }
  });

  it('allows an already dispatched request to finish after ingress quiesces', async () => {
    const dispatched = createDeferred<void>();
    const release = createDeferred<void>();
    const appServer = {
      async request() {
        dispatched.resolve();
        await release.promise;
        return {
          method: 'thread/list',
          ok: true as const,
          result: { threads: [], persistenceFailures: [] },
        };
      },
      subscribe() {
        return () => undefined;
      },
    } satisfies AppServerClient;
    const transport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY,
    });

    try {
      const pending = fetch(new URL('/request', transport.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_CAPABILITY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'thread/list' }),
      });
      await dispatched.promise;
      await transport.quiesce();
      release.resolve();

      const response = await pending;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ method: 'thread/list', ok: true });
    } finally {
      release.resolve();
      await transport.close();
    }
  });

  it('keeps an established SSE stream alive until edge close after quiesce', async () => {
    const appServer = new PushAppServerClient();
    const transport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY,
    });
    const stream = await openEventStream(transport.url);

    try {
      await stream.next('sync');
      await transport.quiesce();
      appServer.emit(itemNotification('item-after-quiesce', 1));
      const notification = await stream.next('notification');

      expect(JSON.parse(notification.data)).toMatchObject({
        item: { id: 'item-after-quiesce' },
      });
    } finally {
      stream.abort();
      await transport.close();
    }
  });

  it('unsubscribes when transport startup cannot bind', async () => {
    const occupied = await listenWithPlainTextResponse();
    let subscriptionCount = 0;
    let unsubscribeCount = 0;
    const appServer = {
      async request() {
        throw new Error('unused');
      },
      subscribe() {
        subscriptionCount += 1;
        return () => {
          unsubscribeCount += 1;
        };
      },
    } satisfies AppServerClient;

    try {
      await expect(
        serveAppServerHttpTransport({
          appServer,
          host: '127.0.0.1',
          port: Number(new URL(occupied.url).port),
        })
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(subscriptionCount).toBe(1);
      expect(unsubscribeCount).toBe(1);
    } finally {
      await occupied.close();
    }
  });

  it('generates independent 256-bit capabilities by default', async () => {
    const first = await serveAppServerHttpTransport({ appServer: createServer() });
    const second = await serveAppServerHttpTransport({ appServer: createServer() });

    try {
      expect(Buffer.from(first.capability, 'base64url')).toHaveLength(32);
      expect(Buffer.from(second.capability, 'base64url')).toHaveLength(32);
      expect(first.capability).not.toBe(second.capability);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('rejects short, whitespace, and control-character provided capabilities', async () => {
    const capabilities = [
      'too-short',
      'provided capability 0123456789 abcdef 0123456789',
      'provided-capability-0123456789\u0000abcdef-0123456789',
    ];

    for (const capability of capabilities) {
      let rejection: unknown;

      try {
        await serveAppServerHttpTransport({
          appServer: createServer(),
          capability,
        });
      } catch (cause) {
        rejection = cause;
      }

      expect(rejection).toEqual(
        new Error(
          'App Server capability must be at least 32 bytes without whitespace or control characters'
        )
      );
      expect(String(rejection)).not.toContain(capability);
    }
  });

  it('rejects event streams without a matching capability before subscribing', async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({
      appServer: server,
      capability: TEST_CAPABILITY,
    });

    try {
      for (const authorization of [undefined, 'Bearer mismatched-capability-0123456789-abcdef']) {
        const response = await fetch(new URL('/events', transport.url), {
          headers: authorization ? { authorization } : undefined,
        });

        expect(response.status).toBe(401);
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({
          method: 'transport/request',
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'App Server capability is missing or invalid',
          },
        });
        expect(body).not.toContain(TEST_CAPABILITY);
      }
    } finally {
      await transport.close();
    }
  });

  it('lets a client start, list, and read threads through transport', async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({ appServer: server });
    const client = new HttpAppServerClient({
      baseUrl: transport.url,
      capability: transport.capability,
    });

    try {
      const start = await client.request({ method: 'thread/start' });

      expect(start).toEqual({
        method: 'thread/start',
        ok: true,
        result: {
          thread: {
            id: 'thread-1',
            status: 'idle',
            turns: [],
            items: [],
          },
        },
      });

      if (!start.ok || start.method !== 'thread/start') {
        throw new Error('thread/start failed');
      }

      await expect(client.request({ method: 'thread/list' })).resolves.toEqual({
        method: 'thread/list',
        ok: true,
        result: { threads: [start.result.thread], persistenceFailures: [] },
      });
      await expect(
        client.request({
          method: 'thread/read',
          params: { threadId: start.result.thread.id },
        })
      ).resolves.toEqual({
        method: 'thread/read',
        ok: true,
        result: { thread: start.result.thread },
      });
    } finally {
      await transport.close();
    }
  });

  it('reconnects the Node client with Last-Event-ID and replays before request readiness', async () => {
    const eventHeaders: Array<string | null> = [];
    const secondConnected = createDeferred<void>();
    const twoNotifications = createDeferred<void>();
    const received: AppServerNotification[] = [];
    let eventConnections = 0;
    let requestCalls = 0;
    let secondController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchImpl = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/request') {
        requestCalls += 1;
        return new Response(
          JSON.stringify({
            method: 'thread/list',
            ok: true,
            result: { threads: [], persistenceFailures: [] },
          })
        );
      }
      eventConnections += 1;
      eventHeaders.push(new Headers(init?.headers).get('last-event-id'));
      const cursor = eventConnections;
      const notification = sseNotification(
        itemNotification(`item-${cursor}`, cursor),
        `stream:${cursor}`
      );
      if (eventConnections === 1) {
        return new Response(`${notification}${sseControl('sync', 'stream:1', 1)}`);
      }
      secondConnected.resolve();
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            secondController = controller;
            controller.enqueue(new TextEncoder().encode(notification));
            signal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        })
      );
    }) as typeof fetch;
    const client = new HttpAppServerClient({
      baseUrl: 'http://127.0.0.1:1',
      capability: TEST_CAPABILITY,
      fetch: fetchImpl,
    });
    const unsubscribe = client.subscribe((notification) => {
      received.push(notification);
      if (received.length === 2) twoNotifications.resolve();
    });

    try {
      await secondConnected.promise;
      const request = client.request({ method: 'thread/list' });
      await Promise.resolve();
      expect(requestCalls).toBe(0);
      secondController?.enqueue(new TextEncoder().encode(sseControl('sync', 'stream:2', 2)));
      await twoNotifications.promise;
      await expect(request).resolves.toMatchObject({ ok: true });

      expect(eventHeaders).toEqual([null, 'stream:1']);
      expect(requestCalls).toBe(1);
      expect(
        received.map((notification) =>
          notification.type === 'item/appended' ? notification.item.id : notification.type
        )
      ).toEqual(['item-1', 'item-2']);
    } finally {
      unsubscribe();
    }
  });

  it('streams running turn notifications in item sequence order', async () => {
    const notifications: AppServerNotification[] = [];
    const server = createServer({
      model: {
        async *generate() {
          yield { type: 'text.delta', text: 'Hel' };
          yield { type: 'text.delta', text: 'lo' };
          yield { type: 'message.completed', content: 'Hello' };
        },
      },
    });
    const transport = await serveAppServerHttpTransport({ appServer: server });
    const client = new HttpAppServerClient({
      baseUrl: transport.url,
      capability: transport.capability,
    });
    const unsubscribe = client.subscribe((notification) => {
      notifications.push(notification);
    });

    try {
      const start = await client.request({ method: 'thread/start' });

      if (!start.ok || start.method !== 'thread/start') {
        throw new Error('thread/start failed');
      }

      await client.request({
        method: 'turn/start',
        params: {
          threadId: start.result.thread.id,
          input: 'Hello',
        },
      });
      await waitForNotification(
        notifications,
        (notification) => notification.type === 'turn/completed'
      );

      expect(notifications.map((notification) => notification.type)).toEqual([
        'thread/started',
        'item/appended',
        'item/appended',
        'item/appended',
        'turn/started',
        'item/appended',
        'item/appended',
        'item/appended',
        'item/appended',
        'item/appended',
        'item/appended',
        'item/appended',
        'item/appended',
        'item/appended',
        'turn/completed',
      ]);
      expect(
        notifications
          .filter((notification) => notification.type === 'item/appended')
          .map((notification) => notification.item.seq)
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    } finally {
      unsubscribe();
      await transport.close();
    }
  });

  it('replays notifications emitted while an SSE client is disconnected', async () => {
    const appServer = new PushAppServerClient();
    const transport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY,
    });
    const first = await openEventStream(transport.url);

    try {
      appServer.emit(itemNotification('item-1', 1));
      const receivedFirst = await first.next('notification');
      expect(receivedFirst.id).toMatch(/^[^:]+:1$/);
      first.abort();
      await Promise.resolve();
      appServer.emit(itemNotification('item-2', 2));

      const second = await openEventStream(transport.url, receivedFirst.id);
      appServer.emit(itemNotification('item-3', 3));
      const replayed = await second.next('notification');

      expect(JSON.parse(replayed.data)).toMatchObject({ item: { id: 'item-2', seq: 2 } });
      second.abort();
    } finally {
      first.abort();
      await transport.close();
    }
  });

  it('signals reset when Last-Event-ID falls behind retained replay history', async () => {
    const appServer = new PushAppServerClient();
    const transport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY,
      eventReplayLimit: 1,
    });
    const first = await openEventStream(transport.url);

    try {
      appServer.emit(itemNotification('item-1', 1));
      const receivedFirst = await first.next('notification');
      first.abort();
      await Promise.resolve();
      appServer.emit(itemNotification('item-2', 2));
      appServer.emit(itemNotification('item-3', 3));

      const second = await openEventStream(transport.url, receivedFirst.id);
      appServer.emit(itemNotification('item-4', 4));
      const reset = await second.nextDataEvent();

      expect(reset.event).toBe('reset');
      expect(JSON.parse(reset.data)).toMatchObject({ cursor: 3 });
      second.abort();
    } finally {
      first.abort();
      await transport.close();
    }
  });

  it('signals reset when Last-Event-ID belongs to a prior server stream', async () => {
    const appServer = new PushAppServerClient();
    const firstTransport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY,
    });
    const first = await openEventStream(firstTransport.url);
    appServer.emit(itemNotification('item-1', 1));
    const receivedFirst = await first.next('notification');
    first.abort();
    await firstTransport.close();

    const secondTransport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY,
    });
    const second = await openEventStream(secondTransport.url, receivedFirst.id);
    try {
      appServer.emit(itemNotification('item-2', 2));
      const reset = await second.nextDataEvent();

      expect(reset.event).toBe('reset');
      expect(JSON.parse(reset.data)).toMatchObject({ cursor: 0 });
    } finally {
      second.abort();
      await secondTransport.close();
    }
  });

  it('interrupts a running turn through transport', async () => {
    const notifications: AppServerNotification[] = [];
    const toolAborted = createDeferred<void>();
    const server = createServer({
      model: {
        async *generate() {
          yield {
            type: 'message.completed',
            content: 'Calling long tool',
            toolCalls: [{ id: 'call-1', name: 'fake-tool', input: {} }],
          };
        },
      },
      toolRuntime: {
        async *execute(_call, context) {
          if (!context.signal) {
            throw new Error('missing abort signal');
          }

          context.signal.addEventListener('abort', () => toolAborted.resolve(), {
            once: true,
          });
          yield { type: 'output.delta', delta: 'started' };
          await toolAborted.promise;
          yield { type: 'error', error: new Error('fake tool canceled') };
        },
      },
    });
    const transport = await serveAppServerHttpTransport({ appServer: server });
    const client = new HttpAppServerClient({
      baseUrl: transport.url,
      capability: transport.capability,
    });
    const unsubscribe = client.subscribe((notification) => {
      notifications.push(notification);
    });

    try {
      const start = await client.request({ method: 'thread/start' });

      if (!start.ok || start.method !== 'thread/start') {
        throw new Error('thread/start failed');
      }

      await client.request({
        method: 'turn/start',
        params: {
          threadId: start.result.thread.id,
          input: 'Use the tool',
        },
      });
      await waitForNotification(
        notifications,
        (notification) =>
          notification.type === 'item/appended' && notification.item.type === 'tool.output.delta'
      );

      const interrupt = await client.request({
        method: 'turn/interrupt',
        params: { threadId: start.result.thread.id },
      });

      expect(interrupt).toEqual({
        method: 'turn/interrupt',
        ok: true,
        result: {
          turn: expect.objectContaining({ status: 'inProgress' }),
        },
      });
      await toolAborted.promise;
      await waitForNotification(
        notifications,
        (notification) => notification.type === 'turn/completed'
      );

      const read = await client.request({
        method: 'thread/read',
        params: { threadId: start.result.thread.id },
      });

      if (!read.ok || read.method !== 'thread/read') {
        throw new Error('thread/read failed');
      }

      expect(read.result.thread.status).toBe('idle');
      expect(read.result.thread.turns.at(-1)).toEqual(
        expect.objectContaining({ status: 'canceled' })
      );
      expect(read.result.thread.items.map((item) => item.type)).not.toContain('tool.error');
    } finally {
      unsubscribe();
      await transport.close();
    }
  });

  it('returns explicit transport errors for malformed HTTP requests', async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({ appServer: server });

    try {
      const response = await fetch(new URL('/request', transport.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${transport.capability}`,
          'content-type': 'application/json',
        },
        body: '{',
      });
      const body = (await response.json()) as AppServerResponse;

      expect(response.status).toBe(400);
      expect(body).toEqual({
        method: 'transport/request',
        ok: false,
        error: {
          code: 'INVALID_JSON',
          message: 'App Server transport request body must be valid JSON',
        },
      });
    } finally {
      await transport.close();
    }
  });

  it('does not authorize cross-origin browser requests or emit CORS headers', async () => {
    const server = createServer();
    const transport = await serveAppServerHttpTransport({ appServer: server });

    try {
      const preflight = await fetch(new URL('/request', transport.url), {
        method: 'OPTIONS',
        headers: {
          origin: 'http://127.0.0.1:8080',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });

      expect(preflight.status).toBe(401);
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
      expect(preflight.headers.get('access-control-allow-methods')).toBeNull();

      const response = await fetch(new URL('/request', transport.url), {
        method: 'POST',
        headers: {
          origin: 'http://127.0.0.1:8080',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'thread/start' }),
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          method: 'transport/request',
          ok: false,
          error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
        })
      );
    } finally {
      await transport.close();
    }
  });

  it('requires explicit opt-in before binding beyond loopback', async () => {
    const server = createServer();
    let unexpectedTransport: Awaited<ReturnType<typeof serveAppServerHttpTransport>> | undefined;
    let rejection: unknown;

    try {
      unexpectedTransport = await serveAppServerHttpTransport({
        appServer: server,
        host: '0.0.0.0',
      });
    } catch (cause) {
      rejection = cause;
    } finally {
      await unexpectedTransport?.close();
    }

    expect(rejection).toEqual(
      new Error('Non-loopback App Server binding requires explicit opt-in')
    );

    const optedIn = await serveAppServerHttpTransport({
      appServer: server,
      host: '0.0.0.0',
      allowRemoteBind: true,
    });

    try {
      expect(new URL(optedIn.url).hostname).toBe('0.0.0.0');
    } finally {
      await optedIn.close();
    }
  });

  it('redacts the capability from protocol error bodies', async () => {
    const appServer = {
      async request() {
        throw new Error(`upstream failure included ${TEST_CAPABILITY}`);
      },
      subscribe() {
        return () => undefined;
      },
    } satisfies AppServerClient;
    const transport = await serveAppServerHttpTransport({
      appServer,
      capability: TEST_CAPABILITY,
    });

    try {
      const response = await fetch(new URL('/request', transport.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_CAPABILITY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'thread/list' }),
      });
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).not.toContain(TEST_CAPABILITY);
      expect(JSON.parse(body)).toEqual({
        method: 'transport/request',
        ok: false,
        error: {
          code: 'UPSTREAM_REQUEST_FAILED',
          message: 'App Server request failed',
        },
      });
    } finally {
      await transport.close();
    }
  });

  it('rejects non-protocol client responses with an explicit transport error', async () => {
    const server = await listenWithPlainTextResponse();
    const client = new HttpAppServerClient({
      baseUrl: server.url,
      capability: TEST_CAPABILITY,
    });

    try {
      await expect(client.request({ method: 'thread/list' })).rejects.toMatchObject({
        name: 'AppServerTransportError',
        code: 'INVALID_RESPONSE_JSON',
      });
    } finally {
      await server.close();
    }
  });
});

function createServer(
  options: {
    readonly model?: ModelGateway;
    readonly toolRuntime?: ToolRuntime;
  } = {}
): AppServer {
  return new AppServer({
    threadManagerOptions: {
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
      runtimeFactory: () => ({
        model:
          options.model ??
          ({
            async *generate() {
              yield { type: 'message.completed', content: 'default response' };
            },
          } satisfies ModelGateway),
        toolRuntime: options.toolRuntime,
      }),
    },
  });
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

async function waitForNotification(
  notifications: readonly AppServerNotification[],
  predicate: (notification: AppServerNotification) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (notifications.some(predicate)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Timed out waiting for notification');
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

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function listenWithPlainTextResponse(): Promise<{
  readonly url: string;
  close(): Promise<void>;
}> {
  const { createServer } = await import('node:http');
  const httpServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('not json');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();

  if (!address || typeof address === 'string') {
    throw new Error('plain text test server did not bind to a TCP port');
  }

  return {
    url: `http://${address.address}:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((cause) => {
          if (cause) {
            reject(cause);
            return;
          }

          resolve();
        });
      });
    },
  };
}

class PushAppServerClient implements AppServerClient {
  private readonly listeners = new Set<AppServerNotificationListener>();

  async request(request: Parameters<AppServerClient['request']>[0]): Promise<AppServerResponse> {
    return {
      method: request.method,
      ok: false,
      error: { code: 'UNUSED', message: 'request not used' },
    };
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(notification: AppServerNotification): void {
    this.listeners.forEach((listener) => listener(notification));
  }
}

function itemNotification(id: string, seq: number): AppServerNotification {
  return {
    type: 'item/appended',
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      id,
      seq,
      type: 'assistant.message.completed',
      createdAtMs: seq,
      runId: 'run-1',
      turnId: 'turn-1',
      payload: { content: id },
    },
  };
}

type ParsedServerSentEvent = {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
};

async function openEventStream(url: string, lastEventId?: string) {
  const controller = new AbortController();
  const response = await fetch(new URL('/events', url), {
    headers: {
      authorization: `Bearer ${TEST_CAPABILITY}`,
      ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
    },
    signal: controller.signal,
  });
  if (!response.body) throw new Error('event stream body missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const nextDataEvent = async (): Promise<ParsedServerSentEvent> => {
    while (true) {
      const separator = buffer.indexOf('\n\n');
      if (separator >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const parsed = parseServerSentEvent(raw);
        if (parsed) return parsed;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('event stream ended before the expected event');
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
    }
  };
  return {
    abort: () => controller.abort(),
    nextDataEvent,
    async next(event: string): Promise<ParsedServerSentEvent> {
      while (true) {
        const parsed = await nextDataEvent();
        if (parsed.event === event) return parsed;
      }
    },
  };
}

function parseServerSentEvent(raw: string): ParsedServerSentEvent | undefined {
  if (raw.startsWith(':')) return undefined;
  const lines = raw.split('\n');
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
  if (!data) return undefined;
  const event = lines
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim();
  const id = lines
    .find((line) => line.startsWith('id:'))
    ?.slice('id:'.length)
    .trim();
  return { event: event || 'message', data, ...(id ? { id } : {}) };
}

function sseNotification(notification: AppServerNotification, id: string): string {
  return `id: ${id}\nevent: notification\ndata: ${JSON.stringify(notification)}\n\n`;
}

function sseControl(event: 'reset' | 'sync', id: string, cursor: number): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify({ streamId: 'stream', cursor })}\n\n`;
}
