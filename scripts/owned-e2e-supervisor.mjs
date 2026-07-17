import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const manifestVersion = 2;
const defaultManifestPath = path.resolve(process.cwd(), '.zen-e2e-owned-processes.json');

export function createRunMarker() {
  return `zen-e2e-${randomUUID()}`;
}

export function isOwnedProcess(entry, current) {
  if (!current || current.pid !== entry.pid || current.createdAt !== entry.createdAt) return false;
  if (entry.parentPid !== undefined && current.parentPid !== entry.parentPid) return false;
  if (entry.executable && current.executable !== entry.executable) return false;
  if (entry.commandLine && current.commandLine !== entry.commandLine) return false;
  return !entry.requiresMarker || current.commandLine.includes(entry.marker);
}

export async function registerCurrentOwnedProcess({
  role,
  marker = process.env.ZEN_E2E_RUN_MARKER,
  manifestPath = process.env.ZEN_E2E_MANIFEST_PATH ?? defaultManifestPath,
  rootPid = readRootPid(process.env.ZEN_E2E_ROOT_PID),
  platform = process.platform,
}) {
  if (!marker || !rootPid) return undefined;
  const identity = await inspectProcess(process.pid, platform);
  if (!identity) throw new Error(`Unable to identify current owned ${role} process`);
  const entry = toEntry(identity, { marker, rootPid, role, requiresMarker: false });
  await createManifestStore(manifestPath).upsert(marker, entry);
  return entry;
}

export async function registerSpawnedProcess({
  child,
  marker,
  rootPid,
  role,
  manifestPath = process.env.ZEN_E2E_MANIFEST_PATH ?? defaultManifestPath,
  platform = process.platform,
  inspect = (pid) => inspectProcess(pid, platform),
}) {
  const identity = await inspect(child.pid);
  if (!identity) {
    await terminateLiveChild(child);
    throw new Error(`Unable to register spawned ${role} process ${child.pid}`);
  }
  const entry = toEntry(identity, { marker, rootPid, role, requiresMarker: true });
  if (!identity.commandLine.includes(marker)) {
    await terminateLiveChild(child);
    throw new Error(`Spawned ${role} process ${child.pid} is missing its ownership marker`);
  }
  await createManifestStore(manifestPath).upsert(marker, entry);
  return entry;
}

export async function cleanupOwnedManifest({
  manifestPath = defaultManifestPath,
  platform = process.platform,
  inspect = (pid) => inspectProcess(pid, platform),
  list = () => listProcesses(platform),
  terminate = (entry) => terminateProcessTree(entry, platform),
}) {
  const manifest = createManifestStore(manifestPath);
  const snapshot = await manifest.read();
  const failures = [];

  for (const rootPid of unique(snapshot.entries.map((entry) => entry.rootPid))) {
    const entries = snapshot.entries.filter((entry) => entry.rootPid === rootPid);
    const root = entries.find((entry) => entry.pid === rootPid);
    const rootCurrent = root ? await inspect(root.pid) : undefined;

    if (!root || !isOwnedProcess(root, rootCurrent)) {
      const live = await findLiveEntries(entries, inspect);
      const unsafe = [];
      for (const entry of live) {
        if (!entry.requiresMarker || !isOwnedProcess(entry, await inspect(entry.pid))) {
          unsafe.push(entry);
        }
      }
      if (unsafe.length > 0) {
        failures.push(
          `Owned root ${rootPid} is absent or unverified while ${unsafe.length} unverified child entries remain`
        );
        continue;
      }
      for (const entry of topLevelEntries(live)) await terminate(entry);
      continue;
    }

    const discovered = await collectOwnedTree(root, await list());
    if (discovered.length > 0) {
      await manifest.upsertMany(snapshot.marker, discovered);
      entries.push(...discovered.filter((entry) => !entries.some((known) => known.pid === entry.pid)));
    }

    // Windows taskkill /T is only reached after this exact root identity and marker check.
    await terminate(root);
    const live = await findLiveEntries(entries, inspect);
    if (live.length > 0) {
      failures.push(`Owned root ${rootPid} still has ${live.length} live verified process entries`);
    }
  }

  const latest = await manifest.read();
  const survivors = [];
  for (const entry of latest.entries) {
    const current = await inspect(entry.pid);
    if (!current) continue;
    if (!isOwnedProcess(entry, current)) {
      failures.push(`Process ${entry.pid} no longer matches its recorded ownership identity`);
    }
    survivors.push(entry);
  }

  if (failures.length > 0 || survivors.length > 0) {
    throw new Error([...failures, `Manifest retains ${survivors.length} live or unverified entry(ies)`].join('; '));
  }
  await manifest.write(emptyManifest(latest.marker));
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
  terminate = (entry) => terminateProcessTree(entry, platform),
}) {
  const manifest = createManifestStore(manifestPath);
  await cleanupStaleManifest({ manifestPath, platform, inspect, list, terminate });
  await manifest.write(emptyManifest(marker));

  let child;
  let rootEntry;
  let childResult;
  let cleanupStarted = false;
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (rootEntry) {
      await cleanupOwnedManifest({ manifestPath, platform, inspect, list, terminate });
      return;
    }
    if (child) await terminateLiveChild(child);
  };
  const handlers = installCleanupHandlers(cleanup);

  try {
    child = spawnCommand(command, args, {
      cwd,
      detached: platform !== 'win32',
      env: {
        ...process.env,
        ZEN_E2E_MANIFEST_PATH: manifestPath,
        ZEN_E2E_ROOT_PID: String(child?.pid ?? ''),
        ZEN_E2E_RUN_MARKER: marker,
      },
      stdio,
    });
    // spawn options are evaluated before child exists; establish root relation immediately afterward.
    childResult = waitForChild(child);
    const identity = await inspect(child.pid);
    if (!identity) {
      if (child.exitCode === null) await terminateLiveChild(child);
      return { ...(await childResult), marker };
    }
    rootEntry = toEntry(identity, {
      marker,
      rootPid: child.pid,
      role: 'runner-root',
      requiresMarker: true,
    });
    if (!identity.commandLine.includes(marker)) {
      await terminateLiveChild(child);
      throw new Error(`Owned runner child ${child.pid} is missing its command marker`);
    }
    await manifest.upsert(marker, rootEntry);
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

export async function assertNoOwnedProcesses(manifestPath = defaultManifestPath) {
  const manifest = await createManifestStore(manifestPath).read();
  if (manifest.entries.length > 0) {
    throw new Error(`Zen E2E manifest retains ${manifest.entries.length} owned process entry(ies)`);
  }
}

async function cleanupStaleManifest(operations) {
  const manifest = createManifestStore(operations.manifestPath);
  const snapshot = await manifest.read();
  if (snapshot.entries.length === 0) return;
  await cleanupOwnedManifest(operations);
}

function installCleanupHandlers(cleanup) {
  let handling = false;
  const handleSignal = (signal) => {
    if (handling) return;
    handling = true;
    void cleanup().finally(() => {
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
    });
  };
  const handleException = (cause) => {
    if (handling) return;
    handling = true;
    void cleanup().finally(() => {
      process.nextTick(() => {
        throw cause;
      });
    });
  };
  const onInterrupt = () => handleSignal('SIGINT');
  const onTerminate = () => handleSignal('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  process.once('uncaughtException', handleException);
  process.once('unhandledRejection', handleException);
  return {
    dispose() {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      process.removeListener('uncaughtException', handleException);
      process.removeListener('unhandledRejection', handleException);
    },
  };
}

function toEntry(identity, options) {
  return {
    ...identity,
    marker: options.marker,
    rootPid: options.rootPid,
    role: options.role,
    requiresMarker: options.requiresMarker,
  };
}

async function collectOwnedTree(root, processes) {
  const byParent = new Map();
  processes.forEach((candidate) => {
    const children = byParent.get(candidate.parentPid) ?? [];
    children.push(candidate);
    byParent.set(candidate.parentPid, children);
  });
  const discovered = [];
  const pending = [...(byParent.get(root.pid) ?? [])];
  while (pending.length > 0) {
    const child = pending.shift();
    discovered.push(
      toEntry(child, {
        marker: root.marker,
        rootPid: root.rootPid,
        role: 'discovered-child',
        requiresMarker: child.commandLine.includes(root.marker),
      })
    );
    pending.push(...(byParent.get(child.pid) ?? []));
  }
  return discovered;
}

async function findLiveEntries(entries, inspect) {
  const live = [];
  for (const entry of entries) {
    const current = await inspect(entry.pid);
    if (current) live.push(entry);
  }
  return live;
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
      if (current.marker && current.marker !== marker) {
        throw new Error('Owned E2E manifest belongs to a different active run');
      }
      const entries = current.entries.filter((known) => known.pid !== entry.pid);
      entries.push(entry);
      await this.write({ version: manifestVersion, marker, entries });
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

async function terminateLiveChild(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await waitForChild(child);
}

async function inspectProcess(pid, platform) {
  if (platform === 'win32') {
    const output = await powershellJson(
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $process) { [PSCustomObject]@{ pid = $process.ProcessId; parentPid = $process.ParentProcessId; createdAt = $process.CreationDate; executable = $process.ExecutablePath; commandLine = $process.CommandLine } | ConvertTo-Json -Compress }`
    );
    return output ? JSON.parse(output) : undefined;
  }
  return (await listProcesses(platform)).find((candidate) => candidate.pid === pid);
}

async function listProcesses(platform) {
  if (platform === 'win32') {
    const output = await powershellJson(
      'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; createdAt = $_.CreationDate; executable = $_.ExecutablePath; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress'
    );
    if (!output) return [];
    return Array.isArray(JSON.parse(output)) ? JSON.parse(output) : [JSON.parse(output)];
  }
  const output = await execFileText('ps', ['-eo', 'pid=,ppid=,lstart=,comm=,args=']);
  return output
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.*)$/);
      return match
        ? [{ pid: Number(match[1]), parentPid: Number(match[2]), createdAt: match[3].trim(), executable: match[4], commandLine: match[5] }]
        : [];
    });
}

async function terminateProcessTree(entry, platform) {
  if (platform === 'win32') {
    const current = await inspectProcess(entry.pid, platform);
    if (!isOwnedProcess(entry, current)) {
      throw new Error(`Refusing taskkill for unverified owned root ${entry.pid}`);
    }
    await execFileText('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F']);
    return;
  }
  process.kill(-entry.pid, 'SIGTERM');
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

function readRootPid(value) {
  const rootPid = Number(value);
  return Number.isInteger(rootPid) && rootPid > 0 ? rootPid : undefined;
}

function unique(values) {
  return [...new Set(values)];
}

function topLevelEntries(entries) {
  const pids = new Set(entries.map((entry) => entry.pid));
  return entries.filter((entry) => !pids.has(entry.parentPid));
}
