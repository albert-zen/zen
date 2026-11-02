import assert from "node:assert/strict";
import test from "node:test";

import type { ToolResultItem } from "../../../src/item.js";
import {
  applyNativeThreadEvent,
  projectNativeRecovery,
} from "../src/renderer/src/thread-view-state.js";
import {
  runtimeCommand,
  runtimeMessage,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";
import { nativeRecoveryForThread } from "./native-recovery-fixture.js";

function result(
  callId: string,
  overrides: Partial<ToolResultItem> = {},
): ToolResultItem {
  return {
    type: "tool_result",
    id: `result-${callId}`,
    threadId: "runtime-thread",
    turnId: "runtime-turn",
    createdAt: "2026-10-30T00:00:00.000Z",
    callId,
    output: "Canonical result",
    exitCode: 0,
    ...overrides,
  };
}

function complete(
  thread: ReturnType<typeof runtimeThread>,
  item: ToolResultItem,
) {
  return applyNativeThreadEvent(thread, { type: "item_completed", item });
}

test("native tool result reuses 5000 unrelated Turns and their item arrays", () => {
  const base = runtimeThread([
    runtimeMessage("active-message", "Keep this message"),
    {
      ...runtimeCommand("active-tool", "echo synthetic", "inProgress"),
      callId: "active-call",
    },
    {
      ...runtimeCommand("other-tool", "echo other", "inProgress"),
      callId: "other-call",
    },
  ]);
  const active = base.turns[0]!;
  const historical = Array.from({ length: 5000 }, (_, index) => ({
    ...active,
    id: `history-${index}`,
    status: "completed" as const,
    completedAt: 1,
    durationMs: 1000,
    items: [
      runtimeMessage(`history-message-${index}`, "Synthetic history"),
      {
        ...runtimeCommand(`history-tool-${index}`),
        callId: `history-call-${index}`,
      },
    ],
  }));
  const current = { ...base, turns: [...historical, active] };
  const receipt = result("active-call", {
    contentType: "application/json",
    structuredContent: { nested: { value: "Fresh result" } },
  });
  const next = complete(current, receipt);
  assert.notEqual(next.turns, current.turns);
  assert.equal(
    next.turns.filter((turn, index) => turn !== current.turns[index]).length,
    1,
    "one result changes exactly one Turn, not the whole transcript",
  );
  for (let index = 0; index < historical.length; index++) {
    assert.ok(
      next.turns[index] === historical[index],
      "unrelated Turn is reused",
    );
    assert.ok(
      next.turns[index]!.items === historical[index]!.items,
      "unrelated item array is reused",
    );
  }
  const updated = next.turns.at(-1)!;
  assert.notEqual(updated, active);
  assert.notEqual(updated.items, active.items);
  assert.equal(updated.items[0], active.items[0]);
  assert.equal(updated.items[2], active.items[2]);
  const command = updated.items[1]!;
  assert.ok(command.type === "commandExecution");
  assert.equal(command.status, "completed");
  assert.equal(command.aggregatedOutput, receipt.output);
  assert.deepEqual(command.structuredContent, receipt.structuredContent);
  assert.notEqual(command.structuredContent, receipt.structuredContent);
  assert.deepEqual(next.canonicalItems, [receipt]);
  assert.equal(
    active.items[1]!.type === "commandExecution" && active.items[1].status,
    "inProgress",
  );

  const backfill = complete(
    next,
    result("history-call-0", {
      id: "late-history-result",
      turnId: "history-0",
      output: "Late canonical output",
    }),
  );
  assert.equal(
    backfill.turns.filter((turn, index) => turn !== next.turns[index]).length,
    1,
  );
  assert.notEqual(backfill.turns[0], next.turns[0]);
  assert.equal(backfill.turns.at(-1), updated);
  const oldCommand = backfill.turns[0]!.items[1]!;
  assert.ok(oldCommand.type === "commandExecution");
  assert.equal(oldCommand.aggregatedOutput, "Late canonical output");
});

test("unmatched results preserve presentation identity without dropping canonical facts", () => {
  const current = runtimeThread([
    runtimeMessage("message", "Keep this message"),
  ]);
  const receipt = result("missing-call");
  const next = complete(current, receipt);
  assert.notEqual(next, current, "the new canonical fact is still appended");
  assert.equal(next.turns, current.turns);
  assert.equal(next.turns[0], current.turns[0]);
  assert.equal(next.turns[0]!.items, current.turns[0]!.items);
  assert.deepEqual(next.canonicalItems, [receipt]);
  assert.equal(next.updatedAt, Date.parse(receipt.createdAt) / 1000);
  assert.equal(
    complete(next, receipt),
    next,
    "replaying an unmatched canonical result is a no-op",
  );
  const withoutCanonical = { ...current, canonicalItems: undefined };
  assert.equal(complete(withoutCanonical, receipt), withoutCanonical);
  assert.equal(
    complete(current, { ...receipt, threadId: "other-thread" }),
    current,
  );
});

test("result matching remains exact callId-based across Turns, not item id or current Turn", () => {
  const matching = {
    ...runtimeCommand("matching", "echo synthetic", "inProgress"),
    callId: "shared-call",
  };
  const decoy = {
    ...runtimeCommand("shared-call", "echo decoy", "inProgress"),
    callId: "other-call",
  };
  const missing = runtimeCommand(
    "missing-call-id",
    "echo missing",
    "inProgress",
  );
  const current = runtimeThread([matching, decoy, missing]);
  current.turns = [
    { ...current.turns[0]!, id: "old-turn" },
    {
      ...current.turns[0]!,
      id: "new-turn",
      items: [{ ...matching, id: "second-match" }],
    },
  ];
  const next = complete(
    current,
    result("shared-call", {
      turnId: "neither-turn",
      exitCode: 126,
      output: "User declined this tool call.",
    }),
  );
  for (const turn of next.turns) {
    const command = turn.items[0]!;
    assert.ok(command.type === "commandExecution");
    assert.equal(command.status, "declined");
  }
  assert.equal(next.turns[0]!.items[1], decoy);
  assert.equal(next.turns[0]!.items[2], missing);
});

test("later results replace matched output and structured data without mutating earlier projections", () => {
  const current = runtimeThread([
    {
      ...runtimeCommand("tool", "echo synthetic", "inProgress"),
      callId: "call",
    },
  ]);
  const first = result("call", {
    id: "first-result",
    contentType: "application/json",
    structuredContent: { version: 1 },
  });
  const second = result("call", {
    id: "second-result",
    output: "Corrected output",
    exitCode: 2,
    executionStatus: "unknown",
    contentType: "application/json",
    structuredContent: { version: 2 },
  });
  const before = complete(current, first);
  const after = complete(before, second);
  const originalCommand = before.turns[0]!.items[0]!;
  const command = after.turns[0]!.items[0]!;
  assert.ok(originalCommand.type === "commandExecution");
  assert.ok(command.type === "commandExecution");
  assert.equal(originalCommand.aggregatedOutput, first.output);
  assert.deepEqual(originalCommand.structuredContent, { version: 1 });
  assert.equal(command.aggregatedOutput, second.output);
  assert.equal(command.exitCode, 2);
  assert.equal(command.status, "unknown");
  assert.deepEqual(command.structuredContent, { version: 2 });
  assert.notEqual(command.structuredContent, second.structuredContent);
  assert.deepEqual(after.canonicalItems, [first, second]);
});

test("result-before-call retains canonical recovery truth and replay still updates the exact command", () => {
  const original = runtimeThread([
    {
      ...runtimeCommand("tool", "echo synthetic", "inProgress"),
      callId: "call",
    },
  ]);
  const recovery = nativeRecoveryForThread(original);
  const call = recovery.thread.items.find((item) => item.type === "tool_call")!;
  assert.ok(call.type === "tool_call");
  const receipt = result("call");
  const emptyRecovery = {
    ...recovery,
    thread: {
      ...recovery.thread,
      items: recovery.thread.items.filter((item) => item !== call),
      turns: recovery.thread.turns.map((turn) => ({
        ...turn,
        items: turn.items.filter((item) => item !== call),
      })),
    },
  };
  const empty = projectNativeRecovery(emptyRecovery);
  const early = complete(empty, receipt);
  assert.equal(early.turns, empty.turns);
  assert.ok(early.canonicalItems?.includes(receipt));
  const called = applyNativeThreadEvent(early, {
    type: "item_completed",
    item: call,
  });
  const replayed = complete(called, receipt);
  const completedRecovery = projectNativeRecovery({
    ...recovery,
    thread: {
      ...recovery.thread,
      items: [...recovery.thread.items, receipt],
      turns: recovery.thread.turns.map((turn) => ({
        ...turn,
        items: [...turn.items, receipt],
      })),
    },
  });
  const command = replayed.turns[0]!.items[0]!;
  const recoveredCommand = completedRecovery.turns[0]!.items[0]!;
  assert.ok(command.type === "commandExecution");
  assert.ok(recoveredCommand.type === "commandExecution");
  assert.equal(command.aggregatedOutput, receipt.output);
  assert.equal(recoveredCommand.aggregatedOutput, receipt.output);
  assert.equal(command.status, recoveredCommand.status);
  assert.equal(
    replayed.canonicalItems?.filter((item) => item.id === receipt.id).length,
    1,
  );
});
