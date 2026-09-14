import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectRtkResource } from "../src/main/rtk-resource.js";

test("RTK resource admission rejects unsupported, missing, and unverified binaries", async () => {
  assert.equal(
    (await inspectRtkResource(undefined, "win32", "arm64")).available,
    false,
  );
  assert.equal(
    (await inspectRtkResource(undefined, "darwin", "x64")).available,
    false,
  );
  assert.equal(
    (await inspectRtkResource(undefined, "darwin", "arm64")).available,
    false,
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-rtk-resource-"));
  try {
    assert.equal(
      (await inspectRtkResource(root, "darwin", "arm64")).available,
      false,
    );
    await mkdir(path.join(root, "rtk"));
    await writeFile(path.join(root, "rtk", "rtk"), "not the pinned executable");
    await chmod(path.join(root, "rtk", "rtk"), 0o755);
    assert.equal(
      (await inspectRtkResource(root, "darwin", "arm64")).available,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
