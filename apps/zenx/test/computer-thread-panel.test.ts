import { chooseValue } from "./choice-interaction.js";
import "./dom-primitives.js";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";

import type { ComputerThreadEvent } from "../src/main/capabilities/computer-thread-observation.js";
import { ComputerThreadPanel } from "../src/renderer/src/computer-thread-panel.js";

test("Computer panel requires human target selection, keeps it during Agent activity and pauses frames while hidden", async () => {
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
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const requests: unknown[] = [];
  let listener: ((event: ComputerThreadEvent) => void) | undefined;
  let disposals = 0;
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      computerObservation: {
        subscribe(
          request: unknown,
          next: (event: ComputerThreadEvent) => void,
        ) {
          requests.push(request);
          listener = next;
          return () => {
            if (listener === next) listener = undefined;
            disposals += 1;
          };
        },
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(ComputerThreadPanel, {
        threadId: "thread-a",
        active: true,
      }),
    ),
  );
  assert.deepEqual(requests, [
    { threadId: "thread-a", targetId: undefined, frames: false },
  ]);
  await act(async () =>
    listener?.({
      type: "targets",
      targets: [
        {
          id: "window-a",
          invocationId: "private-call-id",
          mode: "live",
          target: { pid: 101, windowTitle: "First window" },
          activity: { kind: "background-window", count: 1 },
        },
        {
          id: "window-b",
          invocationId: "latest-private-call-id",
          mode: "live",
          target: { pid: 202, windowTitle: "Latest window" },
        },
      ],
      selectedId: "window-b",
    }),
  );
  const select =
    dom.window.document.querySelector<HTMLButtonElement>(".ui-select")!;
  assert.equal(select.dataset.value, "");
  assert.match(select.textContent ?? "", /Choose a window or application/u);
  assert.doesNotMatch(document.body.textContent ?? "", /Follow Agent/u);
  assert.doesNotMatch(
    dom.window.document.body.textContent ?? "",
    /private-call-id/u,
  );
  assert.doesNotMatch(select.title, /private-call-id/u);
  assert.ok(
    document.querySelector(".computer-activity") === null,
    "an unselected catalog cannot claim activity or idle for a window",
  );

  await chooseValue(select, "window-a");
  await act(async () =>
    listener?.({
      type: "targets",
      targets: [
        {
          id: "window-a",
          invocationId: "private-call-id",
          mode: "live",
          target: { pid: 101, windowTitle: "First window" },
          activity: { kind: "background-window", count: 1 },
        },
      ],
      selectedId: "window-a",
    }),
  );
  await act(async () =>
    listener?.({ type: "status", status: "failed", message: "Capture failed" }),
  );
  assert.match(
    dom.window.document.querySelector(".computer-activity")?.textContent ?? "",
    /Agent is working in First window/u,
  );

  assert.deepEqual(requests.at(-1), {
    threadId: "thread-a",
    targetId: "window-a",
    frames: true,
  });

  await act(async () => {
    listener?.({
      type: "frame",
      frame: {
        sequence: 1,
        mimeType: "image/jpeg",
        data: Buffer.from("frame").toString("base64"),
        width: 100,
        height: 80,
        capturedAt: new Date().toISOString(),
      },
    });
  });
  assert.ok(dom.window.document.querySelector(".computer-live-frame"));

  // Another Agent target can be discovered or operated without changing the human choice.
  await act(async () =>
    listener?.({
      type: "targets",
      selectedId: "window-a",
      targets: [
        {
          id: "window-b",
          invocationId: "new-activity",
          mode: "live",
          target: { pid: 202, windowTitle: "Other window" },
          activity: { kind: "foreground", count: 1 },
        },
        {
          id: "window-a",
          invocationId: "private-call-id",
          mode: "live",
          target: { pid: 101, windowTitle: "First window" },
        },
      ],
    }),
  );
  assert.equal(select.dataset.value, "window-a");
  assert.equal(
    requests.length,
    2,
    "Agent activity never changes the target subscription",
  );
  assert.match(
    document.querySelector(".computer-live-frame")?.getAttribute("alt") ?? "",
    /First window/,
  );

  visibility = "hidden";
  await act(async () =>
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")),
  );
  assert.equal(disposals, 2);
  assert.equal(dom.window.document.querySelector(".computer-live-frame"), null);
  assert.equal(requests.length, 2, "hidden documents must not capture frames");

  visibility = "visible";
  await act(async () =>
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")),
  );
  assert.equal(requests.length, 3);
  assert.equal(dom.window.document.querySelector(".computer-live-frame"), null);

  await act(async () =>
    listener?.({
      type: "targets",
      targets: [
        {
          id: "window-b",
          invocationId: "new-activity",
          mode: "live",
          target: { pid: 202, windowTitle: "Other window" },
        },
      ],
    }),
  );
  assert.equal(select.dataset.value, "window-a");
  assert.match(
    document.body.textContent ?? "",
    /Selected window or application unavailable/,
  );
  assert.ok(
    document.querySelector(".computer-live-frame") === null,
    "an unavailable selected target has no stale frame",
  );
  await act(async () =>
    root.render(
      React.createElement(ComputerThreadPanel, {
        threadId: "thread-b",
        active: true,
      }),
    ),
  );
  assert.deepEqual(requests.at(-1), {
    threadId: "thread-b",
    targetId: undefined,
    frames: false,
  });
  await act(async () =>
    root.render(
      React.createElement(ComputerThreadPanel, {
        threadId: "thread-a",
        active: true,
      }),
    ),
  );
  assert.deepEqual(requests.at(-1), {
    threadId: "thread-a",
    targetId: "window-a",
    frames: true,
  });

  await act(async () => root.unmount());
  dom.window.close();
});
