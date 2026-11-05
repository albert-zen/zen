import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, test } from "node:test";

// Finite hosted opt-in. No keys, focus changes, pixels, AX reads or permission prompts.
const enabled =
  process.platform === "win32" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.ZENX_APP_SHOT_WINDOWS_SMOKE === "1";
const evidence: Record<string, unknown> = {
  scope: "real-windows-ffi-read-only-metadata",
  sourceRevision: process.env.GITHUB_SHA ?? "local",
  nativeLibrary: "not-run",
  foreground: "not-run",
  screenshotCapture: "not-tested",
  accessibilityRead: "not-tested",
  nativeShortcut: "not-tested",
  permissionChanges: false,
  fullNativeAcceptance: false,
};
after(() => {
  const output = process.env.ZENX_APP_SHOT_WINDOWS_EVIDENCE;
  if (output && enabled) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  }
});

test("real Windows metadata bridge loads and reads under a hard process deadline", {
  skip: !enabled, timeout: 12_000,
}, (t) => {
  evidence.nativeLibrary = "failed";
  const moduleUrl = new URL("../src/main/app-shot-windows-foreground.ts", import.meta.url).href;
  const source = `
    const { loadAppShotWindowsApi } = await import(${JSON.stringify(moduleUrl)});
    const api = await loadAppShotWindowsApi();
    const handle = api.getForegroundWindow();
    if (typeof handle !== "bigint") throw new Error("Invalid native HWND type");
    let result = { library: true, foreground: false };
    if (handle !== 0n) {
      const bounds = api.getWindowRect(handle);
      const owner = api.getWindowThreadAndProcessId(handle);
      const title = api.getWindowText(handle);
      const path = owner.processId > 0 ? api.getProcessImagePath(owner.processId) : "";
      result.foreground = Boolean(bounds && bounds.width > 0 && bounds.height > 0 &&
        owner.processId > 0 && title.trim() && typeof path === "string" &&
        api.getForegroundWindow() === handle);
    }
    process.stdout.write(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 8000, maxBuffer: 4096, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  // Never publish arbitrary native stderr, window titles, paths or process IDs.
  assert.equal(result.status, 0, "Windows ffi-rs production metadata bridge failed");
  const value = JSON.parse(result.stdout) as { library: boolean; foreground: boolean };
  assert.equal(value.library, true);
  evidence.nativeLibrary = "passed";
  if (!value.foreground) {
    evidence.foreground = "blocked-no-stable-named-foreground";
    t.skip("Hosted runner has no stable named foreground; capture remains unverified");
    return;
  }
  evidence.foreground = "passed-metadata-only";
});
