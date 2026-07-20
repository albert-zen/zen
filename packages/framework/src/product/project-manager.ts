import type { Clock, IdGenerator } from '../kernel/index.js';
import {
  cloneProjectRecord,
  InMemoryProjectRegistry,
  type ProjectId,
  type ProjectPolicy,
  type ProjectRecord,
  type ProjectRegistry,
  type ProjectSnapshot,
} from './project-registry.js';

export type ProjectCreateInput = {
  readonly name: string;
  readonly rootPath: string;
  readonly policy?: ProjectPolicy;
};

export type ProjectUpdateInput = {
  readonly name?: string;
  readonly policy?: ProjectPolicy;
};

export type ProjectManagerOptions = {
  readonly registry?: ProjectRegistry;
  readonly generateId?: IdGenerator;
  readonly clock?: Clock;
  readonly rootPathNormalizer?: (rootPath: string) => string | Promise<string>;
};

const DEFAULT_PROJECT_POLICY: ProjectPolicy = {
  maxActiveExecutions: 2,
  maxThreadDepth: 4,
  maxThreads: 100,
  maxQueuedMessages: 100,
  maxWaitTargets: 16,
  maxMessageBytes: 16_384,
  idempotencyRetention: 1_000,
  agentCanCreateThreads: true,
  agentCanMessagePeers: true,
};

export class ProjectManager {
  private readonly projects = new Map<ProjectId, ProjectRecord>();
  private readonly registry: ProjectRegistry;
  private readonly generateId: IdGenerator;
  private readonly clock: Clock;
  private readonly rootPathNormalizer: (rootPath: string) => string | Promise<string>;
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(options: Required<ProjectManagerOptions>) {
    this.registry = options.registry;
    this.generateId = options.generateId;
    this.clock = options.clock;
    this.rootPathNormalizer = options.rootPathNormalizer;
  }

  static async open(options: ProjectManagerOptions = {}): Promise<ProjectManager> {
    const manager = new ProjectManager({
      registry: options.registry ?? new InMemoryProjectRegistry(),
      generateId: options.generateId ?? createSequenceIdGenerator('project'),
      clock: options.clock ?? Date.now,
      rootPathNormalizer: options.rootPathNormalizer ?? identityRootPath,
    });
    const loaded = await manager.registry.load();

    for (const project of loaded) {
      const normalizedRoot = await manager.normalizeRootPath(project.rootPath);
      const normalized: ProjectRecord = {
        ...project,
        rootPath: normalizedRoot,
        policy: validatePolicy(project.policy),
      };
      assertStoredProject(normalized);
      if (manager.projects.has(normalized.id)) {
        throw new Error(`Duplicate project id in registry: ${normalized.id}`);
      }
      manager.assertRootAvailable(normalized.rootPath, normalized.id);
      manager.projects.set(normalized.id, cloneProjectRecord(normalized));
    }

    return manager;
  }

  async create(input: ProjectCreateInput): Promise<ProjectSnapshot> {
    return await this.enqueue(async () => {
      const name = validateName(input.name);
      const rootPath = await this.normalizeRootPath(input.rootPath);
      this.assertRootAvailable(rootPath);
      const id = this.generateUniqueId();
      const now = this.clock();
      const project: ProjectRecord = {
        id,
        name,
        rootPath,
        createdAtMs: now,
        updatedAtMs: now,
        status: 'active',
        policy: validatePolicy(input.policy ?? DEFAULT_PROJECT_POLICY),
      };

      await this.persist([...this.projects.values(), project]);
      this.projects.set(project.id, project);
      return cloneProjectRecord(project);
    });
  }

  async list(): Promise<readonly ProjectSnapshot[]> {
    return [...this.projects.values()].map(cloneProjectRecord);
  }

  async read(id: ProjectId): Promise<ProjectSnapshot> {
    return cloneProjectRecord(this.projectFor(id));
  }

  async update(id: ProjectId, input: ProjectUpdateInput): Promise<ProjectSnapshot> {
    return await this.enqueue(async () => {
      const current = this.projectFor(id);
      const name = input.name === undefined ? current.name : validateName(input.name);
      const updated: ProjectRecord = {
        ...current,
        name,
        policy: input.policy === undefined ? { ...current.policy } : validatePolicy(input.policy),
        updatedAtMs: this.clock(),
      };

      await this.persist(this.replaceProject(updated));
      this.projects.set(id, updated);
      return cloneProjectRecord(updated);
    });
  }

  async archive(id: ProjectId): Promise<ProjectSnapshot> {
    return await this.enqueue(async () => {
      const current = this.projectFor(id);
      if (current.status === 'archived') return cloneProjectRecord(current);
      const archived: ProjectRecord = {
        ...current,
        policy: { ...current.policy },
        status: 'archived',
        updatedAtMs: this.clock(),
      };

      await this.persist(this.replaceProject(archived));
      this.projects.set(id, archived);
      return cloneProjectRecord(archived);
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    );
    return await result;
  }

  private async persist(projects: readonly ProjectRecord[]): Promise<void> {
    await this.registry.save(projects.map(cloneProjectRecord));
  }

  private replaceProject(project: ProjectRecord): ProjectRecord[] {
    return [...this.projects.values()].map((current) =>
      current.id === project.id ? project : current
    );
  }

  private projectFor(id: ProjectId): ProjectRecord {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Unknown project: ${id}`);
    return project;
  }

  private assertRootAvailable(rootPath: string, excludeId?: ProjectId): void {
    for (const project of this.projects.values()) {
      if (project.id !== excludeId && project.rootPath === rootPath) {
        throw new Error(`Project root path is already assigned: ${rootPath}`);
      }
    }
  }

  private async normalizeRootPath(rootPath: string): Promise<string> {
    const canonical = await this.rootPathNormalizer(validateRootPath(rootPath));
    if (typeof canonical !== 'string' || canonical.trim().length === 0) {
      throw new Error('Project root path normalizer returned an invalid path');
    }
    return validateRootPath(canonical);
  }

  private generateUniqueId(): ProjectId {
    for (;;) {
      const id = this.generateId();
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new Error('Project id generator returned an invalid id');
      }
      if (!this.projects.has(id)) return id;
    }
  }
}

function validateName(value: string): string {
  if (typeof value !== 'string') throw new Error('Project name must be a string');
  const name = value.trim();
  if (name.length === 0 || name.length > 200)
    throw new Error('Project name must be 1-200 characters');
  return name;
}

function validateRootPath(value: string): string {
  if (typeof value !== 'string') throw new Error('Project root path must be a string');
  const rootPath = value.trim();
  if (rootPath.length === 0) throw new Error('Project root path must not be empty');
  return rootPath;
}

function validatePolicy(value: ProjectPolicy): ProjectPolicy {
  if (!isPositiveInteger(value.maxActiveExecutions)) {
    throw new Error('Project policy maxActiveExecutions must be a positive integer');
  }
  if (!isPositiveInteger(value.maxThreadDepth)) {
    throw new Error('Project policy maxThreadDepth must be a positive integer');
  }
  for (const key of [
    'maxThreads',
    'maxQueuedMessages',
    'maxWaitTargets',
    'maxMessageBytes',
    'idempotencyRetention',
  ] as const) {
    if (value[key] !== undefined && !isPositiveInteger(value[key])) {
      throw new Error(`Project policy ${key} must be a positive integer`);
    }
  }
  if (
    typeof value.agentCanCreateThreads !== 'boolean' ||
    typeof value.agentCanMessagePeers !== 'boolean'
  ) {
    throw new Error('Project policy agent permissions must be boolean');
  }
  if (
    value.defaultModelProfile !== undefined &&
    (typeof value.defaultModelProfile !== 'string' || value.defaultModelProfile.trim().length === 0)
  ) {
    throw new Error('Project policy defaultModelProfile must be a non-empty string when set');
  }
  return {
    maxActiveExecutions: value.maxActiveExecutions,
    maxThreadDepth: value.maxThreadDepth,
    maxThreads: value.maxThreads ?? DEFAULT_PROJECT_POLICY.maxThreads,
    maxQueuedMessages: value.maxQueuedMessages ?? DEFAULT_PROJECT_POLICY.maxQueuedMessages,
    maxWaitTargets: value.maxWaitTargets ?? DEFAULT_PROJECT_POLICY.maxWaitTargets,
    maxMessageBytes: value.maxMessageBytes ?? DEFAULT_PROJECT_POLICY.maxMessageBytes,
    idempotencyRetention: value.idempotencyRetention ?? DEFAULT_PROJECT_POLICY.idempotencyRetention,
    ...(value.defaultModelProfile === undefined
      ? {}
      : { defaultModelProfile: value.defaultModelProfile.trim() }),
    agentCanCreateThreads: value.agentCanCreateThreads,
    agentCanMessagePeers: value.agentCanMessagePeers,
  };
}

function assertStoredProject(project: ProjectRecord): void {
  if (typeof project.id !== 'string' || project.id.trim().length === 0) {
    throw new Error('Invalid project id in registry');
  }
  validateName(project.name);
  validateRootPath(project.rootPath);
  if (!Number.isFinite(project.createdAtMs) || !Number.isFinite(project.updatedAtMs)) {
    throw new Error('Invalid project timestamp in registry');
  }
  if (project.status !== 'active' && project.status !== 'archived') {
    throw new Error('Invalid project status in registry');
  }
  validatePolicy(project.policy);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function identityRootPath(rootPath: string): string {
  return rootPath;
}

function createSequenceIdGenerator(prefix: string): IdGenerator {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
