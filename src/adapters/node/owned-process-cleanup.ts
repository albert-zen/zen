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
  /** One coherent helper invocation can provide the discovery and pre-kill views. */
  readonly snapshots?: () => Promise<
    readonly [readonly OwnedProcessIdentity[], readonly OwnedProcessIdentity[]]
  >;
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
      !Number.isSafeInteger(root.pid) ||
      !Number.isSafeInteger(root.parentPid) ||
      !root.createdAt ||
      Number.isNaN(Date.parse(root.createdAt)) ||
      !/^\d+$/.test(root.creationToken) ||
      !root.executable ||
      !root.commandLine ||
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
      const [snapshot, currentProcesses] = await this.snapshots();
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

  private snapshots(): Promise<
    readonly [readonly OwnedProcessIdentity[], readonly OwnedProcessIdentity[]]
  > {
    if (this.operations.snapshots) return this.operations.snapshots();
    if (!this.operations.list) return listWindowsProcessSnapshots();
    return Promise.all([this.list(), this.list()]);
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
    'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; createdAt = $_.CreationDate.ToUniversalTime().ToString("o"); creationToken = ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds().ToString(); executable = $_.ExecutablePath; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress',
  ]);
  if (!output) return [];
  const parsed = JSON.parse(output) as OwnedProcessIdentity | readonly OwnedProcessIdentity[];
  return Array.isArray(parsed) ? parsed : [parsed as OwnedProcessIdentity];
}

async function listWindowsProcessSnapshots(): Promise<
  readonly [readonly OwnedProcessIdentity[], readonly OwnedProcessIdentity[]]
> {
  if (process.platform !== 'win32') return [[], []];
  const command =
    '$one=Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; createdAt = $_.CreationDate.ToUniversalTime().ToString("o"); creationToken = ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds().ToString(); executable = $_.ExecutablePath; commandLine = $_.CommandLine } };$two=Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; createdAt = $_.CreationDate.ToUniversalTime().ToString("o"); creationToken = ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds().ToString(); executable = $_.ExecutablePath; commandLine = $_.CommandLine } };[PSCustomObject]@{ first=@($one); second=@($two) } | ConvertTo-Json -Compress';
  const output = await execFileText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ]);
  if (!output) return [[], []];
  const parsed = JSON.parse(output) as {
    first?: OwnedProcessIdentity | readonly OwnedProcessIdentity[];
    second?: OwnedProcessIdentity | readonly OwnedProcessIdentity[];
  };
  const normalize = (value: OwnedProcessIdentity | readonly OwnedProcessIdentity[] | undefined) =>
    !value ? [] : Array.isArray(value) ? value : [value];
  return [normalize(parsed.first), normalize(parsed.second)];
}

async function terminateWindowsProcess(identity: OwnedProcessIdentity): Promise<void> {
  if (process.platform === 'win32') {
    const expected = Buffer.from(JSON.stringify(identity), 'utf8').toString('base64');
    await execFileStrict('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$e=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}'))|ConvertFrom-Json;$p=[Diagnostics.Process]::GetProcessById($e.pid);try{$token=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds().ToString();$exe=$p.MainModule.FileName;$w=Get-CimInstance Win32_Process -Filter "ProcessId=$($e.pid)";$bad=@();if($token -ne $e.creationToken){$bad+='creationToken'};if($exe -ine $e.executable){$bad+='executable'};if($w.ParentProcessId -ne $e.parentPid){$bad+='parentPid'};if($w.CommandLine -ne $e.commandLine){$bad+='commandLine'};if($bad.Count){throw ('owned identity mismatch: '+($bad -join ','))};$p.Kill()}finally{$p.Dispose()}`,
    ]);
    return;
  }
  process.kill(identity.pid, 'SIGTERM');
}

/** Internal test seam; deliberately not re-exported by package entrypoints. */
export const ownedProcessTesting = {
  terminateWindowsProcess,
  listWindowsProcesses,
  listWindowsProcessSnapshots,
};

function execFileText(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error?.code === 1) return resolve('');
      if (error) return reject(error);
      resolve(stdout.trim());
    });
  });
}

function execFileStrict(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout.trim());
    });
  });
}
