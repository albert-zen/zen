import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { Thread, Turn } from "../src/protocol-client/index.js";
import type { ApprovalCardState } from "../src/renderer/src/approval-state.js";
import {
  beginComposerSubmission,
  editComposer,
  emptyComposerState,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { capabilityToolName } from "../src/renderer/src/ThreadView.js";

const noop = async () => undefined;

test("idle composer exposes only normal send", () => {
  const html = render(false, []);
  assert.match(html, />Send</);
  assert.doesNotMatch(html, /Steer now/);
  assert.doesNotMatch(html, /Interrupt &amp; send/);
  assert.doesNotMatch(html, /Queue/i);
});

test("active composer stays editable and exposes three distinct actions", () => {
  const html = render(true, []);
  assert.match(html, /aria-label="Message"/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/);
  assert.match(html, /Steer now/);
  assert.match(html, /Interrupt &amp; send/);
  assert.match(html, /Interrupt without sending the draft/);
  assert.doesNotMatch(html, /Queue/i);
});

test("pending approval explains steer and hard-steer behavior", () => {
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
  assert.match(html, /does not approve the pending command/);
  assert.match(html, /Interrupt &amp; send cancels it/);
});

test("pending submission fences duplicate actions without locking the editor", () => {
  const composer = beginComposerSubmission(
    editComposer(emptyComposerState(), "guidance"),
    "steer",
    "turn-1",
    () => "message-1",
  );
  const html = render(true, [], composer);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/);
  assert.match(html, /<button[^>]*disabled[^>]*>.*Steering…/s);
  assert.match(html, /Adding guidance to the current turn/);
});

test("labels capability audit cards separately from shell commands", () => {
  assert.equal(
    capabilityToolName('browser_inspect {"sessionId":"one"}'),
    "browser_inspect",
  );
  assert.equal(capabilityToolName("printf hello"), null);
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
    modelProvider: "fake",
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
