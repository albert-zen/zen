import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NativeComputerTargetTransport } from "../src/main/capabilities/computer-target-transport.js";

test("transport cancellation destroys binding process without replay, then allows explicit reselection", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-target-transport-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fixture.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});\nrl.on('line',line=>{const r=JSON.parse(line);if(r.operation==='select') console.log(JSON.stringify({result:{pid:process.pid}}));});\n`,
    { mode: 0o700 },
  );
  const transport = new NativeComputerTargetTransport(async () => executable);
  t.after(() => transport.close());
  const signal = new AbortController().signal;
  const before = (await transport.request({ operation: "select" }, signal)) as {
    pid: number;
  };
  const controller = new AbortController();
  const pending = transport.request(
    { operation: "key" },
    controller.signal,
    () => {
      throw new Error("broken presentation");
    },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /outcome unknown/);
  assert.throws(() => process.kill(before.pid, 0), { code: "ESRCH" });
  await assert.rejects(
    transport.request({ operation: "key" }, signal),
    /no input dispatched/,
  );
  const after = (await transport.request({ operation: "select" }, signal)) as {
    pid: number;
  };
  assert.notEqual(before.pid, after.pid);
});

test("transport shutdown during executable preparation cannot start a helper", async () => {
  let release!: (value: string) => void;
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const executable = new Promise<string>((resolve) => {
    release = resolve;
  });
  const transport = new NativeComputerTargetTransport(async () => {
    entered();
    return executable;
  });
  const request = transport.request(
    { operation: "select" },
    new AbortController().signal,
  );
  const rejected = assert.rejects(request, /session is closed/);
  await preparing;
  await transport.close();
  release(process.execPath);
  await rejected;
});

for (const response of ["not-json", "null", "{}"])
  test(`invalid native receipt ${response} settles only after child closure`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-target-invalid-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "fixture.cjs");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});\nrl.on('line',line=>{const r=JSON.parse(line);console.log(r.operation==='select'?JSON.stringify({result:{pid:process.pid}}):${JSON.stringify(response)});});\n`,
      { mode: 0o700 },
    );
    const transport = new NativeComputerTargetTransport(async () => executable);
    t.after(() => transport.close());
    const signal = new AbortController().signal;
    const selected = (await transport.request(
      { operation: "select" },
      signal,
    )) as { pid: number };
    await assert.rejects(
      transport.request({ operation: "key" }, signal),
      /Invalid native target response.*outcome unknown/,
    );
    assert.throws(() => process.kill(selected.pid, 0), { code: "ESRCH" });
    await assert.rejects(
      transport.request({ operation: "key" }, signal),
      /no input dispatched/,
    );
    const reselected = (await transport.request(
      { operation: "select" },
      signal,
    )) as { pid: number };
    assert.notEqual(selected.pid, reselected.pid);
  });
