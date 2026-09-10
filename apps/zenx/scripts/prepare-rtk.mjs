import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export const RTK_BINARY_SHA256 =
  "8f79804b15fdedec85cf1f7a33b8a1c28350ef46f5595c5da932a8a64db03951";
export const RTK_ARCHIVE_SHA256 =
  "4fa025cc93a744b6963f4e53a008e5ba3f74b6a38061f4a47c639e1c3023e0db";
const archiveUrl =
  "https://github.com/rtk-ai/rtk/releases/download/v0.48.0/rtk-aarch64-apple-darwin.tar.gz";
const defaultDirectory = fileURLToPath(
  new URL("../resources", import.meta.url),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Build-time dependency only: never downloads, installs hooks, or changes PATH at runtime. */
export async function prepareRtkResource({
  resourcesDirectory = defaultDirectory,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== "darwin" || arch !== "arm64") return false;
  const destination = path.join(resourcesDirectory, "rtk");
  const binary = path.join(destination, "rtk");
  try {
    if (hash(await readFile(binary)) === RTK_BINARY_SHA256) return true;
  } catch {
    /* Missing build resource; fetch the pinned release below. */
  }
  await mkdir(resourcesDirectory, { recursive: true });
  const scratch = await mkdtemp(path.join(resourcesDirectory, ".rtk-build-"));
  try {
    const response = await fetch(archiveUrl, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`RTK download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (hash(archive) !== RTK_ARCHIVE_SHA256)
      throw new Error("RTK archive checksum mismatch");
    const tarball = path.join(scratch, "rtk.tar.gz");
    await writeFile(tarball, archive);
    // Extract only the fixed filename from an archive authenticated above.
    await run("tar", ["-xzf", tarball, "-C", scratch, "rtk"]);
    if (hash(await readFile(path.join(scratch, "rtk"))) !== RTK_BINARY_SHA256)
      throw new Error("RTK binary checksum mismatch");
    await chmod(path.join(scratch, "rtk"), 0o755);
    await mkdir(destination, { recursive: true });
    await copyFile(
      fileURLToPath(new URL("../resources/rtk-NOTICE.txt", import.meta.url)),
      path.join(destination, "NOTICE.txt"),
    );
    await rename(path.join(scratch, "rtk"), binary);
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await prepareRtkResource();
