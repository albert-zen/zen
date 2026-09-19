import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  saveWorkspaceFile,
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

test("editor saves UTF-8 source and refuses to overwrite an external edit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-edit-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Before\r\n中文\r\n");
    const original = await readWorkspaceFile(root, "README.md");
    const saved = await saveWorkspaceFile(
      root,
      "README.md",
      "# Edited\r\n中文\r\n",
      original.revision,
    );
    assert.equal(saved.status, "saved");
    assert.equal(
      (await readWorkspaceFile(root, "README.md")).text,
      "# Edited\r\n中文\r\n",
    );
    await writeFile(path.join(root, "README.md"), "# External");
    const conflict = await saveWorkspaceFile(
      root,
      "README.md",
      "# My draft",
      saved.file.revision,
    );
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.file.text, "# External");
    assert.equal(
      (await readWorkspaceFile(root, "README.md")).text,
      "# External",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent saves accept one version and preserve BOM, while invalid saves leave the file intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-edit-race-"));
  try {
    await writeFile(path.join(root, "file.txt"), "\ufefforiginal\r\n");
    const base = await readWorkspaceFile(root, "file.txt");
    assert.equal(base.text, "\ufefforiginal\r\n");
    const results = await Promise.all([
      saveWorkspaceFile(root, "file.txt", "\ufefffirst\r\n", base.revision),
      saveWorkspaceFile(root, "file.txt", "second", base.revision),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [
      "conflict",
      "saved",
    ]);
    const saved = await readWorkspaceFile(root, "file.txt");
    assert.equal(
      saved.text,
      results.find((result) => result.status === "saved")!.file.text,
    );
    const bomSave = await saveWorkspaceFile(
      root,
      "file.txt",
      "\ufeffpreserved\r\n",
      saved.revision,
    );
    assert.equal(bomSave.status, "saved");
    assert.equal(
      (await readWorkspaceFile(root, "file.txt")).text,
      "\ufeffpreserved\r\n",
    );
    saved.text = bomSave.file.text;
    saved.revision = bomSave.file.revision;
    await assert.rejects(
      saveWorkspaceFile(
        root,
        "file.txt",
        "x".repeat(1024 * 1024 + 1),
        saved.revision,
      ),
      /1 MiB/,
    );
    await assert.rejects(
      saveWorkspaceFile(root, "file.txt", "a\0b", saved.revision),
      /UTF-8/,
    );
    await assert.rejects(
      saveWorkspaceFile(root, "../outside", "x", saved.revision),
      /workspace/,
    );
    assert.equal((await readWorkspaceFile(root, "file.txt")).text, saved.text);
    assert.deepEqual(
      (await listWorkspaceFiles(root, ".")).entries.map((entry) => entry.name),
      ["file.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
