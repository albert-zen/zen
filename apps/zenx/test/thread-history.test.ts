import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSnapshot } from "../../../src/app-server.js";
import { readThreadHistory } from "../src/main/thread-history.js";

const snapshot = {
  id: "thread",
  cwd: "/fixture",
  items: [
    {
      id: "metadata",
      threadId: "thread",
      createdAt: "2026-10-13T00:00:00Z",
      type: "thread_metadata",
      providerProfileId: "fake",
      model: "fake",
      cwd: "/fixture",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    {
      id: "message",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-10-13T00:00:00Z",
      type: "agent_message",
      role: "assistant",
      text: "Visible history",
    },
    {
      id: "deleted",
      threadId: "thread",
      createdAt: "2026-10-13T00:01:00Z",
      type: "thread_deleted",
    },
    {
      id: "restored",
      threadId: "thread",
      createdAt: "2026-10-13T00:02:00Z",
      type: "thread_restored",
      deletionItemId: "deleted",
    },
  ],
} as unknown as ThreadSnapshot;

test("public history omits lifecycle controls while retaining the canonical cursor boundary", () => {
  const options = {
    granularity: "items" as const,
    maxTurns: 20,
    maxItemsPerTurn: 1,
  };
  const first = readThreadHistory(snapshot, options);
  assert.equal(first.snapshotThroughItemId, "restored");
  assert.deepEqual(
    (first.items as { type: string }[]).map((item) => item.type),
    ["agent_message"],
  );
  const second = readThreadHistory(snapshot, {
    ...options,
    cursor: first.nextCursor as string,
  });
  assert.deepEqual(
    (second.items as { type: string }[]).map((item) => item.type),
    ["thread_metadata"],
  );
  assert.equal(second.nextCursor, null);
  for (const itemId of ["deleted", "restored"])
    assert.throws(
      () =>
        readThreadHistory(snapshot, {
          ...options,
          granularity: "item",
          itemId,
        }),
      /Unknown itemId/,
    );
  assert.match(
    readThreadHistory(snapshot, {
      ...options,
      granularity: "item",
      itemId: "message",
    }).content as string,
    /Visible history/,
  );
});
