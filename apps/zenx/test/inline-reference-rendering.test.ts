import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineReferenceContent } from "../src/renderer/src/InlineReferenceContent.js";
import type { Reference } from "../src/renderer/src/composer-selector.js";
const ref: Reference = {
  kind: "thread",
  id: "thread-a",
  name: "线程甲",
  cwd: "/project",
};
const render = (text: string) =>
  renderToStaticMarkup(
    React.createElement(InlineReferenceContent, {
      text,
      references: [{ ...ref, position: text.indexOf("\uFFFC") }],
    }),
  );
test("inline token keeps surrounding Markdown in a single parse and never promotes raw HTML", () => {
  const html = render(
    "说明 **前 \uFFFC 后**，再比较。\n\n- 第一项\n- 第二项\n\n<script>alert(1)</script>",
  );
  assert.match(html, /<strong>前 <.*reference-token/s);
  assert.match(html, /后<\/strong>/);
  assert.match(html, /<ul>/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("ZENXREF"));
});
test("inline code and fenced code retain code structure with a typed reference", () => {
  for (const text of [
    "查看 `前 \uFFFC 后` 的区别",
    "```text\n前 \uFFFC 后\n```",
    "```text\n前 \uFFFC 后",
  ]) {
    const html = render(text);
    assert.match(html, /<code[^>]*>前 .*reference-token/s);
    assert.ok(html.includes("后"));
    assert.ok(!html.includes("[object Object]"));
    assert.ok(!html.includes("ZENXREF"));
  }
});
test("ordinary literal placeholder-like text stays visible and distinct from real references", () => {
  const html = render("\uE000ZENXREF0\uE001 只是普通文本；\uFFFC 是真实引用");
  assert.ok(html.includes("\uE000ZENXREF0\uE001"));
  assert.equal((html.match(/data-reference-kind=/g) ?? []).length, 1);
});

test("references in hidden Markdown syntax stay visible without activating or nesting links", () => {
  for (const text of [
    "[click](https://example.com/\uFFFC)",
    "[before \uFFFC after](https://example.com)",
    "![alt \uFFFC](https://example.com/x.png)",
    '[x](https://example.com "title \uFFFC")',
    '<span title="\uFFFC">hidden</span>',
    "```lang\uFFFC\ntext\n```",
  ]) {
    const html = render(text);
    assert.equal((html.match(/data-reference-kind=/g) ?? []).length, 1, text);
    assert.ok(!html.includes("ZENXREF"), text);
    assert.ok(!/<a[^>]*>.*reference-token/s.test(html), text);
    assert.ok(!html.includes('href="https://example.com'), text);
  }
});
