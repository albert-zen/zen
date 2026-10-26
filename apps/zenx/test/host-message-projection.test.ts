import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type {
  CanonicalItem,
  HostMessageItem,
  QueuedHostMessageItem,
} from "../../../src/item.js";
import type { Thread, ThreadItem, Turn } from "../src/protocol-client/index.js";
import { isClientRequestMethod } from "../src/protocol-client/methods.js";
import { nativeRecoveryForThread } from "./native-recovery-fixture.js";
import {
  applyNativeThreadEvent,
  applyThreadViewNotification,
  projectNativeRecovery,
} from "../src/renderer/src/thread-view-state.js";
import { projectTurn } from "../src/renderer/src/turn-projection.js";
import { cancellationResultsFromItems } from "../src/renderer/src/queue-cancel-state.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import {
  projectRemoteItem,
  projectRemoteRecoveryPage,
} from "../../../src/protocol/native/remote-host.js";
import { readThreadHistory } from "../src/main/thread-history.js";
import { i18n } from "../src/renderer/src/i18n.js";
Object.assign(globalThis, { React });
const { ThreadView } = await import("../src/renderer/src/ThreadView.js");
const { QueuedMessages } =
  await import("../src/renderer/src/QueuedMessages.js");
const { FleetHistory } = await import("../src/renderer/src/FleetHistory.js");
const stamp = "2026-10-13T00:00:00.000Z";
const noop = async () => undefined;
function host(source: HostMessageItem["source"] = "trigger"): HostMessageItem {
  return {
    id: `host-${source}`,
    threadId: "thread",
    turnId: "turn",
    createdAt: stamp,
    type: "host_message",
    sender: "host",
    clientId: `client-${source}`,
    source,
    ...(source === "bootstrap" ? {} : { sourceId: `private-${source}-id` }),
    text: `Wake from ${source}`,
    mode: "start",
  };
}
function queue(id: string): QueuedHostMessageItem {
  return {
    id,
    threadId: "thread",
    createdAt: stamp,
    type: "host_message_queued",
    sender: "host",
    clientId: `client-${id}`,
    source: "trigger",
    sourceId: "private-trigger-id",
    text: "Pending wake",
    input: [{ type: "text", text: "Pending wake" }],
    intent: "steer",
    deliveryMode: "batch-next",
  };
}
function projected(
  item: HostMessageItem,
): Extract<ThreadItem, { type: "hostMessage" }> {
  return {
    id: item.id,
    type: "hostMessage",
    clientId: item.clientId,
    source: item.source,
    ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }),
    text: item.text,
    mode: item.mode,
    ...(item.deliveryAfter === undefined
      ? {}
      : { deliveryAfter: item.deliveryAfter }),
  };
}
function turn(items: ThreadItem[] = []): Turn {
  return {
    id: "turn",
    items,
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
}
function thread(items: ThreadItem[] = []): Thread {
  return {
    id: "thread",
    sessionId: "thread",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "fake",
    createdAt: 10,
    updatedAt: 10,
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
    turns: [turn(items)],
  };
}

test("native Host wake is typed and recovery/live replay retain distinct provenance", () => {
  assert.equal(isClientRequestMethod("zen/turn/wake"), true);
  const items = [
    host("bootstrap"),
    host("trigger"),
    { ...host("room"), mode: "steer" as const, deliveryAfter: "response" },
  ];
  const recovery = nativeRecoveryForThread(thread(items.map(projected)));
  const recovered = projectNativeRecovery(recovery);
  assert.deepEqual(recovered.turns[0]!.items, items.map(projected));
  assert.equal(recovered.preview, "");
  let live = projectNativeRecovery(nativeRecoveryForThread(thread()));
  for (const item of items) {
    live = applyNativeThreadEvent(live, { type: "item_completed", item });
    live = applyNativeThreadEvent(live, { type: "item_completed", item });
  }
  assert.deepEqual(live.turns[0]!.items, recovered.turns[0]!.items);
  assert.equal(
    live.canonicalItems!.filter((item) => item.type === "host_message").length,
    3,
  );
});

test("Host queue delivery and cancellation remove exact pending identities, including stale snapshots", () => {
  let current = projectNativeRecovery(nativeRecoveryForThread(thread()));
  const first = queue("first"),
    second = queue("second");
  for (const item of [first, second])
    current = applyNativeThreadEvent(current, { type: "item_completed", item });
  const stale = current.queuedMessages!;
  assert.deepEqual(stale[0]!.hostSource, {
    source: "trigger",
    sourceId: "private-trigger-id",
  });
  assert.equal(stale[0]!.sender, undefined);
  const delivered = { ...host(), clientId: first.clientId };
  current = applyNativeThreadEvent(current, {
    type: "item_completed",
    item: delivered,
  });
  const canceled: CanonicalItem = {
    id: "cancel",
    type: "host_message_cancelled",
    threadId: "thread",
    createdAt: stamp,
    queuedItemId: second.id,
    clientId: second.clientId,
  };
  current = applyNativeThreadEvent(current, {
    type: "item_completed",
    item: canceled,
  });
  current = applyThreadViewNotification(current, "thread/queue/updated", {
    threadId: "thread",
    queuedMessages: stale,
  });
  assert.deepEqual(current.queuedMessages, []);
  assert.deepEqual(
    cancellationResultsFromItems(
      current.canonicalItems!,
      [first, second].map((item) => ({
        queuedItemId: item.id,
        clientId: item.clientId,
      })),
    ),
    [
      {
        queuedItemId: first.id,
        clientId: first.clientId,
        status: "already_started",
      },
      {
        queuedItemId: second.id,
        clientId: second.clientId,
        status: "already_cancelled",
      },
    ],
  );
  assert.equal(
    cancellationResultsFromItems(
      [first],
      [{ queuedItemId: first.id, clientId: first.clientId }],
    ),
    null,
  );
});

test("Host steering preserves delivery anchors and separates trace batches", () => {
  const initial = projected(host("bootstrap"));
  const steer = projected({
    ...host("room"),
    mode: "steer",
    deliveryAfter: "response",
  });
  const thinking: ThreadItem = {
    type: "reasoning",
    id: "response",
    summary: ["Thinking"],
    content: [],
  };
  const later: ThreadItem = { ...thinking, id: "later" };
  const view = projectTurn(turn([initial, thinking, later, steer]));
  assert.deepEqual(view.inputItems, [initial]);
  assert.deepEqual(
    view.history.map((node) => [
      node.kind,
      node.kind === "agent" ? node.item.id : node.id,
    ]),
    [
      ["traceItem", "response"],
      ["input", steer.id],
      ["traceItem", "later"],
    ],
  );
  const compacted = projectTurn(
    turn([initial, { ...steer, deliveryAfter: "compacted-response" }]),
  );
  assert.deepEqual(compacted.history, [
    {
      kind: "input",
      id: steer.id,
      item: { ...steer, deliveryAfter: "compacted-response" },
    },
  ]);
});

test("Trigger input uses a full bubble while other Host sources retain compact provenance and copy actions", async () => {
  for (const language of ["en", "zh-CN"]) {
    await i18n.changeLanguage(language);
    const html = renderToStaticMarkup(
      React.createElement(ThreadView, {
        approvals: [],
        composer: emptyComposerState(),
        thread: thread(
          [host("bootstrap"), host("trigger"), host("room")].map(projected),
        ),
        onDraftChange: () => {},
        onInterrupt: noop,
        onRespondToApproval: noop,
        onSubmit: noop,
      }),
    );
    const dom = new JSDOM(html);
    try {
      const rows = [
        ...dom.window.document.querySelectorAll(".host-message-row"),
      ];
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map(
          (row) => row.querySelector(".host-message-source")!.textContent,
        ),
        language === "en" ? ["Host", "Room"] : ["宿主", "房间"],
      );
      assert.ok(rows.every((row) => !row.textContent!.includes("private-")));
      const trigger = dom.window.document.querySelector(
        ".trigger-message-row",
      )!;
      assert.ok(trigger);
      assert.equal(
        trigger.querySelector(".host-message-source")!.textContent,
        language === "en" ? "Trigger" : "触发器",
      );
      assert.equal(
        trigger.querySelector(".user-bubble")!.textContent,
        "Wake from trigger",
      );
      assert.equal(trigger.querySelector(".host-message-toggle"), null);
      assert.equal(trigger.textContent!.includes("private-"), false);
      assert.equal(
        trigger.querySelector(".message-actions")!.previousElementSibling
          ?.className,
        "user-bubble",
      );
      assert.ok(
        trigger.querySelector(
          `[aria-label="${i18n.t("shell:copyHostMessage")}"]`,
        ),
      );
      assert.ok(
        trigger
          .querySelector(".host-message-source")!
          .getAttribute("title")!
          .includes(i18n.t("shell:sourceNavigationUnavailable")),
      );
      assert.ok(
        rows.every((row) =>
          row.querySelector(
            `[aria-label="${i18n.t("shell:copyHostMessage")}"]`,
          ),
        ),
      );
    } finally {
      dom.window.close();
    }
  }
  await i18n.changeLanguage("en");
});

test("Host queue rows stay cancellable and never offer human editing", () => {
  const html = renderToStaticMarkup(
    React.createElement(QueuedMessages, {
      threadId: "thread",
      messages: [
        {
          id: "pending",
          clientId: "client",
          text: "Wake",
          imageCount: 0,
          hostSource: { source: "trigger", sourceId: "private-trigger-id" },
        },
      ],
      editableIds: new Set(["pending"]),
      onEdit: () => assert.fail("Host editing must not be offered"),
      onCancel: () => {},
    }),
  );
  const dom = new JSDOM(html);
  try {
    assert.equal(dom.window.document.querySelector(".queue-row-edit"), null);
    assert.ok(dom.window.document.querySelector(".queue-row-cancel"));
    assert.equal(
      dom.window.document.querySelector(".host-message-source")!.textContent,
      "Trigger",
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent!,
      /private-trigger-id/,
    );
  } finally {
    dom.window.close();
  }
});

test("Fleet public Host projection retains provenance through large-message pagination", () => {
  const item = { ...host("room"), text: "長".repeat(150_000) };
  const view = projectRemoteItem(item)!;
  assert.deepEqual(view, {
    id: item.id,
    threadId: item.threadId,
    turnId: item.turnId,
    createdAt: item.createdAt,
    type: "host_message",
    text: item.text,
    source: "room",
    sourceId: item.sourceId,
    mode: "start",
  });
  const snapshot = nativeRecoveryForThread(thread([projected(item)])).thread;
  const boundary = {
    processEpoch: "epoch",
    threadId: "thread",
    watermark: 4,
    itemCount: snapshot.items.length,
  };
  let position = { itemIndex: 0, textOffset: 0 },
    reconstructed = "",
    fragments = 0;
  for (;;) {
    const { page, next } = projectRemoteRecoveryPage(
      snapshot,
      boundary,
      position,
    );
    for (const entry of page.entries) {
      if (entry.kind === "text_fragment") {
        assert.equal(entry.item.type, "host_message");
        assert.equal(entry.item.source, "room");
        assert.equal(entry.item.sourceId, item.sourceId);
        reconstructed += entry.text;
        fragments++;
      }
    }
    if (next === null) break;
    position = next;
  }
  assert.ok(fragments > 1);
  assert.equal(reconstructed, item.text);
  assert.equal(projectRemoteItem(queue("pending")), null);
});

test("Fleet history displays Host provenance as readable source labels", () => {
  const html = renderToStaticMarkup(
    React.createElement(FleetHistory, {
      value: { items: [host("bootstrap"), host("trigger"), host("room")] },
    }),
  );
  const dom = new JSDOM(html);
  try {
    assert.deepEqual(
      [...dom.window.document.querySelectorAll("article strong")].map(
        (node) => node.textContent,
      ),
      ["Host", "Trigger", "Room"],
    );
    assert.doesNotMatch(dom.window.document.body.textContent!, /private-|You/);
    assert.match(
      dom.window.document
        .querySelectorAll("article strong span")[1]!
        .getAttribute("title")!,
      /private-trigger-id/,
    );
  } finally {
    dom.window.close();
  }
});

test("bounded local Host history retains source labels without raw JSON in the message body", () => {
  const item = { ...host("trigger"), text: "Wake context. ".repeat(100) };
  const snapshot = nativeRecoveryForThread(thread([projected(item)])).thread;
  const value = readThreadHistory(snapshot, {
    granularity: "items",
    maxTurns: 5,
    maxItemsPerTurn: 20,
  });
  const html = renderToStaticMarkup(
    React.createElement(FleetHistory, { value }),
  );
  const dom = new JSDOM(html);
  try {
    assert.match(dom.window.document.body.textContent!, /Trigger/);
    assert.match(dom.window.document.body.textContent!, /Triggered update/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /Wake context/);
    assert.doesNotMatch(
      dom.window.document.body.textContent!,
      /private-trigger-id|client-trigger|host_message/,
    );
    assert.ok(
      dom.window.document.querySelector('span[title*="private-trigger-id"]'),
    );
  } finally {
    dom.window.close();
  }
});

test("Host cancellation recovery cannot mistake human receipt kinds for Host receipts", () => {
  const pending = queue("pending");
  const target = { queuedItemId: pending.id, clientId: pending.clientId };
  const humanCancel: CanonicalItem = {
    id: "wrong-cancel",
    type: "user_message_queue_cancelled",
    threadId: pending.threadId,
    createdAt: stamp,
    ...target,
  };
  const humanDelivery: CanonicalItem = {
    id: "wrong-delivery",
    type: "user_message",
    threadId: pending.threadId,
    turnId: "turn",
    createdAt: stamp,
    clientId: pending.clientId,
    text: pending.text,
  };
  assert.equal(
    cancellationResultsFromItems([pending, humanCancel], [target]),
    null,
  );
  assert.equal(
    cancellationResultsFromItems([pending, humanDelivery], [target]),
    null,
  );
});
