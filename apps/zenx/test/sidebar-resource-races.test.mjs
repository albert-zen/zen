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
test("implicit first selected Room resource retains its descriptor owner", async () => {
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
          onSelectTab: () => {},
        }),
      ),
    );
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
test("controlled Room native presentation persists scoped selection without suppressing its own handoff", async () => {
  const dom = setup();
  Object.assign(globalThis, { MutationObserver: dom.window.MutationObserver });
  let present;
  let latest;
  const mounts = [];
  window.zenx = {
    workspaceBrowser: {
      onChanged: () => () => {},
      onPresentation: (listener) => {
        present = listener;
        return () => {};
      },
      presentationContext: async () => {},
      declinePresentation: async () => {},
      onFocusAddress: () => () => {},
      mount: async (value) => mounts.push(value),
      command: async () => [],
    },
    plugins: {},
  };
  const root = createRoot(document.getElementById("root"));
  function Harness() {
    const [state, setState] = React.useState({
      ...emptySidebarState({ kind: "room", id: "handoff-room" }),
      open: true,
      resourceThreadId: "handoff-member",
    });
    latest = state;
    return React.createElement(AuxiliaryPanel, {
      presentationState: state,
      conversationContext: {
        kind: "room",
        roomId: "handoff-room",
        resourceThread: { threadId: "handoff-member", title: "M" },
        resourceThreads: [{ threadId: "handoff-member", title: "M" }],
      },
      title: "R",
      open: state.open,
      onOpenChange: (open) => setState((s) => ({ ...s, open })),
      snapshot: null,
      selectedTab: state.selectedTab ?? void 0,
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
    const now = Date.now();
    await act(async () =>
      present({
        threadId: "handoff-member",
        requestId: "handoff-req",
        operationSequence: 1e3,
        sessionEpoch: "handoff-epoch",
        requestedAt: now + 1,
        expiresAt: now + 1e4,
        tab: {
          id: "handoff-native",
          threadId: "handoff-member",
          title: "Page",
          url: "https://example.com/",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          sharedWithAgent: true,
          control: "agent",
          agentActionsInFlight: 0,
        },
      }),
    );
    assert.equal(latest.selectedTab, "browser:@handoff-member:handoff-native");
    assert.equal(document.querySelector(".browser-follow-button"), null);
    assert.equal(
      [...document.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Follow agent"),
      ),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
test("late hydrated Room native presentation retains fresh scope normalization", async () => {
  const dom = setup();
  Object.assign(globalThis, { MutationObserver: dom.window.MutationObserver });
  let present;
  let latest;
  const mounts = [];
  let hydrate;
  window.zenx = {
    workspaceBrowser: {
      onChanged: () => () => {},
      onPresentation: (listener) => {
        present = listener;
        return () => {};
      },
      presentationContext: async () => {},
      declinePresentation: async () => {},
      onFocusAddress: () => () => {},
      mount: async (value) => mounts.push(value),
      command: async () => [],
    },
    plugins: {},
  };
  const root = createRoot(document.getElementById("root"));
  function Harness() {
    const [hydrated, setHydrated] = React.useState(false);
    hydrate = () => setHydrated(true);
    const [state, setState] = React.useState({
      ...emptySidebarState({ kind: "room", id: "hydration-room" }),
      open: true,
      resourceThreadId: "hydration-member",
    });
    latest = state;
    return React.createElement(AuxiliaryPanel, {
      presentationState: hydrated ? state : void 0,
      conversationContext: {
        kind: "room",
        roomId: "hydration-room",
        resourceThread: { threadId: "hydration-member", title: "M" },
        resourceThreads: [{ threadId: "hydration-member", title: "M" }],
      },
      title: "R",
      open: state.open,
      onOpenChange: (open) => setState((s) => ({ ...s, open })),
      snapshot: null,
      selectedTab: state.selectedTab ?? void 0,
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
    await act(async () => hydrate());
    const now = Date.now();
    await act(async () =>
      present({
        threadId: "hydration-member",
        requestId: "hydration-req",
        operationSequence: 1e3,
        sessionEpoch: "hydration-epoch",
        requestedAt: now + 1,
        expiresAt: now + 1e4,
        tab: {
          id: "hydration-native",
          threadId: "hydration-member",
          title: "Page",
          url: "https://example.com/",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          sharedWithAgent: true,
          control: "agent",
          agentActionsInFlight: 0,
        },
      }),
    );
    assert.equal(
      latest.selectedTab,
      "browser:@hydration-member:hydration-native",
    );
    assert.equal(document.querySelector(".browser-follow-button"), null);
    assert.equal(
      [...document.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Follow agent"),
      ),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
