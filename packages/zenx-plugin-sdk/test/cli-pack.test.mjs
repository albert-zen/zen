import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = path.resolve(import.meta.dirname, "..", "dist", "cli.js");

test("pack validates then delegates to npm pack and produces its standard tarball", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-pack-"));
  const target = path.join(root, "pack-plugin");
  try {
    const created = spawnSync(
      process.execPath,
      [cli, "create", target, "--name", "pack-plugin", "--id", "pack-plugin"],
      { encoding: "utf8" },
    );
    assert.equal(created.status, 0, created.stderr);

    const packed = spawnSync(process.execPath, [cli, "pack", target], {
      encoding: "utf8",
    });
    assert.equal(packed.status, 0, packed.stderr);
    const [result] = JSON.parse(packed.stdout);
    assert.equal(result.filename, "pack-plugin-0.1.0.tgz");
    assert.deepEqual(result.files.map((file) => file.path).sort(), [
      "README.md",
      "package.json",
      "runtime.mjs",
      "zenx.plugin.json",
    ]);
    const tarball = await readFile(path.join(target, result.filename));
    assert.deepEqual([...tarball.subarray(0, 2)], [0x1f, 0x8b]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pack stops at validation failure without producing a tarball", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-pack-invalid-"));
  const target = path.join(root, "invalid-pack-plugin");
  try {
    const created = spawnSync(
      process.execPath,
      [
        cli,
        "create",
        target,
        "--name",
        "invalid-pack-plugin",
        "--id",
        "invalid-pack-plugin",
      ],
      { encoding: "utf8" },
    );
    assert.equal(created.status, 0, created.stderr);
    await rm(path.join(target, "runtime.mjs"));

    const packed = spawnSync(process.execPath, [cli, "pack", target], {
      encoding: "utf8",
    });
    assert.equal(packed.status, 1);
    assert.match(packed.stderr, /runtime entry does not exist/u);
    assert.deepEqual(
      (await readdir(target)).filter((entry) => entry.endsWith(".tgz")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
