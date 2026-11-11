import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  observeReading,
  verifyReading,
  scrollReadingTo,
  readingPathsChanged,
  readingPaths,
} from "../scripts/reading-main-ui-preview.mjs";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const box = (x = 100, right = 900) => ({
  visible: true,
  hit: true,
  disabled: false,
  rect: { x, right, y: 100, bottom: 700, width: right - x, height: 600 },
});
const state = () => ({
  horizontalOverflow: false,
  markdownCounts: Object.fromEntries(
    ["h1", "h2", "h3", "p", "ul", "ol", "table", "pre", "blockquote"].map(
      (t) => [t, 1],
    ),
  ),
  column: box(),
  thread: box(80, 920),
  composer: box(),
  editor: box(),
  primary: box(),
  table: box(),
  code: box(),
  questionReadErrors: [],
  telemetry: { informationUpdates: 0, protocolCalls: [], informationReads: [] },
  dock: null,
  queue: null,
  approval: null,
});
test("desktop reading verifies production rich content, shared width and actual dock/pending combinations", () => {
  verifyReading(state());
  const s = state();
  Object.assign(s, {
    dock: box(920, 1250),
    informationClose: box(),
    queue: box(),
    approval: box(),
    queueEdit: box(),
    allow: box(),
    deny: box(),
  });
  s.telemetry.informationReads.push({ kind: "thread", id: "thread-1" });
  verifyReading(s, { information: true, pending: true });
});
test("overflow, missing Markdown, covered controls and unintended bridge writes cannot pass", () => {
  for (const fault of [
    "overflow",
    "wide",
    "alignment",
    "missing-code",
    "missing-title",
    "editor",
    "table",
    "send",
    "write",
    "question-error",
  ]) {
    const s = state();
    if (fault === "overflow") s.horizontalOverflow = true;
    if (fault === "wide") s.column.rect.width = 900;
    if (fault === "alignment") s.composer.rect.x += 20;
    if (fault === "missing-code") s.code = null;
    if (fault === "missing-title") s.markdownCounts.h2 = 0;
    if (fault === "editor") s.editor.hit = false;
    if (fault === "table") s.table.rect.right = 1000;
    if (fault === "send") s.telemetry.protocolCalls.push("zen/turn/send");
    if (fault === "write") s.telemetry.informationUpdates = 1;
    if (fault === "question-error") s.questionReadErrors = ["failed"];
    assert.throws(() => verifyReading(s), undefined, fault);
  }
});
test("observer executes against production class structure without changing or fabricating geometry", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    '<div class="agent-copy"><div class="markdown-body"><h1>One</h1><h2>Two</h2><h3>Three</h3><p>Text</p><ul><li>Item</li></ul><ol><li>Step</li></ol><blockquote>Note</blockquote><div class="markdown-table-wrap"><table><tbody><tr><td>Result</td></tr></tbody></table></div><div class="markdown-code"><pre>code</pre></div></div></div>',
    { runScripts: "outside-only" },
  );
  try {
    dom.window.document.elementFromPoint = () => null;
    const count = dom.window.document.querySelectorAll("*").length;
    const s = dom.window.eval(`(${observeReading.toString()})()`);
    assert.equal(s.markdownCounts.h1, 1);
    assert.equal(s.markdownCounts.table, 1);
    assert.equal(s.markdownCounts.pre, 1);
    assert.equal(s.code.rect.height, 0, "JSDOM is not pixel evidence");
    assert.equal(dom.window.document.querySelectorAll("*").length, count);
  } finally {
    dom.window.close();
  }
});
test("scrolling is bounded native wheel input with observed progress, never DOM scroll mutation", async () => {
  const calls = [],
    evidence = {};
  let count = 0;
  await scrollReadingTo({
    send: async (...args) => calls.push(args),
    evaluate: async () => ({
      scrollTop: count++ ? 0 : 320,
      x: 500,
      y: 80,
      top: 0,
    }),
    evidence,
    theme: "light",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "Input.dispatchMouseEvent");
  assert.equal(calls[0][1].type, "mouseWheel");
  assert.equal(calls[0][1].deltaY, -320);
  assert.equal(evidence.readingScrollAttempts[0].matched, true);
  assert.doesNotMatch(
    scrollReadingTo.toString(),
    /scrollTop\s*=|scrollIntoView|\.focus\(|\.click\(/,
  );
});
test("missing reading target fails rather than scrolling to an invented location", async () => {
  await assert.rejects(
    scrollReadingTo({
      send: async () => assert.fail("no input"),
      evaluate: async () => ({ targetY: null, top: 0 }),
      evidence: {},
      theme: "light",
      target: ".missing",
    }),
    /production reading block exists/,
  );
});
test("dedicated profile is desktop-only, source-bound and independent of aggregate CI", async () => {
  const c = await read("../scripts/capture-main-ui-preview.mjs"),
    b = await read("../scripts/build-main-ui-preview.mjs"),
    w = await read("../../../.github/workflows/desktop-reading-ui.yml"),
    h = await read("../scripts/reading-main-ui-preview.mjs");
  assert.match(c, /desktopReading = captureProfile === "desktop-reading"/);
  assert.match(c, /desktopOnly \? "fine"/);
  assert.match(c, /options of desktopOnly/);
  assert.match(c, /c.width === 1280 && c.height === 900/);
  assert.match(c, /process.env.GITHUB_ACTIONS,\s*"true"/);
  assert.doesNotMatch(c, /['"]--no-sandbox/);
  assert.match(c, /Object.keys\(source.scenes\),\s*\["reading"\]/);
  assert.match(b, /reading-main-ui-preview.mjs/);
  assert.match(b, /connect-src 'none'/);
  assert.match(w, /desktop-reading" reading/);
  assert.match(w, /desktop-reading" desktop-reading/);
  assert.match(w, /fetch-depth: 2/);
  assert.match(w, /'HEAD\^', 'HEAD'/);
  assert.match(w, /steps.selection.outputs.needsCapture/);
  assert.doesNotMatch(w, /\bneeds:| coarse|npm run check/);
  for (const step of [
    "prose-top",
    "heading-list",
    "table-code",
    "information-reading",
    "pending-approval",
    "pending-information",
  ])
    assert(h.includes(`"${step}"`));
  assert.doesNotMatch(h, /\.click\(|\.focus\(|\.style\./);
  assert.match(h, /Input.insertText/);
  for (const path of readingPaths) assert(readingPathsChanged([path]));
  assert.equal(readingPathsChanged(["docs/ui-quality/evidence.png"]), false);
});

test("approval coexistence opens the real compact Queue disclosure before judging its actions", async () => {
  const source = await read("../scripts/reading-main-ui-preview.mjs");
  assert.match(source, /getAttribute\('aria-expanded'\) === 'false'/);
  const disclosure = source.indexOf('await click(".queue-shelf-toggle")');
  const edit = source.indexOf(
    "await wait(\"!!document.querySelector('.queue-row-edit:not(:disabled)')\")",
  );
  assert(disclosure > 0 && edit > disclosure);
  assert(source.indexOf('await save("pending-approval"', edit) > edit);
  assert.doesNotMatch(source, /setAttribute\(|\.click\(|\.focus\(/);
});
