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

test("real Host activity never presents a peer tab; explicit selection keeps its exact read-only frame lane", async () => {
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
  const connected = {
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
      onChanged: () => () => {},
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
        ...(tabId ? { tabId, url: "https://example.test/same" } : {}),
      },
      signal: new AbortController().signal,
      cwd: "/workspace",
    });
  let expanded = false;
  let openPanel!: (value: boolean) => void;
  function Harness() {
    const [open, setOpen] = useState(false);
    const [selectedTab, onSelectTab] = useState("terminal");
    expanded = open;
    openPanel = setOpen;
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
    document.getElementById("composer")!.focus();
    await act(async () => {
      pending = invoke("navigate", tabs[0].tabId);
    });
    assert.equal(expanded, false);
    assert.equal(selected(), "Terminal");
    assert.deepEqual(frameTargets, []);
    await act(async () => openPanel(true));
    assert.equal(selected(), "Terminal");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
        .click(),
    );
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".workspace-tab-types button",
        ),
      ]
        .find(
          (node) => node.querySelector("strong")?.textContent === "Page one",
        )!
        .click(),
    );
    assert.match(selected()!, /Page one/);
    assert.ok(
      document.activeElement?.id?.startsWith("aux-tab-external-browser:"),
      "explicit chooser navigation focuses the selected preview tab",
    );
    assert.equal(frameTargets.at(-1), "one");
    assert.deepEqual(
      [...activeFrames.values()],
      ["one"],
      "hidden fixed peers cannot replace the selected frame lane",
    );
    assert.equal(
      document.querySelectorAll(
        '.workspace-content-tab[data-agent-active="true"]',
      ).length,
      1,
    );
    await act(async () => {
      finish();
      await pending;
    });
    assert.match(selected()!, /Page one/);
    assert.equal(
      document.querySelectorAll(
        '.workspace-content-tab[data-agent-active="true"]',
      ).length,
      0,
    );
    await act(async () => button("Terminal").click());
    await act(async () => {
      pending = invoke("navigate", tabs[1].tabId);
    });
    assert.equal(selected(), "Terminal");
    assert.ok(
      button("Follow Agent") === undefined,
      "no Follow Agent control remains",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
        .click(),
    );
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".workspace-tab-types button",
        ),
      ]
        .find(
          (node) => node.querySelector("strong")?.textContent === "Page two",
        )!
        .click(),
    );
    assert.match(selected()!, /Page two/);
    assert.equal(frameTargets.at(-1), "two");
    assert.deepEqual([...activeFrames.values()], ["two"]);
    await act(async () => {
      fail(new Error("outcome unknown"));
      await assert.rejects(pending!);
    });
    assert.match(
      document.querySelector(".browser-ui-error")?.textContent ?? "",
      /failed or its outcome is uncertain/,
    );
    assert.equal(
      document.querySelectorAll(
        '.workspace-content-tab[data-agent-active="true"]',
      ).length,
      0,
    );
    assert.ok(
      envelopes.filter((value) => value.event.type === "activity").length >= 4,
      "frame selection must not retire catalog",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
      pending = invoke("navigate", tabs[2].tabId);
    });
    assert.match(
      selected()!,
      /Page two/,
      "hidden-window activity cannot steal selection",
    );
    assert.deepEqual(
      [...activeFrames.values()],
      [],
      "hidden window has no fixed-peer frame owner",
    );
    await act(async () => {
      finish();
      await pending;
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () =>
      document.dispatchEvent(new dom.window.Event("visibilitychange")),
    );
    assert.match(
      selected()!,
      /Page two/,
      "hidden activity is not replayed on return",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
        .click(),
    );
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".workspace-tab-types button",
        ),
      ]
        .find(
          (node) => node.querySelector("strong")?.textContent === "Page three",
        )!
        .click(),
    );
    assert.match(selected()!, /Page three/);
    assert.deepEqual([...activeFrames.values()], ["three"]);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".auxiliary-close-button")!
        .click(),
    );
    await act(async () => {
      pending = invoke("navigate", tabs[0].tabId);
    });
    assert.equal(
      expanded,
      false,
      "later activity cannot reopen a user-collapsed panel",
    );
    assert.deepEqual([...activeFrames.values()], []);
    await act(async () => {
      finish();
      await pending;
    });
    await act(async () => registry.close());
    assert.equal(
      document.querySelectorAll(
        '.workspace-content-tab[data-agent-active="true"]',
      ).length,
      0,
    );
    assert.ok(frameStops > 0);
    assert.equal(
      document.querySelectorAll('[role="tab"]').length,
      4,
      "disconnected identities remain visible",
    );
  } finally {
    await act(async () => root.unmount());
    catalog.close();
    frames.close();
    await registry.close();
    dom.window.close();
  }
});
