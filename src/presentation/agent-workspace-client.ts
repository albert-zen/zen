import type {
  AgentAppClient,
  AgentAppNotification,
  AgentAppResponse,
  AgentAppSubscription,
  ProjectSnapshot,
  ThreadSnapshot,
} from '../product/index.js';
import { InteractionProjection, type WebUiState } from './web-ui-state.js';
import {
  WebUiLifecycleCanceledError,
  type WebUiConnectionState,
  type WebUiRuntimeMode,
} from './web-ui-client.js';

export type WorkspaceThreadStatus =
  'queued' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'canceled' | 'archived';

export type WorkspaceThread = {
  readonly id: string;
  readonly status: WorkspaceThreadStatus;
  readonly depth: number;
  readonly parentThreadId?: string;
  readonly modelProfile?: string;
  readonly objective?: string;
  readonly snapshot?: ThreadSnapshot;
};

export type AgentWorkspaceSnapshot = {
  readonly connection: WebUiConnectionState;
  readonly projects: readonly ProjectSnapshot[];
  readonly selectedProject?: ProjectSnapshot;
  readonly threads: readonly WorkspaceThread[];
  readonly selectedThread?: ThreadSnapshot;
  readonly state: WebUiState;
};

export type AgentWorkspaceClientOptions = {
  readonly client: AgentAppClient;
  readonly mode?: WebUiRuntimeMode;
};

export type AgentWorkspaceClientListener = (snapshot: AgentWorkspaceSnapshot) => void;

/** Project-scoped presentation projection. Domain snapshots remain server-owned. */
export class AgentWorkspaceClient {
  private projection = new InteractionProjection();
  private readonly listeners = new Set<AgentWorkspaceClientListener>();
  private readonly client: AgentAppClient;
  private connection: WebUiConnectionState;
  private projects: readonly ProjectSnapshot[] = [];
  private selectedProject?: ProjectSnapshot;
  private threads: readonly WorkspaceThread[] = [];
  private selectedThread?: ThreadSnapshot;
  private snapshot: AgentWorkspaceSnapshot;
  private unsubscribe?: AgentAppSubscription;
  private generation = 0;

  constructor(options: AgentWorkspaceClientOptions) {
    this.client = options.client;
    this.connection = { mode: options.mode ?? 'real', status: 'disconnected' };
    this.snapshot = this.materialize();
  }

  getSnapshot(): AgentWorkspaceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: AgentWorkspaceClientListener): AgentAppSubscription {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async connect(
    options: { readonly projectId?: string; readonly threadId?: string } = {}
  ): Promise<void> {
    const generation = this.replaceLifecycle();
    this.connection = { ...this.connection, status: 'connecting', message: undefined };
    this.publish();
    try {
      await this.loadProjects(generation);
      const project =
        this.projects.find(
          (entry) => entry.id === options.projectId && entry.status === 'active'
        ) ?? this.projects.find((entry) => entry.status === 'active');
      if (!project) {
        this.selectedProject = undefined;
        this.clearThreadProjection();
        this.connection = { ...this.connection, status: 'connected', message: undefined };
        this.publish();
        return;
      }
      await this.activateProject(project.id, options.threadId, generation);
    } catch (cause) {
      if (generation === this.generation) this.fail(cause);
      throw cause;
    }
  }

  disconnect(): void {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.connection = { ...this.connection, status: 'disconnected', message: undefined };
    this.publish();
  }

  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }

  async selectProject(projectId: string, threadId?: string): Promise<void> {
    const generation = this.replaceLifecycle();
    await this.activateProject(projectId, threadId, generation);
  }

  async createProject(input: {
    readonly name: string;
    readonly rootPath: string;
    readonly policy?: ProjectSnapshot['policy'];
  }): Promise<ProjectSnapshot> {
    const response = await this.request('project/create', {
      ...input,
      idempotencyKey: this.idempotencyKey(),
    });
    const project = readProject(response, 'project/create');
    const generation = this.generation;
    await this.loadProjects(generation);
    await this.activateProject(project.id, undefined, generation);
    return project;
  }

  async updateProject(input: {
    readonly name?: string;
    readonly rootPath?: string;
    readonly policy?: ProjectSnapshot['policy'];
  }): Promise<ProjectSnapshot> {
    const projectId = this.requireProjectId();
    const project = readProject(
      await this.request('project/update', {
        projectId,
        ...input,
        idempotencyKey: this.idempotencyKey(),
      }),
      'project/update'
    );
    this.projects = this.projects.map((entry) => (entry.id === project.id ? project : entry));
    this.selectedProject = project;
    this.publish();
    return project;
  }

  async archiveProject(): Promise<void> {
    const projectId = this.requireProjectId();
    await this.request('project/archive', { projectId, idempotencyKey: this.idempotencyKey() });
    await this.connect();
  }

  async refreshProjects(): Promise<void> {
    await this.loadProjects(this.generation);
    this.publish();
  }

  async refreshThreads(): Promise<void> {
    const generation = this.generation;
    const projectId = this.requireProjectId();
    const response = await this.request('thread/list', { projectId });
    this.assertCurrent(generation);
    this.threads = readThreads(response);
    this.publish();
  }

  async selectThread(threadId: string): Promise<void> {
    const generation = this.generation;
    const projectId = this.requireProjectId();
    const thread = readThread(
      await this.request('thread/read', { projectId, threadId }),
      'thread/read'
    );
    this.assertCurrent(generation);
    this.installThread(thread);
    this.publish();
  }

  async createThread(input: {
    readonly objective: string;
    readonly parentThreadId?: string;
    readonly modelProfile?: string;
  }): Promise<ThreadSnapshot> {
    const generation = this.generation;
    const projectId = this.requireProjectId();
    const thread = readThread(
      await this.request('thread/create', {
        projectId,
        objective: input.objective,
        ...(input.parentThreadId ? { sourceThreadId: input.parentThreadId } : {}),
        ...(input.modelProfile ? { modelProfile: input.modelProfile } : {}),
        idempotencyKey: this.idempotencyKey(),
      }),
      'thread/create'
    );
    this.assertCurrent(generation);
    await this.refreshThreads();
    this.installThread(thread);
    this.publish();
    return thread;
  }

  async sendHumanTurn(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return;
    const projectId = this.requireProjectId();
    const threadId = this.requireThreadId();
    this.connection = { ...this.connection, status: 'running', message: undefined };
    this.publish();
    await this.request('turn/start', {
      projectId,
      threadId,
      input: trimmed,
      idempotencyKey: this.idempotencyKey(),
    });
  }

  async cancelThread(): Promise<void> {
    await this.threadCommand('thread/cancel');
  }

  async archiveThread(): Promise<void> {
    await this.threadCommand('thread/archive');
  }

  async handoff(targetThreadId: string, content: string): Promise<void> {
    const projectId = this.requireProjectId();
    const sourceThreadId = this.requireThreadId();
    await this.request('thread/handoff', {
      projectId,
      sourceThreadId,
      threadId: targetThreadId,
      content,
      idempotencyKey: this.idempotencyKey(),
    });
    await this.refreshThreads();
  }

  async waitFor(threadIds: readonly string[], mode: 'all' | 'any' = 'all'): Promise<void> {
    const projectId = this.requireProjectId();
    await this.request('thread/wait', {
      projectId,
      threadId: this.requireThreadId(),
      threadIds,
      mode,
      idempotencyKey: this.idempotencyKey(),
    });
    await this.refreshThreads();
  }

  private async activateProject(
    projectId: string,
    threadId: string | undefined,
    generation: number
  ): Promise<void> {
    const project = this.projects.find(
      (entry) => entry.id === projectId && entry.status === 'active'
    );
    if (!project) throw new Error(`Unknown active project: ${projectId}`);
    this.selectedProject = project;
    this.clearThreadProjection();
    this.unsubscribe?.();
    this.unsubscribe = this.client.subscribe((envelope) => {
      if (generation === this.generation && envelope.projectId === projectId) {
        this.receiveNotification(envelope.notification);
      }
    });
    this.connection = { ...this.connection, status: 'connecting', message: undefined };
    this.publish();
    await this.refreshThreadSelection(threadId, generation);
    this.assertCurrent(generation);
    this.connection = {
      ...this.connection,
      status: selectedThreadRunning(this.selectedThread) ? 'running' : 'connected',
      message: undefined,
    };
    this.publish();
  }

  private async refreshThreadSelection(
    threadId: string | undefined,
    generation: number
  ): Promise<void> {
    const projectId = this.requireProjectId();
    const response = await this.request('thread/list', { projectId });
    this.assertCurrent(generation);
    this.threads = readThreads(response);
    const selected = threadId ?? this.threads[0]?.id;
    if (!selected) return;
    const thread = readThread(
      await this.request('thread/read', { projectId, threadId: selected }),
      'thread/read'
    );
    this.assertCurrent(generation);
    this.installThread(thread);
  }

  private receiveNotification(notification: AgentAppNotification): void {
    if (notification.type === 'sync/reset') {
      this.threads = notification.threads.map(toWorkspaceThread);
      const selected =
        this.selectedThread &&
        notification.threads.find((thread) => thread.id === this.selectedThread?.id);
      if (selected) this.installThread(selected);
      this.publish();
      return;
    }
    if (notification.type === 'thread/started') {
      this.threads = mergeThread(this.threads, toWorkspaceThread(notification.thread));
      this.publish();
      return;
    }
    if (this.selectedThread?.id !== notification.threadId) return;
    const changed = this.projection.apply(notification);
    const projected = this.projection.getSnapshot();
    this.selectedThread = projected.currentThread
      ? { ...projected.currentThread, items: [...projected.items] }
      : undefined;
    if (notification.type === 'turn/started')
      this.connection = { ...this.connection, status: 'running', message: undefined };
    if (notification.type === 'turn/completed')
      this.connection = { ...this.connection, status: 'connected', message: undefined };
    if (notification.type === 'turn/failed')
      this.connection = {
        ...this.connection,
        status: 'failed',
        message: notification.error.message,
      };
    if (changed) this.publish();
  }

  private installThread(thread: ThreadSnapshot): void {
    this.selectedThread = thread;
    this.threads = mergeThread(this.threads, toWorkspaceThread(thread));
    this.projection.replaceSnapshot(thread);
  }

  private clearThreadProjection(): void {
    this.threads = [];
    this.selectedThread = undefined;
    this.projection = new InteractionProjection();
  }

  private replaceLifecycle(): number {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    return this.generation;
  }

  private async loadProjects(generation: number): Promise<void> {
    const response = await this.request('project/list', {});
    this.assertCurrent(generation);
    if (!response.ok || response.method !== 'project/list') {
      throw new Error(response.ok ? `Unexpected ${response.method}` : response.error.message);
    }
    this.projects = response.result.projects as readonly ProjectSnapshot[];
  }

  private async threadCommand(method: 'thread/cancel' | 'thread/archive'): Promise<void> {
    const projectId = this.requireProjectId();
    await this.request(method, {
      projectId,
      threadId: this.requireThreadId(),
      idempotencyKey: this.idempotencyKey(),
    });
    await this.refreshThreads();
  }

  private async request(
    method: string,
    params: Record<string, unknown>
  ): Promise<AgentAppResponse> {
    const response = await this.client.request({
      method: method as never,
      params: params as never,
    });
    if (!response.ok) {
      this.fail(response.error.message);
      throw new Error(response.error.message);
    }
    return response;
  }

  private requireProjectId(): string {
    if (!this.selectedProject) throw new Error('Select a project first');
    return this.selectedProject.id;
  }

  private requireThreadId(): string {
    if (!this.selectedThread) throw new Error('Select a thread first');
    return this.selectedThread.id;
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new WebUiLifecycleCanceledError();
  }

  private fail(cause: unknown): void {
    this.connection = {
      ...this.connection,
      status: 'failed',
      message: cause instanceof Error ? cause.message : String(cause),
    };
    this.publish();
  }

  private publish(): void {
    this.snapshot = this.materialize();
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private materialize(): AgentWorkspaceSnapshot {
    return {
      connection: this.connection,
      projects: this.projects,
      selectedProject: this.selectedProject,
      threads: this.threads,
      selectedThread: this.selectedThread,
      state: this.projection.getSnapshot(),
    };
  }

  private idempotencyKey(): string {
    return globalThis.crypto?.randomUUID?.() ?? `workspace-${Date.now()}-${Math.random()}`;
  }
}

function readProject(response: AgentAppResponse, method: string): ProjectSnapshot {
  if (!response.ok || response.method !== method || !isRecord(response.result.project)) {
    throw new Error(response.ok ? `Unexpected ${response.method}` : response.error.message);
  }
  return response.result.project as ProjectSnapshot;
}

function readThread(response: AgentAppResponse, method: string): ThreadSnapshot {
  if (!response.ok || response.method !== method || !isRecord(response.result.thread)) {
    throw new Error(response.ok ? `Unexpected ${response.method}` : response.error.message);
  }
  return response.result.thread as ThreadSnapshot;
}

function readThreads(response: AgentAppResponse): readonly WorkspaceThread[] {
  if (
    !response.ok ||
    response.method !== 'thread/list' ||
    !Array.isArray(response.result.threads)
  ) {
    throw new Error(response.ok ? `Unexpected ${response.method}` : response.error.message);
  }
  return response.result.threads.map(toWorkspaceThread);
}

function toWorkspaceThread(value: unknown): WorkspaceThread {
  if (!isRecord(value)) throw new Error('Invalid thread list entry');
  const id = typeof value.threadId === 'string' ? value.threadId : value.id;
  if (typeof id !== 'string') throw new Error('Invalid thread id');
  const status = workspaceStatus(value.status);
  return {
    id,
    status,
    depth: typeof value.depth === 'number' ? value.depth : 0,
    ...(typeof value.parentThreadId === 'string' ? { parentThreadId: value.parentThreadId } : {}),
    ...(typeof value.modelProfile === 'string' ? { modelProfile: value.modelProfile } : {}),
    ...(typeof value.objective === 'string' ? { objective: value.objective } : {}),
    ...('items' in value && 'turns' in value
      ? { snapshot: value as unknown as ThreadSnapshot }
      : {}),
  };
}

function mergeThread(
  threads: readonly WorkspaceThread[],
  next: WorkspaceThread
): readonly WorkspaceThread[] {
  const current = threads.find((thread) => thread.id === next.id);
  const merged = current
    ? {
        ...current,
        ...next,
        parentThreadId: next.parentThreadId ?? current.parentThreadId,
        modelProfile: next.modelProfile ?? current.modelProfile,
        objective: next.objective ?? current.objective,
      }
    : next;
  return [...threads.filter((thread) => thread.id !== next.id), merged].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

function workspaceStatus(value: unknown): WorkspaceThreadStatus {
  if (value === 'idle') return 'completed';
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'waiting' ||
    value === 'blocked' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'canceled' ||
    value === 'archived'
  )
    return value;
  return 'queued';
}

function selectedThreadRunning(thread: ThreadSnapshot | undefined): boolean {
  return thread?.status === 'running';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
