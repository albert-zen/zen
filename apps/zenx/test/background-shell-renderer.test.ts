import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { BackgroundShellStatus } from "../src/renderer/src/BackgroundShellStatus.js";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { ShellThreadPanel } from "../src/renderer/src/shell-thread-panel.js";
import { ShellTargetNavigationContext } from "../src/renderer/src/shell-target-navigation.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { ShellSessionSummary } from "../../../src/shell-session.js";

const session = (taskId: string, threadId = "source"): ShellSessionSummary => ({
  taskId,
  threadId,
  origin: "agent",
  kind: "command",
  command: `synthetic ${taskId}`,
  cwd: "/workspace/synthetic",
  createdAt: "2026-10-29T00:00:00Z",
  status: "running",
  exitCode: null,
  lifecycle: { foreground: "running", stdio: "open" },
  inputAvailable: false,
  retained: false,
});
const list = (sessions: ShellSessionSummary[]) => ({
  sessions,
  host: "local",
  cwd: "/workspace/synthetic",
  canCreate: false,
});
async function mount(request: (input: any) => Promise<any>) {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window as any).zenx = { shellPanel: { request } };
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const opened: any[] = [];
  const navigation = {
    request: null,
    consumed() {},
    async open(target: any) {
      opened.push(target);
    },
  };
  const render = async (threadId = "source") =>
    act(async () =>
      root.render(
        React.createElement(
          ShellTargetNavigationContext.Provider,
          { value: navigation },
          React.createElement(BackgroundShellStatus, { threadId }),
        ),
      ),
    );
  const click = async (selector: string) =>
    act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(selector)!.click(),
    );
  return {
    dom,
    root,
    opened,
    render,
    click,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}
test("live count is independent of ended conversation; disclosure navigates exact command and polling removes completed count", async () => {
  let sessions = [session("one"), session("two")];
  const calls: any[] = [];
  const view = await mount(async (input) => {
    calls.push(input);
    return list(sessions);
  });
  try {
    await view.render();
    assert.match(
      view.dom.window.document.body.textContent!,
      /2 background commands running/,
    );
    await view.click(".background-shell-disclosure");
    const rows = view.dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".background-shell-list button",
    );
    await act(async () => rows[1]!.click());
    assert.deepEqual(view.opened, [{ threadId: "source", taskId: "two" }]);
    sessions = sessions.map((s) => ({
      ...s,
      status: "completed",
      exitCode: 0,
    }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    assert.match(
      view.dom.window.document.body.textContent!,
      /No background commands running/,
    );
    assert.match(view.dom.window.document.body.textContent!, /Exit code: 0/);
    assert(calls.length >= 2);
    assert(calls.every((c) => c.operation === "list"));
    await view.click(".background-shell-disclosure");
    assert.equal(
      view.dom.window.document.querySelector(".background-shell-status"),
      null,
    );
  } finally {
    await view.close();
  }
});
test("read failure invalidates count and exposes original details; Refresh reads only and recovers", async () => {
  let failure = false;
  const calls: any[] = [];
  const view = await mount(async (input) => {
    calls.push(input);
    if (failure)
      throw new Error("synthetic host read unavailable <b>literal</b>");
    return list([session("one")]);
  });
  try {
    await view.render();
    failure = true;
    await view.click(".background-shell-heading > button:last-child");
    assert.doesNotMatch(
      view.dom.window.document.body.textContent!,
      /1 background command running/,
    );
    assert.match(
      view.dom.window.document.body.textContent!,
      /Background command status unavailable/,
    );
    assert.match(
      view.dom.window.document.querySelector("pre")!.textContent!,
      /<b>literal<\/b>/,
    );
    assert.equal(view.dom.window.document.querySelector("b"), null);
    assert.doesNotMatch(view.dom.window.document.body.textContent!, /Retry/);
    failure = false;
    await view.click(".background-shell-heading > button:last-child");
    assert.match(
      view.dom.window.document.body.textContent!,
      /1 background command running/,
    );
    assert(calls.every((c) => c.operation === "list"));
  } finally {
    await view.close();
  }
});
test("late source observation cannot populate fork or another current Thread", async () => {
  let resolve!: (value: unknown) => void;
  const view = await mount(async ({ threadId }) =>
    threadId === "source"
      ? await new Promise((r) => {
          resolve = r;
        })
      : list([]),
  );
  try {
    await view.render();
    await view.render("fork");
    await act(async () => resolve(list([session("source-task")])));
    assert.equal(
      view.dom.window.document.querySelector(".background-shell-status"),
      null,
    );
  } finally {
    await view.close();
  }
});
test("Terminal target opens exact session, never similarly named sibling; missing targets stay explicit", async () => {
  const calls: any[] = [];
  const target = session("exact");
  const view = await mount(async (input) => {
    calls.push(input);
    if (input.operation === "list") return list([session("sibling"), target]);
    if (input.taskId !== "exact") throw new Error("Synthetic session expired");
    return { session: target, output: "", cursor: 0, truncated: false };
  });
  const consumed: number[] = [];
  const render = async (taskId: string, requestId: number) =>
    act(async () =>
      view.root.render(
        React.createElement(ShellThreadPanel, {
          threadId: "source",
          active: true,
          targetRequest: {
            ownerKey: "thread:source",
            threadId: "source",
            taskId,
            requestId,
          },
          onTargetConsumed: (id) => consumed.push(id),
        }),
      ),
    );
  try {
    await render("exact", 1);
    assert.equal(
      view.dom.window.document.querySelector(".shell-heading-context strong")
        ?.textContent,
      "synthetic exact",
    );
    assert.deepEqual(consumed, [1]);
    assert.equal(
      view.dom.window.document.activeElement,
      view.dom.window.document.querySelector(".shell-heading-context"),
    );
    await render("missing", 2);
    assert.match(
      view.dom.window.document.querySelector(".shell-error")!.textContent!,
      /Synthetic session expired/,
    );
    assert.equal(
      view.dom.window.document.querySelector(".shell-heading-context strong"),
      null,
    );
    assert(calls.every((call) => ["list", "read"].includes(call.operation)));
  } finally {
    await view.close();
  }
});

test("non-desktop and static conversation renderers do not invent background status", async () => {
  const view = await mount(async () =>
    assert.fail("No desktop bridge is available"),
  );
  try {
    delete (view.dom.window as any).zenx;
    await view.render();
    assert.equal(
      view.dom.window.document.querySelector(".background-shell-status"),
      null,
    );
  } finally {
    await view.close();
  }
});

test("an existing sidebar opens the exact resource Thread terminal rather than its viewport owner's command", async () => {
  const calls: any[] = [];
  const target = session("resource-exact");
  const view = await mount(async (input) => {
    calls.push(input);
    if (input.threadId !== "source") throw new Error("Wrong resource owner");
    return input.operation === "list"
      ? list([target])
      : { session: target, output: "", cursor: 0, truncated: false };
  });
  try {
    await act(async () =>
      view.root.render(
        React.createElement(
          ShellTargetNavigationContext.Provider,
          {
            value: {
              request: {
                threadId: "source",
                taskId: "resource-exact",
                ownerKey: "thread:viewport",
                requestId: 1,
              },
              consumed() {},
              async open() {},
            },
          },
          React.createElement(AuxiliaryPanel, {
            threadId: "viewport",
            title: "Viewport",
            open: true,
            onOpenChange() {},
            snapshot: null,
            presentationState: {
              owner: { kind: "thread", id: "viewport" },
              revision: 1,
              open: true,
              fullscreen: false,
              tabs: [{ kind: "terminal", resourceThreadId: "source" }],
              selectedTab: "terminal:@source",
              resourceThreadId: null,
            },
            selectedTab: "terminal:@source",
            openedTabs: ["terminal:@source"],
            onSelectTab() {},
            onTabsChange() {},
          }),
        ),
      ),
    );
    assert.equal(
      view.dom.window.document.querySelector(".shell-heading-context strong")
        ?.textContent,
      "synthetic resource-exact",
    );
    assert(
      calls.some(
        (call) => call.operation === "read" && call.taskId === "resource-exact",
      ),
    );
    assert(calls.every((call) => call.threadId === "source"));
    assert.match(
      view.dom.window.document.querySelector("[role=tab]")?.textContent ?? "",
      /Terminal/,
    );
  } finally {
    await view.close();
  }
});

test("older list replies cannot regress a newer exact terminal observation", async () => {
  let resolveList!: (value: unknown) => void;
  const running = session("exact");
  const completed = {
    ...running,
    status: "completed" as const,
    exitCode: 0,
    lifecycle: {
      foreground: "exited" as const,
      stdio: "eof" as const,
      foreground_exit_code: 0,
      foreground_signal: null,
    },
  };
  const view = await mount(async (input) =>
    input.operation === "list"
      ? await new Promise((resolve) => {
          resolveList = resolve;
        })
      : { session: completed, output: "done", cursor: 4, truncated: false },
  );
  try {
    await act(async () =>
      view.root.render(
        React.createElement(ShellThreadPanel, {
          threadId: "source",
          active: true,
          targetRequest: {
            ownerKey: "thread:source",
            threadId: "source",
            taskId: "exact",
            requestId: 1,
          },
          onTargetConsumed() {},
        }),
      ),
    );
    assert.equal(
      view.dom.window.document.querySelector(".shell-status")?.textContent,
      i18n.t("panels:shellStatus_completed"),
    );
    assert.match(
      view.dom.window.document.querySelector(".shell-exit")?.textContent ?? "",
      /Exit code: 0/,
    );
    await act(async () => resolveList(list([running])));
    assert.equal(
      view.dom.window.document.querySelector(".shell-status")?.textContent,
      i18n.t("panels:shellStatus_completed"),
    );
    assert.match(
      view.dom.window.document.querySelector(".shell-exit")?.textContent ?? "",
      /Exit code: 0/,
    );
    assert.equal(view.dom.window.document.querySelector(".shell-stop"), null);
  } finally {
    await view.close();
  }
});
