import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ThreadTitleEditor } from "../src/renderer/src/thread-title-editor.js";

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
