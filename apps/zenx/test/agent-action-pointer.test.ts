import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentActionPointer } from "../src/renderer/src/agent-action-pointer.js";
import type { ComputerActionPointer } from "../src/main/capabilities/computer-provider.js";

test("Agent marker stays aligned to the image, expires, and never replays across targets", async () => {
  const dom = new JSDOM('<input id="work"><div id="root"></div>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const input = dom.window.document.getElementById("work")!;
  input.focus();
  const now = Date.now();
  const pointer: ComputerActionPointer = {
    x: 0.25,
    y: 0.75,
    action: "press",
    capturedAt: new Date(now).toISOString(),
    windowWidth: 800,
    windowHeight: 600,
  };
  const render = async (changes: Record<string, unknown> = {}) =>
    act(async () =>
      root.render(
        React.createElement(AgentActionPointer, {
          targetKey: "thread:window",
          actionId: "first",
          pointer,
          width: 400,
          height: 300,
          capturedAt: new Date(now + 1).toISOString(),
          ...changes,
        }),
      ),
    );
  try {
    await render();
    const overlay = dom.window.document.querySelector("svg")!;
    assert.equal(overlay.getAttribute("viewBox"), "0 0 400 300");
    assert.equal(overlay.getAttribute("preserveAspectRatio"), "xMidYMid meet");
    assert.equal(overlay.getAttribute("aria-hidden"), "true");
    assert.equal(overlay.getAttribute("focusable"), "false");
    assert.equal(
      overlay.querySelector("g")?.getAttribute("transform"),
      "translate(100 225) scale(1)",
    );
    assert.equal(dom.window.document.activeElement, input);

    await render({ capturedAt: new Date(now - 1).toISOString() });
    assert.equal(
      dom.window.document.querySelector("svg"),
      null,
      "no point on a frame captured before the action",
    );
    await render({ actionId: "second", pointer: { ...pointer, x: 0.5 } });
    assert.equal(
      dom.window.document.querySelector("polyline")?.getAttribute("points"),
      "100,225 200,225",
      "two actions with the same timestamp remain distinct",
    );
    await render({ width: 600 });
    assert.equal(
      dom.window.document.querySelector("svg"),
      null,
      "resized window geometry must not be stretched",
    );
    await render({ windowWidth: 1600, windowHeight: 1200 });
    assert.equal(
      dom.window.document.querySelector("svg"),
      null,
      "same-aspect resize must also invalidate geometry",
    );
    await render({
      targetKey: "other-thread:other-window",
      pointer: undefined,
    });
    assert.equal(dom.window.document.querySelector("svg"), null);
    await render({
      targetKey: "third-window",
      pointer: { ...pointer, x: Number.NaN },
    });
    assert.equal(dom.window.document.querySelector("svg"), null);
    await render({
      targetKey: "old-window",
      pointer: { ...pointer, capturedAt: new Date(now - 4000).toISOString() },
    });
    assert.equal(
      dom.window.document.querySelector("svg"),
      null,
      "reopening a panel does not animate stale actions",
    );

    await render({
      pointer: {
        ...pointer,
        capturedAt: new Date(Date.now() - 2950).toISOString(),
      },
    });
    assert.ok(dom.window.document.querySelector("svg"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 70)));
    assert.equal(
      dom.window.document.querySelector("svg"),
      null,
      "idle expiry clears marker without another event",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
