import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  TriggerProgramSpec,
  TriggerProgramStage,
} from "./trigger-types.js";

export const MAX_PROGRAM_INPUT_BYTES = 64 * 1024;
export const DEFAULT_PROGRAM_OUTPUT_BYTES = 64 * 1024;
export const MAX_PROGRAM_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_PROGRAM_TIMEOUT_MS = 30_000;
export const MAX_PROGRAM_TIMEOUT_MS = 120_000;
const PROGRAM_TERM_GRACE_MS = 250;
const PROGRAM_FORCE_SETTLEMENT_MS = 1_000;
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
      let settlementTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        if (settlementTimer !== undefined) clearTimeout(settlementTimer);
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
      const terminate = (force: boolean): void => {
        terminateProcessTree(child, force);
      };
      const requestTermination = (value: TriggerProgramRunResult): void => {
        if (settled || requested !== null) return;
        requested = value;
        stopCollection();
        child.stdin.destroy();
        terminate(false);
        forceTimer = setTimeout(() => {
          forceTimer = undefined;
          terminate(true);
          settlementTimer = setTimeout(
            () => finish(value),
            PROGRAM_FORCE_SETTLEMENT_MS,
          );
        }, PROGRAM_TERM_GRACE_MS);
      };
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
          if (forceTimer !== undefined) {
            clearTimeout(forceTimer);
            forceTimer = undefined;
            terminate(true);
          }
          finish(requested);
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

function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
): void {
  if (child.pid === undefined || (child.exitCode !== null && !force)) return;
  if (process.platform === "win32") {
    if (!force) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The bounded force phase below is the containment fallback.
      }
      return;
    }
    try {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => undefined);
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The settlement deadline remains bounded even if the OS rejects kill.
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // The bounded settlement deadline remains the final containment fence.
    }
  }
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
  if (value === null || value.length <= 2_048) return value;
  return `${value.slice(0, 2_024)}…[truncated]`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
