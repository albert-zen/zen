import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, test } from "node:test";
import {
  MAC_ACTIVE_WINDOW_JXA,
  MAC_WINDOW_METADATA_JXA,
} from "../src/main/app-shot-native.js";

// Explicit hosted opt-in; never prompts, captures pixels, reads AX or changes TCC.
const enabled =
  process.platform === "darwin" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.ZENX_APP_SHOT_JXA_SMOKE === "1";
const evidence: Record<string, unknown> = {
  scope: "real-osascript-coregraphics-metadata-bridge-only",
  sourceRevision: process.env.GITHUB_SHA ?? "local",
  permissionChanges: false,
  screenshotCapture: "not-tested",
  accessibilityRead: "not-tested",
  nativeShortcut: "not-tested",
  fullNativeAcceptance: false,
  bridge: "not-run",
  foreground: "not-run",
};
after(() => {
  const output = process.env.ZENX_APP_SHOT_JXA_EVIDENCE;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  }
});

function run(source: string) {
  const result = spawnSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", source],
    { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
  );
  assert.ifError(result.error);
  assert.equal(
    result.signal,
    null,
    "JXA must settle within its production budget",
  );
  return result;
}

test(
  "real macOS JXA enumerates CoreGraphics through the production bridge",
  { skip: !enabled, timeout: 5000 },
  () => {
    evidence.bridge = "failed";
    // CG window 0 is the null ID. Execute the actual source to its own expected
    // refusal; the public wrapper masks bridge failures and cannot prove this.
    const result = run(MAC_WINDOW_METADATA_JXA.replace("__WINDOW_ID__", "0"));
    assert.notEqual(result.status, 0, "The null CG window must never resolve");
    assert.match(
      result.stderr,
      /Error: Window not found/,
      "Unexpected native bridge failure",
    );
    evidence.bridge = "passed-null-window-refusal";
  },
);

test(
  "real macOS foreground JXA reports metadata or an explicit environment blocker",
  { skip: !enabled, timeout: 8000 },
  (t) => {
    evidence.foreground = "failed";
    const active = run(MAC_ACTIVE_WINDOW_JXA);
    if (active.status !== 0) {
      assert.match(
        active.stderr,
        /Error: No foreground (application|window)/,
        "Unexpected foreground bridge failure",
      );
      evidence.foreground = "blocked-no-foreground-window";
      t.skip(
        "Hosted runner has no foreground application window; no native acceptance",
      );
      return;
    }
    const value = JSON.parse(active.stdout) as Record<string, unknown>;
    assert.ok(
      Number.isSafeInteger(value.windowId) && Number(value.windowId) > 0,
    );
    assert.ok(Number.isSafeInteger(value.pid) && Number(value.pid) > 0);
    assert.equal(typeof value.windowTitle, "string");
    if (!(value.windowTitle as string).trim()) {
      // Screen Recording may redact titles. This is not evidence of permission
      // denial specifically, and no request/grant/reset is attempted.
      evidence.foreground = "blocked-missing-title-permission-or-session";
      t.skip(
        "Hosted window title unavailable; Screen Recording/session unverified",
      );
      return;
    }
    const selected = run(
      MAC_WINDOW_METADATA_JXA.replace("__WINDOW_ID__", String(value.windowId)),
    );
    if (selected.status !== 0) {
      assert.match(
        selected.stderr,
        /Error: Window not found/,
        "Unexpected selected-window bridge failure",
      );
      evidence.foreground = "blocked-window-retired";
      t.skip("Foreground window retired before exact metadata lookup");
      return;
    }
    const metadata = JSON.parse(selected.stdout) as Record<string, unknown>;
    assert.equal(metadata.windowId, value.windowId);
    assert.equal(metadata.pid, value.pid);
    if (metadata.windowTitle !== value.windowTitle) {
      evidence.foreground = "blocked-title-changed";
      t.skip("Foreground window title changed between observations");
      return;
    }
    // Do not export arbitrary runner application/window titles or PIDs.
    evidence.foreground = "passed-exact-metadata-only";
  },
);
