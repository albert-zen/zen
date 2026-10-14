import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Markdown, MessageLinkContext } from "../src/renderer/src/Markdown.js";

async function renderLinks(source: string) {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const opened: { kind: "file" | "browser"; value: string }[] = [];
  const root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(
        MessageLinkContext.Provider,
        { value: (target) => opened.push(target) },
        React.createElement(Markdown, { text: source }),
      ),
    ),
  );
  return {
    opened,
    body: document.querySelector(".markdown-body")!,
    anchors: [
      ...document.querySelectorAll<HTMLAnchorElement>(".markdown-body a"),
    ],
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("production Markdown preserves explicit, reference and angle-autolink destinations", async () => {
  const urls = [
    "https://example.test/report%EF%BC%88v2%EF%BC%89.html",
    "https://example.test/a_",
    "https://example.test/search?q=one%EF%BC%8Ctwo",
    "https://example.test/app#chapter_1!",
    "https://example.test/report（v2）.html",
  ];
  const fixture = await renderLinks(
    [
      ...urls.map((url, index) => `[explicit ${index}](${url})`),
      ...urls.map((_, index) => `[reference ${index}][url${index}]`),
      ...urls.map((url) => `<${url}>`),
      "",
      ...urls.map((url, index) => `[url${index}]: ${url}`),
    ].join("\n"),
  );
  try {
    assert.equal(fixture.anchors.length, urls.length * 3);
    for (const anchor of fixture.anchors) await act(async () => anchor.click());
    assert.deepEqual(
      fixture.opened,
      [...urls, ...urls, ...urls].map((url) => ({
        kind: "browser",
        value: new URL(url).toString(),
      })),
    );
  } finally {
    await fixture.close();
  }
});

test("bare autolink cleanup preserves escaped target bytes and leaves prose visible", async () => {
  const cases = [
    {
      text: "**http://127.0.0.1:56277/sales–architecture.html**（刚重启，已验证 200）",
      prefix: "http://127.0.0.1:56277/sales–architecture.html",
      suffix: "**（刚重启，已验证 200）",
    },
    ...["）", "**", "。"].map((suffix) => ({
      text: `https://example.test/a${suffix}`,
      prefix: "https://example.test/a",
      suffix,
    })),
    {
      text: "https://example.test/?a=1，下一页",
      prefix: "https://example.test/?a=1",
      suffix: "，下一页",
    },
    {
      text: "https://example.test/%E6%8A%A5%E5%91%8A%EF%BC%88extra",
      prefix: "https://example.test/%E6%8A%A5%E5%91%8A",
      suffix: "%EF%BC%88extra",
    },
    {
      text: "https://example.test/%E6%8A%A5%E5%91%8A.html（说明）",
      prefix: "https://example.test/%E6%8A%A5%E5%91%8A.html",
      suffix: "（说明）",
    },
    {
      text: "https://example.test/a%2fb%2F%E6%8A%A5%E5%91%8A%EF%BC%88tail",
      prefix: "https://example.test/a%2fb%2F%E6%8A%A5%E5%91%8A",
      suffix: "%EF%BC%88tail",
    },
    {
      text: "https://example.test/%F0%9F%98%80.html（tail",
      prefix: "https://example.test/%F0%9F%98%80.html",
      suffix: "（tail",
    },
    {
      text: "https://example.test/%F0%9F%98%80%E6%8A%A5%E5%91%8A%ef%bc%88tail",
      prefix: "https://example.test/%F0%9F%98%80%E6%8A%A5%E5%91%8A",
      suffix: "%ef%bc%88tail",
    },
    {
      text: "https://example.test/😀.html（tail",
      prefix: "https://example.test/😀.html",
      suffix: "（tail",
    },
    {
      text: "https://example.test/报告.html，下一页",
      prefix: "https://example.test/报告.html",
      suffix: "，下一页",
    },
    {
      text: "www.example.test/a**（tail",
      prefix: "www.example.test/a",
      suffix: "**（tail",
    },
  ];
  for (const { text, prefix, suffix } of cases) {
    const fixture = await renderLinks(text);
    try {
      assert.equal(fixture.anchors.length, 1, text);
      const anchor = fixture.anchors[0]!;
      await act(async () => anchor.click());
      assert.deepEqual(
        fixture.opened,
        [
          {
            kind: "browser",
            value: new URL(
              prefix.startsWith("www.") ? `http://${prefix}` : prefix,
            ).toString(),
          },
        ],
        text,
      );
      assert.equal(anchor.textContent, prefix, text);
      assert.ok(fixture.body.textContent?.endsWith(suffix), text);
      assert.equal(fixture.body.textContent, text, text);
    } finally {
      await fixture.close();
    }
  }
});

test("autolink cleanup stays out of explicit anchors, mail, files and code", async () => {
  const fixture = await renderLinks(
    [
      "[anchor](#第1节（修订）)",
      "[mail](mailto:owner@example.test?subject=report%EF%BC%88v2%EF%BC%89)",
      "[file](报告（v2）.md)",
      "[named][报告（v2）]",
      "`https://example.test/code**（prose`",
      "",
      "[报告（v2）]: https://example.test/a_",
      "",
      "```text",
      "https://example.test/fence**（prose",
      "```",
    ].join("\n"),
  );
  try {
    assert.deepEqual(
      fixture.anchors.map((anchor) => anchor.getAttribute("href")),
      [
        "#%E7%AC%AC1%E8%8A%82%EF%BC%88%E4%BF%AE%E8%AE%A2%EF%BC%89",
        "mailto:owner@example.test?subject=report%EF%BC%88v2%EF%BC%89",
        "%E6%8A%A5%E5%91%8A%EF%BC%88v2%EF%BC%89.md",
        "https://example.test/a_",
      ],
    );
    await act(async () => fixture.anchors[2]!.click());
    assert.deepEqual(fixture.opened, [
      { kind: "file", value: "报告（v2）.md" },
    ]);
    assert.deepEqual(
      [...fixture.body.querySelectorAll("code")].map(
        (code) => code.textContent,
      ),
      [
        "https://example.test/code**（prose",
        "https://example.test/fence**（prose",
      ],
    );
  } finally {
    await fixture.close();
  }
});

test("bare-link cleanup works in nested GFM blocks and before an unfinished fence", async () => {
  const fixture = await renderLinks(
    [
      "> https://example.test/quote（说明）",
      "",
      "- **https://example.test/list**",
      "",
      "| URL |",
      "| --- |",
      "| https://example.test/table（说明） |",
      "",
      "https://example.test/stream（说明）",
      "",
      "```text",
      "https://example.test/code（说明）",
    ].join("\n"),
  );
  try {
    for (const anchor of fixture.anchors) await act(async () => anchor.click());
    assert.deepEqual(
      fixture.opened,
      ["quote", "list", "table", "stream"].map((path) => ({
        kind: "browser",
        value: `https://example.test/${path}`,
      })),
    );
    assert.equal(
      fixture.body.querySelector(".markdown-code.streaming code")?.textContent,
      "https://example.test/code（说明）",
    );
  } finally {
    await fixture.close();
  }
});
