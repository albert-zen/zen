import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { closeFixtureResources } from '../e2e/fixture-server.mjs';
import {
  cleanupOwnedEntries,
  isOwnedProcess,
  runOwnedCommand,
} from '../scripts/owned-e2e-supervisor.mjs';

describe('owned E2E supervisor', () => {
  it('terminates a verified owned process and reports no remaining child', async () => {
    const entry = ownedEntry();
    let live = true;
    const terminated = [];

    const results = await cleanupOwnedEntries([entry], {
      inspect: async () =>
        live
          ? {
              pid: entry.pid,
              createdAt: entry.createdAt,
              commandLine: `node child ${entry.marker}`,
            }
          : undefined,
      terminate: async (candidate) => {
        terminated.push(candidate.pid);
        live = false;
      },
    });

    expect(terminated).toEqual([entry.pid]);
    expect(results).toMatchObject([{ status: 'terminated' }]);
  });

  it('does not terminate a reused PID whose marker or creation identity differs', async () => {
    const entry = ownedEntry();
    const terminate = async () => {
      throw new Error('must not terminate a process that is no longer owned');
    };

    const markerMismatch = await cleanupOwnedEntries([entry], {
      inspect: async () => ({
        pid: entry.pid,
        createdAt: entry.createdAt,
        commandLine: 'node unrelated-process',
      }),
      terminate,
    });
    const creationMismatch = await cleanupOwnedEntries([entry], {
      inspect: async () => ({
        pid: entry.pid,
        createdAt: 'different-creation-time',
        commandLine: `node child ${entry.marker}`,
      }),
      terminate,
    });

    expect(markerMismatch).toMatchObject([{ status: 'not-owned' }]);
    expect(creationMismatch).toMatchObject([{ status: 'not-owned' }]);
    expect(
      isOwnedProcess(entry, {
        pid: entry.pid,
        createdAt: entry.createdAt,
        commandLine: `node child ${entry.marker}`,
      })
    ).toBe(true);
  });

  it('cleans its manifest after a normally completed child without leaving an owned process', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
    const manifestPath = path.join(directory, 'owned-processes.json');
    const marker = 'zen-e2e-test-normal-exit';

    try {
      const result = await runOwnedCommand({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(0), 100)', '--', marker],
        marker,
        manifestPath,
        stdio: 'ignore',
      });

      expect(result.exitCode).toBe(0);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('cleans its manifest after the owned Playwright launcher fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
    const manifestPath = path.join(directory, 'owned-processes.json');
    const marker = 'zen-e2e-test-failed-launcher';

    try {
      const result = await runOwnedCommand({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(1), 100)', '--', marker],
        marker,
        manifestPath,
        stdio: 'ignore',
      });

      expect(result.exitCode).toBe(1);
      await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"entries": []');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
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

function ownedEntry() {
  return {
    pid: 1234,
    marker: 'zen-e2e-test-marker',
    createdAt: '20260717120000.000000+000',
    platform: 'win32',
  };
}
