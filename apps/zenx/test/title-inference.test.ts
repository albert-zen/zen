import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileTraceStore } from "../../../src/trace.js";
import { FileItemListStore } from "../../../src/item-list-store.js";
import { closeModelTrace } from "../../../src/trace-model.js";

import type { ModelAdapter, ModelRequest } from "../../../src/model.js";
import { ZenXConfiguredTitleInference } from "../src/main/title-inference.js";
import type { ZenXSettingsService } from "../src/main/settings-service.js";

test("configured title inference renders the explicit request placeholder outside Thread history", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-title-"));
  const trace = new FileTraceStore(path.join(directory, "trace"));
  t.after(async () => {
    await closeModelTrace(trace);
    await rm(directory, { recursive: true, force: true });
  });
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
      trace,
      itemListStore: new FileItemListStore(
        path.join(directory, "context-bundles"),
      ),
      titlePrompt: "Name this request exactly: {{request}}",
      configuration: {},
      assertDispatchAllowed: () => undefined,
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
    {
      role: "user",
      content: [{ type: "text", text: "Name this request exactly: Fix login" }],
    },
  ]);
});
