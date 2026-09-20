import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";

import type { ComputerThreadEvent } from "../src/main/capabilities/computer-thread-observation.js";
import { ComputerThreadPanel } from "../src/renderer/src/computer-thread-panel.js";

test("Computer panel follows the Agent until the user pins and pauses frames while hidden", async () => {
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
    { threadId: "thread-a", targetId: undefined, frames: true },
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
  const select = dom.window.document.querySelector("select")!;
  assert.equal(select.value, "__follow__");
  assert.match(select.textContent ?? "", /Follow Agent/u);
  assert.doesNotMatch(dom.window.document.body.textContent ?? "", /private-call-id/u);
  assert.match(select.title, /latest-private-call-id/u);

  select.value = "window-a";
  await act(async () =>
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true })),
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

  await act(async () => root.unmount());
  dom.window.close();
});
