import assert from "node:assert/strict";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import test from "node:test";

import type {
  DirectoryBrowserSnapshot,
  DirectoryListing,
} from "../src/main/directory-browser.js";

interface PickerHarness {
  cancelCount(): number;
  container: HTMLElement;
  dom: JSDOM;
  listCalls: string[];
  root: Root;
  selected(): string[];
}

test("directory picker navigates folders and keyboard focus, selects, and restores focus", async () => {
  const listings = new Map<string, DirectoryListing>([
    ["/docs", listing("/docs", "/", ["Alpha", "Broken"])],
    ["/docs/Alpha", listing("/docs/Alpha", "/docs", ["Child"])],
    ["/docs/Alpha/Child", listing("/docs/Alpha/Child", "/docs/Alpha", [])],
  ]);
  const harness = await mountPicker(async (directory) => {
    const result = listings.get(directory);
    if (result === undefined) throw new Error("permission denied");
    return result;
  });
  try {
    await waitFor(() => findButton("Alpha"));
    assert.equal(harness.dom.window.document.activeElement, button("Alpha"));

    await pressKey(
      harness.dom,
      harness.container.querySelector(".directory-picker-list")!,
      "ArrowDown",
    );
    assert.equal(harness.dom.window.document.activeElement, button("Broken"));

    await click(button("Alpha"));
    await waitFor(() => findButton("Child"));
    assert.match(currentSelection(), /\/docs\/Alpha$/u);

    await click(button("Child"));
    await waitFor(() => currentSelection().endsWith("/docs/Alpha/Child"));
    await click(button("Alpha"));
    await waitFor(() => findButton("Child"));

    await pressKey(
      harness.dom,
      harness.container.querySelector(".directory-picker-list")!,
      "Backspace",
    );
    await waitFor(() => findButton("Broken"));

    const close = ariaButton("Close folder picker");
    close.focus();
    await pressKey(harness.dom, close, "Tab", { shiftKey: true });
    assert.equal(
      harness.dom.window.document.activeElement,
      button("Add folder"),
    );

    await click(button("Alpha"));
    await waitFor(() => currentSelection().endsWith("/docs/Alpha"));
    await click(button("Add folder"));
    assert.deepEqual(harness.selected(), ["/docs/Alpha"]);
    assert.deepEqual(harness.listCalls, [
      "/docs",
      "/docs/Alpha",
      "/docs/Alpha/Child",
      "/docs/Alpha",
      "/docs",
      "/docs/Alpha",
    ]);
  } finally {
    await unmountPicker(harness);
    assert.equal(
      harness.dom.window.document.activeElement?.getAttribute("data-before"),
      "picker",
    );
    harness.dom.window.close();
  }
});

test("directory picker exposes failure, retries, and cancels with Escape", async () => {
  let brokenAttempts = 0;
  const harness = await mountPicker(async (directory) => {
    if (directory === "/docs") return listing("/docs", "/", ["Broken"]);
    if (directory === "/docs/Broken") {
      brokenAttempts += 1;
      if (brokenAttempts === 1) throw new Error("permission denied");
      return listing("/docs/Broken", "/docs", []);
    }
    throw new Error("unexpected directory");
  });
  try {
    await waitFor(() => findButton("Broken"));
    await click(button("Broken"));
    await waitFor(() => harness.container.querySelector('[role="alert"]'));
    assert.match(harness.container.textContent ?? "", /permission denied/u);
    assert.equal(button("Add folder").hasAttribute("disabled"), true);

    await click(button("Try again"));
    await waitFor(() => currentSelection().endsWith("/docs/Broken"));
    assert.equal(harness.container.querySelector('[role="alert"]'), null);
    assert.equal(button("Add folder").hasAttribute("disabled"), false);

    await pressKey(
      harness.dom,
      harness.container.querySelector('[role="dialog"]')!,
      "Escape",
    );
    assert.equal(harness.cancelCount(), 1);
  } finally {
    await unmountPicker(harness);
    harness.dom.window.close();
  }
});

async function mountPicker(
  listDirectory: (directory: string) => Promise<DirectoryListing>,
): Promise<PickerHarness> {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
  });
  const previous = dom.window.document.createElement("button");
  previous.dataset.before = "picker";
  dom.window.document.body.append(previous);
  previous.focus();

  const snapshot: DirectoryBrowserSnapshot = {
    locations: [
      { label: "Home", path: "/home" },
      { label: "Documents", path: "/docs" },
      { label: "Root", path: "/" },
    ],
    initialPath: "/docs",
  };
  const listCalls: string[] = [];
  Object.assign(dom.window, {
    zenx: {
      settings: {
        getDirectoryBrowser: async () => snapshot,
        listDirectory: async (directory: string) => {
          listCalls.push(directory);
          return await listDirectory(directory);
        },
      },
    },
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const selected: string[] = [];
  let cancelCount = 0;
  const { DirectoryPicker } =
    await import("../src/renderer/src/DirectoryPicker.js");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(DirectoryPicker, {
        onCancel: () => {
          cancelCount += 1;
        },
        onSelect: (directory: string) => selected.push(directory),
      }),
    );
  });
  return {
    cancelCount: () => cancelCount,
    container,
    dom,
    listCalls,
    root,
    selected: () => selected,
  };
}

async function unmountPicker(harness: PickerHarness): Promise<void> {
  await act(async () => harness.root.unmount());
}

function listing(
  directory: string,
  parent: string | null,
  children: readonly string[],
): DirectoryListing {
  const segments = directory.split("/").filter(Boolean);
  return {
    path: directory,
    parent,
    breadcrumbs: [
      { label: "/", path: "/" },
      ...segments.map((segment, index) => ({
        label: segment,
        path: `/${segments.slice(0, index + 1).join("/")}`,
      })),
    ],
    directories: children.map((name) => ({
      name,
      path: `${directory}/${name}`,
    })),
  };
}

function button(label: string): HTMLButtonElement {
  const candidate = findButton(label);
  assert.ok(candidate, `Expected button ${label}`);
  return candidate;
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
}

function ariaButton(label: string): HTMLButtonElement {
  const candidate = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  assert.ok(candidate, `Expected aria button ${label}`);
  return candidate;
}

function currentSelection(): string {
  return (
    document.querySelector(".directory-picker-dialog footer strong")
      ?.textContent ?? ""
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function pressKey(
  dom: JSDOM,
  element: Element,
  key: string,
  options: KeyboardEventInit = {},
): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        ...options,
      }),
    );
  });
}

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("Timed out waiting for picker interaction state");
}
