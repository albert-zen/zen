import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ComputerThreadPanel } from "../src/renderer/src/computer-thread-panel.js";
import { BrowserThreadPanel } from "../src/renderer/src/browser-thread-panel.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { ComputerThreadEvent } from "../src/main/capabilities/computer-thread-observation.js";
import type { BrowserThreadEvent } from "../src/main/capabilities/browser-thread-observation.js";

test("localized observation statuses preserve unsupported and snapshot reasons plus unknown diagnostics", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.test/" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(document, "visibilityState", { get: () => "visible" });
  let computer: ((event: ComputerThreadEvent) => void) | undefined;
  let browser: ((event: BrowserThreadEvent) => void) | undefined;
  Object.assign(dom.window, {
    zenx: {
      computerObservation: {
        subscribe: (
          _request: unknown,
          listener: (event: ComputerThreadEvent) => void,
        ) => {
          computer = listener;
          return () => {};
        },
      },
      browserObservation: {
        subscribe: (
          _request: unknown,
          listener: (event: BrowserThreadEvent) => void,
        ) => {
          browser = listener;
          return () => {};
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => {
      await i18n.changeLanguage("en");
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(ComputerThreadPanel, {
            threadId: "computer",
            active: true,
          }),
          React.createElement(BrowserThreadPanel, {
            threadId: "browser",
            title: "Browser",
            open: true,
            onOpenChange: () => {},
            providerRevision: 1,
          }),
        ),
      );
    });
    assert.match(
      document.body.textContent ?? "",
      /Waiting for the Agent to use a Computer window/,
    );
    assert.match(
      document.body.textContent ?? "",
      /Ask the Agent to open or inspect/,
    );
    await act(async () => {
      computer?.({
        type: "status",
        status: "idle",
        message: "This Computer provider does not support a live window view.",
      });
      browser?.({
        type: "status",
        status: "idle",
        message:
          "Waiting for the Agent to inspect this page. This provider shows snapshots.",
      });
    });
    assert.match(
      document.body.textContent ?? "",
      /does not support a live window view/,
    );
    assert.match(
      document.body.textContent ?? "",
      /This provider shows snapshots/,
    );
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    assert.match(document.body.textContent ?? "", /不支持实时窗口预览/);
    assert.match(document.body.textContent ?? "", /仅显示快照/);
    await act(async () => {
      computer?.({
        type: "status",
        status: "idle",
        message: "Unknown provider detail: alpha",
      });
      browser?.({
        type: "status",
        status: "idle",
        message: "Unknown provider detail: beta",
      });
    });
    assert.match(
      document.body.textContent ?? "",
      /Unknown provider detail: alpha/,
    );
    assert.match(
      document.body.textContent ?? "",
      /Unknown provider detail: beta/,
    );
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    assert.match(
      document.body.textContent ?? "",
      /Unknown provider detail: alpha/,
    );
    assert.match(
      document.body.textContent ?? "",
      /Unknown provider detail: beta/,
    );
  } finally {
    await act(async () => {
      root.unmount();
      await i18n.changeLanguage("en");
    });
    dom.window.close();
  }
});
