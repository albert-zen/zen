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
  const current = await waitForSpawnedIdentity(child.pid, marker, inspect);
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

async function waitForSpawnedIdentity(pid, marker, inspect) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await inspect(pid);
    if (!current || current.commandLine?.includes(marker)) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return inspect(pid);
}

export async function cleanupOwnedManifest({
  manifestPath = defaultManifestPath,
  platform = process.platform,
  list = () => listProcesses(platform),
  terminate = (entry, current) => terminateProcess(entry, platform, current),
  maxPasses = 32,
}) {
  const manifest = createManifestStore(manifestPath);
  let stableZeroScans = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const initial = await manifest.read();
    const processes = await list();
    assertRetainedAncestry(initial.entries, processes);
    const discovered = discoverOwnedCandidates(initial.marker, processes, initial.entries);
    if (discovered.length > 0) await manifest.upsertMany(initial.marker, discovered);

    const snapshot = await manifest.read();
    const validation = validateLiveEntries(snapshot.entries, processes);
    if (validation.invalid.length > 0) {
      throw new Error(`Refusing cleanup: ${validation.invalid.join('; ')}`);
    }

    if (validation.live.length === 0) {
      // A second zero scan closes the root-exit window before the manifest is cleared.
      await assertNoOwnedProcesses({ manifestPath, marker: snapshot.marker, list });
      stableZeroScans += 1;
      if (stableZeroScans >= 2) {
        await manifest.write(emptyManifest(snapshot.marker));
        return;
      }
      continue;
    }
    stableZeroScans = 0;

    // Kill only one deepest exact identity each pass. A rescan before a parent can be
    // stopped discovers descendants created while this leaf was terminating.
    const entry = validation.live.sort(
      (left, right) => right.parentChain.length - left.parentChain.length
    )[0];
    const preKillSnapshot = await list();
    const beforeKill = validateEntry(
      entry,
      preKillSnapshot.find((candidate) => sameProcessIdentity(entry, candidate)),
      preKillSnapshot
    );
    if (!beforeKill.valid) {
      throw new Error(`Refusing cleanup: ${beforeKill.reason}`);
    }
    await terminate(entry, beforeKill.current);
  }

  throw new Error(`Owned cleanup did not reach quiescence after ${maxPasses} passes`);
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
  await terminateProcess(entry, platform, current);
}

export async function assertNoOwnedProcesses({
  manifestPath = defaultManifestPath,
  marker,
  list = () => listProcesses(process.platform),
} = {}) {
  const manifest = await createManifestStore(manifestPath).read();
  const ownerMarker = marker ?? manifest.marker;
  const failures = [];
  const processes = await list();
  for (const entry of manifest.entries) {
    const current = processes.find((candidate) => sameProcessIdentity(entry, candidate));
    if (current && sameProcessIdentity(entry, current))
      failures.push(`manifest identity ${entry.pid} is still live`);
  }
  if (ownerMarker) {
    const marked = processes.filter((candidate) => candidate.commandLine?.includes(ownerMarker));
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
  terminate = (entry, current) => terminateProcess(entry, platform, current),
  signals = process,
  setExitCode,
}) {
  await cleanupStaleManifest({ manifestPath, platform, inspect, list, terminate });
  const manifest = createManifestStore(manifestPath);
  await manifest.write(emptyManifest(marker));

  let child;
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
  const known = new Set(knownEntries.map(identityKey));
  const anchors = knownEntries;
  const children = new Map();
  for (const candidate of processes) {
    const siblings = children.get(candidate.parentPid) ?? [];
    siblings.push(candidate);
    children.set(candidate.parentPid, siblings);
  }
  const discovered = new Map();
  const pending = processes
    .filter((candidate) => candidate.commandLine?.includes(marker))
    .map((candidate) => ({
      candidate,
      rootPid: candidate.pid,
      parentChain: readParentChain(candidate, processes),
    }));

  for (const anchor of anchors) {
    for (const child of children.get(anchor.pid) ?? []) {
      if (!isInHistoricalInterval(child, anchor, processes)) continue;
      pending.push({
        candidate: child,
        rootPid: anchor.rootPid,
        parentChain: [parentIdentity(anchor), ...anchor.parentChain],
      });
    }
  }

  while (pending.length > 0) {
    const { candidate, rootPid, parentChain } = pending.pop();
    const key = identityKey(candidate);
    const previous = discovered.get(key);
    if (previous && previous.parentChain.length >= parentChain.length) continue;
    const entry = {
      ...candidate,
      marker,
      rootPid,
      role: candidate.commandLine?.includes(marker)
        ? 'owned-tree-candidate'
        : 'unverified-ancestry-descendant',
      parentChain,
    };
    discovered.set(key, entry);
    for (const child of children.get(candidate.pid) ?? []) {
      if (!isInHistoricalInterval(child, candidate, processes)) continue;
      pending.push({
        candidate: child,
        rootPid,
        parentChain: [parentIdentity(entry), ...parentChain],
      });
    }
  }

  return [...discovered.values()].filter((candidate) => !known.has(identityKey(candidate)));
}

function assertRetainedAncestry() {
  // Reused historical PIDs are absent owners; exact marker discovery remains independent.
}

function parentIdentity(entry) {
  return { pid: entry.pid, creationToken: creationToken(entry) };
}

function createdAfter(child, parent) {
  const childToken = creationToken(child);
  const parentToken = creationToken(parent);
  return /^\d+$/.test(childToken) && /^\d+$/.test(parentToken)
    ? BigInt(childToken) >= BigInt(parentToken)
    : childToken >= parentToken;
}

function isInHistoricalInterval(child, anchor, processes) {
  if (!createdAfter(child, anchor)) return false;
  const nextReuse = processes
    .filter((candidate) => candidate.pid === anchor.pid && !sameProcessIdentity(candidate, anchor))
    .filter((candidate) => createdAfter(candidate, anchor))
    .sort((left, right) => (createdAfter(left, right) ? 1 : -1))[0];
  return !nextReuse || !createdAfter(child, nextReuse);
}

function readParentChain(current, processes) {
  const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
  const chain = [];
  let parent = byPid.get(current.parentPid);
  while (parent) {
    chain.push({ pid: parent.pid, creationToken: creationToken(parent) });
    parent = byPid.get(parent.parentPid);
  }
  return chain;
}

function validateLiveEntries(entries, processes) {
  const live = [];
  const invalid = [];
  for (const entry of entries) {
    const validation = validateEntry(
      entry,
      processes.find((candidate) => sameProcessIdentity(entry, candidate)),
      processes
    );
    if (!validation.current) continue;
    if (!validation.valid) invalid.push(validation.reason);
    else live.push(entry);
  }
  return { live, invalid };
}

function validateEntry(entry, current, processes) {
  if (!current) return { current: undefined, valid: true };
  if (!isOwnedProcess(entry, current)) {
    return {
      current,
      valid: false,
      reason: `PID ${entry.pid} failed exact owner identity validation`,
    };
  }
  if (!hasStableParentChain(entry.parentChain, readParentChain(current, processes), processes)) {
    return { current, valid: false, reason: `PID ${entry.pid} parent chain changed` };
  }
  return { current, valid: true };
}

function sameProcessIdentity(entry, current) {
  return Boolean(
    current &&
    current.pid === entry.pid &&
    creationToken(current) === creationToken(entry) &&
    current.parentPid === entry.parentPid &&
    current.executable === entry.executable &&
    current.commandLine === entry.commandLine
  );
}

function hasStableParentChain(recorded, actual, processes) {
  if (actual.length > recorded.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (
      actual[index].pid !== recorded[index]?.pid ||
      creationToken(actual[index]) !==
        (recorded[index]?.creationToken ?? recorded[index]?.createdAt)
    ) {
      return false;
    }
  }
  const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
  return recorded.slice(actual.length).every((parent) => !byPid.has(parent.pid));
}

function creationToken(entry) {
  return entry.creationToken ?? entry.createdAt;
}

function identityKey(entry) {
  return [
    entry.pid,
    creationToken(entry),
    entry.executable ?? '',
    entry.commandLine ?? '',
    entry.marker ?? '',
  ].join('|');
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
        entries: [
          ...current.entries.filter((known) => identityKey(known) !== identityKey(entry)),
          entry,
        ],
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

async function terminateProcess(entry, platform, current) {
  if (!isOwnedProcess(entry, current))
    throw new Error(`Refusing to terminate unverified PID ${entry.pid}`);
  if (platform === 'win32') {
    const expected = Buffer.from(JSON.stringify(entry), 'utf8').toString('base64');
    await execFileText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$e=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}'))|ConvertFrom-Json;$p=[Diagnostics.Process]::GetProcessById($e.pid);$ticks=$p.StartTime.ToUniversalTime().Ticks.ToString();$exe=$p.MainModule.FileName;$w=Get-CimInstance Win32_Process -Filter "ProcessId=$($e.pid)";if($ticks -ne $e.creationToken -or $exe -ine $e.executable -or $w.ParentProcessId -ne $e.parentPid -or $w.CommandLine -ne $e.commandLine -or $w.CommandLine -notlike ('*'+$e.marker+'*')){throw 'owned identity mismatch'};$p.Kill();$p.Dispose()`,
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
      'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; createdAt = $_.CreationDate.ToUniversalTime().ToString("o"); creationToken = $_.CreationDate.ToUniversalTime().Ticks.ToString(); executable = $_.ExecutablePath; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress'
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
