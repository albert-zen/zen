import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWindowsForegroundSampler } from "../scripts/windows-foreground-sampler.mjs";

async function fixture(t, customize = {}) {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "sampler-test-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const calls = [];
  let assemblyPath;
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(file, "powershell.exe");
    assert.deepEqual(args.slice(0, 3), [
      "-NoProfile",
      "-NonInteractive",
      "-File",
    ]);
    if (path.basename(args[3]) === "compile.ps1") {
      assemblyPath = args[5];
      const source = await readFile(args[4], "utf8");
      assert.match(source, /GetForegroundWindow/u);
      assert.match(source, /GetWindowThreadProcessId/u);
      assert.doesNotMatch(
        source,
        /SendInput|SetForegroundWindow|ShowWindow|EnumWindows/u,
      );
      if (customize.compile) return customize.compile(assemblyPath);
      await writeFile(assemblyPath, "synthetic test assembly");
      return { stdout: "" };
    }
    const script = await readFile(args[3], "utf8");
    assert.match(script, /Add-Type -Path \$AssemblyPath/u);
    assert.doesNotMatch(script, /-TypeDefinition/u);
    assert.match(script, /GetForegroundWindow\(\)/u);
    assert.match(script, /GetWindowThreadProcessId/u);
    if (customize.read) return customize.read();
    return { stdout: JSON.stringify({ pid: 7, hwnd: String(calls.length) }) };
  };
  const create = () =>
    createWindowsForegroundSampler({
      run,
      platform: "win32",
      ci: "true",
      temporaryDirectory,
    });
  return { create, calls, temporaryDirectory, assembly: () => assemblyPath };
}

test("compile once, retain five-second fresh-read budget, and remove owned staging", async (t) => {
  const f = await fixture(t);
  const sampler = await f.create();
  assert.equal(f.calls[0].options.timeout, 60_000);
  assert.deepEqual(await sampler.read(), { pid: 7, hwnd: "2" });
  assert.deepEqual(await sampler.read(), { pid: 7, hwnd: "3" });
  assert.ok(
    f.calls
      .slice(1)
      .every((c) => c.options.timeout === 5000 && c.options.windowsHide),
  );
  await sampler.close();
  await sampler.close();
  assert.deepEqual(await readdir(f.temporaryDirectory), []);
  await assert.rejects(sampler.read(), /closed/u);
  assert.equal(f.calls.length, 3);
});

test("compile failure cannot create a sampler or dispatch a read and cleans staging", async (t) => {
  const f = await fixture(t, {
    compile: async () => {
      throw new Error("compiler failed");
    },
  });
  await assert.rejects(f.create(), /compiler failed/u);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readdir(f.temporaryDirectory), []);
});

test("missing or empty compile output fails closed", async (t) => {
  for (const compile of [async () => {}, async (p) => writeFile(p, "")]) {
    const f = await fixture(t, { compile });
    await assert.rejects(f.create());
    assert.deepEqual(await readdir(f.temporaryDirectory), []);
  }
});

test("changed assembly is rejected before launching sample", async (t) => {
  const f = await fixture(t);
  const sampler = await f.create();
  await writeFile(f.assembly(), "changed");
  await assert.rejects(sampler.read(), /assembly changed/u);
  assert.equal(f.calls.length, 1);
  await sampler.close();
});

test("read failure is surfaced once without retry or cached sample", async (t) => {
  const f = await fixture(t, {
    read: async () => {
      throw new Error("sample timed out");
    },
  });
  const sampler = await f.create();
  await assert.rejects(sampler.read(), /sample timed out/u);
  assert.equal(f.calls.length, 2);
  await sampler.close();
});

test("malformed, missing and extra foreground fields fail closed", async (t) => {
  for (const value of [
    "not json",
    "null",
    "{}",
    '{"pid":0,"hwnd":"2"}',
    '{"pid":7,"hwnd":"0"}',
    '{"pid":7,"hwnd":"2","extra":true}',
  ]) {
    const f = await fixture(t, { read: async () => ({ stdout: value }) });
    const sampler = await f.create();
    await assert.rejects(sampler.read());
    await sampler.close();
  }
});

test("native sampler remains restricted to hosted Windows", async () => {
  await assert.rejects(
    createWindowsForegroundSampler({ platform: "linux", ci: "true" }),
  );
  await assert.rejects(
    createWindowsForegroundSampler({ platform: "win32", ci: "false" }),
  );
});

test("failed sample retains bounded stage evidence, never raw output or a cached result", async (t) => {
  const failure = Object.assign(new Error("timeout"), {
    killed: true,
    signal: "SIGTERM",
    stderr:
      "private\nZEN_FOREGROUND_STAGE:started\nZEN_FOREGROUND_STAGE:assembly-loaded\n",
    stdout: "private",
  });
  const f = await fixture(t, {
    read: async () => {
      throw failure;
    },
  });
  const sampler = await f.create();
  for (let i = 0; i < 10; i++)
    await assert.rejects(sampler.read(), (e) => e === failure);
  assert.equal(f.calls.length, 11);
  assert.equal(sampler.evidence.failedSamples.length, 8);
  assert.equal(sampler.evidence.failedSamplesDropped, 2);
  const first = sampler.evidence.failedSamples[0];
  assert.deepEqual(first.stages, ["started", "assembly-loaded"]);
  assert.equal(first.budgetMs, 5000);
  assert.equal(first.killed, true);
  assert.ok(first.elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(sampler.evidence), /private/);
  assert.deepEqual(sampler.evidence.sampleElapsedMs, []);
  await sampler.close();
});
