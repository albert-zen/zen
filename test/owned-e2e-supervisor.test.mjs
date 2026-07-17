import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { closeFixtureResources } from '../e2e/fixture-server.mjs';
import {
  assertNoOwnedProcesses,
  cleanupOwnedManifest,
  installCleanupHandlers,
  isOwnedProcess,
  registerSpawnedProcess,
  runOwnedCommand,
} from '../scripts/owned-e2e-supervisor.mjs';

describe('owned E2E supervisor', () => {
  it('kills exact verified identities leaf-first without recursive tree termination', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 10, parentPid: 1, parentChain: [] });
      const leaf = ownedEntry({
        marker,
        pid: 11,
        parentPid: 10,
        rootPid: 10,
        parentChain: [{ pid: 10, createdAt: root.createdAt }],
      });
      const processes = new Map([
        [root.pid, root],
        [leaf.pid, leaf],
      ]);
      const terminated = [];
      await writeManifest(manifestPath, marker, [root, leaf]);

      await cleanupOwnedManifest({
        manifestPath,
        inspect: async (pid) => processes.get(pid),
        list: async () => [...processes.values()],
        terminate: async (entry) => {
          terminated.push(entry);
          processes.delete(entry.pid);
        },
      });

      expect(terminated.map((entry) => entry.pid)).toEqual([leaf.pid, root.pid]);
      expect(terminated.every((entry) => entry.commandLine.includes(marker))).toBe(true);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    });
  });

  it('retains an unmarked spawned child without calling its kill provider', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const identity = {
        ...ownedEntry({ marker, pid: 55, parentPid: 1, parentChain: [] }),
        commandLine: 'node unmarked-child',
      };
      const child = { pid: identity.pid, kill: vi.fn() };
      const processes = new Map([[identity.pid, identity]]);

      await expect(
        registerSpawnedProcess({
          child,
          marker,
          rootPid: process.pid,
          role: 'unowned-test',
          manifestPath,
          inspect: async () => identity,
          list: async () => [...processes.values()],
        })
      ).rejects.toThrow('lacks owner marker');

      expect(child.kill).not.toHaveBeenCalled();
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"pid": 55');

      const terminated = [];
      await expect(
        cleanupOwnedManifest({
          manifestPath,
          inspect: async (pid) => processes.get(pid),
          list: async () => [...processes.values()],
          terminate: async (entry) => terminated.push(entry.pid),
        })
      ).rejects.toThrow('exact owner identity');
      expect(terminated).toEqual([]);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('unverified-unowned-test');
    });
  });

  it('cleans a marked descendant after its recorded root has exited', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 10, parentPid: 1, parentChain: [] });
      const child = ownedEntry({
        marker,
        pid: 11,
        parentPid: 10,
        rootPid: 10,
        parentChain: [{ pid: root.pid, createdAt: root.createdAt }],
      });
      const processes = new Map([[child.pid, child]]);
      const terminated = [];
      await writeManifest(manifestPath, marker, [root, child]);

      await cleanupOwnedManifest({
        manifestPath,
        inspect: async (pid) => processes.get(pid),
        list: async () => [...processes.values()],
        terminate: async (entry) => {
          terminated.push(entry.pid);
          processes.delete(entry.pid);
        },
      });

      expect(terminated).toEqual([child.pid]);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    });
  });

  it('retains a PID-reused record and does not kill it', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const entry = ownedEntry({ marker });
      const reused = { ...entry, createdAt: 'reused-process' };
      const terminated = [];
      await writeManifest(manifestPath, marker, [entry]);

      await expect(
        cleanupOwnedManifest({
          manifestPath,
          inspect: async () => reused,
          list: async () => [reused],
          terminate: async (candidate) => terminated.push(candidate.pid),
        })
      ).rejects.toThrow('exact owner identity');

      expect(terminated).toEqual([]);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"pid": 1234');
    });
  });

  it('discovers an unmarked live descendant, retains it, and does not kill it', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 10, parentPid: 1, parentChain: [] });
      const unmarked = {
        ...ownedEntry({
          marker,
          pid: 11,
          parentPid: root.pid,
          rootPid: root.pid,
          parentChain: [{ pid: root.pid, createdAt: root.createdAt }],
        }),
        commandLine: 'node unrelated-worker',
      };
      const processes = new Map([
        [root.pid, root],
        [unmarked.pid, unmarked],
      ]);
      await writeManifest(manifestPath, marker, [root]);

      await expect(
        cleanupOwnedManifest({
          manifestPath,
          inspect: async (pid) => processes.get(pid),
          list: async () => [...processes.values()],
          terminate: async () => {
            throw new Error('unmarked process must not be terminated');
          },
        })
      ).rejects.toThrow('exact owner identity');

      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"pid": 11');
    });
  });

  it('finds a marked orphan missing from the manifest with its independent process scan', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      await writeManifest(manifestPath, marker, []);
      const orphan = ownedEntry({ marker, pid: 44, parentPid: 1, parentChain: [] });

      await expect(
        assertNoOwnedProcesses({
          manifestPath,
          inspect: async () => undefined,
          list: async () => [orphan],
        })
      ).rejects.toThrow('independent marker scan found 1 owned process');
    });
  });

  it('keeps its manifest until both records and the independent marker scan are clear', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const entry = ownedEntry({ marker });
      const orphan = ownedEntry({ marker, pid: 44, parentPid: 1, parentChain: [] });
      const processes = new Map([[entry.pid, entry]]);
      let orphanLive = true;
      await writeManifest(manifestPath, marker, [entry]);
      const operations = {
        manifestPath,
        inspect: async (pid) => processes.get(pid),
        list: async () => [...processes.values(), ...(orphanLive ? [orphan] : [])],
        terminate: async (candidate) => processes.delete(candidate.pid),
      };

      await expect(cleanupOwnedManifest(operations)).rejects.toThrow('independent marker scan');
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"pid": 1234');

      orphanLive = false;
      await cleanupOwnedManifest(operations);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    });
  });

  it('cleans a real marked child and grandchild after a failing launcher exits', async () => {
    await withManifest(async ({ directory, manifestPath, marker }) => {
      const helper = path.join(directory, 'failing-launcher.mjs');
      const childHelper = path.join(directory, 'registered-child.mjs');
      const supervisorUrl = pathToFileURL(path.resolve('scripts/owned-e2e-supervisor.mjs')).href;
      await writeFile(
        childHelper,
        [
          "import { spawn } from 'node:child_process';",
          "import process from 'node:process';",
          `import { registerSpawnedProcess } from '${supervisorUrl}';`,
          'const marker = process.env.ZEN_E2E_RUN_MARKER;',
          'const rootPid = Number(process.env.ZEN_E2E_ROOT_PID);',
          "const grandchild = spawn(process.execPath, [`--title=${marker}-grandchild`, '-e', 'setInterval(() => {}, 1000)'], { env: process.env, stdio: 'ignore' });",
          "await registerSpawnedProcess({ child: grandchild, marker, rootPid, role: 'failing-launcher-grandchild' });",
          "process.send?.('ready');",
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        helper,
        [
          "import { spawn } from 'node:child_process';",
          "import { once } from 'node:events';",
          "import process from 'node:process';",
          `import { registerSpawnedProcess } from '${supervisorUrl}';`,
          'const [childHelper] = process.argv.slice(2);',
          'const marker = process.env.ZEN_E2E_RUN_MARKER;',
          "const child = spawn(process.execPath, [`--title=${marker}-child`, childHelper], { env: { ...process.env, ZEN_E2E_ROOT_PID: String(process.pid) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
          "await registerSpawnedProcess({ child, marker, rootPid: process.pid, role: 'failing-launcher-child' });",
          "await once(child, 'message');",
          'process.exit(1);',
        ].join('\n'),
        'utf8'
      );

      const result = await runOwnedCommand({
        command: process.execPath,
        args: [`--title=${marker}-launcher`, helper, childHelper],
        marker,
        manifestPath,
        stdio: 'ignore',
      });

      expect(result.exitCode).toBe(1);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
      await expect(assertNoOwnedProcesses({ manifestPath })).resolves.toBeUndefined();
    });
  }, 15_000);

  it('cleans its manifest after a normal marked command', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const identity = ownedEntry({ marker, pid: 65, parentPid: 1, parentChain: [] });
      const processes = new Map([[identity.pid, identity]]);
      const child = new EventEmitter();
      child.pid = identity.pid;
      child.exitCode = null;
      child.killed = false;
      const result = await runOwnedCommand({
        command: process.execPath,
        args: [`--title=${marker}-normal`, marker],
        marker,
        manifestPath,
        stdio: 'ignore',
        spawnCommand: () => {
          setImmediate(() => {
            child.exitCode = 0;
            child.emit('exit', 0, null);
          });
          return child;
        },
        inspect: async () => processes.get(identity.pid),
        list: async () => [...processes.values()],
        terminate: async (entry) => processes.delete(entry.pid),
      });

      expect(result.exitCode).toBe(0);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    });
  });

  it('runs the installed SIGTERM cleanup handler before any spawned work', async () => {
    const signals = new EventEmitter();
    const exitCodes = [];
    let resolveCleanup;
    const cleaned = new Promise((resolve) => {
      resolveCleanup = resolve;
    });
    const handlers = installCleanupHandlers(
      async () => resolveCleanup(),
      signals,
      (code) => {
        exitCodes.push(code);
      }
    );
    try {
      signals.emit('SIGTERM');
      await cleaned;
      await new Promise(setImmediate);
      expect(exitCodes).toEqual([143]);
    } finally {
      handlers.dispose();
    }
  });

  it('cleans a marker-owned child when a signal arrives before registration completes', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const signals = new EventEmitter();
      const identity = ownedEntry({ marker, pid: 66, parentPid: 1, parentChain: [] });
      const processes = new Map([[identity.pid, identity]]);
      const child = new EventEmitter();
      child.pid = identity.pid;
      child.exitCode = null;
      child.killed = false;
      const terminated = [];
      const exitCodes = [];
      child.kill = vi.fn();

      const result = await runOwnedCommand({
        command: process.execPath,
        args: [`--title=${marker}-pre-registration`],
        marker,
        manifestPath,
        signals,
        setExitCode: (code) => exitCodes.push(code),
        spawnCommand: () => {
          queueMicrotask(() => signals.emit('SIGTERM'));
          return child;
        },
        inspect: async () => {
          await new Promise(setImmediate);
          return processes.get(identity.pid);
        },
        list: async () => [...processes.values()],
        terminate: async (entry) => {
          terminated.push(entry.pid);
          processes.delete(entry.pid);
          child.exitCode = 143;
          child.emit('exit', 143, 'SIGTERM');
        },
      });

      expect(result.exitCode).toBe(143);
      expect(terminated).toEqual([identity.pid]);
      expect(child.kill).not.toHaveBeenCalled();
      await new Promise(setImmediate);
      expect(exitCodes).toEqual([143]);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    });
  });

  it('requires exact creation, command, parent, executable, and marker identity', () => {
    const entry = ownedEntry({ marker: 'zen-e2e-test-marker' });
    expect(isOwnedProcess(entry, entry)).toBe(true);
    expect(isOwnedProcess(entry, { ...entry, commandLine: 'node unrelated' })).toBe(false);
    expect(isOwnedProcess(entry, { ...entry, createdAt: 'reused' })).toBe(false);
    expect(isOwnedProcess(entry, { ...entry, parentPid: 999 })).toBe(false);
  });

  it('closes every fixture resource after a shutdown failure', async () => {
    const closed = [];
    await expect(
      closeFixtureResources({
        vite: {
          async close() {
            closed.push('vite');
            throw new Error('Vite close failed');
          },
        },
        transport: {
          async close() {
            closed.push('transport');
          },
        },
        appServer: {
          async close() {
            closed.push('app-server');
          },
        },
      })
    ).rejects.toThrow('Failed to close deterministic E2E fixture resources');
    expect(closed).toEqual(['vite', 'transport', 'app-server']);
  });
});

async function withManifest(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
  const manifestPath = path.join(directory, 'owned-processes.json');
  const marker = `zen-e2e-test-${path.basename(directory)}`;
  try {
    await run({ directory, manifestPath, marker });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function writeManifest(manifestPath, marker, entries) {
  await writeFile(manifestPath, `${JSON.stringify({ version: 3, marker, entries }, null, 2)}\n`);
}

function ownedEntry({
  marker = 'zen-e2e-test-marker',
  pid = 1234,
  parentPid = 100,
  rootPid,
  parentChain = [],
}) {
  return {
    pid,
    parentPid,
    rootPid: rootPid ?? pid,
    marker,
    createdAt: '20260717120000.000000+000',
    executable: 'C:\\node.exe',
    commandLine: `node --title=${marker} worker`,
    role: 'test',
    parentChain,
  };
}
