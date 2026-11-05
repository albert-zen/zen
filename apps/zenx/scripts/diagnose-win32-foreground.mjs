// Disposable hosted-runner diagnostics only. No input, activation, or settings changes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const source = await readFile(new URL("./chrome-extension-provider-smoke.mjs", import.meta.url), "utf8");
const match = /const foregroundScript = `([\s\S]*?)`;/u.exec(source);
assert.ok(match, "Read the exact committed sampler script");
const original = match[1];
const results = [];
async function measure(name, script, timeout) {
  const started = performance.now();
  try {
    const { stdout, stderr } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout, maxBuffer: 16384 });
    const sample = JSON.parse(stdout.trim());
    assert.equal(typeof sample.pid, "number");
    assert.match(sample.hwnd, /^\d+$/u);
    results.push({ name, timeout, elapsedMs: performance.now() - started, status: "passed", stderr, sampleValid: true });
  } catch (error) {
    results.push({ name, timeout, elapsedMs: performance.now() - started, status: "failed", code: error.code, killed: error.killed, signal: error.signal, stdout: error.stdout, stderr: error.stderr, message: error.message });
  }
}
await measure("exact-production-five-second-budget", original, 5000);
const instrumented = `[Console]::Error.WriteLine("sampler:script-entered")\n` + original.replace("$window =", `[Console]::Error.WriteLine("sampler:compiled")\n$window =`).replace("@{pid=", `[Console]::Error.WriteLine("sampler:sampled")\n@{pid=`);
await measure("instrumented-cold-compile-diagnostic", instrumented, 60000);
await measure("repeat-production-five-second-budget", original, 5000);
const report = { head: process.env.GITHUB_SHA, node: process.version, results, safety: "Read-only Win32 observations on a disposable runner. No input or activation. Diagnostic extended budget does not change production." };
await mkdir(process.env.RUNNER_TEMP + "/foreground-diagnostic", { recursive: true });
await writeFile(process.env.RUNNER_TEMP + "/foreground-diagnostic/result.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
