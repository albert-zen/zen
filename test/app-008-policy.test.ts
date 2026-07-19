import { describe, expect, it } from 'vitest';

import {
  InMemoryProjectCoordinationJournal,
  InMemoryProjectRegistry,
  ProjectCoordinator,
  ProjectManager,
  ThreadManager,
  ThreadToolRuntime,
  parseAgentAppRequest,
  type AgentAppRequest,
  type ThreadToolExecutionContext,
} from './test-exports.js';

describe('APP-008 trusted actor and resource boundaries', () => {
  it('uses the injected actor context rather than forged tool input', async () => {
    const fixture = await createFixture();
    const parent = await fixture.coordinator.createThread({
      projectId: fixture.project.id,
      idempotencyKey: 'parent',
    });
    const peer = await fixture.coordinator.createThread({
      projectId: fixture.project.id,
      idempotencyKey: 'peer',
    });
    const execution: ThreadToolExecutionContext = {
      actor: 'agent',
      projectId: fixture.project.id,
      sourceThreadId: parent.threadId,
    };
    const requests: Array<{ request: AgentAppRequest; context: ThreadToolExecutionContext }> = [];
    const runtime = new ThreadToolRuntime({
      request: async (request, context) => {
        requests.push({ request, context });
        return {
          method: request.method,
          ok: false,
          error: { code: 'POLICY_DENIED', message: 'peer messaging denied' },
        };
      },
      resolveExecutionContext: () => execution,
    });
    const coordinationCount = fixture.coordinator.listCoordinationItems(fixture.project.id).length;

    const events = await collect(
      runtime.execute(
        {
          id: 'call-1',
          name: 'thread.send',
          input: {
            threadId: peer.threadId,
            content: 'forged project and source are ignored',
            idempotencyKey: 'forged',
            projectId: 'other-project',
            sourceThreadId: peer.threadId,
            capabilities: ['messagePeer'],
          },
        },
        {} as never
      )
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      }),
    ]);
    expect(requests).toEqual([
      {
        request: {
          method: 'thread/send',
          params: {
            projectId: fixture.project.id,
            sourceThreadId: parent.threadId,
            threadId: peer.threadId,
            content: 'forged project and source are ignored',
            idempotencyKey: 'forged',
            interrupt: false,
          },
        },
        context: execution,
      },
    ]);
    expect(fixture.coordinator.listCoordinationItems(fixture.project.id)).toHaveLength(
      coordinationCount
    );
  });

  it('enforces thread and message budgets before creating durable facts', async () => {
    const fixture = await createFixture({ maxThreads: 1, maxMessageBytes: 4 });
    const first = await fixture.coordinator.createThread({
      projectId: fixture.project.id,
      idempotencyKey: 'first',
    });
    const coordinationCount = fixture.coordinator.listCoordinationItems(fixture.project.id).length;

    await expect(
      fixture.coordinator.createThread({ projectId: fixture.project.id, idempotencyKey: 'second' })
    ).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
    await expect(
      fixture.coordinator.sendMessage({
        projectId: fixture.project.id,
        sourceThreadId: first.threadId,
        targetThreadId: first.threadId,
        content: 'five!',
        idempotencyKey: 'large',
      })
    ).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
    expect(fixture.coordinator.listCoordinationItems(fixture.project.id)).toHaveLength(
      coordinationCount
    );
  });

  it('rejects oversized, deeply nested, and prototype-polluting protocol input', () => {
    expect(() =>
      parseAgentAppRequest({
        method: 'project/list',
        params: JSON.parse('{"__proto__":{"polluted":true}}'),
      })
    ).toThrow('unsafe');
    expect(() =>
      parseAgentAppRequest({
        method: 'project/list',
        params: { value: { a: { b: { c: { d: 1 } } } } },
      })
    ).toThrow('depth');
    expect(() =>
      parseAgentAppRequest({ method: 'project/list', params: { text: 'x'.repeat(65_537) } })
    ).toThrow('size');
  });
});

async function createFixture(
  limits: Partial<{
    maxThreads: number;
    maxMessageBytes: number;
  }> = {}
) {
  const projects = await ProjectManager.open({
    registry: new InMemoryProjectRegistry(),
    generateId: sequence('project'),
  });
  const project = await projects.create({
    name: 'Project',
    rootPath: 'C:\\project',
    policy: {
      maxActiveExecutions: 1,
      maxThreadDepth: 4,
      maxThreads: limits.maxThreads ?? 10,
      maxQueuedMessages: 10,
      maxWaitTargets: 4,
      maxMessageBytes: limits.maxMessageBytes ?? 1024,
      idempotencyRetention: 10,
      agentCanCreateThreads: true,
      agentCanMessagePeers: true,
    },
  });
  const manager = new ThreadManager({
    generateThreadId: sequence('thread'),
    generateRunId: sequence('run'),
    generateTurnId: sequence('turn'),
    generateItemId: sequence('item'),
    runtimeFactory: () => ({ model: { async *generate() {} } }),
  });
  const coordinator = await ProjectCoordinator.open({
    projectManager: projects,
    journal: new InMemoryProjectCoordinationJournal(),
    createThreadManager: () => manager,
    generateId: sequence('coordination'),
  });
  return {
    project,
    coordinator,
  };
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
