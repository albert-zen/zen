import assert from "node:assert/strict";
import test from "node:test";
import type { UserMessageItem } from "../../../src/item.js";
import {
  acceptComposerSubmission,
  addComposerImages,
  beginComposerSubmission,
  beginImmediateComposerSubmission,
  dismissPendingSend,
  editComposer,
  emptyComposerState,
  failImmediateComposerSubmission,
  reconcileCanonicalAdmission,
  recoverPendingSend,
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
const message = (clientId: string): UserMessageItem => ({
  type: "user_message", id: `item-${clientId}`, clientId,
  threadId: "thread", turnId: "turn",
  createdAt: "2026-01-01T00:00:00.000Z", text: "synthetic",
});
const begin = () => beginImmediateComposerSubmission(
  addComposerImages(editComposer(emptyComposerState(), "Original"), [image("first")]),
  "start", null, () => "client-one",
);

test("immediate send clears draft but keeps exact text/images and pending admission guard", () => {
  const pending = begin();
  assert.deepEqual(pending.draft, { text: "", images: [] });
  assert.equal(pending.pendingSends?.[0]?.status, "sending");
  assert.equal(pending.pendingSends?.[0]?.draft.text, "Original");
  assert.deepEqual(pending.pendingSends?.[0]?.draft.images, [image("first")]);
  const typing = addComposerImages(editComposer(pending, "Newer"), [image("newer")]);
  assert.equal(
    beginImmediateComposerSubmission(typing, "start", null, () => "must-not-create"),
    typing,
  );
  assert.equal(typing.draft.text, "Newer");
  assert.equal(pending.submission?.clientUserMessageId, "client-one");
});

test("ACK retains local presentation until exact canonical ID and preserves newer draft", () => {
  const pending = editComposer(begin(), "Newer");
  const accepted = acceptComposerSubmission(pending, "client-one");
  assert.equal(accepted.draft.text, "Newer");
  assert.equal(accepted.submission, null);
  assert.equal(accepted.pendingSends?.[0]?.status, "admitted");
  assert.equal(reconcileCanonicalAdmission(accepted, [message("other")]), accepted);
  const projected = reconcileCanonicalAdmission(accepted, [message("client-one")]);
  assert.equal(projected.pendingSends?.length, 0);
  assert.equal(projected.draft.text, "Newer");
});

test("canonical-before-ACK suppresses duplicate row and late transport failure cannot resurrect it", () => {
  const projected = reconcileCanonicalAdmission(begin(), [message("client-one")]);
  assert.equal(projected.pendingSends?.length, 0);
  assert.equal(projected.submission, null);
  assert.equal(acceptComposerSubmission(projected, "client-one"), projected);
  assert.equal(failImmediateComposerSubmission(projected, "client-one", "IPC closed", true), projected);
});

test("post-dispatch errors remain unconfirmed and never auto-restore or resend", () => {
  const pending = begin();
  const unknown = failImmediateComposerSubmission(pending, "client-one", "generic IPC failure", true);
  assert.equal(unknown.pendingSends?.[0]?.status, "unconfirmed");
  assert.equal(unknown.draft.text, "");
  assert.equal(reconcileCanonicalAdmission(unknown, []), unknown);
  assert.equal(reconcileCanonicalAdmission(unknown, [message("client-one")]).pendingSends?.length, 0);
  const recovered = recoverPendingSend(unknown, "client-one");
  assert.equal(recovered.draft.text, "Original");
  assert.deepEqual(recovered.draft.images, [image("first")]);
  assert.equal(recoverPendingSend(recovered, "client-one"), recovered);
  const explicitRetry = beginImmediateComposerSubmission(recovered, "start", null, () => "unused");
  assert.equal(explicitRetry.submission?.clientUserMessageId, "client-one");
  assert.equal(explicitRetry.pendingSends?.length, 1);
});

test("explicit recovery merges newer text and attachments without clobbering them", () => {
  const edited = addComposerImages(editComposer(begin(), "Newer"), [image("newer")]);
  const unknown = failImmediateComposerSubmission(edited, "client-one", "IPC closed", true);
  const recovered = recoverPendingSend(unknown, "client-one");
  assert.equal(recovered.draft.text, "Newer\n\nOriginal");
  assert.deepEqual(recovered.draft.images.map((entry) => entry.id), ["newer", "first"]);
  const dismissed = dismissPendingSend(recovered, "client-one");
  assert.equal(dismissed.pendingSends?.length, 0);
  assert.equal(dismissed.draft.text, recovered.draft.text);
  const newSend = beginImmediateComposerSubmission(dismissed, "start", null, () => "new-content-id");
  assert.equal(newSend.submission?.clientUserMessageId, "new-content-id");
});

test("known pre-dispatch failure restores only its unchanged blank draft", () => {
  const restored = failImmediateComposerSubmission(begin(), "client-one", "archived before dispatch", false);
  assert.equal(restored.draft.text, "Original");
  assert.equal(restored.pendingSends?.[0]?.status, "notSent");
  const newer = editComposer(begin(), "Keep this");
  const failed = failImmediateComposerSubmission(newer, "client-one", "archived before dispatch", false);
  assert.equal(failed.draft.text, "Keep this");
  assert.equal(failed.pendingSends?.[0]?.recovered, undefined);
});

test("multiple admitted sends reconcile separately and a late old event cannot clear a new submission", () => {
  const first = acceptComposerSubmission(begin(), "client-one");
  const second = beginImmediateComposerSubmission(editComposer(first, "Second"), "steer", "turn", () => "client-two");
  assert.equal(second.pendingSends?.length, 2);
  const oldEvent = reconcileCanonicalAdmission(second, [message("client-one")]);
  assert.equal(oldEvent.pendingSends?.length, 1);
  assert.equal(oldEvent.submission?.clientUserMessageId, "client-two");
  assert.equal(oldEvent.pendingSends?.[0]?.clientId, "client-two");
});

test("legacy new-thread and side-chat admission retains its previous draft contract", () => {
  const legacy = beginComposerSubmission(editComposer(emptyComposerState(), "Legacy"), "start", null, () => "legacy");
  assert.equal(legacy.draft.text, "Legacy");
  assert.equal(legacy.pendingSends, undefined);
});
