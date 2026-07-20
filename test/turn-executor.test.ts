import { describe, expect, it } from 'vitest';

import {
  ThreadManager,
  type ThreadManagerOptions,
  type ThreadRuntime,
  type TurnExecutor,
  type TurnExecutorInput,
} from '../src/product/index.js';

describe('TurnExecutor thread runtime branch', () => {
  it('completes a turn through a TurnExecutor and passes the thread snapshot, records, input, and append callback', async () => {
    const executor: TurnExecutor = {
      async run(input: TurnExecutorInput) {
        expect(input.threadSnapshot).toEqual({
          id: 'thread-1',
          status: 'running',
          turns: [
            {
              id: 'turn-1',
              runId: 'run-1',
              status: 'queued',
              itemIds: ['item-1'],
            },
          ],
          items: [expect.objectContaining({ type: 'turn.queued' })],
        });
        expect(input.threadRecord).toEqual(
          expect.objectContaining({
            id: 'thread-1',
            status: 'running',
            turns: [
              expect.objectContaining({
                id: 'turn-1',
                runId: 'run-1',
                status: 'queued',
              }),
            ],
            items: expect.arrayContaining([
              expect.objectContaining({ type: 'thread.created' }),
              expect.objectContaining({ type: 'turn.queued' }),
            ]),
          })
        );
        expect(input.turnSnapshot).toEqual({
          id: 'turn-1',
          runId: 'run-1',
          status: 'queued',
          itemIds: ['item-1'],
        });
        expect(input.turnRecord).toBe(input.turnSnapshot);
        expect(input.input).toEqual({ prompt: 'complete the turn' });
        expect(input.modelOptions).toEqual({ mode: 'fast' });
        expect(input.signal.aborted).toBe(false);

        await input.appendItem({
          type: 'run.started',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: {},
        });
        await input.appendItem({
          type: 'turn.started',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: {},
        });
        await input.appendItem({
          type: 'user.message.completed',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          payload: { content: input.input },
        });
        await input.appendItem({
          type: 'assistant.message.completed',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          payload: { content: 'done' },
        });
        await input.appendItem({
          type: 'turn.completed',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: { status: 'completed' },
        });
        await input.appendItem({
          type: 'run.completed',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: { status: 'completed' },
        });

        return { yielded: false };
      },
    };
    const manager = createExecutorManager(executor);
    const thread = manager.startThread();

    const turn = await manager.startTurn({
      threadId: thread.id,
      input: { prompt: 'complete the turn' },
      modelOptions: { mode: 'fast' },
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn).toEqual(
      expect.objectContaining({
        id: 'turn-1',
        runId: 'run-1',
        status: 'completed',
      })
    );
    expect(snapshot.items.map((item) => item.type)).toEqual([
      'turn.queued',
      'run.started',
      'turn.started',
      'user.message.completed',
      'assistant.message.completed',
      'turn.completed',
      'run.completed',
    ]);
    expect(snapshot.turns).toEqual([turn]);
    expect(snapshot.status).toBe('idle');
  });

  it('fails a turn when the executor throws', async () => {
    const executor: TurnExecutor = {
      async run(input: TurnExecutorInput) {
        await input.appendItem({
          type: 'run.started',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: {},
        });
        await input.appendItem({
          type: 'turn.started',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: {},
        });
        throw new Error('executor failed');
      },
    };
    const manager = createExecutorManager(executor);
    const thread = manager.startThread();

    const turn = await manager.startTurn({
      threadId: thread.id,
      input: { prompt: 'fail please' },
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn.status).toBe('failed');
    expect(snapshot.turns).toEqual([turn]);
    expect(snapshot.items.map((item) => item.type)).toEqual([
      'turn.queued',
      'run.started',
      'turn.started',
      'turn.failed',
    ]);
    expect(turn.error).toEqual({
      name: 'Error',
      message: 'executor failed',
    });
  });

  it('cancels an active executor turn when interrupted', async () => {
    const aborted = deferred<void>();
    const executor: TurnExecutor = {
      async run(input: TurnExecutorInput) {
        await input.appendItem({
          type: 'run.started',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: {},
        });
        await input.appendItem({
          type: 'turn.started',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: {},
        });
        input.signal.addEventListener(
          'abort',
          () => {
            aborted.resolve();
          },
          { once: true }
        );
        await aborted.promise;
        throw new Error('executor aborted');
      },
    };
    const manager = createExecutorManager(executor);
    const thread = manager.startThread();
    const running = manager.startTurn({
      threadId: thread.id,
      input: { prompt: 'interrupt me' },
    });

    await waitForCondition(() => manager.readThread(thread.id).turns[0]?.status === 'inProgress');
    const interrupted = manager.interruptTurn(thread.id);
    const turn = await running;
    const snapshot = manager.readThread(thread.id);

    expect(interrupted).toEqual(expect.objectContaining({ status: 'inProgress' }));
    expect(turn.status).toBe('canceled');
    expect(snapshot.turns).toEqual([turn]);
    expect(snapshot.items.map((item) => item.type)).toEqual([
      'turn.queued',
      'run.started',
      'turn.started',
      'turn.canceled',
    ]);
    expect(snapshot.items.some((item) => item.type === 'turn.failed')).toBe(false);
  });

  it('keeps executor turns serialized under one scheduler lease at a time', async () => {
    const firstRelease = deferred<void>();
    const secondRelease = deferred<void>();
    const started: string[] = [];
    const leaseOrder: string[] = [];
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    let settleCount = 0;
    const executor: TurnExecutor = {
      async run(input: TurnExecutorInput) {
        started.push(input.turnSnapshot.id);
        activeExecutions += 1;
        maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);

        await input.appendItem({
          type: 'run.started',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: {},
        });
        await input.appendItem({
          type: 'turn.started',
          runId: input.turnSnapshot.runId,
          turnId: input.turnSnapshot.id,
          visibility: 'trace',
          payload: {},
        });

        try {
          if (input.turnSnapshot.id === 'turn-1') {
            await firstRelease.promise;
          } else {
            await secondRelease.promise;
          }

          await input.appendItem({
            type: 'turn.completed',
            runId: input.turnSnapshot.runId,
            turnId: input.turnSnapshot.id,
            visibility: 'trace',
            payload: { status: 'completed' },
          });
          await input.appendItem({
            type: 'run.completed',
            runId: input.turnSnapshot.runId,
            turnId: input.turnSnapshot.id,
            visibility: 'trace',
            payload: { status: 'completed' },
          });

          return { yielded: false };
        } finally {
          activeExecutions -= 1;
        }
      },
    };
    const manager = createExecutorManager(executor, async ({ turnId }) => {
      leaseOrder.push(turnId);

      return {
        async settle() {
          settleCount += 1;
        },
      };
    });
    const thread = manager.startThread();

    const first = manager.startTurn({
      threadId: thread.id,
      input: { prompt: 'first' },
    });
    await waitForCondition(() => started.length === 1);

    const second = manager.startTurn({
      threadId: thread.id,
      input: { prompt: 'second' },
    });

    expect(leaseOrder).toEqual(['turn-1']);
    expect(settleCount).toBe(0);

    firstRelease.resolve();
    await waitForCondition(() => started.length === 2);
    expect(leaseOrder).toEqual(['turn-1', 'turn-2']);
    expect(settleCount).toBe(1);

    secondRelease.resolve();
    await Promise.all([first, second]);

    expect(maxActiveExecutions).toBe(1);
    expect(settleCount).toBe(2);
    expect(manager.readThread(thread.id).turns.map((turn) => turn.status)).toEqual([
      'completed',
      'completed',
    ]);
  });
});

function createExecutorManager(
  executor: TurnExecutor,
  acquireExecutionLease?: NonNullable<ThreadManagerOptions['acquireExecutionLease']>
): ThreadManager {
  return new ThreadManager({
    generateThreadId: sequence('thread'),
    generateRunId: sequence('run'),
    generateTurnId: sequence('turn'),
    generateItemId: sequence('item'),
    clock: () => 1000,
    runtimeFactory: () => ({ executor }) satisfies ThreadRuntime,
    ...(acquireExecutionLease ? { acquireExecutionLease } : {}),
  });
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error('Timed out waiting for condition');
}
