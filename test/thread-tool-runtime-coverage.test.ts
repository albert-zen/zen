import { describe, expect, it } from 'vitest';

import {
  ThreadToolRuntime,
  type AgentAppRequest,
  type ThreadToolExecutionContext,
} from './test-exports.js';

describe('ThreadToolRuntime unified App Server dispatch', () => {
  it('maps every thread tool to the shared protocol with server-owned actor context', async () => {
    const calls: Array<{
      readonly request: AgentAppRequest;
      readonly execution: ThreadToolExecutionContext;
    }> = [];
    const execution: ThreadToolExecutionContext = {
      actor: 'agent',
      projectId: 'project',
      sourceThreadId: 'source',
    };
    const runtime = new ThreadToolRuntime({
      request: async (request, context) => {
        calls.push({ request, execution: context });
        return { method: request.method, ok: true, result: { accepted: request.method } };
      },
      resolveExecutionContext: () => execution,
    });

    const cases = [
      ['thread.create', { objective: 'review', idempotencyKey: 'create' }],
      ['thread.list', {}],
      ['thread.read', { threadId: 'child' }],
      ['thread.send', { threadId: 'child', content: 'child', idempotencyKey: 'send' }],
      ['thread.wait', { threadIds: ['child'], mode: 'all', idempotencyKey: 'wait' }],
      ['thread.cancel', { threadId: 'child', idempotencyKey: 'cancel' }],
      ['thread.archive', { threadId: 'child', idempotencyKey: 'archive' }],
      ['thread.handoff', { threadId: 'child', content: 'summary', idempotencyKey: 'handoff' }],
    ] as const;

    for (const [name, input] of cases) {
      const events = await run(runtime, name, input);
      expect(events).toEqual([
        expect.objectContaining({
          type: name === 'thread.wait' ? 'execution.yielded' : 'result.completed',
        }),
      ]);
    }

    expect(calls.map(({ request }) => request.method)).toEqual(
      cases.map(([name]) => name.replace('.', '/'))
    );
    expect(calls.every(({ execution: context }) => context.projectId === execution.projectId)).toBe(
      true
    );
    expect(
      calls.every(({ execution: context }) => context.sourceThreadId === execution.sourceThreadId)
    ).toBe(true);
    expect(calls[0]?.request.params).toMatchObject({
      projectId: 'project',
      sourceThreadId: 'source',
      idempotencyKey: 'create',
    });
    expect(calls[4]?.request.params).toMatchObject({
      projectId: 'project',
      threadId: 'source',
      threadIds: ['child'],
      idempotencyKey: 'wait',
    });
  });

  it('reports missing context, invalid input, protocol denial, and unknown tools', async () => {
    const missing = new ThreadToolRuntime({
      request: async () => ({ method: 'thread/list', ok: true, result: {} }),
      resolveExecutionContext: () => undefined,
    });
    await expect(run(missing, 'thread.list', {})).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      }),
    ]);

    const denied = new ThreadToolRuntime({
      request: async (request) => ({
        method: request.method,
        ok: false,
        error: { code: 'POLICY_DENIED', message: 'ancestor control denied' },
      }),
      resolveExecutionContext: () => ({ projectId: 'project', sourceThreadId: 'source' }),
    });
    await expect(run(denied, 'thread.create', [])).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'INVALID_INPUT' }),
      }),
    ]);
    await expect(
      run(denied, 'thread.send', {
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
    await expect(run(denied, 'not-a-thread-tool', {})).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'NOT_FOUND' }),
      }),
    ]);
  });

  it('uses fallback only for non-thread tools', async () => {
    const runtime = new ThreadToolRuntime({
      request: async () => ({ method: 'thread/list', ok: true, result: {} }),
      fallback: {
        async *execute() {
          yield { type: 'result.completed' as const, content: 'fallback' };
        },
      },
      resolveExecutionContext: () => ({ projectId: 'project', sourceThreadId: 'source' }),
    });
    await expect(run(runtime, 'other.tool', {})).resolves.toEqual([
      expect.objectContaining({ type: 'result.completed', content: 'fallback' }),
    ]);
  });
});

async function run(runtime: ThreadToolRuntime, name: string, input: unknown) {
  const events = [];
  for await (const event of runtime.execute({ id: name, name, input }, {} as never)) {
    events.push(event);
  }
  return events;
}
