import { describe, expect, it, vi } from 'vitest';

import {
  AggregateProductionShutdown,
  runAppServerCliComposition,
  runWebDevCliComposition,
  type ShutdownSignalSource,
} from '../src/adapters/node/production-composition.js';
import {
  AppServer,
  ApprovalBroker,
  createProviderBackedAppServer,
  type AppServerClient,
  type ModelGateway,
  type ThreadJournal,
  type ThreadJournalReplay,
} from './test-exports.js';
import type { Item } from '../src/kernel/item-list.js';

describe('production composition shutdown', () => {
  it('wires SIGINT through ingress quiesce, real AppServer drain, and edge close', async () => {
    const modelStarted = deferred<void>();
    const approvalBroker = new ApprovalBroker();
    const journal = new RecordingJournal();
    const server = new AppServer({
      approvalBroker,
      threadJournal: journal,
      threadManagerOptions: {
        generateThreadId: () => 'thread-1',
        generateRunId: sequence('run'),
        generateTurnId: sequence('turn'),
        generateItemId: sequence('item'),
        clock: () => 1000,
        runtimeFactory: () => ({
          model: {
            async *generate(_context, _options, signal) {
              yield { type: 'text.delta', text: 'working' };
              modelStarted.resolve();
              await new Promise<void>((resolve) =>
                signal?.addEventListener('abort', () => resolve(), { once: true })
              );
              throw new Error('aborted by production shutdown');
            },
          } satisfies ModelGateway,
        }),
      },
    });
    const started = await server.request({ method: 'thread/start' });
    if (!started.ok || started.method !== 'thread/start') throw new Error('thread start failed');
    await server.request({
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'active' },
    });
    await modelStarted.promise;
    await server.request({
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'queued' },
    });
    const pending = approvalBroker.request({
      id: 'approval-1',
      threadId: started.result.thread.id,
      runId: 'run-1',
      turnId: 'turn-1',
      startedItemId: 'item-1',
      call: { id: 'call-1', name: 'test', input: {} },
    });
    const signals = new FakeSignalSource();
    const ready = deferred<void>();
    const order: string[] = [];
    const transport = fakeTransport(order);
    const running = runAppServerCliComposition({
      credentialMode: {
        type: 'provided',
        capability: 'provided-capability-0123456789-abcdef-0123456789',
      },
      signalSource: signals,
      createAppServer: async () => server,
      createTransport: async () => transport,
      onListening: () => ready.resolve(),
    });

    await ready.promise;
    signals.emit('SIGINT');
    await running;

    await expect(pending.decision).resolves.toMatchObject({ type: 'decline' });
    expect(journal.items.filter((item) => item.type === 'turn.canceled')).toHaveLength(2);
    expect(journal.closeCalls).toBe(1);
    expect(transport.quiesce).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('transport.quiesce');
    expect(order.at(-1)).toBe('transport.close');
  });

  it('wires SIGTERM through the web root and closes Vite exactly once', async () => {
    const signals = new FakeSignalSource();
    const ready = deferred<void>();
    const order: string[] = [];
    const appServer = fakeAppServer(order);
    const transport = fakeTransport(order);
    const vite = {
      listen: vi.fn(async () => {
        order.push('vite.listen');
      }),
      close: vi.fn(async () => {
        order.push('vite.close');
      }),
    };
    const running = runWebDevCliComposition({
      signalSource: signals,
      createAppServer: async () => appServer,
      createTransport: async () => transport,
      createVite: async () => vite,
      onListening: () => ready.resolve(),
    });

    await ready.promise;
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await running;

    expect(order.slice(0, 2)).toEqual(['vite.listen', 'transport.quiesce']);
    expect(appServer.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(vite.close).toHaveBeenCalledTimes(1);
  });

  it('drains every acquired resource when web startup fails', async () => {
    const order: string[] = [];
    const appServer = fakeAppServer(order);
    const transport = fakeTransport(order);
    const vite = {
      listen: vi.fn(async () => {
        order.push('vite.listen');
        throw new Error('vite startup failed');
      }),
      close: vi.fn(async () => {
        order.push('vite.close');
      }),
    };

    await expect(
      runWebDevCliComposition({
        signalSource: new FakeSignalSource(),
        createAppServer: async () => appServer,
        createTransport: async () => transport,
        createVite: async () => vite,
      })
    ).rejects.toThrow('vite startup failed');

    expect(order.slice(0, 3)).toEqual(['vite.listen', 'transport.quiesce', 'appServer.close']);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(vite.close).toHaveBeenCalledTimes(1);
  });

  it('retains every shutdown failure while still closing handoff and transport', async () => {
    const signals = new FakeSignalSource();
    const ready = deferred<void>();
    const calls = { appServer: 0, transport: 0, handoff: 0 };
    const running = runAppServerCliComposition({
      credentialMode: { type: 'handoff', directory: 'unused' },
      signalSource: signals,
      createAppServer: async () => ({
        request: async () => ({
          method: 'unused',
          ok: false as const,
          error: { code: 'x', message: 'x' },
        }),
        subscribe: () => () => undefined,
        async close() {
          calls.appServer += 1;
          throw new Error('app close failed');
        },
      }),
      createTransport: async () => ({
        capability: 'generated-capability',
        url: 'http://127.0.0.1:1',
        async quiesce() {},
        async close() {
          calls.transport += 1;
          throw new Error('transport close failed');
        },
      }),
      publishHandoff: async () => ({ path: 'handoff', ownershipMarker: 'owner' }),
      cleanupHandoff: async () => {
        calls.handoff += 1;
        throw new Error('handoff close failed');
      },
      onListening: () => ready.resolve(),
    });

    await ready.promise;
    signals.emit('SIGINT');
    const failure = await running.catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(3);
    expect((failure as AggregateError).errors.map(String)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('app close failed'),
        expect.stringContaining('transport close failed'),
        expect.stringContaining('handoff close failed'),
      ])
    );
    expect(calls).toEqual({ appServer: 1, transport: 1, handoff: 1 });
  });

  it('returns one idempotent shutdown promise and runs phases in order', async () => {
    const order: string[] = [];
    const shutdown = new AggregateProductionShutdown({
      ingress: [
        {
          name: 'transport',
          close: async () => {
            order.push('ingress');
          },
        },
      ],
      product: [
        {
          name: 'appServer',
          close: async () => {
            order.push('product');
          },
        },
      ],
      edge: [
        {
          name: 'vite',
          close: async () => {
            order.push('edge');
          },
        },
      ],
    });

    const first = shutdown.close();
    const second = shutdown.close();

    expect(second).toBe(first);
    await first;
    expect(order).toEqual(['ingress', 'product', 'edge']);
  });

  it('closes the journal even when cancellation durability fails during drain', async () => {
    const modelStarted = deferred<void>();
    const journal = new CancellationFaultJournal();
    const server = new AppServer({
      threadJournal: journal,
      threadManagerOptions: {
        generateThreadId: () => 'thread-1',
        generateRunId: sequence('run'),
        generateTurnId: sequence('turn'),
        generateItemId: sequence('item'),
        clock: () => 1000,
        runtimeFactory: () => ({
          model: {
            async *generate(_context, _options, signal) {
              yield { type: 'text.delta', text: 'working' };
              modelStarted.resolve();
              await new Promise<void>((resolve) =>
                signal?.addEventListener('abort', () => resolve(), { once: true })
              );
              throw new Error('aborted by shutdown');
            },
          } satisfies ModelGateway,
        }),
      },
    });
    const started = await server.request({ method: 'thread/start' });
    if (!started.ok || started.method !== 'thread/start') throw new Error('thread start failed');
    await server.request({
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'active' },
    });
    await modelStarted.promise;
    await server.request({
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'queued' },
    });

    await expect(server.close()).rejects.toBeInstanceOf(AggregateError);
    expect(journal.closeCalls).toBe(1);
    expect(journal.cancellationAttempts).toBeGreaterThan(0);
  });

  it('closes the journal when provider replay fails before AppServer ownership transfers', async () => {
    const journal = new ReplayFaultJournal();

    await expect(createProviderBackedAppServer({ threadJournal: journal })).rejects.toThrow(
      'replay failed'
    );
    expect(journal.closeCalls).toBe(1);
  });
});

class RecordingJournal implements ThreadJournal {
  readonly items: Item[] = [];
  closeCalls = 0;

  async create(_threadId: string, item: Item): Promise<void> {
    this.items.push(item);
  }

  async append(_threadId: string, item: Item): Promise<void> {
    this.items.push(item);
  }

  async flush(_threadId: string): Promise<void> {}

  async replay(): Promise<readonly ThreadJournalReplay[]> {
    return [];
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class CancellationFaultJournal extends RecordingJournal {
  cancellationAttempts = 0;

  override async append(threadId: string, item: Item): Promise<void> {
    if (item.type === 'turn.canceled') {
      this.cancellationAttempts += 1;
      throw new Error('cancellation append failed');
    }
    await super.append(threadId, item);
  }
}

class ReplayFaultJournal extends RecordingJournal {
  override async replay(): Promise<readonly ThreadJournalReplay[]> {
    throw new Error('replay failed');
  }
}

class FakeSignalSource implements ShutdownSignalSource {
  private readonly listeners = new Map<string, Set<(value?: unknown) => void>>();

  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const once = () => {
      this.off(event, once);
      listener();
    };
    this.add(event, once);
  }

  on(event: 'message', listener: (message: unknown) => void): void {
    this.add(event, listener);
  }

  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  off(event: 'message', listener: (message: unknown) => void): void;
  off(event: string, listener: (value?: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  private add(event: string, listener: (value?: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
}

function fakeAppServer(order: string[]) {
  return {
    request: vi.fn<AppServerClient['request']>(),
    subscribe: vi.fn<AppServerClient['subscribe']>(() => () => undefined),
    close: vi.fn(async () => {
      order.push('appServer.close');
    }),
  };
}

function fakeTransport(order: string[]) {
  return {
    capability: 'capability',
    url: 'http://127.0.0.1:1',
    quiesce: vi.fn(async () => {
      order.push('transport.quiesce');
    }),
    close: vi.fn(async () => {
      order.push('transport.close');
    }),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function sequence(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
