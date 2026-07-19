import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  ownedE2eSupervisorTesting,
  registerSpawnedProcess,
  runOwnedCommand,
  terminateRegisteredProcess,
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
        parentChain: [{ pid: 10, creationToken: root.creationToken }],
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
      await expect(readLedger(manifestPath)).resolves.toContain('"entries":[]');
    });
  });

  it('accepts supervisor zero only from two empty views in one paired pass', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      await writeManifest(manifestPath, marker, []);
      let snapshotCalls = 0;

      await cleanupOwnedManifest({
        manifestPath,
        retainLedger: true,
        snapshots: async () => {
          snapshotCalls += 1;
          return [[], []];
        },
      });

      expect(snapshotCalls).toBe(1);
    });
  });

  it('calls an injected supervisor list twice inside one fallback paired pass', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      await writeManifest(manifestPath, marker, []);
      let listCalls = 0;

      await cleanupOwnedManifest({
        manifestPath,
        retainLedger: true,
        list: async () => {
          listCalls += 1;
          return [];
        },
      });

      expect(listCalls).toBe(2);
    });
  });

  it('discovers and cleans a marked process appearing only in the second supervisor view', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 13, parentPid: 1, parentChain: [] });
      await writeManifest(manifestPath, marker, [root]);
      let live = true;
      let snapshotCalls = 0;
      const terminated = [];

      await cleanupOwnedManifest({
        manifestPath,
        retainLedger: true,
        snapshots: async () => {
          snapshotCalls += 1;
          return live ? [[], [root]] : [[], []];
        },
        terminate: async (entry) => {
          terminated.push(entry.pid);
          live = false;
        },
      });

      expect(terminated).toEqual([root.pid]);
      expect(snapshotCalls).toBe(2);
    });
  });

  it('discovers unknown child and grandchild identities only in the second supervisor view', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 15, parentPid: 1, parentChain: [] });
      const child = ownedEntry({ marker, pid: 16, parentPid: root.pid, rootPid: root.pid });
      const grandchild = ownedEntry({
        marker,
        pid: 17,
        parentPid: child.pid,
        rootPid: root.pid,
      });
      await writeManifest(manifestPath, marker, [root]);
      const processes = new Map([
        [root.pid, root],
        [child.pid, child],
        [grandchild.pid, grandchild],
      ]);
      const terminated = [];

      await cleanupOwnedManifest({
        manifestPath,
        retainLedger: true,
        snapshots: async () => [processes.has(root.pid) ? [root] : [], [...processes.values()]],
        terminate: async (entry) => {
          terminated.push(entry.pid);
          processes.delete(entry.pid);
        },
      });

      expect(terminated).toEqual([grandchild.pid, child.pid, root.pid]);
      const persisted = await ownedE2eSupervisorTesting.createManifestStore(manifestPath).read();
      expect(persisted.entries.map((entry) => entry.pid).sort()).toEqual([
        root.pid,
        child.pid,
        grandchild.pid,
      ]);
    });
  });

  it('repeats paired confirmation when the ledger revision changes between views', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      await writeManifest(manifestPath, marker, []);
      let snapshotCalls = 0;
      let appended = false;

      await cleanupOwnedManifest({
        manifestPath,
        retainLedger: true,
        snapshots: async () => {
          snapshotCalls += 1;
          return [[], []];
        },
        afterDiscoveryView: async ({ manifest }) => {
          if (appended) return;
          appended = true;
          await manifest.upsert(marker, ownedEntry({ marker, pid: 14, parentPid: 1 }));
        },
      });

      expect(snapshotCalls).toBe(2);
      await expect(readLedger(manifestPath)).resolves.toContain('"pid":14');
    });
  });

  it('discovers a marked descendant created during a termination pass', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 70, parentPid: 1, parentChain: [] });
      const late = ownedEntry({ marker, pid: 71, parentPid: root.pid, rootPid: root.pid });
      const processes = new Map([[root.pid, root]]);
      const terminated = [];
      await writeManifest(manifestPath, marker, [root]);

      await cleanupOwnedManifest({
        manifestPath,
        inspect: async (pid) => processes.get(pid),
        list: async () => [...processes.values()],
        terminate: async (entry) => {
          terminated.push(entry.pid);
          processes.delete(entry.pid);
          if (entry.pid === root.pid) processes.set(late.pid, late);
        },
      });

      expect(terminated).toEqual([root.pid, late.pid]);
      await expect(readLedger(manifestPath)).resolves.toContain('"entries":[]');
    });
  });

  it('retains an unmarked descendant discovered on the pass after a leaf termination', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 80, parentPid: 1, parentChain: [] });
      const leaf = ownedEntry({
        marker,
        pid: 81,
        parentPid: root.pid,
        rootPid: root.pid,
        parentChain: [{ pid: root.pid, creationToken: root.creationToken }],
      });
      const unmarked = {
        ...ownedEntry({ marker, pid: 82, parentPid: root.pid, rootPid: root.pid }),
        commandLine: 'node unrelated-late-child',
      };
      const processes = new Map([
        [root.pid, root],
        [leaf.pid, leaf],
      ]);
      const terminated = [];
      await writeManifest(manifestPath, marker, [root, leaf]);

      await expect(
        cleanupOwnedManifest({
          manifestPath,
          inspect: async (pid) => processes.get(pid),
          list: async () => [...processes.values()],
          terminate: async (entry) => {
            terminated.push(entry.pid);
            processes.delete(entry.pid);
            if (entry.pid === leaf.pid) processes.set(unmarked.pid, unmarked);
          },
        })
      ).rejects.toThrow('exact owner identity');

      expect(terminated).toEqual([leaf.pid]);
      await expect(readLedger(manifestPath)).resolves.toContain('"pid":82');
    });
  });

  it('fails bounded cleanup when marked descendants keep appearing', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 90, parentPid: 1, parentChain: [] });
      const processes = new Map([[root.pid, root]]);
      let nextPid = 91;
      await writeManifest(manifestPath, marker, [root]);

      await expect(
        cleanupOwnedManifest({
          manifestPath,
          maxPasses: 3,
          inspect: async (pid) => processes.get(pid),
          list: async () => [...processes.values()],
          terminate: async (entry) => {
            processes.delete(entry.pid);
            const replacement = ownedEntry({
              marker,
              pid: nextPid++,
              parentPid: root.pid,
              rootPid: root.pid,
            });
            processes.set(replacement.pid, replacement);
            processes.set(root.pid, root);
          },
        })
      ).rejects.toThrow('did not reach quiescence after 3 passes');

      await expect(readLedger(manifestPath)).resolves.toContain('"entries":');
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
      await expect(readLedger(manifestPath)).resolves.toContain('"pid":55');

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
      await expect(readLedger(manifestPath)).resolves.toContain('unverified-unowned-test');
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
        parentChain: [{ pid: root.pid, creationToken: root.creationToken }],
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
      await expect(readLedger(manifestPath)).resolves.toContain('"entries":[]');
    });
  });

  it('retains an unmarked late child when its recorded root is already absent', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const root = ownedEntry({ marker, pid: 120, parentPid: 1, parentChain: [] });
      const unmarked = {
        ...ownedEntry({ marker, pid: 121, parentPid: root.pid, rootPid: root.pid }),
        commandLine: 'node late-unmarked-child',
      };
      const processes = new Map([[unmarked.pid, unmarked]]);
      const terminated = [];
      await writeManifest(manifestPath, marker, [root]);

      await expect(
        cleanupOwnedManifest({
          manifestPath,
          inspect: async (pid) => processes.get(pid),
          list: async () => [...processes.values()],
          terminate: async (entry) => terminated.push(entry.pid),
        })
      ).rejects.toThrow('exact owner identity');

      expect(terminated).toEqual([]);
      await expect(readLedger(manifestPath)).resolves.toContain('unverified-ancestry-descendant');
      await expect(readLedger(manifestPath)).resolves.toContain('"pid":121');
    });
  });

  it('retains a PID-reused record and does not kill it', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const entry = ownedEntry({ marker });
      const reused = {
        ...entry,
        createdAt: 'reused-process',
        commandLine: 'node unrelated-reused-process',
      };
      const terminated = [];
      await writeManifest(manifestPath, marker, [entry]);

      await expect(
        cleanupOwnedManifest({
          manifestPath,
          inspect: async () => reused,
          list: async () => [reused],
          terminate: async (candidate) => terminated.push(candidate.pid),
        })
      ).resolves.toBeUndefined();

      expect(terminated).toEqual([]);
      await expect(readLedger(manifestPath)).resolves.toContain('"entries":[]');
    });
  });

  it('discovers and terminates a marker-bearing new identity that reused an old PID', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const old = ownedEntry({ marker, pid: 130, parentPid: 1, parentChain: [] });
      const current = { ...old, createdAt: 'new-identity' };
      const processes = new Map([[current.pid, current]]);
      const terminated = [];
      await writeManifest(manifestPath, marker, [old]);

      await cleanupOwnedManifest({
        manifestPath,
        inspect: async (pid) => processes.get(pid),
        list: async () => [...processes.values()],
        terminate: async (entry) => {
          terminated.push(entry.pid);
          processes.delete(entry.pid);
        },
      });

      expect(terminated).toEqual([current.pid]);
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
          parentChain: [{ pid: root.pid, creationToken: root.creationToken }],
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

      await expect(readLedger(manifestPath)).resolves.toContain('"pid":11');
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

  it('folds concurrent cross-process ledger events without losing identities', async () => {
    await withManifest(async ({ directory, manifestPath, marker }) => {
      const writer = path.join(directory, 'ledger-writer.mjs');
      const supervisorUrl = pathToFileURL(path.resolve('scripts/owned-e2e-supervisor.mjs')).href;
      await writeFile(
        writer,
        [
          `import { ownedE2eSupervisorTesting } from '${supervisorUrl}';`,
          'const [manifestPath, marker, index] = process.argv.slice(2);',
          'await ownedE2eSupervisorTesting.createManifestStore(manifestPath).upsert(marker, {',
          '  pid: 9000 + Number(index), parentPid: 1, createdAt: "2026-07-17T12:00:00.000Z",',
          '  creationToken: String(1784300000000 + Number(index)), executable: "C:\\\\node.exe",',
          '  commandLine: `node --title=${marker} ledger-${index}`, marker, rootPid: 9000 + Number(index),',
          '  role: "concurrent-test", parentChain: []',
          '});',
        ].join('\n'),
        'utf8'
      );

      await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          waitForExit(spawn(process.execPath, [writer, manifestPath, marker, String(index)]))
        )
      );

      const ledger = ownedE2eSupervisorTesting.createManifestStore(manifestPath);
      const snapshot = await ledger.read();
      expect(snapshot.entries).toHaveLength(16);
      await Promise.all([
        ledger.upsert(marker, snapshot.entries[0]),
        ledger.upsert(marker, snapshot.entries[0]),
      ]);
      expect((await ledger.read()).entries).toHaveLength(16);
      expect(await readdir(manifestPath)).toHaveLength(19);
    });
  }, 15_000);

  it('isolates same-process runs and reclaims only owner-dead, well-formed runs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
    const root = path.join(directory, 'runs');
    const owner = leaseOwner(901);
    const live = [owner];
    const markerA = 'zen-e2e-same-process-a';
    const markerB = 'zen-e2e-same-process-b';
    try {
      const first = await ownedE2eSupervisorTesting.createRunStore(root, markerA, {
        captureLeaseOwner: async () => owner,
      });
      const second = await ownedE2eSupervisorTesting.createRunStore(root, markerB, {
        captureLeaseOwner: async () => owner,
      });
      expect(first.runDirectory).not.toBe(second.runDirectory);
      await first.upsert(markerA, ownedEntry({ marker: markerA, pid: 902 }));
      await second.upsert(markerB, ownedEntry({ marker: markerB, pid: 903 }));

      await ownedE2eSupervisorTesting.reclaimStaleRuns(root, async () => live);
      await expect(readdir(first.runDirectory)).resolves.toContain('run.json');
      await expect(readdir(second.runDirectory)).resolves.toContain('run.json');

      live.length = 0;
      await ownedE2eSupervisorTesting.reclaimStaleRuns(root, async () => []);
      await expect(readdir(first.runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readdir(second.runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeOwnedTestDirectory(directory, undefined, { list: async () => [] });
    }
  });

  it('retains malformed or unknown-child runs without blocking a separate new run', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
    const root = path.join(directory, 'runs');
    const owner = leaseOwner(910);
    try {
      const bad = await ownedE2eSupervisorTesting.createRunStore(root, 'zen-e2e-bad-run', {
        captureLeaseOwner: async () => owner,
      });
      await writeFile(path.join(bad.runDirectory, 'unknown.bin'), 'diagnostic', 'utf8');
      const good = await ownedE2eSupervisorTesting.createRunStore(root, 'zen-e2e-good-run', {
        captureLeaseOwner: async () => owner,
      });
      await ownedE2eSupervisorTesting.reclaimStaleRuns(root, async () => []);
      await expect(readdir(bad.runDirectory)).resolves.toContain('unknown.bin');
      await expect(readdir(good.runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeOwnedTestDirectory(directory, undefined, { list: async () => [] });
    }
  });

  it('takes its stale-owner snapshot after candidate enumeration', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
    const root = path.join(directory, 'runs');
    const owner = leaseOwner(920);
    let late;
    try {
      await mkdir(root);
      await ownedE2eSupervisorTesting.reclaimStaleRuns(root, async () => [owner], {
        afterEnumerate: async () => {
          late = await ownedE2eSupervisorTesting.createRunStore(root, 'zen-e2e-late-owner', {
            captureLeaseOwner: async () => owner,
          });
        },
      });
      await expect(readdir(late.runDirectory)).resolves.toContain('run.json');
    } finally {
      await removeOwnedTestDirectory(directory, undefined, { list: async () => [] });
    }
  });

  it('ignores an in-progress event and rejects terminal clear after a late completed event', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const ledger = ownedE2eSupervisorTesting.createManifestStore(manifestPath);
      const before = await ledger.read();
      await writeFile(
        path.join(manifestPath, 'entry-00000000-0000-0000-0000-000000000001.tmp'),
        '{"partial":true}',
        'utf8'
      );
      expect((await ledger.read()).revision).toBe(before.revision);
      await ledger.upsert(marker, ownedEntry({ marker, pid: 930 }));
      await expect(ledger.clear(marker, before.revision)).rejects.toThrow(
        'Ownership ledger changed before terminal clear'
      );
    });
  });

  it('keeps event records minimal and bounded across many entries', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const ledger = ownedE2eSupervisorTesting.createManifestStore(manifestPath);
      for (let index = 0; index < 12; index += 1)
        await ledger.upsert(marker, ownedEntry({ marker, pid: 940 + index }));
      const names = (await readdir(manifestPath)).filter(
        (name) => name.endsWith('.json') && name !== 'run.json'
      );
      const events = await Promise.all(
        names.map((name) => readFile(path.join(manifestPath, name), 'utf8'))
      );
      for (const event of events) {
        const parsed = JSON.parse(event);
        expect(Object.keys(parsed).sort()).toEqual(['entry', 'marker', 'runId', 'version']);
        expect(event).not.toContain('"entries"');
        expect(event).not.toContain('"revision"');
        expect(event.length).toBeLessThan(1_000);
      }
    });
  });

  it('makes parallel stale cleaners idempotent without touching a live separate run', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
    const root = path.join(directory, 'runs');
    const dead = leaseOwner(950);
    const live = leaseOwner(951);
    try {
      const stale = await ownedE2eSupervisorTesting.createRunStore(root, 'zen-e2e-dead-run', {
        captureLeaseOwner: async () => dead,
      });
      const retained = await ownedE2eSupervisorTesting.createRunStore(root, 'zen-e2e-live-run', {
        captureLeaseOwner: async () => live,
      });
      await Promise.all([
        ownedE2eSupervisorTesting.reclaimStaleRuns(root, async () => [live]),
        ownedE2eSupervisorTesting.reclaimStaleRuns(root, async () => [live]),
      ]);
      await expect(readdir(stale.runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readdir(retained.runDirectory)).resolves.toContain('run.json');
    } finally {
      await removeOwnedTestDirectory(directory, undefined, { list: async () => [] });
    }
  });

  it('treats a Windows path case alias as the same confined ownership root', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
    const root = path.join(directory, 'runs');
    const aliasedRoot = process.platform === 'win32' ? root.toUpperCase() : root;
    const dead = leaseOwner(952);
    try {
      const stale = await ownedE2eSupervisorTesting.createRunStore(
        aliasedRoot,
        'zen-e2e-path-case',
        { captureLeaseOwner: async () => dead }
      );
      await ownedE2eSupervisorTesting.reclaimStaleRuns(aliasedRoot, async () => []);
      await expect(readdir(stale.runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeOwnedTestDirectory(directory, undefined, { list: async () => [] });
    }
  });

  it('retains a paused writer during clear, then clears after release and revision revalidation', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const entered = deferred();
      const release = deferred();
      const writer = ownedE2eSupervisorTesting.createManifestStore(manifestPath, {
        beforeAppendRename: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const controller = ownedE2eSupervisorTesting.createManifestStore(manifestPath);
      const append = writer.upsert(marker, ownedEntry({ marker, pid: 401, parentPid: 1 }));

      await entered.promise;
      const beforeClear = await controller.read();
      await expect(controller.clear(marker, beforeClear.revision)).rejects.toThrow(
        'active writer lease'
      );
      expect((await controller.read()).entries).toEqual([]);
      release.resolve();
      await expect(append).resolves.toBeUndefined();
      const afterWrite = await controller.read();
      await controller.clear(marker, afterWrite.revision);

      await expect(controller.read()).rejects.toThrow('Invalid immutable ownership run metadata');
      await expect(readdir(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('releases a writer lease when afterWriterLease fails', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const failing = ownedE2eSupervisorTesting.createManifestStore(manifestPath, {
        afterWriterLease: async () => {
          throw new Error('writer hook failed');
        },
      });
      await expect(failing.upsert(marker, ownedEntry({ marker, pid: 470 }))).rejects.toThrow(
        'writer hook failed'
      );
      expect((await readdir(manifestPath)).filter((name) => name.startsWith('writer-'))).toEqual(
        []
      );
      const ledger = ownedE2eSupervisorTesting.createManifestStore(manifestPath);
      const snapshot = await ledger.read();
      await expect(ledger.clear(marker, snapshot.revision)).resolves.toBeUndefined();
    });
  });

  it('uses tombstone hooks to reject a writer that begins during terminal clear', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const started = deferred();
      const release = deferred();
      const clearer = ownedE2eSupervisorTesting.createManifestStore(manifestPath, {
        afterTombstone: async () => started.resolve(),
        beforeClearSnapshot: async () => release.promise,
      });
      const snapshot = await clearer.read();
      const clearing = clearer.clear(marker, snapshot.revision);
      await started.promise;
      const writer = ownedE2eSupervisorTesting.createManifestStore(manifestPath);
      await expect(writer.upsert(marker, ownedEntry({ marker, pid: 471 }))).rejects.toThrow(
        'terminal run'
      );
      release.resolve();
      await clearing;
    });
  });

  it('atomically isolates a run when a writer pauses after reading before its lease capture', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const entered = deferred();
      const release = deferred();
      const owner = ownedEntry({ marker, pid: 472, parentPid: 1 });
      const writer = ownedE2eSupervisorTesting.createManifestStore(manifestPath, {
        captureLeaseOwner: async () => {
          entered.resolve();
          return release.promise;
        },
      });
      const controller = ownedE2eSupervisorTesting.createManifestStore(manifestPath);
      const pending = writer.upsert(marker, ownedEntry({ marker, pid: 473, parentPid: 1 }));

      await entered.promise;
      const snapshot = await controller.read();
      await controller.clear(marker, snapshot.revision);
      release.resolve(owner);

      await expect(pending).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readdir(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('does not initialize a replacement generation until a paused writer releases', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const entered = deferred();
      const release = deferred();
      const owner = leaseOwner(4020);
      const writer = ownedE2eSupervisorTesting.createManifestStore(manifestPath, {
        captureLeaseOwner: async () => owner,
        beforeAppendRename: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const controller = ownedE2eSupervisorTesting.createManifestStore(manifestPath, {
        listLeaseOwners: async () => [],
      });
      const append = writer.upsert(marker, ownedEntry({ marker, pid: 402, parentPid: 1 }));

      await entered.promise;
      const first = await controller.read();
      await expect(controller.clear(marker, first.revision)).rejects.toThrow('active writer lease');
      release.resolve();
      await expect(append).resolves.toBeUndefined();
      const refreshed = await controller.read();
      await controller.clear(marker, refreshed.revision);
      const nextStore = await ownedE2eSupervisorTesting.createRunStore(
        path.dirname(manifestPath),
        marker,
        { captureLeaseOwner: async () => owner }
      );
      const next = await nextStore.read();

      expect(next.runId).not.toBe(first.runId);
      expect(next.entries).toEqual([]);
    });
  });

  it('allows a paused old-generation writer to finish without contaminating a new run', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const entered = deferred();
      const release = deferred();
      const writer = ownedE2eSupervisorTesting.createManifestStore(manifestPath, {
        beforeAppendRename: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const controller = ownedE2eSupervisorTesting.createManifestStore(manifestPath);
      const append = writer.upsert(marker, ownedEntry({ marker, pid: 403, parentPid: 1 }));

      await entered.promise;
      const old = await controller.read();
      const nextStore = await ownedE2eSupervisorTesting.createRunStore(
        path.dirname(manifestPath),
        marker
      );
      const next = await nextStore.read();
      release.resolve();
      await expect(append).resolves.toBeUndefined();

      expect((await readdir(manifestPath)).filter((name) => name.endsWith('.json'))).toHaveLength(
        2
      );
      expect(next.runId).not.toBe(old.runId);
      expect(next.entries).toEqual([]);
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

      await expect(cleanupOwnedManifest(operations)).rejects.toThrow('did not reach quiescence');
      await expect(readLedger(manifestPath)).resolves.toContain('"pid":1234');

      orphanLive = false;
      await cleanupOwnedManifest(operations);
      await expect(readLedger(manifestPath)).resolves.toContain('"entries":[]');
    });
  });

  it('uses an explicit marker postcondition without parsing a legacy manifest', async () => {
    await withManifest(async ({ directory, marker }) => {
      const legacy = path.join(directory, 'legacy-schema-5.json');
      await writeFile(legacy, '{not valid json', 'utf8');
      await expect(
        assertNoOwnedProcesses({ manifestPath: legacy, marker, list: async () => [] })
      ).resolves.toBeUndefined();
      await expect(
        assertNoOwnedProcesses({
          manifestPath: legacy,
          marker,
          list: async () => [ownedEntry({ marker, pid: 474 })],
        })
      ).rejects.toThrow('independent marker scan');
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
      await expect(readLedger(manifestPath)).resolves.toContain('"entries":[]');
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
      await expect(readLedger(manifestPath)).resolves.toContain('"entries":[]');
    });
  });

  it('stops the exact direct root and retains unverified ledger evidence on registration failure', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const identity = {
        ...ownedEntry({ marker, pid: 777, parentPid: 1, parentChain: [] }),
        commandLine: 'node unmarked-root',
      };
      const processes = new Map([[identity.pid, identity]]);
      const child = new EventEmitter();
      child.pid = identity.pid;
      child.exitCode = null;
      child.kill = vi.fn(() => {
        child.exitCode = 143;
        processes.delete(identity.pid);
        child.emit('exit', 143, 'SIGTERM');
        return true;
      });

      await expect(
        runOwnedCommand({
          command: process.execPath,
          args: ['--unmarked-root'],
          marker,
          manifestPath,
          stdio: 'ignore',
          spawnCommand: () => child,
          inspect: async () => identity,
          list: async () => [...processes.values()],
        })
      ).rejects.toThrow('lacks owner marker');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(processes.size).toBe(0);
      await expect(readLedger(manifestPath)).resolves.toContain('unverified-runner-root');
    });
  });

  it('aggregates registration and direct-child cleanup failures without clearing evidence', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const identity = {
        ...ownedEntry({ marker, pid: 778, parentPid: 1, parentChain: [] }),
        commandLine: 'node unmarked-root',
      };
      const child = new EventEmitter();
      child.pid = identity.pid;
      child.exitCode = null;
      child.kill = vi.fn(() => false);

      await expect(
        runOwnedCommand({
          command: process.execPath,
          args: ['--unmarked-root'],
          marker,
          manifestPath,
          stdio: 'ignore',
          spawnCommand: () => child,
          inspect: async () => identity,
          list: async () => [],
        })
      ).rejects.toThrow('registration and cleanup both failed');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await expect(readLedger(manifestPath)).resolves.toContain('unverified-runner-root');
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
      await expect(readLedger(manifestPath)).resolves.toContain('"entries":[]');
    });
  });

  it('requires exact creation, command, parent, executable, and marker identity', () => {
    const entry = ownedEntry({ marker: 'zen-e2e-test-marker' });
    expect(isOwnedProcess(entry, entry)).toBe(true);
    expect(isOwnedProcess(entry, { ...entry, commandLine: 'node unrelated' })).toBe(false);
    expect(isOwnedProcess(entry, { ...entry, creationToken: '1784300000001' })).toBe(false);
    expect(isOwnedProcess(entry, { ...entry, parentPid: 999 })).toBe(false);
  });

  it('uses the default E2E handle terminator only for an exact marked identity', async () => {
    await withManifest(async ({ manifestPath, marker }) => {
      const child = spawn(
        process.execPath,
        [`--title=${marker}`, '-e', 'setInterval(() => {}, 1000)'],
        {
          stdio: 'ignore',
        }
      );
      try {
        const entry = await registerSpawnedProcess({
          child,
          marker,
          rootPid: child.pid,
          role: 'default-terminator-test',
          manifestPath,
        });
        for (const invalid of [
          { ...entry, creationToken: `${BigInt(entry.creationToken) + 1n}` },
          { ...entry, marker: `${marker}-wrong` },
          { ...entry, commandLine: `${entry.commandLine} altered` },
        ]) {
          await expect(terminateRegisteredProcess(invalid)).rejects.toThrow();
          expect(child.exitCode).toBeNull();
        }
        const exited = once(child, 'exit');
        await terminateRegisteredProcess(entry);
        await exited;
      } finally {
        if (child.exitCode === null) child.kill('SIGTERM');
      }
    });
  }, 15_000);

  it('refuses test-directory teardown while a live command line references its path or marker', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
    const marker = `zen-e2e-test-${path.basename(directory)}`;
    let removed = false;
    try {
      for (const commandLine of [`node ${directory}`, `node --title=${marker}`]) {
        await expect(
          removeOwnedTestDirectory(directory, marker, {
            list: async () => [{ commandLine }],
          })
        ).rejects.toThrow('referenced by 1 live process');
        await expect(readdir(directory)).resolves.toEqual([]);
      }

      await removeOwnedTestDirectory(directory, marker, { list: async () => [] });
      removed = true;
      await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (!removed) await removeOwnedTestDirectory(directory, marker, { list: async () => [] });
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

async function withManifest(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'zen-e2e-supervisor-'));
  const rootPath = path.join(directory, 'owned-processes.json');
  const marker = `zen-e2e-test-${path.basename(directory)}`;
  try {
    const store = await ownedE2eSupervisorTesting.createRunStore(`${rootPath}.ledger`, marker);
    await run({
      directory,
      manifestPath: store.runDirectory,
      ledgerRoot: `${rootPath}.ledger`,
      marker,
    });
  } finally {
    await removeOwnedTestDirectory(directory, marker);
  }
}

function leaseOwner(pid) {
  return {
    pid,
    parentPid: 1,
    creationToken: `${1784300000000 + pid}`,
    executable: 'C:\\node.exe',
    commandLine: `node --title=lease-owner-${pid}`,
  };
}

async function removeOwnedTestDirectory(
  directory,
  marker,
  { list = () => ownedE2eSupervisorTesting.listProcesses(process.platform) } = {}
) {
  const root = path.resolve(tmpdir());
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== root ||
    !path.basename(resolved).startsWith('zen-e2e-supervisor-')
  ) {
    throw new Error(`Refusing to remove unexpected test directory ${resolved}`);
  }
  const references = (await list()).filter(
    (candidate) =>
      candidate.commandLine?.includes(resolved) ||
      (marker && candidate.commandLine?.includes(marker))
  );
  if (references.length > 0)
    throw new Error(
      `Refusing to remove test directory referenced by ${references.length} live process(es)`
    );
  await rm(resolved, { force: true, recursive: true });
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))
    );
  });
}

async function writeManifest(manifestPath, marker, entries) {
  const ledger = ownedE2eSupervisorTesting.createManifestStore(manifestPath);
  await ledger.upsertMany(marker, entries);
}

async function readLedger(manifestPath) {
  try {
    return JSON.stringify(await ownedE2eSupervisorTesting.createManifestStore(manifestPath).read());
  } catch (cause) {
    if (cause?.code === 'ENOENT' || /Invalid immutable ownership run metadata/.test(String(cause)))
      return JSON.stringify({ entries: [] });
    throw cause;
  }
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
    createdAt: '2026-07-17T12:00:00.000Z',
    creationToken: '1784300000000',
    executable: 'C:\\node.exe',
    commandLine: `node --title=${marker} worker`,
    role: 'test',
    parentChain,
  };
}
