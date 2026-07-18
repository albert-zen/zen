import { describe, expect, it } from 'vitest';

import {
  AgentInteractionSession,
  AgentInteractionSessionDisposedError,
  AppServer,
  type AppServerClient,
  type AppServerNotificationListener,
  type AppServerRequestInput,
  type AppServerResponse,
  type AppServerSubscription,
  createDemoAppServer,
  renderTerminalTranscript,
  type ModelGateway,
  type ThreadSnapshot,
} from './test-exports.js';

describe('AgentInteractionSession', () => {
  it('replays notifications that arrive while the startup snapshot is in flight', async () => {
    const client = new SessionHandoffClient();
    const session = new AgentInteractionSession({ client });
    const starting = session.start();
    client.emit({
      type: 'item/appended',
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: sessionItem('item-2', 2),
    });
    client.resolveList({
      id: 'thread-1',
      status: 'running',
      turns: [],
      items: [sessionItem('item-1', 1)],
    });

    const snapshot = await starting;

    expect([...(snapshot.thread?.items ?? [])].map((item) => item.id)).toEqual([
      'item-1',
      'item-2',
    ]);
    session.dispose();
  });

  it('settles a submit waiter from an authoritative reconnect snapshot', async () => {
    const client = new DeferredSessionClient(threadSnapshot());
    const session = new AgentInteractionSession({ client });
    await session.start();
    const observed = session.submit('finish while offline').then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await client.waitForTurnRequest();

    client.emit({
      type: 'sync/reset',
      threads: [
        {
          id: 'thread-1',
          status: 'idle',
          turns: [{ id: 'turn-2', runId: 'run-2', status: 'completed', itemIds: ['terminal-1'] }],
          items: [sessionItem('terminal-1', 1)],
        },
      ],
    });
    await Promise.resolve();
    const waiterCount = session.getPendingCompletionWaiterCountForTest();
    if (waiterCount > 0) session.dispose();

    expect(await observed).toBe('resolved');
    expect(waiterCount).toBe(0);
    session.dispose();
  });

  it('settles concurrent submit waiters only for their bound turn', async () => {
    const client = new ConcurrentSubmitClient();
    const session = new AgentInteractionSession({ client });
    await session.start();
    let secondSettled = false;
    const first = session.submit('first');
    const second = session.submit('second').finally(() => {
      secondSettled = true;
    });
    await client.waitForTurnRequests(2);
    client.resolveTurnRequest(0, 'turn-1');
    client.resolveTurnRequest(1, 'turn-2');
    await Promise.resolve();

    client.emit({
      type: 'turn/completed',
      threadId: 'thread-1',
      turn: { id: 'turn-1', runId: 'run-1', status: 'completed', itemIds: [] },
    });
    await first;
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    client.emit({
      type: 'turn/completed',
      threadId: 'thread-1',
      turn: { id: 'turn-2', runId: 'run-2', status: 'completed', itemIds: [] },
    });
    await second;
    expect(session.getPendingCompletionWaiterCountForTest()).toBe(0);
    session.dispose();
  });

  it('caches a terminal by turn id until its response binds the waiter', async () => {
    const client = new ConcurrentSubmitClient();
    const session = new AgentInteractionSession({ client });
    await session.start();
    const pending = session.submit('terminal before response');
    await client.waitForTurnRequests(1);
    client.emit({
      type: 'turn/completed',
      threadId: 'thread-1',
      turn: { id: 'turn-1', runId: 'run-1', status: 'completed', itemIds: [] },
    });
    client.resolveTurnRequest(0, 'turn-1');

    await pending;
    expect(session.getPendingCompletionWaiterCountForTest()).toBe(0);
    session.dispose();
  });

  it('does not apply an early terminal to a response for another turn', async () => {
    const client = new ConcurrentSubmitClient();
    const session = new AgentInteractionSession({ client });
    await session.start();
    let settled = false;
    const pending = session.submit('bind another turn').finally(() => {
      settled = true;
    });
    await client.waitForTurnRequests(1);
    client.emit({
      type: 'turn/completed',
      threadId: 'thread-1',
      turn: { id: 'turn-1', runId: 'run-1', status: 'completed', itemIds: [] },
    });
    client.resolveTurnRequest(0, 'turn-2');
    await Promise.resolve();
    expect(settled).toBe(false);

    client.emit({
      type: 'turn/completed',
      threadId: 'thread-1',
      turn: { id: 'turn-2', runId: 'run-2', status: 'completed', itemIds: [] },
    });
    await pending;
    session.dispose();
  });

  it('rejects a bound waiter when a different thread snapshot replaces it', async () => {
    const client = new ConcurrentSubmitClient();
    const session = new AgentInteractionSession({ client });
    await session.start();
    const pending = session.submit('replace thread');
    await client.waitForTurnRequests(1);
    client.resolveTurnRequest(0, 'turn-1');
    await Promise.resolve();
    client.emit({
      type: 'thread/started',
      thread: { id: 'thread-2', status: 'idle', turns: [], items: [] },
    });

    await expect(pending).rejects.toThrow('Thread replaced before turn completion');
    expect(session.getPendingCompletionWaiterCountForTest()).toBe(0);
    session.dispose();
  });

  it('rejects an unbound waiter when an authoritative reset invalidates response binding', async () => {
    const client = new ConcurrentSubmitClient();
    const session = new AgentInteractionSession({ client });
    await session.start();
    const pending = session.submit('reset before response');
    await client.waitForTurnRequests(1);
    client.emit({ type: 'sync/reset', threads: [threadSnapshot()] });
    client.resolveTurnRequest(0, 'turn-1');

    await expect(pending).rejects.toThrow('Recovery occurred before turn binding');
    expect(session.getPendingCompletionWaiterCountForTest()).toBe(0);
    session.dispose();
  });

  it('discards a submit waiter when turn/start rejects', async () => {
    const client = new DeferredSessionClient(threadSnapshot(), {
      turnFailure: new Error('submit request failed'),
    });
    const session = new AgentInteractionSession({ client });
    await session.start();

    await expect(session.submit('request failure')).rejects.toThrow('submit request failed');
    expect(session.getPendingCompletionWaiterCountForTest()).toBe(0);
    session.dispose();
    session.dispose();
  });

  it('discards a retry waiter when turn/retry rejects', async () => {
    const client = new DeferredSessionClient(recoverableThreadSnapshot(), {
      turnFailure: new Error('retry request failed'),
    });
    const session = new AgentInteractionSession({ client });
    await session.start();

    await expect(session.retryLatestRecoverableTurn()).rejects.toThrow('retry request failed');
    expect(session.getPendingCompletionWaiterCountForTest()).toBe(0);
    session.dispose();
  });

  it('settles a request failure once when disposal races its registered waiter', async () => {
    const client = new DeferredSessionClient(threadSnapshot(), { deferTurnFailure: true });
    const session = new AgentInteractionSession({ client });
    await session.start();
    const pending = session.submit('race');
    await client.waitForTurnRequest();
    let settlements = 0;
    const observed = pending.then(
      () => new Error('unexpected success'),
      (cause) => {
        settlements += 1;
        return cause;
      }
    );

    session.dispose();
    client.rejectTurnRequest(new Error('raced request failure'));

    const result = await observed;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('raced request failure');
    expect(settlements).toBe(1);
    expect(session.getPendingCompletionWaiterCountForTest()).toBe(0);
    session.dispose();
    expect(client.unsubscribeCalls).toBe(1);
  });

  it('rejects pending submit waiters and future async operations after idempotent disposal', async () => {
    const client = new DeferredSessionClient(threadSnapshot());
    const session = new AgentInteractionSession({ client });
    await session.start();
    const pending = session.submit('wait for completion');
    await client.waitForTurnRequest();
    const rejection = expect(pending).rejects.toBeInstanceOf(AgentInteractionSessionDisposedError);

    session.dispose();
    session.dispose();

    await rejection;
    await expect(session.listThreads()).rejects.toBeInstanceOf(
      AgentInteractionSessionDisposedError
    );
    expect(client.unsubscribeCalls).toBe(1);
  });

  it('rejects pending retry waiters and ignores late notifications after disposal', async () => {
    const client = new DeferredSessionClient(recoverableThreadSnapshot());
    const session = new AgentInteractionSession({ client });
    await session.start();
    const beforeDispose = session.getSnapshot();
    const pending = session.retryLatestRecoverableTurn();
    await client.waitForTurnRequest();
    const rejection = expect(pending).rejects.toBeInstanceOf(AgentInteractionSessionDisposedError);

    session.dispose();
    client.emit({
      type: 'turn/completed',
      threadId: 'thread-1',
      turn: { id: 'turn-2', runId: 'run-2', status: 'completed', itemIds: [] },
    });

    await rejection;
    expect(session.getSnapshot()).toBeDefined();
    expect(session.getSnapshot().state).toBe(beforeDispose.state);
  });

  it('does not emit when a resumed snapshot is unchanged', async () => {
    const session = new AgentInteractionSession({
      client: createDemoAppServer({
        appServerOptions: { threadManagerOptions: deterministicIds() },
      }),
    });
    const started = await session.start();
    let calls = 0;
    session.observe(() => {
      calls += 1;
    });

    await session.resumeThread(started.thread?.id ?? 'missing');

    expect(calls).toBe(0);
    session.dispose();
  });

  it('starts a thread and submits turns through an App Server client', async () => {
    const session = new AgentInteractionSession({
      client: createDemoAppServer({
        appServerOptions: { threadManagerOptions: deterministicIds() },
      }),
    });

    const started = await session.start();
    expect(started.thread).toEqual(expect.objectContaining({ id: 'thread-1', status: 'idle' }));

    const submitted = await session.submit('hello from tui');

    expect(submitted.thread).toEqual(expect.objectContaining({ id: 'thread-1', status: 'idle' }));
    expect([...submitted.timelineRows]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'user', content: 'hello from tui' }),
        expect.objectContaining({
          type: 'assistant',
          content: 'Zen demo response: hello from tui',
        }),
      ])
    );

    session.dispose();
  });

  it('provides timeline rows usable by the terminal transcript renderer', async () => {
    const session = new AgentInteractionSession({
      client: createDemoAppServer({
        appServerOptions: { threadManagerOptions: deterministicIds() },
      }),
    });

    await session.start();
    const submitted = await session.submit('use tool');
    const transcript = renderTerminalTranscript(submitted.timelineRows);

    expect(transcript).toEqual(
      expect.arrayContaining([
        'You: use tool',
        expect.stringContaining('Tool call demo.lookup'),
        expect.stringContaining('Tool result demo.lookup'),
        expect.stringContaining('Zen: Demo tool returned'),
      ])
    );

    session.dispose();
  });

  it('lists saved threads with metadata derived from protocol snapshots', async () => {
    const session = new AgentInteractionSession({
      client: new AppServer({
        threadManagerOptions: {
          generateThreadId: sequence('thread'),
          generateRunId: sequence('run'),
          generateTurnId: sequence('turn'),
          generateItemId: sequence('item'),
          clock: tickingClock(1000, 100),
          runtimeFactory: () => ({
            model: {
              async *generate() {
                yield {
                  type: 'message.completed',
                  content: 'We added a resume picker summary',
                };
              },
            } satisfies ModelGateway,
          }),
        },
      }),
    });

    await session.start();
    await session.submit('Find the previous picker work');

    await expect(session.listThreads()).resolves.toEqual([
      {
        id: 'thread-1',
        status: 'idle',
        turns: 1,
        items: 10,
        updatedAtMs: 1900,
        lastUserMessage: 'Find the previous picker work',
        lastAssistantSummary: 'We added a resume picker summary',
      },
    ]);
  });

  it('exposes the latest failed turn as recoverable session state', async () => {
    const session = new AgentInteractionSession({
      client: new AppServer({
        threadManagerOptions: {
          ...deterministicIds(),
          runtimeFactory: () => ({
            model: {
              async *generate() {
                yield { type: 'error', error: new Error('model timed out') };
              },
            } satisfies ModelGateway,
          }),
        },
      }),
    });

    await session.start();

    await expect(session.submit('retry this later')).rejects.toThrow('model timed out');

    expect(session.getSnapshot().recoverableTurn).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'failed',
      input: 'retry this later',
      reason: 'model timed out',
      retryAvailable: true,
    });
  });
});

function deterministicIds() {
  return {
    generateThreadId: sequence('thread'),
    generateRunId: sequence('run'),
    generateTurnId: sequence('turn'),
    generateItemId: sequence('item'),
    clock: () => 1000,
  };
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

function tickingClock(startMs: number, stepMs: number): () => number {
  let nextMs = startMs;

  return () => {
    const current = nextMs;
    nextMs += stepMs;
    return current;
  };
}

function threadSnapshot(): ThreadSnapshot {
  return { id: 'thread-1', status: 'idle', turns: [], items: [] };
}

function recoverableThreadSnapshot(): ThreadSnapshot {
  return {
    id: 'thread-1',
    status: 'failed' as const,
    turns: [{ id: 'turn-1', runId: 'run-1', status: 'failed' as const, itemIds: ['user-1'] }],
    items: [
      {
        id: 'user-1',
        type: 'user.message.completed',
        createdAtMs: 1000,
        seq: 1,
        runId: 'run-1',
        turnId: 'turn-1',
        payload: { content: 'retry me' },
      },
    ],
  };
}

class DeferredSessionClient implements AppServerClient {
  private readonly listeners = new Set<AppServerNotificationListener>();
  unsubscribeCalls = 0;
  turnRequests = 0;

  private pendingTurnReject?: (cause: Error) => void;

  constructor(
    private readonly thread: ThreadSnapshot,
    private readonly options: {
      readonly turnFailure?: Error;
      readonly deferTurnFailure?: boolean;
    } = {}
  ) {}

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    if (request.method === 'thread/list') {
      return {
        method: 'thread/list',
        ok: true,
        result: { threads: [this.thread], persistenceFailures: [] },
      } as AppServerResponse;
    }
    if (request.method === 'turn/start' || request.method === 'turn/retry') {
      this.turnRequests += 1;
      if (this.options.deferTurnFailure) {
        return new Promise((_, reject) => {
          this.pendingTurnReject = reject;
        });
      }
      if (this.options.turnFailure) {
        throw this.options.turnFailure;
      }
      return {
        method: request.method,
        ok: true,
        result: { turn: { id: 'turn-2', runId: 'run-2', status: 'inProgress', itemIds: [] } },
      } as AppServerResponse;
    }
    throw new Error(`Unexpected request: ${request.method}`);
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.unsubscribeCalls += 1;
    };
  }

  emit(notification: Parameters<AppServerNotificationListener>[0]): void {
    this.listeners.forEach((listener) => listener(notification));
  }

  async waitForTurnRequest(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.turnRequests > 0) {
        await Promise.resolve();
        return;
      }
      await Promise.resolve();
    }
    throw new Error('Timed out waiting for turn request');
  }

  rejectTurnRequest(cause: Error): void {
    this.pendingTurnReject?.(cause);
    this.pendingTurnReject = undefined;
  }
}

class ConcurrentSubmitClient implements AppServerClient {
  private readonly listeners = new Set<AppServerNotificationListener>();
  private readonly turnRequests: Array<(turnId: string) => void> = [];

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    if (request.method === 'thread/list') {
      return {
        method: 'thread/list',
        ok: true,
        result: { threads: [threadSnapshot()], persistenceFailures: [] },
      };
    }
    if (request.method !== 'turn/start') throw new Error(`Unexpected request: ${request.method}`);
    return await new Promise<AppServerResponse>((resolve) => {
      this.turnRequests.push((turnId) =>
        resolve({
          method: 'turn/start',
          ok: true,
          result: {
            turn: { id: turnId, runId: `run-${turnId.at(-1)}`, status: 'inProgress', itemIds: [] },
          },
        })
      );
    });
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(notification: Parameters<AppServerNotificationListener>[0]): void {
    this.listeners.forEach((listener) => listener(notification));
  }

  resolveTurnRequest(index: number, turnId: string): void {
    this.turnRequests[index]?.(turnId);
  }

  async waitForTurnRequests(count: number): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.turnRequests.length === count) return;
      await Promise.resolve();
    }
    throw new Error(`Timed out waiting for ${count} turn requests`);
  }
}

class SessionHandoffClient implements AppServerClient {
  private listener?: AppServerNotificationListener;
  private resolveListRequest!: (snapshot: ThreadSnapshot) => void;
  private readonly listRequest = new Promise<ThreadSnapshot>((resolve) => {
    this.resolveListRequest = resolve;
  });

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    if (request.method !== 'thread/list') throw new Error(`Unexpected request: ${request.method}`);
    const snapshot = await this.listRequest;
    return {
      method: 'thread/list',
      ok: true,
      result: { threads: [snapshot], persistenceFailures: [] },
    };
  }

  subscribe(listener: AppServerNotificationListener): AppServerSubscription {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(notification: Parameters<AppServerNotificationListener>[0]): void {
    this.listener?.(notification);
  }

  resolveList(snapshot: ThreadSnapshot): void {
    this.resolveListRequest(snapshot);
  }
}

function sessionItem(id: string, seq: number) {
  return {
    id,
    type: 'assistant.message.completed',
    createdAtMs: seq,
    seq,
    runId: 'run-1',
    turnId: 'turn-1',
    payload: { content: id },
  };
}
