import { describe, expect, it } from 'vitest';
import {
  AgentAppServer,
  InMemoryProjectRegistry,
  ProjectManager,
  parseAgentAppRequest,
  type AgentAppNotificationEnvelope,
  type ProjectRuntime,
} from './test-exports.js';

describe('AgentApp protocol', () => {
  it('validates project scope and mutation idempotency at the JSON boundary', () => {
    expect(() =>
      parseAgentAppRequest({ method: 'thread/read', params: { threadId: 't' } })
    ).toThrow('projectId');
    expect(() =>
      parseAgentAppRequest({ method: 'thread/send', params: { projectId: 'p', threadId: 't' } })
    ).toThrow('idempotencyKey');
    expect(parseAgentAppRequest({ method: 'project/list', params: { limit: 10 } })).toEqual({
      method: 'project/list',
      params: { limit: 10 },
    });
  });
});

describe('AgentAppServer', () => {
  it('routes independently scoped runtime requests and lazily opens each project once', async () => {
    const fixture = await createFixture();
    const first = await fixture.server.request(projectCreate('One', 'C:\\one', 'one'));
    const second = await fixture.server.request(projectCreate('Two', 'C:\\two', 'two'));
    if (!first.ok || !second.ok) throw new Error('project create failed');

    const firstId = projectId(first);
    const secondId = projectId(second);
    await fixture.server.request({
      method: 'thread/list',
      params: { projectId: firstId, limit: 10 },
    });
    await fixture.server.request({
      method: 'thread/list',
      params: { projectId: secondId, limit: 10 },
    });
    await fixture.server.request({
      method: 'thread/list',
      params: { projectId: firstId, limit: 10 },
    });

    expect(fixture.opens).toEqual([firstId, secondId]);
    expect(fixture.requests.map((entry) => entry.projectId)).toEqual([firstId, secondId, firstId]);
  });

  it('envelopes notifications, rejects archived runtime operations, and closes runtimes once', async () => {
    const fixture = await createFixture();
    const created = await fixture.server.request(projectCreate('One', 'C:\\one', 'one'));
    if (!created.ok) throw new Error('project create failed');
    const id = projectId(created);
    const notifications: AgentAppNotificationEnvelope[] = [];
    fixture.server.observe((notification) => notifications.push(notification));
    await fixture.server.request({ method: 'thread/list', params: { projectId: id, limit: 10 } });
    fixture.emit(id, { type: 'thread/started', threadId: 'thread-1' });
    await fixture.server.request({
      method: 'project/archive',
      params: { projectId: id, idempotencyKey: 'a' },
    });

    await expect(
      fixture.server.request({ method: 'thread/list', params: { projectId: id, limit: 10 } })
    ).resolves.toMatchObject({ ok: false, error: { code: 'PROJECT_ARCHIVED' } });
    expect(notifications).toEqual([
      { projectId: id, notification: { type: 'thread/started', threadId: 'thread-1' } },
    ]);
    await fixture.server.close();
    await fixture.server.close();
    expect(fixture.closed).toEqual([id]);
  });
});

function projectCreate(name: string, rootPath: string, idempotencyKey: string) {
  return { method: 'project/create' as const, params: { name, rootPath, idempotencyKey } };
}

function projectId(response: {
  readonly ok: true;
  readonly result: Readonly<Record<string, unknown>>;
}): string {
  const project = response.result.project;
  if (
    typeof project !== 'object' ||
    project === null ||
    !('id' in project) ||
    typeof project.id !== 'string'
  )
    throw new Error('missing project id');
  return project.id;
}

async function createFixture() {
  const projectManager = await ProjectManager.open({
    registry: new InMemoryProjectRegistry(),
    generateId: sequence('project'),
    clock: () => 1,
  });
  const opens: string[] = [];
  const closed: string[] = [];
  const requests: Array<{ projectId: string; method: string }> = [];
  const listeners = new Map<
    string,
    (notification: { readonly type: string; readonly threadId?: string }) => void
  >();
  const server = new AgentAppServer({
    projectManager,
    createRuntime: async (project) => {
      opens.push(project.id);
      const runtime: ProjectRuntime = {
        async request(request) {
          requests.push({ projectId: project.id, method: request.method });
          return { method: request.method, ok: true, result: { threads: [] } };
        },
        observe(listener) {
          listeners.set(project.id, listener);
          return () => listeners.delete(project.id);
        },
        async close() {
          closed.push(project.id);
        },
      };
      return runtime;
    },
  });
  return {
    server,
    opens,
    closed,
    requests,
    emit: (
      projectId: string,
      notification: { readonly type: string; readonly threadId?: string }
    ) => listeners.get(projectId)?.(notification),
  };
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
