import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { Thread, Turn } from "../src/protocol-client/index.js";
import type { ApprovalCardState } from "../src/renderer/src/approval-state.js";
import {
  editComposer,
  emptyComposerState,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";
import { ThreadView } from "../src/renderer/src/ThreadView.js";

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

function render(
  active: boolean,
  approvals: readonly ApprovalCardState[],
  composer: ComposerState = emptyComposerState(),
) {
  return renderToStaticMarkup(
    createElement(ThreadView, {
      approvals,
      composer,
      thread: thread(active ? [turn()] : []),
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
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
}
