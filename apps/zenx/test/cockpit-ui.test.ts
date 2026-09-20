import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Cockpit } from "../src/renderer/src/Cockpit.js";
import { createCockpitHost } from "./fixtures/cockpit-host.js";

test("Cockpit navigation reads the real Host without new Turns; isolated bridge only reads declared source", async () => {
  const host = await createCockpitHost();
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const calls: string[] = [];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, {
    zenx: {
      protocol: {
        request: async (
          method: Parameters<typeof host.client.request>[0],
          params: Parameters<typeof host.client.request>[1],
        ) => {
          calls.push(method);
          return host.client.request(method, params);
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  const summaries = await host.appServer.listThreadSummaries();
  const initial = await host.appServer.readThread(host.threadId);
  const render = async (connected = true) =>
    act(async () =>
      root.render(
        React.createElement(Cockpit, {
          summaries,
          approvals: new Set<string>(),
          connected,
          loading: false,
          error: null,
          onRefresh() {},
          onOpenThread() {},
        }),
      ),
    );
  const click = async (text: string) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes(text),
      );
      assert.ok(button, text);
      button.click();
    });
  try {
    await render();
    assert.deepEqual(calls, []);
    await click("Verify the release evidence");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.deepEqual(calls, ["zen/thread/read"]);
    assert.equal(document.querySelectorAll("iframe").length, 0);
    await click("Open isolated component");
    const frame = document.querySelector("iframe")!;
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
    const messages: any[] = [];
    frame.contentWindow!.postMessage = (value) => messages.push(value);
    await act(async () => frame.dispatchEvent(new window.Event("load")));
    const channel = JSON.parse(
      messages
        .find((value) => value.html)
        .html.match(/const init=(.*?);const deepFreeze/s)[1],
    ).channel;
    const result = initial.items.findLast(
      (item) =>
        item.type === "tool_result" &&
        item.contentType === "cockpit-component/card",
    )!;
    assert.ok(result.type === "tool_result");
    const sourceId = (result.structuredContent as { sourceItemIds: string[] })
      .sourceItemIds[0]!;
    const message = async (operation: string, id: string, input?: unknown) => {
      messages.length = 0;
      await act(async () =>
        window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            source: frame.contentWindow,
            data: {
              channel,
              type: "zenx-plugin-ui:request",
              requestId: "1",
              operation,
              id,
              input,
            },
          }),
        ),
      );
      return messages[0];
    };
    assert.equal((await message("handles.read", sourceId)).value.id, sourceId);
    assert.match(
      (await message("handles.read", "unrelated-item")).message,
      /declared scope/,
    );
    assert.match(
      (await message("commands.execute", "turn\/start")).message,
      /cannot execute/,
    );
    assert.match(
      (await message("navigation.navigate", "route", "/threads/other")).message,
      /disabled/,
    );
    const after = await host.appServer.readThread(host.threadId);
    assert.deepEqual(after.items, initial.items);
    await render(false);
    assert.match(document.body.textContent!, /Unknown \/ stale/);
    assert.equal(
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Run Agent",
      )?.disabled,
      true,
    );
    await click("Source 1");
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Canonical source",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    await host.close();
  }
});
