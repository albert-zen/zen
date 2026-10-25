import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  MessageContextDebugAction,
  MessageContextDebugContext,
} from "../src/renderer/src/MessageContextDebug.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
} from "../../cli/src/model-request-debug-types.js";
const item = {
  type: "user_message" as const,
  createdAt: "2026-01-01T00:00:00Z",
  id: "item",
  threadId: "thread",
  turnId: "turn",
  text: "saved reference <reference>literal</reference>",
};
const result: ModelRequestDebugResult = {
  sessionId: "session",
  generation: 1,
  enabled: true,
  retainedCount: 1,
  retainedBytes: 100,
  evictedCount: 0,
  limits: {
    maxRecords: 64,
    maxBytes: 1000,
    maxRecordBytes: 1000,
    pageCharacters: 1000,
  },
  records: [
    {
      id: "capture",
      capturedAt: "2026-01-01T00:00:00Z",
      threadId: "thread",
      turnId: "turn",
      purpose: "turn",
      sampleId: "sample",
      sampleAttempt: 1,
      transportAttempt: 1,
      contextBoundaryItemId: "item",
      provider: "test",
      model: "test-model",
      format: "chat-completions",
      redacted: true,
      truncated: false,
      originalBytes: 100,
      retainedBytes: 100,
      sourceAttachments: [],
      sourceAttachmentCount: 0,
      messageSources: [{ itemId: "item", container: "messages", index: 0 }],
    },
  ],
};

test("per-message experiment never enables capture, displays saved vs attributed input, and fences closed reads", async () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "http://localhost" },
  );
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  await i18n.changeLanguage("en");
  const root = createRoot(document.getElementById("root")!);
  const commands: ModelRequestDebugCommand[] = [];
  let currentResult = structuredClone(result);
  let resolveRead: ((value: ModelRequestDebugResult) => void) | undefined;
  (window as unknown as { zenx: unknown }).zenx = {
    modelRequestDebug: {
      request: async (command: ModelRequestDebugCommand) => {
        commands.push(command);
        if (command.action === "read")
          return new Promise<ModelRequestDebugResult>((resolve) => {
            resolveRead = resolve;
          });
        return structuredClone(currentResult);
      },
    },
  };
  const render = (enabled: boolean, threadId = "thread") =>
    root.render(
      React.createElement(
        MessageContextDebugContext.Provider,
        {
          value: enabled
            ? { threadId, items: new Map([[item.id, { ...item, threadId }]]) }
            : null,
        },
        React.createElement(MessageContextDebugAction, { itemId: item.id }),
      ),
    );
  const settle = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const click = async (label: string) => {
    const found = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent?.includes(label),
    );
    assert(found, label);
    await act(async () => {
      found.click();
    });
    await settle();
  };
  try {
    await act(async () => render(false));
    assert.equal(document.querySelectorAll("button").length, 0);
    await act(async () => render(true));
    await click("Inspect message input");
    assert.match(document.body.textContent!, /Exact saved message content/);
    assert.match(
      document.body.textContent!,
      /saved reference <reference>literal<\/reference>/,
    );
    assert.deepEqual(commands[0], {
      action: "list",
      threadId: "thread",
      itemId: "item",
    });
    await click("test-model");
    assert.deepEqual(commands.at(-1), {
      action: "read",
      id: "capture",
      view: "message",
      itemId: "item",
      offset: 0,
    });
    await act(async () =>
      resolveRead!({
        ...result,
        page: {
          record: result.records![0]!,
          view: "message",
          text: '{"role":"user","content":"[redacted] provider content"}',
          offset: 0,
          nextOffset: null,
          totalCharacters: 61,
        },
      }),
    );
    assert.match(
      document.body.textContent!,
      /Actual captured provider field after redaction/,
    );
    assert.match(document.body.textContent!, /provider content/);
    currentResult = { ...result, generation: 2, records: [] };
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100));
    });
    assert.doesNotMatch(document.body.textContent!, /provider content/);
    assert.equal(
      document.querySelectorAll(".message-context-debug-records button").length,
      0,
    );
    currentResult = structuredClone(result);
    await click("Refresh");
    await click("test-model");
    const previousThreadRead = resolveRead!;
    currentResult = { ...result, records: [] };
    await act(async () => render(true, "another-thread"));
    await settle();
    await act(async () =>
      previousThreadRead({
        ...result,
        page: {
          record: result.records![0]!,
          view: "message",
          text: "previous thread payload",
          offset: 0,
          nextOffset: null,
          totalCharacters: 23,
        },
      }),
    );
    assert.doesNotMatch(document.body.textContent!, /previous thread payload/);
    assert.deepEqual(commands.at(-1), {
      action: "list",
      threadId: "another-thread",
      itemId: "item",
    });
    currentResult = structuredClone(result);
    await act(async () => render(true));
    await settle();
    await click("test-model");
    await click("Close message input");
    await act(async () =>
      resolveRead!({
        ...result,
        page: {
          record: result.records![0]!,
          view: "message",
          text: "late secret",
          offset: 0,
          nextOffset: null,
          totalCharacters: 11,
        },
      }),
    );
    assert.doesNotMatch(document.body.textContent!, /late secret/);
    assert.equal(
      commands.some((command) => command.action === "setEnabled"),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: false });
    dom.window.close();
  }
});
