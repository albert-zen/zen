import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceBrowserPanel } from "../src/renderer/src/workspace-browser-panel.js";
import { BrowserThreadPanel } from "../src/renderer/src/browser-thread-panel.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { WorkspaceBrowserTab } from "../src/main/workspace-browser.js";
import type {
  BrowserThreadEvent,
  BrowserThreadRequest,
  BrowserThreadTarget,
} from "../src/main/capabilities/browser-thread-observation.js";

const label = "Open current page in external browser";
const unsafeUrls = [
  "",
  "about:blank",
  "javascript:alert(1)",
  "file:///tmp/private",
  "mailto:user@example.com",
  "zenx://settings",
  "data:text/html,hello",
  "//example.com",
  "example.com",
  "https://example.com/\nprivate",
];
const tab = (changes = {}): WorkspaceBrowserTab => ({
  id: "tab-a",
  threadId: "thread-a",
  title: "Current page",
  url: "https://example.com/current",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  sharedWithAgent: true,
  control: "agent",
  agentActionOutcomeUnknown: false,
  agentActionsInFlight: 0,
  requiresFreshObservation: false,
  ...changes,
});
const target = (changes = {}): BrowserThreadTarget => ({
  id: "connected-a",
  sessionId: "session-a",
  tabId: "tab-a",
  title: "Connected page",
  url: "https://example.com/connected",
  loading: false,
  mode: "live",
  backendId: "connected",
  canOpenExternally: true,
  ...changes,
});
async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  const opened: unknown[][] = [];
  const navigationRequests: unknown[][] = [];
  const externalRequests: string[][] = [];
  let nextExternal: Promise<void> | undefined;
  dom.window.open = (...args: unknown[]) => {
    opened.push(args);
    return null;
  };
  const subscriptions: Array<{
    request: BrowserThreadRequest;
    receive(event: BrowserThreadEvent): void;
  }> = [];
  Object.defineProperty(dom.window, "zenx", {
    value: {
      workspaceBrowser: {
        onFocusAddress: () => () => {},
        mount: async () => {},
        command: async (...args: unknown[]) => {
          navigationRequests.push(args);
        },
      },
      browserObservation: {
        async openExternal(threadId: string, targetId: string) {
          externalRequests.push([threadId, targetId]);
          const pending = nextExternal;
          nextExternal = undefined;
          await pending;
        },
        subscribe(
          request: BrowserThreadRequest,
          receive: (event: BrowserThreadEvent) => void,
        ) {
          subscriptions.push({ request, receive });
          return () => {};
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  await i18n.changeLanguage("en");
  const renderNative = async (changes = {}, open = true) => {
    await act(async () =>
      root.render(
        React.createElement(WorkspaceBrowserPanel, {
          threadId: "thread-a",
          tab: tab(changes),
          open,
        }),
      ),
    );
  };
  const renderConnected = async (
    threadId = "thread-a",
    providerRevision = "provider-a",
    open = true,
  ) => {
    await act(async () =>
      root.render(
        React.createElement(BrowserThreadPanel, {
          threadId,
          title: threadId,
          providerRevision,
          open,
          onOpenChange() {},
          embedded: true,
        }),
      ),
    );
  };
  const button = () => {
    const value = document.querySelector<HTMLButtonElement>(
      `[aria-label="${label}"]`,
    );
    assert.ok(value, "Current page needs a visible external-open shortcut");
    return value;
  };
  return {
    opened,
    navigationRequests,
    externalRequests,
    deferExternal(promise: Promise<void>) {
      nextExternal = promise;
    },
    subscriptions,
    renderNative,
    renderConnected,
    button,
    async targets(
      value: BrowserThreadTarget[] = [target()],
      selectedId: string | undefined = value[0]?.id,
    ) {
      await act(async () =>
        subscriptions
          .at(-1)!
          .receive({ type: "targets", targets: value, selectedId }),
      );
    },
    async close() {
      await act(async () => root.unmount());
      await i18n.changeLanguage("en");
      dom.window.close();
    },
  };
}

test("native URL field ends with one external arrow and retains form navigation", async () => {
  const f = await fixture();
  try {
    await f.renderNative();
    const field = document.querySelector(".workspace-browser-location")!;
    const input = field.querySelector("input")!;
    const form = input.form!;
    assert.ok(field.classList.contains("browser-url-field"));
    assert.equal(field.lastElementChild, f.button());
    assert.equal(field.querySelectorAll("button").length, 1);
    assert.equal(form.querySelectorAll('[type="submit"]').length, 0);
    assert.equal(field.querySelector('[data-icon="arrow-right"]'), null);
    assert.ok(field.querySelector('[data-icon="external-link"] path'));
    assert.equal(f.button().disabled, false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "https://draft.example/enter-navigation");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.deepEqual(f.opened, []);
    // A single text input with no submit button retains native implicit Enter
    // submission. Exercise its React submit handler; JSDOM has no key default action.
    await act(async () => {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(f.navigationRequests, [
      [
        "thread-a",
        "navigate",
        "tab-a",
        "https://draft.example/enter-navigation",
      ],
    ]);
    assert.deepEqual(f.opened, []);
    await act(async () => f.button().click());
    assert.equal(f.opened[0]![0], "https://example.com/current");
    assert.equal(
      f.navigationRequests.length,
      1,
      "External opening must not submit the address",
    );
  } finally {
    await f.close();
  }
});

test("URL field sizing contains its 44px narrow and touch action without clipping focus", () => {
  const css = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const field = css.match(/\.browser-url-field \{([^}]+)\}/)![1]!;
  assert.match(field, /--browser-url-action-size: 28px/);
  assert.match(
    field,
    /height: calc\(var\(--browser-url-action-size\) \+ 2px\)/,
  );
  assert.match(field, /border: 1px solid/);
  assert.match(field, /min-width: 0/);
  assert.doesNotMatch(field, /overflow: hidden/);
  const action = css.match(
    /\.browser-url-field \.browser-external-open \{([^}]+)\}/,
  )![1]!;
  assert.match(action, /flex: 0 0 var\(--browser-url-action-size\)/);
  assert.match(action, /width: var\(--browser-url-action-size\)/);
  assert.match(action, /height: var\(--browser-url-action-size\)/);
  assert.match(action, /color: var\(--color-text-primary\)/);
  assert.match(
    css,
    /@media \(pointer: coarse\), \(max-width: 720px\) \{\s*\.workspace-browser-address \{\s*height: auto;\s*min-height: 57px;\s*\}\s*\.browser-url-field \{\s*--browser-url-action-size: 44px;/,
  );
});

test("native shortcut opens the current host URL, never an address draft, and follows navigation", async () => {
  const f = await fixture();
  try {
    await f.renderNative();
    const button = f.button();
    assert.equal(button.title, label);
    assert.equal(button.type, "button");
    assert.equal(
      button.querySelector("svg")?.getAttribute("data-icon"),
      "external-link",
    );
    assert.equal(
      button.querySelector("svg")?.getAttribute("aria-hidden"),
      "true",
    );
    button.focus();
    assert.equal(document.activeElement, button);
    const input = document.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "https://draft.example/unsent");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      button.click();
    });
    assert.deepEqual(f.opened, [
      ["https://example.com/current", "_blank", "noopener,noreferrer"],
    ]);
    await f.renderNative({ url: "https://example.com/redirected?q=1#section" });
    await act(async () => f.button().click());
    assert.equal(f.opened[1]![0], "https://example.com/redirected?q=1#section");
    await f.renderNative({ id: "tab-b", url: "http://localhost:8080/next" });
    await act(async () => f.button().click());
    assert.equal(f.opened[2]![0], "http://localhost:8080/next");
  } finally {
    await f.close();
  }
});

test("native shortcut disables unsafe, missing, loading and hidden pages", async () => {
  const f = await fixture();
  try {
    for (const url of unsafeUrls) {
      await f.renderNative({ url });
      assert.equal(f.button().disabled, true, url);
      await act(async () => f.button().click());
    }
    await f.renderNative({ loading: true });
    assert.equal(f.button().disabled, true);
    await f.renderNative({}, false);
    assert.equal(f.button().disabled, true);
    assert.deepEqual(f.opened, []);
  } finally {
    await f.close();
  }
});

test("connected shortcut sends only exact selected identity to the Host, never a renderer URL", async () => {
  const f = await fixture();
  try {
    await f.renderConnected();
    assert.equal(f.button().disabled, true);
    await f.targets([
      target(),
      target({ id: "connected-b", url: "https://other.example/" }),
    ]);
    const field = document.querySelector(".browser-panel-location")!;
    assert.ok(field.classList.contains("browser-url-field"));
    assert.equal(field.lastElementChild, f.button());
    assert.equal(field.querySelectorAll("button").length, 1);
    assert.ok(field.querySelector('[data-icon="external-link"] path'));
    assert.equal(f.button().disabled, false);
    await act(async () => f.button().click());
    assert.deepEqual(f.externalRequests[0], ["thread-a", "connected-a"]);
    await f.targets([target({ url: "https://example.com/after-redirect" })]);
    await act(async () => f.button().click());
    assert.deepEqual(f.externalRequests[1], ["thread-a", "connected-a"]);
    await f.targets(
      [target(), target({ id: "connected-b", url: "https://other.example/" })],
      "connected-b",
    );
    await act(async () => f.button().click());
    assert.deepEqual(f.externalRequests[2], ["thread-a", "connected-b"]);
    assert.deepEqual(f.opened, []);
    await f.targets([target()], "missing");
    assert.equal(f.button().disabled, true);
    await f.targets([]);
    assert.equal(f.button().disabled, true);
  } finally {
    await f.close();
  }
});

test("connected shortcut fences stale subscriptions, thread/provider switches and closed views", async () => {
  const f = await fixture();
  try {
    await f.renderConnected();
    await f.targets();
    const old = f.subscriptions.at(-1)!;
    await f.renderConnected("thread-b");
    assert.equal(f.button().disabled, true);
    await act(async () =>
      old.receive({
        type: "targets",
        targets: [target()],
        selectedId: "connected-a",
      }),
    );
    assert.equal(f.button().disabled, true);
    await f.targets([target({ url: "https://thread-b.example/" })]);
    await f.renderConnected("thread-b", "provider-b");
    assert.equal(f.button().disabled, true);
    await f.targets();
    await f.renderConnected("thread-b", "provider-b", false);
    assert.equal(document.querySelector(`[aria-label="${label}"]`), null);
    await f.renderConnected("thread-b", "provider-b");
    assert.equal(f.button().disabled, true);
  } finally {
    await f.close();
  }
});

test("connected shortcut rejects unsafe/loading URLs and localizes accessible labels", async () => {
  const f = await fixture();
  try {
    await f.renderConnected();
    for (const url of unsafeUrls) {
      await f.targets([target({ url })]);
      assert.equal(f.button().disabled, true, url);
      await act(async () => f.button().click());
    }
    await f.targets([target({ canOpenExternally: false })]);
    assert.equal(f.button().disabled, true);
    await f.targets([target({ loading: true })]);
    assert.equal(f.button().disabled, true);
    await f.targets();
    for (const status of ["connecting", "failed", "unavailable"] as const) {
      await act(async () =>
        f.subscriptions
          .at(-1)!
          .receive({ type: "status", status, message: "Not current" }),
      );
      assert.equal(f.button().disabled, true, status);
    }
    assert.deepEqual(f.opened, []);
    await act(async () => i18n.changeLanguage("zh-CN"));
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="在外部浏览器打开当前页面"]',
    );
    assert.ok(button);
    assert.equal(button.title, "在外部浏览器打开当前页面");
  } finally {
    await f.close();
  }
});

test("connected external opening locks duplicates, reports failure and fences errors after changing target", async () => {
  const f = await fixture();
  try {
    await f.renderConnected();
    await f.targets();
    let reject!: (error: Error) => void;
    f.deferExternal(
      new Promise<void>((_resolve, no) => {
        reject = no;
      }),
    );
    await act(async () => {
      f.button().click();
      f.button().click();
    });
    assert.equal(f.externalRequests.length, 1);
    assert.equal(f.button().disabled, true);
    await act(async () => reject(new Error("Host open failed")));
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Could not open the current page/,
    );
    assert.equal(f.button().disabled, false);
    f.deferExternal(
      new Promise<void>((_resolve, no) => {
        reject = no;
      }),
    );
    await act(async () => f.button().click());
    await f.targets([target({ id: "connected-b" })]);
    await act(async () => reject(new Error("Old target failed")));
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(f.button().disabled, false);
  } finally {
    await f.close();
  }
});
