import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  electronDownloadOptions,
  parseChecksums,
} from "../scripts/prepare-electron-checksums.mjs";

const VERSION = "43.2.0";
const ARTIFACT = `electron-v${VERSION}-darwin-arm64.zip`;
const MANIFEST = [
  "a171d9b03328faf922a1046d822a7a318e8c5409932f16784e4df50c561ed867 *chromedriver-v43.2.0-darwin-arm64.zip",
  "ad4a0ae3c37ee05aa06c7e2ed0627608389790f0505a2b0d20319efbe33ffe28 *electron-v43.2.0-darwin-arm64.zip",
  "",
].join("\n");

test("Electron checksums are cached so later builds stay offline", async () => {
  const cacheDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-electron-checksums-"),
  );
  try {
    const downloads = [];
    const first = await electronDownloadOptions({
      version: VERSION,
      platform: "darwin",
      arch: "arm64",
      cacheDirectory,
      acquireChecksums: async (url) => {
        downloads.push(url);
        return MANIFEST;
      },
    });
    assert.deepEqual(downloads, [
      "https://github.com/electron/electron/releases/download/v43.2.0/SHASUMS256.txt",
    ]);
    assert.equal(
      first.checksums[ARTIFACT],
      "ad4a0ae3c37ee05aa06c7e2ed0627608389790f0505a2b0d20319efbe33ffe28",
    );

    const second = await electronDownloadOptions({
      version: VERSION,
      platform: "darwin",
      arch: "arm64",
      cacheDirectory,
      acquireChecksums: async () => {
        throw new Error("cached checksums must not be fetched again");
      },
    });
    assert.deepEqual(second.checksums, first.checksums);
    assert.equal(
      await readFile(
        path.join(cacheDirectory, `electron-v${VERSION}.SHASUMS256.txt`),
        "utf8",
      ),
      MANIFEST,
    );
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test("Electron checksums are refetched when the cache lacks the artifact", async () => {
  const cacheDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-electron-checksums-stale-"),
  );
  try {
    await writeFile(
      path.join(cacheDirectory, `electron-v${VERSION}.SHASUMS256.txt`),
      "0000000000000000000000000000000000000000000000000000000000000000 *ffmpeg-v43.2.0-darwin-arm64.zip\n",
      "utf8",
    );
    let downloads = 0;
    const options = await electronDownloadOptions({
      version: VERSION,
      platform: "darwin",
      arch: "arm64",
      cacheDirectory,
      acquireChecksums: async () => {
        downloads += 1;
        return MANIFEST;
      },
    });
    assert.equal(downloads, 1);
    assert.notEqual(options.checksums[ARTIFACT], undefined);
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test("Electron checksums reject manifests without the requested artifact", async () => {
  const cacheDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-electron-checksums-missing-"),
  );
  try {
    await assert.rejects(
      electronDownloadOptions({
        version: VERSION,
        platform: "linux",
        arch: "arm64",
        cacheDirectory,
        acquireChecksums: async () => MANIFEST,
      }),
      /do not cover electron-v43\.2\.0-linux-arm64\.zip/,
    );
    await assert.rejects(
      electronDownloadOptions({
        version: VERSION,
        platform: "darwin",
        arch: "arm64",
        cacheDirectory,
        acquireChecksums: async () => "not a checksums file",
      }),
      /contained no entries/,
    );
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test("parseChecksums accepts both manifest separators", () => {
  assert.deepEqual(parseChecksums(MANIFEST), {
    "chromedriver-v43.2.0-darwin-arm64.zip":
      "a171d9b03328faf922a1046d822a7a318e8c5409932f16784e4df50c561ed867",
    [ARTIFACT]:
      "ad4a0ae3c37ee05aa06c7e2ed0627608389790f0505a2b0d20319efbe33ffe28",
  });
  assert.deepEqual(
    parseChecksums(
      "ad4a0ae3c37ee05aa06c7e2ed0627608389790f0505a2b0d20319efbe33ffe28  electron-v43.2.0-darwin-arm64.zip\n",
    ),
    {
      [ARTIFACT]:
        "ad4a0ae3c37ee05aa06c7e2ed0627608389790f0505a2b0d20319efbe33ffe28",
    },
  );
});
