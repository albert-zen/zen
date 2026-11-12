import assert from "node:assert/strict";
import test from "node:test";
import {
  cursorCharForward,
  deleteCharBackward,
  redo,
  undo,
} from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ComposerInput } from "../src/renderer/src/composer-input.js";
import {
  referenceText,
  type Reference,
} from "../src/renderer/src/composer-selector.js";
import {
  InlineComposerEditor,
  readableReferenceSelection,
  type PositionedReference,
} from "../src/renderer/src/InlineComposerEditor.js";

const file: PositionedReference = {
  kind: "file",
  name: "Very long file name ".repeat(12),
  cwd: "/project",
  path: "src/file.ts",
  position: 2,
};
const message: PositionedReference = {
  kind: "message",
  name: "quote",
  cwd: "/project",
  threadId: "thread",
  id: "item",
  excerpt: "exact\nexcerpt 😀",
  position: 4,
};

async function fixture(
  initialText: string,
  initialReferences: PositionedReference[],
  onKeyDown?: (event: KeyboardEvent) => void,
  initialUndo?: {
    value: string;
    references: readonly Reference[];
    selection?: { anchor: number; head: number };
  },
) {
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
  const root = createRoot(dom.window.document.getElementById("root")!);
  let currentText = initialText;
  let currentReferences: PositionedReference[] = initialReferences;
  let input: ComposerInput | null = null;
  let setDraft!: (value: {
    text: string;
    references: PositionedReference[];
  }) => void;
  let setLocked!: (value: boolean) => void;
  function Harness() {
    const [draft, set] = useState({
      text: initialText,
      references: initialReferences,
    });
    const [locked, setReadOnly] = useState(false);
    const editorRef = useRef<ComposerInput | null>(null);
    setDraft = set;
    setLocked = setReadOnly;
    input = editorRef.current;
    return React.createElement(InlineComposerEditor, {
      value: draft.text,
      references: draft.references,
      editorRef,
      initialUndo,
      readOnly: locked,
      onKeyDown,
      initialSelection: initialUndo
        ? { anchor: 3, head: 3 }
        : { anchor: 0, head: 0 },
      "aria-label": "Message",
      onChange(text: string, references: PositionedReference[]) {
        currentText = text;
        currentReferences = references;
        set({ text, references });
      },
    });
  }
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const view = EditorView.findFromDOM(
    dom.window.document.querySelector<HTMLElement>(".cm-editor")!,
  )!;
  return {
    dom,
    root,
    view,
    get text() {
      return currentText;
    },
    get references() {
      return currentReferences;
    },
    get input() {
      return input;
    },
    async external(text: string, references: PositionedReference[]) {
      currentText = text;
      currentReferences = references;
      await act(async () => setDraft({ text, references }));
    },
    async lock(value: boolean) {
      await act(async () => setLocked(value));
    },
    async close() {
      await act(async () => root.unmount());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      dom.window.close();
    },
  };
}

test("inline references retain order and UTF-16 positions through ordinary typing", async () => {
  const f = await fixture("ab\uFFFCc\uFFFCd", [file, message]);
  try {
    assert.equal(f.view.contentDOM.getAttribute("role"), "textbox");
    assert.equal(f.view.contentDOM.getAttribute("aria-multiline"), "true");
    assert.equal(
      f.dom.window.document.querySelectorAll(".inline-composer-reference")
        .length,
      2,
    );
    assert.equal(
      f.dom.window.document.querySelectorAll(".reference-token").length,
      2,
    );
    assert.match(
      f.dom.window.document
        .querySelector(".reference-token-details")!
        .getAttribute("title")!,
      /Very long/,
    );
    await act(async () =>
      f.view.dispatch({
        changes: { from: 1, insert: "😀" },
        userEvent: "input.type",
      }),
    );
    assert.equal(f.text, "a😀b\uFFFCc\uFFFCd");
    assert.deepEqual(
      f.references.map((reference) => reference.position),
      [4, 6],
    );
    assert.deepEqual(
      f.references.map((reference) => reference.kind),
      ["file", "message"],
    );
    assert.equal(f.input && "value" in f.input ? f.input.value : null, f.text);
  } finally {
    await f.close();
  }
});

test("atomic cursor and backspace remove a whole token; undo and redo restore its metadata", async () => {
  const f = await fixture("ab\uFFFCcd", [file]);
  try {
    await act(async () => f.view.dispatch({ selection: { anchor: 2 } }));
    await act(async () => assert.equal(cursorCharForward(f.view), true));
    assert.equal(f.view.state.selection.main.head, 3);
    await act(async () => assert.equal(deleteCharBackward(f.view), true));
    assert.equal(f.text, "abcd");
    assert.deepEqual(f.references, []);
    await act(async () => assert.equal(undo(f.view), true));
    assert.equal(f.text, "ab\uFFFCcd");
    assert.deepEqual(f.references, [file]);
    await act(async () => assert.equal(redo(f.view), true));
    assert.equal(f.text, "abcd");
    assert.deepEqual(f.references, []);
  } finally {
    await f.close();
  }
});

test("copy expands only genuine reference slots and external text cannot create chips", async () => {
  const f = await fixture("ab\uFFFCc\uFFFCd", [file, message]);
  try {
    assert.equal(
      readableReferenceSelection(f.view.state, 0, f.view.state.doc.length),
      "ab" + referenceText(file) + "c" + referenceText(message) + "d",
    );
    await act(async () =>
      f.view.dispatch({
        selection: { anchor: 0, head: f.view.state.doc.length },
      }),
    );
    const output = f.view.state.facet(EditorView.clipboardOutputFilter)[0]!;
    assert.equal(
      output(f.view.state.doc.toString(), f.view.state),
      "ab" + referenceText(file) + "c" + referenceText(message) + "d",
    );
    await act(async () =>
      f.view.dispatch({
        changes: { from: 0, insert: "\uFFFC" },
        userEvent: "input.paste",
      }),
    );
    assert.equal(f.text[0], "\uFFFC");
    assert.deepEqual(
      f.references.map((reference) => reference.position),
      [3, 5],
    );
    assert.equal(
      f.dom.window.document.querySelectorAll(".inline-composer-reference")
        .length,
      2,
    );
    assert.equal(readableReferenceSelection(f.view.state, 0, 1), "\uFFFC");
  } finally {
    await f.close();
  }
});

test("repeated identical targets remain distinct tokens with independent positions and undo", async () => {
  const f = await fixture("ab\uFFFCcd", [file]);
  try {
    await f.external("ab\uFFFCc\uFFFCd", [file, { ...file, position: 4 }]);
    assert.deepEqual(
      f.references.map((reference) => reference.position),
      [2, 4],
    );
    assert.equal(
      f.dom.window.document.querySelectorAll(".reference-token").length,
      2,
    );
    await act(async () => assert.equal(undo(f.view), true));
    assert.equal(f.text, "ab\uFFFCcd");
    assert.deepEqual(
      f.references.map((reference) => reference.position),
      [2],
    );
  } finally {
    await f.close();
  }
});

test("read-only locks token removal and composing Enter reaches caller unchanged", async () => {
  const seen: boolean[] = [];
  const f = await fixture("ab\uFFFCcd", [file], (event) => {
    if (event.key === "Enter") seen.push(event.isComposing);
  });
  try {
    await f.lock(true);
    const remove = f.dom.window.document.querySelector<HTMLButtonElement>(
      ".reference-token-remove",
    )!;
    assert.equal(remove.disabled, true);
    await act(async () => remove.click());
    assert.equal(f.text, "ab\uFFFCcd");
    const event = new f.dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      isComposing: true,
    });
    await act(async () => f.view.contentDOM.dispatchEvent(event));
    assert.deepEqual(seen, [true]);
  } finally {
    await f.close();
  }
});

test("controlled external insertion does not remount and remains undoable", async () => {
  const f = await fixture("ab\uFFFCcd", [file]);
  try {
    const sameView = f.view;
    await f.external("ab\uFFFCXcd", [file]);
    assert.equal(f.view, sameView);
    assert.equal(f.view.state.doc.toString(), "ab\uFFFCXcd");
    await act(async () => assert.equal(undo(f.view), true));
    assert.equal(f.text, "ab\uFFFCcd");
    assert.deepEqual(f.references, [file]);
  } finally {
    await f.close();
  }
});

test("first rich insertion inherits a pre-switch textarea snapshot as native undo", async () => {
  const f = await fixture("ab\uFFFCcd", [file], undefined, {
    value: "abcd",
    references: [],
    selection: { anchor: 2, head: 2 },
  });
  try {
    assert.equal(f.view.state.doc.toString(), "ab\uFFFCcd");
    assert.equal(f.view.state.selection.main.head, 3);
    await act(async () => assert.equal(undo(f.view), true));
    assert.equal(f.text, "abcd");
    assert.deepEqual(f.references, []);
    assert.equal(f.view.state.selection.main.head, 2);
    await act(async () => assert.equal(redo(f.view), true));
    assert.equal(f.text, "ab\uFFFCcd");
    assert.deepEqual(f.references, [file]);
  } finally {
    await f.close();
  }
});

function clipboardEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  type: string,
  values: Map<string, string>,
) {
  const event = new f.dom.window.Event(type, {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (kind: string) => values.get(kind) ?? "",
      setData: (kind: string, value: string) => values.set(kind, value),
      files: [],
    },
  });
  f.view.contentDOM.dispatchEvent(event);
  return event;
}

test("cut and paste capsule between independent main/side composers retains provenance both ways and undo", async () => {
  const clipboard = new Map<string, string>();
  const f = await fixture("a\uFFFCz", [{ ...message, position: 1 }]);
  try {
    await act(async () =>
      f.view.dispatch({ selection: { anchor: 1, head: 2 } }),
    );
    await act(async () => {
      assert.equal(clipboardEvent(f, "cut", clipboard).defaultPrevented, true);
    });
    assert.equal(f.text, "az");
    assert.deepEqual(f.references, []);
    assert.equal(clipboard.get("text/plain"), message.excerpt);
    assert.ok(
      [...clipboard.keys()].some((key) => key.startsWith("application/x-zenx")),
    );
    await act(async () => assert.equal(undo(f.view), true));
    assert.deepEqual(f.references, [{ ...message, position: 1 }]);
  } finally {
    await f.close();
  }
  for (const threadId of ["side-thread", "main-thread"]) {
    const dest = await fixture("keep \uFFFC draft", [{ ...file, position: 5 }]);
    try {
      await act(async () => dest.view.dispatch({ selection: { anchor: 7 } }));
      await act(async () => {
        assert.equal(
          clipboardEvent(dest, "paste", clipboard).defaultPrevented,
          true,
        );
      });
      assert.equal(dest.text, "keep \uFFFC \uFFFCdraft");
      assert.deepEqual(
        dest.references,
        [
          { ...file, position: 5 },
          { ...message, position: 7 },
        ],
        threadId,
      );
      await act(async () => assert.equal(undo(dest.view), true));
      assert.equal(dest.text, "keep \uFFFC draft");
      assert.deepEqual(dest.references, [{ ...file, position: 5 }]);
      await act(async () => assert.equal(redo(dest.view), true));
      assert.deepEqual(dest.references[1], { ...message, position: 7 });
      await act(async () =>
        dest.view.dispatch({ selection: { anchor: 7, head: 8 } }),
      );
      await act(async () => {
        clipboardEvent(dest, "cut", clipboard);
      });
      assert.equal(clipboard.get("text/plain"), message.excerpt);
    } finally {
      await dest.close();
    }
  }
});
