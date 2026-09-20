import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../src/item.js";
import {
  projectContextInspection,
  isContextInspection,
} from "../src/context-inspection.js";

const base = { threadId: "thread", createdAt: "2026-09-20T00:00:00Z" };
const items: CanonicalItem[] = [
  {
    ...base,
    id: "old",
    type: "user_message",
    turnId: "turn",
    text: "old original",
  },
  {
    ...base,
    id: "keep",
    type: "user_message",
    turnId: "turn",
    text: "retained original",
  },
  {
    ...base,
    id: "compact",
    type: "context_compaction",
    coveredThroughItemId: "keep",
    summary: "continuation",
    retainedItemIds: ["keep"],
    algorithmVersion: "test",
    providerProfileId: "p",
    modelId: "m",
    reasoningEffort: null,
    tokenUsage: { inputTokens: 900000, outputTokens: 30 },
    workspaceInstructions: [{ path: "/repo/AGENTS.md", text: "rule snapshot" }],
  },
  {
    ...base,
    id: "new",
    type: "user_message",
    turnId: "next",
    text: "new original",
  },
];

test("inspection follows compiled context and excludes compacted originals and billing usage", () => {
  const result = projectContextInspection(items);
  const previews = JSON.stringify(result.messages);
  assert.ok(!previews.includes("old original"));
  assert.ok(previews.includes("retained original"));
  assert.ok(previews.includes("new original"));
  assert.equal(result.compaction?.summary.text, "continuation");
  assert.deepEqual(result.compaction?.retainedItemIds, ["keep"]);
  assert.equal(result.rules[0]?.source, "/repo/AGENTS.md");
  assert.ok(result.estimatedMessageTokens < 900000);
  assert.equal(result.throughItemId, "new");
});

test("inspection marks bounded previews", () => {
  const result = projectContextInspection([
    {
      ...base,
      id: "long",
      type: "user_message",
      turnId: "t",
      text: "x".repeat(10000),
    },
  ]);
  assert.equal(result.messages[0]?.preview.truncated, true);
  assert.ok(result.messages[0]!.preview.text.length < 10000);
});

test("opaque reasoning and attachment identity are omitted from previews", () => {
  const selection = {
    providerProfileId: "p",
    modelId: "m",
    reasoningEffort: null,
  };
  const result = projectContextInspection(
    [
      { ...base, id: "start", type: "turn_started", turnId: "t", selection },
      {
        ...base,
        id: "reasoning",
        type: "reasoning",
        turnId: "t",
        contentVisibility: "opaque",
        reasoningContent: "private-provider-payload",
      },
      {
        ...base,
        id: "image",
        type: "user_message",
        turnId: "t",
        content: [
          {
            type: "image",
            attachment: {
              type: "attachment",
              sha256: "a".repeat(64),
              mediaType: "image/png",
              byteLength: 1,
              width: 1,
              height: 1,
            },
          },
        ],
      },
    ],
    selection,
  );
  assert.equal(result.messages.length, 2);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-provider-payload|aaaaaaaa/u,
  );
  assert.match(JSON.stringify(result), /Opaque provider reasoning/u);
  assert.match(JSON.stringify(result), /image attachment/u);
  assert.ok(isContextInspection(result));
  assert.equal(
    isContextInspection({
      ...result,
      messages: [{ role: "user", preview: null }],
    }),
    false,
  );
});

test("a new empty rule snapshot clears earlier rules and long histories stay bounded", () => {
  const result = projectContextInspection([
    ...items,
    {
      ...base,
      id: "clear",
      type: "turn_started",
      turnId: "t",
      workspaceInstructions: [],
    },
    ...Array.from({ length: 100 }, (_, i): CanonicalItem => ({
      ...base,
      id: `user-${i}`,
      type: "user_message",
      turnId: "t",
      text: `message ${i}`,
    })),
  ]);
  assert.deepEqual(result.rules, []);
  assert.equal(result.messages.length, 80);
  assert.ok(result.messageCount > 100);
  assert.equal(result.messages.at(-1)?.preview.text, "message 99");
});
