import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostedAppServer } from "../../../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { ToolEnvironment, type ToolRuntime } from "../../../src/tool.js";

test("host seam preserves compatible effort, falls back atomically, and freezes the active Turn", async () => {
  const enteredTool = deferred<void>();
  const releaseTool = deferred<void>();
  const runtime: ToolRuntime = {
    name: "shell",
    specification: {
      name: "shell",
      description: "Test shell",
      inputSchema: { type: "object" },
    },
    async execute() {
      enteredTool.resolve();
      await releaseTool.promise;
      return { output: "frozen-selection", exitCode: 0 };
    },
  };
  const appServer = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "unused-zenx-model-selection"),
    approvalPolicy: "never",
    journal: new InMemoryThreadJournal(),
    toolEnvironment: new ToolEnvironment({
      bundles: [
        {
          identity: { kind: "external", id: "composer-test" },
          tools: [runtime],
        },
      ],
    }),
    providers: [
      {
        providerProfileId: "alpha",
        provider: { type: "fake" },
        model: "alpha-medium",
        modelCatalog: [
          {
            id: "alpha-medium",
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
          },
          {
            id: "alpha-compatible",
            supportedReasoningEfforts: ["low", "medium"],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
          },
        ],
      },
      {
        providerProfileId: "beta",
        provider: { type: "fake" },
        model: "beta-low",
        modelCatalog: [
          {
            id: "beta-low",
            supportedReasoningEfforts: ["low"],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
          },
        ],
      },
    ],
    defaultSelection: { providerProfileId: "alpha", modelId: "alpha-medium" },
  });
  try {
    const thread = await appServer.startThread();
    const active = await appServer.startTurn(thread.id, "!shell hold");
    await enteredTool.promise;

    const compatible = await appServer.updateThreadSettings(thread.id, {
      selection: {
        providerProfileId: "alpha",
        modelId: "alpha-compatible",
      },
    });
    assert.equal(compatible.reasoningEffort, "medium");

    const fallback = await appServer.updateThreadSettings(thread.id, {
      selection: { providerProfileId: "beta", modelId: "beta-low" },
    });
    assert.deepEqual(
      {
        providerProfileId: fallback.providerProfileId,
        modelId: fallback.modelId,
        reasoningEffort: fallback.reasoningEffort,
      },
      {
        providerProfileId: "beta",
        modelId: "beta-low",
        reasoningEffort: "low",
      },
    );

    releaseTool.resolve();
    await active.done;
    assert.deepEqual(
      (await appServer.readThread(thread.id)).turns[0]?.selection,
      {
        providerProfileId: "alpha",
        modelId: "alpha-medium",
        reasoningEffort: "medium",
      },
    );

    await (
      await appServer.startTurn(thread.id, "use the next selection")
    ).done;
    assert.deepEqual(
      (await appServer.readThread(thread.id)).turns[1]?.selection,
      {
        providerProfileId: "beta",
        modelId: "beta-low",
        reasoningEffort: "low",
      },
    );
  } finally {
    releaseTool.resolve();
    await appServer.closeProviderTransport();
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
