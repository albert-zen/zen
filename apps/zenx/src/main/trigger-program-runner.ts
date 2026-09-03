import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

import type {
  TriggerProgramSpec,
  TriggerProgramStage,
} from "./trigger-types.js";
import { MAX_PROGRAM_TIMEOUT_MS } from "./trigger-limits.js";
import {
  observeOwnedChild,
  type OwnedChildObservation,
} from "./owned-child-process.js";

export { MAX_PROGRAM_TIMEOUT_MS } from "./trigger-limits.js";

export const MAX_PROGRAM_INPUT_BYTES = 64 * 1024;
export const DEFAULT_PROGRAM_OUTPUT_BYTES = 64 * 1024;
export const MAX_PROGRAM_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_PROGRAM_TIMEOUT_MS = 30_000;
const PROGRAM_TERM_GRACE_MS = 250;
const PROGRAM_FORCE_SETTLEMENT_MS =
  process.platform === "win32" ? 12_000 : 1_500;
const PROGRAM_QUIESCENCE_TIMEOUT_MS =
  process.platform === "win32" ? 8_000 : 900;
const PROGRAM_QUIESCENCE_PASSES = 2;
const PROGRAM_QUIESCENCE_POLL_MS = 40;
const MAX_PROGRAM_STDERR_BYTES = 8 * 1_024;
const MAX_PROCESS_TABLE_BYTES = 128 * 1_024;
const WINDOWS_IDENTITY_TERMINATION_TIMEOUT_MS = 4_000;

export interface TriggerProgramRunInput {
  invocationId: string;
  stage: TriggerProgramStage;
  event: unknown;
}

export function processTableTimeoutMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? 8_000 : 750;
}

export interface TriggerProgramRunResult {
  status:
    | "matched"
    | "non_match"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "nonzero_exit"
    | "malformed_output"
    | "oversized_output";
  output: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface TriggerProgramRunner {
  run(
    spec: TriggerProgramSpec,
    input: TriggerProgramRunInput,
    signal: AbortSignal,
  ): Promise<TriggerProgramRunResult>;
}

export class ZenXTriggerProgramRunner implements TriggerProgramRunner {
  constructor(
    private readonly processOperations: WindowsProcessOperations = realWindowsProcessOperations,
  ) {}

  async run(
    spec: TriggerProgramSpec,
    input: TriggerProgramRunInput,
    signal: AbortSignal,
  ): Promise<TriggerProgramRunResult> {
    if (signal.aborted)
      return result(
        "cancelled",
        null,
        null,
        describeError(
          signal.reason ?? new DOMException("Aborted", "AbortError"),
        ),
      );
    const serializedInput = JSON.stringify(input);
    if (Buffer.byteLength(serializedInput, "utf8") > MAX_PROGRAM_INPUT_BYTES) {
      return result(
        "failed",
        null,
        null,
        "Program input exceeded its 64 KiB bound",
      );
    }
    const maxOutputBytes = Math.min(
      MAX_PROGRAM_OUTPUT_BYTES,
      Math.max(
        256,
        Math.floor(spec.maxOutputBytes ?? DEFAULT_PROGRAM_OUTPUT_BYTES),
      ),
    );
    const timeoutMs = Math.min(
      MAX_PROGRAM_TIMEOUT_MS,
      Math.max(1, Math.floor(spec.timeoutMs ?? DEFAULT_PROGRAM_TIMEOUT_MS)),
    );
    const environment = {
      ...minimalEnvironment(process.env),
      ...(spec.env ?? {}),
    };
    return await new Promise<TriggerProgramRunResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(spec.command, spec.args ?? [], {
          cwd: spec.cwd ?? process.cwd(),
          env: environment,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        resolve(result("failed", null, null, describeError(error)));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let collecting = true;
      let requested: TriggerProgramRunResult | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let termination: Promise<TerminationResult> | undefined;
      let containment: Promise<TerminationResult> | undefined;
      let forceStarted = false;
      const cleanup = (): void => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        signal.removeEventListener("abort", abort);
      };
      const stopCollection = (): void => {
        if (!collecting) return;
        collecting = false;
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
      };
      const finish = (value: TriggerProgramRunResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        stopCollection();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        resolve(value);
      };
      const forceAndFinish = async (): Promise<void> => {
        if (settled || requested === null || forceStarted) return;
        forceStarted = true;
        if (forceTimer !== undefined) {
          clearTimeout(forceTimer);
          forceTimer = undefined;
        }
        if (capturedTree === undefined && child.exitCode !== null) {
          const exited = await verifyExitedChild(
            child,
            this.processOperations.captureProcessTable,
          );
          if (settled || requested === null) return;
          if (exited.ok) {
            finish(requested);
            return;
          }
        }
        containment ??= (
          termination ?? Promise.resolve({ ok: true, error: "" })
        ).then(async (softTermination) => {
          const forced = await terminateProcessTree(
            child,
            true,
            capturedTree,
            this.processOperations,
          );
          if (
            !softTermination.ok &&
            softTermination.error.startsWith(
              "process-tree snapshot unavailable",
            )
          )
            return forced.ok
              ? softTermination
              : {
                  ok: false,
                  error: `${softTermination.error}; ${forced.error}`,
                };
          return forced;
        });
        let terminationResult: TerminationResult;
        try {
          terminationResult = await withDeadline(
            containment,
            PROGRAM_FORCE_SETTLEMENT_MS,
            {
              ok: false,
              error: "bounded process-tree termination deadline expired",
            },
          );
        } catch (error) {
          terminationResult = {
            ok: false,
            error: `process-tree termination failed: ${describeError(error)}`,
          };
        }
        if (settled || requested === null) return;
        if (terminationResult.ok) finish(requested);
        else finish(containmentFailure(requested, terminationResult.error));
      };
      const requestTermination = (value: TriggerProgramRunResult): void => {
        if (settled || requested !== null) return;
        requested = value;
        stopCollection();
        child.stdin.destroy();
        const treeAtTermination = captureProcessTree(
          child.pid,
          this.processOperations.captureProcessTable,
        ).then(
          (tree) => ({ tree, error: null }),
          (error: unknown) => ({
            tree: undefined,
            error: describeError(error),
          }),
        );
        termination = treeAtTermination.then(async (snapshot) => {
          if (snapshot.tree !== undefined) {
            capturedTree = snapshot.tree;
            return await terminateProcessTree(
              child,
              false,
              snapshot.tree,
              this.processOperations,
            );
          }
          await terminateProcessTree(
            child,
            false,
            undefined,
            this.processOperations,
          );
          const exited = await verifyExitedChild(
            child,
            this.processOperations.captureProcessTable,
          );
          if (exited.ok) return exited;
          return {
            ok: false as const,
            error: `process-tree snapshot unavailable: ${snapshot.error ?? "unknown discovery failure"}; containment was not proven`,
          };
        });
        forceTimer = setTimeout(() => {
          forceTimer = undefined;
          void forceAndFinish();
        }, PROGRAM_TERM_GRACE_MS);
      };
      let capturedTree: ProcessTreeSnapshot | undefined;
      const abort = (): void => {
        requestTermination(
          result(
            "cancelled",
            null,
            null,
            describeError(
              signal.reason ?? new DOMException("Aborted", "AbortError"),
            ),
          ),
        );
      };
      timeoutTimer = setTimeout(() => {
        requestTermination(
          result(
            "timed_out",
            null,
            null,
            `Program timed out after ${String(timeoutMs)}ms`,
          ),
        );
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (!collecting || settled || requested !== null) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > maxOutputBytes) {
          requestTermination(
            result(
              "oversized_output",
              null,
              null,
              `Program output exceeded its ${String(maxOutputBytes)} byte bound`,
            ),
          );
          return;
        }
        stdout.push(buffer);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        if (!collecting || settled || requested !== null) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = MAX_PROGRAM_STDERR_BYTES - stderrBytes;
        if (remaining <= 0) return;
        const bounded = buffer.subarray(0, remaining);
        stderrBytes += bounded.length;
        stderr.push(bounded);
      });
      child.stdin.once("error", (error: unknown) => {
        if (requested === null && !settled)
          requestTermination(
            result("failed", null, null, describeError(error)),
          );
      });
      child.stdout.once("error", (error: unknown) => {
        if (requested === null && !settled)
          requestTermination(
            result("failed", null, null, describeError(error)),
          );
      });
      child.stderr.once("error", (error: unknown) => {
        if (requested === null && !settled)
          requestTermination(
            result("failed", null, null, describeError(error)),
          );
      });
      child.once("error", (error: unknown) => {
        if (requested === null)
          requestTermination(
            result("failed", null, null, describeError(error)),
          );
      });
      child.once("close", (code: number | null) => {
        if (requested !== null) {
          void forceAndFinish();
          return;
        }
        if (settled) return;
        const text = Buffer.concat(stdout).toString("utf8").trim();
        if (code !== 0) {
          finish(
            result(
              "nonzero_exit",
              text.length === 0 ? null : text,
              code,
              boundedError(Buffer.concat(stderr).toString("utf8")),
            ),
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch (error) {
          finish(
            result(
              "malformed_output",
              text || null,
              code,
              describeError(error),
            ),
          );
          return;
        }
        const object = record(parsed);
        if (object === null) {
          finish(
            result(
              "malformed_output",
              text,
              code,
              "Program output must be a JSON object",
            ),
          );
          return;
        }
        if (input.stage === "predicate") {
          if (typeof object["match"] !== "boolean") {
            finish(
              result(
                "malformed_output",
                text,
                code,
                "Predicate output must contain boolean match",
              ),
            );
            return;
          }
          finish(
            result(object["match"] ? "matched" : "non_match", text, code, null),
          );
          return;
        }
        if (object["ok"] !== undefined && typeof object["ok"] !== "boolean") {
          finish(
            result(
              "malformed_output",
              text,
              code,
              "Action output ok must be boolean",
            ),
          );
          return;
        }
        if (object["ok"] === false) {
          finish(result("failed", text, code, "Action returned ok=false"));
          return;
        }
        finish(result("completed", text, code, null));
      });
      child.stdin.end(`${serializedInput}\n`);
    });
  }
}

export interface WindowsProcessIdentity {
  pid: number;
  parentPid: number;
  processGroupId: number | null;
  sessionId: number | null;
  startTime: string | null;
}

export interface WindowsProcessTableSnapshot {
  entries: WindowsProcessIdentity[];
}

export interface WindowsProcessTreeSnapshot {
  root: WindowsProcessIdentity;
  descendants: WindowsProcessIdentity[];
}

export interface WindowsProcessOperations {
  captureProcessTable(): Promise<WindowsProcessTableSnapshot>;
  terminateProcessIdentity(
    expected: WindowsProcessIdentity,
  ): Promise<{ ok: boolean; error: string }>;
}

type ProcessIdentity = WindowsProcessIdentity;
type ProcessTableSnapshot = WindowsProcessTableSnapshot;
type ProcessTreeSnapshot = WindowsProcessTreeSnapshot;

interface TerminationResult {
  ok: boolean;
  error: string;
}

function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  tree?: ProcessTreeSnapshot,
  processOperations: WindowsProcessOperations = realWindowsProcessOperations,
): Promise<TerminationResult> {
  if (child.pid === undefined)
    return Promise.resolve({
      ok: false,
      error: "the child process did not expose a PID",
    });
  if (!force && child.exitCode !== null)
    return Promise.resolve({ ok: true, error: "" });
  if (process.platform === "win32")
    return terminateWindowsProcessTree(child, force, tree, processOperations);
  return terminatePosixProcessTree(
    child,
    force,
    tree,
    processOperations.captureProcessTable,
  );
}

async function terminateWindowsProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  tree?: ProcessTreeSnapshot,
  operations: WindowsProcessOperations = realWindowsProcessOperations,
): Promise<TerminationResult> {
  if (child.pid === undefined)
    return { ok: false, error: "the child process did not expose a PID" };
  if (!force) {
    try {
      child.kill("SIGTERM");
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }
  if (tree === undefined)
    return {
      ok: false,
      error:
        "process-tree identity was unavailable; containment was not proven",
    };
  return await verifyAndTerminateWindowsProcessTree(
    child.pid,
    tree,
    operations,
  );
}

async function terminatePosixProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  tree?: ProcessTreeSnapshot,
  capture: () => Promise<ProcessTableSnapshot> = captureProcessTable,
): Promise<TerminationResult> {
  if (child.pid === undefined)
    return { ok: false, error: "the child process did not expose a PID" };
  if (!force) return sendPosixSignal(-child.pid, "SIGTERM");
  if (tree === undefined)
    return {
      ok: false,
      error:
        "process-tree identity was unavailable; containment was not proven",
    };
  return await verifyAndTerminatePosix(child.pid, tree, capture);
}

async function verifyExitedChild(
  child: ChildProcessWithoutNullStreams,
  capture: () => Promise<ProcessTableSnapshot> = captureProcessTable,
): Promise<TerminationResult> {
  if (child.pid === undefined || child.exitCode === null)
    return {
      ok: false,
      error: "the child process identity was unavailable before termination",
    };
  try {
    const table = await capture();
    const survivors = table.entries.filter(
      (entry) =>
        entry.parentPid === child.pid || entry.processGroupId === child.pid,
    );
    return survivors.length === 0
      ? { ok: true, error: "" }
      : {
          ok: false,
          error:
            "the child exited before its process tree was captured; descendant containment was not proven",
        };
  } catch (error) {
    return {
      ok: false,
      error: `process-table verification failed: ${describeError(error)}`,
    };
  }
}

export async function verifyAndTerminateWindowsProcessTree(
  rootPid: number,
  tree: ProcessTreeSnapshot,
  operations: WindowsProcessOperations = realWindowsProcessOperations,
  options: {
    quiescenceTimeoutMs?: number;
    quiescencePollMs?: number;
  } = {},
): Promise<TerminationResult> {
  let tracked = [tree.root, ...tree.descendants];
  const timeoutMs = boundedDuration(
    options.quiescenceTimeoutMs,
    PROGRAM_QUIESCENCE_TIMEOUT_MS,
  );
  const pollMs = boundedDuration(
    options.quiescencePollMs,
    PROGRAM_QUIESCENCE_POLL_MS,
  );
  let stableAbsentPasses = 0;
  const deadline = Date.now() + timeoutMs;
  let firstPass = true;
  while (firstPass || Date.now() < deadline) {
    firstPass = false;
    let table: WindowsProcessTableSnapshot;
    try {
      table = await operations.captureProcessTable();
    } catch (error) {
      return processTableDiscoveryFailure(error);
    }
    tracked = addWindowsDescendants(tracked, table.entries);
    const unknownIdentity = tracked.find(
      (identity) => identity.startTime === null,
    );
    if (unknownIdentity !== undefined)
      return {
        ok: false,
        error: `PID ${String(unknownIdentity.pid)} has unknown process identity; containment was not proven`,
      };
    const live = tracked.filter((identity) =>
      identityMatches(
        identity,
        table.entries.find((candidate) => candidate.pid === identity.pid),
      ),
    );
    if (live.length === 0) {
      stableAbsentPasses += 1;
      if (stableAbsentPasses >= PROGRAM_QUIESCENCE_PASSES)
        return { ok: true, error: "" };
    } else {
      stableAbsentPasses = 0;
      for (const identity of live) {
        if (Date.now() >= deadline) return quiescenceDeadlineFailure();
        const termination = await operations.terminateProcessIdentity(identity);
        if (!termination.ok && termination.error !== "process was not found")
          return {
            ok: false,
            error:
              identity.pid === rootPid
                ? termination.error
                : `PID ${String(identity.pid)}: ${termination.error}`,
          };
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return quiescenceDeadlineFailure();
    await delay(Math.min(pollMs, remainingMs));
  }
  return quiescenceDeadlineFailure();
}

function quiescenceDeadlineFailure(): TerminationResult {
  return {
    ok: false,
    error:
      "process-tree quiescence could not be proven before the bounded deadline",
  };
}

function boundedDuration(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

export const realWindowsProcessOperations: WindowsProcessOperations = {
  captureProcessTable,
  terminateProcessIdentity: terminateWindowsProcessIdentity,
};

async function verifyAndTerminatePosix(
  rootPid: number,
  tree: ProcessTreeSnapshot,
  capture: () => Promise<ProcessTableSnapshot> = captureProcessTable,
): Promise<TerminationResult> {
  let stableAbsentPasses = 0;
  const deadline = Date.now() + PROGRAM_QUIESCENCE_TIMEOUT_MS;
  let tracked = [tree.root, ...tree.descendants];
  while (Date.now() < deadline) {
    let table: ProcessTableSnapshot;
    try {
      table = await capture();
    } catch (error) {
      return processTableDiscoveryFailure(error);
    }
    const beforeExpansion = validateTrackedIdentities(tracked, table.entries);
    if (beforeExpansion !== null) return { ok: false, error: beforeExpansion };
    tracked = addDescendants(tracked, table.entries);
    const identityError = validateTrackedIdentities(tracked, table.entries);
    if (identityError !== null) return { ok: false, error: identityError };
    const live = tracked.filter((identity) =>
      table.entries.some((candidate) => candidate.pid === identity.pid),
    );
    if (live.length === 0) {
      stableAbsentPasses += 1;
      if (stableAbsentPasses >= PROGRAM_QUIESCENCE_PASSES)
        return { ok: true, error: "" };
    } else {
      stableAbsentPasses = 0;
      const groupIds = new Set(
        live
          .map((identity) => identity.processGroupId)
          .filter((value): value is number => value !== null),
      );
      for (const groupId of groupIds) {
        const groupResult = sendPosixSignal(-groupId, "SIGKILL");
        if (!groupResult.ok) return groupResult;
      }
      for (const identity of live) {
        const current = table.entries.find(
          (candidate) => candidate.pid === identity.pid,
        );
        if (!identityMatches(identity, current))
          return {
            ok: false,
            error: `PID ${String(identity.pid)} identity changed; containment was not proven`,
          };
        const result = sendPosixSignal(identity.pid, "SIGKILL");
        if (!result.ok)
          return {
            ok: false,
            error: `PID ${String(identity.pid)}: ${result.error}`,
          };
      }
    }
    await delay(PROGRAM_QUIESCENCE_POLL_MS);
  }
  return {
    ok: false,
    error:
      "process-tree quiescence could not be proven before the bounded deadline",
  };
}

function processTableDiscoveryFailure(error: unknown): TerminationResult {
  return {
    ok: false,
    error: `process-table discovery failed: ${describeError(error)}`,
  };
}

function sendPosixSignal(
  pid: number,
  signal: NodeJS.Signals,
): TerminationResult {
  try {
    process.kill(pid, signal);
    return { ok: true, error: "" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH"
      ? { ok: true, error: "" }
      : { ok: false, error: describeError(error) };
  }
}

function validateTrackedIdentities(
  tracked: readonly ProcessIdentity[],
  entries: readonly ProcessIdentity[],
): string | null {
  for (const identity of tracked) {
    if (identity.startTime === null)
      return `PID ${String(identity.pid)} has unknown process identity; containment was not proven`;
    const current = entries.find((candidate) => candidate.pid === identity.pid);
    if (current !== undefined && !identityMatches(identity, current))
      return `PID ${String(identity.pid)} identity changed; containment was not proven`;
  }
  return null;
}

function identityMatches(
  expected: ProcessIdentity,
  actual: ProcessIdentity | undefined,
): boolean {
  return (
    actual !== undefined &&
    expected.startTime !== null &&
    actual.startTime !== null &&
    expected.startTime === actual.startTime
  );
}

function addDescendants(
  tracked: readonly ProcessIdentity[],
  entries: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const result = [...tracked];
  const known = new Set(result.map((identity) => identity.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (known.has(entry.pid)) continue;
      if (result.some((identity) => identity.pid === entry.parentPid)) {
        result.push(entry);
        known.add(entry.pid);
        changed = true;
      }
    }
  }
  return result;
}

function addWindowsDescendants(
  tracked: readonly ProcessIdentity[],
  entries: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const result = [...tracked];
  const known = new Set(result.map((identity) => identity.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (known.has(entry.pid)) continue;
      const parent = result.find(
        (identity) => identity.pid === entry.parentPid,
      );
      if (parent === undefined) continue;
      const currentParent = entries.find(
        (candidate) => candidate.pid === parent.pid,
      );
      if (
        currentParent !== undefined &&
        !identityMatches(parent, currentParent) &&
        !windowsIdentityPredates(entry, currentParent)
      )
        continue;
      result.push(entry);
      known.add(entry.pid);
      changed = true;
    }
  }
  return result;
}

function windowsIdentityPredates(
  identity: ProcessIdentity,
  other: ProcessIdentity,
): boolean {
  if (
    identity.startTime === null ||
    other.startTime === null ||
    !/^\d+$/u.test(identity.startTime) ||
    !/^\d+$/u.test(other.startTime)
  )
    return false;
  return BigInt(identity.startTime) < BigInt(other.startTime);
}

export async function terminateWindowsProcessIdentity(
  expected: WindowsProcessIdentity,
  // Test-only handshake for the real adapter's exit-after-match fixture.
  identityMatchedFixture?: () => void | Promise<void>,
): Promise<TerminationResult> {
  if (expected.startTime === null || !/^\d+$/u.test(expected.startTime))
    return {
      ok: false,
      error: `PID ${String(expected.pid)} has unknown process identity`,
    };
  const script = `
$ErrorActionPreference = 'Stop'
$process = $null
$matched = $false
try {
  [Console]::Out.WriteLine('ZENX_STAGE:started')
  [Console]::Out.Flush()
  try {
    $process = [System.Diagnostics.Process]::GetProcessById(${String(expected.pid)})
    # Force one exact OS handle to be acquired before checking identity. Later
    # StartTime, HasExited, Kill, and WaitForExit calls stay bound to it.
    $null = $process.Handle
  } catch [System.ArgumentException] {
    exit 3
  }
  [Console]::Out.WriteLine('ZENX_STAGE:handle-opened')
  [Console]::Out.Flush()
  $expectedStartTime = [Int64]::Parse('${expected.startTime}')
  $actualStartTime = $process.StartTime.ToUniversalTime().Ticks
  # CIM datetime exposes microseconds while FILETIME exposes 100-nanosecond ticks.
  $actualStartTime -= $actualStartTime % 10
  if ($actualStartTime -eq $expectedStartTime) {
    $matched = $true
    [Console]::Out.WriteLine('ZENX_STAGE:identity-matched')
    [Console]::Out.Flush()
${
  identityMatchedFixture === undefined
    ? ""
    : `    [Console]::Out.WriteLine('ZENX_IDENTITY_MATCHED')
    [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -ne 'continue') {
      throw "identity-match fixture did not continue"
    }
`
}    if (!$process.HasExited) {
      try {
        $process.Kill()
        [Console]::Out.WriteLine('ZENX_STAGE:kill-dispatched')
        [Console]::Out.Flush()
      } catch {
        if (!$process.HasExited) { throw }
      }
      if (!$process.HasExited) { $process.WaitForExit() }
    }
    [Console]::Out.WriteLine('ZENX_STAGE:target-exited')
    [Console]::Out.Flush()
  }
} finally {
  if ($null -ne $process) { $process.Dispose() }
}
if (!$matched) { exit 3 }
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killer: ReturnType<typeof spawn> | undefined;
    let stderr = "";
    let stdout = "";
    let lastStage = "spawn";
    let identityHookStarted = false;
    let forcedFailure: string | undefined;
    let killerObservation: OwnedChildObservation | undefined;
    let escalationStarted = false;
    const appendFailure = (detail: string): void => {
      forcedFailure =
        forcedFailure === undefined ? detail : `${forcedFailure}; ${detail}`;
    };
    const escalateOwnedHelper = async (): Promise<void> => {
      if (
        escalationStarted ||
        killer === undefined ||
        killer.pid === undefined ||
        killerObservation?.outcome() !== undefined
      )
        return;
      escalationStarted = true;
      const pid = killer.pid;
      const cleanup = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let cleanupStdout = "";
      let cleanupStderr = "";
      cleanup.stdout?.setEncoding("utf8");
      cleanup.stdout?.on("data", (chunk: string) => {
        if (cleanupStdout.length < MAX_PROGRAM_STDERR_BYTES)
          cleanupStdout += chunk;
      });
      cleanup.stderr?.setEncoding("utf8");
      cleanup.stderr?.on("data", (chunk: string) => {
        if (cleanupStderr.length < MAX_PROGRAM_STDERR_BYTES)
          cleanupStderr += chunk;
      });
      const cleanupObservation = observeOwnedChild(cleanup);
      const cleanupResult = await cleanupObservation.terminal;
      if (cleanupResult.type === "spawn_error" || cleanupResult.code !== 0) {
        appendFailure(
          `exact helper PID ${String(pid)} taskkill escalation failed: outcome=${JSON.stringify(
            cleanupResult.type === "spawn_error"
              ? { type: cleanupResult.type, error: cleanupResult.error.message }
              : cleanupResult,
          )}; stdout=${JSON.stringify(boundedError(cleanupStdout) ?? "")}; stderr=${JSON.stringify(boundedError(cleanupStderr) ?? "")}`,
        );
        try {
          killer.kill("SIGKILL");
        } catch (error) {
          appendFailure(
            `final exact helper kill failed: ${describeError(error)}`,
          );
        }
      }
    };
    const requestOwnedHelperTermination = (): void => {
      if (killer === undefined || killerObservation?.outcome() !== undefined)
        return;
      try {
        if (!killer.kill("SIGKILL")) void escalateOwnedHelper();
      } catch (error) {
        appendFailure(`exact helper kill failed: ${describeError(error)}`);
        void escalateOwnedHelper();
      }
    };
    const finish = (value: TerminationResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    try {
      killer = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        {
          windowsHide: true,
          stdio:
            identityMatchedFixture === undefined
              ? ["ignore", "pipe", "pipe"]
              : ["pipe", "pipe", "pipe"],
        },
      );
      killerObservation = observeOwnedChild(killer as ChildProcess);
      killer.stderr?.setEncoding("utf8");
      killer.stderr?.on("data", (chunk: string) => {
        if (stderr.length < MAX_PROGRAM_STDERR_BYTES) stderr += chunk;
      });
      killer.stdout?.setEncoding("utf8");
      killer.stdout?.on("data", (chunk: string) => {
        if (stdout.length < MAX_PROGRAM_STDERR_BYTES) stdout += chunk;
        for (const match of chunk.matchAll(/ZENX_STAGE:([^\r\n]+)/gu)) {
          lastStage = match[1] ?? lastStage;
        }
        if (identityMatchedFixture !== undefined && !identityHookStarted) {
          if (!stdout.includes("ZENX_IDENTITY_MATCHED")) return;
          identityHookStarted = true;
          void Promise.resolve()
            .then(identityMatchedFixture)
            .then(
              () => {
                if (!settled) killer?.stdin?.end("continue\n");
              },
              (error: unknown) => {
                forcedFailure = `identity-match fixture failed: ${describeError(error)}`;
                requestOwnedHelperTermination();
              },
            );
        }
      });
    } catch (error) {
      finish({ ok: false, error: describeError(error) });
      return;
    }
    timer = setTimeout(() => {
      forcedFailure = `PID ${String(expected.pid)} identity-aware termination timed out during ${lastStage}; stdout=${JSON.stringify(
        boundedError(stdout) ?? "",
      )}; stderr=${JSON.stringify(boundedError(stderr) ?? "")}`;
      requestOwnedHelperTermination();
    }, WINDOWS_IDENTITY_TERMINATION_TIMEOUT_MS);
    killer.on("error", (error: unknown) => {
      if (killerObservation?.outcome()?.type === "spawn_error") return;
      appendFailure(
        `identity-aware termination helper error: ${describeError(error)}`,
      );
      void escalateOwnedHelper();
    });
    void killerObservation.terminal.then((outcome) =>
      finish(
        outcome.type === "spawn_error"
          ? { ok: false, error: describeError(outcome.error) }
          : forcedFailure !== undefined
            ? { ok: false, error: forcedFailure }
            : outcome.code === 0
              ? { ok: true, error: "" }
              : outcome.code === 3
                ? { ok: false, error: "process was not found" }
                : {
                    ok: false,
                    error:
                      boundedError(stderr) ??
                      `identity-aware termination exited with code ${String(outcome.code)} and signal ${String(outcome.signal)} during ${lastStage}; stdout=${JSON.stringify(
                        boundedError(stdout) ?? "",
                      )}`,
                  },
      ),
    );
  });
}

function captureProcessTree(
  pid: number | undefined,
  capture: () => Promise<ProcessTableSnapshot> = captureProcessTable,
): Promise<ProcessTreeSnapshot> {
  if (pid === undefined)
    return Promise.reject(new Error("the child process did not expose a PID"));
  return capture().then((table) => {
    const root = table.entries.find((entry) => entry.pid === pid);
    if (root === undefined || root.startTime === null)
      throw new Error("root process identity was unavailable");
    const descendants = addDescendants([root], table.entries).filter(
      (entry) => entry.pid !== root.pid,
    );
    if (descendants.some((entry) => entry.startTime === null))
      throw new Error("descendant process identity was unavailable");
    return { root, descendants };
  });
}

async function captureProcessTable(): Promise<ProcessTableSnapshot> {
  const command = process.platform === "win32" ? "powershell.exe" : "ps";
  const windowsScript = `
$ErrorActionPreference = 'Stop'
$searcher = [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process')
try {
  $processes = $searcher.Get()
  try {
    foreach ($process in $processes) {
      $created = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate).ToUniversalTime().Ticks
      [Console]::Out.WriteLine('{0}|{1}|{2}', $process.ProcessId, $process.ParentProcessId, $created)
    }
  } finally {
    $processes.Dispose()
  }
} finally {
  $searcher.Dispose()
}
`;
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(windowsScript, "utf16le").toString("base64"),
        ]
      : process.platform === "linux"
        ? ["-eo", "pid=,ppid=,pgid=,sid=,lstart="]
        : // Darwin ps has no sid= keyword; session identity is not used here.
          ["-axo", "pid=,ppid=,pgid=,lstart="];
  const output = await captureProcessTableCommandOutput(command, args);
  return process.platform === "win32"
    ? parseWindowsProcessTable(output)
    : parsePosixProcessTable(output, process.platform === "linux");
}

export async function captureProcessTableCommandOutput(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    // Test-only observation hook; it cannot alter helper ownership.
    onSpawn?: (child: ChildProcess) => void;
  } = {},
): Promise<string> {
  const timeoutMs =
    options.timeoutMs ?? processTableTimeoutMs(process.platform);
  const maxOutputBytes = options.maxOutputBytes ?? MAX_PROCESS_TABLE_BYTES;
  const overflowError = `process-table snapshot exceeded its ${
    maxOutputBytes === MAX_PROCESS_TABLE_BYTES
      ? "128 KiB"
      : `${String(maxOutputBytes)} byte`
  } bound`;
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflowed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let processHandle: ReturnType<typeof spawn> | undefined;
    let observation: OwnedChildObservation | undefined;
    let escalationSettlement: Promise<unknown> | undefined;
    let forcedFailure: Error | undefined;
    let stderr = "";
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      if (error !== null) reject(error);
      else if (overflowed) reject(new Error(overflowError));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    try {
      processHandle = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      observation = observeOwnedChild(processHandle);
      try {
        options.onSpawn?.(processHandle);
      } catch (error) {
        stderr += `; helper observation hook failed: ${describeError(error)}`;
      }
      processHandle.stdout?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes + buffer.length > maxOutputBytes) {
          overflowed = true;
          return;
        }
        bytes += buffer.length;
        chunks.push(buffer);
      });
      processHandle.stderr?.setEncoding("utf8");
      processHandle.stderr?.on("data", (chunk: string) => {
        if (stderr.length < MAX_PROGRAM_STDERR_BYTES) stderr += chunk;
      });
      processHandle.on("error", (error: unknown) => {
        if (observation?.outcome()?.type !== "spawn_error")
          stderr += `; helper error: ${describeError(error)}`;
      });
      void observation.terminal.then(async (outcome) => {
        await escalationSettlement;
        if (forcedFailure !== undefined) {
          const diagnostic = boundedError(stderr);
          finish(
            diagnostic === null
              ? forcedFailure
              : new Error(`${forcedFailure.message}; stderr=${diagnostic}`),
          );
        } else if (outcome.type === "spawn_error") finish(outcome.error);
        else if (outcome.code === 0) finish(null);
        else
          finish(
            new Error(
              `${command} exited with code ${String(outcome.code)} and signal ${String(outcome.signal)}${boundedError(stderr) === null ? "" : `: ${boundedError(stderr)}`}`,
            ),
          );
      });
      const terminateAndSettle = (error: Error): void => {
        if (forcedFailure !== undefined) return;
        forcedFailure = error;
        if (
          processHandle?.pid === undefined ||
          observation?.outcome() !== undefined
        )
          return;
        try {
          processHandle.kill("SIGKILL");
        } catch (killError) {
          stderr += `; exact helper kill failed: ${describeError(killError)}`;
        }
        if (process.platform === "win32") {
          escalationTimer = setTimeout(() => {
            if (
              processHandle?.pid === undefined ||
              observation?.outcome() !== undefined
            )
              return;
            const escalation = spawn(
              "taskkill.exe",
              ["/PID", String(processHandle.pid), "/T", "/F"],
              { stdio: "ignore", windowsHide: true },
            );
            escalationSettlement = observeOwnedChild(escalation).terminal;
          }, PROGRAM_TERM_GRACE_MS);
        }
      };
      timer = setTimeout(() => {
        terminateAndSettle(
          new Error(`${command} process-tree snapshot timed out`),
        );
      }, timeoutMs);
      processHandle.stdout?.on("data", () => {
        if (overflowed) terminateAndSettle(new Error(overflowError));
      });
    } catch (error) {
      finish(new Error(describeError(error)));
    }
  });
}

function parseWindowsProcessTable(output: string): ProcessTableSnapshot {
  const entries: ProcessIdentity[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = trimmed.match(/^(\d+)\|(\d+)\|(\d+)$/u);
    if (match === null)
      throw new Error("Windows process-table snapshot was incomplete");
    entries.push({
      pid: Number(match[1]!),
      parentPid: Number(match[2]!),
      processGroupId: null,
      sessionId: null,
      startTime: match[3]!,
    });
  }
  return { entries };
}

function parsePosixProcessTable(
  output: string,
  includesSessionId: boolean,
): ProcessTableSnapshot {
  const entries: ProcessIdentity[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const match = includesSessionId
      ? line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u)
      : line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u);
    if (match === null)
      throw new Error("POSIX process-table snapshot was incomplete");
    entries.push({
      pid: Number(match[1]!),
      parentPid: Number(match[2]!),
      processGroupId: Number(match[3]!),
      sessionId: includesSessionId ? Number(match[4]!) : null,
      startTime: match[includesSessionId ? 5 : 4]!.trim() || null,
    });
  }
  return { entries };
}

async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  fallback: T,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, milliseconds);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function result(
  status: TriggerProgramRunResult["status"],
  output: string | null,
  exitCode: number | null,
  error: string | null,
): TriggerProgramRunResult {
  return { status, output: bound(output), exitCode, error: bound(error) };
}

function containmentFailure(
  requested: TriggerProgramRunResult,
  containmentError: string,
): TriggerProgramRunResult {
  const detail = `process-tree containment was not proven: ${containmentError}`;
  return result(
    requested.status,
    requested.output,
    requested.exitCode,
    requested.error === null ? detail : `${requested.error}; ${detail}`,
  );
}

function minimalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "LANG",
    "PATH",
    "Path",
    "PATHEXT",
    "SHELL",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedError(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : bound(trimmed);
}

function bound(value: string | null): string | null {
  if (value === null || Buffer.byteLength(value, "utf8") <= 2_048) return value;
  const suffix = "…[truncated]";
  const available = Math.max(0, 2_048 - Buffer.byteLength(suffix, "utf8"));
  return `${prefixByBytes(value, available)}${suffix}`;
}

function prefixByBytes(value: string, limit: number): string {
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > limit) break;
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
