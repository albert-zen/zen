import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserThreadPanel } from "../src/renderer/src/browser-thread-panel.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type {
  BrowserThreadEvent,
  BrowserThreadTarget,
} from "../src/main/capabilities/browser-thread-observation.js";

const target: BrowserThreadTarget = {
  id: "connected:synthetic-page",
  sessionId: "synthetic-session",
  tabId: "synthetic-tab",
  title: "Synthetic reference page",
  url: "https://example.test/reference",
  loading: false,
  mode: "live",
  backendId: "connected",
  canOpenExternally: true,
};
const originalError =
  'Synthetic observation failure: <img src=x onerror="alert(1)">\nCause: E_SYNTHETIC_SOCKET';

async function fixture(fixedTargetId?: string) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.test/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const listeners: Array<(event: BrowserThreadEvent) => void> = [];
  let stopped = 0;
  let opened = 0;
  Object.assign(window, {
    zenx: {
      browserObservation: {
        subscribe(
          _request: unknown,
          listener: (event: BrowserThreadEvent) => void,
        ) {
          listeners.push(listener);
          return () => stopped++;
        },
        openExternal: async () => {
          opened++;
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  const render = async (providerRevision = 1) => {
    await act(async () => {
      root.render(
        React.createElement(BrowserThreadPanel, {
          threadId: "synthetic-thread",
          title: "Synthetic observation fixture",
          open: true,
          embedded: true,
          fixedTargetId,
          providerRevision,
          onOpenChange() {},
        }),
      );
    });
  };
  await i18n.changeLanguage("en");
  await render();
  return {
    listeners,
    render,
    get stopped() {
      return stopped;
    },
    get opened() {
      return opened;
    },
    text: () => document.body.textContent ?? "",
    status: () => document.querySelector('[role="status"]')!.textContent!,
    send: async (event: BrowserThreadEvent) => {
      await act(async () => listeners.at(-1)!(event));
    },
    async close() {
      await act(async () => root.unmount());
      await i18n.changeLanguage("en");
      dom.window.close();
    },
  };
}
const failed = {
  type: "status",
  status: "failed",
  message: "The live browser view could not be connected.",
  details: originalError,
} as const;

test("failed subscribe before targets is one honest failure with literal original details", async () => {
  const f = await fixture(target.id);
  try {
    assert.match(f.status(), /Reading browser observation/);
    assert.doesNotMatch(
      f.text(),
      /No page for this thread|Selected page unavailable|Agent snapshots/,
    );
    await f.send(failed);
    assert.equal(document.querySelectorAll('[role="status"]').length, 1);
    assert.match(f.status(), /Page preview failed/);
    assert.match(f.status(), /Synthetic observation failure/);
    assert.doesNotMatch(
      f.text(),
      /No page for this thread|Selected page unavailable|Agent snapshots|temporary local artifacts/,
    );
    assert.doesNotMatch(
      f.text(),
      /private page content|may still be open|does not mean|could not be confirmed/iu,
    );
    assert.equal(document.querySelector(".browser-live-privacy-note"), null);
    assert.equal(document.querySelector(".browser-observation-note"), null);
    assert.equal(document.querySelectorAll("pre").length, 1);
    assert.equal(document.querySelector("pre")!.textContent, originalError);
    assert.equal(document.querySelector("details")!.open, false);
    assert.equal(document.querySelector("pre img"), null);
    assert.equal(document.querySelector("pre script"), null);
    assert.equal(document.querySelector("pre")!.tabIndex, 0);
    await act(async () => document.querySelector("summary")!.click());
    assert.equal(document.querySelector("details")!.open, true);
    assert.equal(
      f.listeners.length,
      1,
      "Opening diagnostics is presentation only",
    );
    assert.equal(f.opened, 0);
    assert.equal(
      document.querySelector<HTMLButtonElement>(".browser-external-open")!
        .disabled,
      true,
    );
    assert.equal(f.opened, 0);
    assert.equal(
      f.listeners.length,
      1,
      "Failure must not restart or replay anything",
    );
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    assert.match(f.status(), /页面预览失败/);
    assert.match(f.status(), /Synthetic observation failure/);
    assert.equal(document.querySelector("pre")!.textContent, originalError);
  } finally {
    await f.close();
  }
});

test("stream failure retains known target metadata, clears stale frame and recovers without stale failure", async () => {
  const f = await fixture(target.id);
  try {
    await f.send({ type: "targets", targets: [target], selectedId: target.id });
    await f.send({
      type: "snapshot",
      data: "AA==",
      mimeType: "image/png",
      width: 1,
      height: 1,
      capturedAt: "2026-10-29T00:00:00Z",
    });
    assert.ok(
      document.querySelector(".browser-live-frame")!.getAttribute("src"),
    );
    await f.send(failed);
    assert.equal(
      document.querySelector(".browser-selected-title")!.textContent,
      target.title,
    );
    assert.equal(
      document.querySelector(".browser-panel-location span")!.textContent,
      target.url,
    );
    assert.match(f.status(), /Synthetic observation failure/);
    assert.match(
      document.querySelector(".browser-live-mode")!.textContent!,
      /Live page/,
    );
    assert.doesNotMatch(
      f.text(),
      /No page for this thread|Selected page unavailable|Agent snapshots/,
    );
    assert.equal(
      document.querySelector(".browser-live-frame")!.getAttribute("src"),
      null,
    );
    assert.equal(document.querySelectorAll('[role="status"]').length, 1);
    await f.send({
      type: "status",
      status: "live",
      message: "Synthetic preview connected.",
    });
    await f.send({
      type: "frame",
      frame: {
        sequence: 1,
        mimeType: "image/jpeg",
        data: "AA==",
        width: 1,
        height: 1,
      },
    });
    assert.equal(
      document
        .querySelector(".browser-live-stage")!
        .getAttribute("data-has-frame"),
      "true",
    );
    assert.equal(document.querySelector("details"), null);
    assert.doesNotMatch(f.text(), /Page preview failed|E_SYNTHETIC_SOCKET/);
    assert.equal(document.querySelectorAll('[role="status"]').length, 1);
    assert.equal(f.listeners.length, 1);
  } finally {
    await f.close();
  }
});

test("known empty catalog and unresolved fixed target are distinct from an unread catalog", async () => {
  const empty = await fixture();
  try {
    await empty.send({ type: "targets", targets: [] });
    assert.match(empty.status(), /No page for this thread/);
    assert.match(empty.status(), /Ask the Agent to open or inspect/);
    assert.doesNotMatch(
      empty.text(),
      /Selected page unavailable|Agent snapshots/,
    );
  } finally {
    await empty.close();
  }
  const missing = await fixture(target.id);
  try {
    await missing.send({ type: "targets", targets: [] });
    assert.match(missing.status(), /Selected page unavailable/);
    assert.doesNotMatch(
      missing.text(),
      /No page for this thread|Agent snapshots/,
    );
  } finally {
    await missing.close();
  }
});

test("old subscriptions cannot restore errors or metadata after a new observation", async () => {
  const f = await fixture(target.id);
  try {
    await f.send(failed);
    const old = f.listeners[0]!;
    await f.render(2);
    assert.equal(f.stopped, 1);
    await act(async () => old(failed));
    assert.match(f.status(), /Reading browser observation/);
    assert.equal(document.querySelector("details"), null);
    await f.send({ type: "targets", targets: [target], selectedId: target.id });
    assert.match(f.status(), /Waiting for a browser image/);
    await f.send({
      type: "status",
      status: "failed",
      message: "Synthetic legacy error without details",
    });
    assert.equal(
      document.querySelector("pre")!.textContent,
      "Synthetic legacy error without details",
    );
  } finally {
    await f.close();
  }
});

test("unavailable observation preserves supplied local details without inventing them for ordinary absence", async () => {
  const f = await fixture(target.id);
  try {
    await f.send({ type: "targets", targets: [target], selectedId: target.id });
    await f.send({
      type: "status",
      status: "unavailable",
      message:
        "The last screenshot is no longer available. Ask the Agent to inspect this page again.",
      details: originalError,
    });
    assert.match(f.status(), /Browser preview unavailable/);
    assert.doesNotMatch(f.status(), /Selected page unavailable/);
    assert.equal(document.querySelector("pre")!.textContent, originalError);
    assert.equal(document.querySelector("pre img"), null);
    await f.send({
      type: "status",
      status: "unavailable",
      message:
        "This browser page is no longer available. Ask the Agent to inspect it again.",
    });
    assert.equal(document.querySelector("details"), null);
    assert.equal(f.listeners.length, 1);
    assert.equal(f.opened, 0);
  } finally {
    await f.close();
  }
});

test("structured diagnostics expose their actual message before disclosure while artifact notes need known snapshot mode", async () => {
  const f = await fixture(target.id);
  try {
    const details = JSON.stringify(
      {
        message:
          "Synthetic exact-target observer attach rejected <b>literally</b>",
        code: "E_SYNTHETIC_ATTACH",
        cause: { message: "Synthetic nested failure" },
      },
      null,
      2,
    );
    await f.send({ ...failed, details });
    assert.match(
      f.status(),
      /Synthetic exact-target observer attach rejected <b>literally<\/b>/,
    );
    assert.doesNotMatch(
      f.status(),
      /The live browser view could not be connected/,
    );
    assert.equal(document.querySelector('[role="status"] b'), null);
    assert.equal(document.querySelector("pre")!.textContent, details);
    assert.equal(document.querySelector("details")!.open, false);
    await f.send({
      type: "targets",
      targets: [{ ...target, mode: "snapshot" }],
      selectedId: target.id,
    });
    assert.match(
      document.querySelector(".browser-observation-note")!.textContent!,
      /temporary local artifacts/,
    );
    await f.send({ type: "targets", targets: [target], selectedId: target.id });
    assert.equal(document.querySelector(".browser-observation-note"), null);
    assert.doesNotMatch(f.text(), /private page content|not recorded/iu);
    assert.equal(f.listeners.length, 1);
  } finally {
    await f.close();
  }
});
