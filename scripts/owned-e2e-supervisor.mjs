import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const manifestVersion = 1;
const defaultManifestPath = path.resolve(process.cwd(), '.zen-e2e-owned-processes.json');

export function createRunMarker() {
  return `zen-e2e-${randomUUID()}`;
}

export function isOwnedProcess(entry, current) {
  if (!current || current.pid !== entry.pid || !current.commandLine.includes(entry.marker)) {
    return false;
  }

  return entry.platform !== 'win32' || current.createdAt === entry.createdAt;
}

export async function cleanupOwnedEntries(entries, operations) {
  const results = [];

  for (const entry of entries) {
    const current = await operations.inspect(entry.pid);
    if (!isOwnedProcess(entry, current)) {
      results.push({ entry, status: 'not-owned' });
      continue;
    }

    await operations.terminate(entry);
    const remaining = await waitForExit(entry, operations);
    results.push({ entry, status: remaining ? 'remaining' : 'terminated' });
  }

  return results;
}

export async function runOwnedCommand({
  command,
  args,
  cwd = process.cwd(),
  marker = createRunMarker(),
  manifestPath = defaultManifestPath,
  platform = process.platform,
  stdio = 'inherit',
  spawnCommand = spawn,
  inspect = (pid) => inspectProcess(pid, platform),
  terminate = (entry) => terminateProcessTree(entry, platform),
}) {
  const manifest = createManifestStore(manifestPath);
  const preflight = await manifest.read();
  const staleResults = await cleanupOwnedEntries(preflight.entries, { inspect, terminate });
  const staleRemaining = staleResults.filter((result) => result.status === 'remaining');
  if (staleRemaining.length > 0) {
    throw new Error(
      `Unable to clean ${staleRemaining.length} verified stale Zen E2E process tree(s)`
    );
  }
  await manifest.write({ version: manifestVersion, entries: [] });

  const child = spawnCommand(command, args, {
    cwd,
    detached: platform !== 'win32',
    env: { ...process.env, ZEN_E2E_RUN_MARKER: marker },
    stdio,
  });
  const childResult = waitForChild(child);
  let childExited = false;
  void childResult.finally(() => {
    childExited = true;
  });
  const identity = await waitForProcessIdentity(child.pid, marker, inspect, () => childExited);
  if (!identity) {
    const result = await childResult;
    return { ...result, marker, staleResults };
  }

  const entry = {
    pid: child.pid,
    marker,
    createdAt: identity.createdAt,
    platform,
  };
  await manifest.write({ version: manifestVersion, entries: [entry] });

  let receivedSignal;
  const signalHandlers = ['SIGINT', 'SIGTERM'].map((signal) => {
    const handler = () => {
      receivedSignal ??= signal;
      void cleanupOwnedEntries([entry], { inspect, terminate });
    };
    process.once(signal, handler);
    return { signal, handler };
  });

  let result;
  let cleanupError;
  try {
    result = await childResult;
  } finally {
    signalHandlers.forEach(({ signal, handler }) => process.removeListener(signal, handler));
    const cleanupResults = await cleanupOwnedEntries([entry], { inspect, terminate });
    const remaining = cleanupResults.filter((cleanup) => cleanup.status === 'remaining');
    await manifest.write({ version: manifestVersion, entries: [] });
    if (remaining.length > 0) {
      cleanupError = new Error(
        `Zen E2E runner left ${remaining.length} owned process tree(s) alive`
      );
    }
  }

  if (cleanupError) throw cleanupError;
  return {
    ...result,
    exitCode: receivedSignal ? 128 + signalNumber(receivedSignal) : result.exitCode,
    marker,
    staleResults,
  };
}

export async function assertNoOwnedProcesses(
  manifestPath = defaultManifestPath,
  platform = process.platform
) {
  const manifest = createManifestStore(manifestPath);
  const entries = (await manifest.read()).entries;
  const remaining = [];
  for (const entry of entries) {
    const current = await inspectProcess(entry.pid, platform);
    if (isOwnedProcess(entry, current)) remaining.push(entry);
  }
  if (remaining.length > 0) {
    throw new Error(`Zen E2E manifest still owns ${remaining.length} live process tree(s)`);
  }
}

function createManifestStore(manifestPath) {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        return parsed?.version === manifestVersion && Array.isArray(parsed.entries)
          ? parsed
          : { version: manifestVersion, entries: [] };
      } catch (cause) {
        if (cause && typeof cause === 'object' && cause.code === 'ENOENT') {
          return { version: manifestVersion, entries: [] };
        }
        throw cause;
      }
    },
    async write(value) {
      await fs.writeFile(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

async function waitForProcessIdentity(pid, marker, inspect, hasExited) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await inspect(pid);
    if (current?.commandLine.includes(marker)) return current;
    if (hasExited()) return undefined;
    await delay(10);
  }
  return undefined;
}

async function waitForExit(entry, operations) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await operations.inspect(entry.pid);
    if (!isOwnedProcess(entry, current)) return false;
    await delay(20);
  }
  return true;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal }));
  });
}

async function inspectProcess(pid, platform) {
  if (platform === 'win32') {
    const script = [
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      'if ($null -ne $process) {',
      '  [PSCustomObject]@{ pid = $process.ProcessId; createdAt = $process.CreationDate; commandLine = $process.CommandLine } | ConvertTo-Json -Compress',
      '}',
    ].join('; ');
    const output = await execFileText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    return output ? JSON.parse(output) : undefined;
  }

  const output = await execFileText('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'args=']);
  if (!output) return undefined;
  const separator = output.trim().match(/^(.*?)\s{2,}(.*)$/);
  if (!separator) return undefined;
  return { pid, createdAt: separator[1], commandLine: separator[2] };
}

async function terminateProcessTree(entry, platform) {
  if (platform === 'win32') {
    await execFileText('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F']);
    return;
  }

  process.kill(-entry.pid, 'SIGTERM');
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error?.code === 1) {
        resolve('');
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function signalNumber(signal) {
  return signal === 'SIGINT' ? 2 : 15;
}
