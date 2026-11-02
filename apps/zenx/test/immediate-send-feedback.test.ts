import {
  parseSkillDraft,
  withSkillDraft,
} from "../src/renderer/src/skill-draft.js";
import {
  referenceMessage,
  parseSentReferenceContent,
} from "../src/renderer/src/reference-draft.js";
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
  type: "user_message",
  id: `item-${clientId}`,
  clientId,
  threadId: "thread",
  turnId: "turn",
  createdAt: "2026-01-01T00:00:00.000Z",
  text: "synthetic",
});
const begin = () =>
  beginImmediateComposerSubmission(
    addComposerImages(editComposer(emptyComposerState(), "Original"), [
      image("first"),
    ]),
    "start",
    null,
    () => "client-one",
  );

test("immediate send clears draft but keeps exact text/images and pending admission guard", () => {
  const pending = begin();
  assert.deepEqual(pending.draft, { text: "", images: [] });
  assert.equal(pending.pendingSends?.[0]?.status, "sending");
  assert.equal(pending.pendingSends?.[0]?.draft.text, "Original");
  assert.deepEqual(pending.pendingSends?.[0]?.draft.images, [image("first")]);
  const typing = addComposerImages(editComposer(pending, "Newer"), [
    image("newer"),
  ]);
  assert.equal(
    beginImmediateComposerSubmission(
      typing,
      "start",
      null,
      () => "must-not-create",
    ),
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
  assert.equal(
    reconcileCanonicalAdmission(accepted, [message("other")]),
    accepted,
  );
  const projected = reconcileCanonicalAdmission(accepted, [
    message("client-one"),
  ]);
  assert.equal(projected.pendingSends?.length, 0);
  assert.equal(projected.draft.text, "Newer");
});

test("canonical-before-ACK suppresses duplicate row and late transport failure cannot resurrect it", () => {
  const projected = reconcileCanonicalAdmission(begin(), [
    message("client-one"),
  ]);
  assert.equal(projected.pendingSends?.length, 0);
  assert.equal(projected.submission, null);
  assert.equal(acceptComposerSubmission(projected, "client-one"), projected);
  assert.equal(
    failImmediateComposerSubmission(
      projected,
      "client-one",
      "IPC closed",
      true,
    ),
    projected,
  );
});

test("post-dispatch errors remain unconfirmed and never auto-restore or resend", () => {
  const pending = begin();
  const unknown = failImmediateComposerSubmission(
    pending,
    "client-one",
    "generic IPC failure",
    true,
  );
  assert.equal(unknown.pendingSends?.[0]?.status, "unconfirmed");
  assert.equal(unknown.draft.text, "");
  assert.equal(reconcileCanonicalAdmission(unknown, []), unknown);
  assert.equal(
    reconcileCanonicalAdmission(unknown, [message("client-one")]).pendingSends
      ?.length,
    0,
  );
  const recovered = recoverPendingSend(unknown, "client-one");
  assert.equal(recovered.draft.text, "Original");
  assert.deepEqual(recovered.draft.images, [image("first")]);
  assert.equal(recoverPendingSend(recovered, "client-one"), recovered);
  const explicitRetry = beginImmediateComposerSubmission(
    recovered,
    "start",
    null,
    () => "unused",
  );
  assert.equal(explicitRetry.submission?.clientUserMessageId, "client-one");
  assert.equal(explicitRetry.pendingSends?.length, 1);
});

test("explicit recovery merges newer text and attachments without clobbering them", () => {
  const edited = addComposerImages(editComposer(begin(), "Newer"), [
    image("newer"),
  ]);
  const unknown = failImmediateComposerSubmission(
    edited,
    "client-one",
    "IPC closed",
    true,
  );
  const recovered = recoverPendingSend(unknown, "client-one");
  assert.equal(recovered.draft.text, "Newer\n\nOriginal");
  assert.deepEqual(
    recovered.draft.images.map((entry) => entry.id),
    ["newer", "first"],
  );
  const dismissed = dismissPendingSend(recovered, "client-one");
  assert.equal(dismissed.pendingSends?.length, 0);
  assert.equal(dismissed.draft.text, recovered.draft.text);
  const newSend = beginImmediateComposerSubmission(
    dismissed,
    "start",
    null,
    () => "new-content-id",
  );
  assert.equal(newSend.submission?.clientUserMessageId, "new-content-id");
});

test("known pre-dispatch failure restores only its unchanged blank draft", () => {
  const restored = failImmediateComposerSubmission(
    begin(),
    "client-one",
    "archived before dispatch",
    false,
  );
  assert.equal(restored.draft.text, "Original");
  assert.equal(restored.pendingSends?.[0]?.status, "notSent");
  const newer = editComposer(begin(), "Keep this");
  const failed = failImmediateComposerSubmission(
    newer,
    "client-one",
    "archived before dispatch",
    false,
  );
  assert.equal(failed.draft.text, "Keep this");
  assert.equal(failed.pendingSends?.[0]?.recovered, undefined);
});

test("multiple admitted sends reconcile separately and a late old event cannot clear a new submission", () => {
  const first = acceptComposerSubmission(begin(), "client-one");
  const second = beginImmediateComposerSubmission(
    editComposer(first, "Second"),
    "steer",
    "turn",
    () => "client-two",
  );
  assert.equal(second.pendingSends?.length, 2);
  const oldEvent = reconcileCanonicalAdmission(second, [message("client-one")]);
  assert.equal(oldEvent.pendingSends?.length, 1);
  assert.equal(oldEvent.submission?.clientUserMessageId, "client-two");
  assert.equal(oldEvent.pendingSends?.[0]?.clientId, "client-two");
});

test("legacy new-thread and side-chat admission retains its previous draft contract", () => {
  const legacy = beginComposerSubmission(
    editComposer(emptyComposerState(), "Legacy"),
    "start",
    null,
    () => "legacy",
  );
  assert.equal(legacy.draft.text, "Legacy");
  assert.equal(legacy.pendingSends, undefined);
});

test("recovery merges plain newer text with original references without exposing a second header", () => {
  const original = withSkillDraft(
    "Original question",
    [],
    [
      {
        kind: "file",
        name: "original.ts",
        cwd: "/synthetic",
        path: "original.ts",
      },
    ],
  );
  const pending = beginImmediateComposerSubmission(
    editComposer(emptyComposerState(), original),
    "start",
    null,
    () => "ref-original",
  );
  const failed = failImmediateComposerSubmission(
    editComposer(pending, "Newer text"),
    "ref-original",
    "IPC closed",
    true,
  );
  const recovered = recoverPendingSend(failed, "ref-original");
  const decoded = parseSkillDraft(recovered.draft.text);
  assert.equal(decoded.references.length, 1);
  assert.equal(decoded.references[0]?.name, "original.ts");
  assert.match(decoded.text, /^Newer text\n\nOriginal question/);
  assert.equal(decoded.text.charAt(decoded.references[0]!.position!), "\uFFFC");
  assert.doesNotMatch(decoded.text, /\[zenx-references:/);
});

test("recovery preserves both drafts' positioned references, UTF-16 offsets, skills and images", () => {
  const newerText = "😀 newer \uFFFC";
  const oldText = "Old \uFFFC";
  const newerSkill = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "new_skill",
  };
  const oldSkill = {
    id: "22222222-2222-2222-2222-222222222222",
    name: "old_skill",
  };
  const original = withSkillDraft(
    oldText,
    [oldSkill],
    [
      {
        kind: "file",
        name: "old.ts",
        cwd: "/synthetic",
        path: "old.ts",
        position: oldText.indexOf("\uFFFC"),
      },
    ],
  );
  const newer = withSkillDraft(
    newerText,
    [newerSkill],
    [
      {
        kind: "file",
        name: "new.ts",
        cwd: "/synthetic",
        path: "new.ts",
        position: newerText.indexOf("\uFFFC"),
      },
    ],
  );
  const pending = beginImmediateComposerSubmission(
    addComposerImages(editComposer(emptyComposerState(), original), [
      image("old-image"),
    ]),
    "start",
    null,
    () => "structured-original",
  );
  const edited = addComposerImages(editComposer(pending, newer), [
    image("new-image"),
  ]);
  const failed = failImmediateComposerSubmission(
    edited,
    "structured-original",
    "IPC closed",
    true,
  );
  const recovered = recoverPendingSend(failed, "structured-original");
  const decoded = parseSkillDraft(recovered.draft.text);
  assert.deepEqual(decoded.skills, [newerSkill, oldSkill]);
  assert.deepEqual(
    decoded.references.map((ref) => ref.name),
    ["new.ts", "old.ts"],
  );
  assert.equal(decoded.references[0]?.position, newerText.indexOf("\uFFFC"));
  assert.equal(
    decoded.references[1]?.position,
    newerText.length + 2 + oldText.indexOf("\uFFFC"),
  );
  for (const reference of decoded.references)
    assert.equal(decoded.text.charAt(reference.position!), "\uFFFC");
  assert.equal(
    [...decoded.text].filter((char) => char === "\uFFFC").length,
    decoded.references.length,
  );
  assert.deepEqual(
    recovered.draft.images.map((entry) => entry.id),
    ["new-image", "old-image"],
  );
  assert.doesNotMatch(decoded.text, /\[zenx-references:/);
  const sent = referenceMessage(
    decoded.text,
    decoded.references,
    "merged-new-id",
  );
  assert.equal(
    parseSentReferenceContent(sent, "merged-new-id").references.length,
    2,
  );
  const next = beginImmediateComposerSubmission(
    recovered,
    "start",
    null,
    () => "merged-new-id",
  );
  assert.equal(next.submission?.clientUserMessageId, "merged-new-id");
});
