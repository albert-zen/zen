import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  waitForFile,
  waitForText,
} from "../src/main/windows-packaged-uia-files.js";

const busy = () => Object.assign(new Error("file busy"), { code: "EBUSY" });
const signal = () => new AbortController().signal;

test("fixture observation retries transient EBUSY without altering the observed text", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const expected = "中文\r\n😀";
  let reads = 0;
  t.mock.method(fs, "readFile", async (file: string, encoding: string) => {
    assert.equal(file, path.join("fixture", "editor-value"));
    assert.equal(encoding, "utf8");
    if (++reads <= 2) throw busy();
    return expected;
  });
  const pending = waitForFile("fixture", "editor-value", signal(), []).catch(
    (error: unknown) => error,
  );
  // Let each rejected read schedule the existing 20ms poll.
  await Promise.resolve();
  assert.equal(reads, 1);
  t.mock.timers.tick(20);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(20);
  assert.equal(await pending, expected);
  assert.equal(reads, 3);
  assert.equal(Date.now(), 40);
});

for (const code of ["EBUSY", "ENOENT"]) {
  test(`persistent ${code} expires at the existing 20-second observation deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const read = t.mock.method(fs, "readFile", async () => {
      throw Object.assign(new Error(code), { code });
    });
    const fixture = {
      assertRunning() {},
      diagnostic: () => "fixture still alive",
    };
    const rejected = assert.rejects(
      waitForFile("fixture", "editor-value", signal(), [fixture]),
      /Native fixture did not produce editor-value: fixture still alive/,
    );
    for (let elapsed = 0; elapsed < 20_000; elapsed += 20) {
      await Promise.resolve();
      await Promise.resolve();
      t.mock.timers.tick(20);
    }
    await rejected;
    assert.equal(Date.now(), 20_000);
    assert.equal(read.mock.callCount(), 1001);
  });
}

for (const code of ["EPERM", "EACCES", "EIO"]) {
  test(`fixture observation immediately preserves ${code}`, async (t) => {
    const error = Object.assign(new Error(code), { code });
    const read = t.mock.method(fs, "readFile", async () => {
      throw error;
    });
    await assert.rejects(
      waitForFile("fixture", "editor-value", signal(), []),
      (actual) => actual === error,
    );
    assert.equal(read.mock.callCount(), 1);
  });
}

for (const stop of ["abort", "exit"]) {
  test(`fixture observation checks ${stop} again after an EBUSY read`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const controller = new AbortController();
    const failure = new Error(stop);
    let ended = false;
    const fixture = {
      assertRunning() {
        if (ended) throw failure;
      },
      diagnostic: () => "",
    };
    const read = t.mock.method(fs, "readFile", async () => {
      throw busy();
    });
    const rejected = assert.rejects(
      waitForFile("fixture", "editor-value", controller.signal, [fixture]),
      (error) => error === failure,
    );
    await Promise.resolve();
    if (stop === "abort") controller.abort(failure);
    else ended = true;
    t.mock.timers.tick(20);
    await rejected;
    assert.equal(read.mock.callCount(), 1);
  });
}

test("text mismatch followed by EBUSY cannot restart the text observation deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let reads = 0;
  t.mock.method(fs, "readFile", async () => {
    if (++reads === 1) {
      t.mock.timers.setTime(19_980);
      return "old text";
    }
    throw busy();
  });
  const rejected = assert.rejects(
    waitForText("fixture", "editor-value", "expected", signal(), []),
    /Native fixture did not produce editor-value/,
  );
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(20);
  await rejected;
  assert.equal(Date.now(), 20_000);
  assert.equal(reads, 2);
});
