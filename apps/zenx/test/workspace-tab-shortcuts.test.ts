import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installWorkspaceTabShortcuts } from "../src/renderer/src/workspace-tab-shortcuts.js";

function setup(count = 3, platform: "darwin" | "win32" = "darwin") {
  const dom = new JSDOM(
    `<main><textarea id="composer"></textarea></main><aside><div role="tablist">${Array.from({ length: count }, (_, i) => `<span class="workspace-content-tab"><button role="tab" id="tab-${i}">Tab ${i + 1}</button></span>`).join("")}</div></aside>`,
    { pretendToBeVisual: true },
  );
  const { document } = dom.window;
  const rail = document.querySelector<HTMLElement>('[role="tablist"]')!;
  const selected: string[] = [];
  rail.addEventListener("click", (event) =>
    selected.push((event.target as HTMLElement).id),
  );
  const dispose = installWorkspaceTabShortcuts(rail, platform);
  const key = (type: string, values: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      altKey: true,
      ...values,
    });
    document.getElementById("composer")!.dispatchEvent(event);
    return event;
  };
  const hints = () =>
    [...rail.querySelectorAll("[data-workspace-shortcut-key]")].map((x) => [
      x.id,
      x.getAttribute("data-workspace-shortcut-key"),
    ]);
  return { dom, document, rail, selected, dispose, key, hints };
}

test("held chord hints and Option digit select the real tab from sibling main composer", () => {
  const e = setup();
  assert.deepEqual(e.hints(), []);
  e.key("keydown", { key: "Meta", altKey: false });
  assert.deepEqual(e.hints(), []);
  e.key("keydown", { key: "Alt" });
  assert.equal(e.hints().length, 3);
  const event = e.key("keydown", { key: "™", code: "Digit2" });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(e.selected, ["tab-1"]);
  assert.equal(e.document.activeElement?.id, "tab-1");
  e.key("keyup", { key: "Alt", altKey: false });
  assert.deepEqual(e.hints(), []);
  e.key("keydown", { key: "Alt", metaKey: false });
  e.key("keydown", { key: "Meta" });
  assert.equal(e.hints().length, 3);
  e.key("keyup", { key: "Meta", metaKey: false });
  assert.deepEqual(e.hints(), []);
  e.dispose();
  e.dom.window.close();
});

test("indices follow reordered/removed tabs; only 1–9 and actual targets are consumed", async () => {
  const e = setup(10);
  e.key("keydown", { key: "Alt" });
  assert.equal(e.hints().length, 9);
  const last = e.rail.lastElementChild!;
  e.rail.prepend(last);
  await Promise.resolve();
  assert.deepEqual(e.hints()[0], ["tab-9", "1"]);
  e.key("keydown", { key: "¡", code: "Digit1" });
  assert.deepEqual(e.selected, ["tab-9"]);
  assert.equal(
    e.key("keydown", { key: "0", code: "Digit0" }).defaultPrevented,
    false,
  );
  for (const child of [...e.rail.children].slice(1)) child.remove();
  await Promise.resolve();
  assert.equal(e.key("keydown", { code: "Digit2" }).defaultPrevented, false);
  assert.equal(e.hints().length, 1);
  e.dispose();
  assert.deepEqual(e.hints(), []);
  e.dom.window.close();
});

test("IME, modal/menu, repeat, consumed events and wrong modifiers cannot select", async () => {
  const e = setup();
  for (const values of [
    { isComposing: true },
    { repeat: true },
    { ctrlKey: true },
    { shiftKey: true },
    { metaKey: false },
    { altKey: false },
  ]) {
    assert.equal(
      e.key("keydown", { key: "¡", code: "Digit1", ...values })
        .defaultPrevented,
      false,
    );
  }
  const consumed = new e.dom.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    metaKey: true,
    altKey: true,
    code: "Digit1",
  });
  consumed.preventDefault();
  e.document.getElementById("composer")!.dispatchEvent(consumed);
  for (const role of ["dialog", "menu"]) {
    e.key("keydown", { key: "Alt" });
    const block = e.document.createElement("div");
    block.setAttribute("role", role);
    e.document.body.append(block);
    await Promise.resolve();
    assert.deepEqual(e.hints(), []);
    assert.equal(e.key("keydown", { code: "Digit1" }).defaultPrevented, false);
    block.remove();
  }
  assert.deepEqual(e.selected, []);
  e.key("keydown", { key: "Alt" });
  e.dom.window.dispatchEvent(new e.dom.window.Event("blur"));
  assert.deepEqual(e.hints(), []);
  e.key("keydown", { key: "Meta" });
  e.document.dispatchEvent(
    new e.dom.window.CompositionEvent("compositionstart"),
  );
  assert.deepEqual(e.hints(), []);
  e.dispose();
  assert.equal(e.key("keydown", { code: "Digit1" }).defaultPrevented, false);
  e.dom.window.close();
});

test("production panel installs only for fullscreen Mac/Windows, reuses primary selection and preserves draft", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AuxiliaryPanel } =
    await import("../src/renderer/src/auxiliary-panel.js");
  const { emptySidebarState } = await import("../src/thread-sidebar-state.js");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window as any).zenx = {
    platform: "darwin",
    workspaceBrowser: { command: async () => [], onChanged: () => () => {} },
  };
  const root = createRoot(document.getElementById("root")!);
  const selected: string[] = [];
  let primarySelections = 0;
  const render = async (fullscreen: boolean, open = true) => {
    await React.act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "section",
            { id: "primary" },
            React.createElement("textarea", {
              id: "draft",
              defaultValue: "Keep my unsent draft",
            }),
          ),
          React.createElement(AuxiliaryPanel, {
            threadId: "synthetic",
            title: "Workspace",
            open,
            onOpenChange: () => {},
            snapshot: null,
            presentationState: {
              ...emptySidebarState({ kind: "thread", id: "synthetic" }),
              open,
              fullscreen,
              tabs: [],
            },
            primaryConversation: {
              title: "Main",
              contentId: "primary",
              onSelect: () => {
                primarySelections++;
              },
            },
            customTabs: [
              {
                id: "note",
                title: "Note",
                icon: "file",
                render: () => React.createElement("p", null, "Note"),
              },
            ],
            openedTabs: ["custom:note"],
            selectedTab: "custom:note",
            onSelectTab: (id) => selected.push(id),
          }),
        ),
      );
    });
  };
  const press = async (code: string, key = "¡", windows = false) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      metaKey: !windows,
      ctrlKey: windows,
      altKey: true,
      code,
      key,
    });
    await React.act(async () => {
      document.getElementById("draft")!.dispatchEvent(event);
    });
    return event;
  };
  await render(false);
  assert.equal((await press("Digit1")).defaultPrevented, false);
  await render(true);
  const draft = document.getElementById("draft");
  assert.equal(
    document
      .getElementById("aux-tab-primary-conversation")
      ?.getAttribute("aria-keyshortcuts"),
    "Meta+Alt+1",
  );
  await press("Digit1");
  assert.equal(primarySelections, 1);
  await press("Digit2");
  assert.deepEqual(selected, ["custom:note"]);
  assert.equal(document.getElementById("draft"), draft);
  assert.equal((draft as HTMLTextAreaElement).value, "Keep my unsent draft");
  await render(false);
  assert.equal((await press("Digit1")).defaultPrevented, false);
  await render(true, false);
  assert.equal((await press("Digit1")).defaultPrevented, false);
  await render(false);
  (dom.window as any).zenx.platform = "linux";
  await render(true);
  assert.equal((await press("Digit1")).defaultPrevented, false);
  await render(false);
  (dom.window as any).zenx.platform = "win32";
  await render(true);
  assert.equal(
    document
      .getElementById("aux-tab-primary-conversation")
      ?.getAttribute("aria-keyshortcuts"),
    "Control+Alt+1",
  );
  assert.equal((await press("Digit1", "1", true)).defaultPrevented, true);
  assert.equal(primarySelections, 2);
  await React.act(async () => root.unmount());
  dom.window.close();
});

test("Windows Ctrl+Alt digits show Windows hints but never consume AltGraph or keybinding capture", () => {
  const e = setup(3, "win32");
  const chord = { metaKey: false, ctrlKey: true, altKey: true };
  e.key("keydown", { ...chord, key: "Alt" });
  assert.equal(
    e.document
      .getElementById("tab-0")
      ?.getAttribute("data-workspace-shortcut-label"),
    "Ctrl+Alt+1",
  );
  assert.equal(
    e.key("keydown", { ...chord, key: "1", code: "Digit1" }).defaultPrevented,
    true,
  );
  const altGraph = new e.dom.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...chord,
    key: "@",
    code: "Digit2",
  });
  Object.defineProperty(altGraph, "getModifierState", {
    value: (key: string) => key === "AltGraph",
  });
  e.document.getElementById("composer")!.dispatchEvent(altGraph);
  assert.equal(altGraph.defaultPrevented, false);
  assert.deepEqual(e.hints(), []);
  const input = e.document.getElementById("composer")!;
  input.setAttribute("data-keybinding-capture", "");
  assert.equal(
    e.key("keydown", { ...chord, code: "Digit2" }).defaultPrevented,
    false,
  );
  input.removeAttribute("data-keybinding-capture");
  e.key("keydown", { ...chord, key: "Control" });
  e.key("keyup", { ...chord, key: "Control", ctrlKey: false });
  assert.deepEqual(e.hints(), []);
  assert.deepEqual(e.selected, ["tab-0"]);
  e.dispose();
  e.dom.window.close();
});

test("workspace hint styling temporarily suppresses, but never deletes, left hint authority", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("../src/renderer/src/auxiliary-tab-reorder.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /:root:has\(\s*\.auxiliary-panel\[data-open="true"\]\[data-expanded="true"\]/,
  );
  assert.match(
    css,
    /#primary-sidebar[\s\S]*\[data-shortcut-key\]::after\s*\{\s*visibility: hidden;/,
  );
  const e = setup();
  const left = e.document.createElement("button");
  left.setAttribute("data-shortcut-key", "1");
  e.document.body.append(left);
  e.key("keydown", { key: "Alt" });
  e.key("keyup", { key: "Alt", altKey: false });
  assert.deepEqual(e.hints(), []);
  assert.equal(left.getAttribute("data-shortcut-key"), "1");
  e.dispose();
  e.dom.window.close();
});
