import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageStorageWriter } from "../scripts/stage-storage-writer.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const run = promisify(execFile);
test("offline portable closure loads selected prebuild without source checkout dependencies", async () => {
  const destination = await mkdtemp(
    path.join(os.tmpdir(), "zen-native-package-"),
  );
  const result = await stageStorageWriter(root, destination);
  assert.equal(result.version, "1.4.5");
  const prebuilds = path.join(
    destination,
    "node_modules",
    "fs-native-extensions",
    "prebuilds",
  );
  assert.deepEqual(await readdir(prebuilds), [
    `${process.platform}-${process.arch}`,
  ]);
  assert.deepEqual(
    await readdir(path.join(prebuilds, `${process.platform}-${process.arch}`)),
    ["fs-native-extensions.node"],
  );
  await writeFile(
    path.join(destination, "smoke.cjs"),
    `const fs=require('node:fs'); const addon=require('fs-native-extensions'); const file=fs.openSync('owner','wx+'); if(!addon.tryLock(file))process.exit(21); const second=fs.openSync('owner','r+'); if(addon.tryLock(second))process.exit(22); fs.closeSync(second); const third=fs.openSync('owner','r+'); if(addon.tryLock(third))process.exit(23); fs.closeSync(file); if(!addon.tryLock(third))process.exit(24); fs.closeSync(third); console.log('offline ownership passed');`,
  );
  const output = await run(
    process.execPath,
    [path.join(destination, "smoke.cjs")],
    { cwd: destination, env: { ...process.env, NODE_PATH: "" } },
  );
  assert.match(output.stdout, /offline ownership passed/);
  for (const name of result.packages)
    assert(
      (await readdir(path.join(destination, "licenses"))).includes(
        `${name}.txt`,
      ),
    );
});
test("unsupported package target fails rather than downloading or compiling", async () => {
  const destination = await mkdtemp(
    path.join(os.tmpdir(), "zen-native-unsupported-"),
  );
  await assert.rejects(
    stageStorageWriter(root, destination, "unsupported", "unsupported"),
  );
  assert.deepEqual(await readdir(destination), []);
});
