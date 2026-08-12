import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  TriggerProgramSpec,
  TriggerProgramStage,
} from "./trigger-types.js";
import { MAX_PROGRAM_TIMEOUT_MS } from "./trigger-limits.js";

export { MAX_PROGRAM_TIMEOUT_MS } from "./trigger-limits.js";

export const MAX_PROGRAM_INPUT_BYTES = 64 * 1024;
export const DEFAULT_PROGRAM_OUTPUT_BYTES = 64 * 1024;
export const MAX_PROGRAM_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_PROGRAM_TIMEOUT_MS = 30_000;
const PROGRAM_TERM_GRACE_MS = 250;
const PROGRAM_FORCE_SETTLEMENT_MS = 1_500;
const PROGRAM_QUIESCENCE_TIMEOUT_MS = 900;
const PROGRAM_QUIESCENCE_PASSES = 2;
const PROGRAM_QUIESCENCE_POLL_MS = 40;
const MAX_PROGRAM_STDERR_BYTES = 8 * 1_024;

export interface TriggerProgramRunInput {
  invocationId: string;
  stage: TriggerProgramStage;
  event: unknown;
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
      const initialTree = captureProcessTree(child.pid).catch(() => undefined);
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
          const exited = await verifyExitedChild(child);
          if (settled || requested === null) return;
          if (exited.ok) {
            finish(requested);
            return;
          }
        }
        containment ??= (
          termination ?? Promise.resolve({ ok: true, error: "" })
        ).then(async (softTermination) => {
          const forced = await terminateProcessTree(child, true, capturedTree);
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
        const terminationResult = await withDeadline(
          containment,
          PROGRAM_FORCE_SETTLEMENT_MS,
          {
            ok: false,
            error: "bounded process-tree termination deadline expired",
          },
        );
        if (settled || requested === null) return;
        if (terminationResult.ok) finish(requested);
        else
          finish(
            result(
              "failed",
              null,
              null,
              `Program ${requested.status} did not prove process-tree containment: ${terminationResult.error}`,
            ),
          );
      };
      const requestTermination = (value: TriggerProgramRunResult): void => {
        if (settled || requested !== null) return;
        requested = value;
        stopCollection();
        child.stdin.destroy();
        const treeAtTermination = captureProcessTree(child.pid).catch(
          () => initialTree,
        );
        termination = treeAtTermination.then(async (tree) => {
          if (tree !== undefined) {
            capturedTree = tree;
            return await terminateProcessTree(child, false, tree);
          }
          await terminateProcessTree(child, false);
          const exited = await verifyExitedChild(child);
          if (exited.ok) return exited;
          return {
            ok: false as const,
            error:
              "process-tree snapshot unavailable; containment was not proven",
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

interface ProcessIdentity {
  pid: number;
  parentPid: number;
  processGroupId: number | null;
  sessionId: number | null;
  startTime: string | null;
}

interface ProcessTableSnapshot {
  entries: ProcessIdentity[];
}

interface ProcessTreeSnapshot {
  root: ProcessIdentity;
  descendants: ProcessIdentity[];
}

interface TerminationResult {
  ok: boolean;
  error: string;
}

function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  tree?: ProcessTreeSnapshot,
): Promise<TerminationResult> {
  if (child.pid === undefined)
    return Promise.resolve({
      ok: false,
      error: "the child process did not expose a PID",
    });
  if (!force && child.exitCode !== null)
    return Promise.resolve({ ok: true, error: "" });
  if (process.platform === "win32")
    return terminateWindowsProcessTree(child, force, tree);
  return terminatePosixProcessTree(child, force, tree);
}

async function terminateWindowsProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  tree?: ProcessTreeSnapshot,
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
  return await verifyAndTerminateWindows(child.pid, tree);
}

async function terminatePosixProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  tree?: ProcessTreeSnapshot,
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
  return await verifyAndTerminatePosix(child.pid, tree);
}

async function verifyExitedChild(
  child: ChildProcessWithoutNullStreams,
): Promise<TerminationResult> {
  if (child.pid === undefined || child.exitCode === null)
    return {
      ok: false,
      error: "the child process identity was unavailable before termination",
    };
  try {
    const table = await captureProcessTable();
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

async function verifyAndTerminateWindows(
  rootPid: number,
  tree: ProcessTreeSnapshot,
): Promise<TerminationResult> {
  let stableAbsentPasses = 0;
  const deadline = Date.now() + PROGRAM_QUIESCENCE_TIMEOUT_MS;
  let tracked = [tree.root, ...tree.descendants];
  while (Date.now() < deadline) {
    const table = await captureProcessTable();
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
      const currentRoot = table.entries.find(
        (candidate) => candidate.pid === tree.root.pid,
      );
      if (currentRoot !== undefined) {
        if (!identityMatches(tree.root, currentRoot))
          return {
            ok: false,
            error: `PID ${String(tree.root.pid)} identity changed; containment was not proven`,
          };
        const rootResult = await runTaskkill(rootPid, true);
        if (!rootResult.ok && rootResult.error !== "process was not found")
          return { ok: false, error: rootResult.error };
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
        const result = await runTaskkill(identity.pid, false);
        if (!result.ok && result.error !== "process was not found")
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

async function verifyAndTerminatePosix(
  rootPid: number,
  tree: ProcessTreeSnapshot,
): Promise<TerminationResult> {
  let stableAbsentPasses = 0;
  const deadline = Date.now() + PROGRAM_QUIESCENCE_TIMEOUT_MS;
  let tracked = [tree.root, ...tree.descendants];
  while (Date.now() < deadline) {
    const table = await captureProcessTable();
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

async function runTaskkill(
  pid: number,
  tree: boolean,
): Promise<{ ok: boolean; error: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killer: ReturnType<typeof spawn> | undefined;
    const finish = (value: { ok: boolean; error: string }): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    try {
      killer = spawn(
        "taskkill",
        tree ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
    } catch (error) {
      finish({ ok: false, error: describeError(error) });
      return;
    }
    timer = setTimeout(() => {
      killer?.kill("SIGKILL");
      finish({ ok: false, error: "taskkill timed out" });
    }, 750);
    killer.once("error", (error: unknown) =>
      finish({ ok: false, error: describeError(error) }),
    );
    killer.once("close", (code: number | null) =>
      finish(
        code === 0
          ? { ok: true, error: "" }
          : code === 128
            ? { ok: false, error: "process was not found" }
            : { ok: false, error: `taskkill exited with code ${String(code)}` },
      ),
    );
  });
}

function captureProcessTree(
  pid: number | undefined,
): Promise<ProcessTreeSnapshot> {
  if (pid === undefined)
    return Promise.reject(new Error("the child process did not expose a PID"));
  return captureProcessTable().then((table) => {
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
  const command = process.platform === "win32" ? "wmic.exe" : "ps";
  const args =
    process.platform === "win32"
      ? [
          "process",
          "get",
          "ProcessId,ParentProcessId,CreationDate",
          "/format:list",
        ]
      : ["-eo", "pid=,ppid=,pgid=,sid=,lstart="];
  const output = await new Promise<string>((resolve, reject) => {
    let text = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let processHandle: ReturnType<typeof spawn> | undefined;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error !== null) reject(error);
      else resolve(text);
    };
    try {
      processHandle = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      processHandle.stdout?.setEncoding("utf8");
      processHandle.stdout?.on("data", (chunk: string) => {
        if (text.length < 128 * 1024) text += chunk;
      });
      processHandle.once("error", (error: unknown) =>
        finish(new Error(describeError(error))),
      );
      processHandle.once("close", (code: number | null) => {
        if (code === 0) finish(null);
        else finish(new Error(`${command} exited with code ${String(code)}`));
      });
      timer = setTimeout(() => {
        processHandle?.kill("SIGKILL");
        finish(new Error(`${command} process-tree snapshot timed out`));
      }, 750);
    } catch (error) {
      finish(new Error(describeError(error)));
    }
  });
  return process.platform === "win32"
    ? parseWindowsProcessTable(output)
    : parsePosixProcessTable(output);
}

function parseWindowsProcessTable(output: string): ProcessTableSnapshot {
  const entries: ProcessIdentity[] = [];
  let record: {
    pid?: number;
    parentPid?: number;
    startTime?: string | null;
  } = {};
  const flush = (): void => {
    if (record.pid !== undefined && record.parentPid !== undefined)
      entries.push({
        pid: record.pid,
        parentPid: record.parentPid,
        processGroupId: null,
        sessionId: null,
        startTime: record.startTime ?? null,
      });
    record = {};
  };
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    const match = trimmed.match(
      /^(ProcessId|ParentProcessId|CreationDate)=(.*)$/u,
    );
    if (match === null) continue;
    if (match[1] === "ProcessId") record.pid = Number(match[2]!);
    else if (match[1] === "ParentProcessId")
      record.parentPid = Number(match[2]!);
    else record.startTime = match[2]!.trim() || null;
  }
  flush();
  return { entries };
}

function parsePosixProcessTable(output: string): ProcessTableSnapshot {
  const entries: ProcessIdentity[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u);
    if (match === null) continue;
    entries.push({
      pid: Number(match[1]!),
      parentPid: Number(match[2]!),
      processGroupId: Number(match[3]!),
      sessionId: Number(match[4]!),
      startTime: match[5]!.trim() || null,
    });
  }
  return { entries };
}

async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  fallback: T,
): Promise<T> {
  return await new Promise<T>((resolve) => {
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
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
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
