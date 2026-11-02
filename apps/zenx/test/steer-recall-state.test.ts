import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem, QueuedUserMessageItem, SteerRecalledItem } from "../../../src/item.js";
import { recoverSteerRecall } from "../../../src/steer-recall.js";
import {
  createSteerRecallStore, mergeComposerDrafts, recallTargets, resolveRecallRead,
  restoreRecalledComposer, validateRecallReply,
} from "../src/renderer/src/steer-recall-state.js";
import {
  addComposerImages, beginComposerSubmission, editComposer, emptyComposerState,
  failComposerSubmission, reconcileCanonicalAdmission,
} from "../src/renderer/src/composer-state.js";
import { parseSkillDraft, withSkillDraft } from "../src/renderer/src/skill-draft.js";
import { referenceMessage, parseSentReferenceContent } from "../src/renderer/src/reference-draft.js";

const createdAt = "2026-11-02T00:00:00.000Z";
function queued(id: string, text = id): QueuedUserMessageItem {
  return { type: "user_message_queued", id, threadId: "thread", createdAt,
    clientId: "client-" + id, input: [{ type: "text", text }],
    deliveryMode: "steer", expectedTurnId: "turn" };
}
function recovery(messages = [queued("first"), queued("second")]) {
  const receipt: SteerRecalledItem = {
    type: "user_message_steer_recalled", id: "receipt", threadId: "thread",
    createdAt, recallId: "recall", targets: recallTargets(messages),
  };
  const result = recoverSteerRecall([...messages, receipt], "thread", "recall")!;
  assert.ok(result);
  return { ...result, status: "recalled" as const };
}
const image = (id: string) => ({
  id, name: id + ".png", attachment: { type: "attachment" as const,
    sha256: "a".repeat(64), mediaType: "image/png" as const,
    byteLength: 68, width: 1, height: 1 },
});

test("recall snapshot has no message-count cap and excludes later arrivals", () => {
  const items = Array.from({ length: 300 }, (_, index) => queued(String(index)));
  const targets = recallTargets(items);
  assert.equal(targets.length, 300);
  const result = recovery(items);
  const later = queued("later");
  assert.deepEqual(recallTargets([...items, result.receipt, later]), [
    { queuedItemId: later.id, clientId: later.clientId, expectedRevision: 0 },
  ]);
  assert.equal(targets.length, 300);
});

test("unknown outcome is resolved only by exact receipt; disappearance never restores", () => {
  const items = [queued("one"), queued("two")];
  const result = recovery(items);
  const request = { threadId: "thread", recallId: "recall", targets: recallTargets(items) };
  assert.deepEqual(resolveRecallRead(request, items), { state: "unknown" });
  assert.equal(resolveRecallRead(request, [...items, result.receipt]).state, "recalled");
  assert.deepEqual(resolveRecallRead(request, []), { state: "conflict" });
  const claimed: CanonicalItem = {
    type: "user_message", id: "claim", threadId: "thread", turnId: "turn",
    createdAt, clientId: items[0]!.clientId, content: items[0]!.input,
  };
  assert.deepEqual(resolveRecallRead(request, [...items, claimed]), { state: "conflict" });
  assert.equal(validateRecallReply(request, result), result);
  assert.throws(() => validateRecallReply(request, { ...result,
    receipt: { ...result.receipt, threadId: "other" } }));
  assert.throws(() => validateRecallReply(request, { ...result, messages: result.messages.slice(1) }));
});

test("whole batch restores in admission order before the latest independently edited draft", () => {
  let latest = editComposer(emptyComposerState(), "draft at click");
  latest = editComposer(latest, "newer typing while RPC runs");
  const restored = restoreRecalledComposer(latest, recovery(), () => "new-image");
  assert.equal(restored.draft.text, "first\n\nsecond\n\nnewer typing while RPC runs");
  assert.equal(restored.draftRevision, latest.draftRevision + 1);
  assert.equal(latest.draft.text, "newer typing while RPC runs");
});

test("client-bound references, emoji positions, skills and duplicate ordered images survive merge", () => {
  const oldText = "😀 recalled \uFFFC";
  const latestText = "newer \uFFFC";
  const oldRef = { kind: "file" as const, name: "old.ts", cwd: "/synthetic",
    path: "old.ts", position: oldText.indexOf("\uFFFC") };
  const newRef = { kind: "file" as const, name: "new.ts", cwd: "/synthetic",
    path: "new.ts", position: latestText.indexOf("\uFFFC") };
  const skill = { id: "11111111-1111-1111-1111-111111111111", name: "keep_skill" };
  const first = queued("first");
  first.input = [
    { type: "text", text: referenceMessage(oldText, [oldRef], first.clientId) },
    { type: "image", attachment: image("old").attachment },
    { type: "image", attachment: image("old").attachment },
  ];
  const latest = addComposerImages(editComposer(emptyComposerState(),
    withSkillDraft(latestText, [skill], [newRef])), [image("latest")]);
  let ids = 0;
  const restored = restoreRecalledComposer(latest, recovery([first]), () => "restored-" + ++ids);
  const parsed = parseSkillDraft(restored.draft.text);
  assert.equal(parsed.text, oldText + "\n\n" + latestText);
  assert.deepEqual(parsed.skills, [skill]);
  assert.deepEqual(parsed.references.map((ref) => ref.name), ["old.ts", "new.ts"]);
  assert.deepEqual(parsed.references.map((ref) => ref.position),
    [oldText.indexOf("\uFFFC"), oldText.length + 2 + latestText.indexOf("\uFFFC")]);
  for (const ref of parsed.references) assert.equal(parsed.text.charAt(ref.position!), "\uFFFC");
  assert.doesNotMatch(parsed.text, /\[zenx-references:/);
  assert.deepEqual(restored.draft.images.map((entry) => entry.id),
    ["restored-1", "restored-2", "latest"]);
  assert.deepEqual(restored.draft.images.map((entry) => entry.attachment),
    [image("old").attachment, image("old").attachment, image("latest").attachment]);
  const sent = referenceMessage(parsed.text, parsed.references, "new-client");
  assert.equal(parseSentReferenceContent(sent, "new-client").references.length, 2);
  assert.equal(parseSentReferenceContent(sent, first.clientId).references.length, 0);
  assert.equal(beginComposerSubmission(restored, "start", null, () => "new-client")
    .submission?.clientUserMessageId, "new-client");
});

test("unsupported structured input and an in-flight send keep the recovery card rather than changing draft", () => {
  const pending = beginComposerSubmission(editComposer(emptyComposerState(), "sending"),
    "steer", "turn", () => "sending-client");
  assert.equal(restoreRecalledComposer(pending, recovery(), () => "unused"), pending);
  const unsupported = queued("structured");
  unsupported.input = [{ type: "text", text: "one" }, { type: "text", text: "two" }];
  const latest = editComposer(emptyComposerState(), "keep");
  assert.equal(restoreRecalledComposer(latest, recovery([unsupported]), () => "unused"), latest);
});

test("compaction feedback does not block ordinary steer or recall and duplicate submission still blocks", () => {
  const state = { ...editComposer(emptyComposerState(), "ordinary"),
    compaction: { status: "pending" as const, message: "Summary is running" },
    compactionRequest: { token: {} } };
  const sending = beginComposerSubmission(state, "steer", "turn", () => "client");
  assert.equal(sending.submission?.clientUserMessageId, "client");
  assert.equal(sending.compaction, state.compaction);
  assert.equal(beginComposerSubmission(sending, "steer", "turn", () => "duplicate"), sending);
  const restored = restoreRecalledComposer(state, recovery(), () => "unused");
  assert.equal(restored.compactionRequest, state.compactionRequest);
  assert.equal(restored.compaction, state.compaction);
  assert.equal(restored.draft.text, "first\n\nsecond\n\nordinary");
});

test("native staged receipt settles uncertain steer admission as queued, never model delivered", () => {
  const pending = beginComposerSubmission(editComposer(emptyComposerState(), "one"),
    "steer", "turn", () => "client-one");
  const unknown = failComposerSubmission(pending, "client-one", "request outcome unknown");
  const staged = reconcileCanonicalAdmission(unknown, [queued("one")]);
  assert.equal(staged.confirmedAdmission?.stage, "queued");
  assert.equal(staged.submission, null);
  const newer = reconcileCanonicalAdmission(editComposer(unknown, "new draft"), [queued("one")]);
  assert.equal(newer.draft.text, "new draft");
  const { expectedTurnId: _turn, ...ordinary } = queued("one");
  assert.equal(reconcileCanonicalAdmission(unknown,
    [{ ...ordinary, deliveryMode: "batch-next" }]), unknown);
});

test("memory receipt application is scoped by immutable receipt and no new store auto-restores", () => {
  const store = createSteerRecallStore();
  let changes = 0;
  const off = store.subscribe(() => changes++);
  const request = { threadId: "thread", recallId: "recall", targets: recallTargets([queued("one")]) };
  store.set("thread", { request, owner: Symbol(), phase: "pending" });
  assert.equal(store.getSnapshot().sessions.other, undefined);
  store.applied("receipt");
  assert.equal(store.getSnapshot().applied.has("receipt"), true);
  assert.equal(changes, 2);
  assert.equal(createSteerRecallStore().getSnapshot().applied.has("receipt"), false);
  off();
});

test("empty visible bodies do not add separators or lose image-only inputs", () => {
  assert.deepEqual(mergeComposerDrafts([
    { text: "", images: [image("first")] }, { text: "last", images: [] },
  ]), { text: "last", images: [image("first")] });
});
