import { chooseValue } from "./choice-interaction.js";
import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  UserBrowserCdpBackend,
  type UserBrowserCdpClient,
} from "../src/main/capabilities/user-browser-provider.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";
import {
  BrowserLiveObservationIpcBridge,
  type BrowserObservationEnvelope,
} from "../src/main/browser-live-observation-ipc.js";
import { BrowserThreadPanel } from "../src/renderer/src/browser-thread-panel.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type {
  BrowserThreadEvent,
  BrowserThreadRequest,
} from "../src/main/capabilities/browser-thread-observation.js";

test("real connected provider through registry, Host bridge and UI opens complete current URLs while tool and renderer projections stay redacted", async () => {
  let currentUrl = "https://example.test/search?q=zen#result-2";
  let metadata:
    | ((target: {
        targetId: string;
        type: string;
        title: string;
        url: string;
      }) => void)
    | undefined;
  const page = () => ({
    targetId: "target-1",
    type: "page",
    title: "Current page",
    url: currentUrl,
  });
  const client = {
    listTargets: async () => [page()],
    closureProblem: () => undefined,
    observeTargetMetadata(_id: string, receive: typeof metadata) {
      metadata = receive;
      receive?.(page());
      return () => {
        metadata = undefined;
      };
    },
    observeScreencast: async (
      _id: string,
      _owner: unknown,
      receive: (event: BrowserThreadEvent) => void,
    ) => {
      receive({ type: "status", status: "live", message: "live" });
      return async () => {};
    },
    detachTarget: async () => {},
    close: async () => {},
  } as unknown as UserBrowserCdpClient;
  const registry = new BrowserBackendRegistry(
    { close: async () => {} } as ZenXBrowserBackend,
    new UserBrowserCdpBackend(client),
  );
  const bridge = new BrowserLiveObservationIpcBridge(
    {
      observeBrowserLive: (request, receive) =>
        registry.observeThread(request, receive),
      readBrowserTargetUrl: (threadId, targetId) =>
        registry.readTargetUrl(threadId, targetId),
    },
    "events",
  );
  let receive: ((event: BrowserThreadEvent) => void) | undefined;
  const events: BrowserThreadEvent[] = [];
  const renderer = {
    isDestroyed: () => false,
    send(_channel: string, envelope: BrowserObservationEnvelope) {
      events.push(envelope.event);
      receive?.(envelope.event);
    },
    on() {},
    removeListener() {},
  };
  const opened: string[] = [];
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  window.open = () => {
    throw new Error("Connected UI must use the exact-target Host path");
  };
  Object.defineProperty(window, "zenx", {
    value: {
      browserObservation: {
        subscribe(
          request: BrowserThreadRequest,
          listener: (event: BrowserThreadEvent) => void,
        ) {
          receive = listener;
          const id = crypto.randomUUID();
          bridge.subscribe(renderer, id, request);
          return () => {
            receive = undefined;
            bridge.unsubscribe(renderer, id);
          };
        },
        openExternal: (threadId: string, targetId: string) =>
          bridge.openExternal(renderer, threadId, targetId, async (url) => {
            opened.push(url);
          }),
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  const button = () =>
    document.querySelector<HTMLButtonElement>(".browser-external-open")!;
  try {
    await i18n.changeLanguage("en");
    await act(async () =>
      root.render(
        React.createElement(BrowserThreadPanel, {
          threadId: "thread-a",
          title: "Test",
          open: true,
          onOpenChange() {},
          providerRevision: "fixture",
          embedded: true,
        }),
      ),
    );
    assert.equal(button().disabled, true);
    let result: unknown;
    await act(async () => {
      result = await registry.invoke("browser_connected_list_tabs", {
        callId: "call",
        name: "browser_connected_list_tabs",
        arguments: { sessionId: "work" },
        cwd: "/tmp",
        threadId: "thread-a",
        signal: new AbortController().signal,
      });
    });
    assert.equal(
      (result as Array<{ url: string }>)[0]!.url,
      "https://example.test/search",
    );
    assert.equal(
      button().disabled,
      true,
      "discovery does not select an observation target",
    );
    const targets: BrowserThreadEvent[] = [];
    registry.observeThread({ threadId: "thread-a", frames: false }, (event) =>
      targets.push(event),
    )();
    const catalog = targets.findLast((event) => event.type === "targets")!;
    assert.equal(catalog.type, "targets");
    await chooseValue(
      document.querySelector<HTMLButtonElement>(".ui-select")!,
      catalog.targets[0]!.id,
    );
    assert.equal(button().disabled, false);
    await act(async () => button().click());
    assert.deepEqual(opened, [currentUrl]);
    currentUrl = "https://example.test/app#/invoices/42?mode=full";
    await act(async () => metadata?.(page()));
    assert.equal(
      document.querySelector(".browser-panel-location span")?.textContent,
      "https://example.test/app",
    );
    await act(async () => button().click());
    assert.equal(opened.at(-1), currentUrl);
    // A committed navigation can precede renderer metadata. The Host reads now.
    currentUrl = "https://example.test/latest?q=fresh#current";
    await act(async () => button().click());
    assert.equal(opened.at(-1), currentUrl);
    assert.ok(!JSON.stringify(result).includes("q=zen"));
    assert.ok(!JSON.stringify(events).includes("invoices/42"));
    currentUrl = "javascript:alert(1)";
    await act(async () => button().click());
    assert.equal(opened.length, 3);
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Could not open the current page/,
    );
    const current = events.findLast((event) => event.type === "targets")!;
    assert.equal(current.type, "targets");
    if (current.type === "targets")
      await assert.rejects(
        registry.readTargetUrl("another-thread", current.selectedId!),
        /unavailable/,
      );
  } finally {
    await act(async () => root.unmount());
    bridge.close();
    await registry.close();
    dom.window.close();
  }
});
