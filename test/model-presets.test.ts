import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_MODEL_CATALOG_PRESET_VERSION,
  builtInModelCatalogPreset,
  legacyModelCatalogEntries,
} from "../apps/cli/src/model-presets.js";

test("built-in model presets are versioned and keep unconfirmed facts unknown", () => {
  assert.equal(BUILTIN_MODEL_CATALOG_PRESET_VERSION, 1);
  const subscription = builtInModelCatalogPreset("openai-subscription");
  assert.deepEqual(
    subscription.map((entry) => entry.id),
    ["gpt-5.6-terra", "gpt-5.6-luna"],
  );
  assert.deepEqual(subscription[0]?.supportedReasoningEfforts, ["medium"]);
  assert.equal(subscription[0]?.contextWindow, null);
  assert.deepEqual(subscription[0]?.inputModalities, ["text"]);
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
