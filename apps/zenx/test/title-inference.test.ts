import assert from "node:assert/strict";
import test from "node:test";
import {
  ZenXConfiguredTitleInference,
  awaitCanonicalTitleSource,
} from "../src/main/title-inference.js";
import type { ZenXSettingsService } from "../src/main/settings-service.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import type { HostModelOperationRequest } from "../src/main/model-operation-messages.js";

test("configured title delegates canonical source identity and template to owning Host, never renderer draft text", async () => {
  const requests: HostModelOperationRequest[] = [];
  let releases = 0;
  const settings = {
    titleOperationConfiguration: async () => ({
      selection: { providerProfileId: "title", modelId: "title-model" },
      provider: {
        providerProfileId: "title",
        model: "title-model",
        provider: {
          type: "openai-compatible",
          baseUrl: "https://synthetic.invalid",
          apiKey: "synthetic",
        },
      },
      titlePrompt: "Name this request exactly: {{request}}",
      release: async () => {
        releases++;
      },
    }),
  } as unknown as ZenXSettingsService;
  const host = {
    onNotification: () => () => undefined,
    request: async () => ({
      thread: {
        turns: [
          {
            items: [
              {
                type: "userMessage",
                id: "canonical-source",
                content: [{ text: "Fix login" }],
              },
            ],
          },
        ],
      },
    }),
    runModelOperation: async (request: HostModelOperationRequest) => {
      requests.push(request);
      return {
        status: "completed",
        content: [{ type: "text", text: "A useful title" }],
      };
    },
  } as unknown as AppServerManager;
  const inference = new ZenXConfiguredTitleInference(settings, host);
  assert.equal(
    await inference.generate(
      "uncommitted different draft",
      "title-model",
      new AbortController().signal,
      { threadId: "canonical-thread" },
    ),
    "A useful title",
  );
  assert.deepEqual(requests[0]?.input, {
    kind: "title",
    threadId: "canonical-thread",
    sourceItemId: "canonical-source",
    selection: { providerProfileId: "title", modelId: "title-model" },
    titleTemplate: "Name this request exactly: {{request}}",
  });
  assert.doesNotMatch(JSON.stringify(requests), /uncommitted different draft/);
  assert.equal(releases, 1);
});

test("title admission wait is cancelable and removes its notification listener without model dispatch", async () => {
  let removed = 0;
  const controller = new AbortController();
  const host = {
    onNotification: () => () => {
      removed++;
    },
    request: async () => ({ thread: { turns: [] } }),
    runModelOperation: async () => {
      throw new Error("must not dispatch");
    },
  } as unknown as AppServerManager;
  const pending = awaitCanonicalTitleSource(host, "thread", controller.signal);
  controller.abort(new Error("cancelled title ownership"));
  await assert.rejects(pending, /cancelled title ownership/);
  assert.equal(removed, 1);
});
