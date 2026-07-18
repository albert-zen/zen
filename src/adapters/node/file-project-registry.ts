import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import {
  cloneProjectRecord,
  ProjectRegistryCorruptionError,
  type ProjectPolicy,
  type ProjectRecord,
  type ProjectRegistry,
} from '../../product/index.js';

const REGISTRY_VERSION = 1;

type RegistryFile = {
  readonly version: number;
  readonly projects: readonly ProjectRecord[];
};

export type ProjectRegistryFileSystem = {
  mkdir(path: string, options: { readonly recursive: true }): Promise<string | undefined>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(
    path: string,
    contents: string,
    options: { readonly encoding: BufferEncoding; readonly flag: 'wx' }
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
};

export type FileProjectRegistryOptions = {
  readonly filePath?: string;
  readonly fileSystem?: ProjectRegistryFileSystem;
};

export class FileProjectRegistry implements ProjectRegistry {
  private readonly filePath: string;
  private readonly fileSystem: ProjectRegistryFileSystem;
  private writeTail: Promise<void> = Promise.resolve();
  private tempSequence = 0;

  constructor(options: FileProjectRegistryOptions = {}) {
    this.filePath = options.filePath ?? join(homedir(), '.zen', 'agent-app', 'projects.json');
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
  }

  async load(): Promise<readonly ProjectRecord[]> {
    let text: string;
    try {
      text = await this.fileSystem.readFile(this.filePath, 'utf8');
    } catch (cause) {
      if (isMissing(cause)) return [];
      throw cause;
    }

    try {
      return decodeRegistry(text, this.filePath).projects.map(cloneProjectRecord);
    } catch (cause) {
      if (cause instanceof ProjectRegistryCorruptionError) throw cause;
      throw new ProjectRegistryCorruptionError(this.filePath, readMessage(cause), cause);
    }
  }

  async save(projects: readonly ProjectRecord[]): Promise<void> {
    const snapshot = projects.map(cloneProjectRecord);
    const operation = this.writeTail.then(async () => {
      await this.writeAtomically(snapshot);
    });
    this.writeTail = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
  }

  private async writeAtomically(projects: readonly ProjectRecord[]): Promise<void> {
    const tempPath = `${this.filePath}.tmp-${process.pid}-${++this.tempSequence}`;
    const contents = JSON.stringify({ version: REGISTRY_VERSION, projects });
    await this.fileSystem.mkdir(dirname(this.filePath), { recursive: true });
    try {
      await this.fileSystem.writeFile(tempPath, contents, { encoding: 'utf8', flag: 'wx' });
      await this.fileSystem.rename(tempPath, this.filePath);
    } catch (cause) {
      await this.fileSystem.unlink(tempPath).catch(() => undefined);
      throw cause;
    }
  }
}

export function canonicalizeWindowsProjectRootPath(rootPath: string): string {
  return win32.resolve(rootPath).replaceAll('\\', '/').toLowerCase();
}

const nodeFileSystem: ProjectRegistryFileSystem = { mkdir, readFile, writeFile, rename, unlink };

function decodeRegistry(text: string, path: string): RegistryFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProjectRegistryCorruptionError(path, 'invalid JSON');
  }
  if (!isRecord(value) || value.version !== REGISTRY_VERSION || !Array.isArray(value.projects)) {
    throw new ProjectRegistryCorruptionError(path, 'invalid versioned registry envelope');
  }
  const projects = value.projects.map((project) => decodeProjectRecord(project, path));
  const ids = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id)) throw new ProjectRegistryCorruptionError(path, 'duplicate project id');
    ids.add(project.id);
  }
  return { version: REGISTRY_VERSION, projects };
}

function decodeProjectRecord(value: unknown, path: string): ProjectRecord {
  if (!isRecord(value) || !isProjectPolicy(value.policy)) {
    throw new ProjectRegistryCorruptionError(path, 'invalid project record');
  }
  const createdAtMs = value.createdAtMs;
  const updatedAtMs = value.updatedAtMs;
  if (
    typeof value.id !== 'string' ||
    value.id.trim().length === 0 ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    typeof value.rootPath !== 'string' ||
    value.rootPath.trim().length === 0 ||
    !isFiniteNumber(createdAtMs) ||
    !isFiniteNumber(updatedAtMs) ||
    (value.status !== 'active' && value.status !== 'archived')
  ) {
    throw new ProjectRegistryCorruptionError(path, 'invalid project record');
  }
  return {
    id: value.id,
    name: value.name,
    rootPath: value.rootPath,
    createdAtMs,
    updatedAtMs,
    status: value.status,
    policy: { ...value.policy },
  };
}

function isProjectPolicy(value: unknown): value is ProjectPolicy {
  return (
    isRecord(value) &&
    isPositiveInteger(value.maxConcurrentAgents) &&
    isPositiveInteger(value.maxThreadDepth) &&
    optionalPositiveInteger(value.maxThreads) &&
    optionalPositiveInteger(value.maxQueuedMessages) &&
    optionalPositiveInteger(value.maxWaitTargets) &&
    optionalPositiveInteger(value.maxMessageBytes) &&
    optionalPositiveInteger(value.idempotencyRetention) &&
    typeof value.agentCanCreateThreads === 'boolean' &&
    typeof value.agentCanMessagePeers === 'boolean' &&
    (value.defaultModelProfile === undefined ||
      (typeof value.defaultModelProfile === 'string' &&
        value.defaultModelProfile.trim().length > 0))
  );
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(cause: unknown): boolean {
  return isRecord(cause) && cause.code === 'ENOENT';
}

function readMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
