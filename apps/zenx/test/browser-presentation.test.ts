import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { BrowserLiveObservationIpcBridge } from "../src/main/browser-live-observation-ipc.js";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import type {
  WorkspaceBrowserPresentation,
  WorkspaceBrowserTab,
} from "../src/main/workspace-browser.js";

const page = (id: string): WorkspaceBrowserTab => ({
  id,
  threadId: "presentation-ui",
  title: `Page ${id}`,
  url: "https://example.test/same-url",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  sharedWithAgent: true,
  control: "agent",
  agentActionsInFlight: 0,
  agentActionOutcomeUnknown: false,
  requiresFreshObservation: false,
});

test("workspace presentation reuses exact tab and lease, yields to user navigation, and explicitly resumes", async () => {
  const dom = new JSDOM('<input id="composer"><div id="root"></div>', {
    url: "https://zenx.local",
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
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 40,
    width: 600,
    height: 400,
    top: 40,
    left: 0,
    right: 600,
    bottom: 440,
    toJSON: () => ({}),
  });
  let receive!: (request: WorkspaceBrowserPresentation) => void;
  let changed!: (value: {
    threadId: string;
    tabs: WorkspaceBrowserTab[];
  }) => void;
  const mounts: any[] = [];
  const declined: string[] = [];
  const contexts: any[] = [];
  let operationSequence = 0;
  const requests = (
    id: string,
    epoch = "epoch-a",
    requestedAt = Date.now() + 1,
  ): WorkspaceBrowserPresentation => ({
    requestId: crypto.randomUUID(),
    operationSequence: ++operationSequence,
    sessionEpoch: epoch,
    requestedAt,
    expiresAt: requestedAt + 750,
    threadId: "presentation-ui",
    tab: page(id),
  });
  (dom.window as any).zenx = {
    plugins: {},
    workspaceBrowser: {
      onChanged: (fn: typeof changed) => {
        changed = fn;
        return () => {};
      },
      command: async () => [page("1"), page("2")],
      onFocusAddress: () => () => {},
      onPresentation: (fn: typeof receive) => {
        receive = fn;
        return () => {};
      },
      presentationContext: async (request: any) => {
        contexts.push(request);
      },
      declinePresentation: async (id: string) => {
        declined.push(id);
      },
      mount: async (request: any) => {
        mounts.push(request);
      },
    },
  };
  function Harness() {
    const [open, onOpenChange] = useState(false);
    const [selectedTab, onSelectTab] = useState("browser:2");
    return React.createElement(AuxiliaryPanel, {
      threadId: "presentation-ui",
      title: "Task",
      snapshot: null,
      open,
      onOpenChange,
      selectedTab,
      onSelectTab,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const selected = () =>
    document.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
  const tabs = () => [
    ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const composer = document.getElementById("composer")!;
    composer.focus();
    const first = requests("1");
    await act(async () => receive(first));
    assert.equal(selected(), "Page 1");
    assert.ok(
      document.activeElement === composer,
      "automatic reveal never takes keyboard focus",
    );
    assert.equal(tabs().length, 2, "same URL is not a deduplication key");
    assert.equal(mounts.at(-1).tabId, "1");
    const lease = mounts.at(-1).lease;
    const unmounts = mounts.filter((request) => !request.tabId).length;
    await act(async () => receive(requests("1", "epoch-b")));
    assert.equal(mounts.at(-1).lease, lease);
    assert.equal(
      mounts.filter((request) => !request.tabId).length,
      unmounts,
      "same-page activity must not remount or invalidate observation",
    );
    await act(async () =>
      tabs()
        .find((tab) => tab.textContent === "Page 2")!
        .click(),
    );
    const next = requests("1", "epoch-b");
    await act(async () => receive(next));
    assert.equal(selected(), "Page 2");
    assert.ok(declined.includes(next.requestId));
    await act(async () =>
      changed({
        threadId: "presentation-ui",
        tabs: [{ ...page("1"), agentInspectionsInFlight: 1 }, page("2")],
      }),
    );
    assert.equal(
      selected(),
      "Page 2",
      "activity/list updates cannot reclaim selection",
    );
    assert.equal(
      document.querySelectorAll(
        '.workspace-content-tab[data-agent-active="true"]',
      ).length,
      1,
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Follow Agent")!
        .click(),
    );
    assert.equal(selected(), "Page 1");
    assert.equal(
      mounts.at(-1).presentationId,
      undefined,
      "explicit follow does not replay an expired automatic token",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close side panel"]')!
        .click(),
    );
    const closed = requests("2", "epoch-b");
    await act(async () => receive(closed));
    assert.ok(declined.includes(closed.requestId));
    assert.equal(
      mounts.at(-1).tabId,
      undefined,
      "closed workspace has no mounted native page",
    );
    const expired = requests("1", "epoch-c", Date.now() - 1000);
    await act(async () => receive(expired));
    assert.ok(declined.includes(expired.requestId));
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    const hidden = requests("1", "epoch-d");
    await act(async () => receive(hidden));
    assert.ok(declined.includes(hidden.requestId));
    assert.equal(
      mounts.at(-1).tabId,
      undefined,
      "closed workspace has no mounted native page",
    );
    assert.equal(contexts[0].threadId, "presentation-ui");
  } finally {
    await act(async () => root.unmount());
    assert.equal(contexts.at(-1).threadId, undefined);
    dom.window.close();
    delete (globalThis as any).ResizeObserver;
  }
});

test("external read-only pages share the strip without merging same-URL identities or duplicating Workspace", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local",
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
  const target = (id: string, backendId: string, connectionId: string) => ({
    id,
    backendId,
    connectionId,
    sessionId: "session",
    tabId: id,
    title: "Same page",
    url: page("1").url,
    loading: false,
    mode: "live",
    canOpenExternally: true,
  });
  // Match the registry/native bridge identity contract, including both UUID
  // routing components; distinct instances may expose the same native page.
  const connectionA = "11111111-1111-4111-8111-111111111111";
  const connectionB = "22222222-2222-4222-8222-222222222222";
  const generationA = "33333333-3333-4333-8333-333333333333";
  const generationB = "44444444-4444-4444-8444-444444444444";
  const leaf = "55555555-5555-4555-8555-555555555555";
  const targetA = `connected/${connectionA}/${generationA}:${leaf}`;
  const targetB = `connected/${connectionB}/${generationB}:${leaf}`;
  let targets = [
    target("workspace:1", "workspace", "workspace"),
    target(targetA, "connected", connectionA),
    target(targetB, "connected", connectionB),
  ];
  const listeners = new Set<(event: any) => void>();
  const requests: any[] = [];
  const commands: string[] = [];
  const deliveries = new Map<string, (event: any) => void>();
  const sourceRequests = new Map<(event: any) => void, any>();
  const subscriptionRequests = new Map<string, any>();
  class Renderer extends EventEmitter {
    isDestroyed() {
      return false;
    }
    send(_channel: string, envelope: any) {
      deliveries.get(envelope.subscriptionId)?.(envelope.event);
    }
  }
  const renderer = new Renderer();
  const source = {
    readBrowserTargetUrl: async () => page("1").url,
    observeBrowserLive(request: any, listener: (event: any) => void) {
      requests.push(request);
      listeners.add(listener);
      sourceRequests.set(listener, request);
      listener({ type: "targets", targets, selectedId: request.targetId });
      listener({ type: "status", status: "live", message: "" });
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const catalogBridge = new BrowserLiveObservationIpcBridge(
    source,
    "catalog",
    true,
  );
  const frameBridge = new BrowserLiveObservationIpcBridge(source, "frame");
  (dom.window as any).zenx = {
    plugins: {},
    workspaceBrowser: {
      onChanged: () => () => {},
      onFocusAddress: () => () => {},
      mount: async () => {},
      command: async (_thread: string, command: string) => {
        commands.push(command);
        return [page("1")];
      },
    },
    browserObservation: {
      subscribe: (request: any, listener: (event: any) => void) => {
        const id = crypto.randomUUID();
        const bridge = request.catalog ? catalogBridge : frameBridge;
        deliveries.set(id, listener);
        subscriptionRequests.set(id, request);
        bridge.subscribe(renderer, id, request);
        return () => {
          deliveries.delete(id);
          bridge.unsubscribe(renderer, id);
        };
      },
    },
  };
  let snapshot = {
    plugins: [{ id: "browser", enabled: true, available: true }],
    panels: [],
  } as any;
  function Harness() {
    const [selectedTab, onSelectTab] = useState("browser:1");
    return React.createElement(AuxiliaryPanel, {
      threadId: "presentation-ui-external",
      title: "Task",
      snapshot,
      open: true,
      onOpenChange: () => {},
      selectedTab,
      onSelectTab,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const tabs = () => [
      ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    assert.equal(tabs().length, 3);
    assert.ok(!document.body.textContent?.includes("Attached browser"));
    const external = tabs().filter((tab) =>
      tab.textContent?.includes("read-only"),
    );
    assert.equal(external.length, 2);
    await act(async () => external[0]!.click());
    assert.equal(requests.at(-1).targetId, targetA);
    assert.equal(requests.at(-1).frames, true);
    assert.equal(
      listeners.size,
      2,
      "real IPC keeps catalog and selected frame live together",
    );
    snapshot = { ...snapshot };
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(listeners.size, 2);
    assert.ok(
      [...listeners].some(
        (listener) => sourceRequests.get(listener).catalog === true,
      ),
    );
    assert.ok(
      [...listeners].some(
        (listener) => sourceRequests.get(listener).targetId === targetA,
      ),
      "catalog refresh leaves a live exact-target frame lane " +
        JSON.stringify(
          [...listeners].map((listener) => sourceRequests.get(listener)),
        ),
    );
    assert.equal(
      document.querySelectorAll("select").length,
      0,
      "fixed external target has no second target picker",
    );
    const oldFrameCallback = [...listeners].find(
      (listener) => sourceRequests.get(listener).targetId === targetA,
    )!;
    const oldFrameId = [...deliveries.keys()].find(
      (id) => subscriptionRequests.get(id).targetId === targetA,
    )!;
    await act(async () => external[1]!.click());
    assert.equal(requests.at(-1).targetId, targetB);
    await act(async () =>
      oldFrameCallback({
        type: "status",
        status: "unavailable",
        message: "stale frame",
      }),
    );
    frameBridge.unsubscribe(renderer, oldFrameId);
    const opened: string[] = [];
    await frameBridge.openExternal(
      renderer,
      "presentation-ui-external",
      targetB,
      async (url) => {
        opened.push(url);
      },
    );
    assert.deepEqual(opened, [page("1").url]);
    await assert.rejects(
      frameBridge.openExternal(
        renderer,
        "presentation-ui-external",
        targetA,
        async () => {},
      ),
      /not current/,
    );
    await assert.rejects(
      catalogBridge.openExternal(
        renderer,
        "presentation-ui-external",
        targetB,
        async () => {},
      ),
      /not current/,
    );
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    assert.equal(
      listeners.size,
      1,
      "hidden window retains only the catalog lane",
    );
    await assert.rejects(
      frameBridge.openExternal(
        renderer,
        "presentation-ui-external",
        targetB,
        async () => {},
      ),
      /not current/,
    );
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    assert.equal(listeners.size, 2);
    assert.equal(requests.at(-1).targetId, targetB);
    assert.equal(requests.at(-1).frames, true);
    await act(async () => {
      targets = [];
      for (const listener of [...listeners])
        listener({ type: "targets", targets });
    });
    assert.equal(
      tabs().length,
      3,
      "disconnect preserves read-only identity rather than substituting a page",
    );
    assert.ok(document.body.textContent?.includes("Selected page unavailable"));
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Close tab Same page · External · read-only"]',
        )!
        .click(),
    );
    assert.equal(tabs().length, 2);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Close tab Same page · External · read-only"]',
        )!
        .click(),
    );
    assert.equal(tabs().length, 1);
    assert.equal(
      listeners.size,
      1,
      "closing the final peer retires every frame subscription",
    );
    await assert.rejects(
      frameBridge.openExternal(
        renderer,
        "presentation-ui-external",
        targetB,
        async () => {},
      ),
      /not current/,
    );
    assert.ok(
      !commands.includes("close"),
      "dismissing an external view never closes a real browser target",
    );
  } finally {
    await act(async () => root.unmount());
    catalogBridge.close();
    frameBridge.close();
    assert.equal(listeners.size, 0);
    dom.window.close();
    delete (globalThis as any).ResizeObserver;
  }
});

for (const state of ["dismissed", "disconnected"] as const) {
  test(`unrelated plugin refresh preserves ${state} external tabs but a new Thread or provider resets scope`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "https://zenx.local",
      pretendToBeVisual: true,
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      React,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const target = {
      id: "connected:retained",
      backendId: "connected",
      connectionId: "one",
      sessionId: "session",
      tabId: "real-tab",
      title: "Retained page",
      url: "https://example.test",
      loading: false,
      mode: "live",
    };
    let targets = [target];
    const listeners = new Set<(event: any) => void>();
    (dom.window as any).zenx = {
      plugins: {},
      browserObservation: {
        subscribe: (request: any, listener: (event: any) => void) => {
          listeners.add(listener);
          listener({ type: "targets", targets, selectedId: request.targetId });
          return () => listeners.delete(listener);
        },
      },
    };
    let threadId = "refresh-thread";
    let snapshot: any = {
      plugins: [
        {
          id: "browser",
          enabled: true,
          available: true,
          admissionId: "provider-one",
        },
      ],
      panels: [],
    };
    function Harness() {
      const [selectedTab, onSelectTab] = useState("");
      return React.createElement(AuxiliaryPanel, {
        threadId,
        title: "Task",
        snapshot,
        open: true,
        onOpenChange: () => {},
        selectedTab,
        onSelectTab,
      });
    }
    const root = createRoot(document.getElementById("root")!);
    const rerender = () =>
      act(async () => root.render(React.createElement(Harness)));
    const count = () => document.querySelectorAll('[role="tab"]').length;
    try {
      await rerender();
      assert.equal(count(), 1);
      if (state === "dismissed") {
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              '[aria-label="Close tab Retained page · External · read-only"]',
            )!
            .click(),
        );
      } else {
        await act(async () => {
          targets = [];
          for (const listener of [...listeners])
            listener({ type: "targets", targets });
        });
      }
      const expected = state === "dismissed" ? 0 : 1;
      assert.equal(count(), expected);
      snapshot = {
        ...snapshot,
        plugins: [
          ...snapshot.plugins,
          { id: "unrelated", enabled: true, available: true },
        ],
      };
      await rerender();
      assert.equal(
        count(),
        expected,
        `${state} identity survives an unrelated plugin snapshot`,
      );
      snapshot = {
        ...snapshot,
        plugins: [{ ...snapshot.plugins[0], admissionId: "provider-two" }],
      };
      await rerender();
      assert.equal(
        count(),
        state === "dismissed" ? 1 : 0,
        "genuine provider incarnation establishes a fresh presentation scope",
      );
      if (state === "disconnected") {
        await act(async () => {
          targets = [target];
          for (const listener of [...listeners])
            listener({ type: "targets", targets });
        });
      }
      assert.equal(count(), 1);
      targets = [];
      threadId = "another-thread";
      await rerender();
      assert.equal(
        count(),
        0,
        "new Thread never inherits an old external page",
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
