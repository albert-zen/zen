import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { ZenXSidebarOrder } from "../src/main/host-profile.js";

Object.assign(globalThis, { React });
const { Sidebar } = await import("../src/renderer/src/Sidebar.js");
const { act, createElement, useState } = React;
const noop = () => undefined;

function summary(id: string, cwd: string): NativeThreadSummary {
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
    selected: string[];
    created: (string | undefined)[];
    key(
      key: string,
      init?: KeyboardEventInit,
      target?: Element,
    ): Promise<boolean>;
  }) => Promise<void>,
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
    ];
    return createElement(Sidebar, {
      mode: "projects",
      open: true,
      onClose: noop,
      onNewThread: (workspace) => created.push(workspace),
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
            threadIds: ["Beta"],
          },
        ],
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
      pinnedThreads: [threads[0]!],
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

test("plugins and Projects retain disclosure choices across remount", async () => {
  await harness(async ({ remount }) => {
    await click(".plugin-spaces-toggle");
    await click(".projects-section-toggle");
    await remount();
    assert.equal(
      button(".plugin-spaces-toggle").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      button(".projects-section-toggle").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(document.querySelector(".project-group"), null);
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
    assert.equal(await key("3"), false);
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
