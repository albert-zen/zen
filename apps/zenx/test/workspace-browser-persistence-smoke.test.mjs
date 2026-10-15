import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { waitForSmokeProcess } from "../scripts/workspace-browser-persistence-smoke.mjs";

function childFixture(onSignal) {
  const child = new EventEmitter();
  child.pid = 123;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    onSignal?.(signal, child);
  };
  child.unref = () => {
    child.unrefed = true;
  };
  return child;
}

test("browser persistence smoke waits for normal process closure", async () => {
  const child = childFixture();
  const result = waitForSmokeProcess(child, 100, 10);
  child.emit("exit", 0);
  let completed = false;
  void result.then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  child.emit("close", 0);
  assert.equal(await result, 0);
  assert.deepEqual(child.signals, []);
});

test("browser persistence smoke escalates an ignored SIGTERM and reaps", async () => {
  const child = childFixture((signal, process) => {
    if (signal === "SIGKILL") process.emit("close", null);
  });
  await assert.rejects(waitForSmokeProcess(child, 1, 1), (error) => {
    assert.equal(error.reaped, true);
    return /timed out/.test(error.message);
  });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("browser persistence smoke bounds failed reap and preserves the profile", async () => {
  const child = childFixture();
  await assert.rejects(waitForSmokeProcess(child, 1, 1), (error) => {
    assert.equal(error.reaped, false);
    return /timed out/.test(error.message);
  });
  assert.equal(child.unrefed, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("browser persistence smoke handles spawn failure without a live profile", async () => {
  const child = childFixture();
  delete child.pid;
  const result = waitForSmokeProcess(child, 100, 1);
  child.emit("error", new Error("spawn ENOENT"));
  await assert.rejects(result, (error) => error.reaped === true);
  assert.deepEqual(child.signals, []);
});
