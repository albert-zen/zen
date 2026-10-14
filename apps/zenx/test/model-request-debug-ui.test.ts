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
import { observeRequestBody } from "../../../src/model/request-observation.js";
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
async function capture(
  store: ModelRequestDebugStore,
  threadId = "synthetic-thread",
) {
  const body = JSON.stringify({
    model: "synthetic-model",
    instructions: "synthetic system instructions",
    messages: [{ role: "user", content: "synthetic prompt🙂".repeat(20) }],
    tools: [{ type: "function", function: { name: "synthetic_tool" } }],
  });
  const adapter = store.observe({
    provider: "synthetic",
    requestPayloadFormat: "chat-completions",
    async *stream(request) {
      observeRequestBody(request, body, "chat-completions", "synthetic", 1);
      yield { type: "text_delta" as const, delta: "ok" };
    },
  });
  for await (const _event of adapter.stream({
    model: "synthetic-model",
    messages: [],
    tools: [],
    reasoningEffort: null,
    signal: new AbortController().signal,
    debugContext: {
      threadId,
      purpose: "turn",
      turnId: "synthetic-turn",
      sampleId: "synthetic-sample",
      sampleAttempt: 1,
      contextBoundaryItemId: "synthetic-boundary",
    },
  })) {
    /* consume */
  }
  return body;
}
function connect(
  request: (
    input: ModelRequestDebugCommand,
  ) => Promise<ModelRequestDebugResult>,
) {
  Object.assign(window, { zenx: { modelRequestDebug: { request } } });
}

test("viewer requires opt-in, exposes captured sections, paging and disabling removes payload", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const store = new ModelRequestDebugStore({ pageCharacters: 100 });
    connect(async (input) => store.control(input));
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          threadId: "synthetic-thread",
          onClose() {},
        }),
      ),
    );
    await settle();
    assert.match(
      document.body.textContent!,
      /Earlier requests cannot be reconstructed/,
    );
    assert.equal(store.control({ action: "status" }).enabled, false);
    await click("Enable capture");
    await capture(store);
    await click("Refresh");
    await click("synthetic-model");
    assert.match(
      document.querySelector(".model-debug-payload, .model-debug-tree")!
        .textContent!,
      /synthetic-model/,
    );
    assert.match(
      document.body.textContent!,
      /does not prove that the provider received/,
    );
    await click("Next page");
    assert.match(document.body.textContent!, /Characters 101/);
    await click("Previous page");
    await click("Instructions & settings");
    assert.match(
      document.querySelector(".model-debug-payload, .model-debug-tree")!
        .textContent!,
      /synthetic system instructions/,
    );
    await click("Tools");
    assert.match(
      document.querySelector(".model-debug-payload, .model-debug-tree")!
        .textContent!,
      /synthetic_tool/,
    );
    await click("Disable and clear");
    assert.equal(document.querySelector(".model-debug-payload"), null);
    assert.equal(store.control({ action: "status" }).retainedCount, 0);
    assert.match(document.body.textContent!, /Capture off/);
  }));

test("a late payload after closing and switching thread cannot appear in the new viewer", async () =>
  withDom(async (root) => {
    const store = new ModelRequestDebugStore();
    store.control({ action: "setEnabled", enabled: true });
    await capture(store);
    const pending = deferredResult();
    let delayed: ModelRequestDebugResult | undefined;
    connect(async (input) => {
      if (input.action === "read") {
        delayed = store.control(input);
        return pending.promise;
      }
      return store.control(input);
    });
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          key: "old",
          threadId: "synthetic-thread",
          onClose() {},
        }),
      ),
    );
    await settle();
    await act(async () => button("synthetic-model").click());
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          key: "new",
          threadId: "different-thread",
          onClose() {},
        }),
      ),
    );
    await settle();
    assert(delayed);
    await act(async () => {
      pending.resolve(delayed!);
      await pending.promise;
    });
    assert.equal(document.querySelector(".model-debug-payload"), null);
    assert(!document.body.textContent!.includes("synthetic prompt"));
    assert.equal(
      document.querySelector(".model-debug-scope")?.getAttribute("title"),
      "different-thread",
    );
  }));

test("unsupported adapters and oversized capture are explicitly labeled; structured tabs are disabled", async () =>
  withDom(async (root) => {
    const store = new ModelRequestDebugStore({
      maxBytes: 150,
      maxRecordBytes: 150,
    });
    store.control({ action: "setEnabled", enabled: true });
    await capture(store);
    connect(async (input) => store.control(input));
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          threadId: "synthetic-thread",
          onClose() {},
        }),
      ),
    );
    await settle();
    await click("synthetic-model");
    assert.match(document.body.textContent!, /omitted content is unavailable/);
    assert.equal(button("Messages / input").disabled, true);
    assert.equal(button("Tools").disabled, true);
    const record = store.control({
      action: "list",
      threadId: "synthetic-thread",
    }).records![0]!;
    const originalRequest = window.zenx.modelRequestDebug!.request;
    connect(async (input) => {
      const result = await originalRequest(input);
      if (result.page) result.page.record.format = "model-input";
      if (result.records)
        result.records = result.records.map((row) => ({
          ...row,
          format: "model-input",
        }));
      return result;
    });
    await click("Refresh");
    await click("synthetic-model");
    assert.match(document.body.textContent!, /not a captured provider request/);
    assert.equal(record.format, "chat-completions");
  }));

test("clearing while enabled invalidates the old selected capture and preserves capture mode", async () =>
  withDom(async (root) => {
    const store = new ModelRequestDebugStore();
    store.control({ action: "setEnabled", enabled: true });
    await capture(store);
    connect(async (input) => store.control(input));
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          threadId: "synthetic-thread",
          onClose() {},
        }),
      ),
    );
    await settle();
    await click("synthetic-model");
    await click("Clear captures");
    assert.equal(document.querySelector(".model-debug-payload"), null);
    assert.equal(store.control({ action: "status" }).enabled, true);
    assert.equal(store.control({ action: "status" }).retainedCount, 0);
  }));

function deferredResult() {
  let resolve!: (value: ModelRequestDebugResult) => void;
  const promise = new Promise<ModelRequestDebugResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("complete payload tree folds without losing raw retained text", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const store = new ModelRequestDebugStore();
    store.control({ action: "setEnabled", enabled: true });
    await capture(store);
    connect(async (input) => store.control(input));
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          threadId: "synthetic-thread",
          onClose() {},
        }),
      ),
    );
    await settle();
    await click("synthetic-model");
    assert(document.querySelector(".model-debug-tree"));
    const toggle = document.querySelector<HTMLButtonElement>(
      ".model-debug-tree-toggle",
    )!;
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector(".model-debug-tree-children"), null);
    await click("Raw JSON");
    const id = store.control({ action: "list", threadId: "synthetic-thread" })
      .records![0]!.id;
    const retained = store.control({ action: "read", id, view: "payload" })
      .page!.text;
    assert.equal(
      document.querySelector(".model-debug-payload")!.textContent,
      retained,
    );
    await click("Tree");
    assert(document.querySelector(".model-debug-tree"));
    await click("Disable and clear");
    assert.equal(
      document.querySelector(".model-debug-tree, .model-debug-payload"),
      null,
    );
  }));
