import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
export async function verifyNativeFullscreen(directory, expectedCommit) {
  const read = (name) => readFile(path.join(directory, name));
  const report = JSON.parse(await read("native-measurements.json"));
  assert.equal(report.status, "passed");
  assert.equal(report.cleanupCompleted, true);
  assert.equal(report.platform, "darwin");
  assert.deepEqual(report.errors, []);
  assert.equal(report.cleanupError, undefined);
  assert.equal(report.error, undefined);
  assert.deepEqual(
    report.cases.map((c) => [c.width, c.status]),
    [
      [1280, "passed"],
      [1000, "passed"],
    ],
  );
  if (expectedCommit)
    assert.equal(report.rendererSource.commit, expectedCommit);
  assert.deepEqual(
    report.rendererSource,
    JSON.parse(await read("source.json")),
  );
  assert.deepEqual(
    report.nativeSource,
    JSON.parse(await read("native-source.json")),
  );
  for (const name of [
    "native-main.cjs",
    "native-preload.cjs",
    "fullscreen-primary-chat.html",
  ]) {
    const hash = report.nativeSource.outputs[name];
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(
      createHash("sha256")
        .update(await read(name))
        .digest("hex"),
      hash,
      name,
    );
  }
  for (const width of [1280, 1000])
    for (const suffix of [
      "activity-preview-parent-renderer",
      "activity-preview-native-webcontentsview",
      "returned-parent-renderer",
    ]) {
      const name = `${width}-${suffix}.png`,
        bytes = await read(name);
      assert.ok(bytes.length > 8, name);
      assert.equal(
        bytes.subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a",
        name,
      );
    }
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await verifyNativeFullscreen(
    path.resolve(process.argv[2]),
    process.env.GITHUB_SHA,
  );
  console.log(
    "Verified native fullscreen report, executed output hashes and six PNGs",
  );
}
