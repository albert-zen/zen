import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import { SourceEditor } from "../src/renderer/src/SourceEditor.js";

test("source editor highlights safely, preserves raw source and clears undo after disk replacement", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    React,
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
  const original =
    '\ufeffconst value: string = "<img src=x onerror=alert(1)>";\r\n// Mixed lines\nexport default value;\r';
  let latest = original;
  let external!: (text: string) => void;
  function Harness() {
    const [text, setText] = useState(original);
    external = setText;
    return React.createElement(SourceEditor, {
      path: "app.ts",
      text,
      onChange: (value: string) => {
        latest = value;
        setText(value);
      },
    });
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const view = EditorView.findFromDOM(
      document.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    assert.ok(
      [...document.querySelectorAll(".cm-line span")].some(
        (span) => span.textContent === "const",
      ),
    );
    assert.equal(document.querySelector("img"), null);
    assert.ok(document.querySelector(".cm-lineNumbers"));
    await act(async () =>
      view.dispatch({
        changes: { from: 1, insert: "// Header\n" },
        userEvent: "input.type",
      }),
    );
    assert.equal(latest, "\ufeff// Header\r\n" + original.slice(1));
    await act(async () => {
      assert.equal(undo(view), true);
    });
    assert.equal(latest, original);
    await act(async () => {
      assert.equal(redo(view), true);
    });
    assert.equal(latest, "\ufeff// Header\r\n" + original.slice(1));
    await act(async () => external("const disk = true;\r\n"));
    await act(async () => {
      assert.equal(undo(view), false);
    });
    await act(async () => {
      assert.equal(redo(view), false);
    });
    await act(async () =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "// More\n" },
      }),
    );
    assert.equal(latest, "const disk = true;\r\n// More\r\n");
    await act(async () => external("const data = true;\n".repeat(6000)));
    assert.match(
      document.querySelector(".workspace-file-note")!.textContent!,
      /highlighting is disabled/,
    );
    assert.equal(
      document.querySelectorAll(".cm-line span").length,
      0,
      "large documents disable parsing after edits too",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("source preview is read-only and does not execute HTML source", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        React.createElement(SourceEditor, {
          path: "index.html",
          text: '<script>alert("bad")</script>',
          readOnly: true,
        }),
      ),
    );
    const view = EditorView.findFromDOM(
      document.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    assert.equal(view.state.readOnly, true);
    assert.equal(view.contentDOM.getAttribute("contenteditable"), "false");
    assert.equal(document.querySelector("script"), null);
    assert.match(view.contentDOM.textContent!, /<script>/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Go files highlight keywords and strings while remaining editable", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let latest = "";
  try {
    await act(async () =>
      root.render(
        React.createElement(SourceEditor, {
          path: "cmd/demo/main.go",
          text: 'package main\r\n\r\nimport "fmt"\r\n\r\nfunc main() { fmt.Println("Hello") }\r\n',
          onChange: (value: string) => {
            latest = value;
          },
        }),
      ),
    );
    const tokens = [...document.querySelectorAll(".cm-line span")].map(
      (span) => span.textContent,
    );
    assert.ok(
      tokens.includes("package"),
      "Go package keyword has syntax styling",
    );
    assert.ok(
      tokens.includes("func"),
      "Go function keyword has syntax styling",
    );
    assert.ok(tokens.includes('"Hello"'), "Go strings have syntax styling");
    const view = EditorView.findFromDOM(
      document.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    await act(async () =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "// End\n" },
      }),
    );
    assert.ok(
      latest.endsWith("// End\r\n"),
      "Go editing preserves the original line endings",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
