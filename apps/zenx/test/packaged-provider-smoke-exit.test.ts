import assert from "node:assert/strict";
import test from "node:test";

import { packagedProviderSmokeExitCode } from "../src/main/packaged-provider-smoke-exit.js";

test("packaged provider smoke exits nonzero after an assertion failure", () => {
  assert.equal(packagedProviderSmokeExitCode(new Error("fixture failure")), 1);
});

test("packaged provider smoke exits zero after a successful run", () => {
  assert.equal(packagedProviderSmokeExitCode(undefined), 0);
});
