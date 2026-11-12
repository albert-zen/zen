import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../src/item.js";
import { latestTurnEnd } from "../src/turn-end.js";

test("only the latest Turn's durable lifecycle end proves stopped, independently of messages and clock order", () => {
  const common = {
    threadId: "thread",
    turnId: "first",
    createdAt: new Date(100).toISOString(),
  };
  const end: CanonicalItem = {
    ...common,
    id: "end",
    type: "turn_completed",
    status: "completed",
  };
  const items: CanonicalItem[] = [
    { ...common, id: "start", type: "turn_started" },
    end,
  ];
  assert.equal(latestTurnEnd(items), end);
  items.push({
    ...common,
    id: "new-start",
    turnId: "next",
    type: "turn_started",
    createdAt: new Date(50).toISOString(),
  });
  assert.equal(
    latestTurnEnd(items),
    undefined,
    "canonical order wins over backwards wall clocks and the previous end",
  );
  items.push({
    ...common,
    id: "commentary",
    turnId: "next",
    type: "agent_message",
    text: "Working",
  });
  assert.equal(latestTurnEnd(items), undefined);
  const abort: CanonicalItem = {
    ...common,
    id: "abort",
    turnId: "next",
    type: "turn_aborted",
    reason: "Stopped",
  };
  items.push(abort);
  assert.equal(latestTurnEnd(items), abort);
  items.push({
    ...common,
    id: "usage",
    turnId: "next",
    type: "model_usage",
    modelResponseId: "commentary",
    inputTokens: 1,
    outputTokens: 1,
  });
  assert.equal(
    latestTurnEnd(items),
    abort,
    "trailing telemetry is not another run or end",
  );
});
