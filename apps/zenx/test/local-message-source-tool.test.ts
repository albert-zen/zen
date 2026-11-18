import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { CanonicalItem } from "../../../src/item.js";
import { resolveSourceTool } from "../src/renderer/src/tool-action-targets.js";
import {
  MessageTargetNavigationContext,
  useMessageTargetNavigation,
  type MessageTargetRequest,
} from "../src/renderer/src/message-target-navigation.js";
import { runtimeIntro, runtimeThread } from "./fixtures/agent-runtime-data.js";

const call = (
  id: string,
  callId = "same-call-name",
  threadId = "sender",
): CanonicalItem => ({
  type: "tool_call",
  id,
  callId,
  threadId,
  turnId: "turn",
  createdAt: "2026-11-10T00:00:00Z",
  name: "zenx_subagents_send",
  arguments: { target: "Same name", text: "Identical message" },
});

test("sender provenance resolves only exact canonical tool/thread/call identities", () => {
  const items = [
    call("other"),
    call("exact", "exact-call"),
    call("foreign", "exact-call", "elsewhere"),
  ];
  assert.deepEqual(
    resolveSourceTool(items, "sender", {
      itemId: "exact",
      callId: "exact-call",
    }),
    { itemId: "exact" },
  );
  for (const source of [
    { itemId: "missing", callId: "exact-call" },
    { itemId: "exact", callId: "same-call-name" },
    { itemId: "foreign", callId: "exact-call" },
    { itemId: "", callId: "exact-call" },
    { itemId: "exact", callId: "" },
  ])
    assert.equal(resolveSourceTool(items, "sender", source), undefined);
  assert.equal(
    resolveSourceTool(
      [
        {
          ...call("exact", "exact-call"),
          type: "agent_message",
          text: "Identical message",
        } as CanonicalItem,
      ],
      "sender",
      { itemId: "exact", callId: "exact-call" },
    ),
    undefined,
  );
});

test("tool request reuses canonical source navigation only for its current Thread and request", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.local" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const thread = runtimeThread(runtimeIntro, "completed");
  const calls: unknown[] = [];
  const consumed: number[] = [];
  const navigate = (quote: unknown) => {
    calls.push(quote);
    return true;
  };
  const consume = (id: number) => consumed.push(id);
  const pause = () => {};
  function View() {
    const viewport = useRef<HTMLDivElement>(null);
    useMessageTargetNavigation(thread, viewport, pause, undefined, navigate);
    return React.createElement("div", { ref: viewport });
  }
  const root = createRoot(document.getElementById("root")!);
  const render = (request: MessageTargetRequest | null) =>
    root.render(
      React.createElement(
        MessageTargetNavigationContext.Provider,
        { value: { request, consumed: consume } },
        React.createElement(View),
      ),
    );
  try {
    await act(async () =>
      render({
        threadId: "another-owner",
        itemId: "exact",
        requestId: 1,
        sourceTool: true,
      }),
    );
    assert.deepEqual(calls, []);
    await act(async () =>
      render({
        threadId: thread.id,
        itemId: "exact",
        requestId: 2,
        sourceTool: true,
      }),
    );
    assert.deepEqual(calls, [
      { threadId: thread.id, id: "exact", excerpt: "" },
    ]);
    assert.deepEqual(consumed, [2]);
    await act(async () =>
      render({
        threadId: thread.id,
        itemId: "exact",
        requestId: 2,
        sourceTool: true,
      }),
    );
    assert.equal(calls.length, 1);
    await act(async () =>
      render({
        threadId: thread.id,
        itemId: "different",
        requestId: 3,
        sourceTool: true,
      }),
    );
    assert.deepEqual(calls[1], {
      threadId: thread.id,
      id: "different",
      excerpt: "",
    });
    assert.deepEqual(consumed, [2, 3]);

    // A queued source reveal must not survive a switch away from its owner.
    const queue = globalThis.queueMicrotask;
    const pending: (() => void)[] = [];
    try {
      globalThis.queueMicrotask = (callback) => pending.push(callback);
      await act(async () =>
        render({
          threadId: thread.id,
          itemId: "stale",
          requestId: 4,
          sourceTool: true,
        }),
      );
      await act(async () =>
        render({
          threadId: "another-owner",
          itemId: "stale",
          requestId: 5,
          sourceTool: true,
        }),
      );
      pending.forEach((callback) => callback());
      assert.equal(calls.length, 2);
      assert.deepEqual(consumed, [2, 3]);
    } finally {
      globalThis.queueMicrotask = queue;
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});
