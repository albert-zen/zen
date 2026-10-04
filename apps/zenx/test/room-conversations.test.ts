import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Sidebar } from "../src/renderer/src/Sidebar.js";
import {
  ROOM_ROUTE,
  roomConversationRoute,
  useRoomConversations,
  type RoomConversationState,
} from "../src/renderer/src/room-conversations.js";
import type { LoadedPluginContribution } from "../src/renderer/src/plugin-contributions.js";

const noop = () => undefined;
const companion = {
  id: "assistant /中文",
  name: "Daily companion",
  assistant: { threadId: "assistant-thread", triggerId: "assistant-trigger" },
  members: [{ name: "Companion", threadId: "assistant-thread" }],
  memberCount: 1,
  messagePreview: "Ready to help",
};
const room = {
  id: "team",
  name: "Design team",
  members: [
    { name: "Designer", threadId: "designer" },
    { name: "Reviewer", threadId: "reviewer" },
  ],
  memberCount: 2,
  messagePreview: null,
};

test("Sidebar opens grouped PAW conversations and Rooms without duplicating plugin navigation or creating Threads", async () => {
  await withDom(async (root) => {
    const opened: string[] = [];
    let threadActions = 0;
    await act(async () =>
      root.render(
        React.createElement(
          Sidebar,
          sidebarProps({
            roomConversations: {
              rooms: [room, companion],
              error: null,
              loading: false,
            },
            selectedRoomId: companion.id,
            selectedPage: ROOM_ROUTE,
            onOpenContribution: (route: string) => opened.push(route),
            onNewThread: () => {
              threadActions += 1;
            },
            onSelectThread: () => {
              threadActions += 1;
            },
          }),
        ),
      ),
    );
    assert.ok(document.querySelector('[aria-label="PAW"]'));
    assert.ok(document.querySelector('[aria-label="Rooms"]'));
    assert.equal(
      document.querySelectorAll('.plugin-space-link[title="Rooms"]').length,
      0,
    );
    assert.ok(document.querySelector('.plugin-space-link[title="Triggers"]'));
    const navigationOrder = Array.from(
      document.querySelector(".sidebar-scroll")!.children,
    ).map((element) => element.className);
    assert.ok(
      navigationOrder.indexOf("plugin-spaces") <
        navigationOrder.indexOf("room-conversations"),
      "plugin spaces precede conversation sections",
    );
    assert.ok(
      navigationOrder.indexOf("room-conversations") <
        navigationOrder.indexOf("sidebar-view-head"),
      "conversation sections are peers before Projects, not inside plugin spaces",
    );
    assert.equal(
      document.querySelector(".plugin-spaces .room-conversations"),
      null,
    );
    const selected = button("Open PAW Daily companion");
    assert.equal(selected.getAttribute("aria-current"), "page");
    assert.equal(selected.type, "button");
    assert.equal(
      button("Open room Design team").getAttribute("aria-current"),
      null,
    );
    await act(async () => selected.click());
    await act(async () => button("Open room Design team").click());
    await act(async () => button("New PAW").click());
    await act(async () => button("New room").click());
    assert.deepEqual(opened, [
      roomConversationRoute(companion.id),
      roomConversationRoute(room.id),
      `${ROOM_ROUTE}?create=companion`,
      `${ROOM_ROUTE}?create=room`,
    ]);
    assert.equal(threadActions, 0);
    assert.equal(document.querySelectorAll("#primary-sidebar").length, 1);
    assert.ok(document.querySelector(".projects-section-toggle"));
  });
});

test("disabled discovery has no conversation section and preserves generic plugin navigation", async () => {
  await withDom(async (root) => {
    await act(async () =>
      root.render(React.createElement(Sidebar, sidebarProps())),
    );
    assert.equal(document.querySelector(".room-conversations"), null);
    assert.ok(document.querySelector('.plugin-space-link[title="Rooms"]'));
  });
});

test("conversation error remains visible and selecting a Thread clears Room selection semantics", async () => {
  await withDom(async (root) => {
    const opened: string[] = [];
    await act(async () =>
      root.render(
        React.createElement(
          Sidebar,
          sidebarProps({
            roomConversations: {
              rooms: [room, companion],
              error: "Rooms unavailable",
              loading: false,
            },
            selectedRoomId: companion.id,
            selectedPage: "agent",
            onOpenContribution: (route: string) => opened.push(route),
          }),
        ),
      ),
    );
    assert.equal(
      button("Open PAW Daily companion").getAttribute("aria-current"),
      null,
    );
    assert.match(
      document.querySelector('.room-conversation-error[role="alert"]')
        ?.textContent ?? "",
      /Rooms unavailable/u,
    );
    const open = document.querySelector<HTMLButtonElement>(
      ".room-conversation-error button",
    );
    assert.ok(open);
    await act(async () => open.click());
    assert.deepEqual(opened, [ROOM_ROUTE]);
  });
});

test("StrictMode keeps a single admitted discovery loop and its unmount clears the timer", async () => {
  await withDom(async (root) => {
    const timers = controlledTimers();
    let calls = 0;
    setExecute(async () => {
      calls += 1;
      return { rooms: [storedRoom("one")], nextCursor: null };
    });
    await act(async () =>
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(Discovery),
        ),
      ),
    );
    assert.equal(calls, 1);
    assert.equal(timers.pending.size, 1);
    await act(async () => root.unmount());
    assert.equal(timers.pending.size, 0);
  });
});

test("discovery pages the existing read command and projects only bounded navigation facts", async () => {
  await withDom(async (root) => {
    const calls: unknown[][] = [];
    setExecute(async (...args) => {
      calls.push(args);
      return (args[2] as { cursor: number }).cursor === 0
        ? {
            rooms: [
              storedRoom("one", {
                assistant: companion.assistant,
                messages: [{ text: "x".repeat(400) }],
              }),
            ],
            nextCursor: 1,
          }
        : { rooms: [storedRoom("two")], nextCursor: null };
    });
    await act(async () => root.render(React.createElement(Discovery)));
    assert.deepEqual(calls, [
      ["zenx-rooms", "list", { cursor: 0 }],
      ["zenx-rooms", "list", { cursor: 1 }],
    ]);
    const state = discoveryState();
    assert.deepEqual(
      state.rooms.map((entry) => entry.id),
      ["one", "two"],
    );
    assert.equal(state.rooms[0]?.memberCount, 1);
    assert.equal(state.rooms[0]?.messagePreview?.length, 120);
    assert.equal(state.rooms[0]?.assistant?.threadId, "assistant-thread");
    assert.equal(state.loading, false);
    assert.equal(state.error, null);
  });
});

test("disabled hook never reads and a late read cannot repopulate it", async () => {
  await withDom(async (root) => {
    let calls = 0;
    const pending = deferred<unknown>();
    setExecute(async () => {
      calls += 1;
      return await pending.promise;
    });
    await act(async () =>
      root.render(React.createElement(Discovery, { enabled: false })),
    );
    assert.equal(calls, 0);
    assert.deepEqual(discoveryState(), {
      rooms: [],
      error: null,
      loading: false,
    });
    await act(async () =>
      root.render(React.createElement(Discovery, { enabled: true })),
    );
    assert.equal(calls, 1);
    await act(async () =>
      root.render(React.createElement(Discovery, { enabled: false })),
    );
    await act(async () =>
      pending.resolve({ rooms: [storedRoom("late")], nextCursor: null }),
    );
    assert.deepEqual(discoveryState(), {
      rooms: [],
      error: null,
      loading: false,
    });
  });
});

test("manual refresh joins one read and polling starts only after the read settles", async () => {
  await withDom(async (root) => {
    const timers = controlledTimers();
    let calls = 0;
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    setExecute(async () => {
      calls += 1;
      return await (calls === 1 ? first : second).promise;
    });
    await act(async () => root.render(React.createElement(Discovery)));
    await act(async () => {
      button("Refresh conversations").click();
      button("Refresh conversations").click();
    });
    assert.equal(calls, 1);
    assert.equal(timers.pending.size, 0);
    await act(async () =>
      first.resolve({ rooms: [storedRoom("first")], nextCursor: null }),
    );
    assert.equal(timers.pending.size, 1);
    assert.equal([...timers.pending.values()][0]?.delay, 3000);
    await act(async () => timers.fire());
    assert.equal(calls, 2);
    assert.equal(timers.pending.size, 0);
    await act(async () => root.unmount());
    await act(async () =>
      second.resolve({ rooms: [storedRoom("second")], nextCursor: null }),
    );
    assert.equal(timers.pending.size, 0);
  });
});

test("revision replacement fences old results and waits for its read before requesting the next generation", async () => {
  await withDom(async (root) => {
    let calls = 0;
    const first = deferred<unknown>();
    setExecute(async () => {
      calls += 1;
      return calls === 1
        ? await first.promise
        : { rooms: [storedRoom("current")], nextCursor: null };
    });
    await act(async () =>
      root.render(React.createElement(Discovery, { revision: 1 })),
    );
    await act(async () =>
      root.render(React.createElement(Discovery, { revision: 2 })),
    );
    assert.equal(calls, 1);
    await act(async () =>
      first.resolve({ rooms: [storedRoom("obsolete")], nextCursor: null }),
    );
    assert.equal(calls, 2);
    assert.deepEqual(
      discoveryState().rooms.map((entry) => entry.id),
      ["current"],
    );
  });
});

test("a changed admission revision hides old Room facts before passive effects run", async () => {
  await withDom(async (root) => {
    const observed: Array<{ revision: number; ids: string[] }> = [];
    let calls = 0;
    const pending = deferred<unknown>();
    setExecute(async () => {
      calls += 1;
      return calls === 1
        ? { rooms: [storedRoom("old")], nextCursor: null }
        : await pending.promise;
    });
    function Observe({ revision }: { revision: number }) {
      const state = useRoomConversations(true, revision);
      React.useLayoutEffect(() => {
        observed.push({ revision, ids: state.rooms.map((entry) => entry.id) });
      }, [revision]);
      return null;
    }
    await act(async () =>
      root.render(React.createElement(Observe, { revision: 1 })),
    );
    await act(async () =>
      root.render(React.createElement(Observe, { revision: 2 })),
    );
    assert.deepEqual(observed.find((entry) => entry.revision === 2)?.ids, []);
    await act(async () =>
      pending.resolve({ rooms: [storedRoom("new")], nextCursor: null }),
    );
  });
});

test("nonadvancing pagination fails visibly instead of spinning or publishing a partial list", async () => {
  await withDom(async (root) => {
    let calls = 0;
    setExecute(async () => {
      calls += 1;
      return { rooms: [storedRoom("one")], nextCursor: 0 };
    });
    await act(async () => root.render(React.createElement(Discovery)));
    assert.equal(calls, 1);
    assert.deepEqual(discoveryState().rooms, []);
    assert.match(discoveryState().error ?? "", /cursor/iu);
    assert.equal(discoveryState().loading, false);
  });
});

test("Room list bound rejects oversized pages and duplicate identity", async () => {
  await withDom(async (root) => {
    setExecute(async () => ({
      rooms: Array.from({ length: 129 }, (_, i) => storedRoom(String(i))),
      nextCursor: null,
    }));
    await act(async () => root.render(React.createElement(Discovery)));
    assert.match(discoveryState().error ?? "", /limit|bound/iu);
    setExecute(async () => ({
      rooms: [storedRoom("same"), storedRoom("same")],
      nextCursor: null,
    }));
    await act(async () => button("Refresh conversations").click());
    assert.match(discoveryState().error ?? "", /duplicate/iu);
  });
});

test("advancing empty pages also stop at the bounded page limit", async () => {
  await withDom(async (root) => {
    let calls = 0;
    setExecute(async (...args) => {
      calls += 1;
      return {
        rooms: [],
        nextCursor: (args[2] as { cursor: number }).cursor + 1,
      };
    });
    await act(async () => root.render(React.createElement(Discovery)));
    assert.equal(calls, 128);
    assert.deepEqual(discoveryState().rooms, []);
    assert.match(discoveryState().error ?? "", /pagination.*limit/iu);
  });
});

function Discovery({
  enabled = true,
  revision,
}: {
  enabled?: boolean;
  revision?: unknown;
}) {
  const state = useRoomConversations(enabled, revision);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "output",
      { id: "discovery-state" },
      JSON.stringify({
        rooms: state.rooms,
        error: state.error,
        loading: state.loading,
      }),
    ),
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": "Refresh conversations",
        onClick: () => void state.refresh(),
      },
      "Refresh",
    ),
  );
}

function sidebarProps(extra: Record<string, unknown> = {}) {
  return {
    liveThread: null,
    mode: "projects" as const,
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
    pluginContributions: [
      contribution("zenx-rooms", "Rooms", ROOM_ROUTE),
      contribution(
        "zenx-triggers",
        "Triggers",
        "/plugins/zenx-triggers/triggers",
      ),
    ],
    projects: {
      projects: [],
      unavailableThreadIds: [],
      lastUsedWorkspace: null,
    },
    selectedPage: "agent",
    selectedThreadId: null,
    serverStatus: { type: "ready" as const, reconnected: false },
    threadError: null,
    threadLoading: false,
    pinnedThreads: [],
    threads: [],
    ...extra,
  };
}

function contribution(
  pluginId: string,
  label: string,
  route: string,
): LoadedPluginContribution {
  return {
    id: pluginId,
    pluginId,
    label,
    icon: "users",
    key: pluginId,
    pageId: pluginId,
    page: { id: pluginId, pluginId, key: pluginId, title: label, route },
  };
}
function storedRoom(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    members: [{ name: "Bot", threadId: "bot" }],
    messages: [],
    createdAt: 0,
    ...extra,
  };
}
function discoveryState(): RoomConversationState {
  return JSON.parse(
    document.getElementById("discovery-state")?.textContent ?? "null",
  ) as RoomConversationState;
}
function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === label,
  );
  assert.ok(result, `Expected button ${label}`);
  return result;
}
function setExecute(executeCommand: (...args: unknown[]) => Promise<unknown>) {
  Object.assign(window, { zenx: { plugins: { executeCommand } } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function controlledTimers() {
  const pending = new Map<number, { callback: () => void; delay: number }>();
  let id = 0;
  window.setTimeout = ((callback: () => void, delay: number) => {
    pending.set(++id, { callback, delay });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (handle: Parameters<typeof window.clearTimeout>[0]) => {
    if (typeof handle === "number") pending.delete(handle);
  };
  return {
    pending,
    fire: () => {
      const entry = [...pending.entries()][0];
      assert.ok(entry);
      pending.delete(entry[0]);
      entry[1].callback();
    },
  };
}
async function withDom(run: (root: Root) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}
