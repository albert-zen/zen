import "./dom-primitives.js";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { ThreadDebugger } from "../src/renderer/src/ThreadDebugger.js";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import {
  runtimeThread,
  runtimeMessage,
} from "./fixtures/agent-runtime-data.js";
import { nativeRecoveryForThread } from "./native-recovery-fixture.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });
const noop = async () => undefined;
const base = runtimeThread(
  [runtimeMessage("answer", "**visible answer**")],
  "interrupted",
  "thread",
);
const items = nativeRecoveryForThread(base).thread.items;
const thread = { ...base, canonicalItems: items };
async function dom(
  run: (root: ReturnType<typeof createRoot>) => Promise<void>,
) {
  const previous = { window: globalThis.window, document: globalThis.document };
  const d = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: d.window,
    document: d.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: false });
    d.window.close();
  }
}
test("Items preserves canonical order and renders hidden metadata alongside shared Markdown without capture", async () =>
  dom(async (root) => {
    await act(async () =>
      root.render(
        createElement(ThreadDebugger, {
          thread,
          items,
          localModelDebug: true,
        }),
      ),
    );
    assert.deepEqual(
      [...document.querySelectorAll("[data-item-id]")].map((e) =>
        e.getAttribute("data-item-id"),
      ),
      items.map((i) => i.id),
    );
    assert.equal(
      document.querySelector('[data-item-id="answer"] strong')?.textContent,
      "agent_message",
    );
    assert.ok(
      document
        .querySelector('[data-item-id="answer"]')
        ?.innerHTML.includes("<strong>visible answer</strong>"),
    );
    assert.equal(document.querySelectorAll(".thread-debug-json pre").length, 0);
    const disclosure =
      document.querySelector<HTMLDetailsElement>(".thread-debug-json")!;
    await act(async () => {
      disclosure.open = true;
      disclosure.dispatchEvent(new window.Event("toggle"));
    });
    assert.deepEqual(
      JSON.parse(disclosure.querySelector("pre")!.textContent!),
      items[0],
    );
    assert.equal(document.querySelector('[role="switch"]'), null);
  }));
test("normal views have no debug navigation row; controlled debug exits inline", async () =>
  dom(async (root) => {
    const props = {
      thread,
      approvals: [],
      composer: emptyComposerState(),
      onDraftChange: noop,
      onInterrupt: noop,
      onRespondToApproval: noop,
      onSubmit: noop,
    };
    const render = (debugMode = false) =>
      root.render(
        createElement(ThreadView, {
          ...props,
          debugMode,
          onExitDebug: () => render(false),
        }),
      );
    await act(async () => render());
    assert.equal(document.querySelector(".thread-view-switch"), null);
    assert.equal(document.querySelector(".thread-debugger"), null);
    assert.ok(document.querySelector(".thread-view"));
    await act(async () => render(true));
    assert.ok(document.querySelector(".thread-debugger"));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(
      document.querySelectorAll(".thread-debug-tabs button[aria-pressed]")
        .length,
      1,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-debug-exit")!.click(),
    );
    assert.equal(document.querySelector(".thread-debugger"), null);
    assert.ok(document.querySelector(".thread-view"));
  }));
test("tool results use inert shared fallback; opaque reasoning and hostile strings stay literal", async () =>
  dom(async (root) => {
    const common = {
      threadId: thread.id,
      turnId: "turn",
      createdAt: "2026-10-14T00:00:00Z",
    };
    const extra: typeof items = [
      {
        ...common,
        id: "call",
        type: "tool_call",
        callId: "c",
        name: "shell",
        arguments: { command: "echo test" },
      },
      {
        ...common,
        id: "result",
        type: "tool_result",
        callId: "c",
        output: "<script>window.pwned=true</script>",
        exitCode: 0,
        contentType: "danger",
        structuredContent: { text: "safe" },
      },
      {
        ...common,
        id: "opaque",
        type: "reasoning",
        contentVisibility: "opaque",
        reasoningContent: "OPAQUE_SECRET",
        summary: "Public summary",
      },
    ];
    await act(async () =>
      root.render(
        createElement(ThreadDebugger, {
          thread,
          items: extra,
        }),
      ),
    );
    assert.equal(document.querySelectorAll("script").length, 0);
    assert.ok(
      document
        .querySelector(".tool-result-fallback")
        ?.textContent?.includes("<script>"),
    );
    assert.ok(document.body.textContent?.includes("Public summary"));
    assert.ok(!document.body.textContent?.includes("OPAQUE_SECRET"));
    assert.equal(
      document.querySelectorAll(".message-copy,.message-fork").length,
      0,
    );
    const d = document.querySelector<HTMLDetailsElement>(
      '[data-item-id="opaque"] details',
    )!;
    await act(async () => {
      d.open = true;
      d.dispatchEvent(new window.Event("toggle"));
    });
    assert.ok(d.textContent?.includes("OPAQUE_SECRET"));
  }));
test("debugger remounts for a different Thread without retaining Item JSON", async () =>
  dom(async (root) => {
    const render = async (value: typeof thread, debugMode = true) =>
      act(async () =>
        root.render(
          createElement(ThreadView, {
            thread: value,
            debugMode,
            approvals: [],
            composer: emptyComposerState(),
            onDraftChange: noop,
            onInterrupt: noop,
            onRespondToApproval: noop,
            onSubmit: noop,
          }),
        ),
      );
    await render(thread);
    const d = document.querySelector<HTMLDetailsElement>(".thread-debug-json")!;
    await act(async () => {
      d.open = true;
      d.dispatchEvent(new window.Event("toggle"));
    });
    await render({ ...thread, id: "another", canonicalItems: [] }, false);
    assert.equal(document.querySelector(".thread-debugger"), null);
    await render({ ...thread, id: "another", canonicalItems: [] });
    assert.equal(document.querySelectorAll("[data-item-id]").length, 0);
  }));

test("normal conversation fills its flex surface when history and Composer are absolute", () => {
  const css = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.thread-conversation-surface > \.thread-view\s*\{[^}]*flex:\s*1;/,
  );
});
