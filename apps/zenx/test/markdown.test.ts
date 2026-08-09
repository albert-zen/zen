import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { Markdown, parseMarkdown } from "../src/renderer/src/Markdown.js";
import {
  classifyZenXLink,
  isAllowedZenXExternalUrl,
} from "../src/external-link-policy.js";

test("renders the supported GFM blocks without raw HTML", () => {
  const source = [
    "# Heading",
    "",
    "> quoted `value`",
    "",
    "- first",
    "- [safe](https://example.com)",
    "",
    "| Name | State |",
    "| --- | --- |",
    "| Zen | ready |",
    "",
    "```ts",
    "const ok = true;",
    "```",
    "",
    '<img src=x onerror="alert(1)">',
    "[bad](javascript:alert(1))",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(Markdown, { text: source }));
  assert.match(html, /<h1>Heading<\/h1>/u);
  assert.match(html, /<blockquote>quoted <code>value<\/code><\/blockquote>/u);
  assert.match(html, /<ul>/u);
  assert.match(html, /<table>/u);
  assert.match(html, /const ok = true;/u);
  assert.match(html, /&lt;img src=x onerror=/u);
  assert.doesNotMatch(html, /javascript:/u);
  assert.doesNotMatch(html, /<img/u);
});

test("keeps an unfinished streaming fence as one stable code block", () => {
  const blocks = parseMarkdown('Before\n\n```json\n{"partial": true');
  assert.deepEqual(blocks, [
    { type: "paragraph", text: "Before" },
    {
      type: "code",
      language: "json",
      text: '{"partial": true',
      closed: false,
    },
  ]);
});

test("allows only web/mail external links and keeps anchors inside the renderer", () => {
  assert.deepEqual(classifyZenXLink("#result"), {
    kind: "anchor",
    href: "#result",
  });
  for (const href of [
    "https://example.com/path",
    "http://example.com",
    "mailto:owner@example.com",
  ]) {
    assert.equal(classifyZenXLink(href).kind, "external");
    assert.equal(isAllowedZenXExternalUrl(href), true);
  }
  for (const href of [
    "/tmp/secret",
    "./local",
    "../escape",
    "//evil.example/path",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,boom",
    "custom:payload",
  ]) {
    assert.deepEqual(classifyZenXLink(href), { kind: "rejected" });
    assert.equal(isAllowedZenXExternalUrl(href), false);
  }
  assert.equal(isAllowedZenXExternalUrl("#result"), false);

  const html = renderToStaticMarkup(
    createElement(Markdown, {
      text: "[anchor](#result) [relative](../escape) [file](file:///tmp/a) [web](https://example.com)",
    }),
  );
  assert.match(html, /href="#result"/u);
  assert.doesNotMatch(html, /\.\.\/escape|file:\/\//u);
  assert.match(html, /target="_blank"/u);
});
