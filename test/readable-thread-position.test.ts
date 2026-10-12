import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../src/item.js";
import { completedAnswer } from "../src/readable-thread-position.js";

const message = (id: string, text = "same answer"): CanonicalItem => ({
  id,
  threadId: "thread",
  turnId: "turn",
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "agent_message",
  text,
});
const terminal = (
  status: "completed" | "failed" = "completed",
): CanonicalItem => ({
  id: "end",
  threadId: "thread",
  turnId: "turn",
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "turn_completed",
  status,
});
test("only complete final answers in successful Turns advance readable identity", () => {
  assert.equal(completedAnswer([]), null);
  assert.equal(completedAnswer([message("a")]), null);
  assert.equal(completedAnswer([message("a"), terminal("failed")]), null);
  assert.equal(completedAnswer([terminal()]), null);
  assert.equal(
    completedAnswer([message("a"), message("b", " "), terminal()]),
    null,
  );
  const incomplete = { ...message("b"), incomplete: true } as CanonicalItem;
  assert.equal(completedAnswer([message("a"), incomplete, terminal()]), null);
  assert.deepEqual(completedAnswer([message("a"), message("b"), terminal()]), {
    itemId: "b",
    position: 2,
  });
  assert.deepEqual(
    completedAnswer([message("a"), terminal(), message("b"), terminal()]),
    { itemId: "b", position: 3 },
  );
});
