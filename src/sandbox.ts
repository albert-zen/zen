import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SandboxMode } from "./item.js";

/** Resolve existing ancestors too, so new files cannot escape through a symlink. */
async function resolvedPath(filename: string): Promise<string> {
  try {
    return await realpath(filename);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(await resolvedPath(parent), path.basename(filename));
  }
}

/** File policy for trusted in-process builtins, sharing the shell's writable root. */
export async function assertWritablePaths(
  mode: SandboxMode,
  cwd: string,
  filenames: readonly string[],
): Promise<void> {
  if (mode === "danger-full-access") return;
  if (mode === "read-only")
    throw new Error(
      "Read Only does not allow file changes. Request approval through shell sandbox_permissions: require_escalated if a write is needed.",
    );
  const root = await realpath(cwd);
  for (const filename of filenames) {
    const relative = path.relative(
      root,
      await resolvedPath(path.resolve(cwd, filename)),
    );
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Workspace Write cannot modify ${filename}. Request approval through shell sandbox_permissions: require_escalated if needed.`,
      );
    }
  }
}

/** OS file containment; unsupported hosts fail closed without running the command. */
export async function sandboxCommand(
  mode: SandboxMode,
  cwd: string,
  command: string,
): Promise<{ file: string; args: string[] }> {
  if (mode === "danger-full-access") return { file: command, args: [] };
  const root = await realpath(cwd);
  if (process.platform === "darwin") {
    const quote = (value: string) =>
      `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      '(allow file-write* (literal "/dev/null"))',
    ];
    if (mode === "workspace-write")
      profile.push(`(allow file-write* (subpath ${quote(root)}))`);
    return {
      file: "/usr/bin/sandbox-exec",
      args: ["-p", profile.join(" "), "/bin/sh", "-c", command],
    };
  }
  if (process.platform === "linux") {
    const args = [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--die-with-parent",
    ];
    if (mode === "workspace-write") args.push("--bind", root, root);
    return { file: "bwrap", args: [...args, "--", "/bin/sh", "-c", command] };
  }
  throw new Error(
    `File sandbox is unavailable on ${process.platform}. Request approval with sandbox_permissions: require_escalated to run this command.`,
  );
}
