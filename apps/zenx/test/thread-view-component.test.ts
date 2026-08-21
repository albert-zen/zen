import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { Thread, ThreadItem, Turn } from "../src/protocol-client/index.js";
import type { ApprovalCardState } from "../src/renderer/src/approval-state.js";
import {
  editComposer,
  emptyComposerState,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";
const { createElement } = React;
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
