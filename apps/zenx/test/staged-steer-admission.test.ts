import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../../../src/item.js";
import {
  pendingSteerMessages,
  recoverSteerRecall,
} from "../../../src/steer-recall.js";
import { restoreRecalledComposer } from "../src/renderer/src/steer-recall-state.js";
import {
  acceptComposerSubmission,
  addComposerImages,
  beginComposerSubmission,
  beginImmediateComposerSubmission,
  editComposer,
  emptyComposerState,
  failComposerSubmission,
  failImmediateComposerSubmission,
  reconcileCanonicalAdmission,
} from "../src/renderer/src/composer-state.js";

function staged(clientId: string): CanonicalItem {
  return {
    type: "user_message_queued",
    id: `queued-${clientId}`,
    threadId: "thread",
    createdAt: "2026-11-02T00:00:00Z",
    clientId,
    input: [{ type: "text", text: "Original staged input" }],
    deliveryMode: "steer",
    expectedTurnId: "actual-active-turn",
  };
}

const newerImage = {
  id: "newer-image",
  name: "newer.png",
  attachment: {
    type: "attachment" as const,
    sha256: "a".repeat(64),
    mediaType: "image/png" as const,
    byteLength: 68,
    width: 1,
    height: 1,
  },
};

for (const intent of ["start", "steer"] as const) {
  for (const immediate of [false, true]) {
    for (const order of [
      "event-ack",
      "ack-event",
      "event-loss",
      "loss-event",
      "event-only",
    ] as const) {
      test(`staged ${intent} ${immediate ? "immediate" : "legacy"} ${order} releases only its own submission`, () => {
        const begin = immediate
          ? beginImmediateComposerSubmission
          : beginComposerSubmission;
        const initial = begin(
          editComposer(emptyComposerState(), "Original staged input"),
          intent,
          intent === "start" ? null : "stale-visible-turn",
          () => "old-client",
        );
        let state = addComposerImages(
          editComposer(initial, "Newer independent draft"),
          [newerImage],
        );
        const draft = state.draft;
        const loseAck = () => {
          state = immediate
            ? failImmediateComposerSubmission(
                state,
                "old-client",
                "request outcome unknown",
                true,
              )
            : failComposerSubmission(
                state,
                "old-client",
                "request outcome unknown",
              );
        };
        const event = () => {
          state = reconcileCanonicalAdmission(state, [staged("old-client")]);
        };
        if (order === "ack-event")
          state = acceptComposerSubmission(state, "old-client");
        if (order === "loss-event") loseAck();
        event();
        assert.equal(state.submission, null);
        assert.equal(state.draft, draft);
        assert.equal(state.draft.images[0], newerImage);
        assert.equal(state.pendingSends?.length ?? 0, 0);
        if (order !== "ack-event")
          assert.equal(state.confirmedAdmission?.stage, "queued");
        if (order === "event-ack")
          state = acceptComposerSubmission(state, "old-client");
        if (order === "event-loss") loseAck();
        assert.equal(state.submission, null);
        assert.equal(state.draft, draft);

        const pending = pendingSteerMessages([staged("old-client")]);
        const recall = recoverSteerRecall(
          [
            staged("old-client"),
            {
              type: "user_message_steer_recalled",
              id: "recall-receipt",
              threadId: "thread",
              createdAt: "2026-11-02T00:00:01Z",
              recallId: "recall-old-client",
              targets: pending.map((item) => ({
                queuedItemId: item.id,
                clientId: item.clientId,
                expectedRevision: item.revision,
              })),
            },
          ],
          "thread",
          "recall-old-client",
        );
        assert.ok(recall);
        state = restoreRecalledComposer(state, recall, () => "restored-image");
        assert.equal(
          state.draft.text,
          "Original staged input\n\nNewer independent draft",
        );
        assert.equal(state.draft.images[0], newerImage);
        assert.equal(acceptComposerSubmission(state, "old-client"), state);
        assert.equal(
          failComposerSubmission(state, "old-client", "outcome unknown"),
          state,
        );
        assert.equal(
          failImmediateComposerSubmission(
            state,
            "old-client",
            "outcome unknown",
            true,
          ),
          state,
        );
        assert.equal(state.pendingSends?.length ?? 0, 0);

        const next = beginImmediateComposerSubmission(
          state,
          "steer",
          "actual-active-turn",
          () => "new-client",
        );
        assert.equal(next.submission?.clientUserMessageId, "new-client");
        assert.equal(next.submission?.status, "pending");
        assert.equal(
          failImmediateComposerSubmission(
            next,
            "old-client",
            "Late failure of the old RPC",
            true,
          ),
          next,
        );
        assert.equal(acceptComposerSubmission(next, "old-client"), next);
        assert.equal(
          reconcileCanonicalAdmission(next, [staged("old-client")]),
          next,
        );
        assert.equal(next.pendingSends?.length, 1);
        assert.equal(next.pendingSends?.[0]?.clientId, "new-client");
      });
    }
  }

  test(`staged ${intent} rejects wrong clients and ordinary next-turn queues`, () => {
    const state = beginImmediateComposerSubmission(
      editComposer(emptyComposerState(), "Original staged input"),
      intent,
      intent === "start" ? null : "visible-turn",
      () => "expected-client",
    );
    assert.equal(
      reconcileCanonicalAdmission(state, [staged("wrong-client")]),
      state,
    );
    const item = staged("expected-client");
    assert.equal(item.type, "user_message_queued");
    if (item.type !== "user_message_queued") throw Error("queue expected");
    const { deliveryMode: _mode, expectedTurnId: _turn, ...ordinary } = item;
    const notConfirmed = reconcileCanonicalAdmission(state, [ordinary]);
    assert.equal(notConfirmed, state);
    assert.equal(notConfirmed.submission, state.submission);
    assert.equal(notConfirmed.confirmedAdmission, undefined);
    assert.equal(
      reconcileCanonicalAdmission(state, []).submission,
      state.submission,
    );
  });
}

for (const intent of ["replace", "batch-next"] as const) {
  test(`staged evidence does not admit ${intent}`, () => {
    const state = beginComposerSubmission(
      editComposer(emptyComposerState(), "Original staged input"),
      intent,
      "visible-turn",
      () => "client",
    );
    assert.equal(reconcileCanonicalAdmission(state, [staged("client")]), state);
  });
}
