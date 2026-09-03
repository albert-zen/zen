import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import { observeOwnedChild } from "../src/main/owned-child-process.js";
import { stopOwnedAppServerChild } from "../src/main/app-server-manager.js";

function childWithPid(pid: number | undefined): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { configurable: true, value: pid });
  return child;
}

test("post-spawn errors remain diagnostic until the exact child closes", async () => {
  const child = childWithPid(1234);
  const observation = observeOwnedChild(child);
  const failure = new Error("signal delivery failed");
  let settled = false;
  void observation.terminal.then(() => {
    settled = true;
  });

  child.emit("error", failure);
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(observation.outcome(), undefined);
  assert.equal(observation.lastError(), failure);

  child.emit("close", 7, null);
  assert.deepEqual(await observation.terminal, {
    type: "close",
    code: 7,
    signal: null,
  });
  assert.equal(observation.lastError(), failure);
});

test("a spawn error with no PID proves no child process was created", async () => {
  const child = childWithPid(undefined);
  const observation = observeOwnedChild(child);
  const failure = new Error("spawn ENOENT");

  child.emit("error", failure);

  assert.deepEqual(await observation.terminal, {
    type: "spawn_error",
    code: null,
    signal: null,
    error: failure,
  });
});

test("owned cleanup cannot advance before a post-error close", async () => {
  const child = childWithPid(5678);
  const observation = observeOwnedChild(child);
  const cleanupOrder: string[] = [];
  const cleanup = observation.terminal.then(() => {
    cleanupOrder.push("remove-owned-resource");
  });

  child.emit("error", new Error("kill EPERM"));
  await Promise.resolve();
  assert.deepEqual(cleanupOrder, []);

  child.emit("close", null, "SIGKILL");
  await cleanup;
  assert.deepEqual(cleanupOrder, ["remove-owned-resource"]);
});

test("AppServer owned-child stop escalates exact shutdown through TERM and KILL then awaits close", async () => {
  const child = childWithPid(6789);
  const calls: string[] = [];
  Object.defineProperties(child, {
    connected: { configurable: true, value: true },
    exitCode: { configurable: true, value: null },
    signalCode: { configurable: true, value: null },
  });
  child.send = (() => {
    calls.push("shutdown");
    return true;
  }) as ChildProcess["send"];
  child.kill = ((signal?: NodeJS.Signals | number) => {
    calls.push(String(signal));
    if (signal === "SIGKILL") {
      queueMicrotask(() => {
        calls.push("close");
        child.emit("close", null, "SIGKILL");
      });
    }
    return true;
  }) as ChildProcess["kill"];
  const observation = observeOwnedChild(child);

  await stopOwnedAppServerChild(child, observation, {
    shutdownGraceMs: 1,
    terminationGraceMs: 1,
  });
  assert.deepEqual(calls, ["shutdown", "SIGTERM", "SIGKILL", "close"]);
});

test("AppServer owned-child stop treats an already closed exact child as settled", async () => {
  const child = childWithPid(6790);
  const calls: string[] = [];
  Object.defineProperty(child, "connected", {
    configurable: true,
    value: true,
  });
  child.send = (() => {
    calls.push("shutdown");
    return true;
  }) as ChildProcess["send"];
  child.kill = (() => {
    calls.push("kill");
    return true;
  }) as ChildProcess["kill"];
  const observation = observeOwnedChild(child);
  child.emit("close", 0, null);

  await stopOwnedAppServerChild(child, observation, {
    shutdownGraceMs: 1,
    terminationGraceMs: 1,
  });
  assert.deepEqual(calls, []);
});
