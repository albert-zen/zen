import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelRequestDebugPanel } from "../src/renderer/src/ModelRequestDebugDialog.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { ModelRequestDebugStore } from "../../cli/src/model-request-debug.js";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
} from "../../cli/src/model-request-debug-types.js";
import { InMemoryTraceStore } from "../../../src/trace.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });

async function withDom(run: (root: Root) => Promise<void>) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "http://localhost" },
  );
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: false });
    dom.window.close();
  }
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
function button(text: string) {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (x) =>
      x.textContent?.includes(text) ||
      x.getAttribute("aria-label")?.includes(text),
  );
  assert(found, `Missing button ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
  await settle();
}
function connect(
  request: (
    input: ModelRequestDebugCommand,
  ) => Promise<ModelRequestDebugResult>,
) {
  Object.assign(window, { zenx: { modelRequestDebug: { request } } });
}
async function fixture(threadId = "synthetic-thread") {
  const trace = new InMemoryTraceStore();
  await trace.record({
    threadId,
    sampleId: "sample",
    type: "model_sample_started",
    data: {
      model: "frozen-model",
      purpose: "turn",
      configuration: { permission: "ask" },
    },
  });
  const body = JSON.stringify({
    model: "frozen-model",
    instructions: "trusted-system",
    messages: [
      { role: "user", content: "<img src=x onerror=alert(1)>原文🙂".repeat(6) },
    ],
    tools: [{ name: "test_tool" }],
  });
  const request = await trace.record({
    threadId,
    sampleId: "sample",
    type: "model_request",
    data: { transportAttempt: 1, model: "frozen-model", format: "responses" },
    artifacts: [{ name: "request_body", bytes: body }],
  });
  await trace.record({
    threadId,
    sampleId: "sample",
    type: "model_request_dispatched",
    data: { transportAttempt: 1 },
  });
  await trace.record({
    threadId,
    sampleId: "sample",
    type: "model_sample_finished",
    data: { outcome: "completed", elapsedNs: "125000000" },
  });
  const store = new ModelRequestDebugStore(trace, { pageCharacters: 100 });
  return { trace, store, request, body };
}
test("durable reader has no opt-in/clear, preserves escaped exact pages, separate outcomes and frozen/current settings", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const { store, body } = await fixture();
    const commands: ModelRequestDebugCommand[] = [];
    connect(async (input) => {
      commands.push(input);
      return store.control(input);
    });
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          threadId: "synthetic-thread",
          currentSettings: { model: "current-model" },
        }),
      ),
    );
    await settle();
    assert.match(document.body.textContent!, /Always on · read only/u);
    assert.equal(document.querySelector('[role="switch"]'), null);
    assert(!document.body.textContent!.includes("Clear"));
    await click("frozen-model");
    assert.equal(
      document.querySelector(".trace-inspector-payload")!.textContent,
      body.slice(0, 100),
    );
    assert.equal(document.querySelector(".trace-inspector-payload img"), null);
    assert.match(document.body.textContent!, /Sample outcome: completed/u);
    assert.match(document.body.textContent!, /Raw response capture: unknown/u);
    await click("Next page");
    assert.equal(
      document.querySelector(".trace-inspector-payload")!.textContent,
      body.slice(100, 200),
    );
    await click("Previous page");
    assert.equal(
      document.querySelector(".trace-inspector-payload")!.textContent,
      body.slice(0, 100),
    );
    await click("Frozen settings");
    assert.match(
      document.querySelector(".trace-inspector-payload")!.textContent!,
      /frozenSample/u,
    );
    assert.match(document.body.textContent!, /current-model/u);
    await click("Messages & instructions");
    assert.match(
      document.querySelector(".trace-inspector-payload")!.textContent!,
      /trusted-system/u,
    );
    assert(commands.every((x) => ["list", "read"].includes(x.action)));
  }));
test("close/reopen rereads existing evidence and narrow Back returns keyboard focus", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const { store } = await fixture();
    connect((input) => store.control(input));
    const render = () =>
      createElement(ModelRequestDebugPanel, { threadId: "synthetic-thread" });
    await act(async () => root.render(render()));
    await settle();
    const source = button("frozen-model");
    source.focus();
    await click("frozen-model");
    assert.equal(document.activeElement?.tagName, "H3");
    await click("Back to records");
    assert.equal(document.activeElement, source);
    await act(async () => root.render(null));
    await act(async () => root.render(render()));
    await settle();
    assert.match(document.body.textContent!, /frozen-model/u);
  }));
test("thread switch ignores an old read, new requests remain selectable, stale overlap cannot replace new detail", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const a = await fixture("thread-a"),
      b = await fixture("thread-b");
    let release: ((r: ModelRequestDebugResult) => void) | undefined;
    const oldPage = await a.store.control({
      action: "read",
      threadId: "thread-a",
      id: a.request.recordId!,
    });
    connect((input) =>
      input.action === "read" && input.threadId === "thread-a"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : b.store.control(input),
    );
    // Use the real per-thread records, with a pending old response on the first thread.
    connect((input) =>
      input.action === "read" && input.threadId === "thread-a"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : (input.action !== "status" && input.threadId === "thread-a"
            ? a.store
            : b.store
          ).control(input),
    );
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, { threadId: "thread-a" }),
      ),
    );
    await settle();
    await click("frozen-model");
    assert(release);
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, { threadId: "thread-b" }),
      ),
    );
    await settle();
    await click("frozen-model");
    await act(async () => release!(oldPage));
    assert.match(
      document.querySelector(".trace-inspector-detail")!.textContent!,
      /thread-b/u,
    );
    assert(
      !document
        .querySelector(".trace-inspector-detail")!
        .textContent!.includes("thread-a"),
    );
    await b.trace.record({
      threadId: "thread-b",
      sampleId: "sample-new",
      type: "model_request",
      data: { model: "new-request", transportAttempt: 1 },
      artifacts: [{ name: "request_body", bytes: '{"model":"new-request"}' }],
    });
    await click("Refresh index");
    await click("new-request");
    assert.match(
      document.querySelector(".trace-inspector-payload")!.textContent!,
      /new-request/u,
    );
  }));
test("empty, read error, retry, cancelled sample and prepared blocked records remain honest", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const { store, trace } = await fixture();
    let fail = true;
    connect((input) => {
      if (input.action === "read" && fail)
        return Promise.reject(new Error("artifact is unavailable"));
      return store.control(input);
    });
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, { threadId: "absent" }),
      ),
    );
    await settle();
    assert.match(document.body.textContent!, /No recorded evidence/u);
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, { threadId: "synthetic-thread" }),
      ),
    );
    await settle();
    await click("frozen-model");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /artifact is unavailable/u,
    );
    await click("Back to records");
    fail = false;
    await trace.record({
      threadId: "synthetic-thread",
      sampleId: "sample",
      type: "model_sample_finished",
      data: { outcome: "cancelled" },
    });
    await trace.record({
      threadId: "synthetic-thread",
      sampleId: "sample",
      type: "model_dispatch_blocked",
      data: { transportAttempt: 1, preparedRequestCaptured: true },
    });
    await click("Refresh index");
    await click("frozen-model");
    assert.match(document.body.textContent!, /Sample outcome: cancelled/u);
    assert.match(
      document.body.textContent!,
      /These bytes were not sent by this attempt/u,
    );
  }));
test("all-local title scope and original tool artifacts are explicit", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const { store, trace } = await fixture();
    await trace.record({
      threadId: "aux-title",
      sampleId: "title-sample",
      type: "model_sample_started",
      data: { purpose: "title", model: "title-model" },
    });
    await trace.record({
      threadId: "aux-title",
      sampleId: "title-sample",
      type: "model_input",
      artifacts: [{ name: "model_input", bytes: "title-input" }],
    });
    await trace.record({
      threadId: "synthetic-thread",
      type: "tool_output",
      artifacts: [{ name: "tool_output", bytes: "exact-tool-output" }],
    });
    connect((input) => store.control(input));
    await act(async () =>
      root.render(createElement(ModelRequestDebugPanel, {})),
    );
    await settle();
    assert.match(
      document.body.textContent!,
      /All local · includes title\/probe/u,
    );
    await click("title-model");
    assert.match(
      document.querySelector(".trace-inspector-payload")!.textContent!,
      /Unavailabl/u,
    );
    await click("Original artifact");
    assert.equal(
      document.querySelector(".trace-inspector-payload")!.textContent,
      "title-input",
    );
    await act(async () => {
      const select = document.querySelector(
        'select[aria-label="Evidence"]',
      ) as HTMLSelectElement;
      select.value = "events";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await settle();
    await click("tool_output");
    await click("Original artifact");
    assert.equal(
      document.querySelector(".trace-inspector-payload")!.textContent,
      "exact-tool-output",
    );
  }));

test("changing artifact identity never labels old bytes as the newly selected artifact while reading", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const { trace, store } = await fixture();
    await trace.record({
      threadId: "synthetic-thread",
      type: "tool_result",
      data: { model: "two-artifact-record" },
      artifacts: [
        { name: "first", bytes: "first artifact original" },
        { name: "second", bytes: "second artifact original" },
      ],
    });
    let release: (() => void) | undefined;
    connect(async (input) => {
      if (input.action === "read" && input.artifactIndex === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return store.control(input);
    });
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, { threadId: "synthetic-thread" }),
      ),
    );
    await settle();
    const evidence = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Evidence"]',
    )!;
    await act(async () => {
      evidence.value = "events";
      evidence.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await settle();
    await click("two-artifact-record");
    await click("Original artifact");
    assert.equal(
      document.querySelector(".trace-inspector-payload")!.textContent,
      "first artifact original",
    );
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Artifact"]',
    )!;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert(release);
    assert.equal(document.querySelector(".trace-inspector-payload"), null);
    assert.match(
      document.querySelector(".trace-inspector-detail")!.textContent!,
      /Reading/u,
    );
    await act(async () => release!());
    await settle();
    assert.equal(
      document.querySelector(".trace-inspector-payload")!.textContent,
      "second artifact original",
    );
    assert.equal(
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="Artifact"]',
      )!.value,
      "1",
    );
  }));
