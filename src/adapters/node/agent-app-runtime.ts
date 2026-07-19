import { join, relative, resolve, sep } from 'node:path';

import {
  AgentScheduler,
  DEFAULT_ZEN_SYSTEM_PROMPT,
  ProjectCoordinator,
  ThreadManager,
  ThreadToolRuntime,
  threadToolDefinitions,
  type AgentAppNotification,
  type AgentAppRequest,
  type AgentAppRequestContext,
  type AgentAppResponse,
  type ProjectRuntime,
  type ProjectSnapshot,
  type ThreadRuntimeFactory,
} from '../../product/index.js';
import { AppServer } from '../../product/app-server.js';
import {
  CompositeToolRuntime,
  type ModelGateway,
  type ToolCallPayload,
} from '../../kernel/index.js';
import { FileProjectCoordinationJournal } from './file-project-coordination-journal.js';
import { FileThreadJournal } from './file-thread-journal.js';
import { LocalToolRuntime, localToolDefinitions } from './local-tool-runtime.js';
import {
  loadModelProviderConfig,
  type ModelProviderConfigOptions,
} from './model-provider-config.js';
import { OpenAiCompatibleModelGateway } from './openai-compatible-model-gateway.js';
import { replayThreadJournal } from './provider-runtime.js';

export type AgentAppProjectRuntimeFactoryOptions = {
  /** Explicit application-data root; project discovery is always registry-driven. */
  readonly appDataRoot: string;
  readonly config?: ModelProviderConfigOptions;
  readonly createModel?: (
    project: ProjectSnapshot,
    toolDefinitions: readonly { readonly function: { readonly name: string } }[]
  ) => ModelGateway;
  readonly requestAgentApp?: (
    request: AgentAppRequest,
    context: Extract<AgentAppRequestContext, { readonly actor: 'agent' }>
  ) => Promise<AgentAppResponse>;
};

type ProjectRuntimeState = { current: ProjectSnapshot };

export function createAgentAppProjectRuntimeFactory(
  options: AgentAppProjectRuntimeFactoryOptions
): (project: ProjectSnapshot) => Promise<ProjectRuntime> {
  const appDataRoot = resolve(options.appDataRoot);
  return async (project) => await NodeProjectRuntime.open(project, appDataRoot, options);
}

/**
 * Project IDs become one base64url path component.  This deliberately does
 * not use a human-readable ID as a filesystem path and never scans app data.
 */
export function projectRuntimeDirectory(appDataRoot: string, projectId: string): string {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('Project id must be a non-empty string');
  }
  const root = resolve(appDataRoot, 'projects');
  const encoded = Buffer.from(projectId, 'utf8').toString('base64url');
  const directory = resolve(root, encoded);
  const pathFromRoot = relative(root, directory);
  if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error('Project runtime directory escaped app data root');
  }
  return directory;
}

class NodeProjectRuntime implements ProjectRuntime {
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(
    private readonly state: ProjectRuntimeState,
    private readonly appServer: AppServer,
    private readonly coordinator: ProjectCoordinator,
    private readonly scheduler: AgentScheduler
  ) {}

  static async open(
    project: ProjectSnapshot,
    appDataRoot: string,
    options: AgentAppProjectRuntimeFactoryOptions
  ): Promise<NodeProjectRuntime> {
    const state: ProjectRuntimeState = { current: project };
    const directory = projectRuntimeDirectory(appDataRoot, project.id);
    const threadJournal = new FileThreadJournal({ dir: join(directory, 'threads') });
    const coordinationJournal = new FileProjectCoordinationJournal({
      filePath: join(directory, 'coordination.jsonl'),
    });
    let coordinator: ProjectCoordinator | undefined;
    const scheduler = new AgentScheduler({
      maxActiveExecutions: (projectId) => {
        if (projectId !== project.id) throw new Error('Unexpected project scheduler request');
        return state.current.policy.maxActiveExecutions;
      },
      onEvent: async (event) => {
        await coordinator?.recordLifecycle(event.type, {
          projectId: event.projectId,
          targetThreadId: event.threadId,
          payload: {
            ...(event.leaseId ? { leaseId: event.leaseId } : {}),
            ...(event.status ? { status: event.status } : {}),
            turnId: event.turnId,
          },
        });
      },
    });
    try {
      const { initialThreads, persistenceFailures } = await replayThreadJournal(threadJournal);
      let manager: ThreadManager | undefined;
      const executionProjects = new Map<string, ProjectSnapshot>();
      const runtimeFactory = createProjectThreadRuntimeFactory(state, executionProjects, options);
      const appServer = new AppServer({
        threadJournal,
        persistenceFailures,
        createThreadManager: (managerOptions) => {
          manager = new ThreadManager({
            ...managerOptions,
            initialThreads,
            runtimeFactory,
            acquireExecutionLease: async ({ threadId, turnId, signal }) => {
              const lease = await scheduler.acquire(project.id, threadId, turnId, signal);
              executionProjects.set(turnId, state.current);
              return {
                settle: async (turn) => {
                  executionProjects.delete(turnId);
                  const failures: unknown[] = [];
                  if (
                    turn.status === 'completed' ||
                    turn.status === 'failed' ||
                    turn.status === 'canceled'
                  ) {
                    await coordinator!
                      .recordExecutionSettled({
                        projectId: project.id,
                        threadId,
                        turnId,
                        status: turn.status,
                      })
                      .catch((cause: unknown) => failures.push(cause));
                  }
                  await scheduler
                    .release(lease, turn.status)
                    .catch((cause: unknown) => failures.push(cause));
                  if (failures.length > 0)
                    throw new AggregateError(failures, 'Turn execution settlement failed');
                },
              };
            },
          });
          return manager;
        },
      });
      coordinator = await ProjectCoordinator.open({
        projectManager: {
          read: async (id) => {
            if (id !== project.id) throw new Error(`Unknown project: ${id}`);
            return state.current;
          },
        },
        journal: coordinationJournal,
        createThreadManager: () => {
          if (!manager) throw new Error('Project ThreadManager was not initialized');
          return manager;
        },
      });
      for (const thread of manager?.listThreads() ?? []) await manager?.flushThread(thread.id);
      await coordinator.recover(project.id);
      for (const thread of manager?.listThreads() ?? []) {
        const latest = thread.turns.at(-1);
        if (
          latest?.status === 'completed' ||
          latest?.status === 'failed' ||
          latest?.status === 'canceled'
        ) {
          await coordinator.recordExecutionSettled({
            projectId: project.id,
            threadId: thread.id,
            turnId: latest.id,
            status: latest.status,
          });
        }
      }
      return new NodeProjectRuntime(state, appServer, coordinator, scheduler);
    } catch (cause) {
      const results = await Promise.allSettled([
        scheduler.close(),
        coordinationJournal.close(),
        threadJournal.close(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0)
        throw new AggregateError([cause, ...failures], 'Project runtime startup failed', {
          cause,
        });
      throw cause;
    }
  }

  observe(listener: (notification: AgentAppNotification) => void): () => void {
    return this.appServer.subscribe(listener);
  }

  async request(
    request: AgentAppRequest,
    context: AgentAppRequestContext
  ): Promise<AgentAppResponse> {
    if (this.closed) return failure(request.method, 'SERVER_CLOSING', 'Project runtime is closing');
    const params = request.params;
    try {
      if (context.actor === 'agent') this.authorizeAgentRequest(request, context);
      if (request.method === 'thread/create') {
        const created = await this.coordinator.createThread({
          projectId: this.state.current.id,
          sourceThreadId: optionalText(params.sourceThreadId),
          objective: optionalText(params.objective),
          modelProfile: optionalText(params.modelProfile),
          idempotencyKey: requiredText(params.idempotencyKey, 'idempotencyKey'),
        });
        return success(request.method, {
          thread: this.coordinator.readThread(this.state.current.id, created.threadId),
        });
      }
      if (request.method === 'thread/list') {
        return success(request.method, {
          threads: this.coordinator.listThreadSummaries(this.state.current.id),
        });
      }
      if (request.method === 'thread/read') {
        return success(request.method, {
          thread: this.coordinator.readThread(
            this.state.current.id,
            requiredText(params.threadId, 'threadId')
          ),
        });
      }
      if (request.method === 'thread/send') {
        const result = await this.coordinator.sendMessage({
          projectId: this.state.current.id,
          sourceThreadId: requiredText(params.sourceThreadId, 'sourceThreadId'),
          targetThreadId: requiredText(params.threadId, 'threadId'),
          content: requiredText(params.content, 'content'),
          idempotencyKey: requiredText(params.idempotencyKey, 'idempotencyKey'),
          interrupt: params.interrupt === true,
        });
        return success(request.method, { message: result });
      }
      if (request.method === 'thread/wait') {
        const targets = requiredTextArray(params.threadIds, 'threadIds');
        const result = await this.coordinator.startWait({
          projectId: this.state.current.id,
          sourceThreadId: requiredText(params.threadId, 'threadId'),
          targetThreadIds: targets,
          mode: params.mode === 'any' ? 'any' : params.mode === 'all' ? 'all' : invalidMode(),
          idempotencyKey: requiredText(params.idempotencyKey, 'idempotencyKey'),
        });
        return success(request.method, { wait: result });
      }
      if (request.method === 'thread/cancel') {
        const threadId = requiredText(params.threadId, 'threadId');
        await this.coordinator.cancelThread({
          projectId: this.state.current.id,
          threadId,
          idempotencyKey: requiredText(params.idempotencyKey, 'idempotencyKey'),
        });
        return success(request.method, { ok: true });
      }
      if (request.method === 'thread/archive') {
        const threadId = requiredText(params.threadId, 'threadId');
        await this.coordinator.archiveThread({
          projectId: this.state.current.id,
          threadId,
          idempotencyKey: requiredText(params.idempotencyKey, 'idempotencyKey'),
        });
        return success(request.method, { ok: true });
      }
      if (request.method === 'thread/handoff') {
        return success(request.method, {
          handoff: await this.coordinator.handoff({
            projectId: this.state.current.id,
            sourceThreadId: requiredText(params.sourceThreadId, 'sourceThreadId'),
            targetThreadId: requiredText(params.threadId, 'threadId'),
            content: requiredText(params.content, 'content'),
            idempotencyKey: requiredText(params.idempotencyKey, 'idempotencyKey'),
          }),
        });
      }
      if (
        request.method === 'turn/start' ||
        request.method === 'turn/interrupt' ||
        request.method === 'turn/retry' ||
        request.method === 'approval/resolve'
      ) {
        this.coordinator.assertThreadExecutable(
          this.state.current.id,
          requiredText(params.threadId, 'threadId')
        );
        return (await this.appServer.request({
          method: request.method,
          params,
        })) as AgentAppResponse;
      }
      return failure(
        request.method,
        'INVALID_REQUEST',
        `Unsupported project method: ${request.method}`
      );
    } catch (cause) {
      return failure(
        request.method,
        runtimeErrorCode(cause),
        cause instanceof Error ? cause.message : String(cause)
      );
    }
  }

  async update(project: ProjectSnapshot): Promise<void> {
    if (project.id !== this.state.current.id || project.rootPath !== this.state.current.rootPath) {
      throw new Error('Project runtime identity cannot change');
    }
    this.state.current = project;
    await this.scheduler.refresh(project.id);
  }

  private authorizeAgentRequest(
    request: AgentAppRequest,
    context: Extract<AgentAppRequestContext, { readonly actor: 'agent' }>
  ): void {
    if (
      context.projectId !== this.state.current.id ||
      context.executionProject.id !== this.state.current.id ||
      request.params.projectId !== context.projectId
    ) {
      throw new Error('Agent project authority mismatch');
    }
    const policy = context.executionProject.policy;
    const source = context.sourceThreadId;
    const suppliedSource = request.params.sourceThreadId;
    if (suppliedSource !== undefined && suppliedSource !== source) {
      throw new Error('Agent source thread authority mismatch');
    }
    if (request.method === 'thread/create' && !policy.agentCanCreateThreads) {
      throw new Error('Agent thread creation is not permitted by captured execution policy');
    }
    if (request.method === 'thread/send' || request.method === 'thread/handoff') {
      if (!policy.agentCanMessagePeers) {
        throw new Error('Agent thread messaging is not permitted by captured execution policy');
      }
    }
    if (
      request.method === 'thread/send' ||
      request.method === 'thread/cancel' ||
      request.method === 'thread/archive' ||
      request.method === 'thread/handoff'
    ) {
      const target = requiredText(request.params.threadId, 'threadId');
      const relation = this.coordinator.relation(context.projectId, source, target);
      if (relation === 'self' || relation === 'ancestor') {
        throw new Error('Agents cannot control or message their active thread or an ancestor');
      }
    }
    if (request.method === 'thread/wait' && request.params.threadId !== source) {
      throw new Error('Agent wait source authority mismatch');
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return await this.closePromise;
  }

  private async closeResources(): Promise<void> {
    this.closed = true;
    const failures: unknown[] = [];
    for (const close of [
      () => this.scheduler.close(),
      () => this.appServer.close(),
      () => this.coordinator.close(),
    ]) {
      const result = await Promise.allSettled([close()]);
      failures.push(
        ...result.flatMap((entry) => (entry.status === 'rejected' ? [entry.reason] : []))
      );
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Project runtime close failed');
  }
}

function createProjectThreadRuntimeFactory(
  state: ProjectRuntimeState,
  executionProjects: ReadonlyMap<string, ProjectSnapshot>,
  options: AgentAppProjectRuntimeFactoryOptions
): ThreadRuntimeFactory {
  return ({ thread, turn, approvalBroker }) => {
    const project = executionProjects.get(turn.id) ?? state.current;
    const local = new LocalToolRuntime({ cwd: project.rootPath, approvalBroker });
    const threadTools = new ThreadToolRuntime({
      request: async (request, execution) => {
        if (!options.requestAgentApp) throw new Error('Agent App command path is unavailable');
        return await options.requestAgentApp(request, {
          actor: 'agent',
          projectId: project.id,
          sourceThreadId: thread.id,
          executionProject: project,
          signal: execution.signal,
        });
      },
      resolveExecutionContext: () => ({
        actor: 'agent',
        projectId: project.id,
        sourceThreadId: thread.id,
      }),
    });
    const toolRuntime = new CompositeToolRuntime([
      {
        matches: (call: ToolCallPayload) =>
          threadToolDefinitions.some((tool) => tool.function.name === call.name),
        runtime: threadTools,
      },
      {
        matches: (call: ToolCallPayload) =>
          localToolDefinitions.some((tool) => tool.function.name === call.name),
        runtime: local,
      },
    ]);
    return {
      model:
        options.createModel?.(project, [...threadToolDefinitions, ...localToolDefinitions]) ??
        createConfiguredModel(project, options),
      toolRuntime,
      systemPrompt: DEFAULT_ZEN_SYSTEM_PROMPT,
    };
  };
}

function createConfiguredModel(
  project: ProjectSnapshot,
  options: AgentAppProjectRuntimeFactoryOptions
): ModelGateway {
  const config = loadModelProviderConfig(options.config);
  return new OpenAiCompatibleModelGateway({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: project.policy.defaultModelProfile ?? config.modelId,
    defaultParams: config.params,
    tools: [...threadToolDefinitions, ...localToolDefinitions],
  });
}

function success(
  method: AgentAppRequest['method'],
  result: Readonly<Record<string, unknown>>
): AgentAppResponse {
  return { method, ok: true, result };
}

function failure(
  method: string,
  code: import('../../product/index.js').AgentAppErrorCode,
  message: string
): AgentAppResponse {
  return { method, ok: false, error: { code, message } };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label} is required`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function requiredTextArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

function invalidMode(): never {
  throw new Error('mode must be any or all');
}

function runtimeErrorCode(cause: unknown): import('../../product/index.js').AgentAppErrorCode {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes('Unknown project') || message.includes('Unknown project thread'))
    return 'THREAD_NOT_FOUND';
  if (message.includes('idempotency conflict')) return 'IDEMPOTENCY_CONFLICT';
  if (
    message.includes('policy') ||
    message.includes('permitted') ||
    message.includes('authority mismatch') ||
    message.startsWith('Agents cannot')
  )
    return 'POLICY_DENIED';
  if (message.includes('journal') || message.includes('Persistence')) return 'PERSISTENCE_FAILURE';
  return 'INVALID_REQUEST';
}
