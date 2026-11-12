import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RTK_EXPERIMENT_SHA256 =
  "8f79804b15fdedec85cf1f7a33b8a1c28350ef46f5595c5da932a8a64db03951";

/** Trusted, bounded presentation dependency; never owns the shell command. */
export interface ShellOutputFilter {
  readonly id: string;
  readonly maxInputBytes: number;
  matches(command: string): boolean;
  filter(raw: string, signal: AbortSignal): Promise<string>;
}

/** Isolated macOS experiment. No Host or product enables this by default. */
export class RtkShellOutputFilter implements ShellOutputFilter {
  readonly maxInputBytes = 1024 * 1024;
  readonly id: string;
  readonly #executable: string;
  readonly #sha256: string;

  constructor(options: { executable: string; sha256: string }) {
    if (
      !path.isAbsolute(options.executable) ||
      options.sha256 !== RTK_EXPERIMENT_SHA256
    )
      throw new Error(
        "RTK experiment requires an absolute executable and the pinned v0.48.0 arm64 SHA256",
      );
    this.#executable = options.executable;
    this.#sha256 = options.sha256;
    this.id = `rtk/0.48.0/cargo-test/sha256:${options.sha256}`;
  }

  matches(command: string): boolean {
    return (
      process.platform === "darwin" &&
      process.arch === "arm64" &&
      /^cargo test(?: --offline)?$/u.test(command)
    );
  }

  async filter(raw: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (process.platform !== "darwin")
      throw new Error("RTK experiment is macOS-only");
    if (Buffer.byteLength(raw) > this.maxInputBytes)
      throw new Error("RTK input limit exceeded");
    if ((await stat(this.#executable)).size > 128 * 1024 * 1024)
      throw new Error("RTK executable exceeds verification limit");
    const hash = createHash("sha256")
      .update(await readFile(this.#executable))
      .digest("hex");
    if (hash !== this.#sha256) throw new Error("RTK executable hash mismatch");
    signal.throwIfAborted();
    const directory = await mkdtemp(path.join(os.tmpdir(), "zen-rtk-filter-"));
    try {
      return await new Promise<string>((resolve, reject) => {
        // Only the owned scratch directory is writable. No user's shell/profile
        // settings or RTK hooks are installed; filtering has no network access.
        const policy = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(directory)}))`;
        const child = spawn(
          "/usr/bin/sandbox-exec",
          ["-p", policy, this.#executable, "pipe", "--filter", "cargo-test"],
          {
            cwd: directory,
            env: {
              RTK_TELEMETRY_DISABLED: "1",
              RTK_DB_PATH: path.join(directory, "rtk.db"),
              RTK_TEE: "0",
              RTK_RECALL: "0",
              TMPDIR: directory,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const chunks: Buffer[] = [];
        let size = 0;
        let stderr = "";
        let failure: Error | undefined;
        const stop = (error: Error) => {
          failure ??= error;
          child.kill("SIGKILL");
        };
        const abort = () => stop(new Error("RTK filtering cancelled"));
        const timer = setTimeout(
          () => stop(new Error("RTK filtering timed out")),
          5_000,
        );
        signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.maxInputBytes)
            stop(new Error("RTK output limit exceeded"));
          else chunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(0, 4096);
        });
        child.stdin.on("error", (error) => {
          failure ??= error;
        });
        child.on("error", (error) => {
          failure ??= error;
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (failure !== undefined) reject(failure);
          else if (code !== 0)
            reject(new Error(`RTK filter exited ${String(code)}: ${stderr}`));
          else resolve(Buffer.concat(chunks).toString("utf8"));
        });
        if (signal.aborted) abort();
        else child.stdin.end(raw);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
