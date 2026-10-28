import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { ThreadSummary } from "../../../src/thread-summary.js";
import type { ZenXSidebarOrder } from "../src/main/host-profile.js";

Object.assign(globalThis, { React });
const { Sidebar } = await import("../src/renderer/src/Sidebar.js");
const { act, createElement, useState } = React;
const noop = () => undefined;

function summary(id: string, cwd: string): ThreadSummary {
  return {
    threadId: id,
    name: id,
    preview: "",
    archived: false,
    status: "idle",
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(2000).toISOString(),
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  };
}

async function harness(
  run: (controls: {
    remount(): Promise<void>;
    setVisible(ids: string[]): Promise<void>;
    selected: string[];
    created: (string | undefined)[];
    key(
      key: string,
      init?: KeyboardEventInit,
      target?: Element,
    ): Promise<boolean>;
  }) => Promise<void>,
  includeChildren = false,
  extraRecent = 0,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window, { zenx: { platform: "darwin" } });
  const root = createRoot(document.getElementById("root")!);
  let visibleSubagentThreadIds: string[] = [];
  const selected: string[] = [];
  const created: (string | undefined)[] = [];
  function Harness() {
    const [order, setOrder] = useState<ZenXSidebarOrder>(() =>
      JSON.parse(
        window.localStorage.getItem("test.order") ??
          '{"projectKeys":[],"threadIdsByProject":{}}',
      ),
    );
    const threads = [
      summary("Pinned", "/a"),
      summary("Alpha", "/a"),
      summary("Beta", "/b"),
      ...(extraRecent
        ? Array.from({ length: extraRecent }, (_, index) => ({
            ...summary(`Recent ${index}`, `/synthetic/no-project/${index}`),
            updatedAt: new Date(10_000 + index * 1000).toISOString(),
          }))
        : []),
      ...(includeChildren
        ? [
            { ...summary("Child", "/b"), parentThreadId: "Beta" },
            {
              ...summary("Independent fork", "/b"),
              forkedFromThreadId: "Beta",
            },
          ]
        : []),
    ];
    return createElement(Sidebar, {
      mode: "projects",
      open: true,
      onClose: noop,
      onNewThread: (workspace) => created.push(workspace),
      onNewProjectlessThread: () => created.push(undefined),
      onAddProject: noop,
      onRemoveProject: noop,
      onSetDefaultProject: noop,
      onOpenContribution: noop,
      onOpenSettings: noop,
      onChangeThreadLifecycle: async () => {},
      onChangeThreadPinned: async () => {},
      onRenameThread: async () => {},
      onRetryThreads: noop,
      onSelectThread: (id) => selected.push(id),
      pendingApprovalThreadIds: new Set<string>(),
      pluginContributions: [
        {
          key: "rooms",
          pluginId: "rooms",
          id: "rooms",
          label: "Rooms",
          icon: "users",
          pageId: "rooms",
          page: {
            pluginId: "rooms",
            id: "rooms",
            key: "rooms",
            route: "rooms",
            title: "Rooms",
          },
        },
      ],
      projects: {
        projects: [
          {
            key: "/a",
            workspace: "/a",
            name: "A",
            configured: true,
            isDefault: true,
            threadIds: ["Alpha", "Pinned"],
          },
          {
            key: "/b",
            workspace: "/b",
            name: "B",
            configured: true,
            isDefault: false,
            threadIds: ["Beta", "Child", "Independent fork"],
          },
        ],
        projectlessThreadIds: Array.from(
          { length: extraRecent },
          (_, index) => `Recent ${index}`,
        ),
        unavailableThreadIds: [],
        lastUsedWorkspace: "/b",
      },
      onChangeProjectPinned: async (key) => {
        const next = {
          ...order,
          pinnedProjectKeys: order.pinnedProjectKeys?.includes(key)
            ? order.pinnedProjectKeys.filter((value) => value !== key)
            : [key],
        };
        window.localStorage.setItem("test.order", JSON.stringify(next));
        setOrder(next);
      },
      sidebarOrder: order,
      selectedPage: "agent",
      selectedThreadId: null,
      serverStatus: { type: "ready", reconnected: false },
      threadError: null,
      threadLoading: false,
      liveThread: null,
      visibleSubagentThreadIds,
      pinnedThreads: includeChildren
        ? [threads[0]!, threads[3]!]
        : [threads[0]!],
      threads,
    });
  }
  const remount = async () => {
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Harness)));
  };
  try {
    await remount();
    await run({
      remount,
      setVisible: async (ids) => {
        visibleSubagentThreadIds = ids;
        await remount();
      },
      selected,
      created,
      key: async (key, init = {}, target = document.body) => {
        const event = new dom.window.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          metaKey: true,
          ...init,
        });
        await act(async () => {
          target.dispatchEvent(event);
        });
        return event.defaultPrevented;
      },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

const button = (selector: string) => {
  const result = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(result, selector);
  return result;
};
const click = async (selector: string) => {
  await act(async () => button(selector).click());
};

test("project pins reorder the list, retain collapse through reload, and unpin restores order", async () => {
  await harness(async ({ remount }) => {
    await click('[data-project-key="/b"] .project-toggle');
    await click('[data-project-key="/b"] .project-more-trigger');
    await click(".project-menu button");
    assert.equal(
      document
        .querySelector(".project-group")
        ?.getAttribute("data-project-key"),
      "/b",
    );
    assert.equal(
      button('[data-project-key="/b"] .project-toggle').getAttribute(
        "aria-expanded",
      ),
      "false",
    );
    await remount();
    assert.equal(
      document
        .querySelector(".project-group")
        ?.getAttribute("data-project-key"),
      "/b",
    );
    assert.equal(
      button('[data-project-key="/b"] .project-toggle').getAttribute(
        "aria-expanded",
      ),
      "false",
    );
    await click('[data-project-key="/b"] .project-more-trigger');
    assert.match(
      document.querySelector(".project-menu")?.textContent ?? "",
      /Unpin project/,
    );
    await click(".project-menu button");
    assert.equal(
      document
        .querySelector(".project-group")
        ?.getAttribute("data-project-key"),
      "/a",
    );
  });
});

test("only New thread stays above one scroll area while Projects retains disclosure choices", async () => {
  await harness(async ({ remount }) => {
    assert.ok(document.querySelector(".sidebar-header .new-thread-action"));
    assert.equal(
      document.querySelector(".sidebar-header .plugin-space-link"),
      null,
    );
    assert.ok(document.querySelector(".sidebar-scroll .plugin-space-link"));
    assert.ok(
      document.querySelector(".sidebar-scroll .projects-section-toggle"),
    );
    await click(".projects-section-toggle");
    await remount();
    assert.equal(document.querySelector(".plugin-spaces-toggle"), null);
    assert.ok(document.querySelector(".plugin-space-link"));
    assert.equal(
      button(".projects-section-toggle").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(document.querySelector(".project-group"), null);
  });
});

test("Thread rows default to detailed model metadata and persist compact density locally", async () => {
  await harness(async ({ remount }) => {
    const sidebar = document.querySelector("#primary-sidebar")!;
    assert.equal(sidebar.getAttribute("data-thread-density"), "detailed");
    assert.match(
      document.querySelector(".thread-model")?.textContent ?? "",
      /^Local demo$/,
    );
    await click(".sidebar-density-toggle");
    assert.equal(sidebar.getAttribute("data-thread-density"), "compact");
    assert.equal(
      window.localStorage.getItem("zenx.sidebar.thread-density"),
      "compact",
    );
    await remount();
    assert.equal(
      document
        .querySelector("#primary-sidebar")
        ?.getAttribute("data-thread-density"),
      "compact",
    );
  });
});

test("holding the platform modifier labels only the real New and visible Thread targets", async () => {
  await harness(async () => {
    await act(async () => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Meta",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    assert.equal(
      button(".new-thread-action").getAttribute("data-shortcut-key"),
      "N",
    );
    assert.deepEqual(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".thread-row[data-shortcut-key]",
        ),
      ].map((row) => row.getAttribute("data-shortcut-key")),
      ["1", "2", "3"],
    );
    assert.equal(
      document
        .querySelector(".plugin-space-link")
        ?.hasAttribute("data-shortcut-key"),
      false,
    );
    await act(async () => {
      document.dispatchEvent(
        new window.KeyboardEvent("keyup", { key: "Meta", bubbles: true }),
      );
    });
    assert.equal(document.querySelector("[data-shortcut-key]"), null);
  });
});

test("Cmd/Ctrl digits follow expanded row order and N uses the New thread action", async () => {
  await harness(async ({ key, selected, created }) => {
    assert.equal(await key("1"), true);
    assert.deepEqual(selected, ["Pinned"]);
    await key("2");
    assert.equal(selected.at(-1), "Alpha");
    await click('[data-project-key="/a"] .project-toggle');
    await key("2");
    assert.equal(selected.at(-1), "Beta");
    assert.equal(await key("3"), true);
    assert.equal(
      selected.at(-1),
      "Alpha",
      "Recent retains the collapsed project conversation",
    );
    await key("n");
    assert.deepEqual(created, ["/b"]);
    Object.assign(window.zenx, { platform: "win32" });
    assert.equal(await key("1"), false);
    await key("1", { metaKey: false, ctrlKey: true });
    assert.equal(selected.at(-1), "Pinned");
    await key("n", { metaKey: false, ctrlKey: true });
    assert.deepEqual(created, ["/b", "/b"]);
  });
});

test("shortcuts leave composition, extra modifiers, dialogs, missing slots and disabled New alone", async () => {
  await harness(async ({ key, selected, created }) => {
    for (const init of [
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true },
      { isComposing: true },
      { repeat: true },
    ]) {
      assert.equal(await key("1", init), false);
      assert.equal(await key("n", init), false);
    }
    assert.equal(await key("0"), false);
    assert.equal(await key("9"), false);
    const input = document.createElement("textarea");
    document.body.append(input);
    await key("2", {}, input);
    assert.deepEqual(selected, ["Alpha"]);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    assert.equal(await key("1"), false);
    assert.equal(await key("n"), false);
    dialog.remove();
    button(".new-thread-action").disabled = true;
    assert.equal(await key("n"), false);
    assert.deepEqual(created, []);
  });
});

test("per-child Sidebar preference filters ordinary and Pinned lists and ignores the old global switch", async () => {
  await harness(async ({ remount, setVisible }) => {
    const rows = () =>
      [...document.querySelectorAll(".thread-row-shell")].map(
        (row) => row.textContent,
      );
    assert.ok(!rows().some((text) => text?.includes("Child")));
    assert.ok(rows().some((text) => text?.includes("Independent fork")));
    assert.equal(document.querySelector(".sidebar-subagents-toggle"), null);
    window.localStorage.setItem("zenx-sidebar-show-subagents", "true");
    await remount();
    assert.ok(
      !rows().some((text) => text?.includes("Child")),
      "legacy global state must not reveal a child",
    );
    await setVisible(["Child"]);
    assert.ok(
      document
        .querySelector(".pinned-thread-group")
        ?.textContent?.includes("Child"),
    );
    await remount();
    assert.ok(rows().some((text) => text?.includes("Child")));
    await setVisible([]);
    assert.ok(!rows().some((text) => text?.includes("Child")));
    assert.ok(
      document
        .querySelector(".pinned-thread-group")
        ?.textContent?.includes("Pinned"),
      "ordinary Pin stays visible",
    );
    await setVisible(["Child"]);
    assert.ok(
      document
        .querySelector(".pinned-thread-group")
        ?.textContent?.includes("Child"),
      "child Pin preference survives hiding",
    );
  }, true);
});

test("Pinned, Projects and Recent are independent disclosures and Recent creates without a project", async () => {
  await harness(async ({ remount, created }) => {
    const pin = button("#sidebar-pinned-heading");
    const projects = button("#sidebar-thread-list-heading");
    const recent = button("#sidebar-recent-heading");
    assert.ok(
      pin.compareDocumentPosition(projects) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.ok(
      projects.compareDocumentPosition(recent) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.equal(
      document.querySelectorAll(".recent-thread-group .thread-row-shell")
        .length,
      3,
    );
    const ids = [...document.querySelectorAll("[id]")].map((item) => item.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      "duplicate projections need unique accessibility IDs",
    );
    await act(async () => pin.click());
    assert.equal(
      document.querySelectorAll(".pinned-thread-group .thread-row-shell")
        .length,
      0,
    );
    assert.equal(
      document.querySelectorAll(".recent-thread-group .thread-row-shell")
        .length,
      3,
    );
    await act(async () => recent.click());
    assert.equal(
      document.querySelectorAll(".recent-thread-group .thread-row-shell")
        .length,
      0,
    );
    assert.ok(document.querySelector(".project-group .thread-row-shell"));
    await remount();
    assert.equal(
      button("#sidebar-pinned-heading").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      button("#sidebar-recent-heading").getAttribute("aria-expanded"),
      "false",
    );
    await act(async () => button(".recent-new-thread").click());
    assert.deepEqual(
      created,
      [undefined],
      "explicit no-project action does not use last-used project",
    );
  });
});

test("Recent sorts all visible conversations by activity and reveals more without changing project order", async () => {
  await harness(
    async () => {
      const recentIds = () =>
        [
          ...document.querySelectorAll<HTMLElement>(
            ".recent-thread-group [data-thread-id]",
          ),
        ].map((row) => row.dataset.threadId);
      assert.equal(
        document.querySelector('[data-project-key="__projectless__"]'),
        null,
        "No project must not become a fake project folder",
      );
      assert.equal(
        document.querySelectorAll("[data-project-key]").length,
        2,
        "real project groups are retained",
      );
      assert.equal(recentIds().length, 30);
      assert.equal(recentIds()[0], "Recent 39");
      assert.equal(recentIds()[29], "Recent 10");
      await act(async () => button(".sidebar-show-more").click());
      assert.equal(recentIds().length, 43);
      assert.ok(recentIds().includes("Pinned"));
      assert.ok(recentIds().includes("Alpha"));
      assert.equal(document.querySelector(".sidebar-show-more"), null);
      const firstProject =
        document.querySelector<HTMLElement>("[data-project-key]");
      assert.equal(firstProject?.dataset.projectKey, "/a");
    },
    false,
    40,
  );
});

test("Show more keeps keyboard focus on the newly revealed Recent row, including the final batch", async () => {
  await harness(
    async () => {
      for (const count of [60, 73]) {
        const more = button(".sidebar-show-more");
        more.focus();
        const previousCount = document.querySelectorAll(
          ".recent-thread-group .thread-row",
        ).length;
        await act(async () => more.click());
        const rows = document.querySelectorAll(
          ".recent-thread-group .thread-row",
        );
        assert.equal(rows.length, count);
        assert.equal(document.activeElement, rows[previousCount]);
      }
      assert.equal(document.querySelector(".sidebar-show-more"), null);
    },
    false,
    70,
  );
});
