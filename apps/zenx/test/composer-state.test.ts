import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileCanonicalAdmission,
  acceptComposerSubmission,
  addComposerImages,
  beginComposerSubmission,
  composerDraftHasContent,
  defaultComposerIntent,
  editComposer,
  emptyComposerState,
  failComposerSubmission,
  removeComposerImage,
} from "../src/renderer/src/composer-state.js";

test("unknown queued admission settles only from canonical same clientId and tracks delivery", () => {
  const initial = beginComposerSubmission(
    editComposer(emptyComposerState(), "same text"),
    "queue",
    "active",
    () => "stable-1",
  );
  const unknown = failComposerSubmission(
    initial,
    "stable-1",
    "request outcome unknown",
  );
  const other = [
    queueItem("different-id"),
    messageItem("different-id", "turn-1"),
  ];
  assert.equal(reconcileCanonicalAdmission(unknown, other), unknown);
  const queued = reconcileCanonicalAdmission(unknown, [
    ...other,
    queueItem("stable-1"),
  ]);
  assert.equal(queued.submission, null);
  assert.equal(queued.draft.text, "");
  assert.equal(queued.confirmedAdmission?.stage, "queued");
  const delivered = reconcileCanonicalAdmission(queued, [
    ...other,
    queueItem("stable-1"),
    messageItem("stable-1", "turn-2"),
  ]);
  assert.equal(delivered.confirmedAdmission?.stage, "delivered");
  const completed = reconcileCanonicalAdmission(delivered, [
    ...other,
    queueItem("stable-1"),
    messageItem("stable-1", "turn-2"),
    completedItem("turn-2"),
  ]);
  assert.equal(completed.confirmedAdmission?.stage, "completed");
});

test("other intent rejects queued evidence; changed draft and new submission never clear on late old ID", () => {
  const start = beginComposerSubmission(
    editComposer(emptyComposerState(), "same text"),
    "start",
    null,
    () => "stable-1",
  );
  const unknown = failComposerSubmission(
    start,
    "stable-1",
    "request outcome unknown",
  );
  assert.equal(
    reconcileCanonicalAdmission(unknown, [queueItem("stable-1")]),
    unknown,
  );
  const edited = editComposer(unknown, "new text");
  assert.equal(
    reconcileCanonicalAdmission(edited, [messageItem("stable-1", "turn-1")]),
    edited,
  );
  const newSubmission = beginComposerSubmission(
    edited,
    "queue",
    "turn-2",
    () => "stable-2",
  );
  assert.equal(
    reconcileCanonicalAdmission(newSubmission, [
      messageItem("stable-1", "turn-1"),
    ]),
    newSubmission,
  );
  assert.equal(newSubmission.draft.text, "new text");
});

test("explicit refusal stays refused; queue disappearance is not admission evidence", () => {
  const queued = beginComposerSubmission(
    editComposer(emptyComposerState(), "draft"),
    "queue",
    "turn-1",
    () => "stable",
  );
  const explicit = failComposerSubmission(
    queued,
    "stable",
    "explicit admission rejected",
  );
  assert.equal(
    reconcileCanonicalAdmission(explicit, [queueItem("stable")]),
    explicit,
  );
  const unknown = failComposerSubmission(
    queued,
    "stable",
    "request outcome unknown",
  );
  assert.equal(reconcileCanonicalAdmission(unknown, []), unknown);
  const editedPending = editComposer(queued, "new draft");
  const confirmed = reconcileCanonicalAdmission(editedPending, [
    queueItem("stable"),
  ]);
  assert.equal(confirmed.draft.text, "new draft");
  assert.equal(confirmed.confirmedAdmission?.stage, "queued");
});

function queueItem(clientId: string) {
  return {
    id: `queue-${clientId}`,
    type: "user_message_queued" as const,
    threadId: "thread-1",
    createdAt: "2026-09-30T00:00:00Z",
    clientId,
    input: [{ type: "text" as const, text: "same text" }],
  };
}
function messageItem(clientId: string, turnId: string) {
  return {
    id: `message-${clientId}`,
    type: "user_message" as const,
    threadId: "thread-1",
    turnId,
    createdAt: "2026-09-30T00:00:00Z",
    clientId,
    text: "same text",
  };
}
function completedItem(turnId: string) {
  return {
    id: `complete-${turnId}`,
    type: "turn_completed" as const,
    threadId: "thread-1",
    turnId,
    createdAt: "2026-09-30T00:00:00Z",
    status: "completed" as const,
  };
}

const image = (id: string) => ({
  id,
  name: `${id}.png`,
  attachment: {
    type: "attachment" as const,
    sha256: id.padEnd(64, "0"),
    mediaType: "image/png" as const,
    byteLength: 68,
    width: 1,
    height: 1,
  },
});

test("maps idle, active, and replacement submissions without a queue", () => {
  let ids = 0;
  const createId = () => `message-${++ids}`;
  const idle = editComposer(emptyComposerState(), "first");
  const start = beginComposerSubmission(idle, "start", null, createId);
  assert.deepEqual(start.submission, {
    intent: "start",
    expectedTurnId: null,
    clientUserMessageId: "message-1",
    draftAtSubmit: { text: "first", images: [] },
    text: "first",
    images: [],
    status: "pending",
    error: null,
  });

  const active = beginComposerSubmission(
    editComposer(emptyComposerState(), "guide it"),
    "steer",
    "turn-1",
    createId,
  );
  assert.equal(active.submission?.intent, "steer");
  assert.equal(active.submission?.expectedTurnId, "turn-1");

  const replacement = beginComposerSubmission(
    editComposer(emptyComposerState(), "do this instead"),
    "replace",
    "turn-1",
    createId,
  );
  assert.equal(replacement.submission?.intent, "replace");
  assert.equal("queue" in replacement, false);
  assert.equal(defaultComposerIntent(false), "start");
  assert.equal(defaultComposerIntent(true), "steer");
});

test("a pending request is a click fence, not a local queue", () => {
  const pending = beginComposerSubmission(
    editComposer(emptyComposerState(), "one"),
    "steer",
    "turn-1",
    () => "message-1",
  );
  const second = beginComposerSubmission(
    editComposer(pending, "two"),
    "steer",
    "turn-1",
    () => "message-2",
  );
  assert.equal(second.submission?.clientUserMessageId, "message-1");
  assert.equal(second.submission?.text, "one");
  assert.equal(second.draft.text, "two");
});

test("keeps the draft and stable message id across a transport retry", () => {
  let ids = 0;
  const createId = () => `message-${++ids}`;
  let state = beginComposerSubmission(
    editComposer(emptyComposerState(), "retry me"),
    "steer",
    "turn-1",
    createId,
  );
  state = failComposerSubmission(state, "message-1", "socket closed");
  assert.equal(state.draft.text, "retry me");
  assert.equal(state.submission?.status, "failed");

  state = beginComposerSubmission(state, "steer", "turn-1", createId);
  assert.equal(state.submission?.clientUserMessageId, "message-1");
  assert.equal(ids, 1);
});

test("editing a failed draft creates a new operation id", () => {
  let ids = 0;
  const createId = () => `message-${++ids}`;
  let state = beginComposerSubmission(
    editComposer(emptyComposerState(), "old"),
    "start",
    null,
    createId,
  );
  state = failComposerSubmission(state, "message-1", "offline");
  state = editComposer(state, "new");
  state = beginComposerSubmission(state, "start", null, createId);
  assert.equal(state.submission?.clientUserMessageId, "message-2");
});

test("acceptance clears only the submitted draft and never invents history", () => {
  const createId = () => "message-1";
  let state = beginComposerSubmission(
    editComposer(emptyComposerState(), "submitted"),
    "start",
    null,
    createId,
  );
  state = editComposer(state, "typed while sending");
  state = acceptComposerSubmission(state, "message-1");
  assert.equal(state.draft.text, "typed while sending");
  assert.equal(state.submission, null);
  assert.deepEqual(Object.keys(state).sort(), ["draft", "submission"]);
});

test("ordered images form one draft, removal preserves text, and image-only drafts submit", () => {
  let state = editComposer(emptyComposerState(), "keep this text");
  state = addComposerImages(state, [image("a"), image("b"), image("c")]);
  state = removeComposerImage(state, "b");
  assert.equal(state.draft.text, "keep this text");
  assert.deepEqual(
    state.draft.images.map((entry) => entry.id),
    ["a", "c"],
  );

  const imageOnly = addComposerImages(emptyComposerState(), [image("only")]);
  assert.equal(composerDraftHasContent(imageOnly.draft), true);
  const pending = beginComposerSubmission(
    imageOnly,
    "start",
    null,
    () => "message-image",
  );
  assert.equal(pending.submission?.text, "");
  assert.deepEqual(
    pending.submission?.images.map((entry) => entry.id),
    ["only"],
  );
});

test("running send modes implement the Enter and Cmd/Ctrl+Enter matrix", () => {
  for (const [mode, normal, alternate] of [
    ["batch", "batch-next", "steer"],
    ["queue", "queue", "steer"],
    ["soft", "steer", "batch-next"],
    ["hard", "replace", "batch-next"],
  ] as const) {
    assert.equal(defaultComposerIntent(true, mode), normal);
    assert.equal(defaultComposerIntent(true, mode, true), alternate);
    assert.equal(defaultComposerIntent(false, mode, true), "start");
  }
});
