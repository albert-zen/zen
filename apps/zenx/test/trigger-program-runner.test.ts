import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXTriggerProgramRunner,
  type TriggerProgramRunInput,
} from "../src/main/trigger-program-runner.js";

const runner = new ZenXTriggerProgramRunner();

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
      args: ["-e", "setTimeout(()=>{},1000)"],
      timeoutMs: 20,
    },
    { invocationId: "timeout", stage: "action", event: {} },
    new AbortController().signal,
  );
  assert.equal(timedOut.status, "timed_out");

  const controller = new AbortController();
  const cancelled = runner.run(
    { command: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"] },
    { invocationId: "cancel", stage: "action", event: {} },
    controller.signal,
  );
  controller.abort(new Error("fixture cancellation"));
  assert.equal((await cancelled).status, "cancelled");
});

test("program runner contains a TERM-ignoring descendant after cancellation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-program-kill-"));
  const marker = path.join(directory, "late-marker");
  const descendant = `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),400);`;
  const parent = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>process.stdout.write(JSON.stringify({ok:true})+'\\n'),50);`;
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
    await delay(40);
    controller.abort(new Error("cancel fixture"));
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.equal(result.output, null);
    await delay(600);
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally {
    await assert.rejects(stat(marker), { code: "ENOENT" });
  }
});

test("program runner forces the tree when the direct child exits on TERM", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-program-tree-close-"),
  );
  const marker = path.join(directory, "late-marker");
  const descendant = `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),400);`;
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  const controller = new AbortController();
  try {
    const running = runner.run(
      { command: process.execPath, args: ["-e", parent] },
      { invocationId: "tree-close", stage: "action", event: {} },
      controller.signal,
    );
    await delay(40);
    controller.abort(new Error("tree close fixture"));
    assert.equal((await running).status, "cancelled");
    await delay(600);
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally {
    await assert.rejects(stat(marker), { code: "ENOENT" });
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
