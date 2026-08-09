import { spawn } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXCapabilityManifest, ZenXCapabilityPackage } from "./types.js";

interface LocalCapabilityFile extends ZenXCapabilityManifest {
  runtime: {
    type: "process";
    command: string;
    args?: string[];
    timeoutMs?: number;
  };
}

export async function discoverLocalCapabilityPackages(
  directory: string,
): Promise<{
  packages: ZenXCapabilityPackage[];
  errors: string[];
}> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { packages: [], errors: [] };
    }
    throw error;
  }
  const packages: ZenXCapabilityPackage[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const manifestPath = path.join(directory, entry.name);
    try {
      const parsed = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as unknown;
      if (!isLocalCapabilityFile(parsed)) {
        throw new Error("manifest shape is invalid");
      }
      packages.push(
        await ProcessZenXCapabilityPackage.create(parsed, manifestPath),
      );
    } catch (error) {
      errors.push(`${entry.name}: ${describeError(error)}`);
    }
  }
  return { packages, errors };
}

export class ProcessZenXCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXCapabilityManifest;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #cwd: string;
  readonly #timeoutMs: number;

  private constructor(
    manifest: ZenXCapabilityManifest,
    command: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
  ) {
    this.manifest = manifest;
    this.#command = command;
    this.#args = args;
    this.#cwd = cwd;
    this.#timeoutMs = timeoutMs;
  }

  static async create(
    definition: LocalCapabilityFile,
    manifestPath: string,
  ): Promise<ProcessZenXCapabilityPackage> {
    const directory = path.dirname(manifestPath);
    const requestedCommand = path.resolve(
      directory,
      definition.runtime.command,
    );
    const resolvedDirectory = await realpath(directory);
    const resolvedCommand = await realpath(requestedCommand);
    if (
      resolvedCommand !== resolvedDirectory &&
      !resolvedCommand.startsWith(`${resolvedDirectory}${path.sep}`)
    ) {
      throw new Error(
        "local capability command must stay inside its package directory",
      );
    }
    const { runtime: _runtime, ...manifest } = definition;
    return new ProcessZenXCapabilityPackage(
      manifest,
      resolvedCommand,
      definition.runtime.args ?? [],
      resolvedDirectory,
      Math.min(Math.max(definition.runtime.timeoutMs ?? 30_000, 100), 120_000),
    );
  }

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    invocation.signal.throwIfAborted();
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn(this.#command, this.#args, {
        cwd: this.#cwd,
        env: minimalEnvironment(process.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        invocation.signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = (): void => {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            invocation.signal.reason ??
              new DOMException("Aborted", "AbortError"),
          ),
        );
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(new Error(`Local capability ${this.manifest.id} timed out`)),
        );
      }, this.#timeoutMs);
      invocation.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024) stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.concat(stderr).length < 8 * 1024) stderr.push(chunk);
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => {
        finish(() => {
          if (code !== 0) {
            reject(
              new Error(
                `Local capability ${this.manifest.id} exited ${String(code)}: ${Buffer.concat(stderr).toString("utf8").slice(0, 2048)}`,
              ),
            );
            return;
          }
          if (bytes > 1024 * 1024) {
            reject(
              new Error(
                `Local capability ${this.manifest.id} exceeded its 1 MiB transport limit`,
              ),
            );
            return;
          }
          try {
            resolve(
              JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown,
            );
          } catch (error) {
            reject(
              new Error(
                `Local capability returned invalid JSON: ${describeError(error)}`,
              ),
            );
          }
        });
      });
      child.stdin.end(
        `${JSON.stringify({
          tool: toolName,
          arguments: invocation.arguments,
          context: { callId: invocation.callId, cwd: invocation.cwd },
        })}\n`,
      );
    });
  }
}

function isLocalCapabilityFile(value: unknown): value is LocalCapabilityFile {
  if (!isRecord(value) || !isRecord(value.runtime)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    typeof value.version === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.permissions) &&
    Array.isArray(value.tools) &&
    Array.isArray(value.resources) &&
    value.runtime.type === "process" &&
    typeof value.runtime.command === "string" &&
    (value.runtime.args === undefined ||
      (Array.isArray(value.runtime.args) &&
        value.runtime.args.every((entry) => typeof entry === "string")))
  );
}

function minimalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "LANG", "PATH", "SHELL", "TMPDIR"]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
