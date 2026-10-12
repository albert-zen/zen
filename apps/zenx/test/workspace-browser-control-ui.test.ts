import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceBrowserPanel } from "../src/renderer/src/workspace-browser-panel.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { WorkspaceBrowserTab } from "../src/main/workspace-browser.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tab = (changes = {}): WorkspaceBrowserTab => ({
  id: "tab-a",
  threadId: "thread-a",
  title: "Page",
  url: "https://example.com/",
  loading: false,
  canGoBack: true,
  canGoForward: true,
  sharedWithAgent: true,
  control: "agent",
  agentActionOutcomeUnknown: false,
  agentActionsInFlight: 0,
  requiresFreshObservation: false,
  ...changes,
});
async function withPanel(
  run: (h: {
    render(changes?: object, threadId?: string, open?: boolean): Promise<void>;
    button(label: string): HTMLButtonElement;
    calls: unknown[][];
    pending: ReturnType<typeof deferred>[];
    unmount(): Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  const calls: unknown[][] = [];
  const pending: ReturnType<typeof deferred>[] = [];
  Object.defineProperty(dom.window, "zenx", {
    value: {
      workspaceBrowser: {
        onFocusAddress: () => () => {},
        mount: async () => {},
        command: (...args: unknown[]) => {
          calls.push(args);
          const work = deferred();
          pending.push(work);
          return work.promise;
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  let mounted = true;
  const unmount = async () => {
    if (mounted) {
      await act(async () => root.unmount());
      mounted = false;
    }
  };
  const render = async (changes = {}, threadId = "thread-a", open = true) => {
    await act(async () =>
      root.render(
        React.createElement(WorkspaceBrowserPanel, {
          threadId,
          tab: tab(changes),
          open,
        }),
      ),
    );
  };
  try {
    await i18n.changeLanguage("en");
    await render();
    await run({
      render,
      calls,
      pending,
      unmount,
      button: (label) => {
        const result = [...document.querySelectorAll("button")].find(
          (b) =>
            b.textContent === label || b.getAttribute("aria-label") === label,
        );
        assert.ok(result, `Missing button: ${label}`);
        return result;
      },
    });
  } finally {
    await unmount();
    await i18n.changeLanguage("en");
    dom.window.close();
  }
}

test("explicit takeover locks repeat requests, preserves human navigation and shows dispatched actions", async () => {
  await withPanel(async ({ render, button, calls, pending }) => {
    await render({ agentActionsInFlight: 2 });
    assert.match(
      document.body.textContent!,
      /2.*already dispatched.*may still finish/s,
    );
    await act(async () => {
      button("Take control").click();
      button("Take control").click();
    });
    assert.deepEqual(calls, [["thread-a", "take-control", "tab-a", undefined]]);
    assert.equal(button("Take control").disabled, true);
    assert.equal(button("Reload page").disabled, false);
    await act(async () => button("Reload page").click());
    assert.equal(calls.length, 2);
    await act(async () => pending[0]!.resolve());
    await render({ control: "human", agentActionsInFlight: 1 });
    assert.match(document.body.textContent!, /You control this tab/);
    await act(async () => button("Return to Agent").click());
    assert.equal(calls[2]![1], "return-control");
    await act(async () => pending[2]!.resolve());
    await render({
      control: "agent",
      requiresFreshObservation: true,
      agentActionOutcomeUnknown: true,
    });
    assert.match(
      document.body.textContent!,
      /outcome is uncertain.*Inspect the page before repeating/s,
    );
    assert.match(
      document.body.textContent!,
      /fresh inspection.*No actions are replayed/s,
    );
    await act(async () => pending[1]!.resolve());
  });
});

test("failed control request remains retryable and navigation does not erase its error", async () => {
  await withPanel(async ({ button, calls, pending }) => {
    await act(async () => button("Take control").click());
    await act(async () => pending[0]!.reject(new Error("Takeover failed")));
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Takeover failed/,
    );
    await act(async () => button("Reload page").click());
    assert.match(document.body.textContent!, /Takeover failed/);
    await act(async () => button("Take control").click());
    assert.equal(calls.length, 3);
    await act(async () => {
      pending[1]!.resolve();
      pending[2]!.resolve();
    });
  });
});

test("old errors and requests cannot leak across tab, Thread, close or unmount", async () => {
  await withPanel(async ({ render, button, pending, unmount }) => {
    for (const next of [
      () => render({ id: "tab-b" }),
      () => render({}, "thread-b"),
      () => render({}, "thread-a", false),
    ]) {
      await render();
      await act(async () => button("Take control").click());
      const old = pending.at(-1)!;
      await next();
      await act(async () => old.reject(new Error("stale error")));
      assert.doesNotMatch(document.body.textContent!, /stale error/);
    }
    await render();
    assert.equal(button("Take control").disabled, false);
    await act(async () => button("Take control").click());
    await unmount();
    await act(async () => pending.at(-1)!.reject(new Error("unmounted error")));
    assert.equal(document.body.textContent, "");
  });
});

test("control status and actions localize in Chinese", async () => {
  await withPanel(async ({ render, button }) => {
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    assert.ok(button("接管控制"));
    await render({ control: "human", agentActionsInFlight: 2 });
    assert.ok(button("交还 Agent"));
    assert.match(document.body.textContent!, /你正在控制此标签页/);
    assert.match(document.body.textContent!, /2.*已发出/);
  });
});

test("displayed failure is scoped to its tab and control has accessible context", async () => {
  await withPanel(async ({ render, button, pending }) => {
    const control = button("Take control");
    assert.ok(
      document.getElementById(control.getAttribute("aria-describedby")!),
    );
    control.focus();
    assert.equal(document.activeElement, control);
    await act(async () => control.click());
    await act(async () => pending[0]!.reject(new Error("Only tab A failed")));
    assert.match(document.body.textContent!, /Only tab A failed/);
    await render({ id: "tab-b" });
    assert.doesNotMatch(document.body.textContent!, /Only tab A failed/);
    await render({}, "thread-a", false);
    assert.equal(button("Take control").disabled, true);
  });
});
