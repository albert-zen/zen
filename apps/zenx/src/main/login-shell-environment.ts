import childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { posix } from "node:path";

const MAX_OUTPUT_BYTES = 128 * 1024;
const TIMEOUT_MS = 5_000;

export type LoginShellPathResult =
  | "restored"
  | "skipped"
  | "unsupported-shell"
  | "failed"
  | "timed-out"
  | "invalid-output"
  | "cancelled";

/** Recover the GUI launch's PATH only; shell exports never become Host config. */
export async function restoreLoginShellPath(options: {
  environment: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fromTerminal?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LoginShellPathResult> {
  const { environment, signal } = options;
  if ((options.platform ?? process.platform) !== "darwin") return "skipped";
  const fromTerminal =
    options.fromTerminal ??
    Boolean(
      process.stdin.isTTY ||
      process.stdout.isTTY ||
      environment.TERM_PROGRAM ||
      (environment.TERM && environment.TERM !== "dumb"),
    );
  if (fromTerminal) return "skipped";
  if (signal?.aborted) return "cancelled";

  // SHELL is normally supplied by launchd. If absent, use the account's actual
  // login shell; zsh is the macOS default only when that lookup is unavailable.
  let shell = environment.SHELL;
  if (!shell) {
    try {
      shell = userInfo().shell ?? undefined;
    } catch {
      // Account lookup can fail in a restricted launch context.
    }
    shell ||= "/bin/zsh";
  }
  if (
    !posix.isAbsolute(shell) ||
    shell.includes("\0") ||
    !["zsh", "bash", "sh", "fish"].includes(posix.basename(shell))
  )
    return "unsupported-shell";

  const marker = `ZENX_PATH_${randomBytes(16).toString("hex")}`;
  const delimiter = Buffer.from(`\0${marker}\0`);
  // An absolute external printf avoids aliases/functions and works in the
  // supported login shells. Only PATH is printed, not a dump of exported keys.
  const command = `/usr/bin/printf '\\0${marker}\\0%s\\0${marker}\\0' "$PATH"`;
  return await new Promise<LoginShellPathResult>((resolve) => {
    let child: ReturnType<typeof childProcess.spawn>;
    try {
      child = childProcess.spawn(shell, ["-ilc", command], {
        cwd: environment.HOME || "/",
        env: { ...environment, TERM: environment.TERM || "dumb" },
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve("failed");
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: LoginShellPathResult, stop = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (stop && child.exitCode === null && child.signalCode === null) {
        // The detached shell owns this process group. Kill its startup helpers
        // too, while its live PID still identifies this particular child.
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      child.stdout?.destroy();
      child.unref();
      resolve(result);
    };
    const abort = (): void => finish("cancelled", true);
    const timer = setTimeout(
      () => finish("timed-out", true),
      Math.min(TIMEOUT_MS, Math.max(1, options.timeoutMs ?? TIMEOUT_MS)),
    );
    child.on("error", () => finish("failed", true));
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        finish("invalid-output", true);
        return;
      }
      chunks.push(chunk);
    });
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      if (code !== 0 || exitSignal !== null) {
        finish("failed");
        return;
      }
      const output = Buffer.concat(chunks);
      const start = output.indexOf(delimiter);
      const end = output.indexOf(delimiter, start + delimiter.length);
      if (
        start < 0 ||
        end < 0 ||
        output.indexOf(delimiter, end + delimiter.length) !== -1
      ) {
        finish("invalid-output");
        return;
      }
      let path: string;
      try {
        path = new TextDecoder("utf-8", { fatal: true }).decode(
          output.subarray(start + delimiter.length, end),
        );
      } catch {
        finish("invalid-output");
        return;
      }
      if (
        path.includes("\0") ||
        !path.split(":").every((entry) => posix.isAbsolute(entry))
      ) {
        finish("invalid-output");
        return;
      }
      if (signal?.aborted) {
        abort();
        return;
      }
      environment.PATH = path;
      finish("restored");
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
