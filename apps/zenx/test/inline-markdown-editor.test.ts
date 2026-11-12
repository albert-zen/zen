import assert from "node:assert/strict";
import test from "node:test";
import { undo } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
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

test("live preview keeps one editable document and reveals only the selected syntax", async () => {
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
  function Harness() {
    const [text, setText] = useState(source);
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
    const editor = document.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor);
    assert.ok(view);
    // Parsing is time-budgeted. Under suite load the first render can stop
    // before the trailing reference definition; test the fully parsed view.
    await act(async () => {
      assert.ok(forceParsing(view, view.state.doc.length, 1000));
    });
    assert.equal(
      view.state.doc.lines,
      source.replace(/\r\n?|\n/gu, "\n").split("\n").length,
    );
    const visible = () =>
      document.querySelector<HTMLElement>(".cm-content")!.textContent!;

    assert.match(visible(), /😀 Title/);
    assert.doesNotMatch(visible(), /##/);
    assert.match(visible(), /A link, ref, and bold with style\./);
    assert.doesNotMatch(visible(), /https:\/\//);
    assert.doesNotMatch(visible(), /\*\*/);
    assert.ok(document.querySelector(".cm-live-heading-2"));
    assert.ok(document.querySelector(".cm-live-strong"));
    assert.ok(document.querySelector(".cm-live-emphasis"));
    assert.ok(document.querySelector(".cm-live-strikethrough"));
    assert.match(visible(), /• one/);
    assert.doesNotMatch(visible(), /> quote/);
    assert.match(visible(), /quote/);
    assert.doesNotMatch(visible(), /~~gone~~/);
    assert.match(visible(), /gone/);
    assert.match(visible(), /\| A \| B \|/);
    assert.match(visible(), /const x = 1/);
    assert.doesNotMatch(visible(), /reference\.test/);

    const normalized = source.replace(/\r\n?|\n/gu, "\n");
    const listStart = normalized.indexOf("- one");
    await act(async () => view.focus());
    await act(async () => view.dispatch({ selection: { anchor: listStart } }));
    assert.match(visible(), /- one/);
    assert.doesNotMatch(visible(), /> quote/);

    const quoteStart = normalized.indexOf("> quote");
    await act(async () => view.dispatch({ selection: { anchor: quoteStart } }));
    assert.match(visible(), /> quote/);
    assert.match(visible(), /• one/);

    const linkStart = normalized.indexOf("[link]");
    await act(async () => view.dispatch({ selection: { anchor: linkStart } }));
    await flush();
    assert.equal(view.state.selection.main.head, linkStart);
    assert.match(visible(), /\[link\]\(https:\/\/example\.test\)/);
    assert.doesNotMatch(visible(), /\*\*bold\*\*/);
    assert.doesNotMatch(visible(), /## 😀 Title/);

    const linkEnd = normalized.indexOf("),") + 1;
    await act(async () => view.dispatch({ selection: { anchor: linkEnd } }));
    assert.match(visible(), /\[link\]\(https:\/\/example\.test\)/);

    const boldStart = normalized.indexOf("**bold**");
    await act(async () =>
      view.dispatch({ selection: { anchor: boldStart + 3 } }),
    );
    assert.match(visible(), /\*\*bold\*\*/);
    assert.doesNotMatch(visible(), /https:\/\//);

    await act(async () =>
      view.dispatch({
        changes: { from: boldStart, to: boldStart + 1, insert: "" },
        selection: { anchor: boldStart },
      }),
    );
    assert.equal(latest, source.replace("**bold**", "*bold**"));
    assert.match(latest, /😀/);
    assert.match(latest, /\r\n- one\r\n- two\n/);
    assert.match(latest, /\| A \| B \|\r\n\| - \| - \|\n/);
    assert.match(latest, /```js\r\nconst x = 1;\n```/);
    assert.match(latest, /\[id\]:\n  https:\/\/reference\.test/);

    await act(async () => assert.equal(undo(view), true));
    assert.equal(latest, source);
    await act(async () =>
      view.dispatch({
        changes: { from: boldStart + 2, insert: "X" },
        selection: { anchor: boldStart + 3 },
        userEvent: "input.type",
      }),
    );
    assert.equal(latest, source.replace("**bold**", "**Xbold**"));
    await act(async () => assert.equal(undo(view), true));
    assert.equal(latest, source);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
