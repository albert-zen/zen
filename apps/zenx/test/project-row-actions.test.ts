import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

Object.assign(globalThis, { React });
const { Sidebar } = await import("../src/renderer/src/Sidebar.js");

test("configured Project rows expose scoped creation and a keyboard-safe More menu", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    {
      url: "http://localhost",
    },
  );
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const created: string[] = [];
  const defaults: string[] = [];
  const removed: string[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  const projects = [
    ["/work/zen", true],
    ["/work/alpha", false],
    ["/work/beta", false],
  ] as const;

  try {
    await act(async () => {
      root.render(
        createElement(Sidebar, {
          mode: "projects",
          open: true,
          onClose: () => undefined,
          onChangeThreadLifecycle: async () => undefined,
          onChangeThreadPinned: async () => undefined,
          onNewThread: (workspace?: string) => {
            if (workspace !== undefined) created.push(workspace);
          },
          onAddProject: () => undefined,
          onRemoveProject: (workspace: string) => removed.push(workspace),
          onSetDefaultProject: (workspace: string) => defaults.push(workspace),
          onOpenContribution: () => undefined,
          onOpenSettings: () => undefined,
          onRetryThreads: () => undefined,
          onRenameThread: async () => undefined,
          onSelectThread: () => undefined,
          pendingApprovalThreadIds: new Set<string>(),
          pluginContributions: [],
          selectedPage: "agent",
          selectedThreadId: null,
          serverStatus: { type: "ready", reconnected: false },
          liveThread: null,
          threadError: null,
          threadLoading: false,
          projects: {
            projects: projects.map(([workspace, isDefault]) => ({
              key: workspace,
              workspace,
              configured: true,
              isDefault,
              threadIds: [],
            })),
            unavailableThreadIds: [],
            lastUsedWorkspace: "/work/zen",
          },
          pinnedThreads: [],
          threads: [],
        }),
      );
    });

    assert.equal(document.querySelectorAll(".project-more-trigger").length, 3);
    assert.equal(document.querySelectorAll(".project-toggle svg").length, 3);
    assert.equal(
      document.querySelectorAll('[aria-label^="New thread in "]').length,
      3,
    );

    const beta = document.querySelector<HTMLElement>(
      '[data-project-key="/work/beta"]',
    );
    assert.ok(beta);
    const compose = beta.querySelector<HTMLButtonElement>(
      '[aria-label="New thread in beta"]',
    );
    assert.ok(compose);
    await act(async () => compose.click());
    assert.deepEqual(created, ["/work/beta"]);

    const more = beta.querySelector<HTMLButtonElement>(".project-more-trigger");
    assert.ok(more);
    more.getBoundingClientRect = () =>
      rect({ left: 760, top: 20, width: 26, height: 28 });
    const getBoundingClientRect =
      dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("project-menu")
        ? rect({ left: 0, top: 0, width: 172, height: 84 })
        : getBoundingClientRect.call(this);
    };
    Object.defineProperties(dom.window, {
      innerHeight: { configurable: true, value: 640 },
      innerWidth: { configurable: true, value: 800 },
    });
    await act(async () => {
      more.focus();
      more.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      );
    });
    const openedMenu = requiredElement<HTMLElement>(".project-menu");
    assert.equal(openedMenu.parentElement, document.body);
    assert.equal(openedMenu.dataset.placement, "left");
    assert.equal(openedMenu.style.left, "582px");
    assert.equal(openedMenu.style.top, "20px");
    assert.match(document.activeElement?.textContent ?? "", /Set as default/u);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
    });
    assert.equal(document.activeElement, more);
    await act(async () => {
      more.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowUp",
        }),
      );
    });
    assert.match(
      document.activeElement?.textContent ?? "",
      /Remove from ZenX/u,
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
    });
    assert.equal(document.activeElement, more);
    await act(async () => more.click());
    assert.equal(
      currentProjectMenu()?.textContent?.includes("Set as default"),
      true,
    );
    assert.equal(
      currentProjectMenu()?.textContent?.includes("Remove from ZenX"),
      true,
    );
    assert.match(document.activeElement?.textContent ?? "", /Set as default/u);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowDown",
        }),
      );
    });
    assert.match(
      document.activeElement?.textContent ?? "",
      /Remove from ZenX/u,
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Home",
        }),
      );
    });
    assert.match(document.activeElement?.textContent ?? "", /Set as default/u);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "End",
        }),
      );
    });
    assert.match(
      document.activeElement?.textContent ?? "",
      /Remove from ZenX/u,
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowUp",
        }),
      );
    });
    assert.match(document.activeElement?.textContent ?? "", /Set as default/u);
    const focusedMore = more;
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
    });
    assert.equal(document.activeElement, focusedMore);
    assert.equal(currentProjectMenu(), null);
    await act(async () => more.click());
    await act(async () =>
      currentProjectMenu()!
        .querySelector<HTMLButtonElement>('[role="menuitem"]')!
        .click(),
    );
    assert.deepEqual(defaults, ["/work/beta"]);
    assert.equal(currentProjectMenu(), null);

    await act(async () => more.click());
    await act(async () => {
      dom.window.document.body.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true }),
      );
    });
    assert.equal(currentProjectMenu(), null);

    await act(async () => more.focus());
    await act(async () =>
      more.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      ),
    );
    assert.ok(currentProjectMenu());
    await act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(currentProjectMenu(), null);

    await act(async () => more.click());
    const removeAgain = Array.from(
      currentProjectMenu()!.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ),
    ).find((button) => button.textContent?.includes("Remove from ZenX"));
    assert.ok(removeAgain);
    await act(async () => removeAgain.click());
    assert.deepEqual(removed, ["/work/beta"]);

    const defaultProject = document.querySelector<HTMLElement>(
      '[data-project-key="/work/zen"]',
    );
    assert.ok(defaultProject);
    const defaultMore = defaultProject.querySelector<HTMLButtonElement>(
      ".project-more-trigger",
    );
    assert.ok(defaultMore);
    await act(async () => defaultMore.click());
    assert.equal(
      currentProjectMenu()!.querySelectorAll('[role="menuitem"]').length,
      1,
    );
    assert.match(
      document.activeElement?.textContent ?? "",
      /Remove from ZenX/u,
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowUp",
        }),
      );
    });
    assert.match(
      document.activeElement?.textContent ?? "",
      /Remove from ZenX/u,
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
    });
    assert.equal(document.activeElement, defaultMore);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

function currentProjectMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".project-menu");
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  assert.ok(element, `Expected ${selector}`);
  return element;
}

function rect({
  left,
  top,
  width,
  height,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
