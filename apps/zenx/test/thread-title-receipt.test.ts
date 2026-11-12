import assert from "node:assert/strict";
import test from "node:test";
import { applyThreadTitleReceipt } from "../src/renderer/src/thread-title-receipt.js";
import type { ThreadTitleProjection } from "../src/main/thread-title-types.js";
const title = (
  threadId: string,
  version: number,
  text: string,
): ThreadTitleProjection => ({
  threadId,
  version,
  title: text,
  status: "manual",
  source: "user",
});
test("late rename receipt cannot overwrite a newer title or another selection", () => {
  const newer = title("a", 4, "Newest"),
    other = title("b", 8, "Selected elsewhere");
  const current = { a: newer, b: other };
  assert.equal(
    applyThreadTitleReceipt(current, title("a", 3, "Old name")),
    current,
  );
  const next = applyThreadTitleReceipt(current, title("a", 5, "Saved"));
  assert.equal(next.a?.title, "Saved");
  assert.equal(next.b, other);
});
