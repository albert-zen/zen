import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type {
  NativeThreadSummary,
  ThreadSummary,
} from "../../../src/thread-summary.js";
import { Sidebar } from "../src/renderer/src/Sidebar.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { derivePinnedThreads } from "../src/renderer/src/thread-list.js";
import type { ZenXSidebarOrder } from "../src/main/host-profile.js";

function summary(id: string, openCount?: number): ThreadSummary {
  const value: ThreadSummary = {
    threadId: id,
    name: `${id} — a deliberately long synthetic thread title`,
    preview: "",
    archived: false,
    status: id === "selected" ? "active" : "idle",
    createdAt: "2026-11-02T00:00:01.000Z",
    updatedAt: "2026-11-02T00:00:01.000Z",
    recentActivityAt: "2026-11-02T00:00:01.000Z",
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd: "/synthetic",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    ...(openCount === undefined
      ? {}
      : {
          userQuestionSummary: {
            openCount,
            latestPublishedAt: "2026-11-02T00:00:01.000Z",
          },
        }),
  };
  for (const name of ["items", "itemList", "userQuestions"])
    Object.defineProperty(value, name, {
      get() {
        throw new Error("Sidebar must not read question/history pages");
      },
    });
  return value;
}

for (const density of ["compact", "detailed"] as const) {
  test(`${density} native summary badge is independent of execution, never navigates/focuses or reveals a hidden child`, async () => {
    const dom = new JSDOM(
      '<input id="composer" value="Untouched newer draft"><div id="root"></div>',
      { url: "http://localhost" },
    );
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
    };
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.assign(window, { zenx: { platform: "darwin" } });
    window.localStorage.setItem("zenx.sidebar.thread-density", density);
    const root = createRoot(document.getElementById("root")!);
    const selections: string[] = [];
    const mutations: string[] = [];
    const pinned = Object.freeze(["background", "selected"]);
    const visible = Object.freeze([] as string[]);
    const manual: ZenXSidebarOrder = {
      projectKeys: ["/synthetic"],
      threadIdsByProject: { "/synthetic": ["approval", "legacy"] },
    };
    Object.freeze(manual.projectKeys);
    Object.freeze(manual.threadIdsByProject["/synthetic"]);
    Object.freeze(manual.threadIdsByProject);
    Object.freeze(manual);
    const noop = () => undefined;
    const broken: NativeThreadSummary = {
      threadId: "broken",
      name: "Unavailable",
      status: "systemError",
      error: "Synthetic unavailable journal",
      archived: false,
      createdAt: null,
      updatedAt: null,
      preview: "",
    };
    const rows = (id: string) => [
      ...document.querySelectorAll<HTMLElement>(`[data-thread-id="${id}"]`),
    ];
    const badges = (id: string) =>
      rows(id).flatMap((row) => [
        ...row.querySelectorAll<HTMLElement>(".thread-asking-badge"),
      ]);
    const render = async (open: boolean, pending = false, language = "en") => {
      const selected = summary("selected", open ? 1 : 0);
      const background = summary("background", open ? 2 : 0);
      const approval = summary("approval", open ? 1 : 0);
      const child = { ...summary("hidden", 3), parentThreadId: "selected" };
      if (open) background.recentActivityAt = "2026-11-02T00:00:02.000Z";
      const threads = [
        selected,
        background,
        approval,
        summary("legacy"),
        child,
        broken,
      ];
      if (pending)
        for (const thread of [selected, background, approval])
          thread.userQuestionSummary!.openCount = 0;
      await act(async () => {
        await i18n.changeLanguage(language);
        root.render(
          React.createElement(Sidebar, {
            mode: "projects",
            open: true,
            onClose: noop,
            onNewThread: noop,
            onAddProject: noop,
            onRemoveProject: noop,
            onSetDefaultProject: noop,
            onOpenContribution: noop,
            onOpenSettings: noop,
            onRetryThreads: noop,
            onChangeThreadLifecycle: async () => {
              mutations.push("lifecycle");
            },
            onChangeThreadPinned: async () => {
              mutations.push("pin");
            },
            onRenameThread: async () => {
              mutations.push("rename");
            },
            onSelectThread: (id) => selections.push(id),
            pendingApprovalThreadIds: new Set(["approval"]),
            unreadThreadIds: new Set(["background"]),
            pluginContributions: [],
            selectedPage: "agent",
            selectedThreadId: "selected",
            serverStatus: { type: "ready", reconnected: false },
            liveThread: null,
            threadError: null,
            threadLoading: false,
            visibleSubagentThreadIds: visible,
            sidebarOrder: manual,
            pinnedThreads: derivePinnedThreads(threads, pinned),
            threads,
            projects: {
              projects: [
                {
                  key: "/synthetic",
                  workspace: "/synthetic",
                  configured: true,
                  isDefault: true,
                  threadIds: [
                    "selected",
                    "background",
                    "approval",
                    "legacy",
                    "hidden",
                  ],
                },
              ],
              unavailableThreadIds: ["broken"],
              lastUsedWorkspace: null,
            },
          }),
        );
      });
    };
    try {
      await render(false);
      const composer = document.querySelector<HTMLInputElement>("#composer")!;
      composer.focus();
      assert.equal(document.querySelectorAll(".thread-asking-badge").length, 0);
      await render(true);
      const recentCurrent = document.querySelector<HTMLElement>(
        ".recent-thread-group .thread-row.selected",
      )!;
      const secondary =
        ".sidebar:has(.project-group .thread-row.selected, .pinned-thread-group .thread-row.selected) .recent-thread-group .thread-row.selected";
      assert.ok(recentCurrent.matches(secondary));
      assert.equal(recentCurrent.getAttribute("aria-current"), "page");
      const pinnedToggle = document.querySelector<HTMLButtonElement>(
        ".pinned-section-toggle",
      )!;
      await act(async () => pinnedToggle.click());
      assert.equal(
        recentCurrent.matches(secondary),
        false,
        "collapsed primary location restores Recent's primary fill",
      );
      assert.equal(recentCurrent.getAttribute("aria-current"), "page");
      await act(async () => pinnedToggle.click());
      assert.ok(recentCurrent.matches(secondary));
      composer.focus();
      assert.equal(
        document.querySelector(".sidebar")!.getAttribute("data-thread-density"),
        density,
      );
      assert.ok(badges("selected").length > 0);
      assert.ok(badges("background").length > 0);
      for (const badge of badges("selected")) {
        assert.equal(badge.textContent, "Asking");
        assert.equal(
          badge.getAttribute("aria-label"),
          "1 open question request",
        );
        assert.equal(badge.getAttribute("role"), "img");
        assert.equal(badge.getAttribute("tabindex"), null);
      }
      for (const badge of badges("background"))
        assert.equal(badge.title, "2 open question requests");
      assert.ok(
        rows("selected").every((row) =>
          row.querySelector('[aria-label="Running"]'),
        ),
      );
      assert.ok(
        rows("approval").every(
          (row) =>
            row.textContent?.includes("Needs your approval") &&
            row.querySelector(".thread-asking-badge"),
        ),
      );
      assert.ok(
        rows("background").every((row) =>
          row.querySelector(".thread-unread-dot"),
        ),
      );
      assert.equal(badges("legacy").length, 0);
      assert.equal(badges("broken").length, 0);
      assert.equal(
        rows("hidden").length,
        0,
        "positive count cannot reveal hidden child or inflate its parent count",
      );
      assert.equal(document.activeElement, composer);
      assert.equal(composer.value, "Untouched newer draft");
      assert.deepEqual(selections, []);
      assert.deepEqual(mutations, []);
      await render(true, false, "zh-CN");
      assert.equal(badges("selected")[0]!.textContent, "待回答");
      assert.equal(badges("background")[0]!.title, "2 组问题待回答");
      assert.equal(document.activeElement, composer);
      await render(true, true);
      assert.equal(
        document.querySelectorAll(".thread-asking-badge").length,
        0,
        "pending count zero removes asking, not an answered claim",
      );
      assert.doesNotMatch(document.body.textContent!, /answered|已回答/u);
      await render(true);
      assert.equal(
        document.activeElement,
        composer,
        "recall reopens attention without stealing focus",
      );
      assert.deepEqual(selections, []);
      await act(async () => badges("background")[0]!.click());
      assert.deepEqual(
        selections,
        ["background"],
        "only explicit row activation uses normal navigation",
      );
      assert.deepEqual(mutations, []);
      assert.deepEqual(pinned, ["background", "selected"]);
      assert.deepEqual(visible, []);
      assert.deepEqual(manual.threadIdsByProject["/synthetic"], [
        "approval",
        "legacy",
      ]);
    } finally {
      await act(async () => root.unmount());
      await i18n.changeLanguage("en");
      Object.assign(globalThis, previous, {
        IS_REACT_ACT_ENVIRONMENT: undefined,
      });
      dom.window.close();
    }
  });
}

test("asking capsule shares the title flex layout, preserves status rail spacing and forced-colors text", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.thread-asking-badge\s*\{[^}]*flex: 0 0 auto;[^}]*white-space: nowrap;/u,
  );
  assert.match(
    styles,
    /\.thread-title > span:first-child,[\s\S]*?min-width: 0;[\s\S]*?text-overflow: ellipsis;/u,
  );
  assert.match(
    styles,
    /@media \(forced-colors: active\)\s*\{\s*\.thread-asking-badge\s*\{[^}]*border-color: CanvasText;[^}]*color: CanvasText;/u,
  );
  assert.doesNotMatch(
    styles,
    /\[data-thread-density="(?:compact|detailed)"\][^{]*\.thread-asking-badge\s*\{[^}]*display: none/u,
  );
});
