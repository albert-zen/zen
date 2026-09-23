import assert from "node:assert/strict";
import test from "node:test";

import { computerReadinessSnapshot } from "../src/main/computer-readiness.js";

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
