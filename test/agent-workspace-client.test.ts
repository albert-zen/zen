import { describe, expect, it } from 'vitest';

import type {
  AgentAppClient,
  AgentAppNotificationEnvelope,
  AgentAppRequest,
  AgentAppResponse,
  ProjectSnapshot,
  ThreadSnapshot,
} from './test-exports.js';
import { AgentWorkspaceClient, WebUiLifecycleCanceledError } from './test-exports.js';

describe('AgentWorkspaceClient', () => {
  it('keeps an empty project list empty until an operator creates a project', async () => {
    const transport = new WorkspaceTransport([]);
    const client = new AgentWorkspaceClient({ client: transport });

    await client.connect();
    expect(client.getSnapshot()).toMatchObject({ projects: [], selectedProject: undefined });

    await client.createProject({ name: 'Kernel', rootPath: '/kernel' });
    expect(client.getSnapshot().selectedProject?.name).toBe('Kernel');
    expect(transport.requests.map((entry) => entry.method)).toContain('project/create');
  });

  it('switches project projections without retaining selected threads from the prior project', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One'), project('p2', 'Two')]);
    transport.threads.set('p1', [summary('one', 'p1')]);
    transport.threads.set('p2', [summary('two', 'p2')]);
    const client = new AgentWorkspaceClient({ client: transport });

    await client.connect({ projectId: 'p1' });
    await client.selectProject('p2');

    expect(client.getSnapshot().selectedProject?.id).toBe('p2');
    expect(client.getSnapshot().selectedThread).toBeUndefined();
    expect(client.getSnapshot().threads.map((thread) => thread.id)).toEqual(['two']);

    await client.selectThread('two');
    expect(client.getSnapshot().selectedThread?.id).toBe('two');
  });

  it('adds agent-created child threads from notifications without a local domain copy', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1' });

    transport.emit('p1', { type: 'thread/started', thread: thread('child') });

    expect(client.getSnapshot().threads.map((entry) => entry.id)).toEqual(['child', 'parent']);
  });

  it('uses project-scoped idempotent commands for create, send, interrupt, cancel, archive, and handoff', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1'), summary('target', 'p1')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1', threadId: 'parent' });

    await client.createThread(
      {
        objective: 'Child',
        parentThreadId: 'parent',
        modelProfile: 'reviewer',
      },
      'create-operation'
    );
    await client.sendHumanTurn('Hello', 'turn-operation');
    await client.interruptTurn('interrupt-operation');
    await client.handoff('target', 'Please review');
    await client.resolveApproval(
      { approvalId: 'approval-1', threadId: 'created-thread', turnId: 'turn-1' },
      'approveOnce'
    );
    await client.cancelThread();
    await client.archiveThread();

    for (const request of transport.requests.filter(
      (entry) =>
        entry.method !== 'provider/read' &&
        entry.method !== 'project/list' &&
        entry.method !== 'thread/list' &&
        entry.method !== 'thread/read'
    )) {
      expect(request.params).toHaveProperty('idempotencyKey');
      expect(request.params).toHaveProperty('projectId', 'p1');
    }
    expect(
      transport.requests.find((entry) => entry.method === 'thread/create')?.params
    ).toMatchObject({
      sourceThreadId: 'parent',
      modelProfile: 'reviewer',
      idempotencyKey: 'create-operation',
    });
    expect(transport.requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject(
      {
        idempotencyKey: 'turn-operation',
      }
    );
    expect(
      transport.requests.find((entry) => entry.method === 'turn/interrupt')?.params
    ).toMatchObject({ idempotencyKey: 'interrupt-operation' });
    expect(
      transport.requests.find((entry) => entry.method === 'approval/resolve')?.params
    ).toMatchObject({
      projectId: 'p1',
      threadId: 'created-thread',
      turnId: 'turn-1',
      approvalId: 'approval-1',
      decision: 'approveOnce',
    });
  });

  it('rejects stale select completions after a project lifecycle replacement', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One'), project('p2', 'Two')]);
    transport.threads.set('p1', [summary('one', 'p1')]);
    transport.threads.set('p2', [summary('two', 'p2')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p2' });
    transport.deferThreadListFor = 'p1';
    const stale = client.selectProject('p1');
    await client.selectProject('p2');
    transport.resolveDeferred();

    await expect(stale).rejects.toBeInstanceOf(WebUiLifecycleCanceledError);
    expect(client.getSnapshot().selectedProject?.id).toBe('p2');
  });

  it('reuses explicit operation keys after committed responses are lost', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1')]);
    transport.loseCreateResponseOnce = true;
    transport.loseTurnResponseOnce = true;
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1', threadId: 'parent' });

    const createInput = { objective: 'Retry-safe thread' };
    await expect(client.createThread(createInput, 'stable-create')).rejects.toThrow(
      'thread/create response lost'
    );
    await expect(client.createThread(createInput, 'stable-create')).resolves.toMatchObject({
      id: 'created-thread',
    });

    await expect(client.sendHumanTurn('Retry-safe Turn', 'stable-turn')).rejects.toThrow(
      'turn/start response lost'
    );
    await expect(client.sendHumanTurn('Retry-safe Turn', 'stable-turn')).resolves.toBeUndefined();

    expect(transport.threadCreateCommits).toBe(1);
    expect(transport.turnStartCommits).toBe(1);
    expect(
      transport.requests
        .filter((request) => request.method === 'thread/create')
        .map((request) => request.params.idempotencyKey)
    ).toEqual(['stable-create', 'stable-create']);
    expect(
      transport.requests
        .filter((request) => request.method === 'turn/start')
        .map((request) => request.params.idempotencyKey)
    ).toEqual(['stable-turn', 'stable-turn']);
  });

  it('projects lifecycle/reset notifications and supports update, wait, archive, and disconnect', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1', threadId: 'parent' });
    await client.updateProject({ name: 'Renamed' });
    await client.waitFor(['parent'], 'any');
    transport.emit('p1', { type: 'sync/reset', threads: [thread('reset')] });
    expect(client.getSnapshot().threads.map((entry) => entry.id)).toEqual(['reset']);
    await client.archiveProject();
    client.disconnect();
    expect(client.getSnapshot().connection.status).toBe('disconnected');
  });

  it('guards empty selections and projects current-thread turn notifications only', async () => {
    const empty = new AgentWorkspaceClient({ client: new WorkspaceTransport([]) });
    await empty.connect();
    await expect(empty.selectProject('missing')).rejects.toThrow('Unknown active project');
    await expect(empty.sendHumanTurn('message')).rejects.toThrow('Select a project');
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1', threadId: 'parent' });
    await client.sendHumanTurn('   ');
    expect(transport.requests.some((entry) => entry.method === 'turn/start')).toBe(false);
    transport.emit('p1', {
      type: 'turn/started',
      threadId: 'other',
      turn: { id: 'other', runId: 'r', status: 'inProgress', itemIds: [] },
    });
    expect(client.getSnapshot().connection.status).toBe('connected');
    transport.emit('p1', {
      type: 'turn/started',
      threadId: 'parent',
      turn: { id: 'turn', runId: 'r', status: 'inProgress', itemIds: [] },
    });
    expect(client.getSnapshot().connection.status).toBe('running');
    transport.emit('p1', {
      type: 'turn/completed',
      threadId: 'parent',
      turn: { id: 'turn', runId: 'r', status: 'completed', itemIds: [] },
    });
    expect(client.getSnapshot().connection.status).toBe('connected');
    transport.emit('p1', {
      type: 'turn/failed',
      threadId: 'parent',
      turn: { id: 'turn', runId: 'r', status: 'failed', itemIds: [] },
      error: { code: 'FAIL', message: 'nope' },
    });
    expect(client.getSnapshot().connection).toMatchObject({ status: 'failed', message: 'nope' });
  });

  it('falls back to an active project and completes the operator thread command surface', async () => {
    const archived = { ...project('old', 'Old'), status: 'archived' as const };
    const transport = new WorkspaceTransport([archived, project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'missing' });
    await client.refreshProjects();
    await client.selectThread('parent');
    await client.createThread({ objective: 'Untethered child' });
    await client.sendHumanTurn('actual operator input');
    await client.handoff('parent', 'handoff context');
    await client.cancelThread();
    await client.archiveThread();
    await client.refreshThreads();
    expect(transport.requests.map((entry) => entry.method)).toEqual(
      expect.arrayContaining(['turn/start', 'thread/handoff', 'thread/cancel', 'thread/archive'])
    );
  });

  it('fails closed when project and thread responses violate their protocol contracts', async () => {
    const badList = new AgentWorkspaceClient({
      client: {
        request: async () => response('wrong', { projects: [] }),
        subscribe: () => () => undefined,
      },
    });
    await expect(badList.connect()).rejects.toThrow('Unexpected wrong');

    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1' });
    transport.invalidResponseFor = 'thread/read';
    await expect(client.selectThread('parent')).rejects.toThrow('Unexpected wrong');
    transport.invalidResponseFor = 'thread/list';
    await expect(client.refreshThreads()).rejects.toThrow('Unexpected wrong');
  });

  it('surfaces typed transport denial and prevents thread commands without a selection', async () => {
    const denied = new AgentWorkspaceClient({
      client: {
        request: async (request) =>
          request.method === 'project/list'
            ? ({
                method: request.method,
                ok: false,
                error: { code: 'POLICY_DENIED', message: 'Denied' },
              } as AgentAppResponse)
            : response(request.method, {}),
        subscribe: () => () => undefined,
      },
    });
    await expect(denied.connect()).rejects.toThrow('Denied');
    expect(denied.getSnapshot().connection).toMatchObject({ status: 'failed', message: 'Denied' });
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1' });
    await expect(client.cancelThread()).rejects.toThrow('Select a thread first');
    await expect(client.interruptTurn()).rejects.toThrow('Select a thread first');
  });

  it('restores a running selected thread as an active connection', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1')]);
    transport.threadStatus = 'running';
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1', threadId: 'parent' });
    expect(client.getSnapshot().connection.status).toBe('running');
  });

  it('loads sanitized provider status independently from Project navigation', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.providerStatus = providerStatus({
      account: {
        state: 'authenticated',
        type: 'chatgpt',
        email: 'user@example.test',
        plan: 'pro',
        accessToken: 'must-not-reach-presentation',
      },
      auth: { state: 'authenticated', expiresAt: 1_800_000_000_000 },
    });
    const client = new AgentWorkspaceClient({ client: transport });

    await client.connect({ projectId: 'p1' });

    expect(client.getSnapshot().selectedProject?.id).toBe('p1');
    expect(client.getSnapshot().provider).toMatchObject({
      state: 'ready',
      provider: { id: 'openai-codex', auth: 'oauth' },
      transport: { preferred: 'websocket', fallback: 'http' },
      account: {
        state: 'authenticated',
        email: 'user@example.test',
        plan: 'pro',
      },
      auth: { state: 'authenticated', expiresAt: 1_800_000_000_000 },
      models: { items: [{ id: 'gpt-5.4', displayName: 'GPT-5.4' }] },
    });
    expect(JSON.stringify(client.getSnapshot().provider)).not.toContain('must-not-reach');
  });

  it('keeps provider failures nonblocking and uses idempotent login controls', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.failProviderRead = true;
    const client = new AgentWorkspaceClient({ client: transport });

    await client.connect({ projectId: 'p1' });
    expect(client.getSnapshot()).toMatchObject({
      connection: { status: 'connected' },
      selectedProject: { id: 'p1' },
      provider: { state: 'error', error: 'Subscription unavailable' },
    });

    transport.failProviderRead = false;
    await client.refreshProvider();
    await client.startProviderLogin('chatgptDeviceCode');
    expect(client.getSnapshot().provider.login).toMatchObject({
      type: 'chatgptDeviceCode',
      loginId: 'login-device',
      userCode: 'ZX-1234',
    });
    await client.cancelProviderLogin();
    await client.logoutProvider();

    for (const request of transport.requests.filter((entry) =>
      ['provider/login/start', 'provider/login/cancel', 'provider/logout'].includes(entry.method)
    )) {
      expect(request.params).toHaveProperty('idempotencyKey');
      expect(request.params).not.toHaveProperty('projectId');
    }
  });

  it('replaces transient login and stale auth from each authoritative status response', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.providerStatus = providerStatus({
      account: { state: 'authenticated', email: 'old@example.test' },
      auth: { state: 'authenticated', expiresAt: 1_800_000_000_000 },
    });
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1' });
    await client.startProviderLogin('chatgptDeviceCode');
    expect(client.getSnapshot().provider.login?.loginId).toBe('login-device');

    transport.providerStatus = providerStatus({
      account: { state: 'authenticated', email: 'old@example.test' },
      auth: { state: 'expired', expiresAt: 1 },
    });
    await client.refreshProvider();
    expect(client.getSnapshot().provider).toMatchObject({
      account: { state: 'authenticated' },
      auth: { state: 'expired', expiresAt: 1 },
    });
    expect(client.getSnapshot().provider.login).toBeUndefined();

    await client.startProviderLogin('chatgpt');
    transport.failProviderRead = true;
    await expect(client.refreshProvider()).rejects.toThrow('Subscription unavailable');
    expect(client.getSnapshot().provider).toMatchObject({
      state: 'error',
      account: { state: 'unauthenticated' },
      auth: { state: 'unauthenticated' },
    });
    expect(client.getSnapshot().provider.login).toBeUndefined();
  });

  it('does not let a deferred pre-login status erase the successful login generation', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    const client = new AgentWorkspaceClient({ client: transport });
    transport.deferNextProviderStatus = true;

    const staleRefresh = client.refreshProvider();
    await transport.waitForDeferredProviderStatus();
    await client.startProviderLogin('chatgpt');
    expect(client.getSnapshot().provider.login).toMatchObject({ loginId: 'login-browser' });

    transport.resolveDeferredProviderStatus();
    await staleRefresh;
    expect(client.getSnapshot().provider.login).toMatchObject({ loginId: 'login-browser' });
  });
});

class WorkspaceTransport implements AgentAppClient {
  readonly requests: AgentAppRequest[] = [];
  readonly threads = new Map<string, Array<ReturnType<typeof summary>>>();
  private listeners = new Set<(value: AgentAppNotificationEnvelope) => void>();
  deferThreadListFor?: string;
  invalidResponseFor?: string;
  threadStatus: ThreadSnapshot['status'] = 'idle';
  providerStatus: Record<string, unknown> = providerStatus();
  failProviderRead = false;
  deferNextProviderStatus = false;
  loseCreateResponseOnce = false;
  loseTurnResponseOnce = false;
  threadCreateCommits = 0;
  turnStartCommits = 0;
  private readonly createdThreadsByKey = new Map<string, ThreadSnapshot>();
  private readonly turnsByKey = new Map<string, NonNullable<ThreadSnapshot['turns'][number]>>();
  private readonly lostResponses = new Set<string>();
  private deferred?: () => void;
  private providerStatusDeferred = deferred<void>();
  private providerStatusWaiting = deferred<void>();
  constructor(private readonly projects: ProjectSnapshot[]) {}

  async request(request: AgentAppRequest): Promise<AgentAppResponse> {
    this.requests.push(request);
    if (request.method === this.invalidResponseFor) return response('wrong', {});
    const params = request.params as Record<string, unknown>;
    if (request.method === 'provider/read' || request.method === 'provider/refresh') {
      if (this.failProviderRead) return failure(request.method, 'Subscription unavailable');
      const status = this.providerStatus;
      if (this.deferNextProviderStatus) {
        this.deferNextProviderStatus = false;
        this.providerStatusWaiting.resolve(undefined);
        await this.providerStatusDeferred.promise;
      }
      return response(request.method, { status });
    }
    if (request.method === 'provider/login/start') {
      return response(request.method, {
        result:
          params.type === 'chatgptDeviceCode'
            ? {
                type: 'chatgptDeviceCode',
                loginId: 'login-device',
                verificationUrl: 'https://auth.example/device',
                userCode: 'ZX-1234',
              }
            : {
                type: 'chatgpt',
                loginId: 'login-browser',
                authUrl: 'https://auth.example/login',
              },
      });
    }
    if (request.method === 'provider/login/cancel')
      return response(request.method, { result: { status: 'canceled' } });
    if (request.method === 'provider/logout') return response(request.method, { result: {} });
    if (request.method === 'project/list')
      return response(request.method, { projects: this.projects });
    if (request.method === 'project/create') {
      const created = project('created', String(params.name));
      this.projects.push(created);
      return response(request.method, { project: created });
    }
    if (request.method === 'project/update') {
      const updated = { ...this.projects[0]!, name: String(params.name ?? this.projects[0]!.name) };
      this.projects.splice(0, 1, updated);
      return response(request.method, { project: updated });
    }
    if (request.method === 'project/archive') {
      this.projects.splice(0, 1);
      return response(request.method, { project: project('archived', 'Archived') });
    }
    if (request.method === 'thread/list') {
      if (params.projectId === this.deferThreadListFor)
        await new Promise<void>((resolve) => {
          this.deferred = resolve;
        });
      return response(request.method, {
        threads: this.threads.get(String(params.projectId)) ?? [],
      });
    }
    if (request.method === 'thread/read')
      return response(request.method, {
        thread: { ...thread(String(params.threadId)), status: this.threadStatus },
      });
    if (request.method === 'thread/create') {
      const key = String(params.idempotencyKey);
      let created = this.createdThreadsByKey.get(key);
      if (!created) {
        this.threadCreateCommits += 1;
        created = thread(
          this.threadCreateCommits === 1
            ? 'created-thread'
            : `created-thread-${this.threadCreateCommits}`
        );
        this.createdThreadsByKey.set(key, created);
        const projectId = String(params.projectId);
        const list = this.threads.get(projectId) ?? [];
        this.threads.set(projectId, [
          ...list,
          summary(
            created.id,
            projectId,
            typeof params.modelProfile === 'string' ? params.modelProfile : undefined
          ),
        ]);
      }
      const lossKey = `thread/create:${key}`;
      if (this.loseCreateResponseOnce && !this.lostResponses.has(lossKey)) {
        this.lostResponses.add(lossKey);
        throw new Error('thread/create response lost');
      }
      return response(request.method, { thread: created });
    }
    if (request.method === 'turn/start') {
      const key = String(params.idempotencyKey);
      let turn = this.turnsByKey.get(key);
      if (!turn) {
        this.turnStartCommits += 1;
        turn = {
          id: this.turnStartCommits === 1 ? 'turn' : `turn-${this.turnStartCommits}`,
          runId: 'run',
          status: 'inProgress',
          itemIds: [],
        };
        this.turnsByKey.set(key, turn);
      }
      const lossKey = `turn/start:${key}`;
      if (this.loseTurnResponseOnce && !this.lostResponses.has(lossKey)) {
        this.lostResponses.add(lossKey);
        throw new Error('turn/start response lost');
      }
      return response(request.method, { turn });
    }
    return response(request.method, { ok: true });
  }
  subscribe(listener: (value: AgentAppNotificationEnvelope) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(projectId: string, notification: AgentAppNotificationEnvelope['notification']): void {
    this.listeners.forEach((listener) => listener({ projectId, notification }));
  }
  resolveDeferred(): void {
    this.deferred?.();
  }
  async waitForDeferredProviderStatus(): Promise<void> {
    await this.providerStatusWaiting.promise;
  }
  resolveDeferredProviderStatus(): void {
    this.providerStatusDeferred.resolve(undefined);
    this.providerStatusDeferred = deferred<void>();
    this.providerStatusWaiting = deferred<void>();
  }
}

function project(id: string, name: string): ProjectSnapshot {
  return {
    id,
    name,
    rootPath: `/${id}`,
    createdAtMs: 0,
    updatedAtMs: 0,
    status: 'active',
    policy: {
      maxActiveExecutions: 2,
      maxThreadDepth: 4,
      agentCanCreateThreads: true,
      agentCanMessagePeers: true,
    },
  };
}
function summary(threadId: string, projectId: string, modelProfile?: string) {
  return {
    threadId,
    projectId,
    depth: 0,
    status: 'queued',
    ...(modelProfile ? { modelProfile } : {}),
  };
}
function thread(id: string): ThreadSnapshot {
  return { id, status: 'idle', turns: [], items: [] };
}
function response(method: string, result: Record<string, unknown>): AgentAppResponse {
  return { method: method as never, ok: true, result };
}

function failure(method: string, message: string): AgentAppResponse {
  return { method, ok: false, error: { code: 'INVALID_REQUEST', message } };
}

function providerStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'ready',
    refreshing: false,
    provider: { id: 'openai-codex', auth: 'oauth' },
    transport: {
      identity: 'openai-codex-responses',
      preferred: 'websocket',
      fallback: 'http',
    },
    account: { state: 'unauthenticated' },
    auth: { state: 'unauthenticated' },
    models: {
      state: 'ready',
      items: [
        {
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          hidden: false,
        },
      ],
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
