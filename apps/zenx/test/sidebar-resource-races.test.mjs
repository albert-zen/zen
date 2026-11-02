import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { emptySidebarState } from "../src/thread-sidebar-state.js";
const setup = () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  return dom;
};
test("closing inactive Room browser descriptor closes its original native resource", async () => {
  const dom = setup();
  const calls = [];
  let removed = "";
  window.zenx = {
    workspaceBrowser: {
      onChanged: () => () => {},
      command: async (...args) => {
        calls.push(args);
        return [];
      },
    },
    plugins: {},
  };
  const root = createRoot(document.getElementById("root"));
  const state = {
    ...emptySidebarState({ kind: "room", id: "r" }),
    open: true,
    tabs: [
      { kind: "browser", id: "native-a", resourceThreadId: "a" },
      { kind: "custom", id: "overview" },
    ],
    selectedTab: "custom:overview",
    resourceThreadId: "b",
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(AuxiliaryPanel, {
          presentationState: state,
          conversationContext: {
            kind: "room",
            roomId: "r",
            resourceThread: { threadId: "b", title: "B" },
            resourceThreads: [
              { threadId: "a", title: "A" },
              { threadId: "b", title: "B" },
            ],
          },
          title: "R",
          open: true,
          onOpenChange: () => {},
          snapshot: null,
          selectedTab: state.selectedTab,
          onSelectTab: () => {},
          onRemoveTab: (id) => (removed = id),
          customTabs: [
            {
              id: "overview",
              title: "Overview",
              icon: "users",
              render: () => null,
            },
          ],
        }),
      ),
    );
    const close = document
      .querySelector('[id="aux-tab-browser:@a:native-a"]')
      .parentElement.querySelector(".workspace-tab-close");
    await act(async () => close.click());
    assert.equal(removed, "browser:@a:native-a");
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "a" && args[1] === "close" && args[2] === "native-a",
      ),
      JSON.stringify(calls),
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
test("late materialize reply does not close native tab already retained by concurrent renderer", async () => {
  const dom = setup();
  const calls = [];
  let resolve;
  const gate = new Promise((r) => (resolve = r));
  window.zenx = {
    workspaceBrowser: {
      onChanged: () => () => {},
      command: async (...args) => {
        calls.push(args);
        return args[1] === "materialize" ? gate : [];
      },
    },
    plugins: {},
  };
  const root = createRoot(document.getElementById("root"));
  const initial = {
    ...emptySidebarState("a"),
    open: true,
    tabs: [{ kind: "webpage", id: "intent", url: "https://example.com" }],
    selectedTab: "webpage:intent",
  };
  const props = (state) => ({
    threadId: "a",
    title: "A",
    open: true,
    onOpenChange: () => {},
    snapshot: null,
    selectedTab: state.selectedTab,
    onSelectTab: () => {},
    presentationState: state,
    onReplaceTab: async () => true,
    customTabs: [
      { id: "overview", title: "Overview", icon: "users", render: () => null },
    ],
  });
  try {
    await act(async () =>
      root.render(React.createElement(AuxiliaryPanel, props(initial))),
    );
    await act(async () =>
      root.render(
        React.createElement(
          AuxiliaryPanel,
          props({
            ...initial,
            revision: 1,
            tabs: [
              { kind: "browser", id: "native" },
              { kind: "custom", id: "overview" },
            ],
            selectedTab: "custom:overview",
          }),
        ),
      ),
    );
    await act(async () => resolve([{ id: "native" }]));
    assert.equal(
      calls.some((args) => args[1] === "close"),
      false,
      JSON.stringify(calls),
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
test("unselected Room resource stays dormant and explicit choice retains its descriptor owner", async () => {
  const dom = setup();
  const calls = [];
  window.zenx = {
    workspaceBrowser: { onChanged: () => () => {}, command: async () => [] },
    shellPanel: {
      request: async (args) => {
        calls.push(args);
        return { sessions: [], canCreate: false };
      },
    },
    plugins: {},
  };
  const root = createRoot(document.getElementById("root"));
  const state = {
    ...emptySidebarState({ kind: "room", id: "r" }),
    open: true,
    tabs: [{ kind: "terminal", resourceThreadId: "a" }],
    selectedTab: null,
    resourceThreadId: "b",
  };
  function Harness() {
    const [selectedTab, onSelectTab] = React.useState(undefined);
    return React.createElement(AuxiliaryPanel, {
      presentationState: { ...state, selectedTab: selectedTab ?? null },
      conversationContext: {
        kind: "room",
        roomId: "r",
        resourceThread: { threadId: "b", title: "B" },
        resourceThreads: [
          { threadId: "a", title: "A" },
          { threadId: "b", title: "B" },
        ],
      },
      title: "R",
      open: true,
      onOpenChange: () => {},
      snapshot: null,
      selectedTab,
      onSelectTab,
    });
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(
      calls.length,
      0,
      "a first descriptor is not implicitly selected or read",
    );
    const tab = document.querySelector('[role="tab"]');
    assert.ok(Boolean(tab), "the exact resource is available to human choice");
    assert.equal(tab.getAttribute("aria-selected"), "false");
    await act(async () => tab.click());
    assert.ok(calls.length > 0);
    assert.equal(calls[0].threadId, "a", JSON.stringify(calls));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
import {
  WorkspaceFileDrafts,
  fileDraftKey,
} from "../src/renderer/src/workspace-file-drafts.js";
test("dirty close persists removal only after successful final save despite a newer selected tab", async () => {
  const dom = setup();
  const removed = [];
  let resolve;
  const gate = new Promise((r) => (resolve = r));
  const drafts = new WorkspaceFileDrafts();
  const key = fileDraftKey("a", "README.md");
  drafts.set(key, {
    base: { path: "README.md", text: "old", revision: "1" },
    text: "new",
  });
  window.zenx = {
    workspaceBrowser: { onChanged: () => () => {}, command: async () => [] },
    workspaceFiles: { save: async () => gate },
    plugins: {},
  };
  const root = createRoot(document.getElementById("root"));
  const state = {
    ...emptySidebarState("a"),
    open: true,
    tabs: [
      { kind: "file", path: "README.md" },
      { kind: "custom", id: "overview" },
    ],
    selectedTab: "custom:overview",
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(AuxiliaryPanel, {
          threadId: "a",
          title: "A",
          open: true,
          onOpenChange: () => {},
          snapshot: null,
          presentationState: state,
          selectedTab: state.selectedTab,
          onSelectTab: () => {},
          onRemoveTab: (id) => removed.push(id),
          fileDrafts: drafts,
          customTabs: [
            {
              id: "overview",
              title: "Overview",
              icon: "users",
              render: () => null,
            },
          ],
        }),
      ),
    );
    await act(async () => {
      document
        .querySelector('[id="aux-tab-file:README.md"]')
        .parentElement.querySelector(".workspace-tab-close")
        .click();
    });
    assert.deepEqual(removed, []);
    assert.equal(drafts.snapshot().get(key)?.closing, true);
    await act(async () =>
      resolve({
        status: "saved",
        file: { path: "README.md", text: "new", revision: "2" },
      }),
    );
    assert.deepEqual(removed, ["file:README.md"]);
    assert.equal(drafts.snapshot().has(key), false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
test("collapsed persisted selected file and webpage do not read or materialize", async () => {
  const dom = setup();
  const calls = [];
  window.zenx = {
    workspaceBrowser: {
      onChanged: () => () => {},
      command: async (...args) => {
        calls.push(args);
        return [];
      },
    },
    workspaceFiles: {
      read: async () => {
        calls.push(["read"]);
        throw Error("must remain lazy");
      },
    },
    plugins: {},
  };
  const root = createRoot(document.getElementById("root"));
  const props = (tabs, selectedTab) => ({
    threadId: "a",
    title: "A",
    open: false,
    onOpenChange: () => {},
    snapshot: null,
    presentationState: { ...emptySidebarState("a"), tabs, selectedTab },
    selectedTab,
    onSelectTab: () => {},
  });
  try {
    await act(async () =>
      root.render(
        React.createElement(
          AuxiliaryPanel,
          props([{ kind: "file", path: "README.md" }], "file:README.md"),
        ),
      ),
    );
    await act(async () =>
      root.render(
        React.createElement(
          AuxiliaryPanel,
          props(
            [{ kind: "webpage", id: "i", url: "https://example.com" }],
            "webpage:i",
          ),
        ),
      ),
    );
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "read" || args[1] === "materialize" || args[1] === "new",
      ),
      false,
      JSON.stringify(calls),
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
test("late materialize after descriptor removal/unmount closes native on original owner without selecting", async () => {
  const dom = setup();
  const calls = [];
  let resolve;
  const gate = new Promise((r) => (resolve = r));
  let replacements = 0;
  let selections = 0;
  window.zenx = {
    workspaceBrowser: {
      onChanged: () => () => {},
      command: async (...args) => {
        calls.push(args);
        return args[1] === "materialize" ? gate : [];
      },
    },
    plugins: {},
  };
  const root = createRoot(document.getElementById("root"));
  const state = {
    ...emptySidebarState({ kind: "room", id: "r" }),
    open: true,
    tabs: [
      {
        kind: "webpage",
        id: "i",
        url: "https://example.com",
        resourceThreadId: "a",
      },
    ],
    selectedTab: "webpage:@a:i",
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(AuxiliaryPanel, {
          conversationContext: {
            kind: "room",
            roomId: "r",
            resourceThread: { threadId: "b", title: "B" },
            resourceThreads: [
              { threadId: "a", title: "A" },
              { threadId: "b", title: "B" },
            ],
          },
          title: "R",
          open: true,
          onOpenChange: () => {},
          snapshot: null,
          presentationState: state,
          selectedTab: state.selectedTab,
          onSelectTab: () => selections++,
          onReplaceTab: async (old, tab) => {
            replacements++;
            assert.equal(old, "webpage:@a:i");
            assert.equal(tab.resourceThreadId, "a");
            return false;
          },
        }),
      ),
    );
    await act(async () => root.unmount());
    await act(async () => resolve([{ id: "native" }]));
    assert.equal(replacements, 1);
    assert.equal(selections, 0);
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "a" && args[1] === "close" && args[2] === "native",
      ),
      JSON.stringify(calls),
    );
  } finally {
    dom.window.close();
  }
});
import { sidebarTabFromId } from "../src/thread-sidebar-state.js";
for (const lateHydration of [false, true]) {
  test(`${lateHydration ? "late hydrated" : "controlled"} Room browser choices normalize the exact owner only after human selection`, async () => {
    const dom = setup();
    Object.assign(globalThis, {
      MutationObserver: dom.window.MutationObserver,
    });
    let changed;
    let latest;
    let hydrate;
    const mounts = [];
    const commands = [];
    const native = {
      id: "chosen-native",
      threadId: "room-member",
      title: "Page",
      url: "https://example.com/",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      sharedWithAgent: true,
      control: "agent",
      agentActionsInFlight: 0,
      agentActionOutcomeUnknown: false,
      requiresFreshObservation: false,
    };
    window.zenx = {
      workspaceBrowser: {
        onChanged: (listener) => {
          changed = listener;
          return () => {};
        },
        onFocusAddress: () => () => {},
        mount: async (value) => mounts.push(value),
        command: async (threadId, command) => {
          commands.push([threadId, command]);
          return command === "new" ? [native] : [];
        },
      },
      plugins: {},
    };
    const root = createRoot(document.getElementById("root"));
    function Harness() {
      const [hydrated, setHydrated] = React.useState(!lateHydration);
      hydrate = () => setHydrated(true);
      const [state, setState] = React.useState({
        ...emptySidebarState({ kind: "room", id: "choice-room" }),
        open: true,
        resourceThreadId: "room-member",
      });
      latest = state;
      return React.createElement(AuxiliaryPanel, {
        presentationState: hydrated ? state : undefined,
        conversationContext: {
          kind: "room",
          roomId: "choice-room",
          resourceThread: { threadId: "room-member", title: "M" },
          resourceThreads: [{ threadId: "room-member", title: "M" }],
        },
        title: "R",
        open: state.open,
        onOpenChange: (open) => setState((s) => ({ ...s, open })),
        snapshot: null,
        selectedTab: state.selectedTab ?? undefined,
        onSelectTab: (id) =>
          setState((s) => ({
            ...s,
            selectedTab: id,
            tabs: [sidebarTabFromId(id)],
          })),
      });
    }
    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () =>
        changed({
          threadId: "room-member",
          tabs: [{ ...native, agentActionsInFlight: 1 }],
        }),
      );
      assert.equal(
        latest.selectedTab,
        null,
        "Agent discovery never chooses a Room resource",
      );
      assert.equal(mounts.length, 0);
      if (lateHydration) await act(async () => hydrate());
      assert.equal(
        latest.selectedTab,
        null,
        "late hydration never chooses the discovered Agent target",
      );
      const chooseBrowser = [
        ...document.querySelectorAll(".workspace-tab-types button"),
      ].find(
        (button) =>
          button.querySelector("strong")?.textContent === "ZenX browser",
      );
      assert.ok(
        Boolean(chooseBrowser),
        "manual Browser choice stays available",
      );
      await act(async () => chooseBrowser.click());
      assert.equal(latest.selectedTab, "browser:@room-member:chosen-native");
      assert.deepEqual(latest.tabs, [
        {
          kind: "browser",
          id: "chosen-native",
          resourceThreadId: "room-member",
        },
      ]);
      assert.ok(
        commands.some(
          ([threadId, command]) =>
            threadId === "room-member" && command === "new",
        ),
        "the explicit human open uses the exact Room member",
      );
      await act(async () =>
        changed({
          threadId: "room-member",
          tabs: [
            native,
            { ...native, id: "agent-other", agentActionsInFlight: 1 },
          ],
        }),
      );
      assert.equal(
        latest.selectedTab,
        "browser:@room-member:chosen-native",
        "new Agent targets never replace the human Room choice",
      );
      assert.ok(
        document.querySelector(".browser-follow-button") === null,
        "no Follow control remains",
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
