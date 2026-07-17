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
