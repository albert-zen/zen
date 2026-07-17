import { describe, expect, it } from 'vitest';

import {
  AppServer,
  type AppServerClient,
  type AppServerNotificationListener,
  type AppServerRequestInput,
  type AppServerResponse,
  type AppServerSubscription,
  BrowserAppServerTransportClient,
  HttpAppServerClient,
  WebUiClient,
  WebUiLifecycleCanceledError,
  serveAppServerHttpTransport,
  type ModelGateway,
} from './test-exports.js';

describe('Web UI client', () => {
  it('uses same-origin browser routes without receiving a capability', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    let eventUrl: string | undefined;
    const eventSource = new RecordingEventSource();
    const client = new BrowserAppServerTransportClient({
      fetch: (async (input, init) => {
        requests.push({ input, init });
        return new Response(
          JSON.stringify({
            method: 'thread/list',
            ok: true,
            result: { threads: [] },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
      createEventSource: (url) => {
        eventUrl = url;
        return eventSource;
      },
    });

    await client.request({ method: 'thread/list' });
    const unsubscribe = client.subscribe(() => undefined);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe('/request');
    expect(requests[0]?.init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(eventUrl).toBe('/events');

    unsubscribe();
  });

  it('surfaces transport failures and subscription lifecycle events through public browser callbacks', async () => {
    const statuses: Array<{ status: string; error?: unknown }> = [];
    const events = new ControllableEventSource();
    const notifications: string[] = [];
    const client = new BrowserAppServerTransportClient({
      fetch: (async () => new Response('proxy unavailable', { status: 503 })) as typeof fetch,
      createEventSource: () => events,
      onSubscriptionStatus: (status, error) => statuses.push({ status, error }),
    });

    await expect(client.request({ method: 'thread/list' })).rejects.toThrow(
      'App Server request failed with HTTP 503: proxy unavailable'
    );
    const unsubscribe = client.subscribe((notification) => notifications.push(notification.type));
    events.open();
    events.emitNotification({
      type: 'thread/started',
      thread: { id: 'thread-1', status: 'idle', turns: [], items: [] },
    });
    const streamFailure = new Event('error');
    events.fail(streamFailure);
    unsubscribe();

    expect(notifications).toEqual(['thread/started']);
    expect(statuses).toEqual([
      { status: 'connected' },
      { status: 'failed', error: streamFailure },
      { status: 'disconnected' },
    ]);
    expect(events.closed).toBe(true);
  });

  it('waits for browser EventSource readiness before a thread request can overtake it', async () => {
    const events = new ControllableEventSource();
    const requests: AppServerRequestInput[] = [];
    const client = new BrowserAppServerTransportClient({
      createEventSource: () => events,
      fetch: (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as AppServerRequestInput);
        return new Response(
          JSON.stringify({
            method: 'thread/start',
            ok: true,
            result: { thread: { id: 'thread-1', status: 'idle', turns: [], items: [] } },
          })
        );
      }) as typeof fetch,
    });

    const unsubscribe = client.subscribe(() => undefined);
    const pending = client.request({ method: 'thread/start' });
    await Promise.resolve();
    expect(requests).toEqual([]);

    events.open();
    await pending;
    expect(requests).toEqual([{ method: 'thread/start' }]);
    unsubscribe();
  });

  it('fails a request waiting on an errored subscription without sending its POST', async () => {
    const events = new ControllableEventSource();
    let fetchCalls = 0;
    const statuses: string[] = [];
    const client = new BrowserAppServerTransportClient({
      createEventSource: () => events,
      fetch: (async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({ method: 'thread/list', ok: true, result: { threads: [] } })
        );
      }) as typeof fetch,
      onSubscriptionStatus: (status) => statuses.push(status),
    });
    const unsubscribe = client.subscribe(() => undefined);
    const pending = client.request({ method: 'thread/list' });
    const rejected = expect(pending).rejects.toThrow(
      'Browser event subscription failed before request'
    );
    events.fail(new Event('error'));
    await rejected;

    expect(fetchCalls).toBe(0);
    expect(statuses).toEqual(['failed']);
    unsubscribe();
  });

  it('blocks requests during browser SSE reconnect and releases them on the next open', async () => {
    const events = new ControllableEventSource();
    let fetchCalls = 0;
    const client = new BrowserAppServerTransportClient({
      createEventSource: () => events,
      fetch: (async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({ method: 'thread/list', ok: true, result: { threads: [] } })
        );
      }) as typeof fetch,
    });
    const unsubscribe = client.subscribe(() => undefined);
    events.open();
    events.fail(new Event('error'));

    const pending = client.request({ method: 'thread/list' });
    await Promise.resolve();
    expect(fetchCalls).toBe(0);
    events.open();
    await pending;

    expect(fetchCalls).toBe(1);
    unsubscribe();
  });

  it('rejects an open-generation request invalidated synchronously by reconnect', async () => {
    const events = new ControllableEventSource();
    let fetchCalls = 0;
    const client = new BrowserAppServerTransportClient({
      createEventSource: () => events,
      fetch: (async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({ method: 'thread/list', ok: true, result: { threads: [] } })
        );
      }) as typeof fetch,
    });
    const unsubscribe = client.subscribe(() => undefined);
    events.open();

    const invalidated = client.request({ method: 'thread/list' });
    const rejected = expect(invalidated).rejects.toThrow(
      'Browser event subscription changed before request'
    );
    events.fail(new Event('error'));
    events.open();
    await rejected;
    expect(fetchCalls).toBe(0);

    await client.request({ method: 'thread/list' });
    expect(fetchCalls).toBe(1);
    unsubscribe();
  });

  it('rejects an open-generation request invalidated synchronously by disconnect', async () => {
    const events = new ControllableEventSource();
    let fetchCalls = 0;
    const client = new BrowserAppServerTransportClient({
      createEventSource: () => events,
      fetch: (async () => {
        fetchCalls += 1;
        return new Response('{}');
      }) as typeof fetch,
    });
    const unsubscribe = client.subscribe(() => undefined);
    events.open();

    const invalidated = client.request({ method: 'thread/list' });
    const rejected = expect(invalidated).rejects.toThrow(
      'Browser event subscription changed before request'
    );
    unsubscribe();
    events.open();
    await rejected;

    expect(fetchCalls).toBe(0);
  });

  it('disconnect rejects pending browser readiness and stale open cannot revive it', async () => {
    const events = new ControllableEventSource();
    const statuses: string[] = [];
    const notifications: string[] = [];
    let fetchCalls = 0;
    const client = new BrowserAppServerTransportClient({
      createEventSource: () => events,
      fetch: (async () => {
        fetchCalls += 1;
        return new Response('{}');
      }) as typeof fetch,
      onSubscriptionStatus: (status) => statuses.push(status),
    });
    const unsubscribe = client.subscribe((notification) => notifications.push(notification.type));
    const pending = client.request({ method: 'thread/list' });
    const rejected = expect(pending).rejects.toThrow('Browser event subscription disconnected');
    unsubscribe();
    await rejected;
    events.open();
    events.emitNotification({
      type: 'thread/started',
      thread: { id: 'stale-thread', status: 'idle', turns: [], items: [] },
    });

    expect(fetchCalls).toBe(0);
    expect(statuses).toEqual(['disconnected']);
    expect(notifications).toEqual([]);
  });

  it('connects through real transport and projects streamed turn notifications', async () => {
    const server = new AppServer({
      threadManagerOptions: {
        generateThreadId: sequence('thread'),
        generateRunId: sequence('run'),
        generateTurnId: sequence('turn'),
        generateItemId: sequence('item'),
        clock: () => 1000,
        runtimeFactory: () => ({
          model: {
            async *generate() {
              yield { type: 'text.delta', text: 'Hel' };
              yield { type: 'text.delta', text: 'lo' };
              yield { type: 'message.completed', content: 'Hello' };
            },
          } satisfies ModelGateway,
        }),
      },
    });
    const transport = await serveAppServerHttpTransport({ appServer: server });
    const client = new HttpAppServerClient({
      baseUrl: transport.url,
      capability: transport.capability,
    });
    const webUi = new WebUiClient({ client });

    try {
      await webUi.connect();
      expect(webUi.getSnapshot().connection.status).toBe('connected');
      expect(webUi.getSnapshot().state.currentThread?.id).toBe('thread-1');

      await webUi.submitMessage('Hello');
      await waitForStatus(webUi, 'connected');

      const snapshot = webUi.getSnapshot();
      expect(snapshot.state.currentThread?.status).toBe('idle');
      expect([...snapshot.state.timelineRows]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'user', content: 'Hello' }),
          expect.objectContaining({ type: 'assistant', content: 'Hello' }),
        ])
      );
    } finally {
      webUi.disconnect();
      await transport.close();
    }
  });

  it('shows failed and disconnected states outside the item projection', async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });

    await webUi.connect();
    await webUi.submitMessage('fail');
    client.emit({
      type: 'turn/failed',
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        runId: 'run-1',
        status: 'failed',
        itemIds: [],
      },
      error: {
        code: 'MODEL_FAILED',
        message: 'model failed',
      },
    });

    expect(webUi.getSnapshot()).toEqual(
      expect.objectContaining({
        connection: {
          mode: 'real',
          status: 'failed',
          message: 'model failed',
        },
        state: expect.objectContaining({
          currentThread: expect.objectContaining({ status: 'failed' }),
        }),
      })
    );

    webUi.disconnect();

    expect(webUi.getSnapshot().connection).toEqual({
      mode: 'real',
      status: 'disconnected',
    });
  });

  it('resumes an existing thread by reading it through the client', async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });

    await webUi.connect({ threadId: 'thread-1' });

    expect(webUi.getSnapshot()).toEqual(
      expect.objectContaining({
        connection: { mode: 'real', status: 'connected' },
        state: expect.objectContaining({
          currentThread: {
            id: 'thread-1',
            status: 'idle',
            turns: [],
          },
        }),
      })
    );
    expect(client.requests.map((request) => request.method)).toEqual(['thread/read']);
  });

  it('owns one stream across start, resume, reconnect, disconnect, and disposal', async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });

    await webUi.connect();
    await webUi.startThread();
    await webUi.resumeThread('thread-1');
    expect(client.activeSubscriptions).toBe(1);
    expect(client.subscribeCalls).toBe(1);

    await webUi.connect({ threadId: 'thread-1' });
    expect(client.activeSubscriptions).toBe(1);
    expect(client.subscribeCalls).toBe(2);
    expect(client.unsubscribeCalls).toBe(1);

    webUi.disconnect();
    webUi.disconnect();
    webUi.dispose();
    expect(client.activeSubscriptions).toBe(0);
    expect(client.unsubscribeCalls).toBe(2);
  });

  it('does not publish repeated identical start or resume snapshots', async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });
    let listenerCalls = 0;
    webUi.subscribe(() => {
      listenerCalls += 1;
    });
    await webUi.connect();
    const connectedSnapshot = webUi.getSnapshot();
    const connectedCalls = listenerCalls;

    await webUi.startThread();
    expect(webUi.getSnapshot()).toBe(connectedSnapshot);
    expect(listenerCalls).toBe(connectedCalls);

    await webUi.resumeThread('thread-1');
    expect(webUi.getSnapshot()).toBe(connectedSnapshot);
    expect(listenerCalls).toBe(connectedCalls);
  });

  it('does not publish duplicate terminal notifications', async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });
    let calls = 0;
    webUi.subscribe(() => {
      calls += 1;
    });
    await webUi.connect();
    const completed = {
      type: 'turn/completed' as const,
      threadId: 'thread-1',
      turn: { id: 'turn-1', runId: 'run-1', status: 'completed' as const, itemIds: [] },
    };
    client.emit(completed);
    const snapshot = webUi.getSnapshot();
    const callsAfterCompletion = calls;
    client.emit(completed);
    expect(webUi.getSnapshot()).toBe(snapshot);
    expect(calls).toBe(callsAfterCompletion);
  });

  it('keeps stale connect completions from reviving a disconnected or newer lifecycle', async () => {
    const client = new DeferredConnectClient();
    const webUi = new WebUiClient({ client });

    const stale = webUi.connect();
    webUi.disconnect();
    client.resolveNext();
    await expect(stale).rejects.toBeInstanceOf(WebUiLifecycleCanceledError);
    expect(webUi.getSnapshot().connection.status).toBe('disconnected');
    expect(client.activeSubscriptions).toBe(0);

    const first = webUi.connect();
    const second = webUi.connect({ threadId: 'thread-2' });
    client.resolveNext('thread-1');
    client.resolveNext('thread-2');
    await expect(first).rejects.toBeInstanceOf(WebUiLifecycleCanceledError);
    await expect(second).resolves.toBeUndefined();
    expect(webUi.getSnapshot().connection).toEqual({ mode: 'real', status: 'connected' });
    expect(webUi.getSnapshot().state.currentThread?.id).toBe('thread-2');
    expect(client.activeSubscriptions).toBe(1);
    webUi.dispose();
  });

  it('cancels stale public start and resume loads across lifecycle replacement', async () => {
    const client = new DeferredConnectClient();
    const webUi = new WebUiClient({ client });
    const initial = webUi.connect();
    client.resolveNext('thread-1');
    await initial;

    const staleStart = webUi.startThread();
    webUi.disconnect();
    client.resolveNext('stale-start');
    await expect(staleStart).rejects.toBeInstanceOf(WebUiLifecycleCanceledError);
    expect(webUi.getSnapshot().state.currentThread?.id).toBe('thread-1');

    const reconnect = webUi.connect({ threadId: 'thread-2' });
    client.resolveNext('thread-2');
    await reconnect;
    const staleResume = webUi.resumeThread('thread-1');
    const replacement = webUi.connect({ threadId: 'thread-3' });
    client.resolveNext('stale-resume');
    client.resolveNext('thread-3');
    await expect(staleResume).rejects.toBeInstanceOf(WebUiLifecycleCanceledError);
    await expect(replacement).resolves.toBeUndefined();
    expect(webUi.getSnapshot().state.currentThread?.id).toBe('thread-3');

    const staleReplacement = webUi.resumeThread('thread-1');
    webUi.dispose();
    client.resolveNext('late-after-dispose');
    await expect(staleReplacement).rejects.toBeInstanceOf(WebUiLifecycleCanceledError);
  });

  it('submits the approval tuple supplied by the pending approval row', async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });

    await webUi.resolveApproval(
      { approvalId: 'approval-7', threadId: 'thread-4', turnId: 'turn-9' },
      'decline'
    );

    expect(client.requests.at(-1)).toEqual({
      method: 'approval/resolve',
      params: {
        approvalId: 'approval-7',
        threadId: 'thread-4',
        turnId: 'turn-9',
        decision: 'decline',
      },
    });
  });

  it('allows the same approval action to be retried after a protocol rejection', async () => {
    const client = new RejectOnceApprovalClient();
    const webUi = new WebUiClient({ client });
    const approval = { approvalId: 'approval-7', threadId: 'thread-4', turnId: 'turn-9' };

    await expect(webUi.resolveApproval(approval, 'approveOnce')).rejects.toThrow('stale approval');
    await expect(webUi.resolveApproval(approval, 'approveOnce')).resolves.toBeUndefined();

    expect(client.requests).toEqual([
      { method: 'approval/resolve', params: { ...approval, decision: 'approveOnce' } },
      { method: 'approval/resolve', params: { ...approval, decision: 'approveOnce' } },
    ]);
  });

  it('keeps no-op actions silent and exposes rejected runtime actions as connection failures', async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });
    const demoUi = new WebUiClient({ client, mode: 'demo' });

    expect(demoUi.getSnapshot().connection.mode).toBe('demo');

    await webUi.submitMessage('   ');
    await webUi.interruptThread();
    await webUi.retryTurn();
    expect(client.requests).toEqual([]);

    await webUi.connect();
    client.reject('turn/start', 'turn start rejected');
    await expect(webUi.submitMessage('start')).rejects.toThrow('turn start rejected');
    expect(webUi.getSnapshot().connection).toMatchObject({
      status: 'failed',
      message: 'turn start rejected',
    });

    client.reject('turn/interrupt', 'interrupt rejected');
    await expect(webUi.interruptThread()).rejects.toThrow('interrupt rejected');
    client.reject('turn/retry', 'retry rejected');
    await expect(webUi.retryTurn('turn-1')).rejects.toThrow('retry rejected');
  });

  it('rejects unexpected list responses instead of treating another operation as a thread list', async () => {
    const webUi = new WebUiClient({
      client: {
        async request() {
          return {
            method: 'thread/start',
            ok: true,
            result: { thread: { id: 'thread-1', status: 'idle', turns: [], items: [] } },
          } as AppServerResponse;
        },
        subscribe() {
          return () => undefined;
        },
      },
    });

    await expect(webUi.listThreads()).rejects.toThrow(
      'Expected thread/list response, received thread/start'
    );
  });

  it('sends successful interrupt and retry commands for the active thread', async () => {
    const client = new RecordingClient();
    const webUi = new WebUiClient({ client });

    await webUi.connect();
    await webUi.interruptThread();
    await webUi.retryTurn('turn-9');

    expect(client.requests.slice(-2)).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'thread-1' } },
      { method: 'turn/retry', params: { threadId: 'thread-1', turnId: 'turn-9' } },
    ]);
  });
});

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

async function waitForStatus(
  client: WebUiClient,
  status: ReturnType<WebUiClient['getSnapshot']>['connection']['status']
): Promise<void> {
  if (client.getSnapshot().connection.status === status) return;

  await new Promise<void>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${status}`));
    }, 1_000);
    unsubscribe = client.subscribe((snapshot) => {
      if (snapshot.connection.status === status) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

class RecordingClient implements AppServerClient {
  private listener?: AppServerNotificationListener;
  activeSubscriptions = 0;
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  readonly requests: Parameters<AppServerClient['request']>[0][] = [];
  private readonly rejections = new Map<string, string>();

  reject(method: string, message: string): void {
    this.rejections.set(method, message);
  }

  request(request: Parameters<AppServerClient['request']>[0]) {
    this.requests.push(request);
    const message = this.rejections.get(request.method);
    if (message) {
      return Promise.resolve({
        method: request.method,
        ok: false,
        error: { code: 'REJECTED', message },
      } as AppServerResponse);
    }

    if (request.method === 'thread/start') {
      return Promise.resolve({
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
      } as const);
    }

    if (request.method === 'thread/read') {
      return Promise.resolve({
        method: 'thread/read',
        ok: true,
        result: {
          thread: {
            id: 'thread-1',
            status: 'idle',
            turns: [],
            items: [],
          },
        },
      } as const);
    }

    if (request.method === 'turn/start') {
      this.emit({
        type: 'turn/started',
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          runId: 'run-1',
          status: 'inProgress',
          itemIds: [],
        },
      });

      return Promise.resolve({
        method: 'turn/start',
        ok: true,
        result: {
          turn: {
            id: 'turn-1',
            runId: 'run-1',
            status: 'inProgress',
            itemIds: [],
          },
        },
      } as const);
    }

    if (request.method === 'turn/interrupt' || request.method === 'turn/retry') {
      return Promise.resolve({
        method: request.method,
        ok: true,
        result: {
          turn: {
            id: 'turn-1',
            runId: 'run-1',
            status: request.method === 'turn/retry' ? 'inProgress' : 'canceled',
            itemIds: [],
          },
        },
      } as AppServerResponse);
    }

    if (request.method === 'approval/resolve') {
      const params = request.params as {
        readonly approvalId: string;
        readonly decision: 'approveOnce' | 'decline';
      };
      return Promise.resolve({
        method: 'approval/resolve',
        ok: true,
        result: {
          approvalId: params.approvalId,
          decision: params.decision,
        },
      } as const);
    }

    return Promise.resolve({
      method: request.method,
      ok: false,
      error: {
        code: 'UNKNOWN_METHOD',
        message: `Unknown method ${request.method}`,
      },
    } as const);
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    this.listener = listener;
    this.subscribeCalls += 1;
    this.activeSubscriptions += 1;

    return () => {
      this.listener = undefined;
      this.activeSubscriptions -= 1;
      this.unsubscribeCalls += 1;
    };
  }

  emit(notification: Parameters<AppServerNotificationListener>[0]): void {
    this.listener?.(notification);
  }
}

class RejectOnceApprovalClient implements AppServerClient {
  readonly requests: AppServerRequestInput[] = [];
  private attempts = 0;

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    this.requests.push(request);
    this.attempts += 1;
    if (this.attempts === 1) {
      return {
        method: 'approval/resolve',
        ok: false,
        error: { code: 'STALE', message: 'stale approval' },
      };
    }
    const params = request.params as {
      readonly approvalId: string;
      readonly decision: 'approveOnce' | 'decline';
    };
    return {
      method: 'approval/resolve',
      ok: true,
      result: { approvalId: params.approvalId, decision: params.decision },
    };
  }

  subscribe(_listener: AppServerNotificationListener): AppServerSubscription {
    return () => undefined;
  }
}
class DeferredConnectClient implements AppServerClient {
  private readonly pending: Array<(threadId: string) => void> = [];
  activeSubscriptions = 0;

  request(request: AppServerRequestInput): Promise<AppServerResponse> {
    return new Promise((resolve) => {
      this.pending.push((threadId) =>
        resolve({
          method: request.method,
          ok: true,
          result: { thread: { id: threadId, status: 'idle', turns: [], items: [] } },
        } as AppServerResponse)
      );
    });
  }

  resolveNext(threadId = 'thread-1'): void {
    this.pending.shift()?.(threadId);
  }

  subscribe(_listener: AppServerNotificationListener): AppServerSubscription {
    this.activeSubscriptions += 1;
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        this.activeSubscriptions -= 1;
      }
    };
  }
}

class RecordingEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  addEventListener(_type: string, _listener: (event: MessageEvent<string>) => void): void {}

  close(): void {}
}

class ControllableEventSource extends RecordingEventSource {
  private notificationListener?: (event: MessageEvent<string>) => void;
  closed = false;

  override addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    if (type === 'notification') this.notificationListener = listener;
  }

  override close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event('open'));
  }

  fail(event: Event): void {
    this.onerror?.(event);
  }

  emitNotification(notification: Parameters<AppServerNotificationListener>[0]): void {
    this.notificationListener?.({ data: JSON.stringify(notification) } as MessageEvent<string>);
  }
}
