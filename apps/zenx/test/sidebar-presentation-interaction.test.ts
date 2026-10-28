import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  emptySidebarState,
  applySidebarPatch,
  type ThreadSidebarApi,
} from "../src/thread-sidebar-state.js";
import { useThreadSidebar } from "../src/renderer/src/use-thread-sidebar.js";

test("production sidebar hook paints open/close before slow Host and shows failed persistence", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const prior = { window: globalThis.window, document: globalThis.document };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stored = emptySidebarState("a");
  let fail = false;
  const api = {
    read: async () => stored,
    update: async (request) => {
      await gate;
      if (fail) throw Error("synthetic write failure");
      stored = applySidebarPatch(stored, request.patch);
      return { applied: true, state: stored };
    },
    onChanged: () => () => {},
  } satisfies ThreadSidebarApi;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    React,
  });
  Object.assign(dom.window, { zenx: { threadSidebar: api } });
  function View() {
    const sidebar = useThreadSidebar();
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "button",
        {
          onClick: () =>
            sidebar.setBrowserPanels((map) => ({ ...map, a: !map.a })),
        },
        "Toggle",
      ),
      React.createElement(
        "output",
        { "data-open": !!sidebar.browserPanels.a },
        sidebar.error,
      ),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(async () => root.render(React.createElement(View)));
    await React.act(async () => document.querySelector("button")!.click());
    assert.equal(
      document.querySelector("output")!.getAttribute("data-open"),
      "true",
    );
    assert.equal(stored.revision, 0);
    await React.act(async () => document.querySelector("button")!.click());
    assert.equal(
      document.querySelector("output")!.getAttribute("data-open"),
      "false",
    );
    await React.act(async () => {
      release();
      await gate;
    });
    assert.equal(stored.revision, 2);
    fail = true;
    await React.act(async () => document.querySelector("button")!.click());
    assert.equal(
      document.querySelector("output")!.getAttribute("data-open"),
      "false",
    );
    assert.match(
      document.querySelector("output")!.textContent!,
      /synthetic write failure/,
    );
  } finally {
    release();
    await React.act(async () => root.unmount());
    Object.assign(globalThis, prior, { IS_REACT_ACT_ENVIRONMENT: undefined });
    dom.window.close();
  }
});
