import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { undo } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import { getSearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { documentText } from "../src/renderer/src/editor-raw-source.js";
import { InlineMarkdownEditor } from "../src/renderer/src/InlineMarkdownEditor.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { SourceEditor } from "../src/renderer/src/SourceEditor.js";

async function mount() {
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
  return {
    dom,
    root,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

function key(
  target: HTMLElement,
  key: string,
  options: KeyboardEventInit = {},
) {
  const event = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

test("source Find opens locally with Ctrl+F without changing the draft or selection", async () => {
  const harness = await mount();
  let changes = 0;
  try {
    await act(async () =>
      harness.root.render(
        React.createElement(SourceEditor, {
          path: "notes.txt",
          text: "\ufefffirst\r\nfind me\nfirst\r",
          onChange: () => changes++,
        }),
      ),
    );
    const view = EditorView.findFromDOM(
      document.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    await act(async () => view.dispatch({ selection: { anchor: 3 } }));
    const selection = view.state.selection;
    let event!: KeyboardEvent;
    await act(async () => {
      event = key(view.contentDOM, "F", { ctrlKey: true, shiftKey: true });
    });
    assert.equal(
      event.defaultPrevented,
      false,
      "Find must not capture workspace-search shortcuts",
    );
    assert.equal(document.querySelector(".cm-file-search-input"), null);
    await act(async () => {
      event = key(view.contentDOM, "f", { ctrlKey: true, isComposing: true });
    });
    assert.equal(
      document.querySelector(".cm-file-search-input"),
      null,
      "Find must not interrupt editor IME composition",
    );
    await act(async () => {
      event = key(view.contentDOM, "f", { ctrlKey: true });
    });
    assert.ok(
      document.querySelector(".cm-file-search-input"),
      "Ctrl+F must open an in-file search input",
    );
    assert.equal(event.defaultPrevented, true);
    assert.equal(view.state.selection.eq(selection), true);
    assert.equal(changes, 0);
  } finally {
    await harness.close();
  }
});

function searchInput() {
  return document.querySelector<HTMLInputElement>(".cm-file-search-input")!;
}
function resultCount() {
  return document.querySelector(".cm-file-search-count")!.textContent;
}
async function query(value: string) {
  await act(async () => {
    const input = searchInput();
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function clickMatch(name: "next" | "previous" | "close") {
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        `.cm-file-search-button[name="${name}"]`,
      )!
      .click(),
  );
}

type FindEditorProps = {
  path: string;
  text: string;
  onChange(text: string): void;
  findRequest?: number;
};
const editorCases: ReadonlyArray<
  readonly [string, React.ComponentType<FindEditorProps>, string]
> = [
  ["source", SourceEditor, "notes.txt"],
  ["Markdown", InlineMarkdownEditor, "notes.md"],
];

for (const [name, Editor, path] of editorCases) {
  test(`${name} Find highlights literal matches, navigates both directions and preserves raw draft and undo`, async () => {
    const harness = await mount();
    const original = "\ufefffirst\r\n中文 😀 a.* \\n\nFIRST\r中文 😀 a.* \\n";
    let changes = 0;
    try {
      await act(async () =>
        harness.root.render(
          React.createElement(Editor, {
            path,
            text: original,
            onChange: () => changes++,
          }),
        ),
      );
      const view = EditorView.findFromDOM(
        document.querySelector<HTMLElement>(".cm-editor")!,
      )!;
      await act(async () =>
        view.dispatch({
          changes: { from: view.state.doc.length, insert: "!" },
          userEvent: "input.type",
        }),
      );
      const draft = documentText(view.state);
      assert.equal(changes, 1);
      await act(async () => {
        key(view.contentDOM, "f", { metaKey: true });
      });
      assert.equal(document.activeElement, searchInput());
      await query("first");
      assert.equal(resultCount(), "0 of 2");
      assert.equal(document.querySelectorAll(".cm-searchMatch").length, 2);
      await act(async () => {
        key(searchInput(), "Enter");
      });
      assert.equal(resultCount(), "1 of 2");
      assert.equal(
        view.state.sliceDoc(
          view.state.selection.main.from,
          view.state.selection.main.to,
        ),
        "first",
      );
      assert.equal(
        document.querySelectorAll(".cm-searchMatch-selected").length,
        1,
      );
      await clickMatch("next");
      assert.equal(resultCount(), "2 of 2");
      await clickMatch("next");
      assert.equal(resultCount(), "1 of 2");
      await act(async () => {
        key(searchInput(), "Enter", { shiftKey: true });
      });
      assert.equal(resultCount(), "2 of 2");
      await clickMatch("previous");
      assert.equal(resultCount(), "1 of 2");
      await query("a.* \\n");
      assert.equal(
        document.querySelectorAll(".cm-searchMatch").length,
        2,
        "regex and backslash sequences are literal",
      );
      await query("中文 😀");
      assert.equal(document.querySelectorAll(".cm-searchMatch").length, 2);
      await query("absent");
      assert.equal(resultCount(), "No matches");
      assert.equal(
        document.querySelector<HTMLButtonElement>('[name="next"]')!.disabled,
        true,
      );
      const selection = view.state.selection;
      await act(async () => {
        key(searchInput(), "Enter");
      });
      assert.equal(view.state.selection.eq(selection), true);
      await query("");
      assert.equal(resultCount(), "");
      assert.equal(document.querySelector(".cm-searchMatch"), null);
      let escaped = 0;
      document.body.addEventListener("keydown", () => escaped++);
      await act(async () => {
        key(searchInput(), "Escape");
      });
      assert.equal(document.querySelector(".cm-file-search"), null);
      assert.equal(document.activeElement, view.contentDOM);
      assert.equal(escaped, 0, "Escape must not also dismiss the workspace");
      assert.equal(view.state.selection.eq(selection), true);
      assert.equal(documentText(view.state), draft);
      assert.equal(
        changes,
        1,
        "Find must not mark a draft dirty or schedule saves",
      );
      await act(async () => {
        assert.equal(undo(view), true);
      });
      assert.equal(
        documentText(view.state),
        original,
        "search must preserve BOM, mixed EOLs and undo",
      );
    } finally {
      await harness.close();
    }
  });

  test(`${name} toolbar Find requests, IME and language changes keep the same editor`, async () => {
    const harness = await mount();
    let changes = 0;
    let request = 5;
    const props = {
      path,
      text: "中文\n中文\nEnglish",
      onChange: () => changes++,
    };
    const render = () =>
      harness.root.render(
        React.createElement(Editor, { ...props, findRequest: request }),
      );
    try {
      await act(async () => render());
      const editor = document.querySelector<HTMLElement>(".cm-editor")!;
      const view = EditorView.findFromDOM(editor)!;
      assert.equal(
        document.querySelector(".cm-file-search"),
        null,
        "a remount with old request does not reopen Find",
      );
      await act(async () => {
        request++;
        render();
      });
      assert.ok(searchInput());
      await query("English");
      const input = searchInput();
      const selection = view.state.selection;
      await act(async () => {
        input.dispatchEvent(
          new window.CompositionEvent("compositionstart", { bubbles: true }),
        );
        input.value = "中文";
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        key(input, "Enter", { isComposing: true });
        key(input, "Escape", { keyCode: 229 });
      });
      assert.equal(
        getSearchQuery(view.state).search,
        "English",
        "uncommitted IME text must not change search",
      );
      assert.equal(view.state.selection.eq(selection), true);
      assert.equal(searchInput(), input);
      await act(async () =>
        input.dispatchEvent(
          new window.CompositionEvent("compositionend", { bubbles: true }),
        ),
      );
      assert.equal(getSearchQuery(view.state).search, "中文");
      assert.equal(resultCount(), "0 of 2");
      await act(async () => i18n.changeLanguage("zh-CN"));
      assert.equal(searchInput(), input);
      assert.equal(input.getAttribute("aria-label"), "在文件中查找");
      assert.equal(resultCount(), "0 / 2");
      await act(async () => {
        request++;
        render();
      });
      assert.equal(document.querySelector(".cm-editor"), editor);
      assert.equal(searchInput(), input);
      await clickMatch("close");
      assert.equal(document.activeElement, view.contentDOM);
      assert.equal(changes, 0);
    } finally {
      await harness.close();
      await i18n.changeLanguage("en");
    }
  });
}

test("Markdown Find reveals hidden source and restores live preview without an edit", async () => {
  const harness = await mount();
  const source =
    "# Heading\r\n\nA [link](https://hidden.example/find-me) and **bold**.\n";
  let changes = 0;
  try {
    await act(async () =>
      harness.root.render(
        React.createElement(InlineMarkdownEditor, {
          path: "readme.md",
          text: source,
          onChange: () => changes++,
        }),
      ),
    );
    const view = EditorView.findFromDOM(
      document.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    await act(async () => {
      forceParsing(view, view.state.doc.length);
    });
    assert.equal(
      view.contentDOM.textContent!.includes("https://hidden.example"),
      false,
    );
    await act(async () => {
      key(view.contentDOM, "f", { ctrlKey: true });
    });
    assert.equal(
      view.contentDOM.textContent!.includes("https://hidden.example"),
      true,
    );
    await query("hidden.example");
    assert.equal(
      document.querySelector(".cm-searchMatch")?.textContent,
      "hidden.example",
    );
    await clickMatch("close");
    assert.equal(
      view.contentDOM.textContent!.includes("https://hidden.example"),
      false,
    );
    assert.equal(documentText(view.state), source);
    assert.equal(changes, 0);
  } finally {
    await harness.close();
  }
});

test("read-only Find preserves editor identity, selection and query across disk replacement", async () => {
  const harness = await mount();
  try {
    await act(async () =>
      harness.root.render(
        React.createElement(SourceEditor, {
          path: "disk.txt",
          text: "aaaa 中文",
          readOnly: true,
        }),
      ),
    );
    const editor = document.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    await act(async () => {
      key(view.contentDOM, "f", { ctrlKey: true });
    });
    await query("aa");
    assert.equal(
      resultCount(),
      "0 of 2",
      "count matches the non-overlapping highlights",
    );
    await clickMatch("previous");
    assert.equal(resultCount(), "2 of 2");
    assert.equal(view.state.selection.main.from, 2);
    await clickMatch("next");
    assert.equal(resultCount(), "1 of 2");
    await act(async () =>
      harness.root.render(
        React.createElement(SourceEditor, {
          path: "disk.txt",
          text: "aa",
          readOnly: true,
        }),
      ),
    );
    assert.equal(document.querySelector(".cm-editor"), editor);
    assert.equal(getSearchQuery(view.state).search, "aa");
    assert.match(resultCount()!, /of 1$/);
    await clickMatch("close");
    assert.equal(view.state.readOnly, true);
    assert.equal(document.activeElement, view.contentDOM);
    assert.equal(documentText(view.state), "aa");
  } finally {
    await harness.close();
  }
});
