import type {
  AppServerEvent,
  ThreadSnapshot,
} from "../../../../src/app-server.js";
import type { CanonicalItem, FailureItem } from "../../../../src/item.js";
import type { Thread } from "../../src/protocol-client/index.js";
import {
  applyNativeThreadEvent,
  projectNativeRecovery,
} from "../../src/renderer/src/thread-view-state.js";

export const recoveryPhases = [
  "running",
  "recovering",
  "continuing",
  "completed",
  "failed",
  "stopped",
] as const;
export type RecoveryPhase = (typeof recoveryPhases)[number];
const threadId = "synthetic-loop-recovery";
const turnId = "synthetic-turn";
const base = { threadId, turnId, createdAt: "2026-10-15T12:00:00.000Z" };
const selection = {
  providerProfileId: "synthetic",
  modelId: "synthetic",
  reasoningEffort: null,
};
const metadata: CanonicalItem = {
  id: "metadata",
  type: "thread_metadata",
  threadId,
  createdAt: base.createdAt,
  ...selection,
  cwd: "/synthetic",
  sandbox: "danger-full-access",
  approvalPolicy: "never",
};
const started: CanonicalItem = {
  ...base,
  id: "turn-start",
  type: "turn_started",
  selection,
};
const user: CanonicalItem = {
  ...base,
  id: "user-input",
  type: "user_message",
  content: [
    { type: "text", text: "把合成检查结果保存一次，再告诉我完成情况。" },
  ],
};
const call: CanonicalItem = {
  ...base,
  id: "tool-call",
  type: "tool_call",
  callId: "write-call",
  modelResponseId: "first-sample",
  name: "write_once",
  arguments: { target: "synthetic-check.txt" },
};
const receipt: CanonicalItem = {
  ...base,
  id: "tool-result",
  type: "tool_result",
  callId: "write-call",
  output: "Synthetic write receipt: saved once; execution count = 1.",
  exitCode: 0,
  executionStatus: "completed",
};
export const syntheticRecovery: FailureItem = {
  ...base,
  id: "recovery-1",
  type: "failure",
  code: "loop_recovery",
  message:
    "The model transport failed unexpectedly. Review the canonical progress and continue without replaying completed operations.",
  recovery: {
    attempt: 1,
    sampleAttempt: 2,
    phase: "model",
    sampleId: "failed-sample",
    contextBoundaryItemId: receipt.id,
    progressItemId: receipt.id,
    fingerprint: "synthetic-transport",
    consecutiveFailures: 1,
    withheldMedia: [],
  },
};
const answer: CanonicalItem = {
  ...base,
  id: "final-answer",
  type: "agent_message",
  text: "合成检查结果已保存。恢复后沿用原有保存回执，没有重复执行保存操作。",
};
const terminalFailure: FailureItem = {
  ...base,
  id: "final-failure",
  type: "failure",
  code: "runtime_error",
  message:
    "Synthetic model transport remained unavailable after the bounded recovery budget.",
  retried: 2,
};
const completion: CanonicalItem = {
  ...base,
  id: "turn-done",
  type: "turn_completed",
  status: "completed",
};
const failedCompletion: CanonicalItem = {
  ...base,
  id: "turn-failed",
  type: "turn_completed",
  status: "failed",
};
const stopped: CanonicalItem = {
  ...base,
  id: "turn-stopped",
  type: "turn_aborted",
  reason: "Synthetic explicit user stop",
};

export function recoveryScenarioSnapshot(phase: RecoveryPhase): ThreadSnapshot {
  const items: CanonicalItem[] = [metadata, started, user, call];
  if (phase !== "running") items.push(receipt, syntheticRecovery);
  if (phase === "completed") items.push(answer, completion);
  if (phase === "failed") items.push(terminalFailure, failedCompletion);
  if (phase === "stopped") items.push(stopped);
  return {
    id: threadId,
    ...selection,
    model: "synthetic",
    provider: "synthetic",
    cwd: "/synthetic",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    archived: false,
    name: "同一轮自动恢复 · 合成场景",
    items,
    turns: [
      {
        id: turnId,
        items: items.filter((item) => item.turnId === turnId),
        selection,
        model: "synthetic",
        status:
          phase === "completed"
            ? "completed"
            : phase === "failed"
              ? "failed"
              : phase === "stopped"
                ? "interrupted"
                : "inProgress",
      },
    ],
  };
}

const recoveryEvent: Extract<AppServerEvent, { type: "turn_recovery" }> = {
  type: "turn_recovery",
  threadId,
  turnId,
  recovery: {
    failureItemId: syntheticRecovery.id,
    attempt: 1,
    sampleAttempt: 2,
    phase: "model",
  },
};

export function projectRecoverySnapshot(
  snapshot: ThreadSnapshot,
  liveRecovery = false,
): Thread {
  return projectNativeRecovery({
    processEpoch: "synthetic-host",
    threadId: snapshot.id,
    watermark: liveRecovery ? 1 : 0,
    events: liveRecovery
      ? [
          {
            processEpoch: "synthetic-host",
            threadId: snapshot.id,
            watermark: 1,
            event: recoveryEvent,
          },
        ]
      : [],
    thread: snapshot,
  });
}

export function recoveryScenario(
  phase: RecoveryPhase,
  mode: "live" | "reload" = "live",
): Thread {
  if (mode === "reload")
    return projectRecoverySnapshot(
      recoveryScenarioSnapshot(phase),
      phase === "recovering",
    );
  let view = projectRecoverySnapshot(recoveryScenarioSnapshot("running"));
  const apply = (event: AppServerEvent) => {
    view = applyNativeThreadEvent(
      view,
      event,
      Date.parse(base.createdAt) / 1000 + 2,
    );
  };
  if (phase === "running") return view;
  apply({ type: "item_completed", item: receipt });
  apply({ type: "item_completed", item: syntheticRecovery });
  apply(recoveryEvent);
  if (phase !== "recovering") apply({ ...recoveryEvent, recovery: null });
  if (phase === "continuing" || phase === "completed") {
    apply({
      type: "item_started",
      threadId,
      turnId,
      itemId: answer.id,
      itemType: "agent_message",
    });
    apply({
      type: "item_delta",
      threadId,
      turnId,
      itemId: answer.id,
      delta: "合成检查结果已保存。恢复后沿用原有保存回执",
    });
  }
  if (phase === "completed") {
    apply({ type: "item_completed", item: answer });
    apply({ type: "turn_completed", threadId, turnId, status: "completed" });
  }
  if (phase === "failed") {
    apply({ type: "item_completed", item: terminalFailure });
    apply({ type: "turn_completed", threadId, turnId, status: "failed" });
  }
  if (phase === "stopped")
    apply({ type: "turn_completed", threadId, turnId, status: "interrupted" });
  return view;
}
