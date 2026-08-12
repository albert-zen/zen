import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export interface ExternalProviderProcessResult {
  stdout: string;
  stderr: string;
}

export type ProviderLaunchBinding = () => Promise<void>;

export interface ExternalProviderProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: {
      cwd?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      maxOutputBytes?: number;
      runtimeExecutable?: string;
      bindBeforeSpawn?: () => Promise<ProviderLaunchBinding>;
      verifyBeforeSpawn?: () => Promise<void>;
    },
  ): Promise<ExternalProviderProcessResult>;
}

const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export class SystemExternalProviderProcessRunner implements ExternalProviderProcessRunner {
  async run(
    executable: string,
    args: readonly string[],
    options: {
      cwd?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      maxOutputBytes?: number;
      runtimeExecutable?: string;
      bindBeforeSpawn?: () => Promise<ProviderLaunchBinding>;
      verifyBeforeSpawn?: () => Promise<void>;
    },
  ): Promise<ExternalProviderProcessResult> {
    options.signal?.throwIfAborted();
    const maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES;
    const invocation = await resolveExternalProviderInvocation(
      executable,
      process.env,
      options.runtimeExecutable,
    );
    await options.verifyBeforeSpawn?.();
    const releaseBinding = await options.bindBeforeSpawn?.();
    return await new Promise((resolve, reject) => {
      const child = spawn(
        invocation.executable,
        [...invocation.argumentPrefix, ...args],
        {
          cwd: options.cwd,
          env: providerProcessEnvironment(process.env),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        void Promise.resolve(releaseBinding?.()).catch(() => undefined);
        callback();
      };
      const fail = (error: unknown): void => {
        child.kill("SIGKILL");
        finish(() => reject(error));
      };
      const collect = (target: Buffer[], chunk: Buffer): void => {
        totalBytes += chunk.length;
        if (totalBytes > maxOutputBytes) {
          fail(
            new Error(
              `${path.basename(executable)} exceeded the ${String(maxOutputBytes)} byte output limit`,
            ),
          );
          return;
        }
        target.push(chunk);
      };
      const timer = setTimeout(() => {
        fail(
          new Error(
            `${path.basename(executable)} timed out after ${String(options.timeoutMs)}ms`,
          ),
        );
      }, options.timeoutMs);
      timer.unref();
      const abort = (): void => {
        fail(
          options.signal?.reason ??
            new DOMException("External provider call cancelled", "AbortError"),
        );
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => fail(error));
      child.once("close", (code, signal) => {
        finish(() => {
          const output = Buffer.concat(stdout).toString("utf8");
          const diagnostic = Buffer.concat(stderr).toString("utf8");
          if (code === 0) {
            resolve({ stdout: output, stderr: diagnostic });
            return;
          }
          reject(
            new Error(
              `${path.basename(executable)} failed (${signal ?? String(code)}): ${redactExternalDiagnostic(diagnostic || output)}`,
            ),
          );
        });
      });
      if (options.signal?.aborted === true) abort();
    });
  }
}

interface ExternalProviderInvocation {
  executable: string;
  argumentPrefix: string[];
}

async function resolveExternalProviderInvocation(
  executable: string,
  environment: NodeJS.ProcessEnv,
  runtimeExecutable?: string,
): Promise<ExternalProviderInvocation> {
  if (runtimeExecutable !== undefined) {
    if (!path.isAbsolute(runtimeExecutable)) {
      throw new Error("Bundled provider runtime must be an absolute path");
    }
    if (!(await isExecutable(runtimeExecutable))) {
      throw new Error("Bundled provider runtime is not executable");
    }
    if (!path.isAbsolute(executable)) {
      throw new Error("Bundled provider executable must be an absolute path");
    }
    return { executable: runtimeExecutable, argumentPrefix: [executable] };
  }
  if (
    process.platform !== "win32" ||
    path.extname(executable).toLowerCase() !== ".cmd"
  ) {
    return { executable, argumentPrefix: [] };
  }
  const source = await readFile(executable, "utf8");
  const entry = parseWindowsNpmShimEntry(source);
  if (entry === undefined) {
    throw new Error(
      `${path.basename(executable)} is not a supported npm Node command shim`,
    );
  }
  const segments = entry.split(/[\\/]+/u);
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `${path.basename(executable)} contains an unsafe shim entry`,
    );
  }
  const script = path.resolve(path.dirname(executable), ...segments);
  const relative = path.relative(path.dirname(executable), script);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `${path.basename(executable)} resolves outside its npm prefix`,
    );
  }
  await access(script);
  const siblingNode = path.join(path.dirname(executable), "node.exe");
  const nodeExecutable =
    runtimeExecutable ??
    ((await isExecutable(siblingNode))
      ? siblingNode
      : await discoverExecutable("node", {
          environment,
          platform: "win32",
        }));
  if (nodeExecutable === undefined) {
    throw new Error(
      `Cannot execute ${path.basename(executable)} without node.exe`,
    );
  }
  return { executable: nodeExecutable, argumentPrefix: [script] };
}

export function parseWindowsNpmShimEntry(source: string): string | undefined {
  return source.match(/%dp0%[\\/]([^"\r\n]+?\.js)(?:"|\s|$)/iu)?.[1];
}

export async function discoverExecutable(
  command: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): Promise<string | undefined> {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return (await isExecutable(command)) ? command : undefined;
  }
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const directories = (environment.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  const extensions =
    platform === "win32"
      ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export function parseExternalJson(
  provider: string,
  output: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${provider} returned invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${provider} returned a non-object JSON response`);
  }
  return parsed as Record<string, unknown>;
}

function providerProcessEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "SystemRoot",
    "WINDIR",
    "LOCALAPPDATA",
    "USERPROFILE",
    "PLAYWRIGHT_BROWSERS_PATH",
  ];
  return Object.fromEntries(
    keys.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
}

function redactExternalDiagnostic(value: string): string {
  return value
    .trim()
    .slice(0, 2048)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|password|secret))=\S+/giu,
      "$1=[REDACTED]",
    );
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === "win32" ? undefined : 0o1);
    return true;
  } catch {
    return false;
  }
}
