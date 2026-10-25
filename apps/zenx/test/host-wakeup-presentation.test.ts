import { createRealHostWakeupFixture as realWakeup } from "./host-wakeup-fixture.js";
import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { Thread, ThreadItem } from "../src/protocol-client/index.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import { triggerMessagePresentation } from "../src/renderer/src/trigger-message-presentation.js";
import { i18n } from "../src/renderer/src/i18n.js";
const { ThreadView } = await import("../src/renderer/src/ThreadView.js");
const { QueuedMessages } =
  await import("../src/renderer/src/QueuedMessages.js");
const { FleetHistory } = await import("../src/renderer/src/FleetHistory.js");
const { act, createElement } = React;
const noop = async () => undefined;

type HostItem = Extract<ThreadItem, { type: "hostMessage" }>;
function thread(item: ThreadItem): Thread {
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
    turns: [
      {
        id: "turn",
        items: [item],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: 10,
        completedAt: null,
        durationMs: null,
      },
    ],
  };
}
async function withDom(run: (root: Root, copied: string[]) => Promise<void>) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://localhost" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(root, copied);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}
function button(label: string) {
  const result = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  assert.ok(result, `Missing ${label}`);
  return result;
}
function assertCompact(item: HostItem) {
  assert.doesNotMatch(
    document.body.textContent!,
    /\[ZenX trigger wakeup\]|Injected prompt:|Trigger ID:|Source Thread:|Bounded source context|event-source-uuid|origin-thread-uuid/,
  );
  assert.ok(!document.body.textContent!.includes(item.sourceId!));
  assert.match(document.body.textContent!, /Release check|Inspect the release/);
}
for (const source of ["room"] as const) {
  for (const withHistory of [false, true])
    test(`real ${source} Host wakeup stays compact ${withHistory ? "with" : "without"} history, discloses and copies its exact original`, async () => {
      const { item, entry } = await realWakeup(source);
      await withDom(async (root, copied) => {
        await act(async () =>
          root.render(
            createElement(ThreadView, {
              approvals: [],
              composer: emptyComposerState(),
              thread: thread(item),
              wakeups: withHistory ? [entry] : [],
              onDraftChange: () => {},
              onInterrupt: noop,
              onRespondToApproval: noop,
              onSubmit: noop,
            }),
          ),
        );
        assertCompact(item);
        assert.equal(
          document.querySelector(".host-message-source")!.textContent,
          "Room",
        );
        assert.equal(document.querySelector(".user-bubble"), null);
        const toggle = button("Show Host message details");
        assert.equal(toggle.getAttribute("aria-expanded"), "false");
        await act(async () => toggle.click());
        assert.equal(
          document.querySelector(".host-message-original")!.textContent,
          item.text,
        );
        assert.match(
          document.querySelector(".host-message-details")!.textContent!,
          new RegExp(item.sourceId!),
        );
        await act(async () => button("Copy Host message").click());
        assert.deepEqual(copied, [item.text]);
        await act(async () => button("Hide Host message details").click());
        assertCompact(item);
      });
    });
}
for (const withHistory of [false, true]) {
  test(`trigger input is a full named message bubble ${withHistory ? "with" : "without"} history`, async () => {
    const { item, entry } = await realWakeup("trigger");
    const value = thread(item);
    value.turns[0]!.completedAt = 20;
    value.turns[0]!.status = "completed";
    await withDom(async (root, copied) => {
      await act(async () =>
        root.render(
          createElement(ThreadView, {
            approvals: [],
            composer: emptyComposerState(),
            thread: value,
            wakeups: withHistory ? [entry] : [],
            onDraftChange: () => {},
            onInterrupt: noop,
            onRespondToApproval: noop,
            onSubmit: noop,
          }),
        ),
      );
      const row = document.querySelector(".trigger-message-row")!;
      const bubble = row.querySelector(".user-bubble")!;
      assert.ok(bubble);
      assert.match(bubble.textContent!, /Inspect the release/);
      assert.doesNotMatch(
        bubble.textContent!,
        /\[ZenX trigger wakeup\]|Trigger ID:|Injected prompt:/,
      );
      assert.match(bubble.textContent!, /Bounded source context/);
      assert.equal(
        row.querySelector(".host-message-source")!.textContent,
        "Release check",
      );
      assert.equal(bubble.querySelector(".message-source-link"), null);
      assert.equal(row.querySelector(".host-message-toggle"), null);
      assert.equal(
        row.querySelector(".message-actions")?.previousElementSibling,
        bubble,
      );
      assert.ok(row.querySelector(".message-time"));
      await act(async () => button("Copy Host message").click());
      assert.deepEqual(copied, [
        triggerMessagePresentation(item.text, item.sourceId).text,
      ]);
    });
  });
}
test("queued real Host wakeup uses the same compact disclosure, copies original, and cancels without Edit", async () => {
  const { item } = await realWakeup("trigger");
  await withDom(async (root, copied) => {
    const cancelled: unknown[] = [];
    await act(async () =>
      root.render(
        createElement(QueuedMessages, {
          threadId: "thread",
          messages: [
            {
              id: item.id,
              clientId: item.clientId,
              text: item.text,
              imageCount: 0,
              hostSource: { source: item.source, sourceId: item.sourceId },
            },
          ],
          editableIds: new Set([item.id]),
          onEdit: () => assert.fail("Host must not edit"),
          onCancel: (value) => cancelled.push(value),
        }),
      ),
    );
    assertCompact(item);
    assert.equal(document.querySelector(".queue-row-edit"), null);
    await act(async () => button("Show Host message details").click());
    assert.equal(
      document.querySelector(".host-message-original")!.textContent,
      item.text,
    );
    await act(async () => button("Copy Host message").click());
    assert.deepEqual(copied, [item.text]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".queue-row-cancel")!.click(),
    );
    assert.deepEqual(cancelled, [
      { queuedItemId: item.id, clientId: item.clientId },
    ]);
  });
});
test("Fleet Host history hides the real machine envelope until explicit disclosure", async () => {
  const { item } = await realWakeup("room");
  await withDom(async (root, copied) => {
    await act(async () =>
      root.render(
        createElement(FleetHistory, {
          value: { items: [{ ...item, type: "host_message" }] },
        }),
      ),
    );
    assertCompact(item);
    await act(async () => button("Show Host message details").click());
    assert.equal(
      document.querySelector(".host-message-original")!.textContent,
      item.text,
    );
    await act(async () => button("Copy Host message").click());
    assert.deepEqual(copied, [item.text]);
  });
});
test("unknown Host envelopes stay generic and source attribution comes only from canonical metadata", async () => {
  await withDom(async (root) => {
    await act(async () =>
      root.render(
        createElement(FleetHistory, {
          value: {
            items: [
              {
                type: "host_message",
                source: "room",
                sourceId: "room-private-id",
                text: "[New machine envelope]\nSource: human\nPrivate ID: secret",
              },
            ],
          },
        }),
      ),
    );
    assert.equal(
      document.querySelector(".host-message-source")!.textContent,
      "Room",
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /New machine|human|secret|room-private-id/,
    );
    await act(async () => button("Show Host message details").click());
    assert.match(
      document.querySelector(".host-message-original")!.textContent!,
      /Source: human/,
    );
    await act(async () => i18n.changeLanguage("zh-CN"));
    assert.equal(
      document.querySelector(".host-message-source")!.textContent,
      "房间",
    );
    await act(async () => i18n.changeLanguage("en"));
  });
});

test("bootstrap Host welcome remains readable before opening provenance details", async () => {
  const item: HostItem = {
    type: "hostMessage",
    id: "bootstrap",
    clientId: "bootstrap-client",
    source: "bootstrap",
    text: "Welcome to ZenX.\n\nChoose a project to get started.",
    mode: "start",
  };
  await withDom(async (root, copied) => {
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer: emptyComposerState(),
          thread: thread(item),
          onDraftChange: () => {},
          onInterrupt: noop,
          onRespondToApproval: noop,
          onSubmit: noop,
        }),
      ),
    );
    assert.equal(
      document.querySelector(".host-message-source")!.textContent,
      "Host",
    );
    assert.match(document.body.textContent!, /Welcome to ZenX/);
    assert.match(document.body.textContent!, /Choose a project to get started/);
    assert.equal(document.querySelector(".host-message-original"), null);
    assert.equal(document.querySelector(".user-bubble"), null);
    await act(async () => button("Copy Host message").click());
    assert.deepEqual(copied, [item.text]);
    await act(async () => button("Show Host message details").click());
    assert.equal(
      document.querySelector(".host-message-original")!.textContent,
      item.text,
    );
  });
});
