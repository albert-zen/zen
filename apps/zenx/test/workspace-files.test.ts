import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  saveWorkspaceFile,
  searchWorkspaceFiles,
  validateWorkspaceFileReference,
} from "../src/main/workspace-files.js";

test("reference search matches nested special paths and validates binary without reading content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-reference-"));
  try {
    await mkdir(path.join(root, "文档 [draft]"));
    await writeFile(
      path.join(root, "文档 [draft]", "A # %.bin"),
      Buffer.from([0, 255]),
    );
    for (const directory of ["node_modules", ".git"]) {
      await mkdir(path.join(root, directory));
      await writeFile(path.join(root, directory, "A # %.bin"), "ignored");
    }
    const result = await searchWorkspaceFiles(root, "a # %");
    assert.equal(result.truncated, false);
    assert.deepEqual(result.entries, [
      { name: "A # %.bin", path: "文档 [draft]/A # %.bin" },
    ]);
    const reference = await validateWorkspaceFileReference(
      root,
      result.entries[0]!.path,
    );
    assert.equal(reference.cwd, result.cwd);
    assert.equal(reference.path, "文档 [draft]/A # %.bin");
    await rm(path.join(root, reference.path));
    await assert.rejects(
      validateWorkspaceFileReference(root, reference.path),
      /ENOENT/,
    );
    await assert.rejects(
      validateWorkspaceFileReference(root, "."),
      /regular file/,
    );
    await assert.rejects(
      validateWorkspaceFileReference(root, "../outside"),
      /workspace/,
    );
    await assert.rejects(searchWorkspaceFiles(root, null), /query/);
    await assert.rejects(searchWorkspaceFiles(root, "x".repeat(513)), /query/);
    await assert.rejects(searchWorkspaceFiles(root, "x\0"), /query/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference search reports truncation and does not follow directory junctions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-search-bound-"));
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(
      outside,
      path.join(workspace, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.deepEqual(
      (await searchWorkspaceFiles(workspace, "secret")).entries,
      [],
    );
    const linkedSearch = await searchWorkspaceFiles(workspace, "link/secret");
    assert.deepEqual(linkedSearch.entries, []);
    assert.equal(linkedSearch.truncated, true);
    assert.match(linkedSearch.warnings!.join(" "), /Symbolic link/);
    await assert.rejects(
      validateWorkspaceFileReference(workspace, "link/secret.txt"),
      /outside this workspace/,
    );
    for (let i = 0; i < 85; i++)
      await writeFile(path.join(workspace, `${i}.txt`), "");
    const result = await searchWorkspaceFiles(workspace, ".txt");
    assert.equal(result.entries.length, 80);
    assert.equal(result.truncated, true);
    await assert.rejects(
      searchWorkspaceFiles(path.join(root, "missing"), ""),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference search bounds depth and surfaces unreadable directory errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-search-depth-"));
  try {
    const deep = path.join(root, ...Array.from({ length: 34 }, () => "d"));
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "hidden.txt"), "");
    const result = await searchWorkspaceFiles(root, "hidden");
    assert.equal(result.truncated, true);
    assert.deepEqual(result.entries, []);
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "");
    await assert.rejects(searchWorkspaceFiles(file, ""), /ENOTDIR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference search preserves valid results when child directories disappear or deny access", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-search-partial-"));
  const originalOpen = fs.opendir;
  try {
    await mkdir(path.join(root, "denied"));
    await mkdir(path.join(root, "deleted"));
    await writeFile(path.join(root, "valid.txt"), "");
    t.mock.method(fs, "opendir", async (directory: string) => {
      if (path.basename(directory) === "denied")
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      if (path.basename(directory) === "deleted")
        await rm(directory, { recursive: true });
      return originalOpen(directory);
    });
    syncBuiltinESMExports();
    const result = await searchWorkspaceFiles(root, "");
    assert.deepEqual(result.entries, [
      { name: "valid.txt", path: "valid.txt" },
    ]);
    assert.equal(result.truncated, true);
    assert.equal(result.warnings?.length, 2);
    assert.match(result.warnings!.join(" "), /denied.*EACCES|EACCES.*denied/);
    assert.match(result.warnings!.join(" "), /deleted.*ENOENT|ENOENT.*deleted/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit parent path is searched before root enumeration and remains bounded", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-search-priority-"));
  const originalOpen = fs.opendir;
  const opened: string[] = [];
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "foo.ts"), "");
    t.mock.method(fs, "opendir", async (directory: string) => {
      opened.push(directory);
      return originalOpen(directory);
    });
    syncBuiltinESMExports();
    const result = await searchWorkspaceFiles(root, "src/foo");
    // Root is first opened and closed only to check accessibility.
    assert.equal(path.basename(opened[1]!), "src");
    assert.deepEqual(result.entries, [{ name: "foo.ts", path: "src/foo.ts" }]);
    assert.equal(
      new Set(result.entries.map((entry) => entry.path)).size,
      result.entries.length,
    );
    await assert.rejects(searchWorkspaceFiles(root, "../foo"), /workspace/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

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
