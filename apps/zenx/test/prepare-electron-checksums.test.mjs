import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadArtifact } from "@electron/get";
import {
  ELECTRON_VERSION,
  electronDownloadOptions,
} from "../scripts/prepare-electron-checksums.mjs";

const artifactName = `electron-v${ELECTRON_VERSION}-darwin-arm64.zip`;
const bytes = Buffer.from(
  "Synthetic ZIP fixture: never extracted or executed.",
);
const digest = createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-electron-checksums-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: ELECTRON_VERSION }),
  );
  await writeFile(
    path.join(root, "checksums.json"),
    JSON.stringify({ [artifactName]: digest }),
  );
  const options = { packageDirectory: root, platform: "darwin", arch: "arm64" };
  return { root, options };
}

test("production Electron checksums match the pinned installed package for each packaged target", async () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["win32", "x64"],
    ["win32", "arm64"],
  ]) {
    const options = await electronDownloadOptions({ platform, arch });
    assert.match(
      options.checksums[
        `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`
      ],
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(options.unsafelyDisableChecksums, undefined);
  }
});

test("Electron rejects version mismatch, missing target and malformed package checksums without fetching a manifest", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    electronDownloadOptions({ ...f.options, version: "43.2.1" }),
    /version must match/,
  );
  await assert.rejects(
    electronDownloadOptions({ ...f.options, arch: "x64" }),
    /do not cover/,
  );
  for (const contents of [
    "{}",
    "null",
    "{",
    JSON.stringify({ [artifactName]: "not a digest" }),
  ]) {
    await writeFile(path.join(f.root, "checksums.json"), contents);
    await assert.rejects(electronDownloadOptions(f.options));
  }
  await rm(path.join(f.root, "checksums.json"));
  await assert.rejects(electronDownloadOptions(f.options), /ENOENT/);
});

test("locked @electron/get validates warm ZIPs with package checksums and makes no manifest request", async (t) => {
  const f = await fixture(t);
  const requests = [];
  let response = bytes;
  const options = {
    ...(await electronDownloadOptions(f.options)),
    version: ELECTRON_VERSION,
    platform: "darwin",
    arch: "arm64",
    artifactName: "electron",
    cacheRoot: path.join(f.root, "cache"),
    tempDirectory: f.root,
    downloader: {
      async download(url, target) {
        requests.push(url);
        assert.ok(
          url.endsWith(`/${artifactName}`),
          "must not fetch SHASUMS256.txt",
        );
        await writeFile(target, response);
      },
    },
  };
  const cold = await downloadArtifact(options);
  assert.deepEqual(await readFile(cold), bytes);
  assert.equal(await downloadArtifact(options), cold);
  assert.equal(requests.length, 1);
  // A warm filename is not sufficient: upstream rechecks and replaces corruption.
  await writeFile(cold, "corrupt cached ZIP");
  assert.equal(await downloadArtifact(options), cold);
  assert.deepEqual(await readFile(cold), bytes);
  assert.equal(requests.length, 2);
  // Wrong download bytes are rejected rather than promoted into cache.
  await rm(cold);
  response = Buffer.from("wrong download bytes");
  await assert.rejects(downloadArtifact(options), /checksum/i);
  await assert.rejects(readFile(cold), /ENOENT/);
  assert.deepEqual((await readdir(f.root)).sort(), [
    "cache",
    "checksums.json",
    "package.json",
  ]);
});
