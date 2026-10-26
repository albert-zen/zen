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

test("compact inspector preserves list state and focus when returning from a narrow detail", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const store = new ModelRequestDebugStore();
    store.control({ action: "setEnabled", enabled: true });
    await capture(store);
    const commands: ModelRequestDebugCommand[] = [];
    connect(async (input) => {
      commands.push(input);
      return store.control(input);
    });
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          threadId: "synthetic-thread",
        }),
      ),
    );
    await settle();
    assert.equal(
      document.querySelector("h2"),
      null,
      "embedded inspector has no repeated title",
    );
    const list = document.querySelector<HTMLElement>(".model-debug-list")!;
    list.scrollTop = 120;
    const selected = button("synthetic-model");
    await click("synthetic-model");
    assert.equal(
      document.querySelector(".model-debug-body")?.getAttribute("data-detail"),
      "true",
    );
    assert.equal(
      document.activeElement,
      document.querySelector(".model-debug-detail-heading"),
    );
    await click("Back to requests");
    assert.equal(
      document.querySelector(".model-debug-body")?.getAttribute("data-detail"),
      "false",
    );
    assert.equal(list.scrollTop, 120);
    assert.equal(document.activeElement, selected);
    assert.equal(selected.getAttribute("aria-current"), "true");
    assert.equal(
      commands.some((command) => command.action === "setEnabled"),
      false,
    );
  }));

test("inspector responds to its own container and keeps search, selection and scroll on Back", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    let resize: ResizeObserverCallback | undefined;
    const originalObserver = globalThis.ResizeObserver;
    Object.assign(globalThis, {
      ResizeObserver: class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    });
    try {
      const store = new ModelRequestDebugStore();
      store.control({ action: "setEnabled", enabled: true });
      await capture(store);
      connect(async (input) => store.control(input));
      await act(async () =>
        root.render(
          createElement(ModelRequestDebugPanel, {
            threadId: "synthetic-thread",
          }),
        ),
      );
      await settle();
      const input = document.querySelector<HTMLInputElement>(
        ".model-debug-search input",
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, "synthetic");
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        input.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 220));
      });
      await act(async () =>
        resize!(
          [{ contentRect: { width: 1000 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
      const sidebar = document.querySelector<HTMLElement>(
        ".model-debug-sidebar",
      )!;
      const detail = document.querySelector<HTMLElement>(
        ".model-debug-detail",
      )!;
      assert.equal(sidebar.hidden, false);
      await click("synthetic-model");
      assert.equal(sidebar.hidden, false, "wide container shows both panes");
      await act(async () =>
        resize!(
          [{ contentRect: { width: 600 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
      assert.equal(
        sidebar.hidden,
        true,
        "narrow container hides the list without unmounting it",
      );
      assert.equal(detail.hidden, false);
      const list = document.querySelector<HTMLElement>(".model-debug-list")!;
      list.scrollTop = 70;
      await click("Back to requests");
      assert.equal(sidebar.hidden, false);
      assert.equal(detail.hidden, true);
      assert.equal(document.querySelector(".model-debug-search input"), input);
      assert.equal(input.value, "synthetic");
      assert.equal(list.scrollTop, 70);
      assert.equal(document.activeElement, button("synthetic-model"));
    } finally {
      Object.assign(globalThis, { ResizeObserver: originalObserver });
    }
  }));

test("Back during a pending section read stays in the list and does not change capture", async () =>
  withDom(async (root) => {
    const store = new ModelRequestDebugStore();
    store.control({ action: "setEnabled", enabled: true });
    await capture(store);
    const pending = deferredResult();
    let delayed: ModelRequestDebugResult | undefined;
    connect(async (input) => {
      if (input.action === "read" && input.view === "tools") {
        delayed = store.control(input);
        return pending.promise;
      }
      return store.control(input);
    });
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, { threadId: "synthetic-thread" }),
      ),
    );
    await settle();
    await click("synthetic-model");
    await click("Tools");
    await click("Back to requests");
    await act(async () => pending.resolve(delayed!));
    assert.equal(
      document.querySelector(".model-debug-body")?.getAttribute("data-detail"),
      "false",
    );
    assert.equal(store.control({ action: "status" }).enabled, true);
  }));

test("critical consent stays visible before enabling and simultaneous integrity flags remain discoverable", async () =>
  withDom(async (root) => {
    await i18n.changeLanguage("en");
    const store = new ModelRequestDebugStore();
    connect(async (input) => {
      const result = store.control(input);
      if (result.page)
        Object.assign(result.page.record, {
          truncated: true,
          redacted: true,
          format: "model-input",
        });
      return result;
    });
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, { threadId: "synthetic-thread" }),
      ),
    );
    await settle();
    const consent = document.querySelector(".model-debug-consent")!;
    assert.match(
      consent.textContent!,
      /Device-wide.*private content.*Memory only.*Closing keeps capture on; disabling clears it/,
    );
    assert.equal(
      button("Enable capture").getAttribute("aria-describedby"),
      consent.id,
    );
    await click("Enable capture");
    await capture(store);
    await click("Refresh");
    await click("synthetic-model");
    const summary = document.querySelector(
      ".model-debug-record-info > summary",
    )!;
    assert.match(summary.textContent!, /Model input only/);
    assert.match(summary.textContent!, /Truncated/);
    assert.match(summary.textContent!, /Redacted/);
    assert.equal(button("Messages / input").disabled, true);
    const metadata = document.querySelector<HTMLDetailsElement>(
      ".model-debug-record-info",
    )!;
    assert.equal(metadata.open, false);
    metadata.open = true;
    assert.match(metadata.textContent!, /not a captured provider request/);
    assert.match(metadata.textContent!, /omitted content is unavailable/);
    assert.match(metadata.textContent!, /not byte-identical/);
  }));

test("sample-linked viewer never substitutes another sample from the same Thread", async () =>
  withDom(async (root) => {
    const store = new ModelRequestDebugStore();
    store.control({ action: "setEnabled", enabled: true });
    await capture(store);
    const commands: ModelRequestDebugCommand[] = [];
    Object.assign(window, {
      zenx: {
        modelRequestDebug: {
          request: async (command: ModelRequestDebugCommand) => {
            commands.push(command);
            return store.control(command);
          },
        },
      },
    });
    await i18n.changeLanguage("en");
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          threadId: "synthetic-thread",
          sampleId: "missing-sample",
        }),
      ),
    );
    await settle();
    assert.equal(document.querySelectorAll(".model-debug-request").length, 0);
    assert.doesNotMatch(
      document.querySelector(".model-debug-list")?.textContent ?? "",
      /synthetic-model/,
    );
    await act(async () =>
      root.render(
        createElement(ModelRequestDebugPanel, {
          key: "present",
          threadId: "synthetic-thread",
          sampleId: "synthetic-sample",
        }),
      ),
    );
    await settle();
    assert.match(document.body.textContent!, /synthetic-model/);
    assert.equal(
      commands.some((command) => command.action === "setEnabled"),
      false,
    );
  }));
