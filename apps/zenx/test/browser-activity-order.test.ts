import { browserOperationOrder } from "../src/main/capabilities/browser-operation-order.js";
import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import {
  BrowserLiveObservationIpcBridge,
  type BrowserObservationEnvelope,
} from "../src/main/browser-live-observation-ipc.js";
import type {
  BrowserThreadEvent,
  BrowserThreadRequest,
} from "../src/main/capabilities/browser-thread-observation.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";

test("an older delayed open cannot replace newer exact-target presentation", async () => {
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
  let workspacePresentation!: (request: any) => void;
  const declined: string[] = [];
  const callbacks = new Map<string, (event: BrowserThreadEvent) => void>();
  const envelopes: BrowserObservationEnvelope[] = [];
  const renderer = {
    isDestroyed: () => false,
    send(_channel: string, envelope: BrowserObservationEnvelope) {
      envelopes.push(envelope);
      callbacks.get(envelope.subscriptionId)?.(envelope.event);
    },
    on() {},
    removeListener() {},
  };
  const summary = (sessionId: string, tabId: string) => ({
    sessionId,
    tabId,
    title: `Page ${tabId}`,
    url: "https://example.test/same",
    loading: false,
  });
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const frameTargets: string[] = [];
  let frameStops = 0;
  let frameSerial = 0;
  const activeFrames = new Map<number, string>();
  const openResolvers: Array<() => void> = [];
  const openOrders: number[] = [];
  const connected = {
    open: async (sessionId: string) => {
      openOrders.push(browserOperationOrder());
      const n = openResolvers.length;
      await new Promise<void>((resolve) => openResolvers.push(resolve));
      return summary(sessionId, `opened-${n}`);
    },
    listTabs: async (sessionId: string) => [
      summary(sessionId, "one"),
      summary(sessionId, "two"),
      summary(sessionId, "three"),
    ],
    navigate: async (sessionId: string, tabId: string) => {
      assert.equal(
        envelopes.findLast((value) => value.event.type === "activity")?.event
          .type,
        "activity",
        "Host start must precede backend dispatch",
      );
      const started = envelopes.findLast(
        (value) => value.event.type === "activity",
      )!.event;
      assert.ok(started.type === "activity");
      assert.equal(started.operationSequence, browserOperationOrder());
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      return summary(sessionId, tabId);
    },
    observeTab(
      _session: string,
      target: string,
      listener: (event: BrowserThreadEvent) => void,
    ) {
      frameTargets.push(target);
      const frameId = ++frameSerial;
      activeFrames.set(frameId, target);
      listener({ type: "status", status: "live", message: "Live" });
      return () => {
        frameStops++;
        activeFrames.delete(frameId);
      };
    },
    close: async () => {},
  } as unknown as ZenXBrowserBackend;
  const registry = new BrowserBackendRegistry(
    { close: async () => {} } as ZenXBrowserBackend,
    connected,
  );
  const source = {
    observeBrowserLive: (
      request: BrowserThreadRequest,
      listener: (event: BrowserThreadEvent) => void,
    ) => registry.observeThread(request, listener),
  };
  const catalog = new BrowserLiveObservationIpcBridge(source, "catalog", true);
  const frames = new BrowserLiveObservationIpcBridge(source, "frames");
  const snapshot = {
    plugins: [
      { id: "browser", enabled: true, available: true, admissionId: "a" },
    ],
    panels: [],
  };
  (window as any).zenx = {
    plugins: {},
    workspaceBrowser: {
      command: async () => [],
      mount: async () => {},
      onFocusAddress: () => () => {},
      onChanged: () => () => {},
      onPresentation: (listener: typeof workspacePresentation) => {
        workspacePresentation = listener;
        return () => {};
      },
      presentationContext: async () => {},
      declinePresentation: async (id: string) => {
        declined.push(id);
      },
    },
    browserObservation: {
      subscribe(
        request: BrowserThreadRequest,
        listener: (event: BrowserThreadEvent) => void,
      ) {
        const id = crypto.randomUUID();
        callbacks.set(id, listener);
        const bridge = request.catalog ? catalog : frames;
        bridge.subscribe(renderer, id, request);
        return () => {
          callbacks.delete(id);
          bridge.unsubscribe(renderer, id);
        };
      },
      openExternal() {
        throw new Error("automatic display must not open a URL");
      },
    },
  };
  const invoke = (name: string, tabId?: string) =>
    registry.invoke(`browser_connected_${name}`, {
      name,
      callId: crypto.randomUUID(),
      canonicalToolCallId: "canonical",
      threadId: "external-activity",
      arguments: {
        sessionId: "work",
        url: "https://example.test/",
        ...(tabId ? { tabId, url: "https://example.test/same" } : {}),
      },
      signal: new AbortController().signal,
      cwd: "/workspace",
    });
  let expanded = false;
  function Harness() {
    const [open, setOpen] = useState(false);
    const [selectedTab, onSelectTab] = useState("terminal");
    expanded = open;
    return React.createElement(AuxiliaryPanel, {
      threadId: "external-activity",
      title: "Task",
      snapshot: snapshot as any,
      open,
      onOpenChange: setOpen,
      selectedTab,
      onSelectTab,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const selected = () =>
    document.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (value) => value.textContent === text,
    )!;
  let pending: Promise<unknown> | undefined;
  try {
    await act(async () => root.render(React.createElement(Harness)));
    let tabs: any;
    await act(async () => {
      tabs = await invoke("list_tabs");
    });
    assert.equal(expanded, false, "listing is not automatic presentation");
    let older!: Promise<unknown>, newer!: Promise<unknown>;
    await act(async () => {
      older = invoke("open");
    });
    await act(async () => {
      newer = invoke("open");
    });
    await act(async () => {
      openResolvers[1]!();
      await newer;
    });
    assert.match(selected()!, /Page opened-1/);
    await act(async () => {
      openResolvers[0]!();
      await older;
    });
    assert.match(
      selected()!,
      /Page opened-1/,
      "older delayed open must not steal from newer operation",
    );
    const starts = envelopes
      .map((envelope) => envelope.event)
      .filter(
        (event) => event.type === "activity" && event.phase === "started",
      );
    assert.ok(openOrders[0]! < openOrders[1]!);
    assert.deepEqual(
      starts.map((event) =>
        event.type === "activity" ? event.operationSequence : undefined,
      ),
      [openOrders[1], openOrders[0]],
      "late publication retains original Host admission order",
    );
    const workspaceRequest = (sequence: number, id: string) => ({
      requestId: id,
      operationSequence: sequence,
      sessionEpoch: "workspace-session",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 750,
      threadId: "external-activity",
      tab: {
        id,
        threadId: "external-activity",
        title: `Workspace ${id}`,
        url: "https://example.test/same",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        sharedWithAgent: true,
        control: "agent",
        agentActionsInFlight: 0,
        agentActionOutcomeUnknown: false,
        requiresFreshObservation: false,
      },
    });
    // A later Workspace notification owns the same Thread watermark.
    await act(async () => {
      older = invoke("open");
    });
    const currentWorkspace = workspaceRequest(
      browserOperationOrder(),
      "current-workspace",
    );
    await act(async () => workspacePresentation(currentWorkspace));
    assert.match(selected()!, /Workspace current-workspace/);
    await act(async () => {
      openResolvers[2]!();
      await older;
    });
    assert.match(
      selected()!,
      /Workspace current-workspace/,
      "late external open cannot override newer Workspace presentation",
    );
    // Conversely, an older Workspace request cannot replace newer external intent.
    const staleWorkspace = workspaceRequest(
      browserOperationOrder(),
      "stale-workspace",
    );
    await act(async () => {
      newer = invoke("open");
    });
    await act(async () => {
      openResolvers[3]!();
      await newer;
    });
    assert.match(selected()!, /Page opened-3/);
    await act(async () => workspacePresentation(staleWorkspace));
    assert.match(selected()!, /Page opened-3/);
    assert.ok(declined.includes("stale-workspace"));
    // Rejected late external activity must not rewrite the explicit Follow target.
    await act(async () => {
      older = invoke("open");
    });
    await act(async () => {
      newer = invoke("open");
    });
    await act(async () => {
      openResolvers[5]!();
      await newer;
    });
    await act(async () => button("Terminal").click());
    await act(async () => {
      openResolvers[4]!();
      await older;
    });
    assert.equal(selected(), "Terminal");
    await act(async () => button("Follow Agent").click());
    assert.match(
      selected()!,
      /Page opened-5/,
      "Follow retains newer Host intent after a late completion",
    );
  } finally {
    await act(async () => root.unmount());
    catalog.close();
    frames.close();
    await registry.close();
    dom.window.close();
  }
});
