import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  fileEditorAfterFailureProbe,
} = require("../scripts/file-editor-style-probe-receipt.cjs");

test("any after-failure diagnostic error returns a separate receipt, never replaces the native error", async () => {
  for (const failAt of [
    "persistOriginal",
    "captureOriginal",
    "runProbe",
    "persistProbe",
  ]) {
    const calls: string[] = [];
    const tasks = Object.fromEntries(
      ["persistOriginal", "captureOriginal", "runProbe", "persistProbe"].map(
        (name) => [
          name,
          async () => {
            calls.push(name);
            if (name === failAt) throw new Error(`synthetic ${name} failure`);
            return { synthetic: true };
          },
        ],
      ),
    );
    const original = new Error("original native End assertion failed");
    let thrown: unknown;
    let diagnostic: any;
    try {
      diagnostic = await fileEditorAfterFailureProbe(tasks);
      throw original;
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, original);
    assert.equal(diagnostic.diagnosticStatus, "failed");
    assert.match(diagnostic.failure, new RegExp(`synthetic ${failAt} failure`));
    if (failAt === "persistOriginal" || failAt === "captureOriginal") {
      assert.equal(diagnostic.probeAttempted, false);
      assert.ok(!calls.includes("runProbe"));
    }
  }
});

test("a stalled after-failure probe has an independent deadline and an explicit uncertain receipt", async () => {
  const calls: string[] = [];
  const receipt = await fileEditorAfterFailureProbe({
    persistOriginal: async () => {
      calls.push("original");
    },
    captureOriginal: async () => {
      calls.push("screenshot");
    },
    runProbe: () => new Promise(() => {}),
    persistProbe: async () => {
      calls.push("probe-saved");
    },
    deadlineMs: 1,
  });
  assert.deepEqual(calls, ["original", "screenshot"]);
  assert.equal(receipt.diagnosticStatus, "failed");
  assert.equal(receipt.originalReceiptPersisted, true);
  assert.equal(receipt.probeMayStillBeRunning, true);
  assert.match(receipt.failure, /completion is uncertain/);
});

test("successful diagnostics persist original artifacts first and do not claim native success", async () => {
  const calls: string[] = [];
  const result = { synthetic: true };
  const receipt = await fileEditorAfterFailureProbe({
    persistOriginal: async () => {
      calls.push("original");
    },
    captureOriginal: async () => {
      calls.push("screenshot");
    },
    runProbe: async () => {
      calls.push("probe");
      return result;
    },
    persistProbe: async (actual: unknown) => {
      assert.equal(actual, result);
      calls.push("probe-saved");
    },
  });
  assert.deepEqual(calls, ["original", "screenshot", "probe", "probe-saved"]);
  assert.equal(receipt.diagnosticStatus, "complete");
  assert.equal(receipt.probeMayStillBeRunning, false);
  assert.match(receipt.scope, /native assertion remains failed/);
});
