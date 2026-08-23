import assert from "node:assert/strict";
import test from "node:test";

import {
  activationNeedsWindow,
  secondInstanceDisposition,
  windowAllClosedDisposition,
} from "../src/main/desktop-lifecycle.js";

test("keeps the app-owned Host alive after the last window closes on every desktop platform", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    assert.equal(windowAllClosedDisposition(platform), "keep-host-running");
  }
});

test("re-activation recreates only a missing window", () => {
  assert.equal(activationNeedsWindow(0), true);
  assert.equal(activationNeedsWindow(1), false);
});

test("only the process holding Electron's single-instance lock may publish authority", () => {
  assert.equal(secondInstanceDisposition(true), "own-authority");
  assert.equal(secondInstanceDisposition(false), "defer-to-owner");
});
