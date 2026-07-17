import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const manifestVersion = 3;
const defaultManifestPath = path.resolve(process.cwd(), '.zen-e2e-owned-processes.json');

export function createRunMarker() {
  return `zen-e2e-${randomUUID()}`;
}

export function isOwnedProcess(entry, current) {
  return Boolean(
    current &&
    current.pid === entry.pid &&
    current.createdAt === entry.createdAt &&
    current.parentPid === entry.parentPid &&
    current.executable === entry.executable &&
    current.commandLine === entry.commandLine &&
    typeof current.commandLine === 'string' &&
    current.commandLine.includes(entry.marker)
  );
}

export async function findOwnedProcesses(
  marker,
  { platform = process.platform, list = () => listProcesses(platform) } = {}
) {
  return (await list()).filter((candidate) => candidate.commandLine?.includes(marker));
}

export async function registerSpawnedProcess({
  child,
  marker,
  rootPid,
  role,
  manifestPath = process.env.ZEN_E2E_MANIFEST_PATH ?? defaultManifestPath,
  platform = process.platform,
  inspect = (pid) => inspectProcess(pid, platform),
  list = () => listProcesses(platform),
}) {
  const current = await inspect(child.pid);
  if (!current || !current.commandLine?.includes(marker)) {
    if (current) {
      const entry = makeEntry(current, marker, rootPid, `unverified-${role}`, await list());
      await createManifestStore(manifestPath).upsert(marker, entry);
    }
    throw new Error(
      `Refusing to register spawned ${role}: its command line lacks owner marker ${marker}`
    );
  }
  const entry = makeEntry(current, marker, rootPid, role, await list());
  await createManifestStore(manifestPath).upsert(marker, entry);
  return entry;
}

export async function cleanupOwnedManifest({
  manifestPath = defaultManifestPath,
  platform = process.platform,
  inspect = (pid) => inspectProcess(pid, platform),
  list = () => listProcesses(platform),
  terminate = (entry) => terminateProcess(entry, platform, inspect),
}) {
  const manifest = createManifestStore(manifestPath);
  const initial = await manifest.read();
  const processes = await list();
  const discovered = discoverOwnedCandidates(initial.marker, processes, initial.entries);
  if (discovered.length > 0) await manifest.upsertMany(initial.marker, discovered);

  const snapshot = await manifest.read();
  const validation = await validateLiveEntries(snapshot.entries, inspect, list);
  if (validation.invalid.length > 0) {
    throw new Error(`Refusing cleanup: ${validation.invalid.join('; ')}`);
  }

  for (const entry of validation.live.sort(
    (left, right) => right.parentChain.length - left.parentChain.length
  )) {
    const beforeKill = await validateEntry(entry, await inspect(entry.pid), await list());
    if (!beforeKill.valid) {
      throw new Error(`Refusing cleanup: ${beforeKill.reason}`);
    }
    await terminate(entry);
  }

  // This independently scans Win32_Process/ps by marker before the manifest can be cleared.
  await assertNoOwnedProcesses({ manifestPath, marker: snapshot.marker, inspect, list });
  await manifest.write(emptyManifest(snapshot.marker));
}

export async function terminateRegisteredProcess(
  entry,
  { platform = process.platform, inspect = (pid) => inspectProcess(pid, platform) } = {}
) {
  const current = await inspect(entry.pid);
  if (!current) return;
  if (!isOwnedProcess(entry, current)) {
    throw new Error(`Refusing to terminate unverified PID ${entry.pid}`);
  }
  await terminateProcess(entry, platform, inspect);
}

export async function assertNoOwnedProcesses({
  manifestPath = defaultManifestPath,
  marker,
  inspect = (pid) => inspectProcess(pid, process.platform),
  list = () => listProcesses(process.platform),
} = {}) {
  const manifest = await createManifestStore(manifestPath).read();
  const ownerMarker = marker ?? manifest.marker;
  const failures = [];
  for (const entry of manifest.entries) {
    const current = await inspect(entry.pid);
    if (current) failures.push(`manifest PID ${entry.pid} is still live or has been reused`);
  }
  if (ownerMarker) {
    const marked = await findOwnedProcesses(ownerMarker, { list });
    if (marked.length > 0)
      failures.push(`independent marker scan found ${marked.length} owned process(es)`);
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
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
  list = () => listProcesses(platform),
  terminate = (entry) => terminateProcess(entry, platform, inspect),
  signals = process,
  setExitCode,
}) {
  await cleanupStaleManifest({ manifestPath, platform, inspect, list, terminate });
  const manifest = createManifestStore(manifestPath);
  await manifest.write(emptyManifest(marker));

  let child;
  let rootEntry;
  let registration;
  let cleanupTask;
  const cleanup = () => {
    if (!child) return Promise.resolve();
    if (cleanupTask) return cleanupTask;
    cleanupTask = (async () => {
      try {
        await registration;
      } catch {
        // Registration retained the live, unverified identity for safe diagnosis.
        return;
      }
      await cleanupOwnedManifest({ manifestPath, platform, inspect, list, terminate });
    })();
    return cleanupTask;
  };
  const handlers = installCleanupHandlers(cleanup, signals, setExitCode);

  try {
    child = spawnCommand(command, args, {
      cwd,
      detached: false,
      env: { ...process.env, ZEN_E2E_MANIFEST_PATH: manifestPath, ZEN_E2E_RUN_MARKER: marker },
      stdio,
    });
    const childResult = waitForChild(child);
    registration = registerSpawnedProcess({
      child,
      marker,
      rootPid: child.pid,
      role: 'runner-root',
      manifestPath,
      platform,
      inspect,
      list,
    }).then((entry) => {
      rootEntry = entry;
      return entry;
    });
    await registration;
    if (cleanupTask) {
      await cleanup();
      return { ...(await childResult), marker };
    }
    const result = await childResult;
    await cleanup();
    return { ...result, marker };
  } catch (cause) {
    try {
      await cleanup();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'Owned E2E command and cleanup both failed', {
        cause: cleanupCause,
      });
    }
    throw cause;
  } finally {
    handlers.dispose();
  }
}

function makeEntry(current, marker, rootPid, role, processes) {
  return {
    ...current,
    marker,
    rootPid,
    role,
    parentChain: readParentChain(current, processes),
  };
}

function discoverOwnedCandidates(marker, processes, knownEntries) {
  if (!marker) return [];
  const known = new Set(knownEntries.map((entry) => entry.pid));
  const children = new Map();
  for (const candidate of processes) {
    const siblings = children.get(candidate.parentPid) ?? [];
    siblings.push(candidate);
    children.set(candidate.parentPid, siblings);
  }
  const discovered = new Map();
  const pending = processes
    .filter((candidate) => candidate.commandLine?.includes(marker))
    .map((candidate) => ({ candidate, rootPid: candidate.pid }));

  while (pending.length > 0) {
    const { candidate, rootPid } = pending.pop();
    if (discovered.has(candidate.pid)) continue;
    discovered.set(
      candidate.pid,
      makeEntry(candidate, marker, rootPid, 'owned-tree-candidate', processes)
    );
    for (const child of children.get(candidate.pid) ?? [])
      pending.push({ candidate: child, rootPid });
  }

  return [...discovered.values()].filter((candidate) => !known.has(candidate.pid));
}

function readParentChain(current, processes) {
  const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
  const chain = [];
  let parent = byPid.get(current.parentPid);
  while (parent) {
    chain.push({ pid: parent.pid, createdAt: parent.createdAt });
    parent = byPid.get(parent.parentPid);
  }
  return chain;
}

async function validateLiveEntries(entries, inspect, list) {
  const live = [];
  const invalid = [];
  for (const entry of entries) {
    const validation = await validateEntry(entry, await inspect(entry.pid), await list());
    if (!validation.current) continue;
    if (!validation.valid) invalid.push(validation.reason);
    else live.push(entry);
  }
  return { live, invalid };
}

async function validateEntry(entry, current, processes) {
  if (!current) return { current: false, valid: true };
  if (!isOwnedProcess(entry, current)) {
    return {
      current: true,
      valid: false,
      reason: `PID ${entry.pid} failed exact owner identity validation`,
    };
  }
  if (!hasStableParentChain(entry.parentChain, readParentChain(current, processes), processes)) {
    return { current: true, valid: false, reason: `PID ${entry.pid} parent chain changed` };
  }
  return { current: true, valid: true };
}

function hasStableParentChain(recorded, actual, processes) {
  if (actual.length > recorded.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (
      actual[index].pid !== recorded[index]?.pid ||
      actual[index].createdAt !== recorded[index]?.createdAt
    ) {
      return false;
    }
  }
  const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
  return recorded.slice(actual.length).every((parent) => !byPid.has(parent.pid));
}

async function cleanupStaleManifest(operations) {
  const snapshot = await createManifestStore(operations.manifestPath).read();
  if (snapshot.entries.length > 0) await cleanupOwnedManifest(operations);
}

export function installCleanupHandlers(
  cleanup,
  signals = process,
  setExitCode = (code) => {
    process.exitCode = code;
  }
) {
  let handling = false;
  const handleSignal = (signal) => {
    if (handling) return;
    handling = true;
    void cleanup().finally(() => {
      setExitCode(signal === 'SIGINT' ? 130 : 143);
    });
  };
  const handleException = (cause) => {
    if (handling) return;
    handling = true;
    void cleanup().finally(() =>
      process.nextTick(() => {
        throw cause;
      })
    );
  };
  const onInterrupt = () => handleSignal('SIGINT');
  const onTerminate = () => handleSignal('SIGTERM');
  signals.once('SIGINT', onInterrupt);
  signals.once('SIGTERM', onTerminate);
  signals.once('uncaughtException', handleException);
  signals.once('unhandledRejection', handleException);
  return {
    dispose() {
      signals.removeListener('SIGINT', onInterrupt);
      signals.removeListener('SIGTERM', onTerminate);
      signals.removeListener('uncaughtException', handleException);
      signals.removeListener('unhandledRejection', handleException);
    },
  };
}

function createManifestStore(manifestPath) {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        return parsed?.version === manifestVersion && Array.isArray(parsed.entries)
          ? parsed
          : emptyManifest();
      } catch (cause) {
        if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return emptyManifest();
        throw cause;
      }
    },
    async write(value) {
      const temporary = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
      await fs.rename(temporary, manifestPath);
    },
    async upsert(marker, entry) {
      const current = await this.read();
      if (current.marker && current.marker !== marker)
        throw new Error('Manifest belongs to another run');
      await this.write({
        version: manifestVersion,
        marker,
        entries: [...current.entries.filter((known) => known.pid !== entry.pid), entry],
      });
    },
    async upsertMany(marker, entries) {
      for (const entry of entries) await this.upsert(marker, entry);
    },
  };
}

function emptyManifest(marker) {
  return { version: manifestVersion, marker, entries: [] };
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal }));
  });
}

async function terminateProcess(entry, platform, inspect) {
  const current = await inspect(entry.pid);
  if (!isOwnedProcess(entry, current))
    throw new Error(`Refusing to terminate unverified PID ${entry.pid}`);
  if (platform === 'win32') {
    await execFileText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Stop-Process -Id ${entry.pid} -Force -ErrorAction Stop`,
    ]);
    return;
  }
  process.kill(entry.pid, 'SIGTERM');
}

async function inspectProcess(pid, platform) {
  return (await listProcesses(platform)).find((candidate) => candidate.pid === pid);
}

async function listProcesses(platform) {
  if (platform === 'win32') {
    const output = await powershellJson(
      'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; createdAt = $_.CreationDate; executable = $_.ExecutablePath; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress'
    );
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const output = await execFileText('ps', ['-eo', 'pid=,ppid=,lstart=,comm=,args=']);
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.*)$/);
    return match
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            createdAt: match[3].trim(),
            executable: match[4],
            commandLine: match[5],
          },
        ]
      : [];
  });
}

function powershellJson(script) {
  return execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error?.code === 1) return resolve('');
      if (error) return reject(error);
      resolve(stdout.trim());
    });
  });
}
