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
export const RTK_BINARY_SHA256 =
  "8f79804b15fdedec85cf1f7a33b8a1c28350ef46f5595c5da932a8a64db03951";
export const RTK_ARCHIVE_SHA256 =
  "4fa025cc93a744b6963f4e53a008e5ba3f74b6a38061f4a47c639e1c3023e0db";
const defaultArchiveUrl =
  "https://github.com/rtk-ai/rtk/releases/download/v0.48.0/rtk-aarch64-apple-darwin.tar.gz";
const defaultDirectory = fileURLToPath(
  new URL("../resources", import.meta.url),
);
const defaultCacheDirectory = fileURLToPath(
  new URL("../.packaged/cache/rtk/v0.48.0/darwin-arm64", import.meta.url),
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
      artifactName: "RTK v0.48.0 darwin-arm64 archive",
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
