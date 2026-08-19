import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXTriggerProgramRunner,
  type TriggerProgramRunInput,
  verifyAndTerminateWindowsProcessTree,
  type WindowsProcessIdentity,
  type WindowsProcessTableSnapshot,
} from "../src/main/trigger-program-runner.js";

const runner = new ZenXTriggerProgramRunner();

test("Windows containment never reuses stale identity evidence for a second tree kill", async () => {
  const root: WindowsProcessIdentity = {
    pid: 101,
    parentPid: 1,
    processGroupId: null,
    sessionId: null,
    startTime: "root-original",
  };
  const descendant: WindowsProcessIdentity = {
    pid: 202,
    parentPid: root.pid,
    processGroupId: null,
    sessionId: null,
    startTime: "descendant-original",
  };
  let table: WindowsProcessTableSnapshot = {
    entries: [root, descendant],
  };
  const taskkills: Array<[number, boolean]> = [];

  const result = await verifyAndTerminateWindowsProcessTree(
    root.pid,
    { root, descendants: [descendant] },
    {
      captureProcessTable: async () => structuredClone(table),
      runTaskkill: async (pid, tree) => {
        taskkills.push([pid, tree]);
        table = {
          entries: [
            {
              ...root,
              startTime: "root-reused-after-first-tree-kill",
            },
            {
              ...descendant,
              startTime: "descendant-reused-after-first-tree-kill",
            },
          ],
        };
        return { ok: true, error: "" };
      },
      processIsAlive: (pid) => table.entries.some((entry) => entry.pid === pid),
    },
  );

  assert.deepEqual(result, { ok: true, error: "" });
  assert.deepEqual(taskkills, [[root.pid, true]]);
});

test("program runner passes bounded JSON input, cwd, and env", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-program-"));
  const input: TriggerProgramRunInput = {
    invocationId: "invocation-stable",
    stage: "action",
    event: { completedItemText: "deploy" },
  };
  const result = await runner.run(
    {
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.on('data',d=>{const x=JSON.parse(d); console.log(JSON.stringify({ok:true, cwd:process.cwd(), env:process.env.ZENX_FIXTURE, invocationId:x.invocationId}))})",
      ],
      cwd: directory,
      env: { ZENX_FIXTURE: "yes" },
    },
    input,
    new AbortController().signal,
  );
  assert.equal(result.status, "completed");
  assert.match(result.output ?? "", /invocation-stable/u);
  assert.match(result.output ?? "", /"env":"yes"/u);
  assert.match(result.output ?? "", /zenx-program-/u);
});

test("predicate output distinguishes match and non-match", async () => {
  const make = (match: boolean) =>
    runner.run(
      {
        command: process.execPath,
        args: ["-e", `console.log(JSON.stringify({match:${String(match)}}))`],
      },
      {
        invocationId: "predicate-id",
        stage: "predicate",
        event: {},
      },
      new AbortController().signal,
    );
  assert.equal((await make(true)).status, "matched");
  assert.equal((await make(false)).status, "non_match");
});

test("program runner records malformed, nonzero, oversized, timeout, and cancellation outcomes", async () => {
  const malformed = await runner.run(
    { command: process.execPath, args: ["-e", "console.log('nope')"] },
    { invocationId: "malformed", stage: "action", event: {} },
    new AbortController().signal,
  );
  assert.equal(malformed.status, "malformed_output");

  const nonzero = await runner.run(
    {
      command: process.execPath,
      args: ["-e", "console.error('bad'); process.exit(3)"],
    },
    { invocationId: "nonzero", stage: "action", event: {} },
    new AbortController().signal,
  );
  assert.equal(nonzero.status, "nonzero_exit");
  assert.equal(nonzero.exitCode, 3);

  const oversized = await runner.run(
    {
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({ok:true, x:'x'.repeat(1000)}))",
      ],
      maxOutputBytes: 256,
    },
    { invocationId: "oversized", stage: "action", event: {} },
    new AbortController().signal,
  );
  assert.equal(oversized.status, "oversized_output");

  const timedOut = await runner.run(
    {
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},30000)"],
      timeoutMs: 20,
    },
    { invocationId: "timeout", stage: "action", event: {} },
    new AbortController().signal,
  );
  assert.equal(timedOut.status, "timed_out");

  const controller = new AbortController();
  const cancelled = runner.run(
    { command: process.execPath, args: ["-e", "setTimeout(()=>{},30000)"] },
    { invocationId: "cancel", stage: "action", event: {} },
    controller.signal,
  );
  controller.abort(new Error("fixture cancellation"));
  assert.equal((await cancelled).status, "cancelled");
});

test("program runner contains a descendant after cancellation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-program-kill-"));
  const marker = path.join(directory, "late-marker");
  const ready = path.join(directory, "ready");
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),5000);`;
  const ignoreTermination =
    process.platform === "win32" ? "" : "process.on('SIGTERM',()=>{});";
  const parent = `const {spawn}=require('node:child_process');${ignoreTermination}spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>process.stdout.write(JSON.stringify({ok:true})+'\\n'),50);`;
  const controller = new AbortController();
  try {
    const running = runner.run(
      {
        command: process.execPath,
        args: ["-e", parent],
        maxOutputBytes: 64 * 1024,
      },
      { invocationId: "contained-cancel", stage: "action", event: {} },
      controller.signal,
    );
    const descendantPid = Number(await waitForFile(ready));
    assert(Number.isInteger(descendantPid) && descendantPid > 0);
    controller.abort(new Error("cancel fixture"));
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.equal(result.output, null);
    await waitForProcessExit(descendantPid);
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally {
    await assert.rejects(stat(marker), { code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  }
});

test("program runner contains descendants when the direct child exits", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-program-tree-close-"),
  );
  const marker = path.join(directory, "late-marker");
  const ready = path.join(directory, "ready");
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),5000);`;
  const exitOnTermination =
    process.platform === "win32"
      ? ""
      : "process.on('SIGTERM',()=>process.exit(0));";
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});${exitOnTermination}setInterval(()=>{},1000);`;
  const controller = new AbortController();
  try {
    const running = runner.run(
      { command: process.execPath, args: ["-e", parent] },
      { invocationId: "tree-close", stage: "action", event: {} },
      controller.signal,
    );
    const descendantPid = Number(await waitForFile(ready));
    assert(Number.isInteger(descendantPid) && descendantPid > 0);
    controller.abort(new Error("tree close fixture"));
    assert.equal((await running).status, "cancelled");
    await waitForProcessExit(descendantPid);
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally {
    await assert.rejects(stat(marker), { code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for fixture file: ${file}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Fixture process ${String(pid)} did not exit`);
}
