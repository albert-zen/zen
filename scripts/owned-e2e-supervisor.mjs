import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const manifestVersion = 5;
const defaultManifestPath = path.resolve(process.cwd(), '.zen-e2e-owned-processes.json');

export function createRunMarker() {
  return `zen-e2e-${randomUUID()}`;
}

export function isOwnedProcess(entry, current) {
  return Boolean(
    current &&
    current.pid === entry.pid &&
    creationToken(current) === creationToken(entry) &&
    current.parentPid === entry.parentPid &&
    current.executable === entry.executable &&
    current.commandLine === entry.commandLine &&
    typeof entry.marker === 'string' &&
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
  retainLedger = false,
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
      const afterScan = await manifest.read();
      if (afterScan.revision !== snapshot.revision) {
        stableZeroScans = 0;
        continue;
      }
      stableZeroScans += 1;
      if (stableZeroScans >= 2) {
        if (!retainLedger) await manifest.clear(snapshot.marker, afterScan.revision);
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
  await manifest.initialize(marker);

  let child;
  let registration;
  let cleanupTask;
  const cleanup = () => {
    if (!child) return Promise.resolve();
    if (cleanupTask) return cleanupTask;
    cleanupTask = (async () => {
      try {
        await registration;
      } catch (registrationCause) {
        const cleanupFailures = [];
        try {
          await stopDirectChild(child);
        } catch (cause) {
          cleanupFailures.push(cause);
        }
        try {
          await cleanupOwnedManifest({
            manifestPath,
            platform,
            inspect,
            list,
            terminate,
            retainLedger: true,
          });
        } catch (cause) {
          cleanupFailures.push(cause);
        }
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [registrationCause, ...cleanupFailures],
            'Owned E2E registration and cleanup both failed',
            { cause: registrationCause }
          );
        }
        throw registrationCause;
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
      if (cleanupCause === cause || cleanupCause instanceof AggregateError) throw cleanupCause;
      throw new AggregateError([cause, cleanupCause], 'Owned E2E command and cleanup both failed', {
        cause: cleanupCause,
      });
    }
    throw cause;
  } finally {
    handlers.dispose();
  }
}

async function stopDirectChild(child) {
  if ((child.exitCode !== null && child.exitCode !== undefined) || typeof child.kill !== 'function')
    return;
  if (!child.kill('SIGTERM')) throw new Error(`Failed to stop direct owned child PID ${child.pid}`);
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
  const manifest = createManifestStore(operations.manifestPath);
  const snapshot = await manifest.read();
  if (snapshot.entries.length > 0) await cleanupOwnedManifest(operations);
  await manifest.reclaimStaleGenerations({ list: operations.list });
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

function createManifestStore(manifestPath, hooks = {}) {
  const ledgerRoot = `${manifestPath}.ledger`;
  return {
    async read() {
      try {
        const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (
          parsed?.version !== manifestVersion ||
          typeof parsed.marker !== 'string' ||
          typeof parsed.runId !== 'string' ||
          !isRunId(parsed.runId)
        )
          return emptyManifest();
        const events = await readLedgerEvents(
          ledgerGenerationDirectory(ledgerRoot, parsed.runId),
          parsed
        );
        const folded = new Map();
        for (const event of events) folded.set(identityKey(event.entry), event.entry);
        return {
          ...parsed,
          entries: [...folded.values()],
          revision: events
            .map((event) => event.name)
            .sort()
            .join(','),
        };
      } catch (cause) {
        if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return emptyManifest();
        throw cause;
      }
    },
    async initialize(marker) {
      const runId = randomUUID();
      const generationDirectory = ledgerGenerationDirectory(ledgerRoot, runId);
      const generation = { version: manifestVersion, marker, runId, closed: false };
      await fs.mkdir(generationDirectory, { recursive: true });
      await fs.writeFile(
        generationMetadataPath(generationDirectory),
        `${JSON.stringify(generation, null, 2)}\n`
      );
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ ...emptyManifest(marker), ...generation }, null, 2)}\n`
      );
    },
    async upsert(marker, entry) {
      const current = await this.read();
      if (current.marker && current.marker !== marker)
        throw new Error('Manifest belongs to another run');
      if (!current.runId) throw new Error('Ownership ledger was not initialized');
      if (current.closed) throw new Error('Ownership ledger is already closed');
      const event = { version: manifestVersion, runId: current.runId, marker, entry };
      const eventId = randomUUID();
      const generationDirectory = ledgerGenerationDirectory(ledgerRoot, current.runId);
      const temporary = path.join(generationDirectory, `entry-${eventId}.tmp`);
      const final = path.join(generationDirectory, `entry-${eventId}.json`);
      await fs.writeFile(temporary, `${JSON.stringify(event)}\n`);
      await hooks.beforeAppendRename?.({ current, temporary, final });
      await fs.rename(temporary, final);
    },
    async upsertMany(marker, entries) {
      for (const entry of entries) await this.upsert(marker, entry);
    },
    async clear(marker, expectedRevision) {
      const current = await this.read();
      if (current.marker !== marker || current.revision !== expectedRevision)
        throw new Error('Ownership ledger changed before terminal clear');
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ ...emptyManifest(marker), runId: current.runId, closed: true }, null, 2)}\n`
      );
      const generationDirectory = ledgerGenerationDirectory(ledgerRoot, current.runId);
      await fs.writeFile(
        generationMetadataPath(generationDirectory),
        `${JSON.stringify(
          { version: manifestVersion, marker, runId: current.runId, closed: true },
          null,
          2
        )}\n`
      );
      await fs.rm(generationDirectory, {
        force: true,
        recursive: true,
      });
    },
    async reclaimStaleGenerations({ list = () => listProcesses(process.platform) } = {}) {
      let names;
      try {
        names = await fs.readdir(ledgerRoot, { withFileTypes: true });
      } catch (cause) {
        if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return;
        throw cause;
      }
      const current = await this.read();
      const processes = await list();
      for (const item of names) {
        if (!item.isDirectory() || !isRunId(item.name) || item.name === current.runId) continue;
        const generationDirectory = ledgerGenerationDirectory(ledgerRoot, item.name);
        const generation = await readGenerationMetadata(generationDirectory);
        if (!generation) continue;
        const events = await readLedgerEvents(generationDirectory, generation);
        const liveIdentity = events.some((event) =>
          processes.some((candidate) => sameProcessIdentity(event.entry, candidate))
        );
        const liveMarker = processes.some((candidate) =>
          candidate.commandLine?.includes(generation.marker)
        );
        if (liveIdentity || liveMarker) {
          throw new Error(
            `Refusing to reclaim active ownership ledger generation ${generation.runId}`
          );
        }
        await fs.rm(generationDirectory, { force: true, recursive: true });
      }
    },
  };
}

function emptyManifest(marker) {
  return { version: manifestVersion, marker, entries: [], revision: '' };
}

function ledgerGenerationDirectory(ledgerRoot, runId) {
  return path.join(ledgerRoot, runId);
}

function generationMetadataPath(generationDirectory) {
  return path.join(generationDirectory, 'run.json');
}

function isRunId(value) {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

async function readGenerationMetadata(generationDirectory) {
  try {
    const parsed = JSON.parse(
      await fs.readFile(generationMetadataPath(generationDirectory), 'utf8')
    );
    return parsed?.version === manifestVersion &&
      typeof parsed.marker === 'string' &&
      typeof parsed.runId === 'string' &&
      isRunId(parsed.runId)
      ? parsed
      : undefined;
  } catch (cause) {
    if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return undefined;
    throw cause;
  }
}

async function readLedgerEvents(ledgerDirectory, metadata) {
  let names;
  try {
    names = await fs.readdir(ledgerDirectory);
  } catch (cause) {
    if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return [];
    throw cause;
  }
  const completeNames = names.filter((name) => /^entry-[0-9a-f-]+\.json$/i.test(name));
  const events = await Promise.all(
    completeNames.map(async (name) => {
      try {
        const event = JSON.parse(await fs.readFile(path.join(ledgerDirectory, name), 'utf8'));
        return event?.version === manifestVersion &&
          event.runId === metadata.runId &&
          event.marker === metadata.marker &&
          event.entry
          ? { name, entry: event.entry }
          : undefined;
      } catch (cause) {
        if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return undefined;
        throw cause;
      }
    })
  );
  return events.filter(Boolean);
}

/** Internal test seam; intentionally kept inside the supervisor script. */
export const ownedE2eSupervisorTesting = {
  createManifestStore,
  ledgerGenerationDirectory,
  generationMetadataPath,
  listProcesses,
};

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
    await execFileStrict('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$e=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}'))|ConvertFrom-Json;$p=[Diagnostics.Process]::GetProcessById($e.pid);try{$token=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds().ToString();$exe=$p.MainModule.FileName;$w=Get-CimInstance Win32_Process -Filter "ProcessId=$($e.pid)";$bad=@();if($token -ne $e.creationToken){$bad+='creationToken'};if($exe -ine $e.executable){$bad+='executable'};if($w.ParentProcessId -ne $e.parentPid){$bad+='parentPid'};if($w.CommandLine -ne $e.commandLine){$bad+='commandLine'};if($w.CommandLine -notlike ('*'+$e.marker+'*')){$bad+='marker'};if($bad.Count){throw ('owned identity mismatch: '+($bad -join ','))};$p.Kill()}finally{$p.Dispose()}`,
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
      'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; createdAt = $_.CreationDate.ToUniversalTime().ToString("o"); creationToken = ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds().ToString(); executable = $_.ExecutablePath; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress'
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

function execFileStrict(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout.trim());
    });
  });
}
