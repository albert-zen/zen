import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "../src/main/app-server-manager.js";
import {
  addApprovalRequest,
  markApprovalResponding,
  pendingApprovalThreadIds,
  resolveApproval,
  restoreApprovalPending,
} from "../src/renderer/src/approval-state.js";

test("keeps approval interaction transient and resolves the same card", () => {
  const request: ApprovalRequestEvent = {
    requestId: "approval_1",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 10,
      environmentId: null,
      reason: null,
      command: "printf zenx",
      cwd: "/workspace",
      commandActions: [],
      proposedExecpolicyAmendment: null,
      networkApprovalContext: null,
      proposedNetworkPolicyAmendments: null,
    },
  };
  const pending = addApprovalRequest([], request);
  assert.deepEqual([...pendingApprovalThreadIds(pending)], ["thread-1"]);
  const responding = markApprovalResponding(
    pending,
    request.requestId,
    "accept",
  );
  assert.equal(responding[0]?.status, "responding");
  assert.equal(responding[0]?.decision, "accept");

  const restored = restoreApprovalPending(responding, request.requestId);
  assert.equal(restored[0]?.status, "pending");
  const resolvedEvent: ApprovalResolvedEvent = {
    requestId: request.requestId,
    threadId: request.params.threadId,
    decision: "decline",
  };
  const resolved = resolveApproval(restored, resolvedEvent);
  assert.equal(resolved[0]?.status, "resolved");
  assert.equal(resolved[0]?.decision, "decline");
  assert.equal(pendingApprovalThreadIds(resolved).size, 0);
});
