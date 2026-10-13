import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { verifyShellPtyPatch } from "../../scripts/shell-pty-patch.mjs";
import type {
  ShellPtyProcess,
  ShellPtyProvider,
} from "../../../../src/shell-session.js";

/** Keep platform-specific signal and native-resource cleanup inside the adapter. */
export function wrapDesktopPty(
  terminal: ShellPtyProcess,
  platform = process.platform,
): ShellPtyProcess {
  let windowsClosed = false;
  const closeWindows = () => {
    if (windowsClosed) return;
    // node-pty rejects POSIX signal arguments on Windows. Its public kill also
    // disposes the ConPTY reader worker after a natural shell exit. The pinned
    // dependency patch removes its unsafe asynchronous bare-PID sweep.
    terminal.kill();
    windowsClosed = true;
  };
  return {
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    onData: (listener) => terminal.onData(listener),
    onExit: (listener) =>
      terminal.onExit((event) => {
        if (platform === "win32") {
          try {
            closeWindows();
          } catch (error) {
            // The shell has already exited. Cleanup failure must not erase that
            // observation or escape node-pty's native event callback.
            process.emitWarning(
              `ConPTY cleanup after shell exit failed: ${String(error)}`,
              {
                code: "ZENX_PTY_EXIT_CLEANUP",
              },
            );
          }
        }
        listener(event);
      }),
    kill: (signal) => {
      if (platform === "win32") closeWindows();
      else terminal.kill(signal);
    },
  };
}

/** node-pty owns the platform PTY / Windows ConPTY; the tool task owns its life. */
export const desktopShellPty: ShellPtyProvider = {
  async spawn({ cwd, env, cols, rows }) {
    const windows = process.platform === "win32";
    if (windows) {
      // Only the pinned system-ConPTY path is audited. Reject before launching
      // rather than falling back to WinPTY or an unpatched PID-based cleanup.
      const [major, , build] = os.release().split(".").map(Number);
      if (major !== 10 || !Number.isInteger(build) || build! < 18309)
        throw new Error(
          "Interactive Windows Shell requires supported system ConPTY",
        );
      const require = createRequire(import.meta.url);
      await verifyShellPtyPatch(
        path.dirname(require.resolve("node-pty/package.json")),
      );
    }
    const pty = await import("node-pty");
    const file = windows ? "powershell.exe" : env.SHELL || "/bin/sh";
    return wrapDesktopPty(
      pty.spawn(file, windows ? ["-NoLogo"] : ["-i"], {
        cwd,
        env,
        cols,
        rows,
        name: "xterm-256color",
        ...(windows ? { useConpty: true, useConptyDll: false } : {}),
      }),
    );
  },
};
