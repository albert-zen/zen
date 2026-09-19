import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
} from "../src/main/workspace-files.js";

test("workspace viewer lists directories first and reads exact UTF-8 source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-files-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "README.md"), "# Hello\r\n中文\n");
    const listing = await listWorkspaceFiles(root, ".");
    assert.deepEqual(
      listing.entries.map((e) => [e.name, e.kind]),
      [
        ["src", "directory"],
        ["README.md", "file"],
      ],
    );
    const file = await readWorkspaceFile(root, "README.md");
    assert.equal(file.text, "# Hello\r\n中文\n");
    assert.equal(file.path, "README.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("viewer rejects traversal, binary data and oversized files without partial content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-files-"));
  try {
    await writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, "large"), "x".repeat(1024 * 1024 + 1));
    await assert.rejects(readWorkspaceFile(root, "../outside"), /workspace/i);
    await assert.rejects(readWorkspaceFile(root, "binary"), /text|binary/i);
    await assert.rejects(readWorkspaceFile(root, "large"), /large|MiB/i);
    await assert.rejects(readWorkspaceFile(root, "."), /regular file/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("viewer rejects a directory junction resolving outside cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-files-junction-"));
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "not in this workspace");
    await symlink(
      outside,
      path.join(workspace, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.deepEqual((await listWorkspaceFiles(workspace, ".")).entries, []);
    await assert.rejects(
      readWorkspaceFile(workspace, "link/secret.txt"),
      /outside this workspace/,
    );
    await assert.rejects(
      listWorkspaceFiles(workspace, "link"),
      /outside this workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
