import assert from "node:assert/strict";
import test from "node:test";

import type { ModelAdapter, ModelRequest } from "../../../src/model.js";
import { ZenXConfiguredTitleInference } from "../src/main/title-inference.js";
import type { ZenXSettingsService } from "../src/main/settings-service.js";

test("configured title inference renders the explicit request placeholder outside Thread history", async () => {
  const requests: ModelRequest[] = [];
  const adapter = {
    provider: "test",
    async *stream(request: ModelRequest) {
      requests.push(request);
      yield { type: "text_delta" as const, delta: "A useful title" };
    },
  } as ModelAdapter;
  const settings = {
    titleModel: async () => ({
      adapter,
      model: "title-model",
      reasoningEffort: "low",
      release: async () => undefined,
    }),
    publicSettings: async () => ({
      profile: { titlePrompt: "Name this request exactly: {{request}}" },
    }),
  } as unknown as ZenXSettingsService;

  const inference = new ZenXConfiguredTitleInference(settings);
  assert.equal(
    await inference.generate(
      "Fix login",
      "title-model",
      new AbortController().signal,
    ),
    "A useful title",
  );
  assert.deepEqual(requests[0]?.messages, [
    { role: "user", text: "Name this request exactly: Fix login" },
  ]);
});
