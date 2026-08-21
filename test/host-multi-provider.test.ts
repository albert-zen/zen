import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHostedAppServer,
  redactModelOutput,
} from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import type { ModelAdapter, ModelEvent } from "../src/model.js";
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

test("host runtime redacts every configured Provider API key from tool results", async () => {
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
    dataDirectory: path.join(os.tmpdir(), "zen-host-key-redaction"),
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
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /secret-a|secret-b/u);
    assert.match(serialized, /\[REDACTED\]/u);
  } finally {
    await host.closeProviderTransport();
    globalThis.fetch = originalFetch;
  }
});

test("host boundary redacts split text, reasoning, and complete tool-call events", async () => {
  const source: ModelAdapter = {
    provider: "captured",
    async *stream() {
      yield { type: "text_delta", delta: "prefix se" };
      yield { type: "reasoning", summary: "reasoning secret-b" };
      yield { type: "text_delta", delta: "cr" };
      yield { type: "text_delta", delta: "et-a suffix" };
      yield {
        type: "tool_call",
        callId: "secret-a-call",
        name: "secret-b-tool",
        arguments: { nested: ["secret-a", { value: "secret-b" }] },
      };
    },
  };

  const events: ModelEvent[] = [];
  for await (const event of redactModelOutput(source, [
    "secret-a",
    "secret-b",
  ]).stream({
    model: "shared-model",
    reasoningEffort: "medium",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }

  assert.doesNotMatch(JSON.stringify(events), /secret-a|secret-b/u);
  assert.equal(
    events
      .filter(
        (event): event is Extract<ModelEvent, { type: "text_delta" }> =>
          event.type === "text_delta",
      )
      .map((event) => event.delta)
      .join(""),
    "prefix [REDACTED] suffix",
  );
  assert.deepEqual(
    events.find((event) => event.type === "reasoning"),
    {
      type: "reasoning",
      summary: "reasoning [REDACTED]",
    },
  );
  assert.deepEqual(
    events.find((event) => event.type === "tool_call"),
    {
      type: "tool_call",
      callId: "[REDACTED]-call",
      name: "[REDACTED]-tool",
      arguments: {
        nested: ["[REDACTED]", { value: "[REDACTED]" }],
      },
    },
  );

  for (let split = 1; split < "secret-a".length; split += 1) {
    const splitSource: ModelAdapter = {
      provider: "captured",
      async *stream() {
        yield {
          type: "text_delta",
          delta: `left ${"secret-a".slice(0, split)}`,
        };
        yield { type: "text_delta", delta: `${"secret-a".slice(split)} right` };
      },
    };
    const text: string[] = [];
    for await (const event of redactModelOutput(splitSource, [
      "secret-a",
    ]).stream({
      model: "shared-model",
      reasoningEffort: "medium",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      if (event.type === "text_delta") text.push(event.delta);
    }
    assert.equal(text.join(""), "left [REDACTED] right");
  }
});

test("hosted App Server withholds split API keys from emitted deltas and journal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    modelResponseChunks(["prefix se", "cr", "et-a suffix"]);
  const journal = new InMemoryThreadJournal();
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "zen-host-split-key-redaction"),
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
    assert.equal(emittedDeltas.join(""), "prefix [REDACTED] suffix");
    assert.doesNotMatch(JSON.stringify(emittedDeltas), /secret-a/u);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-a/u);
    assert.match(JSON.stringify(snapshot), /\[REDACTED\]/u);
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
            models: ["shared-model", "shared-model"],
          },
        ],
        defaultSelection: {
          providerProfileId: "profile-a",
          modelId: "shared-model",
        },
      }),
    /must be non-empty and unique/u,
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
    models: ["shared-model"],
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
