import assert from "node:assert/strict";
import test from "node:test";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";

import { InlineMarkdownEditor } from "../src/renderer/src/InlineMarkdownEditor.js";

const source =
  "## 😀 Title\r\n\r\nA [link](https://example.test), [ref][id], and **bold** with *style*.\r\n\r\n- one\r\n- two\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n```js\r\nconst x = 1;\r\n```\r\n\r\n[id]: https://reference.test\r\n";

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
    assert.match(visible(), /- one/);
    assert.match(visible(), /\| A \| B \|/);
    assert.match(visible(), /const x = 1/);
    assert.doesNotMatch(visible(), /reference\.test/);

    const normalized = source.replaceAll("\r\n", "\n");
    const linkStart = normalized.indexOf("[link]");
    await act(async () => view.focus());
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
    assert.match(latest, /\r\n\r\n- one/);
    assert.match(latest, /\| A \| B \|\r\n\| - \| - \|/);
    assert.match(latest, /```js\r\nconst x = 1;\r\n```/);
    assert.match(latest, /\[id\]: https:\/\/reference\.test/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
