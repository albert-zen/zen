import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";

test("hosted App Server routes duplicate model ids through independent profile credentials", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    authorization: string | null;
    model: unknown;
  }> = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { model?: unknown };
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      model: body.model,
    });
    return modelResponse(String(input).includes("profile-a") ? "a" : "b");
  };
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "zen-host-multi-provider"),
    approvalPolicy: "never",
    providers: [
      compatible("profile-a", "secret-a"),
      compatible("profile-b", "secret-b"),
    ],
    defaultSelection: {
      providerProfileId: "profile-a",
      modelId: "shared-model",
    },
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, "first")
    ).done;
    await host.updateThreadSettings(thread.id, {
      selection: {
        providerProfileId: "profile-b",
        modelId: "shared-model",
      },
    });
    await (
      await host.startTurn(thread.id, "second")
    ).done;
    assert.deepEqual(requests, [
      {
        url: "https://profile-a.example.test/v1/chat/completions",
        authorization: "Bearer secret-a",
        model: "shared-model",
      },
      {
        url: "https://profile-b.example.test/v1/chat/completions",
        authorization: "Bearer secret-b",
        model: "shared-model",
      },
    ]);
    const persisted = await host.readThread(thread.id);
    assert.deepEqual(
      persisted.turns.map((turn) => turn.selection?.providerProfileId),
      ["profile-a", "profile-b"],
    );
    assert.doesNotMatch(JSON.stringify(persisted), /secret-a|secret-b/u);
  } finally {
    await host.closeProviderTransport();
    globalThis.fetch = originalFetch;
  }
});

test("removed profiles leave history readable and require an explicit valid switch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    modelResponse(String(input).includes("profile-a") ? "a" : "b");
  const journal = new InMemoryThreadJournal();
  const threadMetadata = new InMemoryThreadMetadataStore();
  const common = {
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "zen-host-profile-removal"),
    approvalPolicy: "never" as const,
    journal,
    threadMetadata,
  };
  const before = createHostedAppServer({
    ...common,
    providers: [
      compatible("profile-a", "secret-a"),
      compatible("profile-b", "secret-b"),
    ],
    defaultSelection: {
      providerProfileId: "profile-a",
      modelId: "shared-model",
    },
  });
  let threadId: string;
  try {
    const thread = await before.startThread({
      selection: {
        providerProfileId: "profile-b",
        modelId: "shared-model",
      },
    });
    threadId = thread.id;
    await (
      await before.startTurn(threadId, "before deletion")
    ).done;
  } finally {
    await before.closeProviderTransport();
  }

  const after = createHostedAppServer({
    ...common,
    providers: [compatible("profile-a", "secret-a")],
    defaultSelection: {
      providerProfileId: "profile-a",
      modelId: "shared-model",
    },
  });
  try {
    const historical = await after.readThread(threadId!);
    assert.equal(historical.providerProfileId, "profile-b");
    await assert.rejects(
      async () => await (await after.startTurn(threadId!, "unavailable")).done,
      /Provider profile is not available.*profile-b/u,
    );
    await after.updateThreadSettings(threadId!, {
      selection: {
        providerProfileId: "profile-a",
        modelId: "shared-model",
      },
    });
    await (
      await after.startTurn(threadId!, "explicit switch")
    ).done;
    const switched = await after.readThread(threadId!);
    assert.deepEqual(
      switched.turns.map((turn) => turn.selection?.providerProfileId),
      ["profile-b", "profile-a"],
    );
  } finally {
    await after.closeProviderTransport();
    globalThis.fetch = originalFetch;
  }
});

test("host preserves Provider-key-matching tool calls and shell results", async () => {
  const originalFetch = globalThis.fetch;
  let request = 0;
  globalThis.fetch = async () => {
    request += 1;
    if (request === 1) {
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"shell","arguments":"{\\"command\\":\\"printf \'secret-a secret-b\'\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return modelResponse("done");
  };
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "zen-host-key-trace"),
    approvalPolicy: "never",
    providers: [
      compatible("profile-a", "secret-a"),
      compatible("profile-b", "secret-b"),
    ],
    defaultSelection: {
      providerProfileId: "profile-a",
      modelId: "shared-model",
    },
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, "run")
    ).done;
    const snapshot = await host.readThread(thread.id);
    const toolCall = snapshot.items.find((item) => item.type === "tool_call");
    const toolResult = snapshot.items.find(
      (item) => item.type === "tool_result",
    );
    assert.deepEqual(toolCall?.arguments, {
      command: "printf 'secret-a secret-b'",
    });
    assert.equal(toolResult?.output, "secret-a secret-b");
  } finally {
    await host.closeProviderTransport();
    globalThis.fetch = originalFetch;
  }
});

test("hosted App Server preserves Provider-key-matching text deltas and journal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    modelResponseChunks(["prefix se", "cr", "et-a suffix"]);
  const journal = new InMemoryThreadJournal();
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "zen-host-split-key-trace"),
    approvalPolicy: "never",
    providers: [compatible("profile-a", "secret-a")],
    defaultSelection: {
      providerProfileId: "profile-a",
      modelId: "shared-model",
    },
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
  });
  const emittedDeltas: string[] = [];
  const unsubscribe = host.subscribe((event) => {
    if (event.type === "item_delta") emittedDeltas.push(event.delta);
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, "split")
    ).done;
    const snapshot = await host.readThread(thread.id);
    assert.deepEqual(emittedDeltas, ["prefix se", "cr", "et-a suffix"]);
    assert.equal(
      snapshot.items.find((item) => item.type === "agent_message")?.text,
      "prefix secret-a suffix",
    );
  } finally {
    unsubscribe();
    await host.closeProviderTransport();
    globalThis.fetch = originalFetch;
  }
});

test("multi-provider host rejects duplicate profiles, catalogs, and dangling defaults", () => {
  const common = {
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "zen-host-invalid-profiles"),
    approvalPolicy: "never" as const,
  };
  assert.throws(
    () =>
      createHostedAppServer({
        ...common,
        providers: [
          compatible("duplicate", "one"),
          compatible("duplicate", "two"),
        ],
        defaultSelection: {
          providerProfileId: "duplicate",
          modelId: "shared-model",
        },
      }),
    /Duplicate provider profile id/u,
  );
  assert.throws(
    () =>
      createHostedAppServer({
        ...common,
        providers: [
          {
            ...compatible("profile-a", "secret-a"),
            modelCatalog: [
              { id: "shared-model", contextWindow: 32_768 },
              { id: "shared-model", contextWindow: 32_768 },
            ],
          },
        ],
        defaultSelection: {
          providerProfileId: "profile-a",
          modelId: "shared-model",
        },
      }),
    /Duplicate model catalog entry/u,
  );
  assert.throws(
    () =>
      createHostedAppServer({
        ...common,
        providers: [compatible("profile-a", "secret-a")],
        defaultSelection: {
          providerProfileId: "missing",
          modelId: "shared-model",
        },
      }),
    /absent from provider profile missing/u,
  );
  assert.throws(
    () =>
      createHostedAppServer({
        ...common,
        providers: [
          {
            ...compatible("profile-a", "secret-a"),
            modelCatalog: [
              {
                id: "shared-model",
                source: "manual",
                supportedReasoningEfforts: ["medium"],
                defaultReasoningEffort: "medium",
                inputModalities: null,
                contextWindow: 32_768,
              },
            ],
          },
        ],
        defaultSelection: {
          providerProfileId: "profile-a",
          modelId: "shared-model",
        },
      }),
    /input modalities.*manual capability override/iu,
  );
});

function compatible(providerProfileId: string, apiKey: string) {
  return {
    providerProfileId,
    provider: {
      type: "openai-compatible" as const,
      name: providerProfileId,
      baseUrl: `https://${providerProfileId}.example.test/v1`,
      apiKey,
    },
    model: "shared-model",
    modelCatalog: [
      {
        id: "shared-model",
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        inputModalities: ["text" as const],
        contextWindow: 32_768,
        source: "manual" as const,
      },
    ],
  };
}

function modelResponse(text: string): Response {
  return new Response(
    `data: {"choices":[{"delta":{"content":"${text}"},"finish_reason":null}]}\n\n` +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function modelResponseChunks(chunks: readonly string[]): Response {
  return new Response(
    chunks
      .map(
        (chunk) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`,
      )
      .join("") +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
