import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  parseSkillDraft,
  withSkillDraft,
} from "../src/renderer/src/skill-draft.js";
import type { MessageQuoteReference } from "../src/renderer/src/composer-selector.js";
import {
  addMessageQuote,
  MessageQuoteCard,
  MessageSelectionActions,
  type MessageSelection,
  readMessageSelection,
} from "../src/renderer/src/message-quote.js";

function selectionFixture() {
  const dom = new JSDOM(`<main id="viewport">
    <article data-quote-thread-id="thread /中" data-quote-item-id="item-a">
      <div data-message-quote-body><p>  Exact <strong>chosen</strong> text\nwith spaces  </p><div class="markdown-code-header">ts<button>Copy</button></div><pre><code>const x = 1;</code></pre></div>
    </article>
    <article data-quote-thread-id="thread /中" data-quote-item-id="item-b"><div data-message-quote-body>Other message</div></article>
    <button>Outside action</button>
  </main>`);
  const document = dom.window.document;
  const viewport = document.querySelector<HTMLElement>("#viewport")!;
  const selection = dom.window.getSelection()!;
  const select = (
    start: Node,
    startOffset: number,
    end: Node,
    endOffset: number,
  ) => {
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  };
  return { dom, document, viewport, selection, select };
}

test("message selection preserves exact native text across inline formatting", () => {
  const view = selectionFixture();
  try {
    const paragraph = view.document.querySelector("p")!;
    view.select(
      paragraph.firstChild!,
      0,
      paragraph.lastChild!,
      paragraph.lastChild!.textContent!.length,
    );
    assert.deepEqual(readMessageSelection(view.viewport, view.selection), {
      threadId: "thread /中",
      id: "item-a",
      excerpt: view.selection.toString(),
    });
    assert.equal(
      readMessageSelection(view.viewport, view.selection)?.excerpt,
      "  Exact chosen text\nwith spaces  ",
    );
  } finally {
    view.dom.window.close();
  }
});

test("selection excludes cross-message ranges, controls and code headers but includes code", () => {
  const view = selectionFixture();
  try {
    const first = view.document.querySelector("p")!.firstChild!;
    const other = view.document.querySelector(
      '[data-quote-item-id="item-b"] [data-message-quote-body]',
    )!.firstChild!;
    view.select(first, 1, other, 3);
    assert.equal(readMessageSelection(view.viewport, view.selection), null);
    const header = view.document.querySelector(
      ".markdown-code-header",
    )!.firstChild!;
    view.select(header, 0, header, 2);
    assert.equal(readMessageSelection(view.viewport, view.selection), null);
    const code = view.document.querySelector("code")!.firstChild!;
    view.select(first, 0, code, 5);
    assert.equal(readMessageSelection(view.viewport, view.selection), null);
    view.select(code, 0, code, code.textContent!.length);
    assert.equal(
      readMessageSelection(view.viewport, view.selection)?.excerpt,
      "const x = 1;",
    );
    view.selection.collapse(code, 0);
    assert.equal(readMessageSelection(view.viewport, view.selection), null);
  } finally {
    view.dom.window.close();
  }
});

const reference: MessageQuoteReference = {
  kind: "message",
  name: "Source conversation",
  cwd: "/workspace",
  threadId: "thread-a",
  id: "item-a",
  excerpt: "Exact selected text",
};

test("adding a quote preserves existing text, skills and references and only deduplicates exact excerpts", () => {
  const skills = [
    { id: "11111111-1111-1111-1111-111111111111", name: "skill-name" },
  ];
  const references = [
    {
      kind: "file" as const,
      name: "file.ts",
      cwd: "/workspace",
      path: "src/file.ts",
    },
  ];
  const draft = withSkillDraft(
    "  My note\nwith exact spacing  ",
    skills,
    references,
  );
  const quoted = addMessageQuote(draft, reference);
  assert.deepEqual(parseSkillDraft(quoted), {
    text: "  My note\nwith exact spacing  ",
    skills,
    references: [...references, reference],
  });
  assert.equal(
    addMessageQuote(quoted, { ...reference, name: "Renamed source" }),
    quoted,
  );
  const differentExcerpt = { ...reference, excerpt: "Exact selected text " };
  const anotherThread = { ...reference, threadId: "thread-b" };
  assert.deepEqual(
    parseSkillDraft(
      addMessageQuote(addMessageQuote(quoted, differentExcerpt), anotherThread),
    ).references,
    [...references, reference, differentExcerpt, anotherThread],
  );
});

async function mount() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  await i18n.changeLanguage("en");
  const root = createRoot(document.querySelector("#root")!);
  return {
    dom,
    render: async (node: React.ReactNode) => {
      await act(async () => root.render(node));
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      await i18n.changeLanguage("en");
      dom.window.close();
    },
  };
}

function button(label: string) {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((element) => element.getAttribute("aria-label") === label);
  assert.ok(found, `Missing button ${label}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function key(key: string, options: KeyboardEventInit = {}) {
  await act(async () => {
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
  });
}

async function actionsHarness() {
  const view = await mount();
  const viewport = React.createRef<HTMLDivElement>();
  const quotes: MessageSelection[] = [];
  const clipboard: string[] = [];
  let copy: (text: string) => Promise<void> = async (text) => {
    clipboard.push(text);
  };
  Object.defineProperty(view.dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => copy(text) },
  });
  let anchor = new view.dom.window.DOMRect(220, 120, 80, 20);
  let toolbarSize = { width: 180, height: 36 };
  view.dom.window.Range.prototype.getBoundingClientRect = () => anchor;
  view.dom.window.Range.prototype.getClientRects = () =>
    [anchor] as unknown as DOMRectList;
  view.dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("message-selection-actions")
      ? new view.dom.window.DOMRect(0, 0, toolbarSize.width, toolbarSize.height)
      : new view.dom.window.DOMRect(100, 50, 500, 400);
  };
  async function render(
    options: {
      threadId?: string;
      sourceThread?: string;
      disabled?: boolean;
      onQuote?: (selection: MessageSelection) => void;
      onAddToSideChat?: (selection: MessageSelection) => void;
    } = {},
  ) {
    await view.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "div",
          { ref: viewport, id: "viewport" },
          React.createElement(
            "article",
            {
              "data-quote-thread-id": options.sourceThread ?? "thread-a",
              "data-quote-item-id": "item-a",
            },
            React.createElement(
              "div",
              { "data-message-quote-body": "" },
              "  Selected text\nwith spaces  ",
            ),
          ),
          React.createElement(MessageSelectionActions, {
            viewport,
            threadId: options.threadId ?? "thread-a",
            disabled: options.disabled ?? false,
            onQuote: options.onQuote ?? ((selection) => quotes.push(selection)),
            onAddToSideChat: options.onAddToSideChat,
          }),
        ),
        React.createElement("textarea", {
          defaultValue: "Existing composer note",
          "aria-label": "Main composer",
        }),
      ),
    );
  }
  async function select(start = 0, end?: number) {
    await act(async () => {
      const node = document.querySelector(
        "[data-message-quote-body]",
      )!.firstChild!;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end ?? node.textContent!.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
  }
  await render();
  return {
    ...view,
    render,
    select,
    viewport,
    quotes,
    clipboard,
    failCopy() {
      copy = async () => {
        throw new Error("Clipboard denied");
      };
    },
    setCopy(next: typeof copy) {
      copy = next;
    },
    setGeometry(rect: DOMRect, height = 36) {
      anchor = rect;
      toolbarSize = { width: 180, height };
    },
  };
}

test("selection toolbar portals two semantic actions, preserves selection on mousedown, and Copy never edits the composer", async () => {
  const view = await actionsHarness();
  try {
    await view.select();
    const toolbar = document.querySelector<HTMLElement>(
      ".message-selection-actions",
    )!;
    assert.equal(toolbar.parentElement, document.body);
    assert.equal(toolbar.getAttribute("aria-label"), "Selected text actions");
    assert.equal(toolbar.querySelectorAll("button").length, 2);
    assert.deepEqual(
      [...toolbar.querySelectorAll("svg")].map((icon) => icon.dataset.icon),
      ["copy", "quote"],
    );
    const down = new window.MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    button("Copy").dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    const exact = document.getSelection()!.toString();
    await click(button("Copy"));
    assert.deepEqual(view.clipboard, [exact]);
    assert.equal(
      document.querySelector('[role="status"]')?.textContent,
      "Copied",
    );
    assert.equal(
      document.querySelector("textarea")!.value,
      "Existing composer note",
    );
    assert.deepEqual(view.quotes, []);
    assert.equal(document.getSelection()!.toString(), exact);
    await click(button("Quote"));
    assert.deepEqual(view.quotes, [
      { threadId: "thread-a", id: "item-a", excerpt: exact },
    ]);
    assert.equal(document.querySelector(".message-selection-actions"), null);
    assert.equal(
      document.querySelector("textarea")!.value,
      "Existing composer note",
    );
  } finally {
    await view.cleanup();
  }
});

test("clipboard failure is local and a late clipboard result never reopens a retired toolbar", async () => {
  const view = await actionsHarness();
  try {
    await view.select();
    view.failCopy();
    await click(button("Copy"));
    assert.match(
      document.querySelector('[role="status"]')!.textContent!,
      /Couldn’t copy/,
    );
    assert.equal(
      document.querySelector("textarea")!.value,
      "Existing composer note",
    );
    assert.deepEqual(view.quotes, []);
    let finish!: () => void;
    view.setCopy(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await click(button("Copy"));
    await key("Escape");
    await act(async () => finish());
    assert.equal(document.querySelector(".message-selection-actions"), null);
  } finally {
    await view.cleanup();
  }
});

test("Alt+Enter ignores composition, uses the latest callback, and Escape dismisses without clearing native selection", async () => {
  const view = await actionsHarness();
  try {
    await view.select();
    await key("Enter", { altKey: true, isComposing: true });
    assert.deepEqual(view.quotes, []);
    assert.ok(document.querySelector(".message-selection-actions"));
    const exact = document.getSelection()!.toString();
    await key("Escape");
    assert.equal(document.querySelector(".message-selection-actions"), null);
    assert.equal(document.getSelection()!.toString(), exact);
    await act(async () =>
      document.dispatchEvent(new window.Event("selectionchange")),
    );
    assert.equal(document.querySelector(".message-selection-actions"), null);
    await view.select(2);
    const latest: MessageSelection[] = [];
    await view.render({ onQuote: (selection) => latest.push(selection) });
    assert.ok(
      document.querySelector(".message-selection-actions"),
      "a parent render does not retire a valid selection",
    );
    await key("Enter", { altKey: true });
    assert.equal(latest.length, 1);
    assert.equal(latest[0]?.excerpt, document.getSelection()!.toString());
    assert.deepEqual(view.quotes, []);
  } finally {
    await view.cleanup();
  }
});

test("thread changes, disabled admission, scroll and resize retire selection actions", async () => {
  const view = await actionsHarness();
  try {
    await view.select();
    await view.render({ threadId: "thread-b", sourceThread: "thread-a" });
    await key("Enter", { altKey: true });
    assert.equal(document.querySelector(".message-selection-actions"), null);
    assert.deepEqual(view.quotes, []);
    await view.render({ threadId: "thread-b", sourceThread: "thread-b" });
    await key("Enter", { altKey: true });
    assert.deepEqual(
      view.quotes,
      [],
      "reused DOM text cannot revive a selection from the prior Thread",
    );
    await view.render({ disabled: true });
    await view.select(2);
    await key("Enter", { altKey: true });
    assert.equal(document.querySelector(".message-selection-actions"), null);
    assert.deepEqual(view.quotes, []);
    await view.render();
    await view.select(3);
    await act(async () =>
      view.viewport.current!.dispatchEvent(new window.Event("scroll")),
    );
    assert.equal(document.querySelector(".message-selection-actions"), null);
    await view.select(4);
    await act(async () => window.dispatchEvent(new window.Event("resize")));
    assert.equal(document.querySelector(".message-selection-actions"), null);
  } finally {
    await view.cleanup();
  }
});

test("selection toolbar is clamped to the viewport and uses measured touch height", async () => {
  const view = await actionsHarness();
  try {
    view.setGeometry(new view.dom.window.DOMRect(570, 60, 20, 20), 52);
    await view.select();
    const toolbar = document.querySelector<HTMLElement>(
      ".message-selection-actions",
    )!;
    assert.equal(toolbar.style.left, "412px");
    assert.equal(toolbar.style.top, "88px");
    assert.equal(toolbar.style.maxWidth, "484px");
    view.setGeometry(new view.dom.window.DOMRect(110, 430, 20, 20), 52);
    await view.select(2);
    assert.equal(toolbar.style.left, "110px");
    assert.equal(toolbar.style.top, "370px");
  } finally {
    await view.cleanup();
  }
});

test("sent quotes use the same exact read-only pill without a remove control or editable note", async () => {
  const view = await mount();
  let sourceCalls = 0;
  try {
    await view.render(
      React.createElement(MessageQuoteCard, {
        reference,
        onSource: () => {
          sourceCalls++;
          return true;
        },
      }),
    );
    const card = document.querySelector(".message-quote-card")!;
    assert.equal(card.getAttribute("role"), "group");
    assert.equal(card.getAttribute("aria-label"), "Quote");
    assert.equal(
      card.querySelector(".message-quote-excerpt")?.textContent,
      reference.excerpt,
    );
    assert.equal(card.querySelectorAll("button").length, 1);
    assert.equal(
      card.querySelector("input, textarea, [contenteditable]"),
      null,
    );
    assert.equal(card.querySelector("h1, h2, h3, h4"), null);
    assert.equal(card.querySelector("svg")?.dataset.icon, "quote");
    await click(button("Go to the source message"));
    assert.equal(sourceCalls, 1);
    assert.equal(document.querySelector('[role="status"]'), null);
  } finally {
    await view.cleanup();
  }
});

test("draft quotes retain remove, and source failure is explicit without modifying the exact excerpt", async () => {
  const view = await mount();
  let removals = 0;
  let available = false;
  try {
    const exactReference = {
      ...reference,
      excerpt: "  line one\nline two\t<literal>  ",
    };
    await view.render(
      React.createElement(MessageQuoteCard, {
        reference: exactReference,
        onRemove: () => {
          removals++;
        },
        onSource: () => available,
      }),
    );
    await click(button("Go to the source message"));
    assert.match(
      document.querySelector('[role="status"]')?.textContent ?? "",
      /Source unavailable/,
    );
    assert.equal(
      document.querySelector(".message-quote-excerpt")?.textContent,
      exactReference.excerpt,
    );
    available = true;
    await click(button("Go to the source message"));
    assert.equal(document.querySelector('[role="status"]'), null);
    await click(button("Remove quoted passage"));
    assert.equal(removals, 1);
  } finally {
    await view.cleanup();
  }
});

test("only actual DOM overflow exposes expansion and expanded text remains exact and read-only", async () => {
  const view = await mount();
  const oldObserver = globalThis.ResizeObserver;
  let measure!: ResizeObserverCallback;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      measure = callback;
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  try {
    await view.render(
      React.createElement(MessageQuoteCard, {
        reference,
        onSource: () => true,
      }),
    );
    assert.equal(document.querySelector(".message-quote-expand"), null);
    const excerpt = document.querySelector<HTMLElement>(
      ".message-quote-excerpt",
    )!;
    let overflow = true;
    Object.defineProperties(excerpt, {
      scrollWidth: { configurable: true, get: () => (overflow ? 250 : 100) },
      clientWidth: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 20 },
      clientHeight: { configurable: true, get: () => 20 },
    });
    await act(async () => measure([], {} as ResizeObserver));
    const expand = button("Show full quote");
    assert.equal(expand.getAttribute("aria-expanded"), "false");
    assert.equal(expand.getAttribute("aria-controls"), excerpt.id);
    await click(expand);
    assert.equal(
      button("Collapse quote").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      document.querySelector<HTMLElement>(".message-quote-card")?.dataset
        .expanded,
      "true",
    );
    assert.equal(excerpt.textContent, reference.excerpt);
    assert.equal(document.querySelector("textarea"), null);
    assert.equal(document.querySelector(".message-quote-remove"), null);
    overflow = false;
    await click(button("Collapse quote"));
    assert.equal(document.querySelector(".message-quote-expand"), null);
    // A short multiline quote is a real vertical overflow, not a text-length heuristic.
    Object.defineProperty(excerpt, "scrollHeight", {
      configurable: true,
      get: () => 40,
    });
    await act(async () => measure([], {} as ResizeObserver));
    assert.ok(button("Show full quote"));
  } finally {
    globalThis.ResizeObserver = oldObserver;
    await view.cleanup();
  }
});

test("quote styling keeps a compact round pill, distinct bounded expansion and accessible touch controls", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/message-quote.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.message-quote-pill\s*\{[^}]*height: 28px;[^}]*border-radius: 999px;/su,
  );
  assert.match(
    css,
    /\.message-quote-pill > button\s*\{[^}]*width: 24px;[^}]*height: 24px;/su,
  );
  assert.match(
    css,
    /\.message-quote-excerpt\s*\{[^}]*height: 18px;[^}]*line-height: 18px;/su,
  );
  assert.match(
    css,
    /\[data-expanded="true"\] \.message-quote-pill\s*\{[^}]*height: auto;[^}]*border-radius: 14px;/su,
  );
  assert.match(
    css,
    /\[data-expanded="true"\] \.message-quote-excerpt\s*\{[^}]*max-height: 160px;[^}]*overflow: auto;[^}]*white-space: pre-wrap;/su,
  );
  assert.match(
    css,
    /\.composer-references:has\(\.message-quote-card\)\s*\{[^}]*max-height: min\(220px, 32vh\);[^}]*overflow: auto;/su,
  );
  assert.match(css, /@media \(pointer: coarse\), \(hover: none\)/u);
  assert.match(css, /min-height: 44px;/u);
  assert.doesNotMatch(css, /border-left|border-inline-start/u);
});

test("Add to side chat hands off exact structured selection without quoting locally or sending", async () => {
  const view = await actionsHarness();
  const received: MessageSelection[] = [];
  try {
    await view.render({
      onAddToSideChat: (selection) => received.push(selection),
    });
    await view.select();
    const action = document.querySelector<HTMLButtonElement>(
      '[aria-label="Add to side chat"]',
    )!;
    assert.ok(action);
    await act(async () => action.click());
    assert.deepEqual(received, [
      {
        threadId: "thread-a",
        id: "item-a",
        excerpt: "  Selected text\nwith spaces  ",
      },
    ]);
    assert.equal(view.quotes.length, 0);
    assert.equal(document.querySelector(".message-selection-actions"), null);
    assert.equal(
      document.querySelector("textarea")?.value,
      "Existing composer note",
    );
  } finally {
    await view.cleanup();
  }
});
