import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AppServer,
  type AppServerNotification,
  createProviderBackedAppServer,
  FileThreadJournal,
  type ModelGateway,
} from './test-exports.js';

describe('AppServer', () => {
  it('dispatches thread/start and thread/read through the public request API', async () => {
    const server = createServer();

    const start = await server.request({ method: 'thread/start' });

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
    const thread = start.result.thread;

    await expect(
      server.request({
        method: 'thread/read',
        params: { threadId: thread.id },
      })
    ).resolves.toEqual({
      method: 'thread/read',
      ok: true,
      result: { thread },
    });
  });

  it('dispatches turn/start and returns ordered notifications to subscribers', async () => {
    const notifications: AppServerNotification[] = [];
    const server = createServer({
      model: {
        async *generate() {
          yield { type: 'message.completed', content: 'Hello from server' };
        },
      },
    });

    const unsubscribe = server.subscribe((notification) => {
      notifications.push(notification);
    });
    const start = await server.request({ method: 'thread/start' });

    if (!start.ok || start.method !== 'thread/start') {
      throw new Error('thread/start failed');
    }

    const turn = await server.request({
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

    unsubscribe();

    expect(turn).toEqual({
      method: 'turn/start',
      ok: true,
      result: {
        turn: expect.objectContaining({
          id: 'turn-1',
          runId: 'run-1',
          status: 'queued',
          itemIds: ['item-1'],
        }),
      },
    });
    expect(notifications.slice(0, 2).map((notification) => notification.type)).toEqual([
      'thread/started',
      'item/appended',
    ]);
    expect(notifications.some((notification) => notification.type === 'turn/started')).toBe(true);
    expect(notifications.at(-1)?.type).toBe('turn/completed');
    expect(
      notifications
        .filter((notification) => notification.type === 'item/appended')
        .map((notification) => notification.item.type)
    ).toEqual([
      'turn.queued',
      'run.started',
      'turn.started',
      'user.message.completed',
      'model.request.started',
      'assistant.message.started',
      'assistant.message.completed',
      'model.request.completed',
      'turn.completed',
      'run.completed',
    ]);
  });

  it('serializes immediate same-thread turn/start requests FIFO', async () => {
    const releases = [createDeferred<void>(), createDeferred<void>()];
    const executionOrder: number[] = [];
    const notifications: AppServerNotification[] = [];
    let active = 0;
    let maxActive = 0;
    const server = createServer({
      model: {
        async *generate() {
          const callIndex = executionOrder.length;
          const release = releases[callIndex];

          if (!release) {
            throw new Error('missing model release gate');
          }

          executionOrder.push(callIndex + 1);
          active += 1;
          maxActive = Math.max(maxActive, active);

          try {
            await release.promise;
            yield { type: 'message.completed', content: callIndex + 1 };
          } finally {
            active -= 1;
          }
        },
      },
    });
    server.subscribe((notification) => notifications.push(notification));
    const start = await server.request({ method: 'thread/start' });

    if (!start.ok || start.method !== 'thread/start') {
      throw new Error('thread/start failed');
    }

    const first = server.request({
      method: 'turn/start',
      params: { threadId: start.result.thread.id, input: 'first' },
    });
    const second = server.request({
      method: 'turn/start',
      params: { threadId: start.result.thread.id, input: 'second' },
    });

    const queued = await Promise.all([first, second]);

    await waitForCondition(() => executionOrder.length >= 1);
    await Promise.resolve();
    await Promise.resolve();
    const orderBeforeFirstCompletes = [...executionOrder];

    releases[0]?.resolve();
    await waitForCondition(() => executionOrder.length === 2);
    releases[1]?.resolve();
    await waitForCondition(
      () =>
        notifications.filter((notification) => notification.type === 'turn/completed').length === 2
    );

    expect(
      queued.map((response) =>
        response.ok && response.method === 'turn/start' ? response.result.turn.status : 'failed'
      )
    ).toEqual(['queued', 'queued']);
    expect({ executionOrder, maxActive, orderBeforeFirstCompletes }).toEqual({
      executionOrder: [1, 2],
      maxActive: 1,
      orderBeforeFirstCompletes: [1],
    });
  });

  it('returns typed errors for unknown and invalid requests', async () => {
    const server = createServer();

    await expect(server.request({ method: 'unknown/method', params: {} })).resolves.toEqual({
      method: 'unknown/method',
      ok: false,
      error: {
        code: 'UNKNOWN_METHOD',
        message: 'Unknown App Server method: unknown/method',
      },
    });
    await expect(
      server.request({
        method: 'thread/read',
        params: { threadId: 'missing-thread' },
      })
    ).resolves.toEqual({
      method: 'thread/read',
      ok: false,
      error: {
        code: 'REQUEST_FAILED',
        message: 'Unknown thread: missing-thread',
      },
    });
  });

  it('retries a failed turn by appending a new turn with the same user input', async () => {
    let modelCalls = 0;
    const notifications: AppServerNotification[] = [];
    const server = createServer({
      model: {
        async *generate() {
          modelCalls += 1;

          if (modelCalls === 1) {
            yield { type: 'error', error: new Error('transient model failure') };
            return;
          }

          yield { type: 'message.completed', content: 'Recovered response' };
        },
      },
    });
    server.subscribe((notification) => notifications.push(notification));
    const start = await server.request({ method: 'thread/start' });

    if (!start.ok || start.method !== 'thread/start') {
      throw new Error('thread/start failed');
    }

    await server.request({
      method: 'turn/start',
      params: {
        threadId: start.result.thread.id,
        input: 'please retry me',
      },
    });
    await waitForNotification(notifications, (notification) => notification.type === 'turn/failed');

    const retry = await server.request({
      method: 'turn/retry',
      params: {
        threadId: start.result.thread.id,
        turnId: 'turn-1',
      },
    });
    await waitForNotification(
      notifications,
      (notification) => notification.type === 'turn/completed' && notification.turn.id === 'turn-2'
    );

    expect(retry).toEqual({
      method: 'turn/retry',
      ok: true,
      result: {
        turn: expect.objectContaining({
          id: 'turn-2',
          runId: 'run-2',
          status: 'queued',
          itemIds: ['item-10'],
        }),
      },
    });

    const read = await server.request({
      method: 'thread/read',
      params: { threadId: start.result.thread.id },
    });

    if (!read.ok || read.method !== 'thread/read') {
      throw new Error('thread/read failed');
    }

    expect(read.result.thread.turns.map((turn) => turn.status)).toEqual(['failed', 'completed']);
    expect(
      read.result.thread.items
        .filter((item) => item.type === 'user.message.completed')
        .map((item) => item.payload)
    ).toEqual([{ content: 'please retry me' }, { content: 'please retry me' }]);
    expect(read.result.thread.items.map((item) => item.type)).toContain('assistant.message.error');
  });

  it('repairs stale in-progress turns replayed from a journal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-startup-repair-'));
    const journal = new FileThreadJournal({ dir });
    await journal.create(
      'thread-1',
      item('thread.created', 'thread-1', 'thread-1', 'item-created', { threadId: 'thread-1' })
    );
    await journal.append('thread-1', item('turn.started', 'run-1', 'turn-1', 'item-1', {}));
    await journal.close();

    const server = await createProviderBackedAppServer({
      threadJournal: new FileThreadJournal({ dir }),
      appServerOptions: {
        threadManagerOptions: {
          generateItemId: sequence('repair-item'),
          clock: () => 2000,
        },
      },
    });

    const list = await server.request({ method: 'thread/list' });

    expect(list).toEqual({
      method: 'thread/list',
      ok: true,
      result: {
        persistenceFailures: [],
        threads: [
          expect.objectContaining({
            id: 'thread-1',
            status: 'failed',
            turns: [
              expect.objectContaining({
                id: 'turn-1',
                status: 'failed',
                itemIds: ['item-1', 'repair-item-1'],
                error: {
                  code: 'TURN_REPAIRED_ON_STARTUP',
                  message: 'Turn was still in progress when the previous process stopped',
                },
              }),
            ],
            items: expect.arrayContaining([
              expect.objectContaining({ id: 'item-1', type: 'turn.started' }),
              expect.objectContaining({
                id: 'repair-item-1',
                type: 'turn.repaired',
                createdAtMs: 2000,
                seq: 2,
                payload: {
                  previousStatus: 'inProgress',
                  status: 'failed',
                  reason: 'Turn was still in progress when the previous process stopped',
                  error: {
                    code: 'TURN_REPAIRED_ON_STARTUP',
                    message: 'Turn was still in progress when the previous process stopped',
                  },
                },
              }),
            ]),
          }),
        ],
      },
    });
    await server.close();
    const path = join(dir, `thread-${Buffer.from('thread-1').toString('base64url')}.jsonl`);
    await expect(readFile(path, 'utf8')).resolves.toContain('turn.repaired');
  });
});

async function waitForNotification(
  notifications: readonly AppServerNotification[],
  predicate: (notification: AppServerNotification) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (notifications.some(predicate)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Timed out waiting for notification');
}

function createServer(options: { readonly model?: ModelGateway } = {}): AppServer {
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
      }),
    },
  });
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

function item(type: string, runId: string, turnId: string, id: string, payload: unknown) {
  return { id, type, createdAtMs: 1000, seq: 1, runId, turnId, payload };
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

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error('Timed out waiting for condition');
}
