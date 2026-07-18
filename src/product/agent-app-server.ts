import { ProjectManager } from './project-manager.js';
import type { ProjectSnapshot } from './project-registry.js';
import {
  parseAgentAppRequest,
  type AgentAppNotification,
  type AgentAppNotificationEnvelope,
  type AgentAppRequest,
  type AgentAppResponse,
} from './agent-app-protocol.js';
export interface ProjectRuntime {
  request(request: AgentAppRequest): Promise<AgentAppResponse>;
  observe(listener: (notification: AgentAppNotification) => void): () => void;
  close(): Promise<void>;
}
export type AgentAppServerOptions = {
  readonly projectManager: ProjectManager;
  readonly createRuntime: (project: ProjectSnapshot) => Promise<ProjectRuntime>;
};
export class AgentAppServer {
  private readonly runtimes = new Map<string, Promise<ProjectRuntime>>();
  private readonly listeners = new Set<(n: AgentAppNotificationEnvelope) => void>();
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(private readonly options: AgentAppServerOptions) {}
  observe(listener: (n: AgentAppNotificationEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async request(value: unknown): Promise<AgentAppResponse> {
    if (this.closing) return error('SERVER_CLOSING', 'Agent App Server is closing');
    try {
      const request = parseAgentAppRequest(value);
      const response = await this.dispatch(request);
      return request.id === undefined ? response : { ...response, id: request.id };
    } catch (cause) {
      return error(code(cause), cause instanceof Error ? cause.message : String(cause));
    }
  }
  private async dispatch(request: AgentAppRequest): Promise<AgentAppResponse> {
    const p = request.params;
    if (request.method === 'project/create')
      return {
        method: request.method,
        ok: true,
        result: {
          project: await this.options.projectManager.create({
            name: text(p.name),
            rootPath: text(p.rootPath),
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
    if (request.method === 'project/update')
      return {
        method: request.method,
        ok: true,
        result: {
          project: await this.options.projectManager.update(text(p.projectId), {
            ...(typeof p.name === 'string' ? { name: p.name } : {}),
            ...(typeof p.rootPath === 'string' ? { rootPath: p.rootPath } : {}),
            ...(isRecord(p.policy)
              ? { policy: p.policy as import('./project-registry.js').ProjectPolicy }
              : {}),
          }),
        },
      };
    if (request.method === 'project/archive') {
      const id = text(p.projectId);
      const project = await this.options.projectManager.archive(id);
      const runtime = this.runtimes.get(id);
      if (runtime) await (await runtime).close();
      this.runtimes.delete(id);
      return { method: request.method, ok: true, result: { project } };
    }
    const project = await this.options.projectManager.read(text(p.projectId));
    if (project.status === 'archived')
      return error('PROJECT_ARCHIVED', `Project is archived: ${project.id}`);
    return await (await this.runtime(project)).request(request);
  }
  private runtime(project: ProjectSnapshot): Promise<ProjectRuntime> {
    let runtime = this.runtimes.get(project.id);
    if (!runtime) {
      runtime = this.options.createRuntime(project);
      this.runtimes.set(project.id, runtime);
      void runtime.then((r) =>
        r.observe((n) =>
          this.listeners.forEach((l) => l({ projectId: project.id, notification: n }))
        )
      );
    }
    return runtime;
  }
  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const opened = await Promise.allSettled([...this.runtimes.values()]);
      await Promise.allSettled(
        opened.flatMap((r) => (r.status === 'fulfilled' ? [r.value.close()] : []))
      );
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
function error(
  code: import('./agent-app-protocol.js').AgentAppErrorCode,
  message: string
): AgentAppResponse {
  return { method: 'unknown', ok: false, error: { code, message } };
}
function code(cause: unknown): import('./agent-app-protocol.js').AgentAppErrorCode {
  if (cause instanceof Error && cause.message.includes('Unknown project'))
    return 'PROJECT_NOT_FOUND';
  return 'INVALID_REQUEST';
}
