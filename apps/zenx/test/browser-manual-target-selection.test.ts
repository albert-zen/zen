import "./dom-primitives.js";
import { chooseValue } from "./choice-interaction.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserThreadPanel } from "../src/renderer/src/browser-thread-panel.js";
import type {
  BrowserThreadEvent,
  BrowserThreadRequest,
  BrowserThreadTarget,
} from "../src/main/capabilities/browser-thread-observation.js";

const target = (id: string): BrowserThreadTarget => ({
  id,
  sessionId: "session",
  tabId: id,
  title: `Page ${id}`,
  url: `https://example.test/${id}`,
  loading: false,
  mode: "live",
  backendId: "connected",
  canOpenExternally: true,
});

test("Browser target selection is manual, survives Agent activity and view remounts, and never opens a closed panel", async () => {
  const dom = new JSDOM('<input id="composer"><div id="root"></div>', {
    url: "https://zenx.local",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let targets = [target("a"), target("b")];
  const requests: BrowserThreadRequest[] = [];
  const opened: boolean[] = [];
  let listener!: (event: BrowserThreadEvent) => void;
  let stopped = 0;
  (window as any).zenx = {
    browserObservation: {
      subscribe(request: BrowserThreadRequest, receive: typeof listener) {
        requests.push(request);
        listener = receive;
        receive({
          type: "targets",
          targets,
          selectedId: targets.find((target) => target.id === request.targetId)
            ?.id,
        });
        receive({
          type: "status",
          status: request.targetId ? "live" : "idle",
          message: "",
        });
        return () => {
          stopped++;
        };
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  const render = async (
    open: boolean | undefined = true,
    threadId = "manual-browser",
  ) =>
    act(async () =>
      root.render(
        React.createElement(BrowserThreadPanel, {
          threadId,
          title: "Browser",
          open,
          onOpenChange: (value) => opened.push(value),
          providerRevision: "provider",
        }),
      ),
    );
  const picker = () => document.querySelector<HTMLButtonElement>(".ui-select")!;
  const send = async (event: BrowserThreadEvent) =>
    act(async () => listener(event));
  const frame = (sequence: number): BrowserThreadEvent => ({
    type: "frame",
    frame: {
      sequence,
      mimeType: "image/jpeg",
      data: Buffer.from(`frame-${sequence}`).toString("base64"),
      width: 20,
      height: 10,
    },
  });
  try {
    await render(undefined);
    assert.deepEqual(opened, [], "first discovered pages never open the panel");
    assert.equal(requests.at(-1)?.frames, false);
    await render();
    assert.equal(picker().dataset.value, "");
    assert.match(picker().textContent ?? "", /Choose a page/);
    assert.equal(document.body.textContent?.includes("Follow Agent"), false);
    document.getElementById("composer")!.focus();
    await send({ type: "targets", targets, selectedId: "b" });
    await send({ type: "status", status: "live", message: "" });
    await send(frame(1));
    assert.equal(picker().dataset.value, "");
    assert.equal(
      document.querySelector(".browser-live-frame")?.getAttribute("src"),
      null,
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(".browser-external-open")
        ?.disabled,
      true,
    );
    assert.equal(document.activeElement?.id, "composer");
    await chooseValue(picker(), "a");
    assert.equal(requests.at(-1)?.targetId, "a");
    assert.equal(requests.at(-1)?.frames, true);
    const requestCount = requests.length;
    document.getElementById("composer")!.focus();
    await send(frame(2));
    const first = document
      .querySelector(".browser-live-frame")
      ?.getAttribute("src");
    targets = [target("b"), target("c"), target("a")];
    await send({ type: "targets", targets, selectedId: "a" });
    await send({
      type: "activity",
      threadId: "manual-browser",
      sessionEpoch: "session",
      operationId: "op",
      operationSequence: 1,
      callId: "call",
      targetId: "c",
      requestedAt: Date.now(),
      phase: "started",
    });
    await send(frame(3));
    assert.equal(picker().dataset.value, "a");
    assert.equal(requests.length, requestCount);
    assert.notEqual(
      document.querySelector(".browser-live-frame")?.getAttribute("src"),
      first,
      "chosen target frames continue updating",
    );
    assert.equal(document.activeElement?.id, "composer");
    targets = [target("b"), target("c")];
    await send({ type: "targets", targets });
    assert.equal(picker().dataset.value, "a");
    assert.match(document.body.textContent ?? "", /Selected page unavailable/);
    assert.equal(
      document.querySelector(".browser-live-frame")?.getAttribute("src"),
      null,
    );
    await render(false);
    await render();
    assert.equal(
      requests.at(-1)?.targetId,
      "a",
      "reopening preserves exact stale human choice",
    );
    await render(true, "other-browser");
    assert.equal(
      requests.at(-1)?.targetId,
      undefined,
      "another Thread cannot inherit the target",
    );
    await render();
    assert.equal(requests.at(-1)?.targetId, "a");
    await chooseValue(picker(), "b");
    assert.equal(requests.at(-1)?.targetId, "b");
    assert.equal(
      document.querySelector<HTMLButtonElement>(".browser-external-open")
        ?.disabled,
      false,
    );
    assert.deepEqual(opened, []);
    assert.ok(stopped > 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
