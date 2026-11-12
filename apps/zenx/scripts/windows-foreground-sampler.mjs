// Disposable, read-only smoke helper. Compilation is setup, never an input receipt.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const source = `using System;
using System.Runtime.InteropServices;
public static class ForegroundWitness {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}`;
const compileScript = `param([string] $SourcePath, [string] $AssemblyPath)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($SourcePath)) -OutputAssembly $AssemblyPath -OutputType Library
`;
const sampleScript = `param([string] $AssemblyPath)
$ErrorActionPreference = "Stop"
[Console]::Error.WriteLine("ZEN_FOREGROUND_STAGE:started")
Add-Type -Path $AssemblyPath
[Console]::Error.WriteLine("ZEN_FOREGROUND_STAGE:assembly-loaded")
$window = [ForegroundWitness]::GetForegroundWindow()
[Console]::Error.WriteLine("ZEN_FOREGROUND_STAGE:window-read")
[uint32]$owner = 0
[void][ForegroundWitness]::GetWindowThreadProcessId($window, [ref]$owner)
[Console]::Error.WriteLine("ZEN_FOREGROUND_STAGE:owner-read")
@{pid=$owner;hwnd=$window.ToInt64().ToString()} | ConvertTo-Json -Compress
`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function createWindowsForegroundSampler({
  run = promisify(execFile),
  platform = process.platform,
  ci = process.env.GITHUB_ACTIONS,
  temporaryDirectory = tmpdir(),
} = {}) {
  assert.equal(platform, "win32");
  assert.equal(ci, "true");
  const directory = await mkdtemp(
    path.join(temporaryDirectory, "zenx-foreground-"),
  );
  const sourcePath = path.join(directory, "sampler.cs");
  const assemblyPath = path.join(directory, "sampler.dll");
  const compilePath = path.join(directory, "compile.ps1");
  const samplePath = path.join(directory, "sample.ps1");
  let closed = false;
  const invoke = (script, args, timeout) =>
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", script, ...args],
      { windowsHide: true, timeout, maxBuffer: 4096 },
    );
  try {
    await Promise.all([
      writeFile(sourcePath, source, { flag: "wx" }),
      writeFile(compilePath, compileScript, { flag: "wx" }),
      writeFile(samplePath, sampleScript, { flag: "wx" }),
    ]);
    // Separate cold PowerShell/CodeDom setup from the unchanged 5s sample budget.
    const setupStarted = performance.now();
    await invoke(compilePath, [sourcePath, assemblyPath], 60_000);
    const assembly = await readFile(assemblyPath);
    assert.ok(
      assembly.length > 0,
      "Foreground sampler compilation produced no assembly",
    );
    const assemblySha256 = digest(assembly);
    const evidence = {
      setupElapsedMs: performance.now() - setupStarted,
      sampleElapsedMs: [],
      failedSamples: [],
      failedSamplesDropped: 0,
    };
    return {
      evidence,
      async read() {
        assert.equal(closed, false, "Foreground sampler is closed");
        assert.equal(
          digest(await readFile(assemblyPath)),
          assemblySha256,
          "Foreground sampler assembly changed",
        );
        const sampleStarted = performance.now();
        let stdout;
        try {
          ({ stdout } = await invoke(samplePath, [assemblyPath], 5000));
        } catch (error) {
          const stages = String(error?.stderr ?? "")
            .split(/\r?\n/u)
            .filter((line) =>
              /^ZEN_FOREGROUND_STAGE:(started|assembly-loaded|window-read|owner-read)$/u.test(
                line,
              ),
            )
            .slice(0, 4)
            .map((line) => line.slice("ZEN_FOREGROUND_STAGE:".length));
          if (evidence.failedSamples.length < 8)
            evidence.failedSamples.push({
              elapsedMs: performance.now() - sampleStarted,
              budgetMs: 5000,
              killed: error?.killed === true,
              signal: error?.signal === "SIGTERM" ? "SIGTERM" : null,
              stages,
            });
          else evidence.failedSamplesDropped++;
          throw error;
        }
        if (evidence.sampleElapsedMs.length < 64)
          evidence.sampleElapsedMs.push(performance.now() - sampleStarted);
        const sample = JSON.parse(stdout.trim());
        assert.deepEqual(Object.keys(sample).sort(), ["hwnd", "pid"]);
        assert.ok(
          Number.isSafeInteger(sample.pid) && sample.pid > 0,
          "Foreground PID is missing",
        );
        assert.match(sample.hwnd, /^[1-9][0-9]*$/u);
        // Never cache a HWND/PID result. Each read above executes both Win32 calls.
        return sample;
      },
      async close() {
        if (closed) return;
        closed = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
