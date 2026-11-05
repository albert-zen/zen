import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Thread as CoreThread } from "../../../src/thread.js";
import { selectThreadHistoryWindow } from "../../../src/thread-history-window.js";
import { historyWindowFixture } from "../../../test/thread-history-window-fixture.js";
import {
  projectNativeThread,
  applyNativeThreadEvent,
} from "../src/renderer/src/thread-view-state.js";
import { mergeThreadHistoryPages } from "../src/renderer/src/thread-history-pages.js";
import { useThreadHistoryPages } from "../src/renderer/src/use-thread-history-pages.js";
import type { ThreadSnapshot } from "../../../src/app-server.js";
import type { Thread } from "../src/protocol-client/index.js";
import { withRuntimeDom } from "./agent-runtime-dom.js";

function page(before?: string): ThreadSnapshot {
  const items = historyWindowFixture(45);
  const selected = selectThreadHistoryWindow(
    "thread",
    items,
    before === undefined ? {} : { before },
  );
  const core = new CoreThread("thread", items);
  return {
    id: "thread",
    items: selected.items,
    turns: core.deriveTurns({ turnIds: selected.turnIds }),
    history: selected.history,
    cwd: "/tmp",
    providerProfileId: "fake",
    modelId: "fake",
    model: "fake",
    provider: "fake",
    reasoningEffort: "medium",
    sandbox: "read-only",
    approvalPolicy: "never",
    archived: false,
  };
}
function initial(): Thread {
  return { ...projectNativeThread(page()), recoveryEpoch: "epoch-a" };
}

test("backfill merges duplicate pages in canonical order and never replaces live deltas or queue state", () => {
  const first = initial();
  const older = projectNativeThread(page(first.history!.before!));
  const active = applyNativeThreadEvent(first, {
    type: "item_delta",
    threadId: "thread",
    turnId: "turn-44",
    itemId: "live-item",
    delta: "new streaming text",
  });
  const merged = mergeThreadHistoryPages(active, [older, older]);
  assert.deepEqual(
    merged.turns.map((turn) => turn.id),
    Array.from({ length: 40 }, (_, i) => `turn-${i + 5}`),
  );
  assert.deepEqual(merged.turns.at(-1), active.turns.at(-1));
  assert.equal(
    new Set(merged.canonicalItems!.map((item) => item.id)).size,
    merged.canonicalItems!.length,
  );
  assert.deepEqual(merged.queuedMessages, active.queuedMessages);
});

test("history controller deduplicates concurrent loads, fences stale recovery and finds exact old Items", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let release: ((value: { thread: ThreadSnapshot }) => void) | undefined;
  const calls: string[] = [];
  window.zenx = {
    protocol: {
      request: async (method: string, params: { before: string }) => {
        assert.equal(method, "zen/thread/history");
        calls.push(params.before);
        return await new Promise<{ thread: ThreadSnapshot }>((resolve) => {
          release = resolve;
        });
      },
    },
  } as unknown as typeof window.zenx;
  let current = initial();
  let view!: ReturnType<typeof useThreadHistoryPages>;
  function Harness() {
    view = useThreadHistoryPages(current);
    return React.createElement("span", null, view.thread?.turns.length);
  }
  const root = createRoot(document.getElementById("root")!);
  const render = async () => {
    await act(async () =>
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(Harness),
        ),
      ),
    );
  };
  try {
    await render();
    let one!: Promise<boolean>, duplicate!: Promise<boolean>;
    await act(async () => {
      one = view.controller.loadOlder();
      duplicate = view.controller.loadOlder();
    });
    assert.equal(one, duplicate);
    assert.equal(calls.length, 1);
    current = { ...initial(), recoveryEpoch: "epoch-b" };
    await render();
    await act(async () => {
      release!({ thread: page(calls[0]) });
      await one;
    });
    assert.equal(view.thread?.turns.length, 20);
    let finding!: Promise<boolean>;
    await act(async () => {
      finding = view.controller.ensureItem("agent-0");
    });
    await act(async () => {
      release!({ thread: page(calls[1]) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(calls.length, 3);
    await act(async () => {
      release!({ thread: page(calls[2]) });
      assert.equal(await finding, true);
    });
    assert.equal(view.thread?.turns.length, 45);
    assert.equal(view.controller.hasMore, false);
    assert.equal(await view.controller.ensureItem("does-not-exist"), false);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("actual ThreadView loads earlier rows without changing the unsent draft", async () => {
  await withRuntimeDom(async (h) => {
    let calls = 0;
    window.zenx = {
      protocol: {
        request: async (_method: string, params: { before: string }) => {
          calls++;
          return { thread: page(params.before) };
        },
      },
    } as unknown as typeof window.zenx;
    await h.render(initial());
    assert.equal(document.querySelectorAll(".turn").length, 20);
    const draftBefore =
      document.querySelector<HTMLTextAreaElement>("textarea")?.value;
    await h.click(".thread-history-backfill button");
    assert.equal(calls, 1);
    assert.equal(document.querySelectorAll(".turn").length, 40);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("textarea")?.value,
      draftBefore,
    );
    await h.click(".thread-history-backfill button");
    assert.equal(document.querySelectorAll(".turn").length, 45);
    assert.equal(document.querySelector(".thread-history-backfill"), null);
  });
});

test("presentation windows never masquerade partial semantic context as an ItemList", () => {
  const current = initial();
  const semantic = {
    id: "context",
    threadId: "thread",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "semantic" }],
  } as unknown as import("../../../src/item-list.js").ContextItem;
  const projected = applyNativeThreadEvent(current, {
    type: "context_item_completed",
    threadId: "thread",
    item: semantic,
  });
  assert.equal(projected.itemList, undefined);
  assert.equal(projected, current);
});

test("a quoted source outside the first page backfills to its exact canonical Item and preserves the draft", async () => {
  await withRuntimeDom(async (h) => {
    const { withSkillDraft } =
      await import("../src/renderer/src/skill-draft.js");
    const { emptyComposerState, editComposer } =
      await import("../src/renderer/src/composer-state.js");
    const composer = editComposer(
      emptyComposerState(),
      withSkillDraft(
        "Unsent question",
        [],
        [
          {
            kind: "message",
            name: "Old answer",
            threadId: "thread",
            id: "agent-0",
            cwd: "/tmp",
            excerpt: "Answer 0:",
          },
        ],
      ),
    );
    let calls = 0;
    window.zenx = {
      protocol: {
        request: async (_method: string, params: { before: string }) => {
          calls++;
          return { thread: page(params.before) };
        },
      },
    } as unknown as typeof window.zenx;
    await h.render(initial(), { composer });
    assert.equal(
      document.querySelector('[data-quote-item-id="agent-0"]'),
      null,
    );
    await h.click("#thread-composer .reference-token-details");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const source = document.querySelector<HTMLElement>(
      '[data-quote-thread-id="thread"][data-quote-item-id="agent-0"]',
    );
    assert.ok(source);
    assert.equal(document.activeElement, source);
    assert.equal(calls, 2);
    assert(
      document
        .querySelector("#thread-composer")
        ?.textContent?.includes("Unsent question"),
    );
  });
});
