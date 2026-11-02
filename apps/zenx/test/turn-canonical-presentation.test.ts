import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../../../src/item.js";
import type { AttachmentRef } from "../../../src/attachment-ref.js";
import type { Turn } from "../src/protocol-client/index.js";
import { indexTurnCanonicalPresentation } from "../src/renderer/src/turn-canonical-presentation.js";
import { projectToolActionTargets } from "../src/renderer/src/tool-action-targets.js";
type User = Extract<CanonicalItem, { type: "user_message" }>;
const turn = (id: string, ids: string[]) => ({ id, items: ids.map((id) => ({ id })) }) as Turn;
const user = (id: string, text = "input"): User => ({
  id, type: "user_message", threadId: "thread", turnId: "turn-a",
  createdAt: "2026-01-01T00:00:00.000Z", text,
});
const emptyTargets = new Map();
test("append reuses old metadata while canonical replacement, removal and scope change invalidate", () => {
  const a = turn("turn-a", ["u-a", "a-a"]);
  const u = user("u-a");
  const inputs = new Map([[u.id, u]]);
  const forks = new Map([["a-a", "turn-a"]]);
  const first = indexTurnCanonicalPresentation("thread", [a], inputs, forks, {}, emptyTargets);
  const b = turn("turn-b", ["u-b"]);
  const next = indexTurnCanonicalPresentation("thread", [a, b],
    new Map([...inputs, ["u-b", user("u-b")]]), new Map(forks), {}, new Map(), first);
  assert.equal(next.turns.get(a.id), first.turns.get(a.id));
  const replacement = user("u-a", "replacement with canonical reference framing");
  const backfill = indexTurnCanonicalPresentation("thread", [a, b],
    new Map([["u-a", replacement]]), forks, {}, emptyTargets, next);
  assert.notEqual(backfill.turns.get(a.id), next.turns.get(a.id));
  assert.equal(backfill.turns.get(a.id)!.inputs.get("u-a"), replacement);
  assert.equal(next.turns.get(a.id)!.inputs.get("u-a"), u, "previous committed view is immutable");
  const removed = indexTurnCanonicalPresentation("thread", [a], new Map(), new Map(), {}, emptyTargets, backfill);
  assert.equal(removed.turns.get(a.id)!.inputs.size, 0);
  assert.equal(removed.turns.get(a.id)!.forkItems.size, 0);
  const switched = indexTurnCanonicalPresentation("other", [a], inputs, forks, {}, emptyTargets, first);
  assert.notEqual(switched.turns.get(a.id), first.turns.get(a.id));
});
test("attachment identity changes refresh only owning turn, including same-hash replaced references", () => {
  const a = turn("a", ["tool-a"]), b = turn("b", ["tool-b"]);
  const attachment = { sha256: "same-hash", mimeType: "image/png", sizeBytes: 10 } as unknown as AttachmentRef;
  const first = indexTurnCanonicalPresentation("scope", [a, b], new Map(), new Map(),
    { "tool-a": [attachment], "tool-b": [attachment] }, emptyTargets);
  const repeated = indexTurnCanonicalPresentation("scope", [a, b], new Map(), new Map(),
    { "tool-a": [attachment], "tool-b": [attachment] }, emptyTargets, first);
  assert.equal(repeated.turns.get("a"), first.turns.get("a"));
  assert.equal(repeated.turns.get("b"), first.turns.get("b"));
  const newer = { ...attachment };
  const changed = indexTurnCanonicalPresentation("scope", [a, b], new Map(), new Map(),
    { "tool-a": [newer], "tool-b": [attachment] }, emptyTargets, repeated);
  assert.notEqual(changed.turns.get("a"), repeated.turns.get("a"));
  assert.equal(changed.turns.get("b"), repeated.turns.get("b"));
  assert.equal(changed.turns.get("a")!.attachments["tool-a"]![0], newer);
});
test("global cross-turn tool target projection is retained and backfilled target refreshes its consumer", () => {
  const stamp = { threadId: "thread", createdAt: "2026-01-01T00:00:00.000Z" };
  const call: CanonicalItem = { ...stamp, type: "tool_call", id: "call-item", callId: "call",
    turnId: "turn-b", name: "zenx_threads_send", arguments: {} };
  const result: CanonicalItem = { ...stamp, type: "tool_result", id: "result", callId: "call",
    turnId: "turn-b", exitCode: 0, output: JSON.stringify({ threadId: "other-thread", messageId: "earlier-turn-message" }) };
  const a = turn("turn-a", ["earlier-turn-message"]), b = turn("turn-b", ["call-item"]);
  const first = indexTurnCanonicalPresentation("thread", [a, b], new Map(), new Map(), {},
    projectToolActionTargets("thread", [call]), undefined);
  const second = indexTurnCanonicalPresentation("thread", [a, b], new Map(), new Map(), {},
    projectToolActionTargets("thread", [call, result]), first);
  assert.equal(first.turns.get("turn-a"), second.turns.get("turn-a"));
  assert.notEqual(first.turns.get("turn-b"), second.turns.get("turn-b"));
  assert.deepEqual(second.turns.get("turn-b")!.toolTargets.get("call-item"), {
    label: "message", target: { kind: "thread", id: "other-thread", itemId: "earlier-turn-message" },
  });
  const again = indexTurnCanonicalPresentation("thread", [a, b], new Map(), new Map(), {},
    projectToolActionTargets("thread", [call, result]), second);
  assert.equal(again.turns.get("turn-b"), second.turns.get("turn-b"),
    "equal reprojected targets retain the existing per-turn context identity");
});
