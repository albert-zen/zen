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
    expect(client.getSnapshot().selectedThread?.id).toBe('two');
    expect(client.getSnapshot().threads.map((thread) => thread.id)).toEqual(['two']);
  });

  it('adds agent-created child threads from notifications without a local domain copy', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1' });

    transport.emit('p1', { type: 'thread/started', thread: thread('child') });

    expect(client.getSnapshot().threads.map((entry) => entry.id)).toEqual(['child', 'parent']);
  });

  it('uses project-scoped idempotent commands for create, send, cancel, archive, and handoff', async () => {
    const transport = new WorkspaceTransport([project('p1', 'One')]);
    transport.threads.set('p1', [summary('parent', 'p1'), summary('target', 'p1')]);
    const client = new AgentWorkspaceClient({ client: transport });
    await client.connect({ projectId: 'p1', threadId: 'parent' });

    await client.createThread({
      objective: 'Child',
      parentThreadId: 'parent',
      modelProfile: 'reviewer',
    });
    await client.sendHumanTurn('Hello');
    await client.handoff('target', 'Please review');
    await client.cancelThread();
    await client.archiveThread();

    for (const request of transport.requests.filter(
      (entry) =>
        entry.method !== 'project/list' &&
        entry.method !== 'thread/list' &&
        entry.method !== 'thread/read'
    )) {
      expect(request.params).toHaveProperty('idempotencyKey');
      expect(request.params).toHaveProperty('projectId', 'p1');
    }
    expect(
      transport.requests.find((entry) => entry.method === 'thread/create')?.params
    ).toMatchObject({ sourceThreadId: 'parent', modelProfile: 'reviewer' });
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
});

class WorkspaceTransport implements AgentAppClient {
  readonly requests: AgentAppRequest[] = [];
  readonly threads = new Map<string, Array<ReturnType<typeof summary>>>();
  private listeners = new Set<(value: AgentAppNotificationEnvelope) => void>();
  deferThreadListFor?: string;
  private deferred?: () => void;
  constructor(private readonly projects: ProjectSnapshot[]) {}

  async request(request: AgentAppRequest): Promise<AgentAppResponse> {
    this.requests.push(request);
    const params = request.params as Record<string, unknown>;
    if (request.method === 'project/list')
      return response(request.method, { projects: this.projects });
    if (request.method === 'project/create') {
      const created = project('created', String(params.name));
      this.projects.push(created);
      return response(request.method, { project: created });
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
      return response(request.method, { thread: thread(String(params.threadId)) });
    if (request.method === 'thread/create')
      return response(request.method, { thread: thread('created-thread') });
    if (request.method === 'turn/start')
      return response(request.method, {
        turn: { id: 'turn', runId: 'run', status: 'inProgress', itemIds: [] },
      });
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
      maxConcurrentAgents: 2,
      maxThreadDepth: 4,
      agentCanCreateThreads: true,
      agentCanMessagePeers: true,
    },
  };
}
function summary(threadId: string, projectId: string) {
  return { threadId, projectId, depth: 0, status: 'queued', modelProfile: 'balanced' };
}
function thread(id: string): ThreadSnapshot {
  return { id, status: 'idle', turns: [], items: [] };
}
function response(method: string, result: Record<string, unknown>): AgentAppResponse {
  return { method: method as never, ok: true, result };
}
