import { execFile } from 'node:child_process';

export type OwnedProcessIdentity = {
  readonly pid: number;
  readonly parentPid: number;
  readonly createdAt: string;
  readonly executable: string | null;
  readonly commandLine: string | null;
};

export type OwnedProcessOperations = {
  readonly platform?: NodeJS.Platform;
  readonly list?: () => Promise<readonly OwnedProcessIdentity[]>;
  readonly terminate?: (identity: OwnedProcessIdentity) => Promise<void>;
  readonly maxPasses?: number;
};

export class OwnedProcessCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnedProcessCleanupError';
  }
}

/** Tracks a directly spawned root and only terminates descendants whose full parent chain remains exact. */
export class OwnedProcessTree {
  private root: OwnedProcessIdentity | undefined;
  private cleanupTask: Promise<readonly number[]> | undefined;
  private readonly retained = new Map<string, Candidate>();

  constructor(
    private readonly rootPid: number,
    private readonly operations: OwnedProcessOperations = {}
  ) {}

  async captureRoot(): Promise<void> {
    const root = (await this.list()).find((candidate) => candidate.pid === this.rootPid);
    if (root) this.root = root;
  }

  async terminateVerified(): Promise<readonly number[]> {
    this.cleanupTask ??= this.terminateUntilQuiescent();
    return this.cleanupTask;
  }

  private async terminateUntilQuiescent(): Promise<readonly number[]> {
    const root = this.root;
    if (!root) return [];
    const terminated: number[] = [];
    let stableZeroScans = 0;

    for (let pass = 0; pass < (this.operations.maxPasses ?? 32); pass += 1) {
      const snapshot = await this.list();
      const rootCurrent = snapshot.find((candidate) => candidate.pid === root.pid);
      if (rootCurrent && !sameIdentity(root, rootCurrent)) {
        throw new OwnedProcessCleanupError(
          `Refusing cleanup: root PID ${root.pid} no longer has its recorded identity`
        );
      }
      if (rootCurrent) {
        for (const candidate of descendantsOf(root, snapshot)) {
          this.retained.set(candidateKey(candidate.identity), candidate);
        }
      }

      const live = this.liveRetainedCandidates(snapshot);
      if (live.length === 0) {
        // Two independent zero scans ensure a just-exited root did not leave a late child behind.
        stableZeroScans += 1;
        if (stableZeroScans >= 2) return terminated;
        continue;
      }
      stableZeroScans = 0;

      const candidate = live.sort((left, right) => right.chain.length - left.chain.length)[0];
      const currentProcesses = await this.list();
      const current = currentProcesses.find((process) => process.pid === candidate.identity.pid);
      if (!sameIdentity(candidate.identity, current)) {
        throw new OwnedProcessCleanupError(
          `Refusing cleanup: PID ${candidate.identity.pid} no longer has its recorded identity`
        );
      }
      if (!hasRecordedChain(candidate.chain, current, currentProcesses)) {
        throw new OwnedProcessCleanupError(
          `Refusing cleanup: PID ${candidate.identity.pid} parent chain changed`
        );
      }
      await this.terminate(candidate.identity);
      terminated.push(candidate.identity.pid);
    }

    throw new OwnedProcessCleanupError(
      `Owned process cleanup did not reach quiescence after ${this.operations.maxPasses ?? 32} passes`
    );
  }

  private liveRetainedCandidates(processes: readonly OwnedProcessIdentity[]): Candidate[] {
    const live: Candidate[] = [];
    for (const [key, candidate] of this.retained) {
      const current = processes.find((process) => process.pid === candidate.identity.pid);
      if (!current) {
        this.retained.delete(key);
        continue;
      }
      if (!sameIdentity(candidate.identity, current)) {
        throw new OwnedProcessCleanupError(
          `Refusing cleanup: retained PID ${candidate.identity.pid} was reused`
        );
      }
      if (!hasRecordedChain(candidate.chain, current, processes)) {
        throw new OwnedProcessCleanupError(
          `Refusing cleanup: retained PID ${candidate.identity.pid} parent chain changed`
        );
      }
      live.push(candidate);
    }
    return live;
  }

  private list(): Promise<readonly OwnedProcessIdentity[]> {
    return this.operations.list?.() ?? listWindowsProcesses();
  }

  private terminate(identity: OwnedProcessIdentity): Promise<void> {
    return this.operations.terminate?.(identity) ?? terminateWindowsProcess(identity);
  }
}

type Candidate = {
  readonly identity: OwnedProcessIdentity;
  readonly chain: readonly OwnedProcessIdentity[];
};

function descendantsOf(
  root: OwnedProcessIdentity,
  processes: readonly OwnedProcessIdentity[]
): Candidate[] {
  const byParent = new Map<number, OwnedProcessIdentity[]>();
  for (const process of processes) {
    const children = byParent.get(process.parentPid) ?? [];
    children.push(process);
    byParent.set(process.parentPid, children);
  }
  const candidates: Candidate[] = [];
  const pending: Candidate[] = [{ identity: root, chain: [root] }];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate) continue;
    candidates.push(candidate);
    for (const child of byParent.get(candidate.identity.pid) ?? []) {
      pending.push({ identity: child, chain: [...candidate.chain, child] });
    }
  }
  return candidates;
}

function hasRecordedChain(
  recorded: readonly OwnedProcessIdentity[],
  current: OwnedProcessIdentity | undefined,
  processes: readonly OwnedProcessIdentity[]
): boolean {
  if (!current || !sameIdentity(recorded.at(-1), current)) return false;
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  let cursor = current;
  for (let index = recorded.length - 1; index >= 0; index -= 1) {
    const expected = recorded[index];
    if (!sameIdentity(expected, cursor)) return false;
    if (index > 0) {
      const parent = byPid.get(cursor.parentPid);
      if (!parent) {
        // A recorded ancestor may already have exited. It is still safe only while no
        // PID in the remaining recorded chain has been reused by another process.
        return recorded.slice(0, index).every((ancestor) => !byPid.has(ancestor.pid));
      }
      cursor = parent;
    }
  }
  return true;
}

function candidateKey(identity: OwnedProcessIdentity): string {
  return `${identity.pid}:${identity.createdAt}`;
}

function sameIdentity(
  expected: OwnedProcessIdentity | undefined,
  actual: OwnedProcessIdentity | undefined
): boolean {
  return Boolean(
    expected &&
    actual &&
    expected.pid === actual.pid &&
    expected.parentPid === actual.parentPid &&
    expected.createdAt === actual.createdAt &&
    expected.executable === actual.executable &&
    expected.commandLine === actual.commandLine
  );
}

async function listWindowsProcesses(): Promise<readonly OwnedProcessIdentity[]> {
  if (process.platform !== 'win32') return [];
  const output = await execFileText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; createdAt = $_.CreationDate; executable = $_.ExecutablePath; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress',
  ]);
  if (!output) return [];
  const parsed = JSON.parse(output) as OwnedProcessIdentity | readonly OwnedProcessIdentity[];
  return Array.isArray(parsed) ? parsed : [parsed as OwnedProcessIdentity];
}

async function terminateWindowsProcess(identity: OwnedProcessIdentity): Promise<void> {
  if (process.platform === 'win32') {
    await execFileText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Stop-Process -Id ${identity.pid} -Force -ErrorAction Stop`,
    ]);
    return;
  }
  process.kill(identity.pid, 'SIGTERM');
}

function execFileText(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error?.code === 1) return resolve('');
      if (error) return reject(error);
      resolve(stdout.trim());
    });
  });
}
