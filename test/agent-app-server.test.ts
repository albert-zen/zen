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
    for (const request of [
      null,
      { method: 'unknown', params: {} },
      { method: 'project/create', params: { name: 'x' } },
      { method: 'project/create', params: { name: 'x', rootPath: 'C:\\x' } },
      { method: 'project/list', params: {}, id: '' },
      { method: 'project/list', params: { nested: { one: { two: { three: { four: 1 } } } } } },
      { method: 'project/list', params: { constructor: 'unsafe' } },
    ]) {
      expect(() => parseAgentAppRequest(request)).toThrow();
    }
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

  it('maps project lookup failures, supports update/read/list, and rejects requests after close', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.server.request({ method: 'project/read', params: { projectId: 'missing' } })
    ).resolves.toMatchObject({ ok: false, error: { code: 'PROJECT_NOT_FOUND' } });
    const created = await fixture.server.request(projectCreate('One', 'C:\\one', 'one'));
    if (!created.ok) throw new Error('project create failed');
    const id = projectId(created);
    await expect(
      fixture.server.request({
        method: 'project/update',
        params: { projectId: id, name: 'Renamed', idempotencyKey: 'update' },
      })
    ).resolves.toMatchObject({ ok: true, result: { project: { name: 'Renamed' } } });
    await expect(
      fixture.server.request({ method: 'project/read', params: { projectId: id } })
    ).resolves.toMatchObject({ ok: true, result: { project: { id } } });
    await expect(
      fixture.server.request({ method: 'project/list', params: {} })
    ).resolves.toMatchObject({
      ok: true,
      result: { projects: [{ id }] },
    });
    await fixture.server.close();
    await expect(
      fixture.server.request({ method: 'project/list', params: {} })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'SERVER_CLOSING' },
    });
  });

  it('returns typed request errors for invalid project input and preserves request ids', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.server.request({
        id: 'bad-create',
        method: 'project/create',
        params: { name: '', rootPath: 'C:\\root', idempotencyKey: 'bad' },
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    const created = await fixture.server.request({
      id: 'create-id',
      method: 'project/create',
      params: { name: 'One', rootPath: 'C:\\one', idempotencyKey: 'one' },
    });
    expect(created).toMatchObject({ ok: true, id: 'create-id' });
    if (!created.ok) throw new Error('project create failed');
    const id = projectId(created);
    await expect(
      fixture.server.request({
        method: 'project/update',
        params: { projectId: id, rootPath: 'C:\\renamed', idempotencyKey: 'update' },
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', message: expect.stringContaining('immutable') },
    });
    await expect(
      fixture.server.request({ method: 'project/read', params: { projectId: id } })
    ).resolves.toMatchObject({ ok: true, result: { project: { rootPath: 'C:\\one' } } });
  });

  it('aggregates runtime startup and close failures after attempting every resource', async () => {
    const manager = await ProjectManager.open({
      registry: new InMemoryProjectRegistry(),
      generateId: sequence('project'),
    });
    const closeFailure = await manager.create({ name: 'Close failure', rootPath: 'C:\\close' });
    const openFailure = await manager.create({ name: 'Open failure', rootPath: 'C:\\open' });
    const opening = deferred<ProjectRuntime>();
    let openRequested = false;
    const server = new AgentAppServer({
      projectManager: manager,
      createRuntime: async (project) => {
        if (project.id === openFailure.id) {
          openRequested = true;
          return await opening.promise;
        }
        return {
          async request(request) {
            return { method: request.method, ok: true, result: { threads: [] } };
          },
          async update() {},
          observe: () => () => undefined,
          async close() {
            throw new Error('injected runtime close failure');
          },
        };
      },
    });
    await server.request({
      method: 'thread/list',
      params: { projectId: closeFailure.id, limit: 10 },
    });
    const failedRequest = server.request({
      method: 'thread/list',
      params: { projectId: openFailure.id, limit: 10 },
    });
    await expect.poll(() => openRequested).toBe(true);
    const closing = server.close();
    opening.reject(new Error('injected runtime startup failure'));

    await expect(closing).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'injected runtime startup failure' }),
        expect.objectContaining({ message: 'injected runtime close failure' }),
      ],
    });
    await expect(failedRequest).resolves.toMatchObject({ ok: false });
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
        async update() {},
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
