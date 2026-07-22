import { describe, expect, it } from 'vitest';

import {
  ThreadManager,
  type ModelGateway,
  type ThreadManagerEvent,
  type ToolRuntime,
} from '../packages/framework/src/product/thread-manager.js';

describe('ThreadManager', () => {
  it('starts a thread with an empty item snapshot', () => {
    const manager = createManager();

    const thread = manager.startThread();

    expect(thread).toEqual({
      id: 'thread-1',
      status: 'idle',
      turns: [],
      items: [],
    });
  });

  it('reports actionable lifecycle errors and rejects new turns after shutdown', async () => {
    const manager = createManager();
    const thread = manager.startThread();

    expect(() => manager.interruptTurn(thread.id)).toThrow(
      `No active turn for thread: ${thread.id}`
    );
    expect(() => manager.retryTurn({ threadId: thread.id })).toThrow(
      `No recoverable turn for thread: ${thread.id}`
    );
    expect(() => manager.retryTurn({ threadId: thread.id, turnId: 'missing-turn' })).toThrow(
      'Unknown turn for retry: missing-turn'
    );

    await manager.shutdown();
    expect(() => manager.enqueueTurn({ threadId: thread.id, input: 'after shutdown' })).toThrow(
      'Thread manager is closing'
    );
  });

  it('rejects unknown threads and completed turns while preserving silent snapshot loading', async () => {
    const manager = createManager();
    expect(() => manager.readThread('missing-thread')).toThrow('Unknown thread: missing-thread');
    const thread = manager.startThread();
    const completed = await manager.startTurn({ threadId: thread.id, input: 'finish' });
    expect(() => manager.retryTurn({ threadId: thread.id, turnId: completed.id })).toThrow(
      `Turn is not recoverable: ${completed.id}`
    );

    const events: ThreadManagerEvent[] = [];
    manager.observe((event) => events.push(event));
    manager.loadThread(
      { id: 'loaded-thread', status: 'idle', turns: [], items: [] },
      { emit: false }
    );
    expect(events).toEqual([]);
    expect(manager.readThread('loaded-thread')).toEqual(
      expect.objectContaining({ id: 'loaded-thread', turns: [] })
    );
  });

  it('publishes explicitly loaded threads and exposes per-thread persistence failures', () => {
    const failure = {
      code: 'THREAD_JOURNAL_CORRUPTION' as const,
      message: 'record is corrupt',
      path: 'C:/threads/thread-a.jsonl',
      recordNumber: 4,
      threadId: 'thread-a',
    };
    const manager = new ThreadManager({ persistenceFailures: [failure] });
    const events: ThreadManagerEvent[] = [];
    manager.observe((event) => events.push(event));

    manager.loadThread({ id: 'thread-a', status: 'idle', turns: [], items: [] });

    expect(events).toEqual([expect.objectContaining({ type: 'thread/started' })]);
    expect(manager.listPersistenceFailures()).toEqual([failure]);
    expect(manager.persistenceFailure('thread-a')).toEqual(failure);
    expect(manager.persistenceFailure('healthy-thread')).toBeUndefined();
  });

  it('cancels queued work while shutting down an active thread', async () => {
    const started = createDeferred<void>();
    const manager = createManager({
      model: {
        async *generate(_context, _options, signal) {
          yield { type: 'text.delta', text: 'working' };
          started.resolve();
          await new Promise<void>((resolve) =>
            signal?.addEventListener('abort', () => resolve(), { once: true })
          );
          throw new Error('stopped during shutdown');
        },
      },
    });
    const thread = manager.startThread();
    const active = manager.startTurn({ threadId: thread.id, input: 'active' });
    await started.promise;
    const queued = manager.enqueueTurn({ threadId: thread.id, input: 'queued' });

    await manager.shutdown();

    expect(queued.status).toBe('queued');
    expect((await active).status).toBe('canceled');
    expect(manager.readThread(thread.id).turns.map((turn) => turn.status)).toEqual([
      'canceled',
      'canceled',
    ]);
  });

  it('normalizes non-Error model failures into failed public turn snapshots', async () => {
    for (const cause of ['provider unavailable', null, { status: 503 }]) {
      const manager = createManager({
        model: {
          async *generate() {
            yield { type: 'text.delta', text: 'loading' };
            throw cause;
          },
        },
      });
      const thread = manager.startThread();
      const failures: string[] = [];
      manager.observe((event) => {
        if (event.type === 'turn/failed') failures.push(event.error.message);
      });

      const turn = await manager.startTurn({ threadId: thread.id, input: 'trigger failure' });
      const snapshot = manager.readThread(thread.id);

      expect(turn.status).toBe('failed');
      expect(snapshot.turns.at(-1)).toEqual(
        expect.objectContaining({ id: turn.id, status: 'failed' })
      );
      expect(snapshot.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'turn.failed' }),
          expect.objectContaining({ type: 'assistant.message.error' }),
        ])
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBe(
        cause === null ? 'null' : typeof cause === 'string' ? cause : '[object Object]'
      );
    }
  });

  it('runs with the default fake runtime when no runtime factory is provided', async () => {
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
    });

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: 'Use the default fake runtime',
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn.status).toBe('completed');
    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'assistant.message.completed',
          payload: { content: 'Fake response' },
        }),
      ])
    );
  });

  it('queues same-thread turns FIFO with one active model execution', async () => {
    const releases = [createDeferred<void>(), createDeferred<void>()];
    const executionOrder: string[] = [];
    let active = 0;
    let maxActive = 0;
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate() {
            const release = releases[executionOrder.length];

            if (!release) {
              throw new Error('missing model release gate');
            }

            executionOrder.push(turn.id);
            active += 1;
            maxActive = Math.max(maxActive, active);

            try {
              await release.promise;
              yield { type: 'message.completed', content: turn.id };
            } finally {
              active -= 1;
            }
          },
        },
      }),
    });
    const thread = manager.startThread();

    const first = manager.startTurn({ threadId: thread.id, input: 'first' });
    const second = manager.startTurn({ threadId: thread.id, input: 'second' });

    await waitForCondition(() => executionOrder.length >= 1);
    await Promise.resolve();
    await Promise.resolve();
    const orderBeforeFirstCompletes = [...executionOrder];

    releases[0]?.resolve();
    await waitForCondition(() => executionOrder.length === 2);
    releases[1]?.resolve();
    await Promise.all([first, second]);

    expect({ executionOrder, maxActive, orderBeforeFirstCompletes }).toEqual({
      executionOrder: ['turn-1', 'turn-2'],
      maxActive: 1,
      orderBeforeFirstCompletes: ['turn-1'],
    });
  });

  it('reserves FIFO order before publishing queued items to reentrant observers', async () => {
    const executionOrder: string[] = [];
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate() {
            executionOrder.push(turn.id);
            yield { type: 'message.completed', content: turn.id };
          },
        },
      }),
    });
    const thread = manager.startThread();
    let nestedTurnId: string | undefined;

    manager.observe((event) => {
      if (
        nestedTurnId === undefined &&
        event.type === 'item/appended' &&
        event.item.type === 'turn.queued'
      ) {
        nestedTurnId = 'reserving';
        nestedTurnId = manager.enqueueTurn({
          threadId: thread.id,
          input: 'nested',
        }).id;
      }
    });

    const outer = manager.enqueueTurn({
      threadId: thread.id,
      input: 'outer',
    });

    await waitForCondition(
      () =>
        manager.readThread(thread.id).turns.length === 2 &&
        manager.readThread(thread.id).turns.every((turn) => turn.status === 'completed')
    );

    expect({ outer: outer.id, nested: nestedTurnId, executionOrder }).toEqual({
      outer: 'turn-1',
      nested: 'turn-2',
      executionOrder: ['turn-1', 'turn-2'],
    });
  });

  it('executes a committed queued item after observer rejection and continues FIFO', async () => {
    const executionOrder: string[] = [];
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate() {
            executionOrder.push(turn.id);
            yield { type: 'message.completed', content: turn.id };
          },
        },
      }),
    });
    const thread = manager.startThread();
    let rejectQueue = true;

    manager.observe((event) => {
      if (rejectQueue && event.type === 'item/appended' && event.item.type === 'turn.queued') {
        rejectQueue = false;
        throw new Error('queue observer rejected');
      }
    });

    expect(() => manager.enqueueTurn({ threadId: thread.id, input: 'committed first' })).toThrow(
      'item observer failed'
    );

    const second = manager.enqueueTurn({
      threadId: thread.id,
      input: 'second',
    });

    await waitForCondition(
      () =>
        manager.readThread(thread.id).turns.length === 2 &&
        manager.readThread(thread.id).turns.every((turn) => turn.status === 'completed')
    );

    expect({ second: second.id, executionOrder }).toEqual({
      second: 'turn-2',
      executionOrder: ['turn-1', 'turn-2'],
    });
  });

  it('keeps turn, run, and item ids unique when generators collide', async () => {
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: collidingSequence('run'),
      generateTurnId: collidingSequence('turn'),
      generateItemId: collidingSequence('item'),
      clock: () => 1000,
      runtimeFactory: () => ({
        model: {
          async *generate() {
            yield { type: 'message.completed', content: 'completed' };
          },
        },
      }),
    });
    const thread = manager.startThread();

    await Promise.all([
      manager.startTurn({ threadId: thread.id, input: 'first' }),
      manager.startTurn({ threadId: thread.id, input: 'second' }),
    ]);

    const snapshot = manager.readThread(thread.id);
    const itemIds = snapshot.items.map((item) => item.id);

    expect({
      turnIds: snapshot.turns.map((turn) => turn.id),
      runIds: snapshot.turns.map((turn) => turn.runId),
      itemIdCount: itemIds.length,
      uniqueItemIdCount: new Set(itemIds).size,
    }).toEqual({
      turnIds: ['turn-1', 'turn-2'],
      runIds: ['run-1', 'run-2'],
      itemIdCount: 20,
      uniqueItemIdCount: 20,
    });
  });

  it('runs turns from different threads concurrently', async () => {
    const release = createDeferred<void>();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
      runtimeFactory: ({ thread, turn }) => ({
        model: {
          async *generate() {
            started.push(`${thread.id}:${turn.id}`);
            active += 1;
            maxActive = Math.max(maxActive, active);

            try {
              await release.promise;
              yield { type: 'message.completed', content: turn.id };
            } finally {
              active -= 1;
            }
          },
        },
      }),
    });
    const firstThread = manager.startThread();
    const secondThread = manager.startThread();

    const first = manager.startTurn({
      threadId: firstThread.id,
      input: 'first thread',
    });
    const second = manager.startTurn({
      threadId: secondThread.id,
      input: 'second thread',
    });

    await waitForCondition(() => started.length === 2);
    release.resolve();
    await Promise.all([first, second]);

    expect({ started, maxActive }).toEqual({
      started: ['thread-1:turn-1', 'thread-2:turn-2'],
      maxActive: 2,
    });
  });

  it('appends queued lifecycle items before execution', async () => {
    const release = createDeferred<void>();
    const manager = createManager({
      model: {
        async *generate() {
          await release.promise;
          yield { type: 'message.completed', content: 'done' };
        },
      },
    });
    const thread = manager.startThread();

    const first = manager.enqueueTurn({ threadId: thread.id, input: 'first' });
    const second = manager.enqueueTurn({ threadId: thread.id, input: 'second' });
    const queued = manager.readThread(thread.id);

    release.resolve();
    await waitForCondition(() =>
      manager.readThread(thread.id).turns.every((turn) => turn.status === 'completed')
    );

    expect({ first, second, queued }).toEqual({
      first: {
        id: 'turn-1',
        runId: 'run-1',
        status: 'queued',
        itemIds: ['item-1'],
      },
      second: {
        id: 'turn-2',
        runId: 'run-2',
        status: 'queued',
        itemIds: ['item-2'],
      },
      queued: {
        id: 'thread-1',
        status: 'running',
        turns: [
          {
            id: 'turn-1',
            runId: 'run-1',
            status: 'queued',
            itemIds: ['item-1'],
          },
          {
            id: 'turn-2',
            runId: 'run-2',
            status: 'queued',
            itemIds: ['item-2'],
          },
        ],
        items: [
          expect.objectContaining({ id: 'item-1', type: 'turn.queued' }),
          expect.objectContaining({ id: 'item-2', type: 'turn.queued' }),
        ],
      },
    });
  });

  it('runs a fake turn and emits item notifications in item sequence order', async () => {
    const events: string[] = [];
    const manager = createManager({
      model: {
        async *generate() {
          yield { type: 'text.delta', text: 'Hello' };
          yield { type: 'message.completed', content: 'Hello from fake model' };
        },
      },
    });

    manager.observe((event) => {
      if (event.type === 'item/appended') {
        events.push(`${event.item.seq}:${event.item.type}`);
      }
    });

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: 'Hello',
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn).toEqual({
      id: 'turn-1',
      runId: 'run-1',
      status: 'completed',
      itemIds: snapshot.items.map((item) => item.id),
    });
    expect(snapshot.status).toBe('idle');
    expect(snapshot.turns).toEqual([turn]);
    expect(snapshot.items.map((item) => item.type)).toEqual([
      'turn.queued',
      'run.started',
      'turn.started',
      'user.message.completed',
      'model.request.started',
      'assistant.message.started',
      'assistant.message.delta',
      'assistant.message.completed',
      'model.request.completed',
      'turn.completed',
      'run.completed',
    ]);
    expect(events).toEqual(snapshot.items.map((item) => `${item.seq}:${item.type}`));
  });

  it('records a fake tool-call turn with ordered lifecycle notifications', async () => {
    const events: ThreadManagerEvent[] = [];
    let modelCalls = 0;
    const manager = createManager({
      model: {
        async *generate() {
          modelCalls += 1;

          if (modelCalls === 1) {
            yield {
              type: 'message.completed',
              content: 'Calling fake tool.',
              toolCalls: [{ id: 'call-1', name: 'fake-tool', input: { value: 1 } }],
            };
            return;
          }

          yield { type: 'message.completed', content: 'Tool returned.' };
        },
      },
      toolRuntime: {
        async *execute(call) {
          expect(call).toEqual({
            id: 'call-1',
            name: 'fake-tool',
            input: { value: 1 },
          });
          yield { type: 'output.delta', delta: 'working' };
          yield { type: 'result.completed', content: { ok: true } };
        },
      },
    });

    manager.observe((event) => events.push(event));

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: 'Use the tool',
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn.status).toBe('completed');
    expect(snapshot.items.map((item) => item.type)).toEqual([
      'turn.queued',
      'run.started',
      'turn.started',
      'user.message.completed',
      'model.request.started',
      'assistant.message.started',
      'assistant.message.completed',
      'model.request.completed',
      'tool.call.started',
      'tool.output.delta',
      'tool.result.completed',
      'model.request.started',
      'assistant.message.started',
      'assistant.message.completed',
      'model.request.completed',
      'turn.completed',
      'run.completed',
    ]);
    expect(events.map((event) => event.type)).toEqual([
      'thread/started',
      'item/appended',
      'item/appended',
      'item/appended',
      'turn/started',
      ...snapshot.items.slice(3).map(() => 'item/appended'),
      'turn/completed',
    ]);
    expect(
      events
        .filter((event) => event.type === 'item/appended')
        .map((event) => `${event.item.seq}:${event.item.type}`)
    ).toEqual(snapshot.items.map((item) => `${item.seq}:${item.type}`));
  });

  it('records failed model execution as a failed turn notification', async () => {
    const events: ThreadManagerEvent[] = [];
    const manager = createManager({
      model: {
        async *generate() {
          yield { type: 'error', error: new Error('fake model failed') };
        },
      },
    });

    manager.observe((event) => events.push(event));

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: 'Fail please',
    });
    const snapshot = manager.readThread(thread.id);

    expect(turn.status).toBe('failed');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.turns).toEqual([turn]);
    expect(snapshot.items.map((item) => item.type)).toContain('assistant.message.error');
    expect(snapshot.items.map((item) => item.type)).toContain('turn.failed');
    expect(snapshot.items.map((item) => item.type)).not.toContain('turn.completed');
    expect(turn.error).toEqual(
      readPayloadProperty(
        snapshot.items.find((item) => item.type === 'turn.failed')?.payload,
        'error'
      )
    );
    expect(events.at(-1)).toEqual({
      type: 'turn/failed',
      threadId: thread.id,
      turn,
      error: {
        code: 'TURN_FAILED',
        message: 'fake model failed',
        details: expect.objectContaining({
          message: 'fake model failed',
        }),
      },
    });
  });

  it('interrupts an active tool execution through the turn abort signal', async () => {
    const events: ThreadManagerEvent[] = [];
    const toolStarted = createDeferred<AbortSignal>();
    const toolAborted = createDeferred<void>();
    const manager = createManager({
      model: {
        async *generate() {
          yield {
            type: 'message.completed',
            content: 'Calling a long tool.',
            toolCalls: [{ id: 'call-1', name: 'fake-tool', input: {} }],
          };
        },
      },
      toolRuntime: {
        async *execute(_call, context) {
          if (!context.signal) {
            throw new Error('missing tool abort signal');
          }

          toolStarted.resolve(context.signal);
          context.signal.addEventListener('abort', () => toolAborted.resolve(), {
            once: true,
          });
          yield { type: 'output.delta', delta: 'started' };
          await toolAborted.promise;
          yield { type: 'error', error: new Error('fake tool canceled') };
        },
      },
    });

    manager.observe((event) => events.push(event));

    const thread = manager.startThread();
    const turnPromise = manager.startTurn({
      threadId: thread.id,
      input: 'Use the tool',
    });
    const signal = await toolStarted.promise;

    expect(signal.aborted).toBe(false);

    const interruptSnapshot = manager.interruptTurn(thread.id);

    expect(interruptSnapshot.status).toBe('inProgress');
    await toolAborted.promise;

    const turn = await turnPromise;
    const snapshot = manager.readThread(thread.id);

    expect(turn.status).toBe('canceled');
    expect(snapshot.status).toBe('idle');
    expect(snapshot.items.map((item) => item.type)).toContain('tool.error');
    expect(snapshot.items.filter((item) => item.type === 'tool.result.completed')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ toolCallId: 'call-1', isError: true }),
      }),
    ]);
    expect(snapshot.items.map((item) => item.type)).toContain('turn.canceled');
    expect(snapshot.items.map((item) => item.type)).not.toContain('turn.completed');
    expect(turn.error).toEqual(
      readPayloadProperty(
        snapshot.items.find((item) => item.type === 'turn.canceled')?.payload,
        'error'
      )
    );
    expect(events.at(-1)).toEqual({
      type: 'turn/completed',
      threadId: thread.id,
      turn,
    });
  });

  it('interrupts only the active turn and continues the thread queue', async () => {
    const firstStarted = createDeferred<AbortSignal>();
    const secondStarted = createDeferred<void>();
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate(_context, _options, signal) {
            if (turn.id === 'turn-1') {
              if (!signal) {
                throw new Error('missing model abort signal');
              }

              const aborted = createDeferred<void>();

              firstStarted.resolve(signal);
              signal.addEventListener('abort', () => aborted.resolve(), {
                once: true,
              });
              await aborted.promise;
              throw new Error('first model canceled');
            }

            secondStarted.resolve();
            yield { type: 'message.completed', content: 'second completed' };
          },
        },
      }),
    });
    const thread = manager.startThread();
    const first = manager.startTurn({ threadId: thread.id, input: 'first' });

    await firstStarted.promise;

    const second = manager.enqueueTurn({
      threadId: thread.id,
      input: 'second',
    });
    const interrupted = manager.interruptTurn(thread.id);
    const canceled = await first;

    await secondStarted.promise;
    await waitForCondition(
      () => manager.readThread(thread.id).turns.at(-1)?.status === 'completed'
    );

    const snapshot = manager.readThread(thread.id);
    const lifecycle = snapshot.items
      .filter((item) => item.type.startsWith('turn.'))
      .map((item) => `${item.turnId}:${item.type}`);

    expect({ interrupted, second, statuses: snapshot.turns.map((turn) => turn.status) }).toEqual({
      interrupted: expect.objectContaining({ id: 'turn-1', status: 'inProgress' }),
      second: expect.objectContaining({ id: 'turn-2', status: 'queued' }),
      statuses: ['canceled', 'completed'],
    });
    expect(canceled.status).toBe('canceled');
    expect(lifecycle.indexOf('turn-1:turn.canceled')).toBeLessThan(
      lifecycle.indexOf('turn-2:turn.started')
    );
  });

  it('keeps completion authoritative when interrupt races its lifecycle item', async () => {
    const manager = createManager();
    let interrupted: ReturnType<ThreadManager['interruptTurn']> | undefined;

    manager.observe((event) => {
      if (event.type === 'item/appended' && event.item.type === 'turn.completed') {
        interrupted = manager.interruptTurn(event.threadId);
      }
    });

    const thread = manager.startThread();
    const turn = await manager.startTurn({
      threadId: thread.id,
      input: 'complete despite the late interrupt',
    });
    const snapshot = manager.readThread(thread.id);

    expect({ interrupted, turn, status: snapshot.status }).toEqual({
      interrupted: expect.objectContaining({ status: 'completed' }),
      turn: expect.objectContaining({ status: 'completed' }),
      status: 'idle',
    });
    expect(snapshot.items.map((item) => item.type)).not.toContain('turn.canceled');
  });

  it('reports terminal observer rejection without appending a conflicting terminal item', async () => {
    const manager = createManager();
    let rejectTerminal = true;

    manager.observe((event) => {
      if (
        rejectTerminal &&
        event.type === 'item/appended' &&
        event.item.type === 'turn.completed'
      ) {
        rejectTerminal = false;
        throw new Error('terminal observer rejected');
      }
    });

    const thread = manager.startThread();
    const first = manager.startTurn({
      threadId: thread.id,
      input: 'commit completion',
    });
    const second = manager.startTurn({
      threadId: thread.id,
      input: 'continue after rejection',
    });

    await expect(first).rejects.toThrow('item observer failed');
    await expect(second).resolves.toEqual(expect.objectContaining({ status: 'completed' }));

    const snapshot = manager.readThread(thread.id);
    const terminalTypes = snapshot.items
      .filter((item) =>
        ['turn.completed', 'turn.failed', 'turn.canceled', 'turn.repaired'].includes(item.type)
      )
      .map((item) => item.type);

    expect({
      threadStatus: snapshot.status,
      turnStatuses: snapshot.turns.map((turn) => turn.status),
      terminalTypes,
    }).toEqual({
      threadStatus: 'idle',
      turnStatuses: ['completed', 'completed'],
      terminalTypes: ['turn.completed', 'turn.completed'],
    });
  });

  it('reports failed terminal observer rejection and continues the queued turn', async () => {
    const executionOrder: string[] = [];
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate() {
            executionOrder.push(turn.id);

            if (turn.id === 'turn-1') {
              yield { type: 'error', error: new Error('model failed') };
              return;
            }

            yield { type: 'message.completed', content: turn.id };
          },
        },
      }),
    });
    const thread = manager.startThread();

    manager.observe((event) => {
      if (event.type === 'item/appended' && event.item.type === 'turn.failed') {
        throw new Error('failed terminal observer rejected');
      }
    });

    const first = manager.startTurn({ threadId: thread.id, input: 'fail' });
    const second = manager.startTurn({
      threadId: thread.id,
      input: 'continue',
    });

    await expect(first).rejects.toThrow('item observer failed');
    await expect(second).resolves.toEqual(
      expect.objectContaining({ id: 'turn-2', status: 'completed' })
    );

    const snapshot = manager.readThread(thread.id);
    const lifecycle = snapshot.items
      .filter((item) => item.type.startsWith('turn.'))
      .map((item) => `${item.turnId}:${item.type}`);
    const firstTerminalTypes = snapshot.items
      .filter(
        (item) =>
          item.turnId === 'turn-1' &&
          ['turn.completed', 'turn.failed', 'turn.canceled', 'turn.repaired'].includes(item.type)
      )
      .map((item) => item.type);

    expect({
      executionOrder,
      statuses: snapshot.turns.map((turn) => turn.status),
      firstTerminalTypes,
    }).toEqual({
      executionOrder: ['turn-1', 'turn-2'],
      statuses: ['failed', 'completed'],
      firstTerminalTypes: ['turn.failed'],
    });
    expect(lifecycle.indexOf('turn-1:turn.failed')).toBeLessThan(
      lifecycle.indexOf('turn-2:turn.started')
    );
    expect(() => manager.interruptTurn(thread.id)).toThrow(
      `No active turn for thread: ${thread.id}`
    );
  });

  it('reports canceled terminal observer rejection and continues the queued turn', async () => {
    const firstStarted = createDeferred<void>();
    const executionOrder: string[] = [];
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate(_context, _options, signal) {
            executionOrder.push(turn.id);

            if (turn.id === 'turn-1') {
              if (!signal) {
                throw new Error('missing model abort signal');
              }

              const aborted = createDeferred<void>();

              firstStarted.resolve();
              signal.addEventListener('abort', () => aborted.resolve(), {
                once: true,
              });
              await aborted.promise;
              throw new Error('model canceled');
            }

            yield { type: 'message.completed', content: turn.id };
          },
        },
      }),
    });
    const thread = manager.startThread();

    manager.observe((event) => {
      if (event.type === 'item/appended' && event.item.type === 'turn.canceled') {
        throw new Error('canceled terminal observer rejected');
      }
    });

    const first = manager.startTurn({ threadId: thread.id, input: 'cancel' });

    await firstStarted.promise;

    const second = manager.startTurn({
      threadId: thread.id,
      input: 'continue',
    });
    const interrupted = manager.interruptTurn(thread.id);

    await expect(first).rejects.toThrow('item observer failed');
    await expect(second).resolves.toEqual(
      expect.objectContaining({ id: 'turn-2', status: 'completed' })
    );

    const snapshot = manager.readThread(thread.id);
    const lifecycle = snapshot.items
      .filter((item) => item.type.startsWith('turn.'))
      .map((item) => `${item.turnId}:${item.type}`);
    const firstTerminalTypes = snapshot.items
      .filter(
        (item) =>
          item.turnId === 'turn-1' &&
          ['turn.completed', 'turn.failed', 'turn.canceled', 'turn.repaired'].includes(item.type)
      )
      .map((item) => item.type);

    expect({
      interrupted,
      executionOrder,
      statuses: snapshot.turns.map((turn) => turn.status),
      firstTerminalTypes,
    }).toEqual({
      interrupted: expect.objectContaining({
        id: 'turn-1',
        status: 'inProgress',
      }),
      executionOrder: ['turn-1', 'turn-2'],
      statuses: ['canceled', 'completed'],
      firstTerminalTypes: ['turn.canceled'],
    });
    expect(lifecycle.indexOf('turn-1:turn.canceled')).toBeLessThan(
      lifecycle.indexOf('turn-2:turn.started')
    );
    expect(() => manager.interruptTurn(thread.id)).toThrow(
      `No active turn for thread: ${thread.id}`
    );
  });

  it('enqueues retries at the tail with the original user input', async () => {
    const secondRelease = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const executionOrder: string[] = [];
    const manager = new ThreadManager({
      generateThreadId: sequence('thread'),
      generateRunId: sequence('run'),
      generateTurnId: sequence('turn'),
      generateItemId: sequence('item'),
      clock: () => 1000,
      runtimeFactory: ({ turn }) => ({
        model: {
          async *generate() {
            executionOrder.push(turn.id);

            if (turn.id === 'turn-1') {
              yield { type: 'error', error: new Error('retryable') };
              return;
            }

            if (turn.id === 'turn-2') {
              secondStarted.resolve();
              await secondRelease.promise;
            }

            yield { type: 'message.completed', content: turn.id };
          },
        },
      }),
    });
    const thread = manager.startThread();
    const failed = await manager.startTurn({
      threadId: thread.id,
      input: 'original input',
    });
    const blocking = manager.startTurn({
      threadId: thread.id,
      input: 'blocking input',
    });

    await secondStarted.promise;

    const retry = manager.retryTurn({
      threadId: thread.id,
      turnId: failed.id,
    });
    const queued = manager.readThread(thread.id);

    secondRelease.resolve();
    await blocking;
    await waitForCondition(
      () => manager.readThread(thread.id).turns.at(-1)?.status === 'completed'
    );

    const snapshot = manager.readThread(thread.id);

    expect({ retry, queuedStatuses: queued.turns.map((turn) => turn.status) }).toEqual({
      retry: expect.objectContaining({ id: 'turn-3', status: 'queued' }),
      queuedStatuses: ['failed', 'inProgress', 'queued'],
    });
    expect(executionOrder).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(
      snapshot.items
        .filter((item) => item.type === 'user.message.completed')
        .map((item) => item.payload)
    ).toEqual([
      { content: 'original input' },
      { content: 'blocking input' },
      { content: 'original input' },
    ]);
  });

  it('preserves durable queued turns and repairs only stale running turns', () => {
    const manager = new ThreadManager({
      generateItemId: sequence('repair-item'),
      clock: () => 2000,
      initialThreads: [
        {
          id: 'thread-1',
          status: 'idle',
          turns: [],
          items: [
            {
              id: 'item-1',
              type: 'turn.queued',
              createdAtMs: 1000,
              seq: 1,
              runId: 'run-1',
              turnId: 'turn-1',
              visibility: 'trace',
              payload: { input: 'queued input' },
            },
            {
              id: 'item-2',
              type: 'turn.queued',
              createdAtMs: 1000,
              seq: 2,
              runId: 'run-2',
              turnId: 'turn-2',
              visibility: 'trace',
              payload: { input: 'running input' },
            },
            {
              id: 'item-3',
              type: 'turn.started',
              createdAtMs: 1000,
              seq: 3,
              runId: 'run-2',
              turnId: 'turn-2',
              visibility: 'trace',
              payload: {},
            },
          ],
        },
      ],
    });

    const snapshot = manager.readThread('thread-1');

    expect(snapshot.status).toBe('running');
    expect(snapshot.turns).toEqual([
      {
        id: 'turn-1',
        runId: 'run-1',
        status: 'queued',
        itemIds: ['item-1'],
      },
      {
        id: 'turn-2',
        runId: 'run-2',
        status: 'failed',
        itemIds: ['item-2', 'item-3', 'repair-item-1'],
        error: {
          code: 'TURN_REPAIRED_ON_STARTUP',
          message: 'Turn was still in progress when the previous process stopped',
        },
      },
    ]);
    expect(
      snapshot.items
        .filter((item) => item.type === 'turn.repaired')
        .map((item) => readPayloadProperty(item.payload, 'previousStatus'))
    ).toEqual(['inProgress']);
  });

  it('derives persisted failure messages from lifecycle facts instead of stale turn snapshots', () => {
    const manager = new ThreadManager({
      initialThreads: [
        {
          id: 'thread-failures',
          status: 'idle',
          turns: [],
          items: [
            {
              id: 'queued-1',
              type: 'turn.queued',
              createdAtMs: 1,
              seq: 1,
              runId: 'run-1',
              turnId: 'turn-1',
              payload: { input: 'first' },
            },
            {
              id: 'failed-1',
              type: 'turn.failed',
              createdAtMs: 2,
              seq: 2,
              runId: 'run-1',
              turnId: 'turn-1',
              payload: { message: 'provider denied request' },
            },
            {
              id: 'queued-2',
              type: 'turn.queued',
              createdAtMs: 3,
              seq: 3,
              runId: 'run-2',
              turnId: 'turn-2',
              payload: { input: 'second' },
            },
            {
              id: 'failed-2',
              type: 'turn.failed',
              createdAtMs: 4,
              seq: 4,
              runId: 'run-2',
              turnId: 'turn-2',
              payload: 'unstructured failure',
            },
          ],
        },
      ],
    });

    expect(manager.readThread('thread-failures').turns).toEqual([
      expect.objectContaining({ id: 'turn-1', status: 'failed' }),
      expect.objectContaining({ id: 'turn-2', status: 'failed' }),
    ]);
  });
});

function createManager(
  options: {
    readonly model?: ModelGateway;
    readonly toolRuntime?: ToolRuntime;
  } = {}
): ThreadManager {
  return new ThreadManager({
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
            yield { type: 'message.completed', content: 'default fake response' };
          },
        } satisfies ModelGateway),
      toolRuntime: options.toolRuntime,
    }),
  });
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

function collidingSequence(prefix: string): () => string {
  let callCount = 0;

  return () => `${prefix}-${Math.floor(callCount++ / 2) + 1}`;
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

function readPayloadProperty(payload: unknown, key: string): unknown {
  if (typeof payload === 'object' && payload !== null && key in payload) {
    return payload[key as keyof typeof payload];
  }

  return undefined;
}
