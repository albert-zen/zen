import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { ZenAppServer } from "../src/app-server.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
} from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import { ViewImageToolRuntime } from "../src/view-image.js";
import { png1x1 } from "./fixtures.js";

function createServer(
  model: ModelAdapter,
  options: {
    journal?: InMemoryThreadJournal;
    attachments?: InMemoryAttachmentStore;
  } = {},
) {
  let sequence = 0;
  const journal = options.journal ?? new InMemoryThreadJournal();
  const attachments = options.attachments ?? new InMemoryAttachmentStore();
  return new ZenAppServer({
    journal,
    attachments,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "model",
            isDefault: true,
            contextWindow: 32_768,
            inputModalities: ["text", "image"],
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    idFactory: () => `id-${String(++sequence)}`,
    now: () => new Date(1_000 + sequence).toISOString(),
  });
}

test("forked history keeps image payloads replayable and authorized", async () => {
  const requests: ModelMessage[][] = [];
  const model: ModelAdapter = {
    provider: "images",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: "seen" };
    },
  };
  const journal = new InMemoryThreadJournal();
  const attachments = new InMemoryAttachmentStore();
  const server = createServer(model, { journal, attachments });
  const source = await server.startThread();
  const image = await server.importImageBytes(png1x1());
  await (
    await server.startTurn(source.id, [
      { type: "text", text: "remember this image" },
      { type: "image", attachment: image },
    ])
  ).done;

  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  const viewer = new ViewImageToolRuntime({ attachments, journal });
  const viewed = await viewer.execute({
    callId: "copied-image",
    name: "view_image",
    arguments: { attachment: image },
    cwd: fork.cwd,
    threadId: fork.id,
    signal: new AbortController().signal,
  });
  assert.deepEqual(viewed.modelContent, [{ type: "image", attachment: image }]);

  await (
    await server.startTurn(fork.id, "what did I attach?")
  ).done;
  assert.deepEqual(requests[1]?.[0], {
    role: "user",
    content: [
      { type: "text", text: "remember this image" },
      { type: "image", attachment: image },
    ],
  });
});

test("fork copies a replayable prefix and both Threads continue independently", async () => {
  const requests: ModelMessage[][] = [];
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      yield { type: "usage", inputTokens: 7, outputTokens: 3 };
      yield { type: "text_delta", delta: `answer-${String(requests.length)}` };
    },
  };
  const server = createServer(model);
  const source = await server.startThread({ cwd: os.tmpdir() });
  await server.setThreadName(source.id, "Investigate parser");
  await (
    await server.startTurn(source.id, "first question")
  ).done;

  const before = await server.readThread(source.id);
  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });

  assert.notEqual(fork.id, source.id);
  assert.equal(fork.cwd, source.cwd);
  assert.equal(fork.name, "Investigate parser · Copy");
  assert.equal(fork.turns.length, 1);
  assert.equal(requests.length, 1, "copying must not invoke the model");
  assert.deepEqual(await server.readThread(source.id), before);
  const provenance = fork.items.at(-1);
  assert.equal(provenance?.type, "thread_forked");
  assert.deepEqual(
    provenance?.type === "thread_forked"
      ? {
          sourceThreadId: provenance.sourceThreadId,
          sourceTurnId: provenance.sourceTurnId,
        }
      : null,
    { sourceThreadId: source.id, sourceTurnId: before.turns[0]?.id },
  );
  const sourceIds = new Set(before.items.map((item) => item.id));
  assert.equal(
    fork.items.slice(0, -1).some((item) => sourceIds.has(item.id)),
    false,
    "copied canonical Items must receive independent identities",
  );
  const copiedUsage = fork.items.find((item) => item.type === "model_usage");
  assert.ok(copiedUsage);
  assert.ok(
    fork.items.some(
      (item) =>
        item.type === "agent_message" &&
        item.id === copiedUsage.modelResponseId,
    ),
    "internal response references must target copied Items",
  );
  const forkSummary = (await server.listThreadSummaries()).find(
    (summary) => summary.threadId === fork.id,
  );
  assert.equal(
    forkSummary?.status === "systemError"
      ? undefined
      : forkSummary?.forkedFromThreadId,
    source.id,
  );
  assert.equal(forkSummary?.createdAt, provenance?.createdAt);

  await (
    await server.startTurn(fork.id, "fork path")
  ).done;
  assert.deepEqual(requests[1], [
    { role: "user", content: [{ type: "text", text: "first question" }] },
    { role: "assistant", text: "answer-1" },
    { role: "user", content: [{ type: "text", text: "fork path" }] },
  ]);
  assert.equal((await server.readThread(source.id)).turns.length, 1);
  assert.equal((await server.readThread(fork.id)).turns.length, 2);
});

test("fork chooses the last closed Turn while the source has active and queued work", async () => {
  let releaseActive!: () => void;
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let calls = 0;
  const model: ModelAdapter = {
    provider: "blocking",
    async *stream(): AsyncIterable<ModelEvent> {
      calls += 1;
      if (calls === 2) await activeGate;
      yield { type: "text_delta", delta: `answer-${String(calls)}` };
    },
  };
  const server = createServer(model);
  const source = await server.startThread();
  await (
    await server.startTurn(source.id, "complete")
  ).done;
  const active = await server.startTurn(source.id, "still running");
  await server.queueMessage(source.id, "later", "queued-client");

  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  assert.equal(fork.turns.length, 1);
  assert.equal(
    fork.items.some(
      (item) =>
        item.type === "user_message_queued" ||
        (item.turnId === active.id && item.type !== "thread_forked"),
    ),
    false,
  );

  releaseActive();
  await active.done;
});

test("fork preserves effective compaction context with remapped references", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    provider: "compacting",
    async *stream(): AsyncIterable<ModelEvent> {
      calls += 1;
      yield { type: "usage", inputTokens: 5, outputTokens: 2 };
      yield {
        type: "text_delta",
        delta: calls === 1 ? "first answer" : "summary of the first exchange",
      };
    },
  };
  const server = createServer(model);
  const source = await server.startThread();
  await (
    await server.startTurn(source.id, "first question")
  ).done;
  await server.compactThread(source.id);
  const compactedSource = await server.readThread(source.id);

  const fork = await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "latest-complete" },
    workspace: { type: "same-directory" },
  });
  assert.equal(calls, 2, "copying compacted history must not resummarize");
  const selection = {
    providerProfileId: source.providerProfileId,
    modelId: source.modelId,
    reasoningEffort: source.reasoningEffort,
  };
  assert.deepEqual(
    compileModelMessages(fork.items, selection),
    compileModelMessages(compactedSource.items, selection),
  );
  const sourceCompaction = compactedSource.items.find(
    (item) => item.type === "context_compaction",
  );
  const forkCompaction = fork.items.find(
    (item) => item.type === "context_compaction",
  );
  assert.ok(sourceCompaction);
  assert.ok(forkCompaction);
  assert.notEqual(
    forkCompaction.coveredThroughItemId,
    sourceCompaction.coveredThroughItemId,
  );
  assert.ok(
    fork.items.some((item) => item.id === forkCompaction.coveredThroughItemId),
  );
  assert.equal(
    forkCompaction.retainedItemIds.every((id) =>
      fork.items.some((item) => item.id === id),
    ),
    true,
  );
});

test("fork rejects Threads without a closed Turn", async () => {
  const model: ModelAdapter = {
    provider: "unused",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", delta: "unused" };
    },
  };
  const server = createServer(model);
  const source = await server.startThread();

  await assert.rejects(
    server.forkThread({
      sourceThreadId: source.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "fork_boundary_unavailable",
  );
});
