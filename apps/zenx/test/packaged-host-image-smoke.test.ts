import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FakeModel } from "../../../src/model.js";
import { verifyPackagedHostImagePreparation } from "../src/main/packaged-host-image-smoke.js";

test("packaged image fixture exercises the offline Host and cold compiler with only a sanitized receipt", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-image-smoke-test-"),
  );
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    throw new Error("Packaged image fixture must not use the network");
  });
  try {
    const receipt = await verifyPackagedHostImagePreparation(directory);
    assert.deepEqual(receipt, {
      syntheticFixture: true,
      provider: "fake",
      originalDimensions: [2048, 2048],
      preparedDimensions: [1600, 1600],
      modelInputImages: 1,
      durablePreparationOverlays: 1,
      originalBytesPreserved: true,
      coldCompilerMatches: true,
    });
    assert.equal(fetches, 0);
    assert.deepEqual(
      await readdir(directory),
      [],
      "fixture must clean its owned data",
    );
    assert(!JSON.stringify(receipt).includes(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged image fixture fails on a failed Host sample and still cleans owned data", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-image-smoke-failure-"),
  );
  t.mock.method(FakeModel.prototype, "stream", async function* () {
    throw new Error("Synthetic provider failure");
  });
  try {
    await assert.rejects(
      verifyPackagedHostImagePreparation(directory),
      /synthetic image Turn must complete/u,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing packaged-provider entry awaits and reports the synthetic Host image fixture", async () => {
  const source = await readFile(
    new URL("../src/main/packaged-provider-smoke.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /import \{ verifyPackagedHostImagePreparation \} from "\.\/packaged-host-image-smoke\.js"/u,
  );
  assert.match(
    source,
    /const imagePreparation = await verifyPackagedHostImagePreparation\(\)/u,
  );
  assert.match(source, /syntheticFixtures: \{ imagePreparation: true \}/u);
  assert.match(source, /programmaticTool,\s+imagePreparation,/u);
});
