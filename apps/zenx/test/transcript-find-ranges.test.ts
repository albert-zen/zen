import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  transcriptFindRange,
  paintTranscriptFindRange,
} from "../src/renderer/src/transcript-find-ranges.js";
import {
  markdownFindBlocks,
  searchTranscript,
} from "../src/renderer/src/transcript-find-index.js";

test("connected exact ranges span inline formatting, match source blocks and ignore controls/hidden copies", () => {
  const dom = new JSDOM(
    `<main><section data-thread-find-item-id="i"><p>Hello <strong>bold</strong> <a>label</a> &amp; <code>code</code></p><p>Second bold label</p><div hidden>bold label</div><span data-thread-find-ignore>bold label</span></section></main>`,
  );
  const viewport = dom.window.document.querySelector("main")!;
  const blocks = markdownFindBlocks(
    "Hello **bold** [label](secret-url) &amp; `code`\n\nSecond bold label",
  );
  const matches = searchTranscript(
    [{ turnId: "t", itemId: "i", field: "body", blocks, disclosures: [] }],
    "bold label",
  );
  assert.equal(matches.length, 2);
  assert.equal(
    transcriptFindRange(viewport, matches[0]!, "bold label")?.toString(),
    "bold label",
  );
  assert.equal(
    transcriptFindRange(viewport, matches[1]!, "bold label")?.toString(),
    "bold label",
  );
  assert.equal(
    transcriptFindRange(
      viewport,
      { ...matches[0]!, occurrence: 2 },
      "bold label",
    ),
    null,
  );
  viewport.remove();
  assert.equal(transcriptFindRange(viewport, matches[0]!, "bold label"), null);
  dom.window.close();
});

test("CSS Highlight paints exact range without replacing native user selection, including multiple owners", () => {
  const dom = new JSDOM(
    `<main><p data-thread-find-item-id="i">keep selected, find needle</p></main>`,
  );
  const document = dom.window.document;
  const ranges = new Map();
  Object.defineProperty(dom.window, "CSS", { value: { highlights: ranges } });
  Object.defineProperty(dom.window, "Highlight", {
    value: class extends Set {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  });
  const viewport = document.querySelector("main")!;
  const selection = document.getSelection()!;
  const user = document.createRange();
  user.setStart(viewport.firstChild!.firstChild!, 0);
  user.setEnd(viewport.firstChild!.firstChild!, 4);
  selection.addRange(user);
  const match = {
    entry: {
      turnId: "t",
      itemId: "i",
      field: "body" as const,
      blocks: ["keep selected, find needle"],
      disclosures: [],
    },
    occurrence: 0,
  };
  const found = transcriptFindRange(viewport, match, "needle")!;
  assert.equal(found.toString(), "needle");
  const ownerA = {},
    ownerB = {};
  assert.equal(paintTranscriptFindRange(document, ownerA, found), true);
  paintTranscriptFindRange(document, ownerB, found);
  assert.equal(ranges.get("zenx-thread-find-active").size, 1);
  paintTranscriptFindRange(document, ownerA, null);
  assert.equal(ranges.has("zenx-thread-find-active"), true);
  paintTranscriptFindRange(document, ownerB, null);
  assert.equal(ranges.has("zenx-thread-find-active"), false);
  assert.equal(selection.toString(), "keep");
  assert.equal(selection.getRangeAt(0), user);
  dom.window.close();
});

test("code copy controls and image UI never shift the product occurrence identity", () => {
  const dom = new JSDOM(
    `<main><div data-thread-find-item-id="i"><div class="markdown-code"><div class="markdown-code-header">text<button>Copy</button></div><pre><code>Copy source</code></pre></div><p>left<button class="markdown-image">Loading image</button>right</p></div></main>`,
  );
  const viewport = dom.window.document.querySelector("main")!;
  const blocks = markdownFindBlocks(
    "```\nCopy source\n```\n\nleft![alt](image.png)right",
  );
  assert.deepEqual(blocks, ["Copy source", "left", "right"]);
  const match = searchTranscript(
    [{ turnId: "t", itemId: "i", field: "body", blocks, disclosures: [] }],
    "Copy",
  )[0]!;
  const range = transcriptFindRange(viewport, match, "Copy")!;
  assert.equal(range.startContainer.parentElement?.tagName, "CODE");
  assert.equal(range.toString(), "Copy");
  assert.equal(searchTranscript([match.entry], "leftright").length, 0);
  dom.window.close();
});
