import assert from "node:assert/strict";
import test from "node:test";
import {
  applyNativeThreadEvent,
  markThreadViewAwaitingRecovery,
  projectNativeRecovery,
} from "../src/renderer/src/thread-view-state.js";
import {
  projectRecoverySnapshot,
  recoveryScenario,
  recoveryScenarioSnapshot,
  syntheticRecovery,
} from "./fixtures/loop-recovery-scenario.js";

const recovery = {
  failureItemId: syntheticRecovery.id,
  attempt: 1,
  sampleAttempt: 2,
  phase: "model" as const,
};

test("only explicit current recovery events drive the live indicator", () => {
  let thread = projectRecoverySnapshot(recoveryScenarioSnapshot("recovering"));
  assert.equal(thread.turns[0]?.liveRecovery, undefined);
  const event = {
    type: "turn_recovery" as const,
    threadId: thread.id,
    turnId: thread.turns[0]!.id,
    recovery,
  };
  thread = applyNativeThreadEvent(thread, event);
  assert.deepEqual(thread.turns[0]?.liveRecovery, recovery);
  assert.equal(
    markThreadViewAwaitingRecovery(thread).turns[0]?.liveRecovery,
    null,
  );
  thread = applyNativeThreadEvent(thread, { ...event, recovery: null });
  assert.equal(thread.turns[0]?.liveRecovery, null);
  thread = applyNativeThreadEvent(thread, {
    type: "item_completed",
    item: syntheticRecovery,
  });
  assert.equal(
    thread.turns[0]?.liveRecovery,
    null,
    "historical diagnostic replay cannot reactivate recovery",
  );
});

for (const phase of ["completed", "stopped", "failed"] as const) {
  test(`late recovery observation cannot reactivate ${phase} Turn`, () => {
    const thread = recoveryScenario(phase, "reload");
    const result = applyNativeThreadEvent(thread, {
      type: "turn_recovery",
      threadId: thread.id,
      turnId: thread.turns[0]!.id,
      recovery,
    });
    assert.equal(result.turns[0]?.liveRecovery, undefined);
  });
}

test("native resume applies current-epoch recovery and ignores other epochs", () => {
  const thread = recoveryScenarioSnapshot("recovering");
  const snapshot = {
    processEpoch: "current",
    threadId: thread.id,
    watermark: 2,
    thread,
    events: [
      {
        processEpoch: "current",
        threadId: thread.id,
        watermark: 1,
        event: {
          type: "turn_recovery" as const,
          threadId: thread.id,
          turnId: thread.turns[0]!.id,
          recovery,
        },
      },
    ],
  };
  assert.deepEqual(
    projectNativeRecovery(snapshot).turns[0]?.liveRecovery,
    recovery,
  );
  assert.equal(
    projectNativeRecovery({ ...snapshot, processEpoch: "new" }).turns[0]
      ?.liveRecovery,
    undefined,
  );
  assert.equal(
    projectNativeRecovery({
      ...snapshot,
      events: [
        ...snapshot.events,
        {
          ...snapshot.events[0]!,
          watermark: 2,
          event: { ...snapshot.events[0]!.event, recovery: null },
        },
      ],
    }).turns[0]?.liveRecovery,
    null,
  );
});
