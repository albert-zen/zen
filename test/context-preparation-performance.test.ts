import assert from "node:assert/strict";
import test from "node:test";
import { contextForFacts } from "../src/context-preparation.js";
import { contextItemsFromLegacy, type ContextItem } from "../src/item-list.js";
import type { CanonicalItem } from "../src/item.js";
import { referenceMessage } from "../apps/zenx/src/renderer/src/reference-draft.js";

function facts(turns: number): CanonicalItem[] {
  const common = { threadId: "t", createdAt: "2026-11-02T00:00:00.000Z" };
  const items: CanonicalItem[] = [
    {
      ...common,
      id: "metadata",
      type: "thread_metadata",
      cwd: "/synthetic",
      provider: "fake",
      model: "fake",
      sandbox: "read-only",
      approvalPolicy: "always",
    },
  ];
  for (let index = 0; index < turns; index++) {
    const turnId = `turn-${index}`;
    items.push(
      { ...common, id: `start-${index}`, turnId, type: "turn_started" },
      {
        ...common,
        id: `user-${index}`,
        turnId,
        type: "user_message",
        clientId: `client-${index}`,
        text: `Synthetic input ${index}`,
      },
      {
        ...common,
        id: `agent-${index}`,
        turnId,
        type: "agent_message",
        text: `Synthetic output ${index}`,
      },
      {
        ...common,
        id: `end-${index}`,
        turnId,
        type: "turn_completed",
        status: "completed",
      },
    );
  }
  return items;
}

function semanticFacts(items: readonly CanonicalItem[]): ContextItem[] {
  const contexts: ContextItem[] = [];
  const previous: CanonicalItem[] = [];
  for (const [index, item] of items.entries()) {
    contexts.push(...contextItemsFromLegacy(item, previous, index, contexts));
    previous.push(item);
  }
  return contexts;
}

// Exact old algorithm is an output oracle, not used by production.
function baselineContextForFacts(
  items: readonly CanonicalItem[],
  existing: readonly ContextItem[],
): ContextItem[] {
  const ids = new Set(items.map((item) => item.id));
  const boundary = Math.max(
    -1,
    ...existing
      .filter((item) => ids.has(item.id))
      .map((item) => item.source.sequence),
  );
  const contexts = existing.filter(
    (item) =>
      ids.has(item.id) ||
      (![
        "user_message",
        "host_message",
        "thread_message",
        "thread_instruction",
        "agent_message",
        "tool_call",
        "tool_result",
        "reasoning",
        "context_compaction",
        "failure",
      ].includes(item.source.kind) &&
        item.source.sequence <= boundary),
  );
  const present = new Set(contexts.map((item) => item.id));
  for (const [index, item] of items.entries())
    if (!present.has(item.id)) {
      const added = contextItemsFromLegacy(
        item,
        items.slice(0, index),
        Math.max(index, boundary + 1),
        contexts,
      );
      contexts.push(...added);
      for (const item of added) present.add(item.id);
    }
  return contexts;
}

for (const turns of [32, 128, 512]) {
  test(`contextForFacts avoids history-prefix slices for ${turns} completed turns`, (t) => {
    const items = facts(turns);
    const existing = semanticFacts(items);
    const expected = baselineContextForFacts(items, existing);
    let calls = 0;
    let copied = 0;
    Object.defineProperty(items, "slice", {
      value(start?: number, end?: number) {
        const result = Array.prototype.slice.call(
          items,
          start,
          end,
        ) as CanonicalItem[];
        calls++;
        copied += result.length;
        return result;
      },
    });
    Object.freeze(items);
    Object.freeze(existing);
    const actual = contextForFacts(items, existing);
    assert.deepEqual(actual, expected);
    assert.equal(calls, 0);
    assert.equal(copied, 0);
    t.diagnostic(
      JSON.stringify({
        turns,
        calls,
        copied,
        oldCopied: 4 * turns * turns + turns,
      }),
    );
  });
}

test("frozen imported context wins while prospective references and receipt lineage remain exact", () => {
  const items = facts(2);
  const existing = semanticFacts(items);
  const frozen = existing.find((item) => item.id === "user-0")!;
  assert.equal(frozen.kind, "message");
  if (frozen.kind !== "message") throw new Error("message expected");
  frozen.content = {
    text: "[Message received at imported exact instant]\nFrozen imported bytes",
    parts: [
      { type: "text", text: "[Message received at imported exact instant]" },
      { type: "text", text: "Frozen imported bytes" },
    ],
  };
  frozen.source.metadata = { ...frozen.source.metadata, imported: true };
  const clientId = "prospective-client";
  items.push(
    {
      id: "queued",
      threadId: "t",
      type: "user_message_queued",
      createdAt: "2026-03-08T06:59:00Z",
      clientId,
      input: [{ type: "text", text: "original input" }],
      receiptTimezone: { timeZone: "America/New_York", source: "client" },
    },
    {
      id: "prospective",
      threadId: "t",
      turnId: "next",
      type: "user_message",
      createdAt: "2026-03-08T07:01:00Z",
      clientId,
      receiptTimezone: { timeZone: "Asia/Tokyo", source: "host" },
      text: referenceMessage(
        "See \uFFFC",
        [
          {
            kind: "message",
            name: "Imported selection",
            cwd: "/synthetic",
            threadId: "t",
            id: "user-0",
            excerpt: "Frozen imported bytes",
            position: 4,
          },
        ],
        clientId,
      ),
    },
  );
  const before = JSON.stringify({ items, existing });
  const expected = baselineContextForFacts(items, existing);
  const actual = contextForFacts(Object.freeze(items), Object.freeze(existing));
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify({ items, existing }), before);
  assert.equal(
    actual.find((item) => item.id === frozen.id),
    frozen,
  );
  const prospective = actual.find((item) => item.id === "prospective")!;
  assert.equal(prospective.kind, "message");
  if (prospective.kind !== "message") throw new Error("message expected");
  assert.match(prospective.content.text, /America\/New_York/);
  assert.match(
    prospective.content.text,
    /source received at imported exact instant/,
  );
  assert.doesNotMatch(prospective.content.text, /Asia\/Tokyo/);
});

test("missing nested-tool suffix keeps full preceding facts and existing context unchanged", () => {
  const items = facts(1);
  const existing = semanticFacts(items);
  const common = {
    threadId: "t",
    turnId: "tool-turn",
    createdAt: "2026-11-02T00:00:00Z",
  };
  items.push(
    { ...common, id: "tool-start", type: "turn_started" },
    {
      ...common,
      id: "parent-call",
      type: "tool_call",
      callId: "parent",
      name: "run_code",
      arguments: {},
    },
    {
      ...common,
      id: "child-call",
      type: "tool_call",
      callId: "child",
      parentCallId: "parent",
      name: "read",
      arguments: {},
    },
    {
      ...common,
      id: "child-result",
      type: "tool_result",
      callId: "child",
      output: "synthetic child",
      exitCode: 0,
    },
    {
      ...common,
      id: "parent-result",
      type: "tool_result",
      callId: "parent",
      output: "synthetic parent",
      exitCode: 0,
    },
    { ...common, id: "tool-end", type: "turn_completed", status: "completed" },
  );
  assert.deepEqual(
    contextForFacts(items, existing),
    baselineContextForFacts(items, existing),
  );
  assert.deepEqual(
    contextForFacts(items, []),
    baselineContextForFacts(items, []),
  );
});

test("selection boundary and supplemental context filtering stay byte-identical", () => {
  const items = facts(2);
  const existing = semanticFacts(items);
  existing.push({
    id: "workspace",
    threadId: "t",
    createdAt: "2026-11-02T00:00:00Z",
    kind: "message",
    role: "developer",
    content: {
      text: "frozen workspace",
      parts: [{ type: "text", text: "frozen workspace" }],
    },
    source: { kind: "workspace_instructions", sequence: 0 },
  });
  items.push({
    id: "selection",
    threadId: "t",
    createdAt: "2026-11-02T00:00:01Z",
    type: "context_compaction",
    coveredThroughItemId: "end-1",
    retainedItemIds: ["user-0", "agent-1"],
    summary: "Synthetic summary",
    includeOriginalReference: true,
    algorithmVersion: "fixture",
    providerProfileId: "synthetic",
    modelId: "synthetic",
    reasoningEffort: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
  });
  const before = JSON.stringify({ items, existing });
  assert.deepEqual(
    contextForFacts(items, existing),
    baselineContextForFacts(items, existing),
  );
  assert.equal(JSON.stringify({ items, existing }), before);
});
