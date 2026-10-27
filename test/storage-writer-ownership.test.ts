import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  writeFile,
  rename,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { StorageWriterOwnership } from "../src/storage-writer-ownership.js";
const fixture = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./storage-writer-child.ts"
      : "./storage-writer-child.js",
    import.meta.url,
  ),
);
function child(dir: string, mode = "") {
  return spawn(process.execPath, [...process.execArgv, fixture, dir, mode], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}
async function run(dir: string, mode = "") {
  const p = child(dir, mode);
  return (await once(p, "exit"))[0];
}
async function directory() {
  return mkdtemp(path.join(os.tmpdir(), "zen-owner-"));
}
test("real competing process refused; unrelated read/close cannot release owner; close permits restart", async () => {
  const dir = await directory();
  const owner = new StorageWriterOwnership(dir);
  try {
    assert.equal(await run(dir), 23);
    await readFile(path.join(dir, ".writer.lock"));
    assert.equal(await run(dir), 23);
    owner.assertHeld();
  } finally {
    owner.close();
  }
  assert.equal(await run(dir), 0);
});
test("SIGKILL releases private OS lock without stale-file deletion", async () => {
  const dir = await directory();
  const p = child(dir, "hold");
  await once(p.stdout!, "data");
  assert.equal(await run(dir), 23);
  p.kill("SIGKILL");
  await once(p, "exit");
  assert.equal(await run(dir), 0);
});
for (const phase of ["temporary", "published"])
  test(`initializer dies ${phase}; next process acquires safely`, async () => {
    const dir = await directory();
    assert.equal(await run(dir, phase), 91);
    assert.equal(await run(dir), 0);
  });
test("legacy JSON/empty lock and symlink fail closed, not reclaimed", async () => {
  for (const bytes of [
    "",
    JSON.stringify({ pid: 999999, ownerToken: "old" }),
  ]) {
    const dir = await directory();
    await writeFile(path.join(dir, ".writer.lock"), bytes);
    assert.throws(() => new StorageWriterOwnership(dir), /legacy/);
    assert.equal(await readFile(path.join(dir, ".writer.lock"), "utf8"), bytes);
  }
  const dir = await directory();
  await writeFile(path.join(dir, "other"), "x");
  await symlink(path.join(dir, "other"), path.join(dir, ".writer.lock"));
  assert.throws(() => new StorageWriterOwnership(dir), /symlink/);
});
test("replacement inode fails closed; closed object cannot mutate", async () => {
  const dir = await directory();
  const owner = new StorageWriterOwnership(dir);
  await rename(path.join(dir, ".writer.lock"), path.join(dir, "moved"));
  await writeFile(path.join(dir, ".writer.lock"), "replacement");
  assert.throws(() => owner.assertHeld(), /replaced/);
  owner.close();
  assert.throws(() => owner.assertHeld(), /closed/);
});
