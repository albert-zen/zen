import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXDirectoryBrowser } from "../src/main/directory-browser.js";

test("lists only directories and resolves linked directories to canonical targets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-picker-"));
  const home = path.join(directory, "home");
  const documents = path.join(home, "Documents");
  const target = path.join(directory, "target");
  await mkdir(documents, { recursive: true });
  await mkdir(path.join(documents, "alpha"));
  await mkdir(target);
  await writeFile(path.join(documents, "note.txt"), "not a directory");
  await symlink(
    target,
    path.join(documents, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    const browser = new ZenXDirectoryBrowser({
      home,
      documents,
      platform: process.platform,
    });
    const snapshot = await browser.snapshot();
    assert.equal(snapshot.initialPath, await real(documents));
    const listing = await browser.list(documents);
    assert.deepEqual(
      listing.directories.map((entry) => entry.name),
      ["alpha", "linked"],
    );
    assert.equal(
      listing.directories.find((entry) => entry.name === "linked")?.path,
      await real(target),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports unavailable paths without mutating the filesystem", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-picker-"));
  try {
    const browser = new ZenXDirectoryBrowser({
      home: directory,
      documents: directory,
    });
    await assert.rejects(
      browser.list(path.join(directory, "missing")),
      /location is unavailable/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function real(value: string): Promise<string> {
  return await import("node:fs/promises").then(({ realpath }) =>
    realpath(value),
  );
}
