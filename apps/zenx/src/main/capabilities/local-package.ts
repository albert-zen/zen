import { spawn } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { ToolInvocation } from "../../../../../src/tool.js";
import {
  MAX_CAPABILITY_OUTPUT_BYTES,
  MIN_CAPABILITY_OUTPUT_BYTES,
  type ZenXCapabilityManifest,
  type ZenXCapabilityPackage,
} from "./types.js";

type LocalCapabilityFile =
  | (Extract<ZenXCapabilityManifest, { schemaVersion: 1 }> & {
      runtime: {
        type: "process";
        command: string;
        args?: string[];
        timeoutMs?: number;
      };
    })
  | Extract<ZenXCapabilityManifest, { schemaVersion: 2 }>;

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
    if (
      definition.schemaVersion === 2 &&
      definition.runtime.type !== "process"
    ) {
      throw new Error("Local plugin runtime must be process-backed");
    }
    const directory = path.dirname(manifestPath);
    const requestedCommand = path.resolve(
      directory,
      definition.schemaVersion === 2
        ? definition.runtime.entry
        : definition.runtime.command,
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
    const manifest: ZenXCapabilityManifest =
      definition.schemaVersion === 2
        ? definition
        : (({ runtime: _runtime, ...capabilityManifest }) =>
            capabilityManifest)(definition);
    const runtime = definition.runtime;
    const runtimeArgs = "args" in runtime ? (runtime.args ?? []) : [];
    const runtimeTimeoutMs =
      "timeoutMs" in runtime ? (runtime.timeoutMs ?? 30_000) : 30_000;
    return new ProcessZenXCapabilityPackage(
      manifest,
      resolvedCommand,
      runtimeArgs,
      resolvedDirectory,
      Math.min(Math.max(runtimeTimeoutMs, 100), 120_000),
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
  if (!isRecord(value) || !isRecord(value.runtime) || !isRecord(value.provider))
    return false;
  return (
    (value.schemaVersion === 1 || value.schemaVersion === 2) &&
    typeof value.id === "string" &&
    (value.schemaVersion === 2
      ? typeof value.name === "string" &&
        isRecord(value.compatibility) &&
        typeof value.compatibility.zenx === "string" &&
        typeof value.mainDocument === "string"
      : typeof value.displayName === "string") &&
    typeof value.version === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.permissions) &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (tool) =>
        isRecord(tool) &&
        (tool.maxOutputBytes === undefined ||
          (Number.isSafeInteger(tool.maxOutputBytes) &&
            (tool.maxOutputBytes as number) >= MIN_CAPABILITY_OUTPUT_BYTES &&
            (tool.maxOutputBytes as number) <= MAX_CAPABILITY_OUTPUT_BYTES)),
    ) &&
    Array.isArray(value.resources) &&
    typeof value.provider.id === "string" &&
    Array.isArray(value.provider.platforms) &&
    value.provider.platforms.every((entry) => typeof entry === "string") &&
    Array.isArray(value.provider.interactionModes) &&
    value.provider.interactionModes.every(
      (entry) =>
        entry === "background_safe" ||
        entry === "foreground_required" ||
        entry === "isolated",
    ) &&
    Array.isArray(value.provider.capabilities) &&
    value.provider.capabilities.every((entry) => typeof entry === "string") &&
    value.runtime.type === "process" &&
    (value.schemaVersion === 2
      ? typeof value.runtime.entry === "string"
      : typeof value.runtime.command === "string") &&
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
