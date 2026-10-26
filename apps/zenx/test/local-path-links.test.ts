import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, MessageLinkContext } from "../src/renderer/src/Markdown.js";
import { isLocalPath } from "../src/renderer/src/local-path-links.js";
import { messageFilePath } from "../src/renderer/src/message-file-path.js";
import { classifyMessageLink } from "../src/external-link-policy.js";

function markup(text: string, context = true) {
  const element = createElement(Markdown, { text });
  return renderToStaticMarkup(
    context
      ? createElement(MessageLinkContext.Provider, { value: () => {} }, element)
      : element,
  );
}

test("plain and inline-code local paths become existing sidebar links", () => {
  for (const source of [
    "Open /Users/alice/work/report.md now",
    "See src/main.ts.",
    "`/Users/alice/work/report notes.md`",
    '"/Users/alice/work/report notes.md"',
    "`C:\\work\\report notes.md`",
    "C:/work/report.md",
    "./notes/report.md",
    "file:///Users/alice/work/report.md",
  ]) {
    const html = markup(source);
    assert.match(html, /<a href=/u, source);
    assert.doesNotMatch(html, /target="_blank"/u);
  }
  assert.match(
    markup("`src/main.ts`"),
    /<a[^>]+><code>src\/main.ts<\/code><\/a>/u,
  );
  assert.match(markup("See src/main.ts."), /<\/a>\.<\/p>/u);
});

test("preserve literal percent paths, whitespace, existing links and code fences", () => {
  assert.match(markup("`./100% done.md`"), /href="\.\/100%25%20done.md"/u);
  assert.match(
    markup("[docs](https://example.test/src/a.ts)"),
    /href="https:\/\/example.test\/src\/a.ts"/u,
  );
  assert.equal((markup("[src/a.ts](src/a.ts)").match(/<a /gu) ?? []).length, 1);
  assert.doesNotMatch(markup("```sh\ncat src/a.ts\n```"), /<a /u);
  assert.doesNotMatch(markup("`cat src/a.ts`"), /<a /u);
  assert.doesNotMatch(markup("src/a.ts", false), /<a /u);
});

test("conservative recognition does not guess prose or network paths", () => {
  for (const value of [
    "hello",
    "README.md",
    "and/or",
    "foo bar/baz.ts",
    "//server/share.txt",
    "\\\\server\\share.txt",
    "javascript:evil",
    "file://server/share.txt",
    "file:///tmp/a?query",
    "https://example.test/a.ts",
  ])
    assert.equal(isLocalPath(value), false, value);
});

test("Windows links resolve within same runtime Host workspace, not browser computer", () => {
  assert.deepEqual(classifyMessageLink("C:/work/a.md"), {
    kind: "file",
    value: "C:/work/a.md",
  });
  assert.deepEqual(classifyMessageLink("file:///C:/work/a%20b.md"), {
    kind: "file",
    value: "C:/work/a b.md",
  });
  assert.equal(messageFilePath("C:\\work\\dir\\a.md", "C:\\work"), "dir/a.md");
  assert.equal(messageFilePath("c:/WORK/dir/a.md", "C:/work"), "dir/a.md");
  assert.equal(messageFilePath("./dir/a.md", "C:\\work"), "dir/a.md");
  assert.equal(messageFilePath("C:/a.md", "C:\\"), "a.md");
  for (const value of [
    "D:/a.md",
    "C:/work2/a.md",
    "../a.md",
    "C:relative.md",
    "C:/work/a:secret",
    "\\\\server\\share\\a.md",
    "/etc/passwd",
  ])
    assert.throws(
      () => messageFilePath(value, "C:\\work"),
      /outside|Network/u,
      value,
    );
  assert.throws(() => messageFilePath("C:/work/a.md", "/work"), /outside/u);
  assert.throws(() => messageFilePath("src/a.md", undefined), /unavailable/u);
});

test("conventional line locations open underlying file, without claiming line navigation", () => {
  for (const value of [
    "src/main.ts#L12",
    "src/main.ts:12",
    "src/main.ts:12:4",
  ]) {
    assert.match(markup(`\`${value}\``), /<a /u);
    const target = classifyMessageLink(value);
    assert.equal(target.kind, "file");
    if (target.kind === "file")
      assert.equal(messageFilePath(target.value, "/work"), "src/main.ts");
  }
  assert.equal(
    messageFilePath(
      (classifyMessageLink("C:/work/main.ts:12:4") as { value: string }).value,
      "C:/work",
    ),
    "main.ts",
  );
  assert.equal(messageFilePath("notes:12", "/work"), "notes:12");
  assert.equal(
    messageFilePath("src/actual:label.md", "/work"),
    "src/actual:label.md",
  );
  assert.deepEqual(classifyMessageLink("file:///work/main.ts#L12"), {
    kind: "file",
    value: "/work/main.ts",
  });
  assert.deepEqual(classifyMessageLink("file:///work/main.ts#other"), {
    kind: "rejected",
  });
});

test("file URI escapes are decoded once and malformed UTF-16 never crashes render", () => {
  for (const source of [
    "file:///tmp/a%20b.md",
    "`file:///tmp/a%20b.md`",
    '"file:///tmp/a%20b.md"',
  ]) {
    assert.match(markup(source), /href="file:\/\/\/tmp\/a%20b.md"/u);
    assert.doesNotMatch(markup(source), /%2520/u);
  }
  assert.doesNotThrow(() => markup("bad /tmp/\ud800.md text"));
  assert.doesNotMatch(markup("`/tmp/\ud800.md`"), /<a /u);
  assert.match(markup("`/tmp/😀.md`"), /<a /u);
});

test("render has no file side effects and explicit click delegates once without navigation", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const opened: unknown[] = [];
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(
          MessageLinkContext.Provider,
          { value: (target) => opened.push(target) },
          createElement(Markdown, { text: "Read `./notes/my file.md` now" }),
        ),
      ),
    );
    assert.equal(opened.length, 0);
    const anchor = document.querySelector("a")!;
    assert.equal(anchor.textContent, "./notes/my file.md");
    const event = new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      anchor.dispatchEvent(event);
    });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(opened, [{ kind: "file", value: "./notes/my file.md" }]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("reference markers remain independent controls, never nested inside generated links", () => {
  const html = renderToStaticMarkup(
    createElement(
      MessageLinkContext.Provider,
      { value: () => {} },
      createElement(Markdown, {
        text: "`./file-ZENXMARKER.md`",
        inlineTokens: [
          {
            marker: "ZENXMARKER",
            copyText: "reference",
            node: createElement("button", null, "Reference"),
          },
        ],
      }),
    ),
  );
  assert.match(html, /<button>Reference<\/button>/u);
  assert.doesNotMatch(html, /<a /u);
});

test("percent-encoded filename punctuation is not mistaken for a source location", () => {
  for (const [href, expected] of [
    ["file:///work/note.md%23L12", "note.md#L12"],
    ["file:///work/name.md%3A12", "name.md:12"],
    ["./note.md%23L12", "note.md#L12"],
    ["./name.md%3A12", "name.md:12"],
  ]) {
    const target = classifyMessageLink(href!);
    assert.equal(target.kind, "file");
    if (target.kind === "file")
      assert.equal(messageFilePath(target.value, "/work"), expected);
  }
});

test("ambiguous unquoted spaces never create partial file targets", () => {
  for (const value of [
    "/Users/alice/My Report.md",
    "C:\\Program Files\\a.md",
    "C:/Program Files/a.md",
  ])
    assert.doesNotMatch(markup(value), /<a /u, value);
  assert.match(markup("`docs/my notes.md`"), /<a /u);
  assert.match(markup("`/etc/hosts`"), /<a /u);
  assert.doesNotMatch(markup("/etc/hosts"), /<a /u);
});

test("oversized path-like text stays inert", () => {
  const oversized = "a/".repeat(10000) + "tail";
  assert.equal(isLocalPath(oversized), false);
  assert.doesNotMatch(markup(`\`${oversized}\``), /<a /u);
});

test("Chinese sentence punctuation delimits bare paths without changing quoted filenames", () => {
  assert.match(
    markup("请查看 docs/long-notes.md，然后继续。"),
    /href="docs\/long-notes.md"/u,
  );
  assert.match(markup("`docs/报告（修订）.md`"), /<a /u);
});

test("file URL line suffixes resolve before decoding literal punctuation", () => {
  for (const [href, cwd, expected] of [
    ["file:///work/main.ts:12", "/work", "main.ts"],
    ["file:///work/main.ts:12:4", "/work", "main.ts"],
    ["file:///C:/work/main.ts:12:4", "C:/work", "main.ts"],
    ["file:///work/main.ts%3A12", "/work", "main.ts:12"],
    ["file:///work/main.ts%3A12%3A4", "/work", "main.ts:12:4"],
  ]) {
    const target = classifyMessageLink(href!);
    assert.equal(target.kind, "file");
    if (target.kind === "file")
      assert.equal(messageFilePath(target.value, cwd), expected);
  }
});

test("extensionless automatic paths require explicit relative or absolute prefixes", () => {
  assert.match(markup("`./docs/README`"), /<a /u);
  assert.match(markup('"../docs/README"'), /<a /u);
  assert.doesNotMatch(markup("`docs/README`"), /<a /u);
  assert.doesNotMatch(markup('"docs/README"'), /<a /u);
});

test("only closed text single-path blocks offer a separate file action", () => {
  for (const language of ["text", "plaintext"]) {
    const html = markup(`\`\`\`${language}\n/synthetic/work/AGENTS.md\n\`\`\``);
    assert.match(html, />Open file<|>打开文件</u);
    assert.match(
      html,
      /<pre><code>\/synthetic\/work\/AGENTS.md<\/code><\/pre>/u,
    );
    assert.doesNotMatch(html, /<a /u);
  }
  for (const source of [
    "```text\n/synthetic/work/AGENTS.md",
    "> ```text\n> /synthetic/a.md",
    "- ```text\n  /synthetic/a.md",
    "> ```text\n> /synthetic/a.md\n> ```",
    "```sh\n/synthetic/work/AGENTS.md\n```",
    "```\n/synthetic/work/AGENTS.md\n```",
    "```text\n/synthetic/a.md\n/synthetic/b.md\n```",
    "```text\ncat /synthetic/a.md\n```",
    "```text\n/synthetic/a.md;whoami\n```",
    "```text\n/synthetic/a.md&&whoami\n```",
    "```text\n/synthetic/my file.md\n```",
    "```text\nfile://remote/a.md\n```",
  ])
    assert.doesNotMatch(markup(source), />Open file<|>打开文件</u, source);
  assert.doesNotMatch(
    markup("```text\n/synthetic/a.md\n```", false),
    />Open file<|>打开文件</u,
  );
});

test("text path action opens once only on activation and preserves code copy", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    },
  });
  const opened: unknown[] = [];
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(
          MessageLinkContext.Provider,
          { value: (target) => opened.push(target) },
          createElement(Markdown, {
            text: "```text\n/synthetic/work/100%.md\n```",
          }),
        ),
      ),
    );
    assert.deepEqual(opened, []);
    assert.equal(
      document.querySelector("pre code")?.textContent,
      "/synthetic/work/100%.md",
    );
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      ".markdown-code-header button",
    );
    assert.equal(buttons.length, 2);
    await act(async () => buttons[0]!.click());
    assert.deepEqual(opened, [
      { kind: "file", value: "/synthetic/work/100%.md" },
    ]);
    await act(async () => buttons[1]!.click());
    assert.deepEqual(copied, ["/synthetic/work/100%.md"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("reference-bearing text blocks never offer a file action", () => {
  const html = renderToStaticMarkup(
    createElement(
      MessageLinkContext.Provider,
      { value: () => {} },
      createElement(Markdown, {
        text: "```text\n/synthetic/ZENXMARKER.md\n```",
        inlineTokens: [
          {
            marker: "ZENXMARKER",
            copyText: "reference",
            node: createElement("button", null, "Reference"),
          },
        ],
      }),
    ),
  );
  assert.doesNotMatch(html, />Open file<|>打开文件</u);
  assert.match(html, />Reference</u);
});
