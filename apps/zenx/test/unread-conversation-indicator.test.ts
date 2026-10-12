import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { ZenXProjectProjectionSnapshot } from "../src/main/project-projection.js";

Object.assign(globalThis, { React });
const { act, createElement } = React;
const { Sidebar } = await import("../src/renderer/src/Sidebar.js");
const noop = () => undefined;

function summary(threadId: string): NativeThreadSummary {
  return {
    threadId,
    name: threadId,
    preview: "",
    archived: false,
    status: "idle",
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd: "/work/a",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  };
}

const projects: ZenXProjectProjectionSnapshot = {
  projects: [
    {
      key: "/work/a",
      workspace: "/work/a",
      configured: true,
      isDefault: true,
      threadIds: ["seen", "fresh"],
    },
  ],
  unavailableThreadIds: [],
  lastUsedWorkspace: "/work/a",
};

test("Sidebar marks unread Threads and Rooms without touching the active row", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window, {
    zenx: {
      platform: "darwin",
      plugins: { executeCommand: async () => ({ rooms: [] }) },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          mode: "projects",
          open: true,
          onClose: noop,
          onNewThread: noop,
          onAddProject: noop,
          onRemoveProject: noop,
          onSetDefaultProject: noop,
          onOpenContribution: noop,
          onOpenSettings: noop,
          onChangeThreadLifecycle: async () => undefined,
          onChangeThreadPinned: async () => undefined,
          onRenameThread: async () => undefined,
          onRetryThreads: noop,
          onSelectThread: noop,
          pendingApprovalThreadIds: new Set<string>(),
          pluginContributions: [],
          projects,
          sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
          selectedPage: "/plugins/zenx-rooms/rooms?roomId=room-1",
          selectedRoomId: "room-1",
          selectedThreadId: "seen",
          serverStatus: { type: "ready", reconnected: false },
          liveThread: null,
          threadError: null,
          threadLoading: false,
          threads: [summary("seen"), summary("fresh")],
          pinnedThreads: [],
          roomConversations: {
            rooms: [
              {
                id: "room-1",
                name: "Design",
                members: [{ name: "Ana", threadId: "ana" }],
                memberCount: 1,
                messagePreview: "hi",
                lastMessageAt: 10,
              },
              {
                id: "room-2",
                name: "Research",
                members: [{ name: "Bo", threadId: "bo" }],
                memberCount: 1,
                messagePreview: "new result",
                lastMessageAt: 20,
              },
            ],
            error: null,
            loading: false,
          },
          unreadThreadIds: new Set(["fresh"]),
          unreadRoomIds: new Set(["room-2"]),
        }),
      ),
    );
    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>(".projects-section-toggle")
        ?.click();
    });

    const freshDot = dom.window.document.querySelector(
      '[data-thread-id="fresh"] .unread-dot',
    );
    assert.ok(freshDot, "background Thread with new activity shows the dot");
    assert.equal(freshDot?.getAttribute("aria-label"), "Unread messages");
    assert.equal(
      dom.window.document.querySelector('[data-thread-id="seen"] .unread-dot'),
      null,
      "the Thread on screen stays read even with newer activity",
    );
    assert.ok(
      dom.window.document.querySelector(
        '[aria-label="Open room Research"] .room-conversation-unread',
      ),
    );
    assert.equal(
      dom.window.document.querySelector(
        '[aria-label="Open room Design"] .room-conversation-unread',
      ),
      null,
      "the Room on screen never shows unread",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
