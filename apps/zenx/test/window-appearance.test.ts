import assert from "node:assert/strict";
import test from "node:test";
import { windowBackdropOptions } from "../src/main/window-appearance.js";

test("desktop translucency uses native materials only on supported systems", () => {
  assert.deepEqual(windowBackdropOptions("win32", "10.0.22631"), {
    backgroundColor: "#00000000",
    backgroundMaterial: "acrylic",
  });
  assert.deepEqual(windowBackdropOptions("darwin", "24.0.0"), {
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
  });
  for (const [platform, release] of [
    ["win32", "10.0.22000"],
    ["win32", "10.0.19045"],
    ["linux", "6.8.0"],
  ] as const) {
    assert.deepEqual(windowBackdropOptions(platform, release), {
      backgroundColor: "#0b0d10",
    });
  }
});
