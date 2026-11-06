import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../../../src/item.js";
import type { AttachmentRef } from "../../../src/attachment-ref.js";
import type { Turn } from "../src/protocol-client/index.js";
import {
  indexTurnCanonicalPresentation,
  indexCanonicalQuoteItems,
} from "../src/renderer/src/turn-canonical-presentation.js";
import { projectToolActionTargets } from "../src/renderer/src/tool-action-targets.js";
type User = Extract<CanonicalItem, { type: "user_message" }>;
const turn = (id: string, ids: string[]) =>
  ({ id, items: ids.map((id) => ({ id })) }) as Turn;
const user = (id: string, text = "input"): User => ({
  id,
  type: "user_message",
  threadId: "thread",
  turnId: "turn-a",
  createdAt: "2026-01-01T00:00:00.000Z",
  text,
});
const emptyTargets = new Map();
test("append reuses old metadata while canonical replacement, removal and scope change invalidate", () => {
  const a = turn("turn-a", ["u-a", "a-a"]);
  const u = user("u-a");
  const inputs = new Map([[u.id, u]]);
  const forks = new Map([["a-a", "turn-a"]]);
  const first = indexTurnCanonicalPresentation(
    "thread",
    [a],
    inputs,
    forks,
    {},
    emptyTargets,
  );
  const b = turn("turn-b", ["u-b"]);
  const next = indexTurnCanonicalPresentation(
    "thread",
    [a, b],
    new Map([...inputs, ["u-b", user("u-b")]]),
    new Map(forks),
    {},
    new Map(),
    first,
  );
  assert.equal(next.turns.get(a.id), first.turns.get(a.id));
  const replacement = user(
    "u-a",
    "replacement with canonical reference framing",
  );
  const backfill = indexTurnCanonicalPresentation(
    "thread",
    [a, b],
    new Map([["u-a", replacement]]),
    forks,
    {},
    emptyTargets,
    next,
  );
  assert.notEqual(backfill.turns.get(a.id), next.turns.get(a.id));
  assert.equal(backfill.turns.get(a.id)!.inputs.get("u-a"), replacement);
  assert.equal(
    next.turns.get(a.id)!.inputs.get("u-a"),
    u,
    "previous committed view is immutable",
  );
  const removed = indexTurnCanonicalPresentation(
    "thread",
    [a],
    new Map(),
    new Map(),
    {},
    emptyTargets,
    backfill,
  );
  assert.equal(removed.turns.get(a.id)!.inputs.size, 0);
  assert.equal(removed.turns.get(a.id)!.forkItems.size, 0);
  const switched = indexTurnCanonicalPresentation(
    "other",
    [a],
    inputs,
    forks,
    {},
    emptyTargets,
    first,
  );
  assert.notEqual(switched.turns.get(a.id), first.turns.get(a.id));
});
test("attachment identity changes refresh only owning turn, including same-hash replaced references", () => {
  const a = turn("a", ["tool-a"]),
    b = turn("b", ["tool-b"]);
  const attachment = {
    sha256: "same-hash",
    mimeType: "image/png",
    sizeBytes: 10,
  } as unknown as AttachmentRef;
  const first = indexTurnCanonicalPresentation(
    "scope",
    [a, b],
    new Map(),
    new Map(),
    { "tool-a": [attachment], "tool-b": [attachment] },
    emptyTargets,
  );
  const repeated = indexTurnCanonicalPresentation(
    "scope",
    [a, b],
    new Map(),
    new Map(),
    { "tool-a": [attachment], "tool-b": [attachment] },
    emptyTargets,
    first,
  );
  assert.equal(repeated.turns.get("a"), first.turns.get("a"));
  assert.equal(repeated.turns.get("b"), first.turns.get("b"));
  const newer = { ...attachment };
  const changed = indexTurnCanonicalPresentation(
    "scope",
    [a, b],
    new Map(),
    new Map(),
    { "tool-a": [newer], "tool-b": [attachment] },
    emptyTargets,
    repeated,
  );
  assert.notEqual(changed.turns.get("a"), repeated.turns.get("a"));
  assert.equal(changed.turns.get("b"), repeated.turns.get("b"));
  assert.equal(changed.turns.get("a")!.attachments["tool-a"]![0], newer);
});
test("global cross-turn tool target projection is retained and backfilled target refreshes its consumer", () => {
  const stamp = { threadId: "thread", createdAt: "2026-01-01T00:00:00.000Z" };
  const call: CanonicalItem = {
    ...stamp,
    type: "tool_call",
    id: "call-item",
    callId: "call",
    turnId: "turn-b",
    name: "zenx_threads_send",
    arguments: {},
  };
  const result: CanonicalItem = {
    ...stamp,
    type: "tool_result",
    id: "result",
    callId: "call",
    turnId: "turn-b",
    exitCode: 0,
    output: JSON.stringify({ ref: "thread-ref", message: "message-ref" }),
  };
  const earlierCall: CanonicalItem = {
    ...stamp,
    type: "tool_call",
    id: "discovery-call",
    callId: "discovery",
    turnId: "turn-a",
    name: "zenx_threads_list",
    arguments: {},
  };
  const earlierBindings: CanonicalItem = {
    ...stamp,
    type: "tool_result",
    id: "discovery-result",
    callId: "discovery",
    turnId: "turn-a",
    exitCode: 0,
    output: "{}",
    referenceBindings: [
      {
        ref: "thread-ref",
        ownerThreadId: "thread",
        namespace: "threads",
        kind: "thread",
        value: { id: "other-thread", device: "local" },
      },
      {
        ref: "message-ref",
        ownerThreadId: "thread",
        namespace: "threads",
        kind: "item",
        value: {
          id: "earlier-turn-message",
          threadId: "other-thread",
          device: "local",
        },
      },
    ],
  };
  const a = turn("turn-a", ["discovery-call"]),
    b = turn("turn-b", ["call-item"]);
  const first = indexTurnCanonicalPresentation(
    "thread",
    [a, b],
    new Map(),
    new Map(),
    {},
    projectToolActionTargets("thread", [call, result]),
    undefined,
  );
  const second = indexTurnCanonicalPresentation(
    "thread",
    [a, b],
    new Map(),
    new Map(),
    {},
    projectToolActionTargets("thread", [
      earlierCall,
      earlierBindings,
      call,
      result,
    ]),
    first,
  );
  assert.deepEqual(first.turns.get("turn-b")!.toolTargets.get("call-item"), {
    label: "message",
    unavailable: "missing",
  });
  assert.equal(first.turns.get("turn-a"), second.turns.get("turn-a"));
  assert.notEqual(first.turns.get("turn-b"), second.turns.get("turn-b"));
  assert.deepEqual(second.turns.get("turn-b")!.toolTargets.get("call-item"), {
    label: "message",
    target: {
      kind: "thread",
      id: "other-thread",
      itemId: "earlier-turn-message",
    },
  });
  const again = indexTurnCanonicalPresentation(
    "thread",
    [a, b],
    new Map(),
    new Map(),
    {},
    projectToolActionTargets("thread", [
      earlierCall,
      earlierBindings,
      call,
      result,
    ]),
    second,
  );
  assert.equal(
    again.turns.get("turn-b"),
    second.turns.get("turn-b"),
    "equal reprojected targets retain the existing per-turn context identity",
  );
});

test("quote metadata preserves call/result pairs, immutable reuse, late replacement and removal", () => {
  const stamp = { threadId: "thread", createdAt: "2026-01-01T00:00:00.000Z" };
  const call: CanonicalItem = {
    ...stamp,
    type: "tool_call",
    id: "call-item",
    callId: "call",
    turnId: "a",
    name: "test",
    arguments: {},
  };
  const result: CanonicalItem = {
    ...stamp,
    type: "tool_result",
    id: "result-item",
    callId: "call",
    turnId: "a",
    exitCode: 0,
    output: "first",
  };
  const unrelated = user("unrelated");
  const a = turn("a", [call.id]),
    b = turn("b", [unrelated.id]);
  // The displayed result row can live elsewhere; quote pairing follows canonical ownership.
  const resultRow = turn("result-row", [result.id]);
  const beforeResult = indexTurnCanonicalPresentation(
    "scope",
    [a, b, resultRow],
    new Map(),
    new Map(),
    {},
    emptyTargets,
    undefined,
    indexCanonicalQuoteItems([call, unrelated]),
  );
  assert.deepEqual(beforeResult.turns.get("a")!.quoteItems.get(call.id), [
    call,
  ]);
  assert.equal(beforeResult.turns.get("result-row")!.quoteItems.size, 0);
  const initialItems = [call, result, unrelated];
  const first = indexTurnCanonicalPresentation(
    "scope",
    [a, b, resultRow],
    new Map(),
    new Map(),
    {},
    emptyTargets,
    beforeResult,
    indexCanonicalQuoteItems(initialItems),
  );
  assert.deepEqual(first.turns.get("a")!.quoteItems.get(call.id), [
    call,
    result,
  ]);
  assert.notEqual(first.turns.get("a"), beforeResult.turns.get("a"));
  assert.notEqual(
    first.turns.get("result-row"),
    beforeResult.turns.get("result-row"),
  );
  assert.equal(first.turns.get("b"), beforeResult.turns.get("b"));
  assert.deepEqual(first.turns.get("result-row")!.quoteItems.get(result.id), [
    result,
  ]);
  const appended = indexTurnCanonicalPresentation(
    "scope",
    [a, b, resultRow],
    new Map(),
    new Map(),
    {},
    emptyTargets,
    first,
    indexCanonicalQuoteItems([...initialItems, user("new")]),
  );
  assert.equal(appended.turns.get("a"), first.turns.get("a"));
  assert.equal(appended.turns.get("b"), first.turns.get("b"));
  const replacement = { ...result, output: "late correction" };
  const changed = indexTurnCanonicalPresentation(
    "scope",
    [a, b, resultRow],
    new Map(),
    new Map(),
    {},
    emptyTargets,
    appended,
    indexCanonicalQuoteItems([call, replacement, unrelated]),
  );
  assert.notEqual(changed.turns.get("a"), appended.turns.get("a"));
  assert.equal(changed.turns.get("b"), appended.turns.get("b"));
  assert.deepEqual(changed.turns.get("a")!.quoteItems.get(call.id), [
    call,
    replacement,
  ]);
  assert.deepEqual(first.turns.get("a")!.quoteItems.get(call.id), [
    call,
    result,
  ]);
  const removed = indexTurnCanonicalPresentation(
    "scope",
    [a, b, resultRow],
    new Map(),
    new Map(),
    {},
    emptyTargets,
    changed,
    indexCanonicalQuoteItems([call, unrelated]),
  );
  assert.deepEqual(removed.turns.get("a")!.quoteItems.get(call.id), [call]);
  assert.notEqual(removed.turns.get("a"), changed.turns.get("a"));
  assert.notEqual(
    removed.turns.get("result-row"),
    changed.turns.get("result-row"),
  );
  assert.equal(removed.turns.get("result-row")!.quoteItems.size, 0);
});

test("streaming Turn changes do not traverse unchanged Turn items with identical metadata inputs", () => {
  let historicalItemVisits = 0;
  const historical = Array.from({ length: 40 }, (_, index) => {
    const value = turn(`history-${index}`, [
      `user-${index}`,
      `answer-${index}`,
    ]);
    const iterate = value.items[Symbol.iterator].bind(value.items);
    value.items[Symbol.iterator] = function* () {
      for (const item of iterate()) {
        historicalItemVisits++;
        yield item;
      }
      return undefined;
    };
    return value;
  });
  const active = turn("active", ["streaming-answer"]);
  const inputs = new Map<string, User>();
  const forks = new Map<string, string | undefined>();
  const attachments = {};
  const targets = new Map();
  const quotes = new Map<string, readonly CanonicalItem[]>();
  const first = indexTurnCanonicalPresentation(
    "scope",
    [...historical, active],
    inputs,
    forks,
    attachments,
    targets,
    undefined,
    quotes,
  );
  assert.equal(historicalItemVisits, 80);
  historicalItemVisits = 0;
  const streamed = {
    ...active,
    items: active.items.map((item) => ({ ...item })),
  };
  const second = indexTurnCanonicalPresentation(
    "scope",
    [...historical, streamed],
    inputs,
    forks,
    attachments,
    targets,
    first,
    quotes,
  );
  assert.equal(
    historicalItemVisits,
    0,
    "immutable historical Turn membership is already known",
  );
  for (const value of historical)
    assert.equal(second.turns.get(value.id), first.turns.get(value.id));
  assert.equal(second.turns.get(active.id), first.turns.get(active.id));
  // A discarded render must not change the source identities of its predecessor.
  const third = indexTurnCanonicalPresentation(
    "scope",
    [...historical, active],
    inputs,
    forks,
    attachments,
    targets,
    first,
    quotes,
  );
  assert.equal(historicalItemVisits, 0);
  assert.equal(third.turns.get(active.id), first.turns.get(active.id));
});

test("stable Turn identity still rechecks changed metadata and reordered or removed membership", () => {
  const a = turn("a", ["u"]),
    b = turn("b", ["answer"]);
  const inputs = new Map([["u", user("u")]]);
  const forks = new Map<string, string | undefined>();
  const attachments = {};
  const targets = new Map();
  const quotes = new Map<string, readonly CanonicalItem[]>();
  const first = indexTurnCanonicalPresentation(
    "scope",
    [a, b],
    inputs,
    forks,
    attachments,
    targets,
    undefined,
    quotes,
  );
  const changed = user("u", "Late metadata replacement");
  const next = indexTurnCanonicalPresentation(
    "scope",
    [a, b],
    new Map([["u", changed]]),
    forks,
    attachments,
    targets,
    first,
    quotes,
  );
  assert.equal(next.turns.get("a")!.inputs.get("u"), changed);
  assert.equal(first.turns.get("a")!.inputs.get("u"), inputs.get("u"));
  const reordered = indexTurnCanonicalPresentation(
    "scope",
    [b, a],
    inputs,
    forks,
    attachments,
    targets,
    first,
    quotes,
  );
  assert.equal(reordered.turns.get("a"), first.turns.get("a"));
  assert.equal(reordered.turns.get("b"), first.turns.get("b"));
  const removed = indexTurnCanonicalPresentation(
    "scope",
    [b],
    inputs,
    forks,
    attachments,
    targets,
    first,
    quotes,
  );
  assert.equal(removed.turns.has("a"), false);
  const replacedTurn = { ...a, items: [] };
  const missing = indexTurnCanonicalPresentation(
    "scope",
    [replacedTurn, b],
    inputs,
    forks,
    attachments,
    targets,
    first,
    quotes,
  );
  assert.equal(missing.turns.get("a")!.inputs.size, 0);
  assert.equal(first.turns.get("a")!.inputs.size, 1);
});

test("answered questions partition by Turn and unchanged history retains its context on streaming, backfill and removal", () => {
  const a = turn("a", ["answer-a"]);
  const b = turn("b", ["answer-b"]);
  const inputs = new Map<string, User>();
  const forks = new Map<string, string | undefined>();
  const answers = new Map([
    ["answer-a", { fallbackText: "Recorded answer A" }],
  ]);
  const first = indexTurnCanonicalPresentation(
    "thread",
    [a, b],
    inputs,
    forks,
    {},
    emptyTargets,
    undefined,
    new Map(),
    answers,
  );
  const same = indexTurnCanonicalPresentation(
    "thread",
    [a, { ...b }],
    inputs,
    forks,
    {},
    emptyTargets,
    first,
    new Map(),
    new Map([
      ["answer-a", { fallbackText: "Recorded answer A" }],
      ["answer-b", { fallbackText: "Recorded answer B" }],
    ]),
  );
  assert.equal(same.turns.get("a"), first.turns.get("a"));
  assert.notEqual(same.turns.get("b"), first.turns.get("b"));
  const backfill = indexTurnCanonicalPresentation(
    "thread",
    [a, b],
    inputs,
    forks,
    {},
    emptyTargets,
    same,
    new Map(),
    new Map([["answer-a", { fallbackText: "Updated original" }]]),
  );
  assert.notEqual(backfill.turns.get("a"), same.turns.get("a"));
  assert.equal(backfill.turns.get("b")?.answeredQuestions?.size, 0);
  assert.equal(
    same.turns.get("a")?.answeredQuestions?.get("answer-a")?.fallbackText,
    "Recorded answer A",
  );
});
