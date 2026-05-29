import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
      name: "read_file",
      description: "Read a UTF-8 text file relative to the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 text file relative to the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a workspace directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search workspace files with ripgrep.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a PowerShell command in the workspace.",
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

    if (call.name === "read_file") {
      return await readFile(this.workspacePath(readString(input.path, "path")), "utf8");
    }

    if (call.name === "write_file") {
      const filePath = this.workspacePath(readString(input.path, "path"));
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, readString(input.content, "content"), "utf8");
      return `wrote ${input.path}`;
    }

    if (call.name === "list_files") {
      const entries = await readdir(this.workspacePath(readString(input.path, "path")), {
        withFileTypes: true
      });
      return entries
        .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
        .join("\n");
    }

    if (call.name === "search_files") {
      const { stdout, stderr } = await execFileAsync(
        "rg",
        [
          "--line-number",
          "--no-heading",
          readString(input.pattern, "pattern"),
          readOptionalString(input.path) ?? "."
        ],
        { cwd: this.cwd, timeout: this.shellTimeoutMs, windowsHide: true }
      );
      return [stdout, stderr].filter(Boolean).join("\n").trim();
    }

    if (call.name === "shell") {
      const { stdout, stderr } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-Command", readString(input.command, "command")],
        { cwd: this.cwd, timeout: this.shellTimeoutMs, windowsHide: true }
      );
      return [stdout, stderr].filter(Boolean).join("\n").trim();
    }

    throw new Error(`Unknown tool: ${call.name}`);
  }

  private workspacePath(path: string): string {
    return resolve(this.cwd, path);
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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
