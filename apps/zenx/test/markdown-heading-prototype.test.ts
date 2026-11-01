import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Markdown,
  MessageLinkContext,
  type MarkdownInlineToken,
} from "../src/renderer/src/Markdown.js";

// Test-only candidate: no production behavior changes, cache, or stream history.
function headingChunks(
  text: string,
  inlineTokens: readonly MarkdownInlineToken[] = [],
): string[] {
  if (inlineTokens.length || /[<\r$]|`{3}|~{3}|^(?:[ \t]+\S|>|\[)/mu.test(text))
    return [text];
  const starts = [0];
  for (const match of text.matchAll(/\n[ \t]*\n(?=#{1,6}(?:[ \t]|$))/gmu)) {
    const start = match.index + match[0].length;
    if (text.slice(starts.at(-1), start).trim()) starts.push(start);
  }
  return starts.map((start, i) => text.slice(start, starts[i + 1]));
}

const callback = () => {};
function original(
  text: string,
  inlineTokens: readonly MarkdownInlineToken[] = [],
  links = false,
): string {
  return renderToStaticMarkup(
    createElement(
      MessageLinkContext.Provider,
      { value: links ? callback : null },
      createElement(Markdown, { text, inlineTokens }),
    ),
  );
}
function candidate(
  text: string,
  inlineTokens: readonly MarkdownInlineToken[] = [],
  links = false,
): string {
  const chunks = headingChunks(text, inlineTokens);
  if (chunks.length === 1) return original(text, inlineTokens, links);
  return (
    '<div class="markdown-body">' +
    chunks
      .map((chunk) =>
        original(chunk, inlineTokens, links).slice(
          '<div class="markdown-body">'.length,
          -6,
        ),
      )
      .join("\n") +
    "</div>"
  );
}

const cases: Record<string, string> = {
  paragraph: "First paragraph.\nSecond line.\n\nAnother paragraph.",
  headings:
    "# First\n\nprose **bold** and *emphasis*\n\n## Second\n\nTail.\n\n### Third",
  blankPrefix: "\n\n# First\n\n## Second\n",
  list: "# First\n\n- one\n- two\n\n## Second\n\n1. a\n2. b\n",
  looseList: "# First\n\n- one\n\n- two\n\n## Second\n\nend",
  table: "# First\n\n| A | B |\n| --- | --- |\n| x | y |\n\n## Second\n\nend",
  nested: "# First\n\n- one\n  - nested\n\n## Second",
  fences: "# First\n\n```text\n /tmp/a.md \n\n## Not heading\n```\n\n## Second",
  tildeFence: "# First\n\n~~~js\n\t a  \n\n## Not heading\n~~~\n\n## Second",
  refsLate:
    "# First\n\nA [reference][r].\n\n## Second\n\n[r]: https://example.com",
  multiline:
    "# First\n\n`open\n\n## Second\n\nclose` and [multi\nline](https://example.com)",
  footnote: "# First\n\nNote[^1].\n\n## Second\n\n[^1]: footnote",
  html: "# First\n\n<div>\n\n## Not heading\n\n</div>\n\n## Second",
  math: "# First\n\n$$\nx\n\n## Second\n\n$$",
  unicode: "# 中文😀\n\nhttps://example.com/你好。 and café\n\n## 二\n\nΔ é",
  crlf: "# First\r\n\r\nbody\r\n\r\n## Second",
  unsafe:
    "# First\n\nA [bad](javascript:alert(1)) and [bad](data:text/plain,x).\n\n## Second",
  local:
    "# First\n\nA `./中文%20file.md` and /tmp/a.md\n\n## Second\n\nA [file](file:///tmp/x%2520.md)",
  quote: "# First\n\n> quoted\n\n## Second",
  setext: "# First\n\nTitle\n=====\n\n## Second",
  thematic: "# First\n\n---\n\n## Second",
  trailingBreak: "# First\n\ntext  \n\n## Second\n\ntail\\\n",
  emptyHeading: "# First\n\n#\n\n## Second",
};

test("test-only heading segmentation equals the original production renderer at EVERY prefix", () => {
  for (const [name, source] of Object.entries(cases)) {
    for (const links of [false, true]) {
      for (let end = 0; end <= source.length; end++) {
        const prefix = source.slice(0, end);
        assert.equal(
          candidate(prefix, [], links),
          original(prefix, [], links),
          `${name}: prefix ${end}, links=${links}, source=${JSON.stringify(prefix)}`,
        );
      }
    }
  }
});

test("inline token source positions use whole production source", () => {
  const tokens = [
    {
      marker: "TOKEN",
      node: createElement("b", {}, "reference"),
      copyText: "reference",
    },
  ];
  const source =
    "# First\n\nTOKEN\n\n## Second\n\n[TOKEN](https://example.com)\n\n```text\nTOKEN  \n```";
  for (let end = 0; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    assert.deepEqual(headingChunks(prefix, tokens), [prefix]);
    assert.equal(
      candidate(prefix, tokens, true),
      original(prefix, tokens, true),
    );
  }
});

// One SSR call/root for both sides. Candidate retains each Markdown wrapper:
// a deliberately unshipped structural prototype, not a DOM-equivalence claim.
function initialCandidate(text: string): string {
  return renderToStaticMarkup(
    createElement(
      Fragment,
      {},
      ...headingChunks(text).map((chunk, key) =>
        createElement(Markdown, { key, text: chunk }),
      ),
    ),
  );
}

test("CPU experiment compares initial rendering, not browser latency", () => {
  for (const sections of [8, 64, 417]) {
    const source = Array.from(
      { length: sections },
      (_, i) =>
        `## Section ${i}\n\nThis is representative prose with **strong text** and a link https://example.com.\n\n- First item\n- Second item\n\n`,
    ).join("");
    assert.equal(candidate(source), original(source));
    original(source);
    initialCandidate(source);
    const samples = { original: [] as number[], candidate: [] as number[] };
    for (let i = 0; i < 7; i++) {
      for (const name of i % 2
        ? (["candidate", "original"] as const)
        : (["original", "candidate"] as const)) {
        const start = performance.now();
        (name === "original" ? original : initialCandidate)(source);
        samples[name].push(performance.now() - start);
      }
    }
    const median = (xs: number[]) =>
      xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    console.log(
      JSON.stringify({
        scope: "Node SSR CPU only; no React update/browser claim",
        chars: source.length,
        sections,
        originalMedianMs: median(samples.original),
        candidateMedianMs: median(samples.candidate),
      }),
    );
  }
});
