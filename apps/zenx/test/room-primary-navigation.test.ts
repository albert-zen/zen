import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
test("primary Room navigation switches conversations without a duplicate rail or starting a turn", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const calls: string[] = [];
  const routes: string[] = [];
  const rooms = ["a", "b"].map((id) => ({
    id,
    name: `Room ${id}`,
    members: [],
    messages: [],
    createdAt: 0,
  }));
  const sdk = (id: string) =>
    ({
      context: {
        route: `/plugins/zenx-rooms/rooms?roomId=${id}`,
        primaryNavigation: true,
      },
      navigation: { navigate: (route: string) => routes.push(route) },
      commands: {
        execute: async (command: string) => {
          calls.push(command);
          if (command === "list") return { rooms };
          throw Error(command);
        },
      },
    }) as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk("a") })),
    );
    assert.equal(
      document.querySelector('nav[aria-label="Rooms"]') === null,
      true,
    );
    assert.equal(document.querySelector("h2")?.textContent, "#Room a");
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk("b") })),
    );
    assert.equal(document.querySelector("h2")?.textContent, "#Room b");
    const panel = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open conversation workspace"]',
    );
    assert.ok(panel);
    await act(async () => panel.click());
    assert.match(routes.at(-1)!, /roomId=b.*panel=open/);
    assert.ok(calls.every((x) => x === "list"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
