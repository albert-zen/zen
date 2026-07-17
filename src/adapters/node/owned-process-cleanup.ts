import { execFile } from 'node:child_process';

export type OwnedProcessIdentity = {
  readonly pid: number;
  readonly parentPid: number;
  readonly createdAt: string;
  readonly creationToken: string;
  readonly executable: string | null;
  readonly commandLine: string | null;
};

export type OwnedProcessOperations = {
  readonly platform?: NodeJS.Platform;
  readonly list?: () => Promise<readonly OwnedProcessIdentity[]>;
  readonly terminate?: (identity: OwnedProcessIdentity) => Promise<void>;
  readonly maxPasses?: number;
};
export type OwnedProcessRootExpectation = {
  readonly pid: number;
  readonly marker: string;
  readonly executable: string;
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
  /** Historical identities remain ancestry anchors until cleanup reaches its terminal decision. */
  private readonly ancestry = new Map<string, Candidate>();

  constructor(
    private readonly expectation: OwnedProcessRootExpectation,
    private readonly operations: OwnedProcessOperations = {}
  ) {}

  captureAttested(root: OwnedProcessIdentity): boolean {
    if (
      root.pid !== this.expectation.pid ||
      !sameExecutable(root.executable, this.expectation.executable) ||
      !root.commandLine?.includes(this.expectation.marker)
    )
      return false;
    this.root = root;
    this.ancestry.set(candidateKey(root), { identity: root, chain: [root] });
    return true;
  }

  async terminateVerified(): Promise<readonly number[]> {
    this.cleanupTask ??= this.terminateUntilQuiescent();
    return this.cleanupTask;
  }

  private async terminateUntilQuiescent(): Promise<readonly number[]> {
    const root = this.root;
    if (!root) {
      throw new OwnedProcessCleanupError(
        `Refusing cleanup: root PID ${this.expectation.pid} was not captured before it exited`
      );
    }
    const terminated: number[] = [];
    let stableZeroScans = 0;

    for (let pass = 0; pass < (this.operations.maxPasses ?? 32); pass += 1) {
      const snapshot = await this.list();
      this.discoverDescendants(snapshot);

      const live = this.liveAncestryCandidates(snapshot);
      if (live.length === 0) {
        // Two independent zero scans ensure a just-exited root did not leave a late child behind.
        stableZeroScans += 1;
        if (stableZeroScans >= 2) return terminated;
        continue;
      }
      stableZeroScans = 0;

      const candidate = live.sort((left, right) => right.chain.length - left.chain.length)[0];
      const currentProcesses = await this.list();
      const current = currentProcesses.find((process) => sameIdentity(candidate.identity, process));
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

  private discoverDescendants(processes: readonly OwnedProcessIdentity[]): void {
    const byParent = new Map<number, OwnedProcessIdentity[]>();
    for (const process of processes) {
      const children = byParent.get(process.parentPid) ?? [];
      children.push(process);
      byParent.set(process.parentPid, children);
    }

    const pending = [...this.ancestry.values()];
    while (pending.length > 0) {
      const parent = pending.pop();
      if (!parent) continue;
      for (const child of byParent.get(parent.identity.pid) ?? []) {
        if (!createdAfter(child, parent.identity)) continue;
        const holder = processes.find((process) => process.pid === parent.identity.pid);
        if (holder && !sameIdentity(holder, parent.identity) && !createdBefore(child, holder))
          continue;
        const existing = this.ancestry.get(candidateKey(child));
        if (existing) {
          continue;
        }
        const discovered = { identity: child, chain: [...parent.chain, child] };
        this.ancestry.set(candidateKey(child), discovered);
        pending.push(discovered);
      }
    }
  }

  private liveAncestryCandidates(processes: readonly OwnedProcessIdentity[]): Candidate[] {
    const live: Candidate[] = [];
    for (const candidate of this.ancestry.values()) {
      const current = processes.find((process) => sameIdentity(candidate.identity, process));
      if (!current) continue;
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

function hasRecordedChain(
  recorded: readonly OwnedProcessIdentity[],
  current: OwnedProcessIdentity | undefined,
  processes: readonly OwnedProcessIdentity[]
): boolean {
  if (!current || !sameIdentity(recorded.at(-1), current)) return false;
  let cursor = current;
  for (let index = recorded.length - 1; index >= 0; index -= 1) {
    const expected = recorded[index];
    if (!sameIdentity(expected, cursor)) return false;
    if (index > 0) {
      const parent = recorded[index - 1];
      if (cursor.parentPid !== parent.pid || !createdAfter(cursor, parent)) return false;
      const holder = processes.find((process) => process.pid === parent.pid);
      if (holder && !sameIdentity(holder, parent) && !createdBefore(cursor, holder)) return false;
      cursor = parent;
    }
  }
  return true;
}

function createdAfter(child: OwnedProcessIdentity, parent: OwnedProcessIdentity): boolean {
  return BigInt(child.creationToken) >= BigInt(parent.creationToken);
}

function createdBefore(child: OwnedProcessIdentity, parent: OwnedProcessIdentity): boolean {
  return BigInt(child.creationToken) < BigInt(parent.creationToken);
}

function candidateKey(identity: OwnedProcessIdentity): string {
  return `${identity.pid}:${identity.creationToken}:${identity.executable}:${identity.commandLine}`;
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
    expected.creationToken === actual.creationToken &&
    sameExecutable(expected.executable, actual.executable) &&
    expected.commandLine === actual.commandLine
  );
}

function sameExecutable(left: string | null, right: string | null): boolean {
  return (left ?? '').toLowerCase() === (right ?? '').toLowerCase();
}

async function listWindowsProcesses(): Promise<readonly OwnedProcessIdentity[]> {
  if (process.platform !== 'win32') return [];
  const output = await execFileText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; createdAt = $_.CreationDate.ToUniversalTime().ToString("o"); creationToken = $_.CreationDate.ToUniversalTime().Ticks.ToString(); executable = $_.ExecutablePath; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress',
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
