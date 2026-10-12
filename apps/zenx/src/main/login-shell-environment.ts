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
  const exitDelimiter = Buffer.from(`\0${marker}_EXIT\0`);
  // An absolute external printf avoids aliases/functions and works in the
  // supported login shells. Only PATH is printed, not a dump of exported keys.
  const command = `/usr/bin/printf '\\0${marker}\\0%s\\0${marker}\\0' "$PATH"`;
  // Keep a supervisor alive until we close its stdin or kill its group. A login
  // profile may leave background helpers holding stdout after its shell exits;
  // the supervisor pins the PGID so cleanup never signals a recycled identity.
  const supervisor = `"$@"
status=$?
/usr/bin/printf '\\0${marker}_EXIT\\0%d\\0' "$status"
exec /bin/cat >/dev/null`;
  return await new Promise<LoginShellPathResult>((resolve) => {
    let child: ReturnType<typeof childProcess.spawn>;
    try {
      child = childProcess.spawn(
        "/bin/sh",
        ["-c", supervisor, "zenx-login-shell", shell, "-ilc", command],
        {
          cwd: environment.HOME || "/",
          env: { ...environment, TERM: environment.TERM || "dumb" },
          detached: true,
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
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
        // The live supervisor pins this detached group even after the login
        // shell exits. Never signal its numeric PGID after the supervisor exits.
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // A failed kill cannot turn the bounded fallback into a hung launch.
          }
        }
      }
      child.stdin?.destroy();
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
    child.stdout?.on("error", () => finish("failed", true));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        finish("invalid-output", true);
        return;
      }
      chunks.push(chunk);
      const output = Buffer.concat(chunks);
      const exitStart = output.indexOf(exitDelimiter);
      if (exitStart < 0) return;
      const statusStart = exitStart + exitDelimiter.length;
      const statusEnd = output.indexOf(0, statusStart);
      if (statusEnd < 0) return;
      if (output.subarray(statusStart, statusEnd).toString("ascii") !== "0") {
        finish("failed", true);
        return;
      }
      const start = output.indexOf(delimiter);
      const end = output.indexOf(delimiter, start + delimiter.length);
      if (
        start < 0 ||
        end < 0 ||
        output.indexOf(delimiter, end + delimiter.length) !== -1
      ) {
        finish("invalid-output", true);
        return;
      }
      let path: string;
      try {
        path = new TextDecoder("utf-8", { fatal: true }).decode(
          output.subarray(start + delimiter.length, end),
        );
      } catch {
        finish("invalid-output", true);
        return;
      }
      if (path.includes("\0")) {
        finish("invalid-output", true);
        return;
      }
      if (signal?.aborted) {
        abort();
        return;
      }
      environment.PATH = path;
      finish("restored", true);
    });
    child.once("close", () => finish("failed"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
