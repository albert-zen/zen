import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ToolCallPayload,
  ToolExecutionContext,
  ToolRuntime,
  ToolRuntimeEvent
} from "./tool-runtime.js";

const execFileAsync = promisify(execFile);

export type LocalToolRuntimeOptions = {
  readonly cwd?: string;
  readonly shellTimeoutMs?: number;
};

export const localToolDefinitions = [
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run a PowerShell command in the workspace. Use this for reading files, searching with rg, editing files, and running tests.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  }
] as const;

export class LocalToolRuntime implements ToolRuntime {
  private readonly cwd: string;
  private readonly shellTimeoutMs: number;

  constructor(options: LocalToolRuntimeOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.shellTimeoutMs = options.shellTimeoutMs ?? 30_000;
  }

  async *execute(
    call: ToolCallPayload,
    _context: ToolExecutionContext
  ): AsyncIterable<ToolRuntimeEvent> {
    try {
      yield { type: "output.delta", delta: `running ${call.name}` };
      yield {
        type: "result.completed",
        content: await this.executeCall(call)
      };
    } catch (error) {
      yield { type: "error", error };
    }
  }

  private async executeCall(call: ToolCallPayload): Promise<string> {
    const input = readObject(call.input);

    if (call.name === "shell") {
      return await this.runShell(readString(input.command, "command"));
    }

    throw new Error(`Unknown tool: ${call.name}`);
  }

  private async runShell(command: string): Promise<string> {
    const result = await execFileWithOutput(
      "powershell",
      ["-NoProfile", "-Command", command],
      { cwd: this.cwd, timeout: this.shellTimeoutMs, windowsHide: true }
    );

    return [
      `exitCode: ${result.exitCode}`,
      result.stdout ? `stdout:\n${result.stdout.trimEnd()}` : undefined,
      result.stderr ? `stderr:\n${result.stderr.trimEnd()}` : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }
}

type ExecFileResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

async function execFileWithOutput(
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeout: number;
    readonly windowsHide: boolean;
  }
): Promise<ExecFileResult> {
  try {
    const result = await execFileAsync(file, [...args], options);

    return {
      exitCode: 0,
      stdout: stringifyOutput(result.stdout),
      stderr: stringifyOutput(result.stderr)
    };
  } catch (cause) {
    if (isExecFileError(cause)) {
      return {
        exitCode: typeof cause.code === "number" ? cause.code : null,
        stdout: stringifyOutput(cause.stdout),
        stderr: stringifyOutput(cause.stderr)
      };
    }

    throw cause;
  }
}

function readObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readString(value: unknown, label: string): string {
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`${label} must be a string`);
}

function isExecFileError(
  value: unknown
): value is Error & { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown } {
  return typeof value === "object" && value !== null && "stdout" in value;
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }

  return value === undefined || value === null ? "" : String(value);
}
