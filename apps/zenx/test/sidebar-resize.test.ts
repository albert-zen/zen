import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  clampSidebarWidth,
  readSidebarWidth,
  sidebarWidthLimit,
  SIDEBAR_WIDTH_KEY,
} from "../src/renderer/src/sidebar-width.js";
import { i18n } from "../src/renderer/src/i18n.js";

Object.assign(globalThis, { React });
const { SidebarResizer } =
  await import("../src/renderer/src/SidebarResizer.js");
const { act, createElement: h } = React;

test("sidebar width validates persisted values and preserves workspace room", () => {
  for (const raw of [
    null,
    "",
    " ",
    "null",
    "NaN",
    "Infinity",
    "-1",
    "0",
    "219",
    "481",
    '{"width":300}',
  ])
    assert.equal(readSidebarWidth({ getItem: () => raw }), 264, String(raw));
  assert.equal(readSidebarWidth({ getItem: () => "337.3" }), 337);
  assert.equal(
    readSidebarWidth({
      getItem: () => {
        throw new Error("denied");
      },
    }),
    264,
  );
  assert.equal(clampSidebarWidth(999, 1200), 480);
  assert.equal(clampSidebarWidth(-10, 1200), 220);
  assert.equal(clampSidebarWidth(480, 800), 320);
  assert.equal(sidebarWidthLimit(721.5), 241);
});

async function harness(
  run: (api: {
    dom: JSDOM;
    shell: HTMLElement;
    handle(): HTMLDivElement;
    width(): number;
    key(key: string, init?: KeyboardEventInit): Promise<boolean>;
    pointer(
      type: string,
      x?: number,
      init?: Record<string, unknown>,
    ): Promise<void>;
    resize(width: number): Promise<void>;
    render(collapsed?: boolean): Promise<void>;
    unmount(): Promise<void>;
    remount(): Promise<void>;
  }) => Promise<void>,
  initial?: string,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  if (initial !== undefined)
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, initial);
  let viewport = 1200;
  const captures = new WeakMap<Element, Set<number>>();
  dom.window.HTMLElement.prototype.setPointerCapture = function (id) {
    captures.set(this, new Set([id]));
  };
  dom.window.HTMLElement.prototype.hasPointerCapture = function (id) {
    return captures.get(this)?.has(id) ?? false;
  };
  dom.window.HTMLElement.prototype.releasePointerCapture = function (id) {
    captures.get(this)?.delete(id);
    const event = new dom.window.Event("lostpointercapture", { bubbles: true });
    Object.assign(event, { pointerId: id });
    this.dispatchEvent(event);
  };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      width: viewport,
      height: 800,
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: viewport,
      bottom: 800,
      toJSON() {},
    };
  };
  const root = createRoot(document.getElementById("root")!);
  let collapsed = false;
  let mounted = true;
  const content = () =>
    h(
      "div",
      { className: `app-shell${collapsed ? " sidebar-collapsed" : ""}` },
      h("button", { className: "sidebar-collapse-button" }, "Toggle sidebar"),
      h("button", { className: "mobile-menu" }, "Open sidebar"),
      h("button", { className: "mobile-menu" }, "Open sidebar"),
      h("aside", { id: "primary-sidebar" }),
      h(SidebarResizer, {
        collapsed,
        onCollapse: () => {
          collapsed = true;
          root.render(h(React.StrictMode, null, content()));
        },
      }),
    );
  const render = async (next = false) => {
    collapsed = next;
    await act(async () => root.render(h(React.StrictMode, null, content())));
  };
  await render();
  const handle = () =>
    document.querySelector<HTMLDivElement>(".sidebar-resizer")!;
  try {
    await run({
      dom,
      shell: document.querySelector<HTMLElement>(".app-shell")!,
      handle,
      width: () => Number(handle().getAttribute("aria-valuenow")),
      render,
      key: async (key, init = {}) => {
        const event = new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
          ...init,
        });
        await act(async () => handle().dispatchEvent(event));
        return event.defaultPrevented;
      },
      pointer: async (type, x = 264, init = {}) => {
        const event = new dom.window.Event(type, {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, {
          pointerId: 1,
          button: 0,
          isPrimary: true,
          clientX: x,
          ...init,
        });
        await act(async () => handle().dispatchEvent(event));
      },
      resize: async (width) => {
        viewport = width;
        await act(async () =>
          window.dispatchEvent(new dom.window.Event("resize")),
        );
      },
      unmount: async () => {
        await act(async () => root.unmount());
        mounted = false;
      },
      remount: async () => {
        await act(async () => root.render(null));
        await render();
      },
    });
  } finally {
    if (mounted) await act(async () => root.unmount());
    Object.assign(globalThis, saved);
    dom.window.close();
  }
}

test("keyboard separator changes, clamps and persists on remount", async () => {
  await harness(async (a) => {
    assert.equal(a.handle().getAttribute("role"), "separator");
    assert.equal(a.handle().getAttribute("aria-controls"), "primary-sidebar");
    assert.equal(a.handle().getAttribute("aria-orientation"), "vertical");
    assert.equal(await a.key("ArrowRight"), true);
    assert.equal(a.width(), 274);
    await a.key("ArrowRight", { shiftKey: true });
    assert.equal(a.width(), 324);
    await a.key("Home");
    assert.equal(a.width(), 220);
    await a.key("End");
    assert.equal(a.width(), 480);
    assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "480");
    await a.remount();
    assert.equal(a.width(), 480);
    assert.equal(await a.key("ArrowLeft", { ctrlKey: true }), false);
    assert.equal(a.width(), 480);
  });
});

test("primary pointer capture tracks deltas, ignores others and commits only once released", async () => {
  await harness(async (a) => {
    await a.pointer("pointerdown", 262);
    assert.equal(a.handle().hasPointerCapture(1), true);
    await a.pointer("pointermove", 360, { pointerId: 2 });
    assert.equal(a.width(), 264);
    await a.pointer("pointermove", 362);
    assert.equal(a.width(), 364);
    assert.equal(a.shell.style.getPropertyValue("--sidebar-width"), "364px");
    assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), null);
    await a.pointer("pointerup", 362, { pointerId: 2 });
    assert.equal(a.handle().dataset.resizing, "true");
    await a.pointer("pointerup", 362);
    assert.equal(a.handle().hasPointerCapture(1), false);
    assert.equal(a.handle().dataset.resizing, "false");
    assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "364");
    await a.pointer("pointermove", 400);
    assert.equal(a.width(), 364);
  });
});

for (const type of [
  "pointercancel",
  "lostpointercapture",
  "escape",
  "blur",
  "collapse",
  "resize",
]) {
  test(`interrupted gesture (${type}) restores original preference without saving`, async () => {
    await harness(async (a) => {
      await a.pointer("pointerdown", 350);
      await a.pointer("pointermove", 430);
      assert.equal(a.width(), 430);
      if (type === "escape") await a.key("Escape");
      else if (type === "blur")
        await act(async () =>
          window.dispatchEvent(new a.dom.window.Event("blur")),
        );
      else if (type === "collapse") await a.render(true);
      else if (type === "resize") await a.resize(1100);
      else await a.pointer(type);
      assert.equal(a.width(), 350);
      assert.equal(a.handle().hasPointerCapture(1), false);
      assert.equal(a.handle().dataset.resizing, "false");
      assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "350");
    }, "350");
  });
}

test("collapsed, narrow and overlay layouts do not overwrite expanded preference", async () => {
  await harness(async (a) => {
    await a.resize(800);
    assert.equal(a.width(), 320);
    assert.equal(a.handle().getAttribute("aria-valuemax"), "320");
    await a.pointer("pointerdown", 320);
    await a.pointer("pointerup", 320);
    assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "460");
    await a.render(true);
    assert.equal(a.handle().tabIndex, -1);
    await a.render(false);
    a.handle().focus();
    await a.resize(390);
    assert.equal(document.activeElement?.className, "mobile-menu");
    assert.equal(a.handle().tabIndex, -1);
    assert.equal(a.handle().getAttribute("aria-hidden"), "true");
    await a.pointer("pointerdown");
    await a.pointer("pointermove", 400);
    assert.equal(a.handle().hasPointerCapture(1), false);
    await a.resize(1200);
    assert.equal(a.width(), 460);
    assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "460");
    assert.equal(a.handle().tabIndex, 0);
  }, "460");
});

test("Enter collapses and restores focus to the existing toggle", async () => {
  await harness(async (a) => {
    a.handle().focus();
    await a.key("Enter");
    assert.equal(a.handle().tabIndex, -1);
    assert.equal(document.activeElement?.className, "sidebar-collapse-button");
    await a.render(false);
    assert.equal(a.width(), 350);
  }, "350");
});

test("non-primary pointers and failed capture cannot start a resize", async () => {
  await harness(async (a) => {
    for (const init of [{ button: 2 }, { isPrimary: false }]) {
      await a.pointer("pointerdown", 264, init);
      await a.pointer("pointermove", 400);
      assert.equal(a.width(), 264);
      assert.equal(a.handle().dataset.resizing, "false");
    }
    a.handle().setPointerCapture = () => {
      throw new Error("pointer already gone");
    };
    await a.pointer("pointerdown");
    assert.equal(a.handle().dataset.resizing, "false");
  });
});

test("unmount releases capture and removes layout preference without committing a drag", async () => {
  await harness(async (a) => {
    await a.pointer("pointerdown");
    await a.pointer("pointermove", 400);
    const handle = a.handle();
    await a.unmount();
    assert.equal(handle.hasPointerCapture(1), false);
    assert.equal(a.shell.style.getPropertyValue("--sidebar-width"), "");
    assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), null);
    window.dispatchEvent(new a.dom.window.Event("resize"));
    window.dispatchEvent(new a.dom.window.Event("blur"));
  });
});

test("cross-window storage changes cancel local gestures and malformed values reset safely", async () => {
  await harness(async (a) => {
    await a.pointer("pointerdown");
    await a.pointer("pointermove", 400);
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "310");
    await act(async () =>
      window.dispatchEvent(
        new a.dom.window.StorageEvent("storage", { key: SIDEBAR_WIDTH_KEY }),
      ),
    );
    assert.equal(a.width(), 310);
    assert.equal(a.handle().dataset.resizing, "false");
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "invalid");
    await act(async () =>
      window.dispatchEvent(
        new a.dom.window.StorageEvent("storage", { key: SIDEBAR_WIDTH_KEY }),
      ),
    );
    assert.equal(a.width(), 264);
    await a.key("ArrowRight");
    window.localStorage.clear();
    await act(async () =>
      window.dispatchEvent(
        new a.dom.window.StorageEvent("storage", { key: null }),
      ),
    );
    assert.equal(a.width(), 264);
  });
});

test("storage failure is visible while width stays usable and explicit retry can save", async () => {
  await harness(async (a) => {
    const original = a.dom.window.Storage.prototype.setItem;
    a.dom.window.Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    await a.key("ArrowRight");
    assert.equal(a.width(), 274);
    assert.match(
      document.querySelector('[role="status"]')!.textContent!,
      /could not be saved/,
    );
    a.dom.window.Storage.prototype.setItem = original;
    await a.key("ArrowRight");
    assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_KEY), "284");
    assert.equal(document.querySelector('[role="status"]'), null);
  });
});

test("separator labels update with the selected interface language", async () => {
  await harness(async (a) => {
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    assert.equal(a.handle().getAttribute("aria-label"), "侧边栏宽度");
    assert.equal(a.handle().getAttribute("aria-valuetext"), "264 像素");
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  });
});

test("viewport changes move focus off a hidden separator to the mobile menu", async () => {
  await harness(async (a) => {
    a.handle().focus();
    await a.resize(390);
    assert.equal(document.activeElement?.className, "mobile-menu");
  });
});
