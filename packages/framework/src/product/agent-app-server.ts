import { ProjectManager } from './project-manager.js';
import type { JsonObject, JsonValue } from './app-server-protocol.js';
import type { ProjectSnapshot } from './project-registry.js';
import {
  isAgentAppMutation,
  parseAgentAppRequest,
  type AgentAppNotification,
  type AgentAppNotificationEnvelope,
  type AgentAppRequest,
  type AgentAppResponse,
} from './agent-app-protocol.js';
import { ProjectCommandConflictError, ProjectCommandLedger } from './project-command-ledger.js';
export interface ProjectRuntime {
  request(request: AgentAppRequest, context: AgentAppRequestContext): Promise<AgentAppResponse>;
  update(project: ProjectSnapshot): Promise<void>;
  observe(
    listener: (notification: { readonly type: string; readonly threadId?: string }) => void
  ): () => void;
  close(): Promise<void>;
}
export type AgentAppRequestContext =
  | { readonly actor: 'human' }
  | {
      readonly actor: 'agent';
      readonly projectId: string;
      readonly sourceThreadId: string;
      readonly executionProject: ProjectSnapshot;
      readonly signal?: AbortSignal;
    };
export interface ProviderControl {
  read(): Promise<JsonValue>;
  refresh(): Promise<JsonValue>;
  loginStart(input: JsonObject): Promise<JsonValue>;
  loginCancel(input: JsonObject): Promise<JsonValue>;
  logout(input: JsonObject): Promise<JsonValue>;
}
export type AgentAppServerOptions = {
  readonly projectManager: ProjectManager;
  readonly createRuntime: (project: ProjectSnapshot) => Promise<ProjectRuntime>;
  readonly commandLedger?: ProjectCommandLedger;
  readonly providerControl?: ProviderControl;
};
export class AgentAppServer {
  private readonly runtimes = new Map<string, Promise<ProjectRuntime>>();
  private readonly projectTails = new Map<string, Promise<void>>();
  private readonly inflightCommands = new Map<
    string,
    { readonly digest: string; readonly promise: Promise<AgentAppResponse> }
  >();
  private readonly listeners = new Set<(n: AgentAppNotificationEnvelope) => void>();
  private readonly commandLedger: ProjectCommandLedger;
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(private readonly options: AgentAppServerOptions) {
    this.commandLedger = options.commandLedger ?? ProjectCommandLedger.inMemory();
  }
  observe(listener: (n: AgentAppNotificationEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribe(listener: (n: AgentAppNotificationEnvelope) => void): () => void {
    return this.observe(listener);
  }
  async request(value: unknown): Promise<AgentAppResponse> {
    return await this.requestWithContext(value, { actor: 'human' });
  }
  async requestFromAgent(
    value: unknown,
    context: Extract<AgentAppRequestContext, { readonly actor: 'agent' }>
  ): Promise<AgentAppResponse> {
    return await this.requestWithContext(value, context);
  }
  private async requestWithContext(
    value: unknown,
    context: AgentAppRequestContext
  ): Promise<AgentAppResponse> {
    if (this.closing) return error('SERVER_CLOSING', 'Agent App Server is closing');
    try {
      const request = parseAgentAppRequest(value);
      const response = isAgentAppMutation(request.method)
        ? await this.executeMutation(request, context)
        : await this.dispatch(request, context);
      return request.id === undefined ? response : { ...response, id: request.id };
    } catch (cause) {
      return error(code(cause), cause instanceof Error ? cause.message : String(cause));
    }
  }
  private async executeMutation(
    request: AgentAppRequest,
    context: AgentAppRequestContext
  ): Promise<AgentAppResponse> {
    const scope = request.method.startsWith('provider/')
      ? 'provider'
      : typeof request.params.projectId === 'string'
        ? request.params.projectId
        : 'agent-app';
    const key = String(request.params.idempotencyKey);
    const params = request.method.startsWith('provider/')
      ? providerParams(request.params)
      : request.params;
    const identity = `${scope}\u0000${request.method}\u0000${key}`;
    const digest = stableDigest({ method: request.method, params });
    const inflight = this.inflightCommands.get(identity);
    if (inflight) {
      if (inflight.digest !== digest) {
        throw new ProjectCommandConflictError(scope, request.method, key);
      }
      return await inflight.promise;
    }
    const operation = this.executeMutationOnce(request, scope, key, digest, context);
    this.inflightCommands.set(identity, { digest, promise: operation });
    try {
      return await operation;
    } finally {
      if (this.inflightCommands.get(identity)?.promise === operation) {
        this.inflightCommands.delete(identity);
      }
    }
  }
  private async executeMutationOnce(
    request: AgentAppRequest,
    scope: string,
    key: string,
    digest: string,
    context: AgentAppRequestContext
  ): Promise<AgentAppResponse> {
    const started = await this.commandLedger.begin({
      scope,
      method: request.method,
      idempotencyKey: key,
      digest,
    });
    if (started.state === 'completed') return started.response;
    if (started.state === 'pending' && request.method !== 'thread/handoff') {
      return error('COMMAND_PENDING', `Command outcome is pending recovery: ${request.method}`);
    }
    let response: AgentAppResponse;
    try {
      response = await this.dispatch(request, context);
    } catch (cause) {
      response = error(code(cause), cause instanceof Error ? cause.message : String(cause));
    }
    await this.commandLedger.complete({
      scope,
      method: request.method,
      idempotencyKey: key,
      response,
    });
    return response;
  }
  private async dispatch(
    request: AgentAppRequest,
    context: AgentAppRequestContext
  ): Promise<AgentAppResponse> {
    const p = request.params;
    if (context.actor === 'agent' && !request.method.startsWith('thread/')) {
      return error('POLICY_DENIED', 'Agents may only use thread coordination methods');
    }
    if (request.method.startsWith('provider/')) return await this.dispatchProvider(request);
    if (request.method === 'project/create')
      return {
        method: request.method,
        ok: true,
        result: {
          project: await this.options.projectManager.create({
            name: text(p.name),
            rootPath: text(p.rootPath),
            ...(isRecord(p.policy)
              ? { policy: p.policy as import('./project-registry.js').ProjectPolicy }
              : {}),
          }),
        },
      };
    if (request.method === 'project/list')
      return {
        method: request.method,
        ok: true,
        result: { projects: await this.options.projectManager.list() },
      };
    if (request.method === 'project/read')
      return {
        method: request.method,
        ok: true,
        result: { project: await this.options.projectManager.read(text(p.projectId)) },
      };
    if (request.method === 'project/update') {
      const id = text(p.projectId);
      return await this.serializeProject(id, async () => {
        if ('rootPath' in p) throw new Error('Project root path is immutable');
        const project = await this.options.projectManager.update(id, {
          ...(typeof p.name === 'string' ? { name: p.name } : {}),
          ...(isRecord(p.policy)
            ? { policy: p.policy as import('./project-registry.js').ProjectPolicy }
            : {}),
        });
        const runtime = this.runtimes.get(id);
        if (runtime) await (await runtime).update(project);
        return {
          method: request.method,
          ok: true,
          result: {
            project,
          },
        };
      });
    }
    if (request.method === 'project/archive') {
      const id = text(p.projectId);
      return await this.serializeProject(id, async () => {
        await this.closeRuntime(id);
        const project = await this.options.projectManager.archive(id);
        return { method: request.method, ok: true, result: { project } };
      });
    }
    const projectId = text(p.projectId);
    await (this.projectTails.get(projectId) ?? Promise.resolve());
    const project = await this.options.projectManager.read(projectId);
    if (project.status === 'archived')
      return error('PROJECT_ARCHIVED', `Project is archived: ${project.id}`);
    return await (await this.runtime(project)).request(request, context);
  }
  private async dispatchProvider(request: AgentAppRequest): Promise<AgentAppResponse> {
    const provider = this.options.providerControl;
    if (!provider) {
      return {
        method: request.method,
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: `Unsupported provider control method: ${request.method}`,
        },
      };
    }
    const params = providerParams(request.params);
    if (request.method === 'provider/read') {
      return {
        method: request.method,
        ok: true,
        result: { status: toJsonValue(await provider.read()) },
      };
    }
    if (request.method === 'provider/refresh') {
      return {
        method: request.method,
        ok: true,
        result: { status: toJsonValue(await provider.refresh()) },
      };
    }
    if (request.method === 'provider/login/start') {
      return {
        method: request.method,
        ok: true,
        result: { result: toJsonValue(await provider.loginStart(params)) },
      };
    }
    if (request.method === 'provider/login/cancel') {
      return {
        method: request.method,
        ok: true,
        result: { result: toJsonValue(await provider.loginCancel(params)) },
      };
    }
    if (request.method === 'provider/logout') {
      return {
        method: request.method,
        ok: true,
        result: { result: toJsonValue(await provider.logout(params)) },
      };
    }
    return error('INVALID_REQUEST', `Unsupported provider control method: ${request.method}`);
  }
  private runtime(project: ProjectSnapshot): Promise<ProjectRuntime> {
    let runtime = this.runtimes.get(project.id);
    if (!runtime) {
      runtime = this.options.createRuntime(project);
      this.runtimes.set(project.id, runtime);
      void runtime
        .then((r) =>
          r.observe((n) =>
            this.listeners.forEach((l) =>
              l({ projectId: project.id, notification: n as AgentAppNotification })
            )
          )
        )
        .catch(() => {
          if (this.runtimes.get(project.id) === runtime) this.runtimes.delete(project.id);
        });
    }
    return runtime;
  }
  private async closeRuntime(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId);
    this.runtimes.delete(projectId);
    if (runtime) await (await runtime).close();
  }
  private async serializeProject<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectTails.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.projectTails.set(projectId, tail);
    try {
      return await result;
    } finally {
      if (this.projectTails.get(projectId) === tail) this.projectTails.delete(projectId);
    }
  }
  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const opened = await Promise.allSettled([...this.runtimes.values()]);
      const failures = opened.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      const closed = await Promise.allSettled(
        opened.flatMap((result) => (result.status === 'fulfilled' ? [result.value.close()] : []))
      );
      failures.push(
        ...closed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      );
      if (failures.length > 0) throw new AggregateError(failures, 'Agent App Server close failed');
    })();
    return await this.closePromise;
  }
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid string param');
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function providerParams(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'idempotencyKey' && key !== 'projectId')
  ) as JsonObject;
}
function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, toJsonValue(entry)])
    ) as JsonObject;
  }
  return null;
}
function error(
  code: import('./agent-app-protocol.js').AgentAppErrorCode,
  message: string
): AgentAppResponse {
  return { method: 'unknown', ok: false, error: { code, message } };
}
function code(cause: unknown): import('./agent-app-protocol.js').AgentAppErrorCode {
  if (cause instanceof ProjectCommandConflictError) return 'IDEMPOTENCY_CONFLICT';
  if (cause instanceof Error && cause.message.includes('Unknown project'))
    return 'PROJECT_NOT_FOUND';
  return 'INVALID_REQUEST';
}

function stableDigest(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))
        )
      : entry
  );
}
