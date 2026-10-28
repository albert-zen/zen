import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeDom, act } from "./agent-runtime-dom.js";
import type { ContextCompactionItem } from "../../../src/item.js";
import type { Thread } from "../src/protocol-client/index.js";

const item = {
  id: "compact",
  threadId: "thread",
  createdAt: "2026-10-28T12:00:00Z",
  type: "context_compaction",
  provenance: "agentic",
  turnId: "turn",
  callId: "call",
  sourceModelResponseId: "response",
  coveredThroughItemId: "boundary",
  summary: "## Retained goal\nKeep the exact original history accessible.",
  retainedItemIds: [],
  algorithmVersion: "test",
  includeOriginalReference: true,
} as ContextCompactionItem;
const thread = {
  id: "thread",
  cwd: "/synthetic",
  turns: [],
  canonicalItems: [item],
  status: { type: "idle" },
  name: "Synthetic compaction",
} as unknown as Thread;

test("one compaction row opens peer views without nested disclosure or eager history reads", async () => {
  await withRuntimeDom(async (h) => {
    const requests: unknown[] = [];
    Object.assign(window, {
      zenx: {
        protocol: {
          request: async (_method: string, request: unknown) => {
            requests.push(request);
            return {
              granularity: "items",
              threadId: "thread",
              snapshotThroughItemId: "boundary",
              items: [],
              nextCursor: null,
            };
          },
        },
      },
    });
    await h.render(thread);
    const event = document.querySelector(".context-compaction-event")!;
    assert.equal(event.querySelectorAll("button").length, 1);
    assert.equal(event.querySelectorAll("details").length, 0);
    assert.equal(requests.length, 0);
    await h.click(".context-compaction-toggle");
    const tabs = event.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    assert.deepEqual(
      [...tabs].map((tab) => tab.textContent),
      ["Retained context", "Original history", "Diagnostics"],
    );
    assert.equal(tabs[0]!.getAttribute("aria-selected"), "true");
    assert.match(
      event.querySelector('[role="tabpanel"]')!.textContent!,
      /Retained goal/,
    );
    assert.equal(event.querySelectorAll("details").length, 0);
    await act(async () => tabs[1]!.click());
    assert.equal(requests.length, 1);
    assert(event.querySelector(".original-history-reader"));
    assert.equal(
      event.querySelector(".original-history-reader > p")?.textContent,
      "Original history before this compaction",
    );
    assert(!event.querySelector(".original-history-open"));
    assert(!event.querySelector(".compaction-summary"));
    await act(async () => tabs[2]!.click());
    assert(!event.querySelector(".original-history-reader"));
    assert.match(
      event.querySelector('[role="tabpanel"]')!.textContent!,
      /boundary does not exist/,
    );
    assert.match(
      event.querySelector(".compaction-record")!.textContent!,
      /"algorithmVersion": "test"/,
    );
    assert.equal(event.querySelectorAll("details").length, 0);
    await h.click(".context-compaction-toggle");
    assert.equal(event.querySelectorAll("button").length, 1);
    assert(!event.querySelector('[role="tabpanel"]'));
  });
});

test("compaction view tabs support scoped arrow navigation and independent rows", async () => {
  await withRuntimeDom(async (h) => {
    await h.render({
      ...thread,
      canonicalItems: [
        item,
        { ...item, id: "second", includeOriginalReference: false },
      ],
    });
    const toggles = document.querySelectorAll<HTMLButtonElement>(
      ".context-compaction-toggle",
    );
    await act(async () => {
      toggles[0]!.click();
      toggles[1]!.click();
    });
    const rows = document.querySelectorAll(".context-compaction-event");
    const tabs = rows[1]!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[0]!.focus();
    await act(async () =>
      tabs[0]!.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }),
      ),
    );
    assert.equal(document.activeElement, tabs[1]);
    assert.equal(tabs[1]!.getAttribute("aria-selected"), "true");
    assert.match(rows[1]!.textContent!, /No original-history reference/);
    assert.equal(
      rows[0]!.querySelector('[role="tab"][aria-selected="true"]')!.textContent,
      "Retained context",
    );
    await act(async () =>
      tabs[1]!.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    assert.equal(document.activeElement, tabs[2]);
    const panel = rows[1]!.querySelector('[role="tabpanel"]')!;
    assert.equal(panel.getAttribute("aria-labelledby"), tabs[2]!.id);
    assert.equal(panel.id, tabs[2]!.getAttribute("aria-controls"));
  });
});
