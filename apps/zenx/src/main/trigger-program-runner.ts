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
const PROGRAM_FORCE_SETTLEMENT_MS = 1_000;
const PROGRAM_QUIESCENCE_MS = 100;
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
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const finish = (value: TriggerProgramRunResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        stopCollection();
        child.stdin.destroy();
        resolve(value);
      };
      const forceAndFinish = async (): Promise<void> => {
        if (settled || requested === null || forceStarted) return;
        forceStarted = true;
        if (forceTimer !== undefined) {
          clearTimeout(forceTimer);
          forceTimer = undefined;
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
        await delay(PROGRAM_QUIESCENCE_MS);
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
        if (process.platform === "win32") {
          termination = captureProcessTree(child.pid)
            .then((tree) => {
              capturedTree = tree;
              return terminateProcessTree(child, false, tree);
            })
            .catch(async (error: unknown) => {
              await terminateProcessTree(child, false);
              return {
                ok: false as const,
                error: `process-tree snapshot unavailable: ${describeError(error)}`,
              };
            });
        } else {
          termination = captureProcessTree(child.pid)
            .then((tree) => {
              capturedTree = tree;
              return terminateProcessTree(child, false, tree);
            })
            .catch(async (error: unknown) => {
              await terminateProcessTree(child, false);
              return {
                ok: false as const,
                error: `process-tree snapshot unavailable: ${describeError(error)}`,
              };
            });
        }
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

interface ProcessTreeSnapshot {
  descendants: number[];
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
  const errors: string[] = [];
  const root = await runTaskkill(child.pid, true);
  if (!root.ok && root.error !== "process was not found")
    errors.push(root.error);
  for (const pid of tree?.descendants ?? []) {
    const result = await runTaskkill(pid, true);
    if (!result.ok && result.error !== "process was not found")
      errors.push(`PID ${String(pid)}: ${result.error}`);
  }
  return errors.length === 0
    ? { ok: true, error: "" }
    : { ok: false, error: errors.join("; ") };
}

async function terminatePosixProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  tree?: ProcessTreeSnapshot,
): Promise<TerminationResult> {
  if (child.pid === undefined)
    return { ok: false, error: "the child process did not expose a PID" };
  const signal = force ? "SIGKILL" : "SIGTERM";
  const errors: string[] = [];
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") errors.push(describeError(error));
  }
  if (force) {
    for (const pid of tree?.descendants ?? []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH")
          errors.push(`PID ${String(pid)}: ${describeError(error)}`);
      }
    }
  }
  return errors.length === 0
    ? { ok: true, error: "" }
    : { ok: false, error: errors.join("; ") };
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
  if (process.platform === "win32")
    return captureProcessTreeWithCommand(
      "wmic.exe",
      ["process", "get", "ProcessId,ParentProcessId", "/format:list"],
      pid,
    );
  return captureProcessTreeWithCommand("ps", ["-eo", "pid=,ppid="], pid);
}

async function captureProcessTreeWithCommand(
  command: string,
  args: string[],
  rootPid: number,
): Promise<ProcessTreeSnapshot> {
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
  const relationships: Array<[number, number]> = [];
  let processId: number | undefined;
  let parentProcessId: number | undefined;
  for (const line of output.split(/\r?\n/u)) {
    const processMatch = line.trim().match(/^ProcessId=(\d+)$/u);
    const parentMatch = line.trim().match(/^ParentProcessId=(\d+)$/u);
    const csvMatch = line.trim().match(/^(\d+)[,\s]+(\d+)$/u);
    if (processMatch !== null) processId = Number(processMatch[1]);
    else if (parentMatch !== null) parentProcessId = Number(parentMatch[1]);
    else if (csvMatch !== null)
      relationships.push([Number(csvMatch[1]), Number(csvMatch[2])]);
    else if (
      line.trim() === "" &&
      processId !== undefined &&
      parentProcessId !== undefined
    ) {
      relationships.push([processId, parentProcessId]);
      processId = undefined;
      parentProcessId = undefined;
    }
  }
  if (processId !== undefined && parentProcessId !== undefined)
    relationships.push([processId, parentProcessId]);
  const descendants = new Set<number>();
  let parents = new Set<number>([rootPid]);
  while (parents.size > 0) {
    const next = new Set<number>();
    for (const [childPid, parentPid] of relationships) {
      if (
        parents.has(parentPid) &&
        childPid !== rootPid &&
        !descendants.has(childPid)
      ) {
        descendants.add(childPid);
        next.add(childPid);
      }
    }
    parents = next;
  }
  return { descendants: [...descendants] };
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
