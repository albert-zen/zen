import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileItemList,
  contextItemsFromLegacy,
  decodeContextItem,
  legacyItemFromContext,
  contextAnnotationFromLegacy,
  type ContextItem,
} from "../src/item-list.js";
import type { CanonicalItem } from "../src/item.js";
const base = {
  id: "input",
  threadId: "thread",
  turnId: "turn",
  createdAt: "2026-10-27T01:00:00Z",
};

test("semantic writer rejects runtime events and hidden body fields", () => {
  for (const type of [
    "turn_started",
    "model_usage",
    "code_state",
    "user_message_queued",
  ])
    assert.throws(() => decodeContextItem({ ...base, type }));
  const item = contextItemsFromLegacy({
    ...base,
    type: "user_message",
    text: "exact user password=literal",
  })[0]!;
  assert.throws(() => decodeContextItem({ ...item, event: "runtime" }));
  assert.throws(() =>
    decodeContextItem({
      ...item,
      source: { ...item.source, metadata: { runtimeHistory: [] } },
    }),
  );
  assert.throws(() => decodeContextItem({ ...item, role: "developer" }));
  assert.throws(() =>
    decodeContextItem({
      ...item,
      content: { ...item.content, text: "hidden rewrite" },
    }),
  );
});

test("user text and receipt metadata are real stored parts; compiler performs no semantic injection", () => {
  const original: CanonicalItem = {
    ...base,
    type: "user_message",
    clientId: "client",
    text: "literal UUID 1234, password=secret",
  };
  const items = contextItemsFromLegacy(original);
  const item = items[0]!;
  assert.equal(item.kind, "message");
  if (item.kind !== "message") throw new Error("message expected");
  assert.equal(
    item.content.text,
    "[Message received at 2026-10-27T01:00:00Z]\nliteral UUID 1234, password=secret",
  );
  const before = JSON.stringify(items);
  assert.deepEqual(compileItemList(items).messages, [
    { role: "user", content: item.content.parts },
  ]);
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual(legacyItemFromContext(item), original);
});

test("empty observed assistant/tool text is legal and raw rendering annotations stay outside ItemList", () => {
  const assistant = contextItemsFromLegacy({
    ...base,
    type: "agent_message",
    text: "",
  })[0]!;
  assert.deepEqual(compileItemList([assistant]).messages, [
    { role: "assistant", text: "" },
  ]);
  const raw: CanonicalItem = {
    ...base,
    type: "tool_result",
    callId: "call",
    output: "",
    exitCode: 0,
    contentType: "test/plain",
    structuredContent: { privateRuntimeOnly: "raw" },
  };
  const result = contextItemsFromLegacy(raw)[0]!;
  assert.equal(JSON.stringify(result).includes("privateRuntimeOnly"), false);
  assert.deepEqual(compileItemList([result]).messages, [
    { role: "tool", callId: "call", text: "Exit code: 0\n", exitCode: 0 },
  ]);
  assert.deepEqual(
    legacyItemFromContext(result, contextAnnotationFromLegacy(raw)),
    raw,
  );
});

test("partial samples and nested tool lifecycle are not semantic history", () => {
  assert.deepEqual(
    contextItemsFromLegacy({
      ...base,
      type: "agent_message",
      text: "partial",
      incomplete: true,
    }),
    [],
  );
  const call: CanonicalItem = {
    ...base,
    type: "tool_call",
    callId: "child",
    parentCallId: "parent",
    name: "write",
    arguments: {},
  };
  assert.deepEqual(contextItemsFromLegacy(call), []);
  assert.deepEqual(
    contextItemsFromLegacy(
      {
        ...base,
        id: "result",
        type: "tool_result",
        callId: "child",
        output: "raw",
        exitCode: 0,
      },
      [call],
    ),
    [],
  );
});

test("selection is immutable, validates retained IDs and omits covered old content", () => {
  const old = contextItemsFromLegacy(
    { ...base, type: "user_message", text: "old" },
    [],
    0,
  )[0]!;
  const selection: ContextItem = {
    ...base,
    id: "selection",
    source: { kind: "context_compaction", sequence: 2 },
    kind: "selection",
    role: "user",
    content: {
      text: "summary",
      coveredThroughItemId: old.id,
      coveredSequence: 0,
      retainedItemIds: [],
    },
  };
  const all = [old, selection];
  const before = JSON.stringify(all);
  assert.deepEqual(compileItemList(all).messages, [
    { role: "user", text: "summary" },
  ]);
  assert.equal(JSON.stringify(all), before);
  assert.throws(
    () =>
      compileItemList([
        old,
        {
          ...selection,
          content: { ...selection.content, retainedItemIds: ["missing"] },
        },
      ]),
    /Retained context Item/,
  );
  assert.throws(
    () =>
      compileItemList([
        old,
        { ...selection, content: { ...selection.content, coveredSequence: 3 } },
      ]),
    /boundary/,
  );
});

test("opaque reasoning only replays on exact producing model selection", () => {
  const item: ContextItem = {
    ...base,
    kind: "reasoning",
    role: "assistant",
    source: {
      kind: "reasoning",
      sequence: 0,
      metadata: {
        selection: {
          providerProfileId: "profile",
          modelId: "model",
          reasoningEffort: null,
        },
      },
    },
    content: { text: "opaque", visibility: "opaque" },
  };
  assert.equal(compileItemList([item]).messages.length, 0);
  assert.equal(
    compileItemList([item], {
      selection: { providerProfileId: "other", modelId: "model" },
    }).messages.length,
    0,
  );
  assert.equal(
    compileItemList([item], {
      selection: { providerProfileId: "profile", modelId: "model" },
    }).messages.length,
    1,
  );
});

test("invalid historical dates are unknown, never synthesized as receipt time", () => {
  const item = contextItemsFromLegacy({
    ...base,
    createdAt: "not a receipt",
    type: "user_message",
    text: "input",
  })[0]!;
  if (item.kind !== "message") throw new Error("message expected");
  assert.equal(
    item.content.parts[0]?.type === "text" && item.content.parts[0].text,
    "[Message receipt time unavailable]",
  );
});

test("steered user contents select after the complete observed tool batch without rewriting source order", () => {
  const facts: CanonicalItem[] = [
    {
      id: "user",
      threadId: "t",
      turnId: "turn",
      createdAt: "2026-10-27T00:00:00Z",
      type: "user_message",
      text: "initial",
    },
    {
      id: "steer",
      threadId: "t",
      turnId: "turn",
      createdAt: "2026-10-27T00:00:01Z",
      type: "user_message",
      text: "steer",
      deliveryAfter: "response",
    },
    {
      id: "response",
      threadId: "t",
      turnId: "turn",
      createdAt: "2026-10-27T00:00:02Z",
      type: "agent_message",
      text: "calling",
    },
    {
      id: "call",
      threadId: "t",
      turnId: "turn",
      createdAt: "2026-10-27T00:00:03Z",
      type: "tool_call",
      callId: "c",
      modelResponseId: "response",
      name: "observe",
      arguments: {},
    },
    {
      id: "result",
      threadId: "t",
      turnId: "turn",
      createdAt: "2026-10-27T00:00:04Z",
      type: "tool_result",
      callId: "c",
      output: "seen",
      exitCode: 0,
    },
  ];
  const context = facts.flatMap((item, index) =>
    contextItemsFromLegacy(item, facts.slice(0, index), index),
  );
  const serialized = JSON.stringify(context);
  const compiled = compileItemList(context);
  assert.deepEqual(compiled.selectedItemIds, [
    "user",
    "response",
    "call",
    "result",
    "steer",
  ]);
  assert.equal(JSON.stringify(context), serialized);
  assert.equal(compiled.messages.at(-1)?.role, "user");
});

test("opaque reasoning uses exact producing sample selection after an in-flight settings edit", () => {
  const start: CanonicalItem = {
    id: "start",
    threadId: "t",
    turnId: "turn",
    createdAt: "2026-10-27T00:00:00Z",
    type: "turn_started",
    selection: {
      providerProfileId: "p",
      modelId: "old",
      reasoningEffort: null,
    },
  };
  const reasoning: CanonicalItem = {
    id: "reason",
    threadId: "t",
    turnId: "turn",
    createdAt: "2026-10-27T00:00:01Z",
    type: "reasoning",
    reasoningContent: "opaque-bytes",
    contentVisibility: "opaque",
    selection: {
      providerProfileId: "p",
      modelId: "new",
      reasoningEffort: null,
    },
    opaqueReplayProvenance: {
      version: 1,
      adapter: "public-responses",
      endpointSha256: "a".repeat(64),
    },
  };
  const items = contextItemsFromLegacy(reasoning, [start]);
  assert.equal(
    compileItemList(items, {
      selection: { providerProfileId: "p", modelId: "old" },
    }).messages.length,
    0,
  );
  const compiled = compileItemList(items, {
    selection: { providerProfileId: "p", modelId: "new" },
  });
  assert.equal(compiled.messages[0]?.role, "reasoning");
  assert.deepEqual(legacyItemFromContext(items[0]!)?.type, "reasoning");
});

test("nested media is committed in the outer semantic receipt with exact child occurrence provenance", async () => {
  const base = {
    threadId: "t",
    turnId: "turn",
    createdAt: "2026-10-27T00:00:00Z",
  };
  const media = {
    type: "image" as const,
    attachment: {
      type: "attachment" as const,
      sha256: "a".repeat(64),
      mediaType: "image/png" as const,
      byteLength: 68,
      width: 1,
      height: 1,
    },
  };
  const facts: CanonicalItem[] = [
    {
      ...base,
      id: "root",
      type: "tool_call",
      callId: "root-call",
      name: "run_code",
      arguments: {},
    },
    {
      ...base,
      id: "child",
      type: "tool_call",
      callId: "child-call",
      parentCallId: "root-call",
      name: "observe",
      arguments: {},
    },
    {
      ...base,
      id: "child-result",
      type: "tool_result",
      callId: "child-call",
      output: "image observed",
      exitCode: 0,
      modelContent: [media],
    },
  ];
  const result: CanonicalItem = {
    ...base,
    id: "root-result",
    type: "tool_result",
    callId: "root-call",
    output: "program finished",
    exitCode: 0,
  };
  const semantic = contextItemsFromLegacy(result, facts);
  const compiled = compileItemList(semantic, {
    inputModalities: ["text", "image"],
  });
  const { sampledMediaOccurrences } = await import("../src/loop-recovery.js");
  assert.deepEqual(
    sampledMediaOccurrences([...facts, result], compiled.messages, [
      "text",
      "image",
    ]),
    [
      {
        itemId: "child-result",
        field: "modelContent",
        partIndex: 0,
        sha256: media.attachment.sha256,
      },
    ],
  );
  assert.equal(legacyItemFromContext(semantic[0]!)?.type, "tool_result");
  assert.equal("modelContent" in legacyItemFromContext(semantic[0]!)!, false);
});

test("agentic reset persists exact source exclusions, keeps unseen steering and never restores reset receipts", () => {
  const facts: CanonicalItem[] = [
    { ...base, id: "user", type: "user_message", text: "old" },
    {
      ...base,
      id: "reason",
      type: "reasoning",
      reasoningContent: "discard",
      summary: "discard",
      contentVisibility: "public",
    },
    { ...base, id: "response", type: "agent_message", text: "discard" },
    {
      ...base,
      id: "call",
      type: "tool_call",
      callId: "compact",
      name: "compact_context",
      arguments: {},
      modelResponseId: "response",
    },
    { ...base, id: "steer", type: "user_message", text: "unseen" },
    {
      ...base,
      id: "reset",
      type: "context_compaction",
      provenance: "agentic",
      initiator: "agent",
      algorithmVersion: "zen.context-compaction.agentic.v2",
      coveredThroughItemId: "user",
      sourceModelResponseId: "response",
      callId: "compact",
      retainedItemIds: [],
      includeOriginalReference: false,
      summary: "  exact continuation  ",
    },
    {
      ...base,
      id: "receipt",
      type: "tool_result",
      callId: "compact",
      output: "working context reset",
      exitCode: 0,
    },
  ];
  const items: ContextItem[] = [];
  for (const [index, fact] of facts.entries())
    items.push(
      ...contextItemsFromLegacy(fact, facts.slice(0, index), index, items),
    );
  const frozen = JSON.stringify(items);
  const selected = compileItemList(items);
  assert.deepEqual(selected.selectedItemIds, ["reset", "steer"]);
  assert.deepEqual(selected.messages[0], {
    role: "user",
    text: "[Zen compacted context]\n  exact continuation  ",
  });
  const reset = items.find((item) => item.id === "reset")!;
  assert.equal(reset.kind, "selection");
  if (reset.kind !== "selection") throw Error("selection expected");
  assert.deepEqual(reset.content.excludedCallIds, ["compact"]);
  assert.deepEqual(reset.content.excludedItemIds, [
    "reason",
    "response",
    "call",
  ]);
  assert.deepEqual(compileItemList(JSON.parse(frozen)), selected);
  assert.equal(JSON.stringify(items), frozen);
  assert.equal(
    (
      legacyItemFromContext(reset, contextAnnotationFromLegacy(facts[5]!)) as {
        summary: string;
      }
    ).summary,
    "  exact continuation  ",
  );
});

test("historical fork receipts close their original batch before later context without rewriting stored Items", () => {
  const facts: CanonicalItem[] = [
    {
      ...base,
      id: "call-a",
      type: "tool_call",
      callId: "a",
      name: "read",
      arguments: {},
    },
    {
      ...base,
      id: "call-b",
      type: "tool_call",
      callId: "b",
      name: "read",
      arguments: {},
    },
    {
      ...base,
      id: "result-b",
      type: "tool_result",
      callId: "b",
      output: "observed",
      exitCode: 0,
    },
    {
      ...base,
      id: "later",
      type: "agent_message",
      text: "Later selected answer",
    },
    {
      ...base,
      id: "snapshot-a",
      type: "tool_result",
      callId: "a",
      output: "Historical snapshot; not executed",
      exitCode: null,
      contentType: "zen.side-chat-tool-snapshot.v1",
      structuredContent: { status: "snapshot", executed: false },
    },
  ];
  const items = facts.flatMap((item, index) =>
    contextItemsFromLegacy(item, facts.slice(0, index)),
  );
  const before = JSON.stringify(items);
  const compiled = compileItemList(items);
  assert.deepEqual(compiled.selectedItemIds, [
    "call-a",
    "call-b",
    "result-b",
    "snapshot-a",
    "later",
  ]);
  assert.equal(JSON.stringify(items), before);
  assert.equal(items.at(-1)?.source.metadata?.historicalSnapshot, true);
});

test("hosted discovery payload is semantic, ordered, round-trippable and compactable", () => {
  const discovery: CanonicalItem = {
    ...base,
    id: "search",
    type: "tool_discovery",
    protocol: "openai-responses",
    endpointSha256: "a".repeat(64),
    items: [
      {
        type: "tool_search_call",
        id: "search-call",
        execution: "server",
        arguments: { query: "find" },
      },
      { type: "tool_search_output", id: "search-output", tools: [] },
    ],
  };
  const call: CanonicalItem = {
    ...base,
    id: "call",
    type: "tool_call",
    callId: "local",
    name: "lookup",
    providerNamespace: "plugin_docs",
    arguments: {},
  };
  const contexts = [
    ...contextItemsFromLegacy(discovery, [], 0),
    ...contextItemsFromLegacy(call, [discovery], 1),
  ];
  assert.deepEqual(legacyItemFromContext(contexts[0]!), discovery);
  assert.deepEqual(legacyItemFromContext(contexts[1]!), call);
  const compiled = compileItemList(contexts);
  assert.deepEqual(
    compiled.messages.map((m) => m.role),
    ["tool_discovery", "assistant"],
  );
  assert.deepEqual(compiled.messages[0], {
    role: "tool_discovery",
    protocol: discovery.protocol,
    endpointSha256: discovery.endpointSha256,
    items: discovery.items,
  });
  assert.deepEqual(
    compileItemList([
      ...contexts,
      {
        ...base,
        id: "compact",
        kind: "selection",
        role: "user",
        source: { kind: "context_compaction", sequence: 2 },
        content: {
          text: "summary",
          coveredThroughItemId: "call",
          coveredSequence: 1,
          retainedItemIds: [],
        },
      },
    ]).messages,
    [{ role: "user", text: "summary" }],
  );
  assert.throws(() =>
    decodeContextItem({
      ...contexts[0],
      content: { ...discovery, endpointSha256: "https://wrong" },
    }),
  );
});

test("compiler preserves exact committed provider presentation and later fallback clears it", () => {
  const presentation = {
    protocol: "openai-responses" as const,
    tools: [
      {
        type: "namespace",
        name: "plugin_docs",
        description: "Exact authored namespace",
        tools: [{ type: "function", name: "lookup", defer_loading: true }],
      },
      { type: "tool_search" },
    ],
  };
  const item: ContextItem = {
    ...base,
    id: "catalog",
    kind: "tools",
    role: "developer",
    source: { kind: "tool_definitions", sequence: 0 },
    content: { tools: [], providerToolPresentation: presentation },
  };
  assert.deepEqual(
    compileItemList([item]).providerToolPresentation,
    presentation,
  );
  const fallback: ContextItem = {
    ...item,
    id: "fallback",
    source: { ...item.source, sequence: 1 },
    content: { tools: [] },
  };
  assert.equal(
    compileItemList([item, fallback]).providerToolPresentation,
    undefined,
  );
});
