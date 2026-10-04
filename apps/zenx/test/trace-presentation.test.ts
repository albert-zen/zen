import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CanonicalItem,
  ContextCompactionItem,
} from "../../../src/item.js";
import type { Thread, ThreadItem, Turn } from "../src/protocol-client/index.js";
import { applyNativeThreadEvent } from "../src/renderer/src/thread-view-state.js";
import { projectContextCompactions } from "../src/renderer/src/context-compaction-projection.js";
import { getConversationPresentationStore } from "../src/renderer/src/conversation-presentation.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";

Object.assign(globalThis, { React });
const { ThreadView } = await import("../src/renderer/src/ThreadView.js");
const { act, createElement } = React;
const noop = async () => undefined;

test("normal conversations have no permanent trace controls or debug-data row", async () => {
  await withDom(async (root) => {
    await render(root, [command("one")]);
    assert.ok(
      document.querySelector(".trace-presentation-controls") === null,
      "Presentation controls belong to Settings, not the transcript",
    );
    assert.ok(
      document.querySelector(".trace-debug-source") === null,
      "Normal conversations do not add debug data rows",
    );
    assert.ok(document.querySelector('[aria-label="Debug trace"]') === null);
  });
});

test("debug trace reveals process rows while individual bodies remain on demand", async () => {
  await withDom(async (root) => {
    await render(root, [command("one"), command("two")]);
    const debug = debugPreference();
    assert.equal(getConversationPresentationStore().getSnapshot(), "normal");
    assert.equal(
      button(".trace-toggle").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(document.querySelector(".trace-tool-detail"), null);
    await act(async () => debug.click());
    assert.equal(getConversationPresentationStore().getSnapshot(), "debug");
    assert.equal(button(".trace-toggle").getAttribute("aria-expanded"), "true");
    assert.equal(
      document.querySelectorAll(".trace-items .trace-item-toggle").length,
      2,
    );
    assert.equal(document.querySelector(".trace-tool-detail"), null);
    assert.equal(document.querySelector(".trace-debug-raw pre"), null);
    await act(async () => button(".trace-items .trace-item-toggle").click());
    assert.equal(element(".trace-input-preview code").textContent, "echo one");
    assert.equal(document.querySelector(".trace-debug-raw pre"), null);
  });
});

test("debug switching preserves a reader's disclosure, row identity and streamed output", async () => {
  await withDom(async (root) => {
    await render(root, [command("one"), command("two")]);
    const debug = debugPreference();
    await act(async () => debug.click());
    const row = button(".trace-items .trace-item-toggle");
    await act(async () => row.click());
    const detail = element(".trace-tool-detail");
    await act(async () => debug.click());
    assert.equal(element(".trace-tool-detail"), detail);
    await act(async () => debug.click());
    assert.equal(button(".trace-items .trace-item-toggle"), row);
    assert.equal(row.getAttribute("aria-expanded"), "true");
    await render(root, [
      {
        ...command("one"),
        aggregatedOutput: "streamed update",
        status: "failed",
      },
      command("two"),
    ]);
    assert.equal(element(".trace-tool-detail"), detail);
    assert.match(detail.textContent ?? "", /streamed update/u);
    assert.match(element(".trace-items").textContent ?? "", /Failed/u);
    await act(async () => button(".trace-toggle").click());
    await act(async () => {
      debug.click();
      debug.click();
    });
    assert.equal(
      button(".trace-toggle").getAttribute("aria-expanded"),
      "false",
    );
  });
});

test("canonical JSON is exact and lazy, while external debug honestly exposes only the display projection", async () => {
  await withDom(async (root) => {
    const canonicalItems: CanonicalItem[] = [
      {
        id: "raw-agent",
        type: "agent_message",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-10-04T09:00:00Z",
        text: "Exact <text> with whitespace  ",
      },
    ];
    await render(root, [command("one")], { canonicalItems });
    await act(async () => debugPreference().click());
    const raw = element<HTMLDetailsElement>(
      ".trace-debug-source .trace-debug-raw",
    );
    assert.equal(raw.querySelector("pre"), null);
    await act(async () => {
      raw.open = true;
      raw.dispatchEvent(new window.Event("toggle"));
    });
    assert.deepEqual(
      JSON.parse(raw.querySelector("pre")!.textContent!),
      canonicalItems,
    );
    await render(root, [command("one")], { canonicalItems: undefined });
    assert.match(
      element(".trace-debug-source").textContent ?? "",
      /Only the current display projection is available/u,
    );
    assert.doesNotMatch(
      element(".trace-debug-source").textContent ?? "",
      /Canonical items/u,
    );
  });
});

test("tool-associated compaction stays with its exact tool instead of a standalone event", async () => {
  await withDom(async (root) => {
    const compactTool = {
      ...command("compact-tool"),
      callId: "compact-call",
      toolName: "compact_context",
      command: 'compact_context {"text":"Saved plan"}',
    };
    const canonicalItems = compactionHistory();
    await render(root, [compactTool], { canonicalItems });
    assert.ok(
      document.querySelector(".context-compaction-event") === null,
      "Tool compaction must not create a separate event",
    );
    await act(async () => button(".trace-item-toggle").click());
    assert.ok(
      document.querySelector(".context-compaction-event") === null,
      "Tool compaction must not create a separate event",
    );
    const summary = element<HTMLDetailsElement>(".trace-compaction-summary");
    assert.equal(summary.open, false);
    await act(async () => {
      summary.open = true;
      summary.dispatchEvent(new window.Event("toggle"));
    });
    assert.match(
      element(".trace-compaction-summary .compaction-summary").textContent ??
        "",
      /Saved plan/u,
    );
    await render(
      root,
      [{ ...compactTool, aggregatedOutput: "Completed", status: "completed" }],
      { canonicalItems },
    );
    assert.equal(element(".trace-compaction-summary"), summary);
    assert.equal(document.querySelectorAll(".compaction-summary").length, 1);
    await render(root, [{ ...compactTool, callId: "other-call" }], {
      canonicalItems,
    });
    assert.equal(
      document.querySelectorAll(".context-compaction-event").length,
      1,
    );
    assert.equal(document.querySelector(".trace-compaction-summary"), null);
  });
});

test("a compaction event over a partial display history retains its summary without crashing or inventing context", async () => {
  await withDom(async (root) => {
    const source = compactionHistory().at(-1)!;
    const partial = applyNativeThreadEvent(fixture([command("one")]), {
      type: "item_completed",
      item: source,
    });
    const projected = projectContextCompactions(partial.canonicalItems);
    assert.equal(projected[0]?.effectiveMessages, null);
    assert.match(projected[0]?.snapshotError ?? "", /unavailable/u);
    await render(root, [command("one")], partial);
    await act(async () => button(".context-compaction-toggle").click());
    assert.match(
      element(".compaction-summary").textContent ?? "",
      /Saved plan/u,
    );
    const diagnostics = element<HTMLDetailsElement>(".compaction-projection");
    await act(async () => {
      diagnostics.open = true;
      diagnostics.dispatchEvent(new window.Event("toggle"));
    });
    assert.match(diagnostics.textContent ?? "", /unavailable/u);
    assert.equal(diagnostics.querySelector("ol"), null);
    await render(root, [command("one")], {
      canonicalItems: compactionHistory(),
    });
    assert.match(diagnostics.textContent ?? "", /projected history messages/u);
    assert.equal(
      projectContextCompactions(compactionHistory())[0]?.snapshotError,
      undefined,
    );
  });
});

test("debug singleton and opaque reasoning keep their bodies manual and preserve the completed-turn choice", async () => {
  await withDom(async (root) => {
    await render(
      root,
      [command("one")],
      fixture([command("one")], "completed"),
    );
    const debug = debugPreference();
    assert.equal(document.querySelector(".trace-singleton"), null);
    await act(async () => debug.click());
    assert.equal(button(".turn-toggle").getAttribute("aria-expanded"), "true");
    assert.equal(
      button(".trace-item-toggle").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(document.querySelector(".trace-tool-detail"), null);
    await act(async () => button(".trace-item-toggle").click());
    const detail = element(".trace-tool-detail");
    await act(async () => debug.click());
    assert.equal(button(".turn-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(element(".trace-tool-detail"), detail);
    await act(async () => debug.click());
    assert.equal(element(".trace-tool-detail"), detail);
    await act(async () => button(".turn-toggle").click());
    await act(async () => {
      debug.click();
      debug.click();
    });
    assert.equal(button(".turn-toggle").getAttribute("aria-expanded"), "false");
    await render(root, [
      { type: "reasoning", id: "empty-reasoning", summary: [], content: [] },
    ]);
    assert.equal(
      button(".trace-item-toggle").getAttribute("aria-expanded"),
      "false",
    );
    await act(async () => button(".trace-item-toggle").click());
    const raw = element<HTMLDetailsElement>(".trace-detail .trace-debug-raw");
    await act(async () => {
      raw.open = true;
      raw.dispatchEvent(new window.Event("toggle"));
    });
    assert.equal(
      JSON.parse(raw.querySelector("pre")!.textContent!).id,
      "empty-reasoning",
    );
  });
});

function compactionHistory(): CanonicalItem[] {
  const start: CanonicalItem = {
    id: "started",
    type: "turn_started",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: "2026-10-04T09:00:00Z",
  };
  const compact: ContextCompactionItem = {
    id: "compact",
    type: "context_compaction",
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "compact-call",
    sourceModelResponseId: "response-1",
    createdAt: "2026-10-04T09:00:02Z",
    provenance: "agentic",
    initiator: "agent",
    coveredThroughItemId: "started",
    summary: "Saved plan",
    retainedItemIds: [],
    algorithmVersion: "zen.context-compaction.v2",
  };
  return [
    start,
    {
      id: "compact-tool",
      type: "tool_call",
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "compact-call",
      modelResponseId: "response-1",
      createdAt: "2026-10-04T09:00:01Z",
      name: "compact_context",
      arguments: { text: "Saved plan" },
    },
    compact,
  ];
}

function command(
  id: string,
): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    source: "agent",
    command: `echo ${id}`,
    cwd: "/workspace",
    status: "completed",
    aggregatedOutput: `output ${id}`,
    exitCode: 0,
    durationMs: null,
    processId: null,
    commandActions: [],
    toolName: "shell",
    callId: `call-${id}`,
    toolArguments: { command: `echo ${id}` },
  };
}
function fixture(
  items: ThreadItem[],
  status: Turn["status"] = "inProgress",
): Thread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "test",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: { type: "active", activeFlags: [] },
    path: null,
    cwd: "/workspace",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [
      {
        id: "turn-1",
        items,
        itemsView: "full",
        status,
        error: null,
        startedAt: 1,
        completedAt: status === "inProgress" ? null : 2,
        durationMs: 1,
      },
    ],
  };
}
async function render(
  root: Root,
  items: ThreadItem[],
  options: Partial<Thread> = {},
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(ThreadView, {
        approvals: [],
        composer: emptyComposerState(),
        thread: { ...fixture(items), ...options },
        onDraftChange: () => undefined,
        onInterrupt: noop,
        onRespondToApproval: noop,
        onSubmit: noop,
      }),
    ),
  );
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  assert.ok(result, `Expected ${selector}`);
  return result;
}
function debugPreference() {
  return {
    click: () => {
      const store = getConversationPresentationStore();
      store.setDetail(store.getSnapshot() === "normal" ? "debug" : "normal");
    },
  };
}

function button(selector: string): HTMLButtonElement {
  return element(selector);
}
async function withDom(run: (root: Root) => Promise<void>): Promise<void> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  });
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(element("#root"));
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}
