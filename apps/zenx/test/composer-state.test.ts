import assert from "node:assert/strict";
import test from "node:test";

import {
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
