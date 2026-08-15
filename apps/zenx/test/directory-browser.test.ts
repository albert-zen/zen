import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXDirectoryBrowser } from "../src/main/directory-browser.js";

test("directory browser starts from Documents and returns sorted folders and breadcrumbs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-picker-"));
  try {
    const documents = path.join(root, "Documents");
    await mkdir(path.join(documents, "zeta"), { recursive: true });
    await mkdir(path.join(documents, "Alpha"));
    const browser = new ZenXDirectoryBrowser({
      home: root,
      documents,
      platform: "linux",
    });
    const snapshot = await browser.snapshot();
    assert.equal(snapshot.initialPath, documents);
    assert.deepEqual(snapshot.locations.slice(0, 2), [
      { label: "Home", path: root },
      { label: "Documents", path: documents },
    ]);
    const listing = await browser.list(documents);
    assert.deepEqual(
      listing.directories.map(({ name }) => name),
      ["Alpha", "zeta"],
    );
    assert.equal(listing.path, documents);
    assert.equal(listing.parent, root);
    assert.equal(listing.breadcrumbs.at(-1)?.label, "Documents");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory browser canonicalizes directory symlinks and rejects unavailable paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-picker-link-"));
  try {
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await mkdir(target);
    try {
      await symlink(
        target,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      t.skip(`symlinks are unavailable: ${String(error)}`);
      return;
    }
    const browser = new ZenXDirectoryBrowser({
      home: root,
      documents: root,
    });
    const listing = await browser.list(root);
    assert.equal(
      listing.directories.find(({ name }) => name === "link")?.path,
      target,
    );
    assert.equal((await browser.list(link)).path, target);
    await assert.rejects(
      browser.list(path.join(root, "missing")),
      /location is unavailable/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
