import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import {
  Markdown,
  MessageLinkContext,
  parseMarkdown,
} from "../src/renderer/src/Markdown.js";
import { classifyMessageLink } from "../src/external-link-policy.js";
import { messageFilePath } from "../src/renderer/src/message-file-path.js";
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
  assert.match(
    html,
    /<blockquote>\s*<p>quoted <code>value<\/code><\/p>\s*<\/blockquote>/u,
  );
  assert.match(html, /<ul>/u);
  assert.match(html, /<table>/u);
  assert.match(html, /const ok = true;/u);
  assert.match(html, /&lt;img src=x onerror=/u);
  assert.doesNotMatch(html, /javascript:/u);
  assert.doesNotMatch(html, /<img/u);
});

test("renders strong, emphasis, and list item inline syntax", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      text: "**bold** and *emphasis*\n\n- **first**\n- _second_",
    }),
  );
  assert.match(html, /<strong>bold<\/strong>/u);
  assert.match(html, /<em>emphasis<\/em>/u);
  assert.match(html, /<li><strong>first<\/strong><\/li>/u);
  assert.match(html, /<li><em>second<\/em><\/li>/u);
});

test("renders Markdown images and preserves fence contents", () => {
  const source = [
    "![remote](https://evil.example/x.png)",
    "",
    "````js",
    "[bad](javascript:alert(1))",
    "```",
    "tail",
    "````",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(Markdown, { text: source }));
  assert.match(html, /<img\b/u);
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)\n```\ntail/u);
});

test("does not treat a different fence as closing an unfinished block", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      text: "~~~js\na\n```\nb\n```\n",
    }),
  );
  assert.equal(
    (html.match(/class="markdown-code(?: streaming)?"/g) ?? []).length,
    1,
  );
  assert.match(html, /a\n```\nb/u);
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

test("message links render local and web anchors inside a Thread", () => {
  const html = renderToStaticMarkup(
    createElement(
      MessageLinkContext.Provider,
      { value: () => {} },
      createElement(Markdown, {
        text: "[修复记录与备份说明](agent-data/codex-instance-repair/RESULT.md) [中文](./中文%20file.md) [file](file:///tmp/a%20b.md) [web](https://example.com/) [unsafe](javascript:alert(1))",
      }),
    ),
  );
  assert.match(html, /href="agent-data\/codex-instance-repair\/RESULT.md"/u);
  assert.match(html, /href="\.\/%E4%B8%AD%E6%96%87%20file.md"/u);
  assert.match(html, /href="file:\/\/\/tmp\/a%20b.md"/u);
  assert.match(html, /href="https:\/\/example.com\/"/u);
  assert.doesNotMatch(html, /target="_blank"|javascript:/u);
});

test("message link policy rejects dangerous schemes and delegates workspace boundaries", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "//host/path",
    "file://remote/etc/passwd",
    "file:///tmp/x?query",
    "file:///tmp/%0Asecret",
    "./%00secret",
    "\\\\server\\share",
  ]) {
    assert.deepEqual(classifyMessageLink(value), { kind: "rejected" });
  }
  assert.deepEqual(
    classifyMessageLink("file:///tmp/%E4%B8%AD%E6%96%87%20file.md"),
    { kind: "file", value: "/tmp/中文 file.md" },
  );
  assert.equal(
    messageFilePath("agent-data/codex-instance-repair/RESULT.md", "/tmp/work"),
    "agent-data/codex-instance-repair/RESULT.md",
  );
  assert.equal(
    messageFilePath("/tmp/work/中文 file.md", "/tmp/work"),
    "中文 file.md",
  );
  assert.throws(
    () => messageFilePath("../elsewhere.md", "/tmp/work"),
    /outside/u,
  );
  assert.throws(() => messageFilePath("/etc/passwd", "/tmp/work"), /outside/u);
});

test("production Markdown keeps one decode for percent filenames and file URLs", () => {
  const markup = renderToStaticMarkup(
    createElement(
      MessageLinkContext.Provider,
      { value: () => {} },
      createElement(Markdown, {
        text: [
          "[literal percent](report%25done.md)",
          "[literal percent20](report%2520done.md)",
          "[file percent](file:///tmp/report%25done.md)",
          "[space](report%20done.md)",
          "[中文](%E4%B8%AD%E6%96%87%20file.md)",
        ].join(" "),
      }),
    ),
  );
  assert.match(markup, /href="report%25done.md"/u);
  assert.match(markup, /href="report%2520done.md"/u);
  assert.match(markup, /href="file:\/\/\/tmp\/report%25done.md"/u);
  assert.match(markup, /href="report%20done.md"/u);
  assert.match(markup, /href="%E4%B8%AD%E6%96%87%20file.md"/u);
  assert.equal((markup.match(/<a /gu) ?? []).length, 5);
});
