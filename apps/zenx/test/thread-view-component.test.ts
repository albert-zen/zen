import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { Thread, ThreadItem, Turn } from "../src/protocol-client/index.js";
import type { AttachmentRef } from "../../../src/attachment.js";
import type { ApprovalCardState } from "../src/renderer/src/approval-state.js";
import {
  addComposerImages,
  editComposer,
  emptyComposerState,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });
const { ThreadView } = await import("../src/renderer/src/ThreadView.js");

const noop = async () => undefined;

test("idle composer exposes one disabled Send action when empty", () => {
  const html = render(false, []);
  assert.match(html, /aria-label="Send"/u);
  assert.match(html, /action-orb send/u);
  assert.doesNotMatch(html, /Steer now/u);
});

test("running empty composer exposes Stop without locking the editor", () => {
  const html = render(true, []);
  assert.match(html, /aria-label="Message"/u);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/u);
  assert.match(html, /aria-label="Stop"/u);
});

test("running draft exposes Steer and Interrupt and send", () => {
  const composer = editComposer(emptyComposerState(), "change direction");
  const html = render(true, [], composer);
  assert.match(html, />Steer</u);
  assert.match(html, /aria-label="Interrupt and send"/u);
  assert.doesNotMatch(html, /Interrupt without sending the draft/u);
});

test("pending approvals render in the bottom zone next to the composer", () => {
  const approval = {
    requestId: "approval-1",
    status: "pending",
    decision: null,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      command: "printf ok",
      cwd: "/workspace",
    },
  } as ApprovalCardState;
  const html = render(true, [approval]);
  assert.match(html, /class="bottom-zone"/u);
  assert.match(html, /class="approval-bar"/u);
  assert.match(html, /Allow once/u);
});

test("assistant messages omit the identity row while preserving metadata and content", () => {
  const html = renderTurns([
    turnWithItems("completed", [user("request"), agent("Final answer")], 1_000),
  ]);

  assert.doesNotMatch(html, /class="agent-(?:meta|glyph)"/u);
  assert.match(
    html,
    /class="user-row"[\s\S]*<\/article><button class="turn-toggle"[^>]*><span>Worked for 1s<\/span>/u,
  );
  assert.match(html, /class="agent-copy"[\s\S]*Final answer/u);
});

test("assistant messages retain running reasoning and tool disclosure affordances", () => {
  const html = renderTurns([
    turnWithItems("inProgress", [
      user("Inspect the project"),
      agent("Checking the relevant files."),
      reasoning("Mapped the rendering path"),
      command("rg ThreadView"),
    ]),
  ]);

  assert.doesNotMatch(html, /class="agent-(?:meta|glyph)"/u);
  assert.match(html, /class="turn-running-label"[\s\S]*Working/u);
  assert.match(html, /Checking the relevant files\./u);
  assert.match(
    html,
    /class="trace-toggle"[^>]*aria-expanded="false"[\s\S]*Reasoned and used rg[\s\S]*2 items/u,
  );
});

test("public reasoning with a summary expands from summary to full content", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem(
        "reasoning-public-summary",
        ["Provider summary"],
        ["Full public reasoning"],
      ),
    );
    const toggle = requiredWithin<HTMLButtonElement>(
      row,
      ":scope > .trace-item-toggle",
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(
      requiredWithin(toggle, ":scope > span").textContent,
      "Provider summary",
    );

    await act(async () => toggle.click());
    const detail = requiredWithin(row, ":scope > .trace-detail");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(detail.textContent, "Full public reasoning");
    assert.doesNotMatch(detail.textContent ?? "", /Provider summary/u);
  });
});

test("public reasoning without a summary keeps a neutral expandable label", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem("reasoning-public", [], ["Full public reasoning"]),
    );
    const toggle = requiredWithin<HTMLButtonElement>(
      row,
      ":scope > .trace-item-toggle",
    );
    assert.equal(
      requiredWithin(toggle, ":scope > span").textContent,
      "Reasoning details",
    );

    await act(async () => toggle.click());
    assert.equal(
      requiredWithin(row, ":scope > .trace-detail").textContent,
      "Full public reasoning",
    );
  });
});

test("opaque reasoning with a summary is a static summary row", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem("reasoning-opaque-summary", ["Provider summary"], []),
    );
    const label = requiredWithin(row, ":scope > .trace-item-static > span");
    assert.equal(label.textContent, "Provider summary");
    assert.equal(row.querySelector(":scope > button"), null);
    assert.equal(row.querySelector("[aria-expanded]"), null);
    assert.equal(row.querySelector('[data-icon="chevron-down"]'), null);
    assert.equal(row.querySelector(".trace-detail"), null);
  });
});

test("opaque reasoning without a summary exposes only a neutral static row", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem("reasoning-opaque", [], []),
    );
    assert.equal(
      requiredWithin(row, ":scope > .trace-item-static > span").textContent,
      "Reasoning details",
    );
    assert.equal(row.querySelector(":scope > button"), null);
    assert.equal(row.querySelector("[aria-expanded]"), null);
    assert.equal(row.querySelector('[data-icon="chevron-down"]'), null);
    assert.equal(row.querySelector(".trace-detail"), null);
  });
});

test("streamed public content turns a static row into an expandable completed item", async () => {
  await withDom(async (root) => {
    const id = "reasoning-stream";
    await renderInteractive(
      root,
      turnWithItems("inProgress", [reasoningItem(id, [], [])]),
    );
    await act(async () => requiredButton(".trace-toggle").click());
    assert.ok(document.querySelector(".trace-item-static"));
    assert.equal(document.querySelector(".trace-item-toggle"), null);

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        reasoningItem(id, [], ["Streaming public reasoning"]),
      ]),
    );
    assert.equal(
      requiredButton(".trace-toggle").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      requiredButton(".trace-item-toggle").getAttribute("aria-expanded"),
      "false",
    );

    await renderInteractive(
      root,
      turnWithItems("completed", [
        reasoningItem(id, [], ["Streaming public reasoning"]),
      ]),
    );
    await act(async () => requiredButton(".turn-toggle").click());
    await act(async () => requiredButton(".trace-toggle").click());
    const toggle = requiredButton(".trace-item-toggle");
    await act(async () => toggle.click());
    assert.equal(
      requiredElement(".trace-detail").textContent,
      "Streaming public reasoning",
    );
  });
});

test("resumed user messages expose canonical attachments with accessible preview names", () => {
  const html = renderTurns(
    [turnWithItems("completed", [user(""), agent("Seen")])],
    [],
    emptyComposerState(),
    {
      "user-1": [
        {
          type: "attachment",
          sha256: "a".repeat(64),
          mediaType: "image/png",
          byteLength: 68,
          width: 1,
          height: 1,
        },
      ],
    },
  );
  assert.match(html, /aria-label="Attached images"/u);
  assert.match(html, /aria-label="Preview Attached image 1"/u);
  assert.doesNotMatch(html, /base64|\/tmp\//u);
});

test("images precede text in Composer and transcript, including image-only messages", () => {
  const first: AttachmentRef = {
    type: "attachment",
    sha256: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 4,
    width: 1,
    height: 1,
  };
  const second: AttachmentRef = { ...first, sha256: "b".repeat(64) };
  const composer = addComposerImages(
    editComposer(emptyComposerState(), "line one\nline two"),
    [
      { id: "draft-a", name: "first.png", attachment: first },
      { id: "draft-b", name: "second.png", attachment: second },
    ],
  );
  const composerHtml = renderTurns([], [], composer);
  assert.ok(
    composerHtml.indexOf('class="composer-images"') <
      composerHtml.indexOf('id="thread-composer"'),
  );
  assert.ok(
    composerHtml.indexOf("first.png") < composerHtml.indexOf("second.png"),
  );

  const transcriptHtml = renderTurns(
    [turnWithItems("completed", [user("line one\nline two"), agent("Seen")])],
    [],
    emptyComposerState(),
    { "user-1": [first, second] },
  );
  assert.ok(
    transcriptHtml.indexOf('class="message-images"') <
      transcriptHtml.indexOf("line one"),
  );
  assert.ok(
    transcriptHtml.indexOf('aria-label="Preview Attached image 1"') <
      transcriptHtml.indexOf('aria-label="Preview Attached image 2"'),
  );

  const imageOnlyHtml = renderTurns(
    [turnWithItems("completed", [user(""), agent("Seen")])],
    [],
    emptyComposerState(),
    { "user-1": [first] },
  );
  assert.match(imageOnlyHtml, /class="message-images"/u);
  const userBubbleStart = imageOnlyHtml.indexOf('class="user-bubble"');
  const userBubbleEnd = imageOnlyHtml.indexOf("</article>", userBubbleStart);
  assert.ok(userBubbleStart >= 0 && userBubbleEnd > userBubbleStart);
  assert.doesNotMatch(
    imageOnlyHtml.slice(userBubbleStart, userBubbleEnd),
    /markdown-body|<p>/u,
  );
});

function render(
  active: boolean,
  approvals: readonly ApprovalCardState[],
  composer: ComposerState = emptyComposerState(),
) {
  return renderTurns(active ? [turn()] : [], approvals, composer);
}

function renderTurns(
  turns: Turn[],
  approvals: readonly ApprovalCardState[] = [],
  composer: ComposerState = emptyComposerState(),
  threadAttachments: Parameters<typeof ThreadView>[0]["threadAttachments"] = {},
) {
  return renderToStaticMarkup(
    createElement(ThreadView, {
      approvals,
      composer,
      thread: thread(turns),
      threadAttachments,
      onDraftChange: () => undefined,
      onInterrupt: noop,
      onRespondToApproval: noop,
      onSubmit: noop,
    }),
  );
}

async function openReasoningRow(
  root: Root,
  item: Extract<ThreadItem, { type: "reasoning" }>,
): Promise<HTMLElement> {
  await renderInteractive(root, turnWithItems("inProgress", [item]));
  await act(async () => requiredButton(".trace-toggle").click());
  return requiredElement<HTMLElement>(".trace-item");
}

async function renderInteractive(root: Root, value: Turn): Promise<void> {
  await act(async () =>
    root.render(
      createElement(ThreadView, {
        approvals: [],
        composer: emptyComposerState(),
        thread: thread([value]),
        onDraftChange: () => undefined,
        onInterrupt: noop,
        onRespondToApproval: noop,
        onSubmit: noop,
      }),
    ),
  );
}

async function withDom(run: (root: Root) => Promise<void>): Promise<void> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
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
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
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

function requiredButton(selector: string): HTMLButtonElement {
  return requiredElement<HTMLButtonElement>(selector);
}

function requiredElement<T extends Element = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  assert.ok(value, `Expected ${selector}`);
  return value;
}

function requiredWithin<T extends Element = HTMLElement>(
  parent: ParentNode,
  selector: string,
): T {
  const value = parent.querySelector<T>(selector);
  assert.ok(value, `Expected ${selector}`);
  return value;
}

function thread(turns: Turn[]): Thread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: 10,
    updatedAt: 10,
    recencyAt: null,
    status:
      turns.length === 0
        ? { type: "idle" }
        : { type: "active", activeFlags: [] },
    path: null,
    cwd: "/workspace",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns,
  };
}

function turn(): Turn {
  return turnWithItems("inProgress", []);
}

function turnWithItems(
  status: Turn["status"],
  items: ThreadItem[],
  durationMs: number | null = null,
): Turn {
  return {
    id: "turn-1",
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: 10,
    completedAt: status === "inProgress" ? null : 11,
    durationMs,
  };
}

function user(text: string): ThreadItem {
  return {
    type: "userMessage",
    id: "user-1",
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
  };
}

function agent(text: string): ThreadItem {
  return {
    type: "agentMessage",
    id: `agent-${text}`,
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}

function reasoning(summary: string): ThreadItem {
  return {
    type: "reasoning",
    id: "reasoning-1",
    summary: [summary],
    content: [],
  };
}

function reasoningItem(
  id: string,
  summary: string[],
  content: string[],
): Extract<ThreadItem, { type: "reasoning" }> {
  return { type: "reasoning", id, summary, content };
}

function command(value: string): ThreadItem {
  return {
    type: "commandExecution",
    id: "command-1",
    pluginId: null,
    scriptPath: null,
    command: value,
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "ThreadView.tsx",
    exitCode: 0,
    durationMs: null,
  };
}
