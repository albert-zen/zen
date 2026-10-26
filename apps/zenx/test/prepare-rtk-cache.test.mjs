import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { prepareRtkResource } from "../scripts/prepare-rtk.mjs";

const run = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function temporaryDirectory(name) {
  return await mkdtemp(path.join(os.tmpdir(), `zen-${name}-`));
}

async function archiveContaining(binary) {
  const staging = await temporaryDirectory("rtk-archive");
  try {
    await writeFile(path.join(staging, "rtk"), binary);
    const archive = path.join(staging, "rtk.tar.gz");
    await run("tar", ["-czf", archive, "-C", staging, "rtk"]);
    return await readFile(archive);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

test("RTK resource is only fetched once for a pinned version", async () => {
  const root = await temporaryDirectory("rtk-cache");
  const binary = "#!/bin/sh\necho pinned rtk\n";
  const expectedBinarySha256 = sha256(Buffer.from(binary));
  try {
    const archive = await archiveContaining(binary);
    const expectedArchiveSha256 = sha256(archive);
    const cacheDirectory = path.join(root, "cache");
    const acquisitions = [];
    const acquireArchive = async (url, digest) => {
      acquisitions.push({ url, digest });
      return archive;
    };

    const first = await prepareRtkResource({
      resourcesDirectory: path.join(root, "resources-1"),
      cacheDirectory,
      platform: "darwin",
      arch: "arm64",
      expectedBinarySha256,
      expectedArchiveSha256,
      acquireArchive,
    });
    assert.equal(first, true);
    assert.equal(acquisitions.length, 1);
    assert.equal(acquisitions[0].digest, expectedArchiveSha256);
    assert.equal(
      await readFile(path.join(root, "resources-1", "rtk", "rtk"), "utf8"),
      binary,
    );
    assert.notEqual(
      (await stat(path.join(root, "resources-1", "rtk", "NOTICE.txt"))).size,
      0,
    );
    assert.equal(
      await readFile(path.join(cacheDirectory, "rtk"), "utf8"),
      binary,
    );

    const second = await prepareRtkResource({
      resourcesDirectory: path.join(root, "resources-2"),
      cacheDirectory,
      platform: "darwin",
      arch: "arm64",
      expectedBinarySha256,
      expectedArchiveSha256,
      acquireArchive: async () => {
        throw new Error("cache hit must not download the pinned archive");
      },
    });
    assert.equal(second, true);
    assert.equal(acquisitions.length, 1);
    assert.equal(
      await readFile(path.join(root, "resources-2", "rtk", "rtk"), "utf8"),
      binary,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RTK cache entries that do not match the pin are replaced", async () => {
  const root = await temporaryDirectory("rtk-cache-mismatch");
  const binary = "#!/bin/sh\necho pinned rtk\n";
  const expectedBinarySha256 = sha256(Buffer.from(binary));
  try {
    const cacheDirectory = path.join(root, "cache");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(path.join(cacheDirectory, "rtk"), "stale rtk");
    const archive = await archiveContaining(binary);
    let downloads = 0;

    await prepareRtkResource({
      resourcesDirectory: path.join(root, "resources"),
      cacheDirectory,
      platform: "darwin",
      arch: "arm64",
      expectedBinarySha256,
      expectedArchiveSha256: sha256(archive),
      acquireArchive: async () => {
        downloads += 1;
        return archive;
      },
    });

    assert.equal(downloads, 1);
    assert.equal(
      await readFile(path.join(cacheDirectory, "rtk"), "utf8"),
      binary,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RTK builds skip the resource on other platforms and reject bad archives", async () => {
  const root = await temporaryDirectory("rtk-cache-guard");
  try {
    assert.equal(
      await prepareRtkResource({
        resourcesDirectory: path.join(root, "resources"),
        cacheDirectory: path.join(root, "cache"),
        platform: "win32",
        arch: "x64",
        acquireArchive: async () => {
          throw new Error("other platforms must not download rtk");
        },
      }),
      false,
    );

    await assert.rejects(
      prepareRtkResource({
        resourcesDirectory: path.join(root, "resources"),
        cacheDirectory: path.join(root, "cache"),
        platform: "darwin",
        arch: "arm64",
        acquireArchive: async () => {
          throw new Error("RTK archive checksum mismatch");
        },
      }),
      /RTK archive checksum mismatch/,
    );
    assert.equal(
      await stat(path.join(root, "cache", "rtk")).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
