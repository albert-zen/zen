import { describe, expect, it } from 'vitest';

import {
  OwnedProcessTree,
  type OwnedProcessIdentity,
} from '../src/adapters/node/owned-process-cleanup.js';

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
    const tree = new OwnedProcessTree(root.pid, {
      list: async () => [...processes.values()],
      terminate: async (identity) => {
        terminated.push(identity.pid);
        processes.delete(identity.pid);
        return undefined;
      },
    });

    await tree.captureRoot();

    await expect(tree.terminateVerified()).resolves.toEqual([leaf.pid, child.pid, root.pid]);
    expect(terminated).toEqual([leaf.pid, child.pid, root.pid]);
    expect(processes).toEqual(new Map());
  });

  it('refuses PID reuse or a changed ancestor chain without terminating any process', async () => {
    const root = processIdentity(20, 1, 'root');
    const child = processIdentity(21, root.pid, 'child');
    const processes = new Map([
      [root.pid, root],
      [child.pid, child],
    ]);
    const terminated: number[] = [];
    const tree = new OwnedProcessTree(root.pid, {
      list: async () => [...processes.values()],
      terminate: async (identity) => {
        terminated.push(identity.pid);
        return undefined;
      },
    });
    await tree.captureRoot();
    processes.set(root.pid, { ...root, createdAt: 'reused-root' });

    await expect(tree.terminateVerified()).rejects.toThrow(
      'root PID 20 no longer has its recorded identity'
    );
    expect(terminated).toEqual([]);

    expect(processes.get(root.pid)).toEqual({ ...root, createdAt: 'reused-root' });
    expect(processes.get(child.pid)).toEqual(child);
  });

  it('leaves zero tracked residue after timeout and abort cleanup requests', async () => {
    const root = processIdentity(30, 1, 'root');
    const child = processIdentity(31, root.pid, 'child');
    const processes = new Map([
      [root.pid, root],
      [child.pid, child],
    ]);
    const tree = new OwnedProcessTree(root.pid, {
      list: async () => [...processes.values()],
      terminate: async (identity) => {
        processes.delete(identity.pid);
        return undefined;
      },
    });
    await tree.captureRoot();

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
    const tree = new OwnedProcessTree(root.pid, {
      list: async () => [...processes.values()],
      terminate: async (identity) => {
        terminated.push(identity.pid);
        processes.delete(identity.pid);
        if (identity.pid === leaf.pid) processes.set(lateChild.pid, lateChild);
      },
    });
    await tree.captureRoot();

    await expect(tree.terminateVerified()).resolves.toEqual([
      leaf.pid,
      lateChild.pid,
      child.pid,
      root.pid,
    ]);
    expect(terminated).toEqual([leaf.pid, lateChild.pid, child.pid, root.pid]);
  });

  it('propagates a cleanup failure through the one shared cleanup task', async () => {
    const root = processIdentity(50, 1, 'root');
    let terminateCalls = 0;
    const tree = new OwnedProcessTree(root.pid, {
      list: async () => [root],
      terminate: async () => {
        terminateCalls += 1;
        throw new Error('termination provider failed');
      },
    });
    await tree.captureRoot();

    const first = tree.terminateVerified();
    const second = tree.terminateVerified();
    await expect(Promise.all([first, second])).rejects.toThrow('termination provider failed');
    expect(terminateCalls).toBe(1);
  });
});

function processIdentity(pid: number, parentPid: number, label: string): OwnedProcessIdentity {
  return {
    pid,
    parentPid,
    createdAt: `20260717120000.${pid}+000`,
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    commandLine: `powershell -Command ${label}`,
  };
}
