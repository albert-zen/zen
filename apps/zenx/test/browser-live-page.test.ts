import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";

import type { BrowserLiveObservationEvent } from "../src/main/capabilities/browser-provider.js";
import { BrowserPage } from "../src/renderer/src/bundled-browser-ui.js";

test("Browser observer keeps status, privacy, and mode in one compact toolbar", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      browserObservation: {
        subscribe() {
          return () => {};
        },
      },
    },
  });

  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(React.createElement(BrowserPage)));

  const toolbar = dom.window.document.querySelector(
    ".browser-live-toolbar[aria-label='Browser observation']",
  );
  assert.ok(toolbar);
  assert.match(toolbar.textContent ?? "", /observer only/iu);
  assert.match(
    toolbar.textContent ?? "",
    /private page content may be visible/iu,
  );
  assert.match(toolbar.textContent ?? "", /not recorded/iu);
  assert.equal(
    dom.window.document.querySelectorAll("[role='status']").length,
    1,
  );
  const status = dom.window.document.querySelector("[role='status']");
  assert.equal(status?.getAttribute("aria-live"), "polite");
  assert.equal(status?.getAttribute("aria-atomic"), "true");
  assert.equal(dom.window.document.querySelector(".browser-live-intro"), null);
  assert.equal(
    dom.window.document.querySelector(".browser-live-privacy"),
    null,
  );
  assert.equal(dom.window.document.querySelector("h2"), null);
  assert.match(
    dom.window.document.querySelector(".browser-live-placeholder")
      ?.textContent ?? "",
    /ask the agent to open or inspect a tab/iu,
  );

  await act(async () => root.unmount());
  dom.window.close();
});

test("Browser observer gives the live stage the remaining page height", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.browser-live-page\s*\{[^}]*height:\s*100%;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/su,
  );
  assert.match(
    css,
    /\.browser-live-stage\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;/su,
  );
  assert.doesNotMatch(css, /\.browser-live-stage\s*\{[^}]*aspect-ratio:/su);
});

test("Browser page updates frames without moving focus or announcing every frame", async () => {
  const dom = new JSDOM(
    '<button id="before">Before</button><div id="root"></div>',
    { url: "https://zenx.local/" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  let listener: ((event: BrowserLiveObservationEvent) => void) | undefined;
  let disposals = 0;
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      browserObservation: {
        subscribe(next: (event: BrowserLiveObservationEvent) => void) {
          listener = next;
          return () => {
            listener = undefined;
            disposals += 1;
          };
        },
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(React.createElement(BrowserPage)));
  assert.match(
    dom.window.document.querySelector("[role='status']")?.textContent ?? "",
    /waiting for the agent/iu,
  );
  assert.match(
    dom.window.document.body.textContent ?? "",
    /private page content/iu,
  );

  const before = dom.window.document.getElementById(
    "before",
  ) as HTMLButtonElement;
  before.focus();
  await act(async () => {
    listener?.({
      type: "status",
      status: "live",
      message: "Watching the Agent's browser tab live.",
    });
  });
  const status = dom.window.document.querySelector("[role='status']");
  const statusText = status?.textContent;
  for (let sequence = 1; sequence <= 64; sequence += 1) {
    await act(async () => {
      listener?.({
        type: "frame",
        frame: {
          sequence,
          mimeType: "image/jpeg",
          data: Buffer.from(`frame-${sequence}`).toString("base64"),
          width: 1280,
          height: 720,
        },
      });
    });
  }
  const image = dom.window.document.querySelector(
    ".browser-live-frame",
  ) as HTMLImageElement;
  assert.match(image.src, /ZnJhbWUtNjQ=$/u);
  assert.equal(status?.textContent, statusText);
  assert.equal(dom.window.document.activeElement, before);

  const clearingStatuses = [
    {
      type: "status",
      status: "connecting",
      message: "Connecting to the Agent's browser tab…",
    },
    {
      type: "status",
      status: "idle",
      message: "Waiting for the Agent to use a browser tab.",
    },
    {
      type: "status",
      status: "unavailable",
      message: "The observed browser tab is no longer attached.",
    },
    {
      type: "status",
      status: "failed",
      message: "The live browser view could not resume.",
    },
  ] satisfies Extract<BrowserLiveObservationEvent, { type: "status" }>[];
  for (const [index, clearingStatus] of clearingStatuses.entries()) {
    await act(async () => listener?.(clearingStatus));
    assert.equal(image.getAttribute("src"), null);
    assert.equal(
      dom.window.document
        .querySelector(".browser-live-stage")
        ?.getAttribute("data-has-frame"),
      "false",
    );
    assert.ok(dom.window.document.querySelector(".browser-live-placeholder"));
    assert.equal(dom.window.document.activeElement, before);
    await act(async () => {
      listener?.({
        type: "frame",
        frame: {
          sequence: 999,
          mimeType: "image/jpeg",
          data: Buffer.from("late-stale-frame").toString("base64"),
          width: 1280,
          height: 720,
        },
      });
    });
    assert.equal(image.getAttribute("src"), null);

    await act(async () => {
      listener?.({
        type: "status",
        status: "live",
        message: "Watching the Agent's browser tab live.",
      });
    });
    assert.equal(image.getAttribute("src"), null);
    assert.ok(dom.window.document.querySelector(".browser-live-placeholder"));
    const liveStatus = dom.window.document.querySelector("[role='status']");
    const liveStatusText = liveStatus?.textContent;
    const freshFrame = `fresh-frame-${index}`;
    await act(async () => {
      listener?.({
        type: "frame",
        frame: {
          sequence: 1,
          mimeType: "image/jpeg",
          data: Buffer.from(freshFrame).toString("base64"),
          width: 1280,
          height: 720,
        },
      });
    });
    assert.match(
      image.src,
      new RegExp(`${Buffer.from(freshFrame).toString("base64")}$`, "u"),
    );
    assert.equal(liveStatus?.textContent, liveStatusText);
    assert.equal(dom.window.document.activeElement, before);
  }

  await act(async () => root.unmount());
  assert.equal(disposals, 1);
  dom.window.close();
});

test("Browser page clears its frame while hidden and resumes with a fresh sequence", async () => {
  const dom = new JSDOM(
    '<button id="before">Before</button><div id="root"></div>',
    {
      url: "https://zenx.local/",
    },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  let subscriptions = 0;
  let disposals = 0;
  let listener: ((event: BrowserLiveObservationEvent) => void) | undefined;
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      browserObservation: {
        subscribe(next: (event: BrowserLiveObservationEvent) => void) {
          subscriptions += 1;
          listener = next;
          return () => {
            if (listener === next) listener = undefined;
            disposals += 1;
          };
        },
      },
    },
  });
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(React.createElement(BrowserPage)));
  assert.equal(subscriptions, 1);
  const before = dom.window.document.getElementById(
    "before",
  ) as HTMLButtonElement;
  before.focus();
  await act(async () => {
    listener?.({
      type: "status",
      status: "live",
      message: "Watching the Agent's browser tab live.",
    });
    listener?.({
      type: "frame",
      frame: {
        sequence: 42,
        mimeType: "image/jpeg",
        data: Buffer.from("before-hidden").toString("base64"),
        width: 1280,
        height: 720,
      },
    });
  });
  const image = dom.window.document.querySelector(
    ".browser-live-frame",
  ) as HTMLImageElement;
  assert.match(image.src, /YmVmb3JlLWhpZGRlbg==$/u);

  visibility = "hidden";
  await act(async () =>
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")),
  );
  assert.equal(disposals, 1);
  assert.equal(image.getAttribute("src"), null);
  assert.equal(
    dom.window.document
      .querySelector(".browser-live-stage")
      ?.getAttribute("data-has-frame"),
    "false",
  );
  assert.ok(dom.window.document.querySelector(".browser-live-placeholder"));
  assert.equal(dom.window.document.activeElement, before);
  visibility = "visible";
  await act(async () =>
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")),
  );
  assert.equal(subscriptions, 2);
  assert.equal(image.getAttribute("src"), null);
  await act(async () => {
    listener?.({
      type: "status",
      status: "live",
      message: "Watching the Agent's browser tab live.",
    });
  });
  const liveStatus = dom.window.document.querySelector("[role='status']");
  const liveStatusText = liveStatus?.textContent;
  await act(async () => {
    listener?.({
      type: "frame",
      frame: {
        sequence: 1,
        mimeType: "image/jpeg",
        data: Buffer.from("after-hidden").toString("base64"),
        width: 1280,
        height: 720,
      },
    });
  });
  assert.match(image.src, /YWZ0ZXItaGlkZGVu$/u);
  assert.equal(liveStatus?.textContent, liveStatusText);
  assert.equal(dom.window.document.activeElement, before);

  await act(async () => root.unmount());
  assert.equal(disposals, 2);
  dom.window.close();
});
