import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ThreadTitleEditor } from "../src/renderer/src/thread-title-editor.js";

test("editor starts from the exact Thread name, not its disclosure title", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const wakeup = "[ZenX trigger wakeup]\nTrigger ID: trigger-a";
  try {
    await act(async () =>
      root.render(
        React.createElement(ThreadTitleEditor, {
          editable: true,
          title: "Room wakeup · 63c6c01d",
          editTitle: wakeup,
          onRename: async () => undefined,
        }),
      ),
    );
    assert.equal(
      document.querySelector<HTMLElement>(".thread-title-line strong")
        ?.textContent,
      "Room wakeup · 63c6c01d",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".thread-title-rename")!
        .click(),
    );
    // A single-line input strips newlines; the stored title normalizes whitespace.
    assert.equal(
      document.querySelector<HTMLInputElement>("input")!.value,
      wakeup.replace(/[\r\n]/gu, ""),
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("working Thread title editor handles IME, Escape, late saves, and focus ownership", async () => {
  const dom = new JSDOM(
    '<div id="root"></div><button id="outside">Outside</button>',
    { url: "http://localhost" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  let resolve!: () => void;
  const calls: string[] = [];
  const props = (el: any) =>
    el[Object.keys(el).find((key) => key.startsWith("__reactProps"))!];
  const open = async () =>
    act(async () =>
      document
        .querySelector<HTMLButtonElement>(".thread-title-rename")!
        .click(),
    );
  const input = () => document.querySelector<HTMLInputElement>("input")!;
  const key = async (name: string) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input().dispatchEvent(event));
    return event;
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(ThreadTitleEditor, {
          editable: true,
          title: "Working Thread",
          onRename: async (title) => {
            calls.push(title);
            await new Promise<void>((done) => {
              resolve = done;
            });
          },
        }),
      ),
    );
    await open();
    await act(async () => props(input().form).onCompositionStart());
    assert.equal((await key("Enter")).defaultPrevented, true);
    await key("Escape");
    assert.equal(document.querySelector("input"), null);
    assert.equal(
      document.activeElement,
      document.querySelector(".thread-title-rename"),
    );
    await open();
    assert.equal((await key("Enter")).defaultPrevented, false);
    await act(async () =>
      props(input()).onChange({ target: { value: "First draft" } }),
    );
    await act(async () => {
      input().form!.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(calls, ["First draft"]);
    await key("Escape");
    await open();
    const newer = input();
    await act(async () => resolve());
    assert.equal(input(), newer, "late reply leaves newer editor mounted");
    await act(async () =>
      props(newer).onChange({ target: { value: "Second draft" } }),
    );
    await act(async () => {
      newer.form!.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    const outside = document.getElementById("outside")!;
    outside.focus();
    await act(async () => resolve());
    assert.equal(
      document.activeElement,
      outside,
      "late save cannot steal external focus",
    );
    assert.deepEqual(calls, ["First draft", "Second draft"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

for (const outside of [false, true]) {
  test(`mouse title Save ${outside ? "respects later outside interaction" : "restores the disabled submit focus owner"}`, async () => {
    const dom = new JSDOM(
      '<div id="root"></div><div id="outside">Outside</div>',
      { url: "http://localhost", pretendToBeVisual: true },
    );
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const root = createRoot(document.getElementById("root")!);
    let resolve!: () => void;
    try {
      await act(async () =>
        root.render(
          React.createElement(ThreadTitleEditor, {
            editable: true,
            title: "Working Thread",
            onRename: () =>
              new Promise<void>((done) => {
                resolve = done;
              }),
          }),
        ),
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(".thread-title-rename")!
          .click(),
      );
      const save =
        document.querySelector<HTMLButtonElement>('[type="submit"]')!;
      save.focus();
      await act(async () => save.click());
      assert.equal(save.disabled, true);
      // Chromium drops a focused button to BODY when it becomes disabled.
      // JSDOM does not, so model exactly that browser transition here.
      document.body.tabIndex = -1;
      document.body.focus();
      assert.equal(document.activeElement?.tagName, "BODY");
      Object.defineProperty(document, "hasFocus", {
        value: () => true,
        configurable: true,
      });
      if (outside)
        document
          .getElementById("outside")!
          .dispatchEvent(
            new dom.window.Event("pointerdown", { bubbles: true }),
          );
      await act(async () => resolve());
      assert.equal(
        document.activeElement ===
          (outside
            ? document.body
            : document.querySelector(".thread-title-rename")),
        true,
        `unexpected focus: ${document.activeElement?.tagName}`,
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
