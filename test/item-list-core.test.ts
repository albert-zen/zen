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
