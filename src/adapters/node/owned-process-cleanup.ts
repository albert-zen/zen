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
};

/** Tracks a directly spawned root and only terminates descendants whose full parent chain remains exact. */
export class OwnedProcessTree {
  private root: OwnedProcessIdentity | undefined;

  constructor(
    private readonly rootPid: number,
    private readonly operations: OwnedProcessOperations = {}
  ) {}

  async captureRoot(): Promise<void> {
    const root = (await this.list()).find((candidate) => candidate.pid === this.rootPid);
    if (root) this.root = root;
  }

  async terminateVerified(): Promise<readonly number[]> {
    const root = this.root;
    if (!root) return [];
    const snapshot = await this.list();
    const rootCurrent = snapshot.find((candidate) => candidate.pid === root.pid);
    if (!sameIdentity(root, rootCurrent)) return [];

    const candidates = descendantsOf(root, snapshot);
    const terminated: number[] = [];
    for (const candidate of candidates.sort(
      (left, right) => right.chain.length - left.chain.length
    )) {
      const current = (await this.list()).find((process) => process.pid === candidate.identity.pid);
      if (!sameIdentity(candidate.identity, current)) continue;
      const currentProcesses = await this.list();
      if (!hasExactChain(candidate.chain, current, currentProcesses)) continue;
      await this.terminate(candidate.identity);
      terminated.push(candidate.identity.pid);
    }
    return terminated;
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

function hasExactChain(
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
      if (!parent) return false;
      cursor = parent;
    }
  }
  return true;
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
