import assert from "node:assert/strict";
import test from "node:test";

import { StaticModelCatalog } from "../src/model-catalog.js";

test("keeps unknown capabilities distinct from known unsupported capabilities", () => {
  const catalog = new StaticModelCatalog([
    {
      id: "unknown",
      isDefault: true,
      source: "discovered",
      supportedReasoningEfforts: null,
      defaultReasoningEffort: null,
      inputModalities: null,
      contextWindow: null,
    },
    {
      id: "unsupported",
      source: "manual",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: [],
      contextWindow: 32_768,
    },
  ]);

  assert.deepEqual(catalog.get("unknown"), {
    id: "unknown",
    displayName: "unknown",
    description: "",
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: null,
    defaultReasoningEffort: null,
    inputModalities: null,
    contextWindow: null,
    source: "discovered",
  });
  assert.deepEqual(catalog.get("unsupported"), {
    id: "unsupported",
    displayName: "unsupported",
    description: "",
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: [],
    contextWindow: 32_768,
    source: "manual",
  });
});

test("validates catalog source and capability metadata without guessing", () => {
  const base = {
    id: "model",
    isDefault: true,
    source: "manual" as const,
    supportedReasoningEfforts: ["low"],
    defaultReasoningEffort: "low",
    inputModalities: ["text" as const],
    contextWindow: 8_192,
  };
  assert.throws(
    () =>
      new StaticModelCatalog([
        { ...base, source: "provider-marketing" as never },
      ]),
    /source/u,
  );
  assert.throws(
    () => new StaticModelCatalog([{ ...base, contextWindow: 0 }]),
    /context window/u,
  );
  assert.throws(
    () =>
      new StaticModelCatalog([{ ...base, inputModalities: ["text", "text"] }]),
    /input modalities/u,
  );
  assert.throws(
    () =>
      new StaticModelCatalog([
        {
          ...base,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "low",
        },
      ]),
    /default reasoning effort/u,
  );
});
