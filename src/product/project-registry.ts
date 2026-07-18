export type ProjectId = string;

export type ProjectStatus = 'active' | 'archived';

export type ProjectPolicy = {
  readonly maxConcurrentAgents: number;
  readonly maxThreadDepth: number;
  readonly defaultModelProfile?: string;
  readonly agentCanCreateThreads: boolean;
  readonly agentCanMessagePeers: boolean;
};

export type ProjectRecord = {
  readonly id: ProjectId;
  readonly name: string;
  readonly rootPath: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly status: ProjectStatus;
  readonly policy: ProjectPolicy;
};

export type ProjectSnapshot = ProjectRecord;

export interface ProjectRegistry {
  load(): Promise<readonly ProjectRecord[]>;
  save(projects: readonly ProjectRecord[]): Promise<void>;
}

export class ProjectRegistryCorruptionError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly cause?: unknown
  ) {
    super(`Project registry corruption at ${path}: ${message}`);
    this.name = 'ProjectRegistryCorruptionError';
  }
}

export class InMemoryProjectRegistry implements ProjectRegistry {
  private projects: ProjectRecord[];

  constructor(initialProjects: readonly ProjectRecord[] = []) {
    this.projects = initialProjects.map(cloneProjectRecord);
  }

  async load(): Promise<readonly ProjectRecord[]> {
    return this.projects.map(cloneProjectRecord);
  }

  async save(projects: readonly ProjectRecord[]): Promise<void> {
    this.projects = projects.map(cloneProjectRecord);
  }
}

export function cloneProjectRecord(project: ProjectRecord): ProjectRecord {
  return {
    ...project,
    policy: { ...project.policy },
  };
}
