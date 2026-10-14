import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Cockpit } from "../src/renderer/src/Cockpit.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { createCockpitHost } from "./fixtures/cockpit-host.js";

test("Cockpit follows live language changes without translating canonical content or reading the Host", async () => {
  const host = await createCockpitHost();
  const summaries = await host.appServer.listThreadSummaries();
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        React.createElement(Cockpit, {
          summaries,
          approvals: new Set<string>(),
          connected: true,
          loading: false,
          overviewReadAt: Date.now(),
          error: null,
          onRefresh() {},
          onOpenThread() {},
        }),
      ),
    );
    assert.match(document.body.textContent!, /Refresh overview/);
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    assert.match(document.body.textContent!, /刷新概览/);
    assert.match(document.body.textContent!, /空闲/);
    assert.match(document.body.textContent!, /Verify the release evidence/);
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    assert.match(document.body.textContent!, /Refresh overview/);
  } finally {
    await act(async () => root.unmount());
    await i18n.changeLanguage("en");
    dom.window.close();
    await host.close();
  }
});
