import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  OwnedProcessTree,
  ownedProcessTesting,
  type OwnedProcessIdentity,
} from '../packages/framework/src/adapters/node/owned-process-cleanup.js';

describe('OwnedProcessTree', () => {
  it('terminates an exact owned snapshot leaf-first', async () => {
    const root = processIdentity(10, 1, 'root');
    const child = processIdentity(11, root.pid, 'child');
    const leaf = processIdentity(12, child.pid, 'leaf');
    const processes = new Map([
      [root.pid, root],
      [child.pid, child],
      [leaf.pid, leaf],
    ]);
    const terminated: number[] = [];
    const tree = new OwnedProcessTree(expectation(root), {
      list: async () => [...processes.values()],
      terminate: async (identity) => {
        terminated.push(identity.pid);
        processes.delete(identity.pid);
        return undefined;
      },
    });

    expect(tree.captureAttested(root)).toBe(true);

    await expect(tree.terminateVerified()).resolves.toEqual([leaf.pid, child.pid, root.pid]);
    expect(terminated).toEqual([leaf.pid, child.pid, root.pid]);
    expect(processes).toEqual(new Map());
  });

  it('uses one paired snapshot provider per cleanup pass while preserving two distinct views', async () => {
    const root = processIdentity(15, 1, 'root');
    const processes = new Map([[root.pid, root]]);
    let snapshotCalls = 0;
    const tree = new OwnedProcessTree(expectation(root), {
      snapshots: async () => {
        snapshotCalls += 1;
        const first = [...processes.values()];
        const second = [...processes.values()].map((identity) => ({ ...identity }));
        expect(first).not.toBe(second);
        return [first, second];
      },
      terminate: async (identity) => {
        processes.delete(identity.pid);
      },
    });
    expect(tree.captureAttested(root)).toBe(true);

    await expect(tree.terminateVerified()).resolves.toEqual([root.pid]);
    // One paired operation terminates the root; one paired-zero operation closes cleanup.
    expect(snapshotCalls).toBe(2);
  });

  it('accepts zero only when both views from one paired helper are empty', async () => {
    const root = processIdentity(16, 1, 'root');
    let snapshotCalls = 0;
    const tree = new OwnedProcessTree(expectation(root), {
      snapshots: async () => {
        snapshotCalls += 1;
        return [[], []];
      },
    });
    expect(tree.captureAttested(root)).toBe(true);

    await expect(tree.terminateVerified()).resolves.toEqual([]);
    expect(snapshotCalls).toBe(1);
  });

  it('discovers and terminates an exact process appearing only in the second paired view', async () => {
    const root = processIdentity(17, 1, 'root');
    let snapshotCalls = 0;
    let live = true;
    const terminated: number[] = [];
    const tree = new OwnedProcessTree(expectation(root), {
      snapshots: async () => {
        snapshotCalls += 1;
        return live ? [[], [root]] : [[], []];
      },
      terminate: async (identity) => {
        terminated.push(identity.pid);
        live = false;
      },
    });
    expect(tree.captureAttested(root)).toBe(true);

    await expect(tree.terminateVerified()).resolves.toEqual([root.pid]);
    expect(terminated).toEqual([root.pid]);
    expect(snapshotCalls).toBe(2);
  });

  it('discovers unknown descendants appearing only in the second paired view', async () => {
    const root = processIdentity(181, 1, 'root');
    const child = processIdentity(182, root.pid, 'late-child');
    const grandchild = processIdentity(183, child.pid, 'late-grandchild');
    const processes = new Map([
      [child.pid, child],
      [grandchild.pid, grandchild],
    ]);
    const terminated: number[] = [];
    const tree = new OwnedProcessTree(expectation(root), {
      snapshots: async () => [[], [...processes.values()]],
      terminate: async (identity) => {
        terminated.push(identity.pid);
        processes.delete(identity.pid);
      },
    });
    expect(tree.captureAttested(root)).toBe(true);

    await expect(tree.terminateVerified()).resolves.toEqual([grandchild.pid, child.pid]);
    expect(terminated).toEqual([grandchild.pid, child.pid]);
    expect(processes.size).toBe(0);
  });

  it('calls an injected list operation twice inside one fallback paired pass', async () => {
    const root = processIdentity(18, 1, 'root');
    let listCalls = 0;
    const tree = new OwnedProcessTree(expectation(root), {
      list: async () => {
        listCalls += 1;
        return [];
      },
    });
    expect(tree.captureAttested(root)).toBe(true);

    await expect(tree.terminateVerified()).resolves.toEqual([]);
    expect(listCalls).toBe(2);
  });

  it('refuses PID reuse or a changed ancestor chain without terminating any process', async () => {
    const root = processIdentity(20, 1, 'root');
    const child = processIdentity(21, root.pid, 'child');
    const processes = new Map([
      [root.pid, root],
      [child.pid, child],
    ]);
    const terminated: number[] = [];
    const tree = new OwnedProcessTree(expectation(root), {
      list: async () => [...processes.values()],
      terminate: async (identity) => {
        terminated.push(identity.pid);
        return undefined;
      },
    });
    expect(tree.captureAttested(root)).toBe(true);
    processes.set(root.pid, {
      ...root,
      createdAt: 'reused-root',
      creationToken: String(BigInt(root.creationToken) + 100n),
      commandLine: 'powershell unrelated-replacement',
    });
    processes.delete(child.pid);

    await expect(tree.terminateVerified()).resolves.toEqual([]);
    expect(terminated).toEqual([]);

    expect(processes.get(root.pid)).toEqual(
      expect.objectContaining({ commandLine: 'powershell unrelated-replacement' })
    );
  });

  it('leaves zero tracked residue after timeout and abort cleanup requests', async () => {
    const root = processIdentity(30, 1, 'root');
    const child = processIdentity(31, root.pid, 'child');
    const processes = new Map([
      [root.pid, root],
      [child.pid, child],
    ]);
    const tree = new OwnedProcessTree(expectation(root), {
      list: async () => [...processes.values()],
      terminate: async (identity) => {
        processes.delete(identity.pid);
        return undefined;
      },
    });
    expect(tree.captureAttested(root)).toBe(true);

    await tree.terminateVerified();
    await expect(tree.terminateVerified()).resolves.toEqual([child.pid, root.pid]);
    expect(processes.size).toBe(0);
  });

  it('rescans and terminates descendants created while a leaf is being stopped', async () => {
    const root = processIdentity(40, 1, 'root');
    const child = processIdentity(41, root.pid, 'child');
    const leaf = processIdentity(42, child.pid, 'leaf');
    const lateChild = processIdentity(43, child.pid, 'late-child');
    const processes = new Map([
      [root.pid, root],
      [child.pid, child],
      [leaf.pid, leaf],
    ]);
    const terminated: number[] = [];
    const tree = new OwnedProcessTree(expectation(root), {
      list: async () => [...processes.values()],
      terminate: async (identity) => {
        terminated.push(identity.pid);
        processes.delete(identity.pid);
        if (identity.pid === leaf.pid) processes.set(lateChild.pid, lateChild);
      },
    });
    expect(tree.captureAttested(root)).toBe(true);

    await expect(tree.terminateVerified()).resolves.toEqual([
      leaf.pid,
      lateChild.pid,
      child.pid,
      root.pid,
    ]);
    expect(terminated).toEqual([leaf.pid, lateChild.pid, child.pid, root.pid]);
  });

  it('discovers a child linked to retained root ancestry after root termination', async () => {
    const root = processIdentity(45, 1, 'root');
    const lateChild = processIdentity(46, root.pid, 'late-child');
    const processes = new Map([[root.pid, root]]);
    const terminated: number[] = [];
    const tree = new OwnedProcessTree(expectation(root), {
      list: async () => [...processes.values()],
      terminate: async (identity) => {
        terminated.push(identity.pid);
        processes.delete(identity.pid);
        if (identity.pid === root.pid) processes.set(lateChild.pid, lateChild);
      },
    });
    expect(tree.captureAttested(root)).toBe(true);

    await expect(tree.terminateVerified()).resolves.toEqual([root.pid, lateChild.pid]);
    expect(terminated).toEqual([root.pid, lateChild.pid]);
  });

  it('fails cleanup explicitly when the root identity was absent at capture time', async () => {
    const tree = new OwnedProcessTree(expectation(processIdentity(47, 1, 'missing')), {
      list: async () => [],
    });

    expect(tree.captureAttested(processIdentity(48, 1, 'wrong'))).toBe(false);
    await expect(tree.terminateVerified()).rejects.toThrow('was not captured before it exited');
  });

  it('propagates a cleanup failure through the one shared cleanup task', async () => {
    const root = processIdentity(50, 1, 'root');
    let terminateCalls = 0;
    const tree = new OwnedProcessTree(expectation(root), {
      list: async () => [root],
      terminate: async () => {
        terminateCalls += 1;
        throw new Error('termination provider failed');
      },
    });
    expect(tree.captureAttested(root)).toBe(true);

    const first = tree.terminateVerified();
    const second = tree.terminateVerified();
    await expect(Promise.all([first, second])).rejects.toThrow('termination provider failed');
    expect(terminateCalls).toBe(1);
  });

  it('uses the default Windows handle terminator only for an exact live identity', async () => {
    if (process.platform !== 'win32') return;
    const marker = `zen-local-terminator-${Date.now()}`;
    const child = spawn(
      process.execPath,
      [`--title=${marker}`, '-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      }
    );
    try {
      const identity = await waitForIdentity(child.pid ?? 0);
      for (const invalid of [
        { ...identity, creationToken: `${BigInt(identity.creationToken) + 1n}` },
        { ...identity, commandLine: `${identity.commandLine} altered` },
        { ...identity, parentPid: identity.parentPid + 1 },
        { ...identity, executable: `${identity.executable}.wrong` },
      ]) {
        await expect(ownedProcessTesting.terminateWindowsProcess(invalid)).rejects.toThrow();
        expect(child.exitCode).toBeNull();
      }
      const exited = once(child, 'exit');
      await ownedProcessTesting.terminateWindowsProcess(identity);
      await exited;
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }, 15_000);
});

async function waitForIdentity(pid: number): Promise<OwnedProcessIdentity> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const identity = (await ownedProcessTesting.listWindowsProcesses()).find(
      (candidate) => candidate.pid === pid
    );
    if (identity) return identity;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Missing test child identity ${pid}`);
}

function processIdentity(pid: number, parentPid: number, label: string): OwnedProcessIdentity {
  return {
    pid,
    parentPid,
    createdAt: new Date(1784300000000 + pid).toISOString(),
    creationToken: String(1784300000000 + pid),
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    commandLine: `powershell -Command ${label} zen-test-${pid}`,
  };
}

function expectation(identity: OwnedProcessIdentity) {
  return {
    pid: identity.pid,
    marker: `zen-test-${identity.pid}`,
    executable: identity.executable ?? '',
  };
}
