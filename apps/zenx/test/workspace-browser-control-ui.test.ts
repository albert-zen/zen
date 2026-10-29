import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
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
    mounts: Record<string, unknown>[];
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
  const mounts: Record<string, unknown>[] = [];
  const pending: ReturnType<typeof deferred>[] = [];
  Object.defineProperty(dom.window, "zenx", {
    value: {
      workspaceBrowser: {
        onFocusAddress: () => () => {},
        mount: async (request: Record<string, unknown>) => {
          mounts.push(request);
        },
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
      mounts,
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

test("permission switch locks repeat requests, preserves human navigation and shows dispatched actions", async () => {
  await withPanel(async ({ render, button, calls, pending }) => {
    await render({ agentActionsInFlight: 2 });
    assert.match(
      document.body.textContent!,
      /2.*already dispatched.*may still finish/s,
    );
    await act(async () => {
      button("Allow Agent to operate this tab").click();
      button("Allow Agent to operate this tab").click();
    });
    assert.deepEqual(calls, [["thread-a", "take-control", "tab-a", undefined]]);
    assert.equal(button("Allow Agent to operate this tab").disabled, true);
    assert.equal(button("Reload page").disabled, false);
    await act(async () => button("Reload page").click());
    assert.equal(calls.length, 2);
    await act(async () => pending[0]!.resolve());
    await render({ control: "human", agentActionsInFlight: 1 });
    assert.match(document.body.textContent!, /Not allowed/);
    await act(async () => button("Allow Agent to operate this tab").click());
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
    await act(async () => button("Allow Agent to operate this tab").click());
    await act(async () => pending[0]!.reject(new Error("Takeover failed")));
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Takeover failed/,
    );
    await act(async () => button("Reload page").click());
    assert.match(document.body.textContent!, /Takeover failed/);
    await act(async () => button("Allow Agent to operate this tab").click());
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
      await act(async () => button("Allow Agent to operate this tab").click());
      const old = pending.at(-1)!;
      await next();
      await act(async () => old.reject(new Error("stale error")));
      assert.doesNotMatch(document.body.textContent!, /stale error/);
    }
    await render();
    assert.equal(button("Allow Agent to operate this tab").disabled, false);
    await act(async () => button("Allow Agent to operate this tab").click());
    await unmount();
    await act(async () => pending.at(-1)!.reject(new Error("unmounted error")));
    assert.equal(document.body.textContent, "");
  });
});

test("permission switch and rules localize in Chinese", async () => {
  await withPanel(async ({ render, button }) => {
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    assert.ok(button("允许 Agent 操作此标签页"));
    await render({ control: "human", agentActionsInFlight: 2 });
    assert.ok(button("允许 Agent 操作此标签页"));
    assert.match(document.body.textContent!, /未允许/);
    assert.match(document.body.textContent!, /2.*已发出/);
  });
});

test("displayed failure is scoped to its tab and control has accessible context", async () => {
  await withPanel(async ({ render, button, pending }) => {
    const control = button("Allow Agent to operate this tab");
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
    assert.equal(button("Allow Agent to operate this tab").disabled, true);
  });
});

test("one stable permission switch ends the address bar without a status row or continuation action", async () => {
  await withPanel(async ({ render, button }) => {
    const label = "Allow Agent to operate this tab";
    const control = button(label);
    assert.equal(control.getAttribute("role"), "switch");
    assert.equal(control.getAttribute("aria-checked"), "true");
    assert.equal(control.textContent, "");
    assert.equal(document.querySelector(".workspace-browser-control"), null);
    assert.equal(
      document
        .querySelector(".workspace-browser-address")!
        .querySelector(":scope > button:last-of-type"),
      control,
    );
    assert.match(control.title, /does not mean it is currently running/);
    assert.match(control.title, /always browse and sign in manually/);
    assert.match(
      control.title,
      /does not start a task, continue a conversation, or replay/,
    );
    await render({ control: "human" });
    assert.equal(button(label).getAttribute("aria-checked"), "false");
    assert.match(button(label).title, /Not allowed/);
    assert.equal(button(label).getAttribute("aria-label"), label);
    assert.equal(
      document.getElementById(control.getAttribute("aria-describedby")!)!
        .textContent,
      button(label).title,
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /Done, continue|You control|Agent control enabled/,
    );
  });
});

test("native smoke layout probe resolves the current permission UI in every state", async () => {
  // Execute the exact browser-side probe from the native smoke against real
  // production markup. JSDOM verifies its selectors and accessibility contract;
  // the hosted Chromium smoke remains authoritative for physical geometry.
  const smoke = readFileSync(
    new URL("../src/main/workspace-browser-smoke.ts", import.meta.url),
    "utf8",
  );
  const probe = smoke.match(
    /const measured = await layout\.webContents\s*\.executeJavaScript\(`([\s\S]*?)`\);/,
  )?.[1];
  assert.ok(probe, "Native layout smoke must expose its browser-side probe");
  const dom = new JSDOM('<main id="fixture"></main>', {
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  try {
    for (const language of ["en", "zh-CN"]) {
      await i18n.changeLanguage(language);
      for (const state of [
        {},
        { control: "human", requiresFreshObservation: true },
        { requiresFreshObservation: true },
        { agentActionsInFlight: 1, requiresFreshObservation: true },
        { agentActionOutcomeUnknown: true, requiresFreshObservation: true },
        {},
      ]) {
        const current = tab(state);
        const markup = renderToStaticMarkup(
          React.createElement(WorkspaceBrowserPanel, {
            threadId: current.threadId,
            tab: current,
            open: true,
          }),
        );
        const measured = (await dom.window.eval(
          probe.replace("${JSON.stringify(markup)}", JSON.stringify(markup)),
        )) as Record<string, unknown>;
        assert.equal(
          measured.permissionChecked,
          String(current.control === "agent"),
        );
        assert.equal(
          measured.permissionLabel,
          i18n.t("panels:browserAgentPermission"),
        );
        assert.equal(measured.permissionInToolbar, true);
        assert.equal(measured.permissionFocusable, true);
        assert.equal(measured.permissionDetailsAccessible, true);
        assert.equal(measured.legacyControlCount, 0);
      }
    }
  } finally {
    await i18n.changeLanguage("en");
    dom.window.close();
  }
});

test("unknown outcome keeps a reserved toolbar status slot when cleared", async () => {
  await withPanel(async ({ render }) => {
    await render({ agentActionOutcomeUnknown: true });
    const status = document.querySelector(".browser-outcome-status")!;
    assert.equal(status.parentElement?.className, "workspace-browser-address");
    assert.equal(status.getAttribute("data-unknown"), "true");
    assert.equal(
      status.textContent,
      i18n.t("panels:browserActionOutcomeUnknown"),
    );
    assert.equal(document.querySelector("p[role=status]"), null);
    await render({ agentActionOutcomeUnknown: false });
    assert.equal(document.querySelector(".browser-outcome-status"), status);
    assert.equal(status.getAttribute("data-unknown"), "false");
    assert.equal(status.textContent, "");
  });
});

test("tab glyph owns Agent activity; page chrome retains only actual human-control feedback", async () => {
  await withPanel(async ({ render }) => {
    for (const activity of [
      { agentInspectionsInFlight: 1 },
      { agentActionsInFlight: 1 },
      { agentActionsInFlight: 0, agentInspectionsInFlight: 0 },
    ]) {
      await render({ ...activity, control: "agent" });
      assert.ok(
        document.querySelector(".workspace-browser-activity") === null,
        "Agent activity has no duplicate text row",
      );
      assert.ok(
        document.querySelector(".workspace-browser-control-status") === null,
        "Human-control feedback is absent when the Agent is allowed",
      );
      assert.equal(
        document
          .querySelector(".workspace-browser-panel")
          ?.hasAttribute("data-agent-active"),
        false,
      );
    }
    await render({ agentActionsInFlight: 1, control: "human" });
    assert.match(
      document.querySelector(".workspace-browser-control-status")
        ?.textContent ?? "",
      /action.*finishing/u,
    );
    assert.match(
      document.querySelector('[role="switch"]')?.getAttribute("title") ?? "",
      /already dispatched/u,
    );
    await render({ agentActionsInFlight: 0, control: "human" });
    assert.match(
      document.querySelector(".workspace-browser-control-status")
        ?.textContent ?? "",
      /You have control/u,
    );
  });
});

test("blank viewport distinguishes websites, loading and errors; theme updates retain native lease", async () => {
  await withPanel(async ({ render, mounts }) => {
    const viewport = () =>
      document.querySelector(".workspace-browser-viewport")!;
    await render({ url: "about:blank", loading: false });
    assert.equal(viewport().getAttribute("data-blank"), "true");
    const lease = mounts.at(-1)!.lease;
    await act(async () => {
      document.documentElement.dataset.appearance = "dark";
    });
    assert.equal(mounts.at(-1)!.appearance, "dark");
    assert.equal(mounts.at(-1)!.lease, lease);
    await act(async () => {
      document.documentElement.dataset.appearance = "light";
    });
    assert.equal(mounts.at(-1)!.appearance, "light");
    assert.equal(mounts.at(-1)!.lease, lease);
    for (const changes of [
      { url: "about:blank", loading: true },
      { url: "about:blank", error: "Navigation failed" },
      { url: "https://example.test/", loading: false },
    ]) {
      await render(changes);
      assert.equal(viewport().hasAttribute("data-blank"), false);
    }
  });
});

test("human-mounted page retains one native lease through appearance and activity updates", async () => {
  await withPanel(async ({ render, mounts }) => {
    const viewport = document.querySelector(".workspace-browser-viewport")!;
    viewport.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 640, height: 480 }) as DOMRect;
    await render({ url: "about:blank" });
    await act(async () => window.dispatchEvent(new window.Event("resize")));
    const mounted = mounts.at(-1)!;
    assert.ok(mounted.bounds);
    await act(async () => {
      document.documentElement.dataset.appearance = "dark";
    });
    const themed = mounts.at(-1)!;
    assert.equal(themed.lease, mounted.lease);
    assert.equal(themed.appearance, "dark");
    assert.deepEqual(themed.bounds, mounted.bounds);
    const count = mounts.length;
    await render({ url: "about:blank", agentInspectionsInFlight: 1 });
    assert.equal(
      mounts.length,
      count,
      "Agent activity cannot request or acknowledge presentation",
    );
    assert.equal(mounts.at(-1)!.lease, mounted.lease);
    assert.ok(mounts.every((request) => !("presentationId" in request)));
  });
});
