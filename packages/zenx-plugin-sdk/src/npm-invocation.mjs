import path from "node:path";

/**
 * Construct a shell-free npm invocation. Windows command shims cannot be
 * executed directly by execFile/spawn, so Node runs npm's JavaScript CLI.
 *
 * @param {readonly string[]} args
 * @param {{
 *   platform?: NodeJS.Platform;
 *   execPath?: string;
 *   npmExecPath?: string;
 * }} [options]
 * @returns {{ executable: string; args: string[] }}
 */
export function npmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { executable: "npm", args: [...args] };

  const execPath = options.execPath ?? process.execPath;
  const npmExecPath =
    options.npmExecPath ??
    process.env.npm_execpath ??
    path.win32.join(
      path.win32.dirname(execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
  if (!path.win32.isAbsolute(execPath) || !path.win32.isAbsolute(npmExecPath)) {
    throw new Error(
      "Windows npm execution requires absolute Node and npm CLI paths",
    );
  }
  if (!/\.(?:c?js|mjs)$/iu.test(npmExecPath)) {
    throw new Error("Windows npm execution requires npm's JavaScript CLI");
  }
  return { executable: execPath, args: [npmExecPath, ...args] };
}
