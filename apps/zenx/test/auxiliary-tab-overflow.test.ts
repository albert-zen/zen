import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";

test("automatic tab reveal preserves whole leading tabs, end slack, and keyboard focus without snapping manual scroll", async () => {
  const dom = new JSDOM(
    '<button id="outside">Outside</button><div id="root"></div>',
    { url: "https://zenx.local", pretendToBeVisual: true },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (window as any).zenx = {};
  const callbacks = new Set<() => void>();
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {
      callbacks.add(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      callbacks.delete(this.callback);
    }
  } as unknown as typeof ResizeObserver;
  let width = 300;
  const widths = [120, 120, 120, 188, 168];
  const proto = dom.window.HTMLElement.prototype;
  const originalRect = proto.getBoundingClientRect;
  const originalFocus = proto.focus;
  let focusOptions: FocusOptions | undefined;
  proto.focus = function (options) {
    focusOptions = options;
    originalFocus.call(this, options);
  };
  const rail = () => document.querySelector<HTMLElement>('[role="tablist"]')!;
  const ordered = () => [
    ...document.querySelectorAll<HTMLElement>(".workspace-content-tab"),
  ];
  const tabWidth = (item: HTMLElement) =>
    widths[Number(item.querySelector('[role="tab"]')!.id.slice(-1))]!;
  const naturalWidth = () =>
    4 +
    ordered().reduce((sum, item) => sum + tabWidth(item), 0) +
    Math.max(0, ordered().length - 1) * 4;
  let scroll = 0;
  Object.defineProperties(proto, {
    clientWidth: {
      configurable: true,
      get() {
        return this.getAttribute("role") === "tablist" ? width : 0;
      },
    },
    scrollWidth: {
      configurable: true,
      get() {
        return this.getAttribute("role") === "tablist"
          ? Math.max(
              width,
              naturalWidth() +
                parseFloat(
                  this.style.getPropertyValue("--workspace-tab-end-gap") || "0",
                ),
            )
          : 0;
      },
    },
    scrollLeft: {
      configurable: true,
      get() {
        return this.getAttribute("role") === "tablist" ? scroll : 0;
      },
      set(value) {
        if (this.getAttribute("role") === "tablist")
          scroll = Math.max(0, Math.min(value, this.scrollWidth - width));
      },
    },
  });
  proto.getBoundingClientRect = function () {
    if (this.getAttribute("role") === "tablist")
      return {
        x: 128,
        y: 0,
        left: 128,
        right: 128 + width,
        top: 0,
        bottom: 34,
        width,
        height: 34,
        toJSON() {},
      };
    if (this.classList.contains("workspace-content-tab")) {
      const items = ordered(),
        index = items.indexOf(this),
        left =
          130 -
          scroll +
          items
            .slice(0, index)
            .reduce((sum, item) => sum + tabWidth(item) + 4, 0),
        itemWidth = tabWidth(this);
      return {
        x: left,
        y: 2,
        left,
        right: left + itemWidth,
        top: 2,
        bottom: 32,
        width: itemWidth,
        height: 30,
        toJSON() {},
      };
    }
    return originalRect.call(this);
  };
  let select!: (id: string) => void;
  let reorder!: (ids: string[]) => void;
  const ids = widths.map((_, i) => `custom:tab-${i}`);
  function Harness() {
    const [selected, setSelected] = useState(ids[0]!);
    const [tabs, setTabs] = useState(ids);
    select = setSelected;
    reorder = setTabs;
    return React.createElement(AuxiliaryPanel, {
      threadId: "synthetic-overflow",
      title: "Synthetic",
      open: true,
      onOpenChange: () => {},
      snapshot: null,
      selectedTab: selected,
      onSelectTab: setSelected,
      openedTabs: tabs,
      onTabsChange: setTabs,
      customTabs: widths.map((_, i) => ({
        id: `tab-${i}`,
        title: `Synthetic ${i}`,
        icon: "file" as const,
        render: () => null,
      })),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const resize = () =>
    act(async () => {
      for (const callback of callbacks) callback();
    });
  const selectedBounds = () =>
    document
      .querySelector<HTMLElement>('[aria-selected="true"]')!
      .closest<HTMLElement>(".workspace-content-tab")!
      .getBoundingClientRect();
  const assertWhole = () => {
    const r = rail().getBoundingClientRect(),
      active = selectedBounds();
    assert.ok(
      active.left >= r.left + 1 && active.right <= r.right - 1,
      "active tab fully fits",
    );
    for (const item of ordered()) {
      const b = item.getBoundingClientRect();
      assert.ok(
        b.right <= r.left || b.left >= r.left,
        "no leading title fragment",
      );
    }
  };
  try {
    await act(async () => root.render(React.createElement(Harness)));
    document.getElementById("outside")!.focus();
    await act(async () => select(ids[3]!));
    assert.equal(
      scroll,
      372,
      "right reveal advances to the next whole tab boundary",
    );
    assertWhole();
    assert.equal(
      document.activeElement?.id,
      "outside",
      "external selection does not steal focus",
    );
    await act(async () => select(ids[4]!));
    assert.equal(
      scroll,
      564,
      "last reveal must not clamp inside the previous tab",
    );
    assert.equal(
      rail().style.getPropertyValue("--workspace-tab-end-gap"),
      "128px",
    );
    assertWhole();
    await act(async () => select(ids[0]!));
    assert.equal(scroll, 0);
    assertWhole();
    rail().scrollLeft = 125.5;
    await act(async () => rail().dispatchEvent(new dom.window.Event("scroll")));
    assert.equal(
      scroll,
      125.5,
      "manual scrolling can intentionally stop between tabs",
    );
    await act(async () => select(ids[1]!));
    assertWhole();
    const selected = document.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    )!;
    selected.focus();
    await act(async () =>
      selected.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "End",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(document.activeElement?.id, "aux-tab-" + ids[4]);
    assert.deepEqual(focusOptions, { preventScroll: true });
    assertWhole();
    width = 500;
    await resize();
    assertWhole();
    width = 260;
    await resize();
    assertWhole();
    widths[3] = 210;
    await resize();
    assertWhole();
    await act(async () => reorder([...ids].reverse()));
    assertWhole();
    assert.equal(
      scroll,
      0,
      "reordered active tab is revealed at its new position",
    );
    width = 100;
    await resize();
    assert.equal(
      selectedBounds().left,
      rail().getBoundingClientRect().left + 2,
      "oversized tab prioritizes its icon and leading label",
    );
    width = 1200;
    await resize();
    assert.equal(
      rail().style.getPropertyValue("--workspace-tab-end-gap"),
      "0px",
      "no trailing space when tabs fit",
    );
    assert.equal(scroll, 0);
  } finally {
    await act(async () => root.unmount());
    globalThis.ResizeObserver = previousObserver;
    dom.window.close();
  }
});

// The browser fixture verifies the actual layout; these guard the CSS intent
// against global reduced-motion duration rules reanimating an invisible spacer.
test("tab end spacer has no transition property and tall chooser alignment is safe", () => {
  const css = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const spacer = css.match(
    /\.auxiliary-heading \[role="tablist"\]::after\s*\{([^}]+)\}/,
  )?.[1];
  assert.ok(spacer);
  assert.match(spacer, /transition:\s*none\s*;/);
  const chooser = css.match(/\.workspace-new-tab\s*\{([^}]+)\}/)?.[1];
  assert.ok(chooser);
  assert.match(chooser, /align-items:\s*safe center\s*;/);
});
