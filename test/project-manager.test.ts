import { mkdtempSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileProjectRegistry,
  InMemoryProjectRegistry,
  ProjectManager,
  ProjectRegistryCorruptionError,
  canonicalizeWindowsProjectRootPath,
  type ProjectPolicy,
  type ProjectRecord,
  type ProjectRegistry,
} from './test-exports.js';

const tempPrefix = 'zen-agent-app-project-';
const tempRoots = new Set<string>();

afterEach(async () => {
  const roots = [...tempRoots];
  tempRoots.clear();
  const results = await Promise.allSettled(
    roots.map(async (root) => await rm(root, { recursive: true, force: true }))
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) throw new AggregateError(failures, 'Project test temp cleanup failed');
});

describe('ProjectManager', () => {
  it('creates, lists, reads, updates, and archives immutable project snapshots', async () => {
    const manager = await managerWithMemory();
    const created = await manager.create({ name: 'Zen App', rootPath: 'C:\\work\\zen' });

    expect(created).toMatchObject({
      id: 'project-1',
      name: 'Zen App',
      rootPath: 'C:\\work\\zen',
      createdAtMs: 1000,
      updatedAtMs: 1000,
      status: 'active',
      policy: defaultPolicy(),
    });

    (created as { name: string; policy: { maxConcurrentAgents: number } }).name = 'mutated';
    (created as { policy: { maxConcurrentAgents: number } }).policy.maxConcurrentAgents = 99;
    expect(await manager.read('project-1')).toMatchObject({
      name: 'Zen App',
      policy: { maxConcurrentAgents: 2 },
    });

    const updated = await manager.update('project-1', {
      name: 'Zen App Control Plane',
      policy: { ...defaultPolicy(), maxConcurrentAgents: 3, defaultModelProfile: 'balanced' },
    });
    const archived = await manager.archive('project-1');

    expect(updated.updatedAtMs).toBe(1001);
    expect(archived).toMatchObject({ status: 'archived', updatedAtMs: 1002 });
    expect(await manager.list()).toEqual([archived]);
  });

  it('rejects invalid names, roots, and policies before persistence', async () => {
    const registry = new RecordingRegistry();
    const manager = await ProjectManager.open({ registry, generateId: sequence('project'), clock });

    await expect(manager.create({ name: '  ', rootPath: 'C:\\work' })).rejects.toThrow('name');
    await expect(manager.create({ name: 'Zen', rootPath: '  ' })).rejects.toThrow('root path');
    await expect(
      manager.create({
        name: 'Zen',
        rootPath: 'C:\\work',
        policy: { ...defaultPolicy(), maxThreadDepth: 0 },
      })
    ).rejects.toThrow('maxThreadDepth');
    await expect(
      manager.create({
        name: 'Zen',
        rootPath: 'C:\\work',
        policy: { ...defaultPolicy(), defaultModelProfile: '  ' },
      })
    ).rejects.toThrow('defaultModelProfile');
    expect(registry.saved).toEqual([]);
  });

  it('rejects canonical root collisions through the injected host normalizer', async () => {
    const manager = await managerWithMemory({
      rootPathNormalizer: (path: string) => path.replaceAll('/', '\\').toLowerCase(),
    });
    await manager.create({ name: 'First', rootPath: 'C:/Work/Zen' });

    await expect(manager.create({ name: 'Second', rootPath: 'c:\\work\\zen' })).rejects.toThrow(
      'root path is already assigned'
    );
  });

  it('serializes concurrent mutations in invocation order', async () => {
    const registry = new RecordingRegistry();
    const manager = await ProjectManager.open({ registry, generateId: sequence('project'), clock });
    const created = await manager.create({ name: 'Initial', rootPath: 'C:\\work\\zen' });

    await Promise.all([
      manager.update(created.id, { name: 'First' }),
      manager.update(created.id, { name: 'Second' }),
    ]);

    expect((await manager.read(created.id)).name).toBe('Second');
    expect(registry.saved.map((projects) => projects[0]?.name)).toEqual([
      'Initial',
      'First',
      'Second',
    ]);
  });

  it('does not publish a mutation when persistence fails', async () => {
    const registry = new FailingRegistry();
    const manager = await ProjectManager.open({ registry, generateId: sequence('project'), clock });

    await expect(manager.create({ name: 'Zen', rootPath: 'C:\\work\\zen' })).rejects.toThrow(
      'injected write failure'
    );
    expect(await manager.list()).toEqual([]);
  });
});

describe('FileProjectRegistry', () => {
  it('atomically persists a versioned snapshot and restores it after restart', async () => {
    const root = createTempRoot();
    const filePath = join(root, 'app-data', 'projects.json');
    const first = await ProjectManager.open({
      registry: new FileProjectRegistry({ filePath }),
      generateId: sequence('project'),
      clock,
    });
    const created = await first.create({ name: 'Zen', rootPath: 'C:\\work\\zen' });
    await first.update(created.id, { name: 'Zen Updated' });

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      version: 1,
      projects: [{ id: 'project-1', name: 'Zen Updated' }],
    });
    expect((await readdir(dirname(filePath))).filter((entry) => entry.includes('.tmp-'))).toEqual(
      []
    );

    const restored = await ProjectManager.open({ registry: new FileProjectRegistry({ filePath }) });
    expect(await restored.list()).toEqual([
      expect.objectContaining({ id: 'project-1', name: 'Zen Updated' }),
    ]);
  });

  it('fails closed when the persisted JSON is corrupt or fails schema validation', async () => {
    const root = createTempRoot();
    const filePath = join(root, 'projects.json');
    await writeFile(filePath, '{not-json', 'utf8');
    await expect(new FileProjectRegistry({ filePath }).load()).rejects.toBeInstanceOf(
      ProjectRegistryCorruptionError
    );

    await writeFile(filePath, JSON.stringify({ version: 1, projects: [{}] }), 'utf8');
    await expect(new FileProjectRegistry({ filePath }).load()).rejects.toThrow(
      'invalid project record'
    );
  });

  it('serializes concurrent saves and preserves invocation order', async () => {
    const root = createTempRoot();
    const registry = new FileProjectRegistry({ filePath: join(root, 'projects.json') });

    await Promise.all([
      registry.save([projectRecord('First')]),
      registry.save([projectRecord('Second')]),
    ]);

    await expect(registry.load()).resolves.toEqual([projectRecord('Second')]);
  });

  it('provides a Windows case and separator canonicalizer for ProjectManager injection', () => {
    expect(canonicalizeWindowsProjectRootPath('C:/Work/Zen')).toBe('c:/work/zen');
    expect(canonicalizeWindowsProjectRootPath('c:\\WORK\\zen\\')).toBe('c:/work/zen');
  });
});

function defaultPolicy(): ProjectPolicy {
  return {
    maxConcurrentAgents: 2,
    maxThreadDepth: 4,
    agentCanCreateThreads: true,
    agentCanMessagePeers: true,
  };
}

async function managerWithMemory(
  options: Omit<Parameters<typeof ProjectManager.open>[0], 'registry' | 'generateId' | 'clock'> = {}
): Promise<ProjectManager> {
  return await ProjectManager.open({
    ...options,
    registry: new InMemoryProjectRegistry(),
    generateId: sequence('project'),
    clock,
  });
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

let tick = 1000;
function clock(): number {
  return tick++;
}

function createTempRoot(): string {
  const parent = resolve(tmpdir());
  const root = resolve(mkdtempSync(join(parent, tempPrefix)));
  if (dirname(root) !== parent || !basename(root).startsWith(tempPrefix)) {
    throw new Error(`Unsafe project test temp root: ${root}`);
  }
  tempRoots.add(root);
  return root;
}

class RecordingRegistry implements ProjectRegistry {
  readonly saved: ProjectRecord[][] = [];

  async load(): Promise<readonly ProjectRecord[]> {
    return [];
  }

  async save(projects: readonly ProjectRecord[]): Promise<void> {
    this.saved.push(projects.map(clone));
  }
}

class FailingRegistry implements ProjectRegistry {
  async load(): Promise<readonly ProjectRecord[]> {
    return [];
  }

  async save(_projects: readonly ProjectRecord[]): Promise<void> {
    throw new Error('injected write failure');
  }
}

function clone(project: ProjectRecord): ProjectRecord {
  return { ...project, policy: { ...project.policy } };
}

function projectRecord(name: string): ProjectRecord {
  return {
    id: 'project-1',
    name,
    rootPath: 'C:\\work\\zen',
    createdAtMs: 1000,
    updatedAtMs: 1000,
    status: 'active',
    policy: defaultPolicy(),
  };
}
