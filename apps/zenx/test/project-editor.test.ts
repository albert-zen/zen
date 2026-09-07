import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { ProjectEditor } from "../src/renderer/src/ProjectEditor.js";
const { act, createElement } = React;
const bootstrap = new JSDOM("<html><body></body></html>");
Object.assign(globalThis, {
  React,
  window: bootstrap.window,
  document: bootstrap.window.document,
});
const { createRoot } = await import("react-dom/client");

async function mount(
  overrides: Partial<React.ComponentProps<typeof ProjectEditor>> = {},
) {
  const dom = new JSDOM(
    '<button id="trigger">Edit project</button><div id="root"></div>',
    { url: "http://localhost" },
  );
  const keys = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previous = Object.fromEntries(
    keys.map((key) => [key, (globalThis as any)[key]]),
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const trigger = document.getElementById("trigger")!;
  trigger.focus();
  const calls: Array<unknown> = [];
  const root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root.render(
      createElement(ProjectEditor, {
        workspace: "/work",
        name: "work",
        isDefault: false,
        hostBusy: false,
        onSave: async (...args) => {
          calls.push(args);
        },
        onRemove: async () => {
          calls.push("remove");
        },
        onClose: () => calls.push("close"),
        ...overrides,
      }),
    ),
  );
  const button = (label: string) => {
    const found = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((node) => node.textContent === label);
    assert.ok(found, label);
    return found;
  };
  const input = document.querySelector("input")!;
  const changeName = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  return {
    dom,
    calls,
    trigger,
    input,
    button,
    changeName,
    async cleanup() {
      await act(async () => root.unmount());
      assert.equal(document.activeElement, trigger);
      Object.assign(globalThis, previous);
      dom.window.close();
    },
  };
}

test("project editor saves only on submit and Cancel preserves the project", async () => {
  const view = await mount();
  try {
    assert.equal(document.activeElement, view.input);
    await view.changeName("Renamed project");
    assert.deepEqual(view.calls, []);
    await act(async () => view.button("Cancel").click());
    assert.deepEqual(view.calls, ["close"]);
    await act(async () => view.button("Save").click());
    assert.deepEqual(view.calls, [
      "close",
      ["Renamed project", "/work"],
      "close",
    ]);
  } finally {
    await view.cleanup();
  }
});

test("project editor keeps failed edits available and traps keyboard focus", async () => {
  const view = await mount({
    onSave: async () => {
      throw new Error("Disk write failed");
    },
  });
  try {
    await act(async () => view.button("Save").click());
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Disk write failed/,
    );
    assert.equal(view.button("Save").disabled, false);
    assert.deepEqual(view.calls, []);
    view.button("Save").focus();
    await act(async () =>
      view.button("Save").dispatchEvent(
        new view.dom.window.KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Close project editor",
    );
    await act(async () =>
      view.input.dispatchEvent(
        new view.dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.deepEqual(view.calls, ["close"]);
  } finally {
    await view.cleanup();
  }
});
