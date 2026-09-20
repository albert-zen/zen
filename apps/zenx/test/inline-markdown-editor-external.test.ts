import assert from "node:assert/strict";
import test from "node:test";
import { undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";

import { InlineMarkdownEditor } from "../src/renderer/src/InlineMarkdownEditor.js";

const source =
  "## 😀 Title\r\n\nA [link](https://example.test), [ref][id], and **bold** with *style*.\n\r\n- one\r\n- two\n\n> quote\r\n\n~~gone~~\n\n| A | B |\r\n| - | - |\n| 1 | 2 |\r\n\n```js\r\nconst x = 1;\n```\r\n\n[id]:\n  https://reference.test\r\n";

const flush = async () =>
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

test("external disk replacement clears stale raw-source undo history", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    React,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window.Range.prototype as any).getClientRects = () => [];
  (dom.window.Range.prototype as any).getBoundingClientRect = () => ({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let latest = source;
  const currentText = (): string => latest;
  let externalSet!: (s: string) => void;
  function Harness() {
    const [text, setText] = useState(source);
    externalSet = setText;
    return React.createElement(InlineMarkdownEditor, {
      path: "README.md",
      text,
      onChange(value: string) {
        latest = value;
        setText(value);
      },
    });
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    const view = EditorView.findFromDOM(
      document.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    await act(async () =>
      view.dispatch({
        changes: { from: 0, insert: "X" },
        userEvent: "input.type",
      }),
    );
    await act(async () =>
      view.dispatch({
        changes: { from: 1, insert: "Y" },
        userEvent: "input.type",
      }),
    );
    await act(async () => undo(view));
    assert.equal(currentText(), source, "group undo exact");
    await act(async () => redo(view));
    assert.equal(currentText(), "XY" + source, "group redo exact");
    await act(async () => externalSet("# External\r\nBody\n😀\rEnd"));
    await act(async () => assert.equal(undo(view), false));
    await act(async () => assert.equal(redo(view), false));
    await act(async () =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "Z" },
        userEvent: "input.type",
      }),
    );
    assert.equal(currentText(), "# External\r\nBody\n😀\rEndZ");
    await act(async () => assert.equal(undo(view), true));
    assert.equal(currentText(), "# External\r\nBody\n😀\rEnd");
    assert.equal(
      currentText().replace(/\r\n?|\n/gu, "\n"),
      view.state.doc.toString(),
      "raw and visible text must agree",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
