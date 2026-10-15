import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Sidebar } from "../src/renderer/src/Sidebar.js";
const noop = () => undefined;
const summary = (id: string) => ({
  threadId: id,
  name: `${id} · A complete and deliberately very long thread title`,
  archived: false,
  status: id === "a" ? "active" : "idle",
  createdAt: new Date(1000).toISOString(),
  updatedAt: new Date(9000).toISOString(),
  preview: "",
  currentMetadata: {
    model: "fake",
    provider: "fake",
    cwd: "/work/zen",
    sandbox: "workspace-write",
    approvalPolicy: "never",
  },
});

test("details retain focus, title directly renames, and late save cannot close a newer editor", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, {
    zenx: {
      plugins: {
        executeCommand: async () => ({
          triggers: [
            {
              id: "timer",
              threadId: "a",
              kind: "timer",
              active: true,
              timer: { nextRunAt: Date.now() + 100000 },
            },
          ],
        }),
      },
    },
  });
  // Chromium cannot focus a portal input while its first layout is visibility:hidden.
  const nativeFocus = dom.window.HTMLElement.prototype.focus;
  dom.window.HTMLElement.prototype.focus = function (options) {
    if (this.closest('[style*="visibility: hidden"]')) return;
    if (
      this.classList.contains("thread-menu-trigger") &&
      this.closest(".thread-row-shell")?.getAttribute("data-menu-open") !==
        "true" &&
      document.activeElement !==
        this.closest(".thread-row-shell")?.querySelector(".thread-row")
    )
      return;
    nativeFocus.call(this, options);
  };
  const root = createRoot(document.getElementById("root")!);
  const calls: Array<[string, string]> = [];
  const selections: string[] = [];
  let resolve: (() => void) | undefined;
  const props: any = {
    mode: "projects",
    open: true,
    onClose: noop,
    onChangeThreadLifecycle: async () => {},
    onChangeThreadPinned: async () => {},
    onNewThread: noop,
    onAddProject: noop,
    onRemoveProject: noop,
    onSetDefaultProject: noop,
    onOpenContribution: noop,
    onOpenSettings: noop,
    triggerAdmissionId: "test-trigger-admission",
    onRetryThreads: noop,
    onRenameThread: async (id: string, name: string) => {
      calls.push([id, name]);
      if (name === "error") throw new Error("Save failed");
      await new Promise<void>((r) => {
        resolve = r;
      });
    },
    onSelectThread: (id: string) => selections.push(id),
    pendingApprovalThreadIds: new Set(),
    pluginContributions: [
      {
        pluginId: "zenx-triggers",
        id: "triggers",
        key: "triggers",
        title: "Triggers",
        icon: "clock",
        page: {
          id: "triggers",
          route: "/plugins/zenx-triggers/triggers",
          pluginId: "zenx-triggers",
          title: "Triggers",
        },
      },
    ],
    selectedPage: "agent",
    selectedThreadId: "a",
    serverStatus: { type: "ready" },
    liveThread: null,
    threadError: null,
    threadLoading: false,
    projects: {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          name: "Zen",
          configured: true,
          isDefault: true,
          threadIds: ["a", "b"],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    },
    pinnedThreads: [],
    threads: [summary("a"), summary("b")],
    unreadThreadIds: new Set(["b"]),
  };
  const change = async (input: HTMLInputElement, value: string) => {
    const key = Object.keys(input).find((k) => k.startsWith("__reactProps"))!;
    await act(async () => {
      (input as any)[key].onChange({ target: { value } });
    });
  };
  const event = (key: string, extra = {}) =>
    new dom.window.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
  try {
    await act(async () => root.render(React.createElement(Sidebar, props)));
    const row = document.querySelector<HTMLButtonElement>(
      '[data-thread-id="a"] > .thread-row',
    )!;
    await act(async () => {
      row.dispatchEvent(
        new dom.window.MouseEvent("pointerover", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 380));
    });
    let hoverPane = document.querySelector<HTMLElement>(".thread-information");
    assert.ok(hoverPane, "hover opens details after the deliberate delay");
    assert.equal(document.activeElement, document.body, "hover does not focus");
    await act(async () => {
      row.dispatchEvent(
        new dom.window.MouseEvent("pointerout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      hoverPane!.dispatchEvent(
        new dom.window.MouseEvent("pointerover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    assert.ok(
      document.querySelector(".thread-information"),
      "pointer bridge keeps clickable details open",
    );
    await act(async () => {
      hoverPane!.dispatchEvent(
        new dom.window.MouseEvent("pointerout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    assert.equal(
      document.querySelector(".thread-information"),
      null,
      "leaving both surfaces dismisses details",
    );
    await act(async () => row.focus());
    assert.equal(
      document.activeElement,
      row,
      "opening information does not steal focus",
    );
    const details = document.querySelector<HTMLElement>(".thread-information")!;
    assert.ok(details);
    assert.equal(details.getAttribute("aria-modal"), null);
    await act(async () =>
      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "2",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      selections.at(-1),
      "b",
      "a hover details panel does not block global thread shortcuts",
    );
    assert.match(
      details.textContent!,
      /A complete and deliberately very long thread title/,
    );
    assert.match(
      details.textContent!,
      /Unavailable/,
      "updatedAt must not impersonate message time",
    );
    const status = document.querySelector(
      '[data-thread-id="a"] .thread-status-rail',
    )!;
    assert.ok(status.querySelector('[aria-label="1 trigger"]'));
    assert.ok(status.querySelector('[aria-label="Running"]'));
    assert.equal(
      document.querySelector('[data-thread-id="a"] .thread-state-inline'),
      null,
      "running status is not duplicated beside the model",
    );
    assert.deepEqual(
      Array.from(status.querySelectorAll("svg")).map((icon) => [
        icon.getAttribute("width"),
        icon.getAttribute("height"),
      ]),
      [
        ["16", "16"],
        ["16", "16"],
        ["16", "16"],
      ],
      "clock, progress and overflow use the same icon canvas",
    );
    assert.equal(status.querySelectorAll(".thread-status-slot").length, 2);
    assert.ok(
      status.querySelector(".thread-running-spinner circle[stroke-dasharray]"),
    );

    assert.equal(status.querySelector(".live-dot"), null);
    assert.ok(
      document.querySelector(
        '[data-thread-id="b"] [aria-label="Unread agent reply"]',
      ),
    );
    await act(async () =>
      details
        .querySelector<HTMLButtonElement>(".thread-information-title")!
        .click(),
    );
    assert.equal(
      document.querySelector(".thread-information"),
      details,
      "hover title edits inside the original information panel",
    );
    assert.equal(document.querySelector(".thread-item-menu"), null);
    assert.ok(details.querySelector(".thread-information-facts"));
    let input = document.querySelector<HTMLInputElement>(
      ".thread-menu-rename input",
    )!;
    assert.ok(input);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(
      document.activeElement === input,
      true,
      "renaming waits for a visible positioned portal then focuses its input",
    );
    await change(input, "first saved name");
    const ime = event("Enter", { isComposing: true });
    await act(async () => input.dispatchEvent(ime));
    assert.equal(ime.defaultPrevented, true);
    assert.equal(calls.length, 0);
    await act(async () => {
      input.form!.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
      input.form!.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(calls, [["a", "first saved name"]]);
    assert.match(
      document.querySelector(".thread-menu-rename")!.textContent!,
      /Saving/,
    );
    const nextRow = document.querySelector<HTMLButtonElement>(
      '[data-thread-id="b"] > .thread-row',
    )!;
    await act(async () => {
      nextRow.focus();
      root.render(
        React.createElement(Sidebar, { ...props, selectedThreadId: "b" }),
      );
    });
    assert.equal(
      document.querySelector(".thread-menu-rename"),
      null,
      "new selection retires the old editor even without an outside pointer event",
    );
    assert.equal(document.activeElement, nextRow);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-thread-id="b"] .thread-menu-trigger',
        )!
        .click(),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".thread-menu-information .thread-information-title",
        )!
        .click(),
    );
    input = document.querySelector<HTMLInputElement>(
      ".thread-menu-rename input",
    )!;
    await change(input, "new draft");
    await act(async () => resolve!());
    assert.equal(
      document.querySelector<HTMLInputElement>(".thread-menu-rename input")
        ?.value,
      "new draft",
    );
    assert.equal(
      document.activeElement,
      input,
      "late receipt does not move focus",
    );
    await change(input, "error");
    await act(async () =>
      input.form!.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Save failed/,
    );
    assert.equal(input.value, "error");
    await act(async () => input.dispatchEvent(event("Escape")));
    assert.equal(document.querySelector(".thread-menu-rename"), null);
    assert.equal(
      document.activeElement,
      document.querySelector(
        ".thread-menu-information .thread-information-title",
      ),
    );
    assert.ok(
      document.querySelector(".thread-item-menu"),
      "cancel keeps the same panel open",
    );
    await act(async () =>
      document.activeElement!.dispatchEvent(event("Escape")),
    );
    assert.equal(
      document.activeElement,
      document.querySelector('[data-thread-id="b"] .thread-menu-trigger'),
    );
    await act(async () => row.focus());
    const pane = document.querySelector<HTMLElement>(".thread-information")!;
    await act(async () =>
      pane.querySelector<HTMLButtonElement>("button")!.focus(),
    );
    await act(async () => pane.dispatchEvent(event("Escape")));
    assert.equal(
      document.querySelector(".thread-information"),
      null,
      "Escape stays dismissed after restoring row focus",
    );
    assert.equal(document.activeElement, row);
    const openNameEditor = async () => {
      if (!document.querySelector(".thread-item-menu"))
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              '[data-thread-id="b"] .thread-menu-trigger',
            )!
            .click(),
        );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            ".thread-menu-information .thread-information-title",
          )!
          .click(),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      return document.querySelector<HTMLInputElement>(
        ".thread-menu-rename input",
      )!;
    };
    input = await openNameEditor();
    await change(input, "successful save");
    await act(async () =>
      input.form!.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await act(async () => resolve!());
    assert.equal(
      document.activeElement,
      document.querySelector(
        ".thread-menu-information .thread-information-title",
      ),
      "successful Enter restores owned focus to the title in the same panel",
    );
    input = await openNameEditor();
    await change(input, "save while moving elsewhere");
    await act(async () =>
      input.form!.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    const elsewhere =
      document.querySelector<HTMLButtonElement>(".settings-nav-row")!;
    await act(async () => elsewhere.focus());
    await act(async () => resolve!());
    assert.equal(
      document.activeElement === elsewhere,
      true,
      "late success cannot reclaim focus the user has moved elsewhere",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
