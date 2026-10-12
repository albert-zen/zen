import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  readSourceProvenance,
  writeBuildInfo,
} from "../scripts/build-info.mjs";

const run = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-build-info-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run("git", ["-C", root, ...args]);
  await git("init");
  await writeFile(path.join(root, ".gitignore"), "output/\n");
  await writeFile(path.join(root, "source.txt"), "original\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  return { root, git };
}

test("source provenance records full detached commit and sorted exact tags", async (t) => {
  const { root, git } = await fixture(t);
  await git("tag", "z-release");
  await git("tag", "a-release");
  await git("checkout", "--detach");
  const source = await readSourceProvenance(root);
  assert.match(source.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(source.tags, ["a-release", "z-release"]);
  assert.equal(source.state, "clean");
  await mkdir(path.join(root, "output"));
  await writeFile(path.join(root, "output", "generated.txt"), "generated");
  assert.deepEqual(await readSourceProvenance(root), source);
});

test("source provenance marks staged, unstaged and untracked changes dirty", async (t) => {
  const { root, git } = await fixture(t);
  await writeFile(path.join(root, "source.txt"), "changed\n");
  assert.equal((await readSourceProvenance(root)).state, "dirty");
  await git("add", ".");
  assert.equal((await readSourceProvenance(root)).state, "dirty");
  await git("reset", "--hard", "HEAD");
  await writeFile(path.join(root, "new.txt"), "untracked");
  assert.equal((await readSourceProvenance(root)).state, "dirty");
});

test("missing Git metadata and nested exports are unknown, not parent provenance", async (t) => {
  const { root } = await fixture(t);
  const exported = path.join(root, "output");
  await mkdir(exported);
  assert.deepEqual(await readSourceProvenance(exported), {
    commit: null,
    tags: [],
    state: "unknown",
  });
  await rm(path.join(root, ".git"), { recursive: true });
  assert.equal((await readSourceProvenance(root)).state, "unknown");
});

test("private build info is deterministic, target-specific and includes provider digest", async (t) => {
  const { root } = await fixture(t);
  const source = await readSourceProvenance(root);
  const appDirectory = path.join(root, "output", "app");
  await mkdir(appDirectory, { recursive: true });
  const options = {
    appDirectory,
    version: "0.1.0",
    target: "app",
    platform: "darwin",
    arch: "arm64",
    manifestSha256: "a".repeat(64),
    sourceBefore: source,
    sourceAfter: source,
  };
  const info = await writeBuildInfo(options);
  const first = await readFile(
    path.join(appDirectory, "build-info.json"),
    "utf8",
  );
  await writeBuildInfo(options);
  assert.equal(
    await readFile(path.join(appDirectory, "build-info.json"), "utf8"),
    first,
  );
  assert.deepEqual(JSON.parse(first), info);
  assert.deepEqual(info, {
    schemaVersion: 1,
    version: "0.1.0",
    target: "app",
    platform: "darwin",
    arch: "arm64",
    source,
    providers: { manifestSha256: "a".repeat(64) },
  });
  await assert.rejects(readFile(path.join(root, "build-info.json")), {
    code: "ENOENT",
  });
  const smoke = await writeBuildInfo({
    ...options,
    target: "smoke",
    platform: "win32",
    arch: "x64",
  });
  assert.equal(smoke.target, "smoke");
  assert.equal(smoke.platform, "win32");
});

test("source changes during packaging do not claim a clean exact build", async (t) => {
  const { root } = await fixture(t);
  const source = await readSourceProvenance(root);
  const options = {
    appDirectory: root,
    version: "0.1.0",
    target: "app",
    platform: "linux",
    arch: "x64",
    manifestSha256: "b".repeat(64),
    sourceBefore: source,
  };
  const changed = await writeBuildInfo({
    ...options,
    sourceAfter: { ...source, commit: "c".repeat(40) },
  });
  assert.deepEqual(changed.source, {
    commit: null,
    tags: [],
    state: "changed-during-build",
  });
  const dirty = { ...source, state: "dirty" };
  assert.equal(
    (
      await writeBuildInfo({
        ...options,
        sourceBefore: dirty,
        sourceAfter: dirty,
      })
    ).source.state,
    "dirty",
  );
  await assert.rejects(
    writeBuildInfo({ ...options, sourceAfter: source, manifestSha256: "bad" }),
    /digest/,
  );
});
