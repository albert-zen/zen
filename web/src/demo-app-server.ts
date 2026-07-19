import type {
  AgentAppClient,
  AgentAppNotification,
  AgentAppNotificationListener,
  AgentAppRequest,
  AgentAppResponse,
  AgentAppSubscription,
  ProjectSnapshot,
  ProtocolItem,
  ThreadSnapshot,
  TurnSnapshot,
} from '#zen/product';

type DemoThread = {
  id: string;
  projectId: string;
  objective: string;
  parentThreadId?: string;
  modelProfile?: string;
  depth: number;
  status:
    'queued' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'canceled' | 'archived';
  turns: TurnSnapshot[];
  items: ProtocolItem[];
};

const policy = {
  maxActiveExecutions: 3,
  maxThreadDepth: 4,
  defaultModelProfile: 'balanced',
  agentCanCreateThreads: true,
  agentCanMessagePeers: true,
};

/** Browser-only fixture for workspace visual and component verification. */
export function createBrowserDemoAppServer(): AgentAppClient {
  const projects: ProjectSnapshot[] = [
    project('demo-project-alpha', 'Kernel migration', '/demo/kernel'),
    project('demo-project-beta', 'Release coordination', '/demo/release'),
  ];
  const threads = new Map<string, DemoThread>();
  const listeners = new Set<AgentAppNotificationListener>();
  let next = 1;

  const root = createThread('demo-project-alpha', 'Map the item-first kernel');
  const childA = createThread('demo-project-alpha', 'Review projection boundaries', root.id);
  const childB = createThread('demo-project-alpha', 'Verify notification handoff', root.id);
  const release = createThread('demo-project-beta', 'Prepare release checklist');
  append(childA, 'assistant.message.completed', {
    content: 'Review is ready for the parent thread.',
  });
  append(childB, 'thread.wait.started', { threadIds: [childA.id], mode: 'all' });
  childB.status = 'waiting';
  append(root, 'thread.handoff', {
    sourceThreadId: root.id,
    targetThreadId: childA.id,
    correlationId: 'demo-review-1',
  });
  append(release, 'assistant.message.completed', {
    content: 'Release work is queued for the next operator.',
  });

  return {
    subscribe(listener): AgentAppSubscription {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(request: AgentAppRequest): Promise<AgentAppResponse> {
      const params = object(request.params);
      if (request.method === 'project/list') return ok(request.method, { projects });
      if (request.method === 'project/create') {
        const created = project(`demo-project-${next++}`, text(params.name), text(params.rootPath));
        projects.push(created);
        return ok(request.method, { project: created });
      }
      const projectId = text(params.projectId);
      const currentProject = projects.find((entry) => entry.id === projectId);
      if (!currentProject) return fail(request.method, 'PROJECT_NOT_FOUND', 'Unknown demo project');
      if (request.method === 'project/read') return ok(request.method, { project: currentProject });
      if (request.method === 'project/update') {
        const updated = {
          ...currentProject,
          ...(typeof params.name === 'string' ? { name: params.name } : {}),
          ...(typeof params.rootPath === 'string' ? { rootPath: params.rootPath } : {}),
        };
        projects.splice(projects.indexOf(currentProject), 1, updated);
        return ok(request.method, { project: updated });
      }
      if (request.method === 'project/archive') {
        const archived = { ...currentProject, status: 'archived' as const };
        projects.splice(projects.indexOf(currentProject), 1, archived);
        return ok(request.method, { project: archived });
      }
      if (request.method === 'thread/list')
        return ok(request.method, { threads: list(projectId), persistenceFailures: [] });
      if (request.method === 'thread/create') {
        const created = createThread(
          projectId,
          typeof params.objective === 'string' ? params.objective : 'Untitled thread',
          optional(params.sourceThreadId),
          optional(params.modelProfile)
        );
        emit(projectId, { type: 'thread/started', thread: snapshot(created) });
        return ok(request.method, { thread: snapshot(created) });
      }
      const thread = threads.get(text(params.threadId));
      if (!thread || thread.projectId !== projectId)
        return fail(request.method, 'THREAD_NOT_FOUND', 'Unknown demo thread');
      if (request.method === 'thread/read') return ok(request.method, { thread: snapshot(thread) });
      if (request.method === 'turn/start') {
        const turn = turnFor(thread);
        thread.status = 'running';
        emit(projectId, { type: 'turn/started', threadId: thread.id, turn });
        append(thread, 'user.message.completed', { content: String(params.input ?? '') }, turn);
        append(
          thread,
          'assistant.message.completed',
          { content: `Demo agent recorded the human turn and will coordinate follow-up work.` },
          turn
        );
        thread.status = 'completed';
        const completed = { ...turn, status: 'completed' as const, itemIds: [...turn.itemIds] };
        thread.turns.splice(thread.turns.indexOf(turn), 1, completed);
        emit(projectId, { type: 'turn/completed', threadId: thread.id, turn: completed });
        return ok(request.method, { turn: completed });
      }
      if (request.method === 'thread/cancel') {
        thread.status = 'canceled';
        append(thread, 'thread.canceled', { threadId: thread.id });
        return ok(request.method, { ok: true });
      }
      if (request.method === 'thread/archive') {
        thread.status = 'archived';
        append(thread, 'thread.archived', { threadId: thread.id });
        return ok(request.method, { ok: true });
      }
      if (request.method === 'thread/wait') {
        thread.status = 'waiting';
        append(thread, 'thread.wait.started', {
          threadIds: strings(params.threadIds),
          mode: optional(params.mode) ?? 'all',
        });
        return ok(request.method, { wait: { status: 'waiting' } });
      }
      if (request.method === 'thread/handoff') {
        append(thread, 'thread.handoff', {
          sourceThreadId: optional(params.sourceThreadId) ?? '',
          targetThreadId: thread.id,
          correlationId: `handoff-${next++}`,
          content: optional(params.content) ?? '',
        });
        return ok(request.method, { handoff: { ok: true } });
      }
      return fail(request.method, 'INVALID_REQUEST', `Unsupported demo request: ${request.method}`);
    },
  };

  function createThread(
    projectId: string,
    objective: string,
    parentThreadId?: string,
    modelProfile?: string
  ): DemoThread {
    const parent = parentThreadId ? threads.get(parentThreadId) : undefined;
    const thread: DemoThread = {
      id: `demo-thread-${next++}`,
      projectId,
      objective,
      parentThreadId,
      modelProfile: modelProfile ?? policy.defaultModelProfile,
      depth: (parent?.depth ?? -1) + 1,
      status: 'queued',
      turns: [],
      items: [],
    };
    threads.set(thread.id, thread);
    append(thread, 'thread.created', { objective });
    return thread;
  }

  function append(
    thread: DemoThread,
    type: string,
    payload: ProtocolItem['payload'],
    currentTurn?: TurnSnapshot
  ): void {
    const item: ProtocolItem = {
      id: `demo-item-${next++}`,
      type,
      createdAtMs: Date.now(),
      seq: thread.items.length + 1,
      runId: currentTurn?.runId ?? `demo-run-${next}`,
      turnId: currentTurn?.id ?? `demo-turn-${next}`,
      payload,
    };
    thread.items.push(item);
    if (currentTurn) (currentTurn.itemIds as string[]).push(item.id);
    emit(thread.projectId, {
      type: 'item/appended',
      threadId: thread.id,
      turnId: item.turnId,
      item,
    });
  }

  function turnFor(thread: DemoThread): TurnSnapshot {
    const turn: TurnSnapshot = {
      id: `demo-turn-${next++}`,
      runId: `demo-run-${next++}`,
      status: 'inProgress',
      itemIds: [],
    };
    thread.turns.push(turn);
    return turn;
  }

  function list(projectId: string) {
    return [...threads.values()]
      .filter((thread) => thread.projectId === projectId)
      .map((thread) => ({
        projectId,
        threadId: thread.id,
        objective: thread.objective,
        parentThreadId: thread.parentThreadId,
        depth: thread.depth,
        status: thread.status,
        modelProfile: thread.modelProfile,
      }));
  }

  function snapshot(thread: DemoThread): ThreadSnapshot {
    return {
      id: thread.id,
      status:
        thread.status === 'running' ? 'running' : thread.status === 'failed' ? 'failed' : 'idle',
      turns: thread.turns.map((turn) => ({ ...turn, itemIds: [...turn.itemIds] })),
      items: thread.items.map((item) => ({ ...item })),
    };
  }

  function emit(projectId: string, notification: AgentAppNotification): void {
    listeners.forEach((listener) => listener({ projectId, notification }));
  }
}

function project(id: string, name: string, rootPath: string): ProjectSnapshot {
  return { id, name, rootPath, createdAtMs: 0, updatedAtMs: 0, status: 'active', policy };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : 'Untitled';
}
function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
function ok(method: string, result: Record<string, unknown>): AgentAppResponse {
  return { method: method as never, ok: true, result };
}
function fail(
  method: string,
  code: 'PROJECT_NOT_FOUND' | 'THREAD_NOT_FOUND' | 'INVALID_REQUEST',
  message: string
): AgentAppResponse {
  return { method, ok: false, error: { code, message } };
}
