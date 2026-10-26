import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHostedAppServer,
  type HostProviderProfile,
} from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import type { CanonicalItem } from "../src/item.js";

const draft: HostProviderProfile = {
  providerProfileId: "unapplied-draft",
  provider: {
    type: "openai-compatible",
    baseUrl: "https://draft.invalid/v1",
    apiKey: "synthetic-private-key",
  },
  model: "draft",
  modelCatalog: [
    {
      id: "draft",
      isDefault: true,
      contextWindow: null,
      supportedReasoningEfforts: null,
      defaultReasoningEffort: null,
    },
  ],
};
test("Host draft probe uses one canonical journal, never publishes credentials/configuration, and releases on success/error/append failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-canonical-aux-"));
  class Journal extends InMemoryThreadJournal {
    rejectContext = false;
    override async append(item: CanonicalItem) {
      if (this.rejectContext && item.type === "context_message")
        throw new Error("synthetic unknown append");
      await super.append(item);
    }
  }
  const journal = new Journal();
  let calls = 0,
    closes = 0,
    failHttp = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_tokens, 1);
      const all = (
        await Promise.all(
          (await journal.listThreadIds()).map((id) => journal.read(id)),
        )
      ).flat();
      assert(
        all.some(
          (item) =>
            item.type === "context_message" &&
            item.content.some((part) => part.type === "image"),
        ),
      );
      if (failHttp)
        return new Response(
          JSON.stringify({
            error: {
              message: "synthetic-private-key https://draft.invalid/v1",
              code: "invalid_request",
            },
          }),
          { status: 400 },
        );
      return new Response(
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    {
      close: async () => {
        closes++;
      },
    },
  ) as typeof fetch;
  const host = createHostedAppServer({
    cwd: "/tmp",
    dataDirectory: directory,
    provider: { type: "fake" },
    model: "fake",
    approvalPolicy: "never",
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
  });
  const input = {
    kind: "image-capability-probe" as const,
    selection: { providerProfileId: "unapplied-draft", modelId: "draft" },
  };
  try {
    const before = host.currentConfiguration();
    const ok = await host.runConfiguredModelOperation(input, draft);
    assert.equal(ok.status, "completed");
    assert.equal(closes, 1);
    assert.equal(calls, 1);
    assert.deepEqual(host.currentConfiguration(), before);
    assert.equal((await host.listThreadSummaries()).length, 0);
    assert.equal(host.activitySnapshot().rootOperations.length, 0);
    await assert.rejects(
      host.runConfiguredModelOperation(
        { ...input, selection: { ...input.selection, modelId: "missing" } },
        draft,
      ),
      /does not match/,
    );
    await assert.rejects(
      host.runConfiguredModelOperation(
        {
          ...input,
          selection: { ...input.selection, reasoningEffort: "high" },
        },
        draft,
      ),
      /cannot override/,
    );
    assert.equal(calls, 1);
    assert.equal(closes, 3);
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, "title source")
    ).done;
    const source = (await host.readThread(thread.id)).items.find(
      (item) => item.type === "user_message",
    )!;
    await assert.rejects(
      host.runConfiguredModelOperation(
        {
          kind: "title",
          threadId: thread.id,
          sourceItemId: source.id,
          selection: input.selection,
        },
        draft,
      ),
      /Context window is missing/,
    );
    assert.equal(calls, 1);
    assert.equal(closes, 4);
    for (const [
      supportedReasoningEfforts,
      defaultReasoningEffort,
      requested,
    ] of [
      [null, null, undefined],
      [["low"], "low", null],
      [["low"], "low", "high"],
    ] as const) {
      const titleProfile: HostProviderProfile = {
        ...draft,
        modelCatalog: [
          {
            id: "draft",
            isDefault: true,
            contextWindow: 32768,
            supportedReasoningEfforts,
            defaultReasoningEffort,
          },
        ],
      };
      await assert.rejects(
        host.runConfiguredModelOperation(
          {
            kind: "title",
            threadId: thread.id,
            sourceItemId: source.id,
            selection: {
              ...input.selection,
              ...(requested === undefined
                ? {}
                : { reasoningEffort: requested }),
            },
          },
          titleProfile,
        ),
        /Reasoning capability is unknown|requires an explicit supported|not available/,
      );
    }
    assert.equal(calls, 1);
    assert.equal(closes, 7);
    failHttp = true;
    const failed = await host.runConfiguredModelOperation(input, draft);
    assert.equal(failed.status, "failed");
    assert.equal(failed.probeOutcome, "inconclusive");
    assert.equal(closes, 8);
    journal.rejectContext = true;
    await assert.rejects(
      host.runConfiguredModelOperation(input, draft),
      /synthetic unknown append/,
    );
    assert.equal(calls, 2);
    assert.equal(closes, 9);
    const all = (
      await Promise.all(
        (await journal.listThreadIds()).map((id) => journal.read(id)),
      )
    ).flat();
    assert.doesNotMatch(
      JSON.stringify(all),
      /synthetic-private-key|https:\/\/draft.invalid/,
    );
    assert.equal(host.activitySnapshot().rootOperations.length, 0);
  } finally {
    await host.closeHostResources();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
