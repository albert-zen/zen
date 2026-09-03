import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CanonicalItem, ModelUsageItem } from "../src/item.js";
import { JsonlThreadJournal } from "../src/journal.js";
import { projectModelUsage } from "../src/model-usage.js";
import { Thread } from "../src/thread.js";

test("projects token-weighted Turn and Thread cache usage with response replacement", () => {
  const projection = projectModelUsage([
    metadata(),
    usage("usage-a-provisional", "turn-a", "response-a", 100, 20, 10, 4),
    usage("usage-b", "turn-a", "response-b", 50, undefined, 5),
    usage("usage-a-final", "turn-a", "response-a", 100, 40, 12, 6),
    usage("usage-c", "turn-b", "response-c", 50, 10, 8),
  ]);

  assert.deepEqual(projection.turns["turn-a"], {
    responseCount: 2,
    inputTokens: 150,
    cachedInputTokens: 40,
    outputTokens: 17,
    reasoningOutputTokens: 6,
    cacheHitRate: 0.4,
  });
  assert.deepEqual(projection.turns["turn-b"], {
    responseCount: 1,
    inputTokens: 50,
    cachedInputTokens: 10,
    outputTokens: 8,
    cacheHitRate: 0.2,
  });
  assert.deepEqual(projection.thread, {
    responseCount: 3,
    inputTokens: 200,
    cachedInputTokens: 50,
    outputTokens: 25,
    reasoningOutputTokens: 6,
    cacheHitRate: 1 / 3,
  });
});

test("keeps cache usage unknown when no response reports cache data", () => {
  const projection = projectModelUsage([
    metadata(),
    usage("usage-a", "turn-a", "response-a", 12, undefined, 3),
  ]);

  assert.deepEqual(projection.thread, {
    responseCount: 1,
    inputTokens: 12,
    outputTokens: 3,
  });
  assert.equal(projection.thread.cachedInputTokens, undefined);
  assert.equal(projection.thread.cacheHitRate, undefined);
});

test("projects context pressure from provider usage and configured window", () => {
  const projection = projectModelUsage(
    [
      metadata(),
      usage("usage-a", "turn-a", "response-a", 90, undefined, 3),
      usage("usage-b", "turn-a", "response-b", 120, undefined, 4),
    ],
    { contextWindow: 200 },
  );

  assert.deepEqual(projection.context, {
    inputTokens: 120,
    inputTokenSource: "provider",
    contextWindow: 200,
    ratio: 0.6,
  });
});

test("uses estimated context pressure after compaction invalidates latest usage", () => {
  const projection = projectModelUsage(
    [
      metadata(),
      usage("usage-a", "turn-a", "response-a", 180, undefined, 3),
      {
        id: "compaction",
        threadId: "thread",
        createdAt: "2026-08-27T00:00:02.000Z",
        type: "context_compaction",
        coveredThroughItemId: "completed",
        summary: "summary",
        retainedItemIds: [],
        providerProfileId: "provider",
        modelId: "model",
        reasoningEffort: "medium",
        algorithmVersion: "zen.context-compaction.v1",
        tokenUsage: { inputTokens: 180, outputTokens: 5 },
      },
    ],
    { contextWindow: 200, estimatedInputTokens: 40 },
  );

  assert.deepEqual(projection.context, {
    inputTokens: 40,
    inputTokenSource: "estimated",
    contextWindow: 200,
    ratio: 0.2,
  });
});

test("replays canonical model usage from the JSONL journal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-usage-"));
  try {
    const journal = new JsonlThreadJournal(directory);
    await journal.append(metadata());
    await journal.append(
      usage("usage-a", "turn-a", "response-a", 20, 15, 7, 2),
    );

    const replayed = new Thread("thread", await journal.read("thread"));
    assert.deepEqual(projectModelUsage(replayed.items).thread, {
      responseCount: 1,
      inputTokens: 20,
      cachedInputTokens: 15,
      outputTokens: 7,
      reasoningOutputTokens: 2,
      cacheHitRate: 0.75,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function metadata(): CanonicalItem {
  return {
    id: "metadata",
    threadId: "thread",
    createdAt: "2026-08-27T00:00:00.000Z",
    type: "thread_metadata",
    providerProfileId: "provider",
    modelId: "model",
    reasoningEffort: "medium",
    cwd: "/workspace",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  };
}

function usage(
  id: string,
  turnId: string,
  modelResponseId: string,
  inputTokens: number,
  cachedInputTokens: number | undefined,
  outputTokens: number,
  reasoningOutputTokens?: number,
): ModelUsageItem {
  return {
    id,
    threadId: "thread",
    turnId,
    createdAt: "2026-08-27T00:00:01.000Z",
    type: "model_usage",
    modelResponseId,
    inputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    outputTokens,
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
}
