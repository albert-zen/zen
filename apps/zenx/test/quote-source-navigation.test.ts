import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { CanonicalItem } from "../../../src/item.js";
import {
  findMessageQuoteSource,
  quoteSourceTarget,
} from "../src/renderer/src/quote-source-navigation.js";
import {
  indexCanonicalQuoteItems,
  indexTurnCanonicalPresentation,
} from "../src/renderer/src/turn-canonical-presentation.js";
import { disclosureKey } from "../src/renderer/src/thread-reading-state.js";
import {
  runtimeIntro,
  runtimeThread,
  runtimeCommand,
  runtimeMessage,
} from "./fixtures/agent-runtime-data.js";
const thread = runtimeThread(
  [
    runtimeIntro[0]!,
    runtimeMessage("middle", "Intermediate"),
    runtimeCommand("call"),
    runtimeCommand("call-two"),
    runtimeMessage("final", "Final"),
  ],
  "completed",
);
const stamp = {
  threadId: thread.id,
  turnId: thread.turns[0]!.id,
  createdAt: "2026-11-03T00:00:00Z",
};
const canonical: CanonicalItem[] = [
  {
    ...stamp,
    type: "user_message",
    id: "runtime-user",
    text: "Original input",
  },
  { ...stamp, type: "agent_message", id: "middle", text: "Intermediate" },
  {
    ...stamp,
    type: "tool_call",
    id: "call",
    callId: "tool-call",
    name: "shell",
    arguments: {},
  },
  {
    ...stamp,
    type: "tool_result",
    id: "result",
    callId: "tool-call",
    output: "Output",
    exitCode: 0,
  },
  {
    ...stamp,
    type: "tool_call",
    id: "call-two",
    callId: "tool-two",
    name: "shell",
    arguments: {},
  },
  { ...stamp, type: "agent_message", id: "final", text: "Final" },
];
const presentation = indexTurnCanonicalPresentation(
  "test",
  thread.turns,
  new Map(),
  new Map(),
  {},
  new Map(),
  undefined,
  indexCanonicalQuoteItems(canonical),
);
const target = (id: string, threadId = thread.id) =>
  quoteSourceTarget(thread.id, thread.turns, presentation, { id, threadId });
test("canonical final/input quote targets do not unnecessarily expand completed history", () => {
  assert.deepEqual(target("final")?.disclosures, []);
  assert.deepEqual(target("runtime-user")?.disclosures, []);
  assert.equal(
    target("final")?.rowKey,
    JSON.stringify([thread.id, "turn", stamp.turnId]),
  );
});
test("an intermediate quote opens only its owning turn", () => {
  assert.deepEqual(target("middle")?.disclosures, [
    disclosureKey("turn", stamp.turnId),
  ]);
});
test("canonical tool-result alias resolves its represented call row and exact trace disclosure", () => {
  assert.equal(target("result")?.renderItemId, "call");
  assert.deepEqual(target("result")?.disclosures, [
    disclosureKey("turn", stamp.turnId),
    disclosureKey("trace", stamp.turnId, "call"),
    disclosureKey("item", stamp.turnId, "call"),
  ]);
});
test("unknown canonical IDs and wrong-thread identities never fall back to text", () => {
  assert.equal(target("missing"), null);
  assert.equal(target("final", "another-thread"), null);
});
test("mounted source lookup keeps exact thread identity and accepts canonical multi-item aliases", () => {
  const dom = new JSDOM(
    `<div id="viewport"><article data-quote-thread-id="thread" data-quote-item-id="call" data-quote-item-ids='["call","result"]'>Output</article><article data-quote-thread-id="other" data-quote-item-id="result">Output</article></div>`,
  );
  const viewport = dom.window.document.getElementById("viewport")!;
  assert.equal(
    findMessageQuoteSource(viewport, { threadId: "thread", id: "result" })
      ?.dataset.quoteItemId,
    "call",
  );
  assert.equal(
    findMessageQuoteSource(viewport, { threadId: "missing", id: "result" }),
    null,
  );
  assert.equal(
    findMessageQuoteSource(viewport, { threadId: "thread", id: "not-present" }),
    null,
  );
  dom.window.close();
});

test("excerpt range spans formatting only within the exact source and never changes content", async () => {
  const { quoteExcerptRange, focusMessageQuoteSource } =
    await import("../src/renderer/src/quote-source-navigation.js");
  const dom = new JSDOM(
    '<div class="messages"><div data-quote-thread-id="other" data-quote-item-id="same">精确原句。</div><div tabindex="-1" data-quote-thread-id="right" data-quote-item-id="same">之前。<strong>精确</strong><em>原句。</em>之后。<button>不可匹配</button></div></div>',
  );
  const document = dom.window.document;
  const source = findMessageQuoteSource(document.body, {
    threadId: "right",
    id: "same",
  })!;
  assert.ok(source);
  assert.equal(
    quoteExcerptRange(source, "精确原句。")?.toString(),
    "精确原句。",
  );
  assert.equal(
    quoteExcerptRange(source, "精确 \n原句。")?.toString(),
    "精确原句。",
  );
  assert.equal(quoteExcerptRange(source, "不可匹配"), null);
  assert.equal(quoteExcerptRange(source, "missing"), null);
  const before = source.innerHTML;
  let centers = 0;
  source.scrollIntoView = () => {
    centers++;
  };
  focusMessageQuoteSource(source, "精确原句。");
  assert.equal(source.dataset.quoteHighlight, "true");
  assert.equal(document.activeElement, source);
  focusMessageQuoteSource(source, "精确原句。");
  assert.equal(centers, 2);
  assert.equal(source.innerHTML, before);
  document.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape" }),
  );
  assert.equal(source.dataset.quoteHighlight, undefined);
  dom.window.close();
});
