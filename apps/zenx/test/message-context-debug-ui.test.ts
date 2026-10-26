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

test("per-message inspection never enables capture, displays saved vs attributed input, and fences closed reads", async () => {
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
            ? {
                threadId,
                items: new Map([[item.id, { ...item, threadId }]]),
                captureAvailable: true,
              }
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
    assert.match(
      document.body.textContent!,
      /Saved content, in text-part order/,
    );
    assert.match(
      document.body.textContent!,
      /saved reference <reference>literal<\/reference>/,
    );
    assert.equal(
      commands.length,
      0,
      "canonical inspection does not query captures",
    );
    await act(async () => {
      document.querySelector<HTMLDetailsElement>(
        ".message-context-debug > details",
      )!.open = true;
    });
    await settle();
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
    await act(async () => {
      document.querySelector<HTMLDetailsElement>(
        ".message-context-debug > details",
      )!.open = true;
    });
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
    await act(async () => {
      document.querySelector<HTMLDetailsElement>(
        ".message-context-debug > details",
      )!.open = true;
    });
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

test("canonical content is complete without a Host bridge and labels trusted metadata only", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CanonicalMessageContent } =
    await import("../src/renderer/src/MessageContextDebug.js");
  await i18n.changeLanguage("en");
  const content = [
    { type: "text" as const, text: '[received_at="synthetic-time"]' },
    {
      type: "text" as const,
      text: "literal human text [received_at=not-trusted]",
    },
  ];
  const html = renderToStaticMarkup(
    React.createElement(CanonicalMessageContent, {
      item: {
        ...item,
        text: undefined,
        content,
        contentAuthority: { version: 1, hostTextPartIndices: [0] },
      } as never,
    }),
  );
  assert.match(html, /synthetic-time/);
  assert.match(html, /literal human text/);
  assert.equal((html.match(/Host-authored metadata/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Legacy Item/);
  const legacy = renderToStaticMarkup(
    React.createElement(CanonicalMessageContent, {
      item: { ...item, text: undefined, content } as never,
    }),
  );
  assert.match(legacy, /Legacy Item/);
  assert.match(legacy, /synthetic-time/);
  assert.doesNotMatch(legacy, /Host-authored metadata/);
});

test("materialized content preserves origin and failed operation diagnostics are not model content", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CanonicalMessageContent } =
    await import("../src/renderer/src/MessageContextDebug.js");
  const context = {
    id: "context",
    threadId: "thread",
    createdAt: "2026-01-01T00:00:00Z",
    type: "context_message" as const,
    compilerPolicyVersion: 1 as const,
    sourceItemIds: ["host"],
    role: "user" as const,
    origin: "host" as const,
    purpose: "host-message",
    variant: "fixture",
    content: [{ type: "text" as const, text: "exact committed wrapper" }],
  };
  const html = renderToStaticMarkup(
    React.createElement(CanonicalMessageContent, { item: context }),
  );
  assert.match(html, /host · user · host-message/);
  assert.match(html, /exact committed wrapper/);
  const failed = renderToStaticMarkup(
    React.createElement(CanonicalMessageContent, {
      item: {
        id: "done",
        threadId: "thread",
        createdAt: context.createdAt,
        type: "model_operation_completed",
        operationItemId: "operation",
        status: "failed",
        error: "synthetic transport failure",
      },
    }),
  );
  assert.match(failed, /Host diagnostic/);
  assert.doesNotMatch(failed, /Legacy Item|content\[0\]/);
});
