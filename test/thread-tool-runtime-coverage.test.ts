import { describe, expect, it } from 'vitest';

import { AgentScheduler, ThreadToolRuntime } from './test-exports.js';

describe('ThreadToolRuntime dispatch and capability boundaries', () => {
  it('dispatches each project coordination tool with server-owned actor context', async () => {
    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const coordinator = {
      relation: (_projectId: string, _sourceId: string, targetId: string) =>
        targetId === 'child' ? 'child' : 'peer',
      createThread: async (input: unknown) => record('createThread', input),
      listThreadSummaries: (projectId: string) => record('listThreadSummaries', projectId),
      readThread: (_projectId: string, threadId: string) => ({
        id: threadId,
        status: 'idle',
        turns: [{ id: 'turn', status: 'completed' }],
      }),
      sendMessage: async (input: unknown) => record('sendMessage', input),
      assertWaitWithinLimit: async (projectId: string, targets: unknown) =>
        record('assertWaitWithinLimit', { projectId, targets }),
      cancelThread: async (input: unknown) => record('cancelThread', input),
      archiveThread: async (input: unknown) => record('archiveThread', input),
      handoff: async (input: unknown) => record('handoff', input),
    };
    const scheduler = new AgentScheduler({ maxConcurrentAgents: () => 1 });
    const waitFor = scheduler.waitFor.bind(scheduler);
    scheduler.waitFor = async (input) => {
      calls.push({ name: 'waitFor', input });
      return { threadId: 'child', status: 'completed' };
    };
    const record = (name: string, input: unknown) => {
      calls.push({ name, input });
      return { name };
    };
    const runtime = new ThreadToolRuntime({
      coordinator: coordinator as never,
      scheduler,
      resolveExecutionContext: () => ({
        actor: 'agent',
        projectId: 'project',
        sourceThreadId: 'source',
        capabilities: new Set([
          'createChildThread',
          'readProjectThreads',
          'messageChild',
          'messagePeer',
          'interruptPeer',
          'cancelThread',
          'archiveThread',
          'handoffThread',
        ]),
      }),
    });

    for (const [name, input] of [
      ['thread.create', { objective: 'review', idempotencyKey: 'create' }],
      ['thread.list', {}],
      ['thread.read', { threadId: 'child' }],
      ['thread.send', { threadId: 'child', content: 'child', idempotencyKey: 'send-child' }],
      [
        'thread.send',
        { threadId: 'peer', content: 'peer', interrupt: true, idempotencyKey: 'send-peer' },
      ],
      ['thread.wait', { threadIds: ['child'], mode: 'all' }],
      ['thread.cancel', { threadId: 'child', idempotencyKey: 'cancel' }],
      ['thread.archive', { threadId: 'child', idempotencyKey: 'archive' }],
      ['thread.handoff', { threadId: 'child', content: 'summary', idempotencyKey: 'handoff' }],
    ] as const) {
      await expect(run(runtime, name, input)).resolves.toEqual([
        expect.objectContaining({ type: 'result.completed' }),
      ]);
    }
    expect(calls.map((entry) => entry.name)).toEqual([
      'createThread',
      'listThreadSummaries',
      'sendMessage',
      'sendMessage',
      'assertWaitWithinLimit',
      'waitFor',
      'cancelThread',
      'archiveThread',
      'handoff',
    ]);
    scheduler.waitFor = waitFor;
  });

  it('reports missing context, invalid input, ancestor control, and unknown tools without side effects', async () => {
    const runtime = new ThreadToolRuntime({
      coordinator: { relation: () => 'ancestor' } as never,
      scheduler: {} as never,
      resolveExecutionContext: () => undefined,
    });
    await expect(run(runtime, 'thread.list', {})).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      }),
    ]);
    await expect(run(runtime, 'thread.create', [])).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      }),
    ]);
    await expect(run(runtime, 'not-a-thread-tool', {})).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'NOT_FOUND' }),
      }),
    ]);
  });

  it('uses fallback only for non-thread tools and blocks self or ancestor mutations', async () => {
    const runtime = new ThreadToolRuntime({
      coordinator: { relation: () => 'ancestor' } as never,
      scheduler: {} as never,
      fallback: {
        async *execute() {
          yield { type: 'result.completed' as const, content: 'fallback' };
        },
      },
      resolveExecutionContext: () => ({
        projectId: 'project',
        sourceThreadId: 'source',
        capabilities: new Set(['cancelThread', 'messagePeer']),
      }),
    });
    await expect(run(runtime, 'other.tool', {})).resolves.toEqual([
      expect.objectContaining({ type: 'result.completed', content: 'fallback' }),
    ]);
    await expect(
      run(runtime, 'thread.cancel', { threadId: 'source', idempotencyKey: 'self' })
    ).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      }),
    ]);
    await expect(
      run(runtime, 'thread.send', {
        threadId: 'ancestor',
        content: 'no',
        idempotencyKey: 'ancestor',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      }),
    ]);
  });
});

async function run(runtime: ThreadToolRuntime, name: string, input: unknown) {
  const events = [];
  for await (const event of runtime.execute({ id: name, name, input }, {} as never))
    events.push(event);
  return events;
}
