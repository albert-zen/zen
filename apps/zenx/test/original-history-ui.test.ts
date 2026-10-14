import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeDom, act } from "./agent-runtime-dom.js";
import type {
  CanonicalItem,
  ContextCompactionItem,
} from "../../../src/item.js";
import type { ThreadSnapshot } from "../../../src/app-server.js";
import type { Thread } from "../src/protocol-client/index.js";
import {
  readOriginalThreadHistory,
  type OriginalHistoryOptions,
  type OriginalHistoryPage,
} from "../../../src/thread-history.js";

const original = Array.from({ length: 61 }, (_, index) => ({
  id: `item-${index}`,
  threadId: "thread",
  turnId: "turn",
  createdAt: "2026-10-14T00:00:00Z",
  type: "agent_message",
  role: "assistant",
  text:
    index === 60
      ? "FULL ORIGINAL 世界\n".repeat(650)
      : `Public original ${index}`,
})) as CanonicalItem[];
const compaction = {
  id: "compact",
  threadId: "thread",
  createdAt: "2026-10-14T00:01:00Z",
  type: "context_compaction",
  provenance: "agentic",
  turnId: "turn",
  callId: "call",
  sourceModelResponseId: "response",
  coveredThroughItemId: "item-60",
  summary: "Saved continuation",
  retainedItemIds: [],
  algorithmVersion: "test",
  includeOriginalReference: true,
} as ContextCompactionItem;
const snapshot = {
  id: "thread",
  cwd: "/fixture",
  items: [...original, compaction],
} as unknown as ThreadSnapshot;
function thread(item = compaction): Thread {
  return {
    id: item.threadId,
    cwd: "/fixture",
    turns: [],
    canonicalItems: [item],
    status: { type: "idle" },
    name: "Synthetic compaction",
  } as unknown as Thread;
}
function button(text: string) {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((node) => node.textContent?.includes(text));
  assert(result, `Missing button ${text}`);
  return result;
}
function installReader(
  read: (
    options: OriginalHistoryOptions & { threadId: string },
  ) => Promise<OriginalHistoryPage>,
) {
  Object.assign(window, {
    zenx: {
      protocol: {
        request: async (
          method: string,
          options: OriginalHistoryOptions & { threadId: string },
        ) => {
          assert.equal(method, "zen/thread/original/read");
          return await read(options);
        },
      },
    },
  });
}

test("compaction's visible original-history entry pages exact Items and reads full original chunks", async () => {
  await withRuntimeDom(async (h) => {
    const calls: Array<OriginalHistoryOptions & { threadId: string }> = [];
    installReader(async (request) => {
      calls.push(request);
      const { threadId, ...options } = request;
      assert.equal(threadId, snapshot.id);
      return readOriginalThreadHistory(snapshot, options);
    });
    await h.render(thread());
    assert.equal(calls.length, 0);
    assert(
      !document.querySelector(".context-compaction-detail"),
      "link is visible even while summary is collapsed",
    );
    await h.click(".original-history-open");
    assert.equal(calls.length, 1);
    assert(
      !document.querySelector(".original-history-items code"),
      "canonical IDs stay inside explicit details",
    );
    assert.doesNotMatch(
      document.querySelector(".original-history-items")!.textContent!,
      /\"threadId\"|\"createdAt\"/,
    );
    assert.equal(calls[0]?.throughItemId, "item-60");
    assert.equal(calls[0]?.limit, 50);
    assert.match(
      document.querySelector(".original-history-locator")!.textContent!,
      /zen-thread:\/\/thread\/items\?through=item-60/,
    );
    assert.equal(
      document.querySelectorAll(".original-history-items > li").length,
      50,
    );
    const last = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".original-history-item-toggle",
      ),
    ].at(-1)!;
    await act(async () => last.click());
    assert.match(
      document.querySelector(".original-history-item-detail")!.textContent!,
      /FULL ORIGINAL/,
    );
    let more = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.includes("Read more"),
    );
    assert(more);
    while (more) {
      await act(async () => more!.click());
      more = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent?.includes("Read more"),
      );
    }
    const detail = JSON.parse(
      document.querySelector(".original-history-item-detail pre")!.textContent!,
    );
    assert.equal(detail.text, (original[60] as { text: string }).text);
    await act(async () => button("Older Items").click());
    assert.equal(
      document.querySelectorAll(".original-history-items > li").length,
      11,
    );
    assert.match(
      document.querySelector(".original-history-items")!.textContent!,
      /Public original 0/,
    );
    assert(button("Older Items").disabled);
    await act(async () => button("Newer Items").click());
    assert.equal(
      document.querySelectorAll(".original-history-items > li").length,
      50,
    );
    await h.click(".original-history-open");
    assert(!document.querySelector(".original-history-reader"));
    assert(
      calls.every(
        (call) =>
          call.threadId === "thread" && call.throughItemId === "item-60",
      ),
    );
  });
});

test("disabled and legacy references cannot fetch, failure is retryable, and late reads cannot reopen after close or navigation", async () => {
  await withRuntimeDom(async (h) => {
    let calls = 0;
    installReader(async () => {
      calls++;
      throw new Error("Reference unavailable on this Host");
    });
    for (const includeOriginalReference of [false, undefined]) {
      await h.render(
        thread({
          ...compaction,
          includeOriginalReference,
        } as ContextCompactionItem),
      );
      assert(!document.querySelector(".original-history-open"));
      assert.match(document.body.textContent!, /No original-history reference/);
    }
    assert.equal(calls, 0);
    await h.render(thread());
    await h.click(".original-history-open");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Reference unavailable/,
    );
    await act(async () => button("Retry").click());
    assert.equal(calls, 2);
    await h.click(".original-history-open");
    let finish!: (page: OriginalHistoryPage) => void;
    installReader(
      async () =>
        await new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await h.click(".original-history-open");
    assert.match(document.body.textContent!, /Reading original history/);
    await h.click(".original-history-open");
    await act(async () =>
      finish(readOriginalThreadHistory(snapshot, { throughItemId: "item-60" })),
    );
    assert(!document.querySelector(".original-history-reader"));
    await h.click(".original-history-open");
    const oldFinish = finish;
    await h.render(
      thread({
        ...compaction,
        id: "new-compact",
        threadId: "another-thread",
        coveredThroughItemId: "different-cutoff",
      }),
    );
    await act(async () =>
      oldFinish(
        readOriginalThreadHistory(snapshot, { throughItemId: "item-60" }),
      ),
    );
    assert(!document.querySelector(".original-history-reader"));
    assert.doesNotMatch(document.body.textContent!, /Public original/);
  });
});
