import { readFileSync } from "node:fs";
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
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { acquireVerifiedArtifact } from "../../../scripts/verified-artifact-acquisition.mjs";

const run = promisify(execFile);
const rtkLock = JSON.parse(
  readFileSync(
    new URL("../../../scripts/desktop-archives.lock.json", import.meta.url),
    "utf8",
  ),
).rtk;
export const RTK_BINARY_SHA256 = rtkLock.binarySha256;
export const RTK_ARCHIVE_SHA256 = rtkLock.archiveSha256;
const defaultArchiveUrl = rtkLock.url;
const defaultDirectory = fileURLToPath(
  new URL("../resources", import.meta.url),
);
const defaultCacheDirectory = fileURLToPath(
  new URL(
    `../.packaged/cache/rtk/v${rtkLock.version}/darwin-arm64`,
    import.meta.url,
  ),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Build-time dependency only: never downloads, installs hooks, or changes PATH at runtime. */
export async function prepareRtkResource({
  resourcesDirectory = defaultDirectory,
  cacheDirectory = defaultCacheDirectory,
  platform = process.platform,
  arch = process.arch,
  archiveUrl = defaultArchiveUrl,
  expectedArchiveSha256 = RTK_ARCHIVE_SHA256,
  expectedBinarySha256 = RTK_BINARY_SHA256,
} = {}) {
  if (platform !== "darwin" || arch !== "arm64") return false;
  const destination = path.join(resourcesDirectory, "rtk");
  const binary = path.join(destination, "rtk");
  let cached = false;
  try {
    cached = hash(await readFile(binary)) === expectedBinarySha256;
  } catch {
    /* Missing build resource; fetch the pinned release below. */
  }
  if (cached) {
    await chmod(binary, 0o755);
    await copyFile(
      fileURLToPath(new URL("../resources/rtk-NOTICE.txt", import.meta.url)),
      path.join(destination, "NOTICE.txt"),
    );
    return true;
  }
  await mkdir(resourcesDirectory, { recursive: true });
  const scratch = await mkdtemp(path.join(resourcesDirectory, ".rtk-build-"));
  try {
    const tarball = await acquireVerifiedArtifact({
      artifactName: `RTK v${rtkLock.version} darwin-arm64 archive`,
      url: archiveUrl,
      digest: expectedArchiveSha256,
      deadline: Date.now() + 60_000,
      cacheLocation: cacheDirectory,
      redirectOrigins: ["https://release-assets.githubusercontent.com"],
    });
    // Extract only the fixed filename from an archive authenticated above.
    await run("tar", ["-xzf", tarball, "-C", scratch, "rtk"], {
      timeout: 60_000,
    });
    if (
      hash(await readFile(path.join(scratch, "rtk"))) !== expectedBinarySha256
    )
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
