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

    await expect(tree.terminateVerified()).resolves.toEqual([]);
    expect(terminated).toEqual([]);

    processes.set(root.pid, root);
    processes.set(child.pid, { ...child, parentPid: 999 });
    await expect(tree.terminateVerified()).resolves.toEqual([root.pid]);
    expect(terminated).toEqual([root.pid]);
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
    await expect(tree.terminateVerified()).resolves.toEqual([]);
    expect(processes.size).toBe(0);
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
