import { spawn } from "node:child_process";

import type { ApprovalDecision } from "./item.js";
import type { ModelTool } from "./model.js";

export interface ToolInvocation {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  cwd: string;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  output: string;
  exitCode: number;
}

export interface ToolExecutor {
  readonly definitions: ModelTool[];
  execute(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}

export interface ApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  callId: string;
  command: string;
  cwd: string;
  signal: AbortSignal;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

export class ShellToolExecutor implements ToolExecutor {
  readonly definitions: ModelTool[] = [
    {
      name: "shell",
      description: "Run a shell command in the thread working directory.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ];

  readonly #maxOutputBytes: number;
  readonly #redactedValues: readonly string[];
  readonly #terminationGraceMs: number;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    options: {
      maxOutputBytes?: number;
      terminationGraceMs?: number;
      environment?: Readonly<NodeJS.ProcessEnv>;
      blockedEnvironmentVariables?: readonly string[];
      redactedValues?: readonly string[];
    } = {},
  ) {
    const sourceEnvironment = options.environment ?? process.env;
    const blockedEnvironmentVariables =
      options.blockedEnvironmentVariables ?? [];
    this.#maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    this.#redactedValues = Object.freeze(
      [
        ...(options.redactedValues ?? []),
        ...blockedEnvironmentVariables.map(
          (name) => sourceEnvironment[name] ?? "",
        ),
      ].filter((value, index, values) => {
        return value.length > 0 && values.indexOf(value) === index;
      }),
    );
    this.#terminationGraceMs = options.terminationGraceMs ?? 250;
    this.#environment = Object.freeze(
      sanitizeToolEnvironment(sourceEnvironment, blockedEnvironmentVariables),
    );
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    if (invocation.name !== "shell") {
      throw new Error(`Unsupported tool: ${invocation.name}`);
    }
    const command = invocation.arguments.command;
    if (typeof command !== "string" || command.length === 0) {
      throw new Error("shell.command must be a non-empty string");
    }
    invocation.signal.throwIfAborted();

    return await new Promise<ToolExecutionResult>((resolve, reject) => {
      const child = spawn(command, {
        cwd: invocation.cwd,
        env: this.#environment,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let terminationStarted = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const collect = (chunk: Buffer): void => {
        if (bytes >= this.#maxOutputBytes) {
          return;
        }
        const remaining = this.#maxOutputBytes - bytes;
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.length;
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const killProcessTree = (signal: NodeJS.Signals): void => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // The process group may already have exited. Fall back to the
            // direct child so a spawn race cannot leave it running.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // A concurrent exit is indistinguishable from successful cleanup.
        }
      };
      const abort = (): void => {
        if (terminationStarted) {
          return;
        }
        terminationStarted = true;
        killProcessTree("SIGTERM");
        forceKillTimer = setTimeout(() => {
          killProcessTree("SIGKILL");
          // A descendant can outlive the wrapper while retaining these file
          // descriptors. Closing our ends guarantees the invocation itself
          // cannot wait forever after the forced termination deadline.
          child.stdout.destroy();
          child.stderr.destroy();
          forceKillTimer = undefined;
          finishWithError(abortReason(invocation.signal));
        }, this.#terminationGraceMs);
      };
      const cleanup = (): void => {
        invocation.signal.removeEventListener("abort", abort);
        // Keep the forced group kill scheduled after an abort even if the
        // wrapper shell closes first; a descendant may have redirected its
        // stdio and still be alive in the same process group.
        if (!terminationStarted && forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
      };
      const finishWithError = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      invocation.signal.addEventListener("abort", abort, { once: true });
      if (invocation.signal.aborted) {
        abort();
      }

      child.once("error", (error) => {
        finishWithError(error);
      });
      child.once("close", (code, signal) => {
        if (settled) {
          return;
        }
        if (invocation.signal.aborted) {
          if (forceKillTimer !== undefined) {
            clearTimeout(forceKillTimer);
            forceKillTimer = undefined;
          }
          // `close` proves the wrapper and inherited pipes are gone, but a
          // descendant with redirected stdio may still occupy the group.
          killProcessTree("SIGKILL");
          finishWithError(abortReason(invocation.signal));
          return;
        }
        settled = true;
        cleanup();
        const suffix =
          bytes >= this.#maxOutputBytes ? "\n[output truncated by Zen]" : "";
        const output = redactValues(
          `${Buffer.concat(chunks).toString("utf8")}${suffix}`,
          this.#redactedValues,
        );
        resolve({
          output:
            signal === null ? output : `${output}\n[terminated by ${signal}]`,
          exitCode: code ?? 128,
        });
      });
    });
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

function redactValues(output: string, values: readonly string[]): string {
  let redacted = output;
  for (const value of values) {
    redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
}

const SAFE_ENVIRONMENT_VARIABLES = new Set([
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "WINDIR",
]);

/**
 * Shell tools get a deliberately small process environment. Provider keys and
 * unrelated host configuration must never become implicit model-visible input.
 */
export function sanitizeToolEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  blockedEnvironmentVariables: readonly string[] = [],
): NodeJS.ProcessEnv {
  const blocked = new Set(blockedEnvironmentVariables);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !blocked.has(name) &&
      (SAFE_ENVIRONMENT_VARIABLES.has(name) || name.startsWith("LC_"))
    ) {
      environment[name] = value;
    }
  }
  return environment;
}
