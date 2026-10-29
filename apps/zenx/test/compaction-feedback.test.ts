import assert from "node:assert/strict";
import test from "node:test";
import type { ContextCompactionStatusEvent } from "../../../src/app-server.js";
import type { CanonicalItem } from "../../../src/item.js";
import {
  applyCompactionStatus,
  markCompactionOutcomeUnknown,
} from "../src/renderer/src/compaction-feedback.js";
import {
  emptyComposerState,
  reconcileCanonicalAdmission,
} from "../src/renderer/src/composer-state.js";
import { i18n } from "../src/renderer/src/i18n.js";

const event: ContextCompactionStatusEvent = {
  type: "context_compaction_status",
  threadId: "synthetic-thread",
  operationId: "operation-1",
  initiator: "automatic",
  coveredThroughItemId: "completed-boundary",
  phase: "pending",
  trigger: {
    reason: "next_turn_estimate",
    estimatedInputTokens: 810,
    thresholdTokens: 800,
  },
  contextWindow: 1_000,
  triggerPercent: 80,
  targetPercent: 80,
  agenticEnabled: false,
};

test("native compaction feedback distinguishes pending, known failure, unknown and canonical success", async () => {
  await i18n.changeLanguage("en");
  const initial = emptyComposerState();
  const pending = applyCompactionStatus(initial, event);
  assert.equal(pending.compaction?.status, "pending");
  assert.match(
    pending.compaction!.message,
    /Automatically compacting context.*Next-turn context estimate/u,
  );
  assert.match(pending.compaction!.detail!, /"contextWindow": 1000/u);
  assert.match(pending.compaction!.detail!, /"estimatedInputTokens": 810/u);
  assert.equal(applyCompactionStatus(pending, event), pending);
  const unknown = markCompactionOutcomeUnknown(pending);
  assert.match(unknown.compaction!.message, /unknown; no automatic retry/u);
  assert.equal(unknown.submission, initial.submission);
  assert.equal(unknown.draft, initial.draft);
  const failure = applyCompactionStatus(pending, {
    ...event,
    phase: "failed",
    error: { name: "Error", message: "<script>synthetic failure</script>" },
  });
  assert.match(
    failure.compaction!.message,
    /failed; no replacement committed/u,
  );
  assert.match(
    failure.compaction!.detail!,
    /<script>synthetic failure<\/script>/u,
  );
  assert.match(
    applyCompactionStatus(pending, { ...event, phase: "cancelled" }).compaction!
      .message,
    /cancelled; no replacement committed/u,
  );
  assert.match(
    applyCompactionStatus(pending, { ...event, phase: "unknown" }).compaction!
      .message,
    /outcome is unknown/u,
  );
  const committed = applyCompactionStatus(pending, {
    ...event,
    phase: "committed",
    compactionItemId: "actual-selection",
  });
  assert.equal(committed.compaction?.status, "succeeded");
  assert.equal(committed.compaction?.detail, undefined);
  assert.equal(
    reconcileCanonicalAdmission(unknown, [
      {
        type: "context_compaction",
        coveredThroughItemId: "different",
      } as CanonicalItem,
    ]),
    unknown,
  );
  assert.equal(
    reconcileCanonicalAdmission(unknown, [
      {
        type: "context_compaction",
        coveredThroughItemId: "completed-boundary",
      } as CanonicalItem,
    ]).compaction,
    undefined,
  );
});

test("an earlier operation cannot overwrite a newer pending compaction", () => {
  const pending = applyCompactionStatus(emptyComposerState(), {
    ...event,
    operationId: "new-operation",
  });
  for (const phase of ["committed", "failed", "cancelled", "unknown"] as const)
    assert.equal(applyCompactionStatus(pending, { ...event, phase }), pending);
});

test("Chinese automatic compaction names its real cause rather than claiming agent work", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    const pending = applyCompactionStatus(emptyComposerState(), event);
    assert.match(
      pending.compaction!.message,
      /正在自动压缩上下文.*下一轮上下文估算达到阈值/u,
    );
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("exact native epoch and watermark prevent delayed starts or ends from replacing current feedback", () => {
  const current = applyCompactionStatus(
    emptyComposerState(),
    { ...event, operationId: "new" },
    { processEpoch: "epoch", watermark: 10 },
  );
  assert.equal(
    applyCompactionStatus(current, event, {
      processEpoch: "epoch",
      watermark: 9,
    }),
    current,
  );
  assert.equal(
    applyCompactionStatus(current, event, {
      processEpoch: "old-epoch",
      watermark: 11,
    }),
    current,
  );
  const retired = markCompactionOutcomeUnknown(current);
  assert.equal(retired.compactionObservation, undefined);
  assert.equal(
    applyCompactionStatus(
      retired,
      { ...event, operationId: "after-reconnect" },
      { processEpoch: "new-epoch", watermark: 1 },
    ).compaction?.status,
    "pending",
  );
});
