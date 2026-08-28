import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { Thread, ThreadItem, Turn } from "../src/protocol-client/index.js";
import type { AttachmentRef } from "../../../src/attachment.js";
import type { ModelUsageProjection } from "../../../src/model-usage.js";
import { projectCompletedItem } from "../../../src/protocol/codex/mapper.js";
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

test("message controls are Turn-backed, accessible, and stable while hovering", () => {
  const completedAt = new Date();
  completedAt.setHours(12, 34, 0, 0);
  const html = renderTurns([
    {
      ...turnWithItems(
        "completed",
        [user("Copy this *raw* Markdown"), agent("Answer")],
        1_000,
      ),
      completedAt: Math.floor(completedAt.getTime() / 1_000),
    },
  ]);

  assert.match(html, /class="message-actions user-message-actions"/u);
  assert.match(html, /aria-label="Copy user message"/u);
  assert.match(html, /class="message-actions assistant-message-actions"/u);
  assert.match(html, /aria-label="Copy assistant message"/u);
  assert.equal((html.match(/data-icon="copy"/gu) ?? []).length, 2);
  assert.doesNotMatch(html, />Copy<|>Completed /u);
  assert.equal((html.match(/class="message-time"/gu) ?? []).length, 2);
  const todayTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(completedAt);
  assert.equal(
    (html.match(new RegExp(`>${todayTime}</time>`, "gu")) ?? []).length,
    2,
  );
});

test("Turn disclosure does not repeat cache telemetry from assistant actions", () => {
  const html = renderTurns(
    [turnWithItems("completed", [user("request"), agent("Done")], 1_000)],
    [],
    emptyComposerState(),
    {},
    {
      thread: {
        responseCount: 1,
        inputTokens: 150,
        cachedInputTokens: 40,
        outputTokens: 17,
        cacheHitRate: 0.4,
      },
      turns: {
        "turn-1": {
          responseCount: 1,
          inputTokens: 150,
          cachedInputTokens: 40,
          outputTokens: 17,
          cacheHitRate: 0.4,
        },
      },
    },
  );
  const disclosure = html.match(
    /<button class="turn-toggle"[\s\S]*?<\/button>/u,
  )?.[0];

  assert.ok(disclosure);
  assert.doesNotMatch(disclosure, /Cache/u);
  assert.equal((html.match(/Cache 40% · 150 in · 17 out/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /class="turn-usage"/u);
});

test("running Turns do not invent a completion timestamp in message controls", () => {
  const html = renderTurns([
    turnWithItems("inProgress", [user("Still running"), agent("Partial")]),
  ]);

  assert.match(html, /class="message-actions user-message-actions"/u);
  assert.doesNotMatch(html, /class="message-time"/u);
  assert.match(html, /aria-label="Copy user message"/u);
});

test("terminal Turn timestamps show time only today and add a date across local days", () => {
  const today = new Date();
  today.setHours(12, 34, 0, 0);
  const todayTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(today);
  for (const status of ["completed", "interrupted", "failed"] as const) {
    const html = renderTurns([
      {
        ...turnWithItems(status, [user(`${status} request`), agent(status)]),
        completedAt: Math.floor(today.getTime() / 1_000),
      },
    ]);

    assert.equal(
      (html.match(new RegExp(`>${todayTime}</time>`, "gu")) ?? []).length,
      2,
    );
    assert.doesNotMatch(html, />(?:Completed|Interrupted|Failed) /u);
  }

  const otherDay = new Date(today);
  otherDay.setDate(today.getDate() === 1 ? 2 : today.getDate() - 1);
  const otherDate = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(otherDay);
  const otherTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(otherDay);
  const html = renderTurns([
    {
      ...turnWithItems("completed", [user("Earlier"), agent("Earlier answer")]),
      completedAt: Math.floor(otherDay.getTime() / 1_000),
    },
  ]);
  assert.equal(
    (html.match(new RegExp(`>${otherDate} ${otherTime}</time>`, "gu")) ?? [])
      .length,
    2,
  );
});

test("reasoning detail uses the safe Markdown renderer", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem(
        "reasoning-markdown",
        ["Reasoning"],
        ["**bold**\n\n`code`"],
      ),
    );
    await act(async () => requiredButton(".trace-item-toggle").click());
    const detail = requiredElement(".trace-detail");
    assert.match(detail.innerHTML, /<strong>bold<\/strong>/u);
    assert.match(detail.innerHTML, /<code>code<\/code>/u);
  });
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

test("renders compact token-weighted cache usage for the Thread and each Turn", () => {
  const html = renderTurns(
    [
      turnWithItems("completed", [user("request"), agent("Done")], 1_000),
      { ...turnWithItems("completed", [agent("Again")]), id: "turn-2" },
    ],
    [],
    emptyComposerState(),
    {},
    {
      thread: {
        responseCount: 3,
        inputTokens: 200,
        cachedInputTokens: 50,
        outputTokens: 25,
        cacheHitRate: 1 / 3,
      },
      turns: {
        "turn-1": {
          responseCount: 2,
          inputTokens: 150,
          cachedInputTokens: 40,
          outputTokens: 17,
          cacheHitRate: 0.4,
        },
        "turn-2": {
          responseCount: 1,
          inputTokens: 50,
          outputTokens: 8,
        },
      },
    },
  );

  assert.match(html, /Thread cache 33% · 200 in · 25 out/u);
  assert.match(html, /Cache 40% · 150 in · 17 out/u);
  assert.match(html, /Cache unknown · 50 in · 8 out/u);
  assert.doesNotMatch(html, /Cache 0% · 50 in/u);
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

test("renders one trace Item directly and wraps only a sequence of two or more", () => {
  const singleton = renderTurns([
    turnWithItems("inProgress", [reasoning("Mapped the rendering path")]),
  ]);
  assert.match(singleton, /class="trace-item trace-singleton"/u);
  assert.doesNotMatch(singleton, /class="trace-group"/u);
  assert.doesNotMatch(singleton, /[>]1 items[<]/u);

  const grouped = renderTurns([
    turnWithItems("inProgress", [
      reasoning("Mapped the rendering path"),
      command("rg ThreadView"),
    ]),
  ]);
  assert.match(grouped, /class="trace-group"/u);
  assert.match(grouped, /[>]2 items[<]/u);
});

test("singleton promotion preserves its disclosure and focused button", async () => {
  await withDom(async (root) => {
    const first = reasoningItem(
      "reasoning-promote",
      ["Mapped the rendering path"],
      ["Public reasoning"],
    );
    await renderInteractive(root, turnWithItems("inProgress", [first]));
    const singletonToggle = requiredButton(".trace-singleton > button");
    singletonToggle.focus();
    await act(async () => singletonToggle.click());
    assert.equal(singletonToggle.getAttribute("aria-expanded"), "true");

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        commandItem("command-promote", "rg ThreadView"),
      ]),
    );
    const groupToggle = requiredButton(".trace-group > .trace-toggle");
    assert.equal(groupToggle, singletonToggle);
    assert.equal(document.activeElement, groupToggle);
    assert.equal(groupToggle.getAttribute("aria-expanded"), "true");
    assert.equal(
      requiredElement(".trace-group .trace-item .trace-detail").textContent,
      "Public reasoning",
    );

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        reasoningItem(
          "reasoning-promote",
          ["Mapped the rendering path"],
          ["Updated public reasoning"],
        ),
        commandItem("command-promote", "rg ThreadView"),
      ]),
    );
    assert.equal(requiredButton(".trace-group > .trace-toggle"), groupToggle);
    assert.equal(document.activeElement, groupToggle);
    assert.equal(
      requiredElement(".trace-group .trace-item .trace-detail").textContent,
      "Updated public reasoning",
    );
  });
});

test("tool singleton promotion preserves its open detail", async () => {
  await withDom(async (root) => {
    const first = commandItem("command-promote-first", "rg ThreadView");
    await renderInteractive(root, turnWithItems("inProgress", [first]));
    await act(async () => requiredButton(".trace-singleton > button").click());

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        reasoningItem("reasoning-promote-second", ["Mapped"], []),
      ]),
    );
    const detail = requiredElement(".trace-group .trace-item .trace-detail");
    assert.equal(requiredWithin(detail, "code").textContent, "rg ThreadView");
    assert.match(detail.textContent ?? "", /ThreadView\.tsx/u);
  });
});

test("collapsed singleton promotes to a collapsed trace group", async () => {
  await withDom(async (root) => {
    const first = reasoningItem(
      "reasoning-promote-closed",
      ["Mapped the rendering path"],
      ["Public reasoning"],
    );
    await renderInteractive(root, turnWithItems("inProgress", [first]));
    assert.equal(
      requiredButton(".trace-singleton > button").getAttribute("aria-expanded"),
      "false",
    );

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        commandItem("command-promote-closed", "rg ThreadView"),
      ]),
    );
    assert.equal(
      requiredButton(".trace-group > .trace-toggle").getAttribute(
        "aria-expanded",
      ),
      "false",
    );
  });
});

test("streaming append preserves an explicitly closed trace group", async () => {
  await withDom(async (root) => {
    const first = reasoningItem("reasoning-close", ["Mapped"], []);
    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        commandItem("command-close-a", "rg ThreadView"),
      ]),
    );
    const toggle = requiredButton(".trace-toggle");
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    toggle.focus();

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        commandItem("command-close-a", "rg ThreadView"),
        commandItem("command-close-b", "npm test"),
      ]),
    );
    const updated = requiredButton(".trace-toggle");
    assert.equal(updated, toggle);
    assert.equal(document.activeElement, updated);
    assert.equal(updated.getAttribute("aria-expanded"), "false");
  });
});

test("terminal transition folds intermediate trace before Turn history reopens", async () => {
  await withDom(async (root) => {
    const items = [
      reasoningItem("reasoning-terminal", ["Mapped"], []),
      commandItem("command-terminal", "npm test"),
    ];
    await renderInteractive(root, turnWithItems("inProgress", items));
    await act(async () => requiredButton(".trace-toggle").click());
    assert.equal(
      requiredButton(".trace-toggle").getAttribute("aria-expanded"),
      "true",
    );

    await renderInteractive(
      root,
      turnWithItems("completed", [...items, agent("Done")]),
    );
    assert.equal(document.querySelector(".trace-toggle"), null);
    await act(async () => requiredButton(".turn-toggle").click());
    assert.equal(
      requiredButton(".trace-toggle").getAttribute("aria-expanded"),
      "false",
    );
  });
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

test("projected public reasoning keeps its summary label and expandable content", async () => {
  const projected = projectCompletedItem({
    type: "reasoning",
    id: "reasoning-projected-public-summary",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: "2026-08-27T00:00:00.000Z",
    reasoningContent: "Projected public reasoning",
    summary: "Projected provider summary",
    contentVisibility: "public",
  });
  assert.ok(projected?.type === "reasoning");

  await withDom(async (root) => {
    const row = await openReasoningRow(root, projected);
    const toggle = requiredWithin<HTMLButtonElement>(
      row,
      ":scope > .trace-item-toggle",
    );
    assert.equal(
      requiredWithin(toggle, ":scope > span").textContent,
      "Projected provider summary",
    );

    await act(async () => toggle.click());
    assert.equal(
      requiredWithin(row, ":scope > .trace-detail").textContent,
      "Projected public reasoning",
    );
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
    assert.ok(document.querySelector(".trace-item-static"));
    assert.equal(document.querySelector(".trace-item-toggle"), null);

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        reasoningItem(id, [], ["Streaming public reasoning"]),
      ]),
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
  threadUsage?: ModelUsageProjection,
) {
  return renderToStaticMarkup(
    createElement(ThreadView, {
      approvals,
      composer,
      thread: thread(turns),
      threadAttachments,
      threadUsage,
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
  return requiredElement<HTMLElement>(".trace-singleton");
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
  return commandItem("command-1", value);
}

function commandItem(id: string, value: string): ThreadItem {
  return {
    type: "commandExecution",
    id,
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
