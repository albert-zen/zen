import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem, UserMessageItem } from "../src/item.js";
import { recordedUserTimestamps } from "../src/model.js";
import { contextItemsFromLegacy } from "../src/item-list-legacy.js";
import { formatReceiptTimestamp } from "../src/message-timezone.js";

const instant = "2026-10-31T08:00:00.000Z";
function user(id: string, clientId = id): UserMessageItem {
  return {
    id,
    clientId,
    threadId: "synthetic",
    turnId: `turn-${id}`,
    type: "user_message",
    createdAt: instant,
    content: [{ type: "text", text: "synthetic input" }],
    receiptTimezone: { timeZone: "Asia/Shanghai", source: "client" },
  };
}

test("single receipt projection formats only its canonical admission", () => {
  const history: CanonicalItem[] = Array.from({ length: 2_000 }, (_, i) =>
    user(`old-${i}`),
  );
  history.push({
    id: "unrelated-queue",
    type: "user_message_queued",
    threadId: "synthetic",
    createdAt: instant,
    clientId: "unrelated",
    input: [{ type: "text", text: "queued" }],
  });
  for (const queued of [false, true]) {
    const input = user("new");
    const prior: CanonicalItem[] = [...history];
    if (queued)
      prior.push({
        id: "target-queue",
        type: "user_message_queued",
        threadId: input.threadId,
        createdAt: "2026-10-31T07:00:00.000Z",
        clientId: input.clientId!,
        receiptTimezone: { timeZone: "America/New_York", source: "client" },
        input: [{ type: "text", text: "queued" }],
      });
    let calls = 0;
    const result = recordedUserTimestamps(
      [...prior, input],
      (value, zone) => {
        calls++;
        return formatReceiptTimestamp(value, zone);
      },
      input.id,
    );
    assert.equal(calls, 1);
    assert.equal(result.size, 1);
    const expected = recordedUserTimestamps(
      [...prior, input],
      formatReceiptTimestamp,
    ).get(input.id);
    assert.equal(result.get(input.id), expected);
    const projected = contextItemsFromLegacy(input, prior)[0];
    assert.equal(projected?.kind, "message");
    assert(projected?.kind === "message");
    assert.equal(
      projected.content.text,
      `[Message received at ${expected}]\nsynthetic input`,
    );
  }
});

test("targeted receipt retains full projection admission and legacy semantics", () => {
  const delivered = user("delivered", "shared");
  const queue: CanonicalItem = {
    id: "queue",
    threadId: "synthetic",
    type: "user_message_queued",
    clientId: "shared",
    createdAt: "2026-10-30T06:00:00.000Z",
    input: [{ type: "text", text: "queued" }],
  };
  const replacement: CanonicalItem = {
    id: "replace",
    threadId: "synthetic",
    type: "turn_replacement_requested",
    turnId: "old",
    successorTurnId: "new",
    clientId: "shared",
    createdAt: instant,
    text: "replacement",
  };
  const metadata: CanonicalItem = {
    id: "metadata",
    threadId: "synthetic",
    type: "thread_metadata",
    createdAt: instant,
    cwd: "/synthetic",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    provider: "synthetic",
    model: "synthetic",
    importedFrom: {
      format: "synthetic",
      sourceId: "import",
      sourceVersion: "1",
      sourceCwd: "/synthetic",
      sha256: "0".repeat(64),
      exclusions: [],
      historyItemCount: 10,
      contextBasis: {
        kind: "replacement-history",
        sourceLine: 1,
        earlierRecords: 1,
      },
    },
  };
  const fork: CanonicalItem = {
    id: "fork",
    threadId: "synthetic",
    type: "thread_forked",
    createdAt: instant,
    sourceThreadId: "original",
    sourceBoundaryItemId: "old",
    workspace: "same-directory",
  };
  const { clientId: _clientId, ...legacy } = delivered;
  const cases: CanonicalItem[][] = [
    [delivered],
    [queue, delivered],
    [replacement, delivered],
    [queue, replacement, delivered],
    [{ ...queue, threadId: "other" }, delivered],
    [{ ...queue, createdAt: "unknown" }, delivered],
    [{ ...delivered, createdAt: "unknown" }],
    [legacy],
    [metadata, delivered],
    [metadata, fork, delivered],
    [metadata, queue, fork, delivered],
    [metadata, delivered, fork],
  ];
  for (const items of cases) {
    const oracle = recordedUserTimestamps(items, formatReceiptTimestamp);
    assert.deepEqual(
      recordedUserTimestamps(items, formatReceiptTimestamp, delivered.id),
      oracle,
    );
    assert.deepEqual(
      recordedUserTimestamps(items, formatReceiptTimestamp, "missing"),
      new Map(),
    );
  }
});
