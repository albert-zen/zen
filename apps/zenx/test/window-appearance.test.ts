import assert from "node:assert/strict";
import test from "node:test";
import { windowBackdropOptions } from "../src/main/window-appearance.js";

test("desktop windows use an opaque background without native materials", () => {
  assert.deepEqual(windowBackdropOptions(), { backgroundColor: "#0b0d10" });
});
