import { describe, expect, it } from 'vitest';
import {
  AgentScheduler,
  ThreadToolRuntime,
  WaitCycleError,
  WaitGraph,
  threadToolDefinitions,
} from './test-exports.js';

describe('AgentScheduler', () => {
  it('grants leases FIFO at the configured project concurrency', async () => {
    const scheduler = new AgentScheduler({ maxConcurrentAgents: () => 1 });
    const first = await scheduler.acquire('project', 'one');
    const second = scheduler.acquire('project', 'two');
    const third = scheduler.acquire('project', 'three');

    await scheduler.release(first);
    expect((await second).threadId).toBe('two');
    await scheduler.release(await second);
    expect((await third).threadId).toBe('three');
  });

  it('releases its slot during a wait and reacquires after settlement', async () => {
    const scheduler = new AgentScheduler({ maxConcurrentAgents: () => 1 });
    const lease = await scheduler.acquire('project', 'waiter');
    const waiting = scheduler.wait(lease, ['target'], 'all');
    const other = await scheduler.acquire('project', 'other');

    expect(other.threadId).toBe('other');
    scheduler.settle('project', { threadId: 'target', status: 'completed', summary: 'done' });
    await scheduler.release(other);
    expect((await waiting).lease.threadId).toBe('waiter');
  });

  it('emits lease lifecycle events and rejects queued leases on close', async () => {
    const events: string[] = [];
    const scheduler = new AgentScheduler({
      maxConcurrentAgents: () => 1,
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    const lease = await scheduler.acquire('project', 'active');
    const queued = scheduler.acquire('project', 'queued');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.close();
    await expect(queued).rejects.toThrow('closed');
    await expect(scheduler.acquire('project', 'after-close')).rejects.toThrow('closed');
    await scheduler.release(lease);
    expect(events).toEqual(expect.arrayContaining(['agent.lease.queued', 'agent.lease.granted']));
  });
});

describe('WaitGraph', () => {
  it('supports any/all and reports the full cycle path', async () => {
    const graph = new WaitGraph();
    const any = graph.wait({ source: 'a', targets: ['b', 'c'], mode: 'any' });
    const all = graph.wait({ source: 'd', targets: ['e', 'f'], mode: 'all' });
    graph.settle('c', { threadId: 'c', status: 'completed' });
    graph.settle('e', { threadId: 'e', status: 'completed' });
    graph.settle('f', { threadId: 'f', status: 'failed' });
    await expect(any).resolves.toMatchObject({ threadId: 'c' });
    await expect(all).resolves.toMatchObject({ threadId: 'e' });

    graph.wait({ source: 'first', targets: ['second'], mode: 'all' });
    graph.wait({ source: 'second', targets: ['third'], mode: 'all' });
    expect(() => graph.wait({ source: 'third', targets: ['first'], mode: 'all' })).toThrow(
      WaitCycleError
    );
  });

  it('rejects invalid, aborted, canceled, and disposed waits without retaining edges', async () => {
    const graph = new WaitGraph();
    expect(() => graph.wait({ source: 'a', targets: [], mode: 'all' })).toThrow('at least one');
    expect(() => graph.wait({ source: 'a', targets: ['b', 'b'], mode: 'all' })).toThrow('unique');
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      graph.wait({ source: 'aborted', targets: ['target'], mode: 'all', signal: aborted.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    const cancel = graph.wait({ source: 'cancel-source', targets: ['cancel-target'], mode: 'all' });
    graph.cancelThread('cancel-target');
    await expect(cancel).rejects.toThrow('canceled');
    const disposable = graph.wait({
      source: 'dispose-source',
      targets: ['dispose-target'],
      mode: 'all',
    });
    graph.dispose();
    await expect(disposable).rejects.toThrow('disposed');
    const resolved = graph.wait({ source: 'a', targets: ['b'], mode: 'all' });
    graph.settle('b', { threadId: 'b', status: 'completed' });
    await expect(resolved).resolves.toMatchObject({ threadId: 'b' });
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
      coordinator: {} as never,
      scheduler: {} as never,
      resolveExecutionContext: () => ({
        projectId: 'project',
        sourceThreadId: 'source',
        capabilities: new Set(),
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
        type: 'error',
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
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
