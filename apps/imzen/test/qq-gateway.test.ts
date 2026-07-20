import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import { QQGateway, parseInbound } from '../src/qq-gateway.js';
import type { QQOutboundMessage } from '../src/types.js';

describe('QQ Gateway protocol projection', () => {
  it('normalizes direct and group messages and strips the group mention', () => {
    expect(
      parseInbound(
        'C2C_MESSAGE_CREATE',
        { id: 'm1', content: ' hello ', author: { user_openid: 'u1' } },
        100
      )
    ).toEqual({
      conversationId: 'c2c:u1',
      kind: 'c2c',
      messageId: 'm1',
      receivedAtMs: 100,
      text: 'hello',
      userId: 'u1',
    });
    expect(
      parseInbound(
        'GROUP_AT_MESSAGE_CREATE',
        {
          id: 'm2',
          content: '<@!bot> run tests',
          group_openid: 'g1',
          author: { member_openid: 'u1' },
        },
        101
      )
    ).toMatchObject({ conversationId: 'group:g1', text: 'run tests', userId: 'u1' });
  });

  it('rejects unsupported and incomplete messages', () => {
    expect(parseInbound('READY', {}, 0)).toBeUndefined();
    expect(
      parseInbound('C2C_MESSAGE_CREATE', { id: 'm', content: '', author: { user_openid: 'u' } }, 0)
    ).toBeUndefined();
  });

  it('uses a fresh frame chain after a failed websocket session', async () => {
    const sockets: FakeWebSocket[] = [];
    const messages: string[] = [];
    const gateway = createGateway(sockets);

    const start = gateway.start(async (message) => {
      messages.push(message.text);
    });
    await waitUntil(() => sockets.length === 1);
    sockets[0]!.emit('open');
    sockets[0]!.emit('message', { data: '{invalid json' });
    await waitUntil(() => sockets.length === 2);

    sockets[1]!.emit('open');
    sockets[1]!.emit('message', {
      data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }),
    });
    sockets[1]!.emit('message', {
      data: JSON.stringify({
        op: 0,
        t: 'READY',
        s: 1,
        d: { session_id: 'session-2' },
      }),
    });
    sockets[1]!.emit('message', {
      data: JSON.stringify({
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        s: 2,
        d: { id: 'm1', content: 'hello', author: { user_openid: 'u1' } },
      }),
    });

    await expect(start).resolves.toBeUndefined();
    await waitUntil(() => messages.includes('hello'));
    await gateway.stop();
  });

  it('removes each session abort listener before reconnecting', async () => {
    const sockets: FakeWebSocket[] = [];
    let stopSignal: AbortSignal | undefined;
    const gateway = createGateway(sockets, {
      sleep: async (_ms, signal) => {
        stopSignal = signal;
      },
      startupTimeoutMs: 60_000,
    });

    const start = gateway.start(async () => undefined);
    await waitUntil(() => sockets.length === 1);
    emitReady(sockets[0]!);
    await start;

    try {
      sockets[0]!.close();
      await waitUntil(() => sockets.length === 2);
      expect(stopSignal).toBeDefined();
      const listenerCount = getEventListeners(stopSignal!, 'abort').length;

      for (let session = 2; session <= 3; session += 1) {
        sockets[session - 1]!.close();
        await waitUntil(() => sockets.length === session + 1);
        expect(getEventListeners(stopSignal!, 'abort')).toHaveLength(listenerCount);
      }
    } finally {
      await gateway.stop();
    }
  });

  it('waits for the ordered frame task when stopping without a close event', async () => {
    const sockets: FakeWebSocket[] = [];
    let inboundStarted!: () => void;
    let finishInbound!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      inboundStarted = resolvePromise;
    });
    const inboundFinished = new Promise<void>((resolvePromise) => {
      finishInbound = resolvePromise;
    });
    const gateway = createGateway(sockets, {
      createSocket: () => new FakeWebSocket(false),
    });

    const start = gateway.start(async () => {
      inboundStarted();
      await inboundFinished;
    });
    await waitUntil(() => sockets.length === 1);
    emitReady(sockets[0]!);
    sockets[0]!.emit('message', {
      data: JSON.stringify({
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        s: 2,
        d: { id: 'm1', content: 'hello', author: { user_openid: 'u1' } },
      }),
    });
    await start;
    await started;

    let stopped = false;
    const stop = gateway.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(stopped).toBe(false);

    finishInbound();
    await stop;
    expect(stopped).toBe(true);
  });

  it('bounds ordered frame draining when an inbound handler never settles', async () => {
    const sockets: FakeWebSocket[] = [];
    let inboundStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      inboundStarted = resolvePromise;
    });
    const gateway = createGateway(sockets, {
      createSocket: () => new FakeWebSocket(false),
      shutdownFrameDrainTimeoutMs: 10,
    });

    const start = gateway.start(async () => {
      inboundStarted();
      await new Promise<void>(() => undefined);
    });
    await waitUntil(() => sockets.length === 1);
    emitReady(sockets[0]!);
    sockets[0]!.emit('message', {
      data: JSON.stringify({
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        s: 2,
        d: { id: 'm1', content: 'hello', author: { user_openid: 'u1' } },
      }),
    });
    await start;
    await started;

    await expect(settlesWithin(gateway.stop(), 250)).resolves.toBe(true);
    expect(sockets[0]!.readyState).toBe(3);
  });

  it('aborts a never-settling QQ fetch when stopping', async () => {
    let fetchStarted!: () => void;
    let requestSignal!: AbortSignal;
    const started = new Promise<void>((resolvePromise) => {
      fetchStarted = resolvePromise;
    });
    const gateway = new QQGateway({
      apiBase: 'https://api.sgroup.qq.com',
      credential: { appId: '1', appSecret: 'secret' },
      fetch: async (_input, init) => {
        requestSignal = init?.signal as AbortSignal;
        fetchStarted();
        return await new Promise<Response>(() => undefined);
      },
      requestTimeoutMs: 60_000,
    });
    const send = gateway.send(outbound('shutdown-fetch'));
    await started;

    await expect(gateway.stop()).resolves.toBeUndefined();
    expect(requestSignal.aborted).toBe(true);
    await expect(send).rejects.toBeDefined();
  });

  it('fails a never-settling QQ fetch after its finite timeout', async () => {
    const gateway = new QQGateway({
      apiBase: 'https://api.sgroup.qq.com',
      credential: { appId: '1', appSecret: 'secret' },
      fetch: async () => await new Promise<Response>(() => undefined),
      requestTimeoutMs: 5,
    });

    await expect(gateway.send(outbound('timeout-fetch'))).rejects.toThrow('timed out');
    await gateway.stop();
  });

  it('removes the request cancellation listener after successful fetches', async () => {
    const requestSignals: AbortSignal[] = [];
    const gateway = new QQGateway({
      apiBase: 'https://api.sgroup.qq.com',
      credential: { appId: '1', appSecret: 'secret' },
      fetch: async (input, init) => {
        requestSignals.push(init?.signal as AbortSignal);
        if (String(input).includes('getAppAccessToken')) {
          return jsonResponse({ access_token: 'token', expires_in: 7_200 });
        }
        return new Response('', { status: 200 });
      },
    });

    await gateway.send(outbound('listener-cleanup'));

    expect(requestSignals).toHaveLength(2);
    for (const signal of requestSignals) {
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    }
    await gateway.stop();
  });

  it('refreshes once after a message 401 and preserves msg_seq for later chunks', async () => {
    const requests: Array<{ input: string; body?: Record<string, unknown> }> = [];
    let tokenNumber = 0;
    let messageNumber = 0;
    const gateway = new QQGateway({
      apiBase: 'https://api.sgroup.qq.com',
      credential: { appId: '1', appSecret: 'secret' },
      fetch: async (input, init) => {
        const target = String(input);
        if (target.includes('getAppAccessToken')) {
          tokenNumber += 1;
          return jsonResponse({ access_token: `token-${tokenNumber}`, expires_in: 7_200 });
        }
        messageNumber += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ input: target, body });
        return messageNumber === 2
          ? new Response('', { status: 401 })
          : new Response('', { status: 200 });
      },
    });

    await gateway.send(outbound('x'.repeat(1_801)));

    expect(tokenNumber).toBe(2);
    expect(messageNumber).toBe(3);
    expect(requests[1]?.body?.msg_seq).toBe(requests[2]?.body?.msg_seq);
    expect(requests[1]?.body?.msg_seq).not.toBe(requests[0]?.body?.msg_seq);
    await gateway.stop();
  });

  it('does not refresh the token for ordinary production-to-sandbox discovery fallback', async () => {
    const sockets: FakeWebSocket[] = [];
    let tokenRequests = 0;
    let gatewayRequests = 0;
    const gateway = new QQGateway({
      apiBase: 'https://api.sgroup.qq.com',
      credential: { appId: '1', appSecret: 'secret' },
      fetch: async (input) => {
        const target = String(input);
        if (target.includes('getAppAccessToken')) {
          tokenRequests += 1;
          return jsonResponse({ access_token: 'token', expires_in: 7_200 });
        }
        gatewayRequests += 1;
        if (target.startsWith('https://api.sgroup.qq.com'))
          return new Response('', { status: 401 });
        return jsonResponse({ url: 'wss://gateway.qq.com/' });
      },
      sleep: async () => undefined,
      startupTimeoutMs: 1_000,
      websocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const start = gateway.start(async () => undefined);
    await waitUntil(() => sockets.length === 1);
    emitReady(sockets[0]!);
    await start;

    expect(tokenRequests).toBe(1);
    expect(gatewayRequests).toBe(2);
    await gateway.stop();
  });

  it('refreshes the token once when the selected gateway endpoint returns 401', async () => {
    const sockets: FakeWebSocket[] = [];
    let tokenRequests = 0;
    let sandboxRequests = 0;
    const gateway = new QQGateway({
      apiBase: 'https://api.sgroup.qq.com',
      credential: { appId: '1', appSecret: 'secret' },
      fetch: async (input) => {
        const target = String(input);
        if (target.includes('getAppAccessToken')) {
          tokenRequests += 1;
          return jsonResponse({ access_token: `token-${tokenRequests}`, expires_in: 7_200 });
        }
        if (target.startsWith('https://api.sgroup.qq.com')) {
          return new Response('', { status: 401 });
        }
        sandboxRequests += 1;
        if (sandboxRequests === 1) return new Response('', { status: 401 });
        return jsonResponse({ url: 'wss://gateway.qq.com/' });
      },
      sleep: async () => undefined,
      startupTimeoutMs: 1_000,
      websocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const start = gateway.start(async () => undefined);
    await waitUntil(() => sockets.length === 1);
    emitReady(sockets[0]!);
    await start;

    expect(tokenRequests).toBe(2);
    expect(sandboxRequests).toBe(2);
    await gateway.stop();
  });

  it('backs off after continued gateway 401s and recovers without hot-looping', async () => {
    const sockets: FakeWebSocket[] = [];
    const sleeps: Array<{ ms: number; release: () => void }> = [];
    let gatewayRequests = 0;
    let tokenRequests = 0;
    let serviceRecovered = false;
    const gateway = new QQGateway({
      apiBase: 'https://sandbox.api.sgroup.qq.com',
      credential: { appId: '1', appSecret: 'secret' },
      fetch: async (input) => {
        const target = String(input);
        if (target.includes('getAppAccessToken')) {
          tokenRequests += 1;
          return jsonResponse({ access_token: `token-${tokenRequests}`, expires_in: 7_200 });
        }
        gatewayRequests += 1;
        if (gatewayRequests === 1 || serviceRecovered) {
          return jsonResponse({ url: 'wss://gateway.qq.com/' });
        }
        return new Response('', { status: 401 });
      },
      sleep: async (ms) => {
        await new Promise<void>((resolvePromise) => {
          sleeps.push({ ms, release: resolvePromise });
        });
      },
      startupTimeoutMs: 1_000,
      websocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const start = gateway.start(async () => undefined);
    await waitUntil(() => sockets.length === 1);
    emitReady(sockets[0]!);
    await start;

    sockets[0]!.close();
    await waitUntil(() => sleeps.length === 1);
    expect(sleeps[0]?.ms).toBe(1_000);
    sleeps[0]!.release();

    await waitUntil(() => gatewayRequests === 3 || sleeps.length === 2);
    expect(gatewayRequests).toBe(3);
    expect(tokenRequests).toBe(2);
    expect(sleeps[1]?.ms).toBe(2_000);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(gatewayRequests).toBe(3);

    serviceRecovered = true;
    sleeps[1]!.release();
    await waitUntil(() => sockets.length === 2);
    expect(tokenRequests).toBe(3);
    expect(gatewayRequests).toBe(4);
    await gateway.stop();
  });
});

class FakeWebSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(private readonly emitCloseOnClose = true) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.emitCloseOnClose) this.emit('close');
  }

  emit(type: string, event: unknown = {}): void {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(_data: string): void {}
}

type GatewayHarnessOptions = {
  readonly createSocket?: () => FakeWebSocket;
  readonly shutdownFrameDrainTimeoutMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly startupTimeoutMs?: number;
};

function createGateway(sockets: FakeWebSocket[], options: GatewayHarnessOptions = {}): QQGateway {
  return new QQGateway({
    apiBase: 'https://api.sgroup.qq.com',
    credential: { appId: '1', appSecret: 'secret' },
    fetch: async (input) => {
      if (String(input).includes('getAppAccessToken')) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 7_200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ url: 'wss://gateway.qq.com/' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    sleep: options.sleep ?? (async () => undefined),
    ...(options.shutdownFrameDrainTimeoutMs === undefined
      ? {}
      : { shutdownFrameDrainTimeoutMs: options.shutdownFrameDrainTimeoutMs }),
    startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
    websocketFactory: () => {
      const socket = options.createSocket?.() ?? new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
}

function emitReady(socket: FakeWebSocket): void {
  socket.emit('open');
  socket.emit('message', {
    data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } }),
  });
}

function outbound(text: string): QQOutboundMessage {
  return {
    conversationId: 'c2c:user',
    deliveryId: 'qq:delivery:turn',
    receivedAtMs: Date.now(),
    replyToMessageId: 'message',
    text,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error('Timed out waiting for gateway work');
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
