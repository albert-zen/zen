import { applyShellPtyPatch } from "./shell-pty-patch.mjs";
import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Prepare only the audited Windows cleanup or macOS spawn-helper permission. */
export async function prepareShellPty(
  directory,
  platform = process.platform,
  arch = process.arch,
) {
  if (platform === "win32") {
    await applyShellPtyPatch(directory);
    return;
  }
  if (platform !== "darwin") return;
  for (const candidate of [
    "build/Release",
    "build/Debug",
    `prebuilds/darwin-${arch}`,
  ]) {
    const helper = path.join(directory, candidate, "spawn-helper");
    if (
      await stat(helper).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      await chmod(helper, 0o755);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const require = createRequire(import.meta.url);
  await prepareShellPty(path.dirname(require.resolve("node-pty/package.json")));
}
