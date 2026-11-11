import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import type { CanonicalItem } from "../../../src/item.js";
import { projectInformationCommunications as project } from "../src/renderer/src/information-communications.js";
import { InformationCommunications } from "../src/renderer/src/InformationCommunications.js";
import {
  MessageSourceNavigationContext,
  type MessageSourceNavigator,
} from "../src/renderer/src/message-source-navigation.js";
import { i18n } from "../src/renderer/src/i18n.js";
const message = (id: string, extra = {}): CanonicalItem => ({
  type: "thread_message",
  id,
  threadId: "owner",
  turnId: "turn",
  createdAt: "2026-11-10T00:00:00Z",
  mode: "steer",
  messageType: "guidance",
  clientId: id,
  sender: {
    threadId: "sender",
    threadName: "Same name",
    toolCallId: `tool-${id}`,
    callId: `call-${id}`,
  },
  content: [{ type: "text", text: "Identical message" }],
  ...extra,
});
test("only latest three loaded local canonical inbound facts; identical text is not deduplicated", () => {
  const p = project("owner", "owner", false, [
    message("1"),
    message("2"),
    message("3"),
    message("4"),
  ])!;
  assert.deepEqual(
    p.messages.map((x) => x.id),
    ["4", "3", "2"],
  );
  assert.deepEqual(p.messages[1]?.sourceTool, {
    itemId: "tool-3",
    callId: "call-3",
  });
  assert.equal(
    project("owner", "owner", false, [message("1"), message("1")])?.messages
      .length,
    1,
  );
});
test("pending, absent, stale owner, and non-Thread selections expose nothing", () => {
  for (const [owner, loaded, pending, items] of [
    [null, "owner", false, [message("1")]],
    ["other", "owner", false, [message("1")]],
    ["owner", "owner", true, [message("1")]],
    ["owner", undefined, false, undefined],
  ] as const)
    assert.equal(project(owner, loaded, pending, items), undefined);
});
test("foreign, queued, remote and incomplete provenance never enter native summary", () => {
  const items = [
    message("foreign", { threadId: "other" }),
    message("queued", { type: "thread_message_queued" }),
    message("remote", {
      sender: {
        threadId: "sender",
        toolCallId: "tool",
        callId: "call",
        deviceId: "remote",
      },
    }),
    message("missing", {
      sender: { threadId: "sender", toolCallId: "", callId: "call" },
    }),
  ];
  assert.deepEqual(project("owner", "owner", false, items)?.messages, []);
});
test("excerpt is bounded plain text, whitespace normalized; no markup or identity guessing", () => {
  const p = project("owner", "owner", false, [
    message("long", {
      content: [{ type: "text", text: "<script> x\n" + "z".repeat(300) }],
    }),
  ])!;
  assert.equal(p.messages[0]?.excerpt.length, 181);
  assert.ok(!p.messages[0]?.excerpt.includes("\n"));
});
test("native source button targets exact canonical call and retires owner on switch", async () => {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.local" });
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const observed: Parameters<MessageSourceNavigator>[] = [];
  const navigate: MessageSourceNavigator = async (...args) => {
    observed.push(args);
  };
  const projection = project("owner", "owner", false, [
    message("A"),
    message("B"),
  ]);
  const render = (ownerThreadId: string) =>
    React.createElement(
      MessageSourceNavigationContext.Provider,
      { value: navigate },
      React.createElement(InformationCommunications, {
        ownerThreadId,
        projection,
      }),
    );
  try {
    await act(async () => root.render(render("owner")));
    const excerpts = document.querySelectorAll(
      ".information-communications-excerpt",
    );
    assert.equal(excerpts.length, 2);
    assert.deepEqual(
      [...excerpts].map((node) => [node.tagName, node.textContent]),
      [
        ["P", "Identical message"],
        ["P", "Identical message"],
      ],
    );
    assert.equal(
      document
        .querySelector(".information-communications-scope")
        ?.classList.contains("information-communications-excerpt"),
      false,
    );
    const buttons = document.querySelectorAll<HTMLButtonElement>("button");
    assert.equal(buttons.length, 2);
    assert.equal(observed.length, 0);
    buttons[1]!.focus();
    assert.equal(document.activeElement, buttons[1]);
    // Native button activation uses the same click path for keyboard and pointer.
    await act(async () => buttons[1]!.click());
    assert.equal(observed.length, 1);
    const [navigation] = observed;
    assert.ok(navigation);
    assert.deepEqual(navigation[0], {
      kind: "thread",
      id: "sender",
      sourceTool: { itemId: "tool-A", callId: "call-A" },
    });
    assert.equal(navigation[1].threadId, "owner");
    assert.equal(navigation[1].isCurrent(), true);
    await act(async () => root.render(render("different")));
    assert.equal(document.querySelectorAll("button").length, 0);
    assert.equal(navigation[1].isCurrent(), false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
test("App and Room binding gates keep private projection out of generic plugin context", () => {
  const read = (name: string) =>
    readFileSync(
      new URL(`../src/renderer/src/${name}`, import.meta.url),
      "utf8",
    );
  assert.match(
    read("App.tsx"),
    /page === "agent" && !selectedRoomId && newThreadDraft === null/,
  );
  assert.match(read("App.tsx"), /threadLoading \|\| !!threadError/);
  assert.match(
    read("EditableInformationPanel.tsx"),
    /owner.kind === "thread"[\s\S]*communications\?\.ownerThreadId === owner.threadId/,
  );
  assert.match(
    read("ConversationInformationCards.tsx"),
    /\(\) => \(\{ threadId, threads \}\)/,
  );
  assert.doesNotMatch(
    read("information-communications.ts"),
    /window\.|executeCommand|readThread/,
  );
});

test("native Lineage shows received messages without descendants and hides stale/empty owners", async () => {
  const { ConversationInformationCards } =
    await import("../src/renderer/src/ConversationInformationCards.js");
  const { createPluginUiRegistry } =
    await import("../src/renderer/src/plugin-ui-host.js");
  const { registerSubagentsUi } =
    await import("../src/renderer/src/subagents-ui.js");
  const { workspaceLauncherSnapshot } =
    await import("./workspace-launcher-snapshot.js");
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.local" });
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: string[] = [];
  Object.assign(dom.window, {
    zenx: {
      plugins: {
        executeCommand: async (_p: string, command: string) => {
          calls.push(command);
          return { threads: [] };
        },
        readHandle: async () => null,
      },
    },
  });
  const registry = createPluginUiRegistry();
  registerSubagentsUi(registry);
  const root = createRoot(document.getElementById("root")!);
  const visibility: boolean[] = [];
  const projection = project("owner", "owner", false, [message("A")]);
  const render = (threadId: string, communications = projection) =>
    act(async () =>
      root.render(
        React.createElement(ConversationInformationCards, {
          threadId,
          communications,
          threads: [],
          snapshot: workspaceLauncherSnapshot,
          registry,
          theme: "light",
          navigate() {},
          types: ["lineage"],
          onVisibilityChange: (v: boolean) => visibility.push(v),
        }),
      ),
    );
  try {
    await render("owner");
    assert.equal(visibility.at(-1), true);
    assert.match(
      document.querySelector(".information-communications")!.textContent!,
      /Identical message/,
    );
    assert.equal(document.querySelector(".subagents-panel"), null);
    assert.deepEqual([...new Set(calls)], ["list"]); // Existing lineage roster only, no transcript read.
    await render("other");
    assert.equal(visibility.at(-1), false);
    assert.equal(document.querySelector(".information-communications"), null);
    await render("owner", project("owner", "owner", false, []));
    assert.equal(visibility.at(-1), false);
    assert.equal(document.querySelector(".information-communications"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

test("received excerpts have scoped body typography rather than muted metadata", () => {
  const css = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  // Two local classes outrank the shared Information section/panel paragraph
  // defaults. This checks the scoped style contract, not rendered contrast.
  const rule = css.match(
    /\.information-communications \.information-communications-excerpt\s*\{([^}]+)\}/,
  )?.[1];
  assert.ok(rule);
  assert.match(rule, /font-size: 13px;/);
  assert.match(rule, /line-height: 1\.5;/);
  assert.match(rule, /color: var\(--color-text-primary\);/);
  assert.doesNotMatch(rule, /opacity:|!important/);
  assert.doesNotMatch(css, /(?:^|\n)\.information-communications-excerpt\s*\{/);
});
