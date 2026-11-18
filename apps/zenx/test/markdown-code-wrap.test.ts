import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Markdown, MessageLinkContext } from "../src/renderer/src/Markdown.js";
import { i18n } from "../src/renderer/src/i18n.js";

test("explicit code wrapping preserves the original payload and native button semantics", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const writes: string[] = [];
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (value: string) => {
          writes.push(value);
        },
      },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const payload =
    'const label = "这是保留原样的中文与 English ' +
    "long-segment-".repeat(30) +
    '";\n\treturn label;';
  try {
    await act(async () =>
      root.render(
        createElement(Markdown, { text: "```ts\n" + payload + "\n```" }),
      ),
    );
    const frame = container.querySelector<HTMLElement>(".markdown-code")!;
    const wrap = container.querySelector<HTMLButtonElement>(
      ".markdown-code-wrap",
    )!;
    const copy = container.querySelector<HTMLButtonElement>(
      ".markdown-code-copy",
    )!;
    const sourceText = container.querySelector("pre code")!.textContent;
    assert.equal(frame.dataset.wrapped, "false");
    assert.equal(wrap.tagName, "BUTTON");
    assert.equal(wrap.type, "button");
    assert.equal(wrap.getAttribute("aria-pressed"), "false");
    assert.equal(wrap.disabled, false);
    assert.equal(wrap.tabIndex, 0);
    wrap.focus();
    await act(async () => wrap.click());
    assert.equal(document.activeElement, wrap);
    assert.equal(frame.dataset.wrapped, "true");
    assert.equal(wrap.getAttribute("aria-pressed"), "true");
    assert.equal(container.querySelector("pre code")!.textContent, sourceText);
    await act(async () => copy.click());
    assert.deepEqual(writes, [payload]);
    await act(async () => wrap.click());
    assert.equal(frame.dataset.wrapped, "false");
    assert.equal(container.querySelector("pre code")!.textContent, sourceText);
    await act(async () => i18n.changeLanguage("zh-CN"));
    assert.equal(
      container.querySelector(".markdown-code-wrap")!.textContent,
      "代码换行",
    );
    await act(async () => i18n.changeLanguage("en"));
    assert.equal(
      container.querySelector(".markdown-code-wrap")!.textContent,
      "Wrap lines",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
    if (oldNavigator)
      Object.defineProperty(globalThis, "navigator", oldNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("wrap CSS is global to fenced blocks while trace code grouping and prose leading remain unchanged", () => {
  const css = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\n\.markdown-code\[data-wrapped="true"\] pre\s*\{\s*white-space: pre-wrap;\s*overflow-wrap: anywhere;/,
  );
  assert.match(css, /\.trace-detail-markdown \.markdown-code code/);
  assert.doesNotMatch(
    css,
    /\.trace-detail-markdown \.markdown-code\[data-wrapped/,
  );
  assert.match(
    css,
    /\.markdown-code pre\s*\{[^}]*white-space: pre;[^}]*overflow-wrap: normal;/,
  );
  assert.match(
    css,
    /\.thread-view \.agent-copy\s*\{\s*font-size: 15px;\s*line-height: 1.8;/,
  );
});

test("closed code retains toggle identity and focus across streaming updates with independent blocks", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (text: string) =>
    act(async () => root.render(createElement(Markdown, { text })));
  const first = "```ts\nconst first = 1;";
  try {
    await render(first);
    assert.equal(container.querySelector(".markdown-code-wrap"), null);
    await render(first + "\nconst second = 2;");
    assert.equal(container.querySelector(".markdown-code-wrap"), null);
    const closed = first + "\n```";
    await render(closed);
    const wrap = container.querySelector<HTMLButtonElement>(
      ".markdown-code-wrap",
    )!;
    wrap.focus();
    await act(async () => wrap.click());
    await render(closed + "\n\nAppended prose.");
    assert.equal(container.querySelector(".markdown-code-wrap"), wrap);
    assert.equal(wrap.getAttribute("aria-pressed"), "true");
    assert.equal(document.activeElement, wrap);
    const two = closed + "\n\nAppended prose.\n\n```txt\nsecond block\n```";
    await render(two);
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      ".markdown-code-wrap",
    );
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0], wrap);
    const second = buttons[1];
    assert.ok(second);
    assert.equal(second.getAttribute("aria-pressed"), "false");
    assert.equal(document.activeElement, wrap);
    // Beginning and closing another streamed fence must not remount earlier blocks.
    await render(two + "\n\n```txt\nthird block");
    assert.equal(container.querySelector(".markdown-code-wrap"), wrap);
    assert.equal(document.activeElement, wrap);
    await render(two + "\n\n```txt\nthird block\n```");
    assert.equal(container.querySelector(".markdown-code-wrap"), wrap);
    assert.equal(wrap.getAttribute("aria-pressed"), "true");
    assert.equal(document.activeElement, wrap);
    const all = container.querySelectorAll<HTMLButtonElement>(
      ".markdown-code-wrap",
    );
    const secondAfterUpdate = all[1];
    const third = all[2];
    assert.ok(secondAfterUpdate);
    assert.ok(third);
    await act(async () => secondAfterUpdate.click());
    await act(async () => wrap.click());
    assert.equal(secondAfterUpdate.getAttribute("aria-pressed"), "true");
    assert.equal(third.getAttribute("aria-pressed"), "false");
    assert.equal(wrap.getAttribute("aria-pressed"), "false");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("wrapped code copies current inline-token payload after a message update", async () => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const writes: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const text = "```txt\n__REFERENCE__\n```";
    const render = async (copyText: string, suffix = "") =>
      act(async () =>
        root.render(
          createElement(Markdown, {
            text: text + suffix,
            inlineTokens: [
              {
                marker: "__REFERENCE__",
                node: createElement("span", null, "visible reference"),
                copyText,
              },
            ],
          }),
        ),
      );
    await render("original reference");
    const wrap = container.querySelector<HTMLButtonElement>(
      ".markdown-code-wrap",
    )!;
    wrap.focus();
    await act(async () => wrap.click());
    await render("current reference", "\n\nmore prose");
    assert.equal(container.querySelector(".markdown-code-wrap"), wrap);
    assert.equal(document.activeElement, wrap);
    assert.equal(wrap.getAttribute("aria-pressed"), "true");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".markdown-code-copy")!
        .click(),
    );
    assert.deepEqual(writes, ["current reference"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (oldNavigator)
      Object.defineProperty(globalThis, "navigator", oldNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("nested and indented code remains conservative without exposing an unconfirmed wrap control", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    for (const text of [
      "> ```ts\n> const nested = 1;",
      "> ```ts\n> const nested = 1;\n> ```",
      "- item\n\n    ```ts\n    const nested = 1;",
      "    indented code",
    ]) {
      await act(async () => root.render(createElement(Markdown, { text })));
      assert.equal(container.querySelector(".markdown-code-wrap"), null, text);
    }
    await act(async () =>
      root.render(
        createElement(Markdown, {
          text: "~~~javascript\nconst valid = 1;\n~~~",
        }),
      ),
    );
    assert.ok(container.querySelector(".markdown-code-wrap"));
  } finally {
    await act(async () => root.unmount());
  }
});

test("file path Open, Copy and Wrap remain separate in both locales", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const path = "/synthetic/file-sidebar-preview/src/long-source.ts";
  const opened: unknown[] = [];
  const writes: string[] = [];
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    },
  });
  try {
    for (const lang of ["en", "zh-CN"]) {
      await act(async () => i18n.changeLanguage(lang));
      await act(async () =>
        root.render(
          createElement(
            MessageLinkContext.Provider,
            {
              value: (target) => {
                opened.push(target);
              },
            },
            createElement(Markdown, { text: "```text\n" + path + "\n```" }),
          ),
        ),
      );
      const open = container.querySelector<HTMLButtonElement>(
        ".markdown-code-actions button:not(.markdown-code-copy):not(.markdown-code-wrap)",
      );
      const copy = container.querySelector<HTMLButtonElement>(
        ".markdown-code-copy",
      );
      const wrap = container.querySelector<HTMLButtonElement>(
        ".markdown-code-wrap",
      );
      assert.ok(open);
      assert.ok(copy);
      assert.ok(wrap);
      assert.equal(new Set([open, copy, wrap]).size, 3);
      assert.equal(open.textContent, lang === "en" ? "Open file" : "打开文件");
      assert.equal(copy.textContent, lang === "en" ? "Copy" : "复制");
      assert.equal(wrap.textContent, lang === "en" ? "Wrap lines" : "代码换行");
      const before = opened.length;
      await act(async () => wrap.click());
      assert.equal(opened.length, before);
      assert.equal(container.querySelector("pre code")?.textContent, path);
      await act(async () => copy.click());
      assert.equal(writes.at(-1), path);
      assert.equal(opened.length, before);
      await act(async () => open.click());
      assert.deepEqual(opened.at(-1), { kind: "file", value: path });
      assert.equal(opened.length, before + 1);
      await act(async () => root.render(null));
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
    if (oldNavigator)
      Object.defineProperty(globalThis, "navigator", oldNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
