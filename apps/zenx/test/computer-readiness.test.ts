import assert from "node:assert/strict";
import test from "node:test";

import {
  computerReadinessSnapshot,
  probeComputerAccess,
} from "../src/main/computer-readiness.js";

test("unknown screen status stays unknown instead of being reported as denial", () => {
  assert.deepEqual(
    computerReadinessSnapshot({
      platform: "darwin",
      accessibilityTrusted: false,
      screenRecording: "unexpected-status",
      foregroundControlEnabled: false,
    }),
    {
      platform: "darwin",
      accessibility: "needs-setup",
      screenRecording: "unknown",
      foregroundControlEnabled: false,
    },
  );
  assert.deepEqual(
    computerReadinessSnapshot({
      platform: "win32",
      foregroundControlEnabled: true,
    }),
    {
      platform: "win32",
      accessibility: "not-applicable",
      screenRecording: "not-applicable",
      foregroundControlEnabled: true,
    },
  );
});

test("probe checks the native helper and uses a denied screen status for direct setup", async () => {
  let accessibilityChecks = 0;
  let captureChecks = 0;
  const result = await probeComputerAccess(
    computerReadinessSnapshot({
      platform: "darwin",
      accessibilityTrusted: true,
      screenRecording: "denied",
      foregroundControlEnabled: false,
    }),
    {
      accessibility: async () => {
        accessibilityChecks += 1;
      },
      screenCapture: async () => {
        captureChecks += 1;
      },
      screenRecordingStatus: () => "denied",
    },
  );
  assert.deepEqual(result, {
    accessibility: { state: "ready" },
    screenCapture: { state: "needs-setup" },
  });
  assert.equal(accessibilityChecks, 1);
  assert.equal(captureChecks, 0);
});

test("capture probe reports the actual error without calling it a permission denial", async () => {
  const result = await probeComputerAccess(
    computerReadinessSnapshot({
      platform: "darwin",
      accessibilityTrusted: true,
      screenRecording: "granted",
      foregroundControlEnabled: false,
    }),
    {
      accessibility: async () => undefined,
      screenCapture: async () => {
        throw new Error("Failed to get sources");
      },
      screenRecordingStatus: () => "granted",
    },
  );
  assert.deepEqual(result, {
    accessibility: { state: "ready" },
    screenCapture: {
      state: "failed",
      detail: "Failed to get sources",
    },
  });
});

test("native helper denial is a setup issue even if Electron itself is trusted", async () => {
  const result = await probeComputerAccess(
    computerReadinessSnapshot({
      platform: "darwin",
      accessibilityTrusted: true,
      screenRecording: "not-determined",
      foregroundControlEnabled: false,
    }),
    {
      accessibility: async () => {
        throw new Error("macOS Accessibility denied for helper");
      },
      screenCapture: async () => undefined,
      screenRecordingStatus: () => "granted",
    },
  );
  assert.deepEqual(result, {
    accessibility: { state: "needs-setup" },
    screenCapture: { state: "ready" },
  });
});

test("a thumbnail alone does not verify Screen Recording when macOS still reports undetermined", async () => {
  const result = await probeComputerAccess(
    computerReadinessSnapshot({
      platform: "darwin",
      accessibilityTrusted: true,
      screenRecording: "not-determined",
      foregroundControlEnabled: false,
    }),
    {
      accessibility: async () => undefined,
      screenCapture: async () => undefined,
      screenRecordingStatus: () => "not-determined",
    },
  );
  assert.equal(result.screenCapture.state, "unknown");
});

test("a failed Screen Recording status read does not become a capture failure", async () => {
  const result = await probeComputerAccess(
    computerReadinessSnapshot({
      platform: "darwin",
      accessibilityTrusted: true,
      screenRecording: "unknown",
      foregroundControlEnabled: false,
    }),
    {
      accessibility: async () => undefined,
      screenCapture: async () => undefined,
      screenRecordingStatus: () => {
        throw new Error("TCC status unavailable");
      },
    },
  );
  assert.equal(result.screenCapture.state, "unknown");
});
