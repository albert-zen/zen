import { describe, expect, it } from 'vitest';
import { AgentScheduler, ThreadToolRuntime, threadToolDefinitions } from './test-exports.js';

describe('AgentScheduler', () => {
  it('grants leases FIFO at the configured project concurrency', async () => {
    const scheduler = new AgentScheduler({ maxActiveExecutions: () => 1 });
    const first = await scheduler.acquire('project', 'one', 'turn-1');
    const second = scheduler.acquire('project', 'two', 'turn-2');
    const third = scheduler.acquire('project', 'three', 'turn-3');

    await scheduler.release(first, 'completed');
    expect((await second).threadId).toBe('two');
    await scheduler.release(await second, 'completed');
    expect((await third).threadId).toBe('three');
  });

  it('counts only active Turn executors and never idle Threads', async () => {
    const scheduler = new AgentScheduler({ maxActiveExecutions: () => 1 });
    expect(scheduler.activeExecutionCount('project')).toBe(0);
    const lease = await scheduler.acquire('project', 'thread-100', 'turn-1');
    expect(scheduler.activeExecutionCount('project')).toBe(1);
    await scheduler.release(lease, 'waiting');
    expect(scheduler.activeExecutionCount('project')).toBe(0);
  });

  it('re-evaluates durable queued Turns when execution policy changes', async () => {
    let limit = 1;
    const scheduler = new AgentScheduler({ maxActiveExecutions: () => limit });
    const first = await scheduler.acquire('project', 'one', 'turn-1');
    const second = scheduler.acquire('project', 'two', 'turn-2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.activeExecutionCount('project')).toBe(1);
    expect(scheduler.queuedExecutionCount('project')).toBe(1);

    limit = 2;
    await scheduler.refresh('project');
    const granted = await second;
    expect(scheduler.activeExecutionCount('project')).toBe(2);
    expect(scheduler.queuedExecutionCount('project')).toBe(0);

    await scheduler.release(first, 'completed');
    await scheduler.release(granted, 'completed');
  });

  it('emits lease lifecycle events and rejects queued leases on close', async () => {
    const events: string[] = [];
    const scheduler = new AgentScheduler({
      maxActiveExecutions: () => 1,
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    const lease = await scheduler.acquire('project', 'active', 'turn-active');
    const queued = scheduler.acquire('project', 'queued', 'turn-queued');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.close();
    await expect(queued).rejects.toThrow('closed');
    await expect(scheduler.acquire('project', 'after-close', 'turn-after')).rejects.toThrow(
      'closed'
    );
    await scheduler.release(lease, 'canceled');
    expect(events).toEqual(expect.arrayContaining(['agent.lease.queued', 'agent.lease.granted']));
  });

  it('cancels acquisition without leaking queued or active execution capacity', async () => {
    const scheduler = new AgentScheduler({ maxActiveExecutions: () => 1 });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      scheduler.acquire('project', 'pre-aborted', 'turn-pre-aborted', preAborted.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });

    const active = await scheduler.acquire('project', 'active', 'turn-active');
    const queuedAbort = new AbortController();
    const queued = scheduler.acquire('project', 'queued', 'turn-queued', queuedAbort.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.queuedExecutionCount('project')).toBe(1);
    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.queuedExecutionCount('project')).toBe(0);

    await scheduler.release(active, 'canceled');
    await scheduler.release(active, 'canceled');
    await scheduler.close();
    await scheduler.close();
    await expect(scheduler.refresh('project')).rejects.toThrow('closed');
  });
});

describe('thread tool definitions', () => {
  it('publishes all eight strict schemas', () => {
    expect(threadToolDefinitions.map((definition) => definition.function.name)).toEqual([
      'thread.create',
      'thread.list',
      'thread.read',
      'thread.send',
      'thread.wait',
      'thread.cancel',
      'thread.archive',
      'thread.handoff',
    ]);
    expect(
      threadToolDefinitions.every(
        (definition) => definition.function.parameters.additionalProperties === false
      )
    ).toBe(true);
  });

  it('derives authority from execution context instead of tool input', async () => {
    const runtime = new ThreadToolRuntime({
      request: async () => ({ method: 'thread/list', ok: true, result: { threads: [] } }),
      resolveExecutionContext: () => ({
        projectId: 'project',
        sourceThreadId: 'source',
      }),
    });
    const events = [];
    for await (const event of runtime.execute(
      { id: 'call', name: 'thread.list', input: { projectId: 'forged' } },
      {
        runId: 'run',
        turnId: 'turn',
        assistantItem: item('assistant'),
        startedItem: item('started'),
      }
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      expect.objectContaining({
        type: 'result.completed',
        content: { threads: [] },
      }),
    ]);
  });
});

function item(id: string) {
  return {
    id,
    type: 'assistant.message.completed',
    createdAtMs: 1,
    seq: 1,
    runId: 'run',
    turnId: 'turn',
    payload: {},
  };
}
