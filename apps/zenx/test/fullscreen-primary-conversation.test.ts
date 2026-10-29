import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useSyncExternalStore, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { ThreadSidebarController } from "../src/renderer/src/thread-sidebar-controller.js";
import {
  emptySidebarState,
  sidebarTabId,
  type SidebarOwner,
} from "../src/thread-sidebar-state.js";
import { i18n } from "../src/renderer/src/i18n.js";

const primary = "primary-conversation";

test("fullscreen primary tab reuses main DOM, preserves resources and exact Thread/Room selection", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Window: dom.window.Window,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  (dom.window.HTMLElement.prototype as any).attachEvent = () => {};
  (dom.window.HTMLElement.prototype as any).detachEvent = () => {};
  await i18n.changeLanguage("en");
  const mounts: { threadId: string; tabId?: string; lease: string }[] = [];
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    top: 0,
    left: 0,
    right: 640,
    bottom: 480,
    toJSON() {},
  });
  let nativeSequence = 0;
  let finishMaterialization:
    ((tabs: ReturnType<typeof tabFor>[]) => void) | undefined;
  const tabFor = (threadId: string) => ({
    id: "web",
    threadId,
    title: "Existing webpage",
    url: "https://example.test/synthetic",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sharedWithAgent: true,
    control: "human",
    agentActionsInFlight: 0,
    agentInspectionsInFlight: 0,
    agentActionOutcomeUnknown: false,
    requiresFreshObservation: false,
  });
  (dom.window as any).zenx = {
    workspaceBrowser: {
      command: async (threadId: string, action: string) => {
        if (action === "materialize")
          return await new Promise<ReturnType<typeof tabFor>[]>((resolve) => {
            finishMaterialization = resolve;
          });
        assert.equal(
          action,
          "list",
          "Viewing never creates or navigates a browser",
        );
        return [tabFor(threadId)];
      },
      onChanged: () => () => {},
      onFocusAddress: () => () => {},
      mount: async (request: any) => {
        mounts.push(request);
        return { sequence: ++nativeSequence };
      },
    },
    plugins: {},
  };
  const controller = new ThreadSidebarController();
  const threadOwner: SidebarOwner = { kind: "thread", id: "same-id" };
  const roomOwner: SidebarOwner = { kind: "room", id: "same-id" };
  // A plain custom resource also proves the fixed primary never enters saved order.
  controller.accept({
    ...emptySidebarState(threadOwner),
    open: true,
    selectedTab: "browser:web",
    tabs: [
      { kind: "browser", id: "web" },
      { kind: "thread", threadId: "child" },
    ],
  });
  controller.accept({
    ...emptySidebarState(roomOwner),
    open: true,
    fullscreen: true,
    selectedTab: "browser:web",
    resourceThreadId: "member",
    tabs: [
      { kind: "browser", id: "web" },
      { kind: "thread", threadId: "child" },
    ],
  });
  let navigateOwner!: (room: boolean) => void;
  let mainMounts = 0;
  let selectedOwner = threadOwner;
  function Main() {
    React.useEffect(() => {
      mainMounts++;
    }, []);
    return React.createElement(
      "section",
      { className: "agent-surface", id: "primary-conversation-content" },
      React.createElement(
        "div",
        { id: "transcript" },
        "Existing primary conversation",
      ),
      React.createElement("textarea", {
        "aria-label": "Main composer",
        defaultValue: "Unsent primary draft",
      }),
    );
  }
  function Harness() {
    const [room, setRoom] = useState(false);
    navigateOwner = setRoom;
    const all = useSyncExternalStore(controller.subscribe, controller.snapshot);
    const owner = room ? roomOwner : threadOwner;
    selectedOwner = owner;
    const state = all[`${owner.kind}:${owner.id}`]!;
    return React.createElement(
      "main",
      { className: "workspace" },
      React.createElement(Main),
      React.createElement(AuxiliaryPanel, {
        // Intentionally no React key: scope changes must be fenced even without remount.
        conversationContext: room
          ? {
              kind: "room",
              roomId: owner.id,
              resourceThread: { threadId: "member", title: "Member" },
              resourceThreads: [{ threadId: "member", title: "Member" }],
            }
          : { kind: "thread", threadId: owner.id },
        primaryConversation: {
          title: room ? "Main Room conversation" : "Main agent conversation",
          contentId: "primary-conversation-content",
          onSelect: () => {
            const intent = controller.beginPresentationIntent(owner);
            return () => controller.isPresentationIntentCurrent(owner, intent);
          },
        },
        title: owner.id,
        open: state.open,
        onOpenChange: (open) => {
          void controller.edit(owner, () => ({ open }));
        },
        snapshot: null,
        presentationState: state,
        selectedTab: state.selectedTab ?? "",
        onSelectTab: (id) => {
          void controller.select(owner, id);
        },
        onReplaceTab: async (oldId, replacement) => {
          await controller.edit(
            owner,
            (current) => ({
              tabs: current.tabs.map((tab) =>
                sidebarTabId(tab) === oldId ? replacement : tab,
              ),
              selectedTab:
                current.selectedTab === oldId
                  ? sidebarTabId(replacement)
                  : current.selectedTab,
            }),
            undefined,
            "preserve",
          );
          return true;
        },
        onFullscreenChange: (fullscreen) => {
          void controller.edit(owner, () => ({ fullscreen }));
        },
        onTabsChange: (ids) => {
          assert.ok(!ids.includes(primary));
          void controller.edit(owner, () => ({
            tabs: ids.map((id) =>
              state.tabs.find((tab) => sidebarTabId(tab) === id)!,
            ),
          }));
        },
        conversations: [
          {
            threadId: "child",
            title: "Side chat",
            render: () => React.createElement("p", null, "Existing side chat"),
          },
        ],
      }),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  const element = (selector: string) => {
    const node = document.querySelector<HTMLElement>(selector);
    assert.ok(node !== null, selector);
    return node!;
  };
  const tab = (id: string) => element(`[role="tab"][id="aux-tab-${id}"]`);
  const click = async (node: HTMLElement) =>
    act(async () => {
      node.click();
    });
  const selected = () =>
    document.querySelector('[role="tab"][aria-selected="true"]')?.id;
  const expand = () => click(element('[aria-label="Expand side panel"]'));
  const restore = () => click(element('[aria-label="Restore side panel"]'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(
      document.getElementById(`aux-tab-${primary}`) === null,
      "No redundant primary tab in split mode",
    );
    const main = element("#primary-conversation-content");
    const composer = element("textarea") as HTMLTextAreaElement;
    composer.setSelectionRange(2, 6);
    element("#transcript").scrollTop = 87;
    await expand();
    assert.equal(
      selected(),
      "aux-tab-browser:web",
      "Entering fullscreen preserves webpage",
    );
    assert.equal(
      document.querySelector('[role="tab"]')?.id,
      `aux-tab-${primary}`,
    );
    assert.ok(
      tab(primary).parentElement!.querySelector(".workspace-tab-close") ===
        null,
      "Primary is not closeable",
    );
    assert.ok(
      !tab(primary).parentElement!.hasAttribute("data-reorderable"),
      "Primary is fixed first",
    );
    const beforeOrder = controller.get(threadOwner)!.tabs;
    await act(async () =>
      tab(primary).dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.deepEqual(
      controller.get(threadOwner)!.tabs,
      beforeOrder,
      "Primary cannot move into resources",
    );
    await act(async () =>
      tab("thread:child").dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.deepEqual(
      controller.get(threadOwner)!.tabs.map((tab) => tab.kind),
      ["thread", "browser"],
    );
    assert.equal(
      document.querySelector('[role="tab"]')?.id,
      `aux-tab-${primary}`,
      "Resource reorder cannot move ahead of primary",
    );
    assert.equal(
      selected(),
      "aux-tab-browser:web",
      "Reordering preserves resource selection",
    );
    const nativePage = mounts.findLast((request) => request.tabId === "web")!;
    await click(tab(primary));
    assert.equal(selected(), `aux-tab-${primary}`);
    assert.equal(element(".auxiliary-panel").dataset.primaryActive, "true");
    assert.ok(
      element("#primary-conversation-content") === main,
      "Main DOM is never replaced",
    );
    assert.equal(mainMounts, 1);
    assert.equal(composer.value, "Unsent primary draft");
    assert.equal(composer.selectionStart, 2);
    assert.equal(composer.selectionEnd, 6);
    assert.equal(element("#transcript").scrollTop, 87);
    assert.ok(
      document.querySelector(".workspace-browser-panel") === null,
      "Native browser renderer unmounts while primary is selected",
    );
    assert.equal(
      mounts.at(-1)?.lease,
      nativePage.lease,
      "Hide releases the exact mounted native lease",
    );
    assert.equal(mounts.at(-1)?.threadId, nativePage.threadId);
    assert.equal(
      mounts.at(-1)?.tabId,
      undefined,
      "Existing native view lease is detached for main chat",
    );
    assert.ok(
      mounts.some((request) => request.tabId === "web"),
      "Native page was mounted before main selection",
    );
    assert.equal(controller.get(threadOwner)?.selectedTab, "browser:web");
    const committed = controller.get(threadOwner)!;
    await act(async () =>
      controller.accept({ ...committed, revision: committed.revision + 1 }),
    );
    assert.equal(
      selected(),
      `aux-tab-${primary}`,
      "Background Host receipts never steal primary selection",
    );
    await act(async () => {
      controller.beginPresentationIntent(threadOwner);
    });
    assert.equal(
      selected(),
      "aux-tab-browser:web",
      "Same-ID explicit resource navigation supersedes primary",
    );
    await click(tab(primary));
    await restore();
    assert.equal(
      mounts.at(-1)?.tabId,
      "web",
      "Returning restores the same native target, without creation/navigation",
    );
    assert.ok(document.getElementById(`aux-tab-${primary}`) === null);
    assert.equal(selected(), "aux-tab-browser:web");
    await expand();
    assert.equal(
      selected(),
      "aux-tab-browser:web",
      "Reenter restores retained resource, not primary",
    );
    await click(tab(primary));
    await act(async () =>
      composer.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      element(".auxiliary-panel").dataset.expanded,
      "false",
      "Escape works from sibling main composer",
    );
    await expand();
    await click(tab("thread:child"));
    assert.match(
      element('[id="aux-content-thread:child"]').textContent!,
      /Existing side chat/,
    );
    await restore();
    await expand();
    assert.equal(
      selected(),
      "aux-tab-thread:child",
      "Side-chat selection is also preserved",
    );
    await click(tab(primary));
    await act(async () => navigateOwner(true));
    assert.equal(selectedOwner.kind, "room");
    assert.equal(
      selected(),
      "aux-tab-browser:web",
      "Same ID in a Room is a distinct presentation owner",
    );
    await click(tab(primary));
    assert.equal(tab(primary).textContent, "Main Room conversation");
    await act(async () => navigateOwner(false));
    assert.equal(
      selected(),
      "aux-tab-thread:child",
      "Old owner's primary choice does not leak back",
    );
    await act(async () =>
      controller.accept({
        ...controller.get(threadOwner)!,
        revision: controller.get(threadOwner)!.revision + 1,
        selectedTab: "webpage:pending",
        tabs: [
          {
            kind: "webpage",
            id: "pending",
            url: "https://example.test/deferred",
          },
        ],
      }),
    );
    assert.ok(
      finishMaterialization !== undefined,
      "Selected webpage begins existing materialization",
    );
    await click(tab(primary));
    const mountsBeforeResolve = mounts.length;
    await act(async () =>
      finishMaterialization!([{ ...tabFor(threadOwner.id), id: "real" }]),
    );
    assert.equal(
      controller.get(threadOwner)!.selectedTab,
      "browser:real",
      "Late descriptor reconciliation is retained",
    );
    assert.equal(
      selected(),
      `aux-tab-${primary}`,
      "Late materialization never steals primary chat",
    );
    assert.equal(
      mounts.length,
      mountsBeforeResolve,
      "Late materialization never mounts a hidden native page",
    );
    await click(tab("browser:real"));
    assert.equal(
      mounts.at(-1)?.tabId,
      "real",
      "Explicit resource selection mounts the reconciled exact target",
    );
    assert.equal(mainMounts, 1);
    assert.ok(
      controller
        .get(threadOwner)!
        .tabs.every((tab) => tab.kind !== ("primary" as any)),
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("primary view intent is reactive but background reconciliation never advances it", async () => {
  const controller = new ThreadSidebarController();
  controller.accept({
    ...emptySidebarState("a"),
    open: true,
    fullscreen: true,
    selectedTab: "webpage:intent",
    tabs: [{ kind: "webpage", id: "intent", url: "https://example.test" }],
  });
  let notifications = 0;
  controller.subscribe(() => notifications++);
  const intent = controller.beginPresentationIntent("a");
  assert.equal(notifications, 1);
  assert.equal(
    controller.get("a")!.revision,
    0,
    "Local choice creates no Host fact",
  );
  await controller.edit(
    "a",
    () => ({
      tabs: [{ kind: "browser", id: "real" }],
      selectedTab: "browser:real",
    }),
    undefined,
    "preserve",
  );
  assert.ok(
    controller.isPresentationIntentCurrent("a", intent),
    "Webpage materialization retains explicit primary selection",
  );
  const current = controller.get("a")!;
  controller.accept({ ...current, revision: current.revision + 1 });
  assert.ok(
    controller.isPresentationIntentCurrent("a", intent),
    "Background receipts do not claim navigation intent",
  );
  const before = notifications;
  controller.beginPresentationIntent("a");
  assert.equal(notifications, before + 1);
  assert.ok(
    !controller.isPresentationIntentCurrent("a", intent),
    "Same-ID explicit resource navigation supersedes primary",
  );
});
