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
const defaultCacheDirectory = fileURLToPath(
  new URL("../.packaged/cache/rtk", import.meta.url),
);
const noticeFile = fileURLToPath(
  new URL("../resources/rtk-NOTICE.txt", import.meta.url),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function matchesPin(file, digest) {
  try {
    return hash(await readFile(file)) === digest;
  } catch {
    return false;
  }
}

async function copyNotice(destination) {
  await copyFile(noticeFile, path.join(destination, "NOTICE.txt"));
}

async function downloadArchive(url, digest) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok)
    throw new Error(`RTK download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (hash(archive) !== digest)
    throw new Error("RTK archive checksum mismatch");
  return archive;
}

/**
 * Build-time dependency only: never downloads, installs hooks, or changes PATH at
 * runtime. The pinned release is fetched once and then reused from the build
 * cache, so a pinned toolchain does not need network access on every build.
 */
export async function prepareRtkResource({
  resourcesDirectory = defaultDirectory,
  cacheDirectory = defaultCacheDirectory,
  platform = process.platform,
  arch = process.arch,
  expectedBinarySha256 = RTK_BINARY_SHA256,
  expectedArchiveSha256 = RTK_ARCHIVE_SHA256,
  acquireArchive = downloadArchive,
} = {}) {
  if (platform !== "darwin" || arch !== "arm64") return false;
  const destination = path.join(resourcesDirectory, "rtk");
  const binary = path.join(destination, "rtk");
  if (await matchesPin(binary, expectedBinarySha256)) {
    await chmod(binary, 0o755);
    await copyNotice(destination);
    return true;
  }
  const cachedBinary = path.join(cacheDirectory, "rtk");
  if (await matchesPin(cachedBinary, expectedBinarySha256)) {
    await mkdir(destination, { recursive: true });
    await copyFile(cachedBinary, binary);
    await chmod(binary, 0o755);
    await copyNotice(destination);
    return true;
  }
  const archive = await acquireArchive(archiveUrl, expectedArchiveSha256);
  await mkdir(resourcesDirectory, { recursive: true });
  const scratch = await mkdtemp(path.join(resourcesDirectory, ".rtk-build-"));
  try {
    const tarball = path.join(scratch, "rtk.tar.gz");
    await writeFile(tarball, archive);
    // Extract only the fixed filename from an archive authenticated above.
    await run("tar", ["-xzf", tarball, "-C", scratch, "rtk"]);
    const extracted = path.join(scratch, "rtk");
    if (!(await matchesPin(extracted, expectedBinarySha256)))
      throw new Error("RTK binary checksum mismatch");
    await chmod(extracted, 0o755);
    await mkdir(destination, { recursive: true });
    await copyNotice(destination);
    await rename(extracted, binary);
    await mkdir(cacheDirectory, { recursive: true });
    const staged = path.join(
      cacheDirectory,
      `.rtk-${process.pid}-${Date.now()}`,
    );
    await copyFile(binary, staged);
    await chmod(staged, 0o755);
    await rename(staged, cachedBinary);
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
