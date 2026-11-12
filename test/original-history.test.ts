import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSnapshot } from "../src/app-server.js";
import type { CanonicalItem } from "../src/item.js";
import { readOriginalThreadHistory } from "../src/thread-history.js";

const base = { threadId: "thread", createdAt: "2026-10-14T00:00:00Z" };
const original = Array.from({ length: 73 }, (_, index) => ({
  ...base,
  id: `item-${index}`,
  type: "agent_message",
  turnId: "turn",
  role: "assistant",
  text: `Original message ${index}`,
})) as CanonicalItem[];
original[12] = {
  ...base,
  id: "tool-output",
  type: "tool_result",
  turnId: "turn",
  callId: "call",
  toolCallId: "tool-call",
  tool: "fixture",
  output: "Original tool result 世界\n".repeat(1200),
  exitCode: 0,
  sourceItemId: "source-output",
} as CanonicalItem;
original[22] = {
  ...base,
  id: "opaque",
  type: "reasoning",
  turnId: "turn",
  contentVisibility: "opaque",
  reasoningContent: "NEVER EXPOSE",
  summary: "Public summary",
} as CanonicalItem;
original[23] = {
  ...base,
  id: "nested",
  type: "tool_result",
  turnId: "turn",
  callId: "nested-call",
  output: "Exact public text",
  modelContent: [
    {
      type: "opaque",
      contentVisibility: "opaque",
      content: "NESTED PRIVATE",
      summary: "Nested public summary",
    },
  ],
} as unknown as CanonicalItem;
const compact = {
  ...base,
  id: "compaction",
  type: "context_compaction",
  coveredThroughItemId: "item-72",
  includeOriginalReference: true,
} as CanonicalItem;
const snapshot = {
  id: "thread",
  cwd: "/fixture",
  items: [
    ...original,
    compact,
    { ...original[0], id: "later", text: "LATER HISTORY" },
  ],
} as unknown as ThreadSnapshot;

test("original public history pages the exact prefix without loss, mutation or opaque payloads", () => {
  const saved = JSON.stringify(snapshot);
  let page = readOriginalThreadHistory(snapshot, { throughItemId: "item-72" });
  assert.equal(page.granularity, "items");
  if (page.granularity !== "items") throw new Error();
  assert.equal(page.items.length, 50);
  assert(page.nextCursor);
  const newest = page.items;
  page = readOriginalThreadHistory(snapshot, {
    throughItemId: "item-72",
    cursor: page.nextCursor,
  });
  if (page.granularity !== "items") throw new Error();
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    [...page.items, ...newest].map((item) => item.itemId),
    original.map((item) => item.id),
  );
  assert.equal(JSON.stringify(snapshot), saved);
  for (const [itemId, visible, hidden] of [
    ["opaque", "Public summary", "NEVER EXPOSE"],
    ["nested", "Nested public summary", "NESTED PRIVATE"],
  ]) {
    const detail = readOriginalThreadHistory(snapshot, {
      throughItemId: "item-72",
      granularity: "item",
      itemId: itemId!,
    });
    assert.equal(detail.granularity, "item");
    if (detail.granularity !== "item") throw new Error();
    assert(detail.content.includes(visible!));
    assert(!detail.content.includes(hidden!));
  }
  let content = "";
  let cursor: string | undefined;
  do {
    const detail = readOriginalThreadHistory(snapshot, {
      throughItemId: "item-72",
      granularity: "item",
      itemId: "tool-output",
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (detail.granularity !== "item") throw new Error();
    assert.equal(detail.offset, content.length);
    assert(detail.content.length <= 8000);
    content += detail.content;
    cursor = detail.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(JSON.parse(content), original[12]);
});

test("original-history references, limits and cursors fail closed across threads and cutoffs", () => {
  for (const includeOriginalReference of [false, undefined]) {
    assert.throws(
      () =>
        readOriginalThreadHistory(
          {
            ...snapshot,
            items: [
              ...original,
              { ...compact, includeOriginalReference } as CanonicalItem,
            ],
          },
          { throughItemId: "item-72" },
        ),
      /not enabled/,
    );
  }
  for (const throughItemId of ["later", "compaction", "missing"])
    assert.throws(
      () => readOriginalThreadHistory(snapshot, { throughItemId }),
      /not enabled/,
    );
  for (const limit of [0, 51, -1, 1.5])
    assert.throws(
      () =>
        readOriginalThreadHistory(snapshot, {
          throughItemId: "item-72",
          limit,
        }),
      /limit/,
    );
  assert.throws(
    () =>
      readOriginalThreadHistory(snapshot, {
        throughItemId: "item-72",
        granularity: "item",
        itemId: "later",
      }),
    /Unknown itemId/,
  );
  const first = readOriginalThreadHistory(snapshot, {
    throughItemId: "item-72",
    limit: 1,
  });
  assert(first.nextCursor);
  const expanded = {
    ...snapshot,
    items: [
      ...snapshot.items,
      { ...compact, id: "second", coveredThroughItemId: "later" },
    ] as CanonicalItem[],
  };
  assert.throws(
    () =>
      readOriginalThreadHistory(expanded, {
        throughItemId: "later",
        cursor: first.nextCursor!,
      }),
    /cursor/,
  );
  assert.throws(
    () =>
      readOriginalThreadHistory(
        { ...snapshot, id: "other" },
        { throughItemId: "item-72", cursor: first.nextCursor! },
      ),
    /cursor/,
  );
  const forged = JSON.parse(
    Buffer.from(first.nextCursor, "base64url").toString(),
  );
  forged.boundary = "later";
  assert.throws(
    () =>
      readOriginalThreadHistory(snapshot, {
        throughItemId: "item-72",
        cursor: Buffer.from(JSON.stringify(forged)).toString("base64url"),
      }),
    /boundary/,
  );
  const item = readOriginalThreadHistory(snapshot, {
    throughItemId: "item-72",
    granularity: "item",
    itemId: "tool-output",
  });
  assert(item.nextCursor);
  assert.throws(
    () =>
      readOriginalThreadHistory(snapshot, {
        throughItemId: "item-72",
        granularity: "item",
        itemId: "nested",
        cursor: item.nextCursor!,
      }),
    /cursor/,
  );
});

test("user previews read public canonical content while preserving legacy text and opaque boundaries", () => {
  const messages = [
    {
      ...base,
      id: "legacy",
      type: "user_message",
      turnId: "turn",
      text: "Legacy original",
    },
    {
      ...base,
      id: "public",
      type: "user_message",
      turnId: "turn",
      content: [
        { type: "text", text: "First original" },
        { type: "text", text: "Second original" },
      ],
    },
    {
      ...base,
      id: "opaque-user",
      type: "user_message",
      turnId: "turn",
      contentVisibility: "opaque",
      content: [{ type: "text", text: "TOP LEVEL PRIVATE" }],
    },
    {
      ...base,
      id: "nested-user",
      type: "user_message",
      turnId: "turn",
      content: [
        { type: "text", text: "Public content" },
        { type: "text", contentVisibility: "opaque", text: "NESTED PRIVATE" },
      ],
    },
  ] as unknown as CanonicalItem[];
  const stored = {
    ...snapshot,
    items: [...messages, { ...compact, coveredThroughItemId: "nested-user" }],
  };
  const before = JSON.stringify(stored);
  const page = readOriginalThreadHistory(stored, {
    throughItemId: "nested-user",
  });
  assert.equal(page.granularity, "items");
  if (page.granularity !== "items") throw new Error();
  assert.equal(page.items[0]?.text, "Legacy original");
  assert.equal(page.items[1]?.text, "First original\nSecond original");
  assert.equal(page.items[2]?.text, undefined);
  assert.equal(page.items[3]?.text, "Public content\n");
  assert.doesNotMatch(JSON.stringify(page), /TOP LEVEL PRIVATE|NESTED PRIVATE/);
  assert.equal(JSON.stringify(stored), before);
});

test("an original reference survives journal reload without changing its prefix", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { JsonlThreadJournal } = await import("../src/journal.js");
  const { createHostedAppServer } = await import("../apps/cli/src/host.js");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-original-reload-"),
  );
  const options = {
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never" as const,
    provider: { type: "fake" as const },
  };
  const app = createHostedAppServer({
    ...options,
    journal: new JsonlThreadJournal(directory),
  });
  try {
    const thread = await app.startThread();
    await (
      await app.startTurn(thread.id, "Preserve this original message verbatim.")
    ).done;
    await app.compactThread(thread.id);
    const snapshot = await app.readThread(thread.id);
    const compaction = snapshot.items.find(
      (item) => item.type === "context_compaction",
    );
    assert(compaction?.type === "context_compaction");
    const expected = readOriginalThreadHistory(snapshot, {
      throughItemId: compaction.coveredThroughItemId,
    });
    const restored = createHostedAppServer({
      ...options,
      journal: new JsonlThreadJournal(directory),
    });
    try {
      const reloaded = await restored.readThread(thread.id);
      assert.deepEqual(
        readOriginalThreadHistory(reloaded, {
          throughItemId: compaction.coveredThroughItemId,
        }),
        expected,
      );
      assert.deepEqual(reloaded.items, snapshot.items);
    } finally {
      await restored.closeProviderTransport();
    }
  } finally {
    await app.closeProviderTransport();
    await rm(directory, { recursive: true, force: true });
  }
});
