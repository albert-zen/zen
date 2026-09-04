import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_MODEL_CATALOG_PRESET_VERSION,
  builtInModelCatalogPreset,
  legacyModelCatalogEntries,
} from "../apps/cli/src/model-presets.js";

test("built-in model presets are versioned and provide runnable context windows", () => {
  assert.equal(BUILTIN_MODEL_CATALOG_PRESET_VERSION, 4);
  const subscription = builtInModelCatalogPreset("openai-subscription");
  assert.deepEqual(
    subscription.map((entry) => entry.id),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
  );
  assert.deepEqual(
    subscription.map((entry) => entry.supportedReasoningEfforts),
    [
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["low", "medium", "high", "xhigh", "max"],
      ["low", "medium", "high", "xhigh"],
      ["low", "medium", "high", "xhigh"],
    ],
  );
  assert.deepEqual(
    subscription.map((entry) => entry.defaultReasoningEffort),
    ["medium", "medium", "medium", "medium", "medium"],
  );
  assert.deepEqual(
    subscription.map((entry) => entry.inputModalities),
    Array.from({ length: 5 }, () => ["text", "image"]),
  );
  assert.deepEqual(
    subscription.map((entry) => entry.contextWindow),
    Array.from({ length: 5 }, () => 256_000),
  );
  assert.equal(builtInModelCatalogPreset("fake")[0]?.contextWindow, 16_384);
  assert.deepEqual(builtInModelCatalogPreset("openai-compatible"), []);
});

test("legacy model ids use matching presets and remain runnable otherwise", () => {
  const entries = legacyModelCatalogEntries("openai-subscription", [
    "gpt-5.6-terra",
    "user-confirmed-custom",
  ]);
  assert.equal(entries[0]?.source, "preset");
  assert.deepEqual(entries[1], {
    id: "user-confirmed-custom",
    source: "legacy",
  });
});
