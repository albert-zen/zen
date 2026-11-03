import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const originalBlob = "95465f2ab89ce41a10553f58af83618f7310e83c";
export const patchedBlob = "252a9d5b23e271c089d30c357a78dff754f1c899";
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const patchPath = fileURLToPath(
  new URL("../patches/legend-list-3.3.5-react.patch", import.meta.url),
);
export function blobHash(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

/** Apply only the pinned upstream web ESM patch, never to a shared dependency tree. */
export function prepareLegendList({
  root = repositoryRoot,
  modulePath = fileURLToPath(import.meta.resolve("@legendapp/list/react")),
} = {}) {
  root = realpathSync(root);
  modulePath = resolve(modulePath);
  const directory = dirname(modulePath);
  if (
    realpathSync(modulePath) !== modulePath ||
    realpathSync(directory) !== directory
  )
    throw new Error(
      "Refusing to patch symlinked/shared LegendList; install dependencies inside this checkout.",
    );
  const localPath = relative(root, directory).split(sep).join("/");
  if (
    ![
      "node_modules/@legendapp/list",
      "apps/zenx/node_modules/@legendapp/list",
    ].includes(localPath)
  )
    throw new Error(
      "Refusing to patch LegendList outside this checkout's installed dependency.",
    );
  const before = blobHash(readFileSync(modulePath));
  if (before === patchedBlob) return "already patched";
  if (before !== originalBlob)
    throw new Error(
      `Unexpected LegendList web source ${before}; expected pinned 3.3.5. No patch applied.`,
    );
  const args = ["--directory=" + localPath, "--whitespace=nowarn", patchPath];
  execFileSync("git", ["apply", "--check", ...args], {
    cwd: root,
    stdio: "pipe",
  });
  execFileSync("git", ["apply", ...args], { cwd: root, stdio: "pipe" });
  if (blobHash(readFileSync(modulePath)) !== patchedBlob)
    throw new Error(
      "LegendList patch result does not match the exact upstream web blob.",
    );
  return "patched";
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(`LegendList web: ${prepareLegendList()}`);
