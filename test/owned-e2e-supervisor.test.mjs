import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { closeFixtureResources } from '../e2e/fixture-server.mjs';
import {
  cleanupOwnedManifest,
  isOwnedProcess,
  registerCurrentOwnedProcess,
  runOwnedCommand,
} from '../scripts/owned-e2e-supervisor.mjs';

describe('owned E2E supervisor', () => {
  it('terminates a verified root and its persisted discovered child tree', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 10, parentPid: 1 });
      const child = ownedEntry({
        marker,
        pid: 11,
        parentPid: 10,
        rootPid: 10,
        requiresMarker: false,
      });
      const processes = new Map([
        [root.pid, root],
        [child.pid, child],
      ]);
      await writeManifest(manifestPath, marker, [root]);
      const terminated = [];

      await cleanupOwnedManifest({
        manifestPath,
        inspect: async (pid) => processes.get(pid),
        list: async () => [...processes.values()],
        terminate: async (entry) => {
          terminated.push(entry.pid);
          processes.clear();
        },
      });

      expect(terminated).toEqual([root.pid]);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    });
  });

  it('keeps stale or PID-reused entries and refuses termination when identity verification fails', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const entry = ownedEntry({ marker });
      await writeManifest(manifestPath, marker, [entry]);
      const terminated = [];

      await expect(
        cleanupOwnedManifest({
          manifestPath,
          inspect: async () => ({ ...entry, createdAt: 'reused-process' }),
          list: async () => [],
          terminate: async (candidate) => terminated.push(candidate.pid),
        })
      ).rejects.toThrow('unverified');

      expect(terminated).toEqual([]);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"pid": 1234');
    });
  });

  it('fails safely when a root exits with an unmarked live fixture descendant', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 10, parentPid: 1 });
      const fixture = ownedEntry({
        marker,
        pid: 11,
        parentPid: 10,
        rootPid: 10,
        requiresMarker: false,
      });
      await writeManifest(manifestPath, marker, [root, fixture]);

      await expect(
        cleanupOwnedManifest({
          manifestPath,
          inspect: async (pid) => (pid === fixture.pid ? fixture : undefined),
          list: async () => [],
          terminate: async () => {
            throw new Error('must not terminate an unmarked descendant');
          },
        })
      ).rejects.toThrow('unverified child entries remain');

      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"pid": 11');
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
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        helper,
        [
          "import { spawn } from 'node:child_process';",
          "import process from 'node:process';",
          `import { registerSpawnedProcess } from '${supervisorUrl}';`,
          'const marker = process.env.ZEN_E2E_RUN_MARKER;',
          `const child = spawn(process.execPath, [\`--title=\${marker}-child\`, ${JSON.stringify(childHelper)}], { env: { ...process.env, ZEN_E2E_ROOT_PID: String(process.pid) }, stdio: 'ignore' });`,
          "await registerSpawnedProcess({ child, marker, rootPid: process.pid, role: 'failing-launcher-child' });",
          'process.exit(1);',
        ].join('\n'),
        'utf8'
      );

      const result = await runOwnedCommand({
        command: process.execPath,
        args: [`--title=${marker}-launcher`, helper],
        marker,
        manifestPath,
        stdio: 'ignore',
      });

      expect(result.exitCode).toBe(1);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    });
  }, 15_000);

  it('cleans its manifest after a normally completed marked child with no owned process left', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const result = await runOwnedCommand({
        command: process.execPath,
        args: [`--title=${marker}-normal`, '-e', 'process.exit(0)'],
        marker,
        manifestPath,
        stdio: 'ignore',
      });

      expect(result.exitCode).toBe(0);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    });
  });

  it('installs signal cleanup before spawn and terminates the direct live child safely', async () => {
    await withManifest(async ({ directory, manifestPath, marker }) => {
      const runner = path.join(directory, 'signal-runner.mjs');
      const supervisorUrl = pathToFileURL(path.resolve('scripts/owned-e2e-supervisor.mjs')).href;
      await writeFile(
        runner,
        [
          "import process from 'node:process';",
          `import { runOwnedCommand } from '${supervisorUrl}';`,
          'const [manifestPath, marker] = process.argv.slice(2);',
          "const result = await runOwnedCommand({ command: process.execPath, args: [`--title=${marker}-signal-child`, '-e', \"process.kill(process.ppid, 'SIGTERM'); setInterval(() => {}, 1000)\"], marker, manifestPath, stdio: 'ignore' });",
          'process.exitCode = result.exitCode;',
        ].join('\n'),
        'utf8'
      );
      const child = spawn(process.execPath, [runner, manifestPath, marker], { stdio: 'ignore' });
      await once(child, 'exit');

      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    });
  }, 15_000);

  it('records the fixture worker identity in the active manifest', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const entry = await registerCurrentOwnedProcess({
        role: 'fixture-worker-test',
        marker,
        rootPid: process.pid,
        manifestPath,
      });

      expect(entry?.role).toBe('fixture-worker-test');
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('fixture-worker-test');
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
  await writeFile(manifestPath, `${JSON.stringify({ version: 2, marker, entries }, null, 2)}\n`);
}

function ownedEntry({
  marker = 'zen-e2e-test-marker',
  pid = 1234,
  parentPid = 100,
  rootPid,
  requiresMarker = true,
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
    requiresMarker,
  };
}
