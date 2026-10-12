import type { ShellPtyProvider } from "../../../../src/shell-session.js";

/** node-pty owns the platform PTY / Windows ConPTY; the tool task owns its life. */
export const desktopShellPty: ShellPtyProvider = {
  async spawn({ cwd, env, cols, rows }) {
    const pty = await import("node-pty");
    const windows = process.platform === "win32";
    const file = windows ? "powershell.exe" : env.SHELL || "/bin/sh";
    return pty.spawn(file, windows ? ["-NoLogo"] : ["-i"], {
      cwd,
      env,
      cols,
      rows,
      name: "xterm-256color",
    });
  },
};
