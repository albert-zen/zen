import assert from "node:assert/strict";
import test from "node:test";
import { prepareSampleContext } from "../src/context-preparation.js";
import {
  AGENTIC_CONTEXT_COMPACTION_TOOL,
  normalizeAgenticCompactionRetention,
  planAgenticCompactionRetention,
} from "../src/context-compaction.js";
import {
  compileItemList,
  contextItemsFromLegacy,
  decodeContextItem,
  type ContextItem,
} from "../src/item-list.js";
import type { CanonicalItem } from "../src/item.js";

const base = { threadId: "synthetic", createdAt: "2026-10-29T00:00:00Z" };
const user = {
  ...base,
  id: "user",
  turnId: "turn",
  type: "user_message" as const,
  text: "literal c1 is user text, not a model capability",
};
function prepare(itemList: ContextItem[], sampleId: string) {
  let next = itemList.length;
  return prepareSampleContext({
    threadId: base.threadId,
    turnId: "turn",
    sampleId,
    items: [user],
    itemList,
    sandbox: "danger-full-access",
    tools: [AGENTIC_CONTEXT_COMPACTION_TOOL],
    inputModalities: ["text"],
    id: () => `prepared-${next++}`,
    now: () => base.createdAt,
  });
}

test("actual compiled samples below threshold contain no retention inventory or reminder", () => {
  let items = contextItemsFromLegacy(user, [], 0);
  const golden = compileItemList(items).messages;
  for (let sample = 1; sample <= 4; sample++) {
    const additions = prepare(items, `sample-${sample}`);
    assert.equal(
      additions.some((item) => item.source.kind === "context_notice"),
      false,
    );
    assert.equal(
      additions.some(
        (item) => item.source.metadata?.referenceBindings !== undefined,
      ),
      false,
    );
    items = [...items, ...additions];
    const compiled = compileItemList(items, { sampleId: `sample-${sample}` });
    assert.deepEqual(compiled.messages, golden);
    assert.deepEqual(compiled.tools, [AGENTIC_CONTEXT_COMPACTION_TOOL]);
  }
  const schema = JSON.stringify(AGENTIC_CONTEXT_COMPACTION_TOOL);
  assert.doesNotMatch(
    schema,
    /cN|itemIds|itemRanges|fromItemId|toItemId|recentTurnCount|preserveUserMessages/u,
  );
  for (const key of [
    "recentItemCount",
    "recentUserMessageCount",
    "recentFinalMessageCount",
    "recentAgentMessageCount",
    "tokenBudget",
  ])
    assert(schema.includes(key));
});

test("old sample-only index and tool schema remain exact historical bytes, never leak to a newly prepared sample", () => {
  const prior: ContextItem[] = [
    ...contextItemsFromLegacy(user, [], 0),
    {
      ...base,
      id: "old-tools",
      kind: "tools",
      role: "developer",
      source: { kind: "tool_definitions", sequence: 1 },
      content: {
        tools: [
          {
            name: "compact_context",
            description: "old exact retention",
            inputSchema: {
              type: "object",
              properties: { itemIds: { type: "array" } },
            },
          },
        ],
      },
    },
    {
      ...base,
      id: "old-index",
      kind: "message",
      role: "developer",
      source: {
        kind: "context_notice",
        sequence: 1,
        metadata: {
          onlySampleId: "old-sample",
          referenceBindings: [
            {
              ref: "c1",
              ownerThreadId: base.threadId,
              namespace: "builtin-compaction",
              kind: "item",
              value: { itemId: user.id },
            },
          ],
        },
      },
      content: {
        text: "[compact_context retention: c1 user message]",
        parts: [
          {
            type: "text",
            text: "[compact_context retention: c1 user message]",
          },
        ],
      },
    },
  ];
  const bytes = JSON.stringify(prior);
  const decoded = JSON.parse(bytes).map(decodeContextItem);
  assert.equal(JSON.stringify(decoded), bytes);
  const old = compileItemList(prior, { sampleId: "old-sample" });
  assert(
    JSON.stringify(old.messages).includes(
      "[compact_context retention: c1 user message]",
    ),
  );
  const additions = prepare(prior, "new-sample");
  assert.equal(additions.length, 1);
  assert.equal(additions[0]?.kind, "tools");
  assert.equal(JSON.stringify(prior), bytes);
  assert.deepEqual(compileItemList(decoded, { sampleId: "old-sample" }), old);
  const next = compileItemList([...prior, ...additions], {
    sampleId: "new-sample",
  });
  assert.deepEqual(
    next.messages,
    compileItemList(contextItemsFromLegacy(user, [], 0)).messages,
  );
  assert.deepEqual(next.tools, [AGENTIC_CONTEXT_COMPACTION_TOOL]);
});

test("coarse type counts union deterministically; budget uses newest suffix and disallows mixing modes", () => {
  const facts: CanonicalItem[] = [];
  for (let turn = 1; turn <= 3; turn++) {
    const turnId = `turn-${turn}`;
    facts.push(
      { ...user, id: `user-${turn}`, turnId, text: `input ${turn}` },
      {
        ...base,
        id: `agent-${turn}`,
        turnId,
        type: "agent_message",
        text: `answer ${turn}`,
      },
      {
        ...base,
        id: `done-${turn}`,
        turnId,
        type: "turn_completed",
        status: turn === 2 ? "failed" : "completed",
      },
    );
  }
  const boundary = {
    item: facts.at(-1)!,
    index: facts.length - 1,
    retainedItemIds: [],
  };
  const plan = (retention: unknown, retainedTokenBudget = 100) =>
    planAgenticCompactionRetention(facts, boundary, {
      retention: normalizeAgenticCompactionRetention(retention),
      retainedTokenBudget,
      estimateRetainedTokens: (items) => items.length,
    });
  assert.deepEqual(
    plan({
      recentUserMessageCount: 1,
      recentFinalMessageCount: 2,
      recentAgentMessageCount: 1,
    }).retainedItemIds,
    ["agent-1", "user-3", "agent-3"],
  );
  assert.deepEqual(plan({ tokenBudget: 2 }).retainedItemIds, [
    "user-3",
    "agent-3",
  ]);
  assert.deepEqual(plan({ tokenBudget: 100 }, 1).retainedItemIds, ["agent-3"]);
  assert.deepEqual(plan({ tokenBudget: 0 }).retainedItemIds, []);
  assert.deepEqual(plan(undefined).retainedItemIds, []);
  assert.throws(() => plan({ recentItemCount: 3 }, 1), /exceed/u);
  assert.throws(
    () => plan({ tokenBudget: 2, recentUserMessageCount: 1 }),
    /not both/u,
  );
  for (const value of [
    { itemIds: ["c1"] },
    { recentItemCount: -1 },
    { tokenBudget: 1.5 },
  ])
    assert.throws(() => plan(value));
});

test("coarse counts and token allowances preserve complete sibling tool call/result groups", () => {
  const turnId = "turn";
  const facts: CanonicalItem[] = [
    user,
    {
      ...base,
      turnId,
      id: "response",
      type: "agent_message",
      text: "using tools",
    },
    {
      ...base,
      turnId,
      id: "call-a",
      type: "tool_call",
      callId: "a",
      modelResponseId: "response",
      name: "shell",
      arguments: { command: "printf a" },
    },
    {
      ...base,
      turnId,
      id: "call-b",
      type: "tool_call",
      callId: "b",
      modelResponseId: "response",
      name: "shell",
      arguments: { command: "printf b" },
    },
    {
      ...base,
      turnId,
      id: "result-a",
      type: "tool_result",
      callId: "a",
      output: "a",
      exitCode: 0,
    },
    {
      ...base,
      turnId,
      id: "result-b",
      type: "tool_result",
      callId: "b",
      output: "b",
      exitCode: 0,
    },
  ];
  const boundary = {
    item: facts.at(-1)!,
    index: facts.length - 1,
    retainedItemIds: [],
  };
  const plan = (retention: unknown, limit = 10) =>
    planAgenticCompactionRetention(facts, boundary, {
      retention: normalizeAgenticCompactionRetention(retention),
      retainedTokenBudget: limit,
      estimateRetainedTokens: (items) => items.length,
    });
  const group = ["response", "call-a", "call-b", "result-a", "result-b"];
  assert.deepEqual(plan({ recentItemCount: 1 }).retainedItemIds, group);
  assert.deepEqual(plan({ recentAgentMessageCount: 1 }).retainedItemIds, group);
  assert.deepEqual(plan({ tokenBudget: 5 }).retainedItemIds, group);
  assert.deepEqual(plan({ tokenBudget: 4 }).retainedItemIds, []);
  assert.throws(
    () => plan({ recentItemCount: 1 }, 4),
    /complete tool groups exceed/u,
  );
});
