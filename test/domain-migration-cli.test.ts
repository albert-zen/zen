import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
// This test exercises the checked-in source CLI, so the supported TS loader is explicit.
const project = root.endsWith(`${path.sep}dist${path.sep}`)
  ? path.resolve(root, "..")
  : root;
const script = path.join(project, "scripts", "migrate-itemlist-trace.mjs");
const loader = path.join(project, "node_modules", "tsx", "dist", "loader.mjs");
function cli(directory: string, apply = false) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      loader,
      script,
      "--offline",
      "--data-directory",
      directory,
      ...(apply ? ["--apply"] : []),
    ],
    { encoding: "utf8" },
  );
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-migration-cli-"));
  await mkdir(path.join(root, "threads"));
  const bytes =
    JSON.stringify({
      id: "m",
      threadId: "t",
      createdAt: "2026-10-27",
      type: "thread_metadata",
      cwd: "/synthetic",
      provider: "p",
      model: "m",
      sandbox: "read-only",
      approvalPolicy: "always",
    }) + "\n";
  await writeFile(path.join(root, "threads", "t.jsonl"), bytes);
  return { root, bytes };
}
test("CLI read-only preflight leaves no lock/Trace and apply is repeatable", async () => {
  const { root, bytes } = await setup();
  const before = cli(root);
  assert.equal(before.status, 0, before.stderr);
  assert.deepEqual(await readdir(root), ["threads"]);
  assert.deepEqual(await readdir(path.join(root, "threads")), ["t.jsonl"]);
  for (let i = 0; i < 2; i++) {
    const result = cli(root, true);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(
    await readFile(path.join(root, "threads", "legacy", "t.jsonl"), "utf8"),
    bytes,
  );
});
test("all-source preflight rejects unsupported records before any selected source mutation", async () => {
  const { root, bytes } = await setup();
  await writeFile(
    path.join(root, "threads", "z.jsonl"),
    '{"type":"model_operation"}\n',
  );
  const result = cli(root, true);
  assert.notEqual(result.status, 0);
  assert.equal(
    await readFile(path.join(root, "threads", "t.jsonl"), "utf8"),
    bytes,
  );
  assert.deepEqual(await readdir(root), ["threads"]);
});
