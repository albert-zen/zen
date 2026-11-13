import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  informationDockReady,
  observeReading,
  verifyApprovalMode,
  tabToApprovalToggle,
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

test("observer measures both production virtual and legacy content columns, not only the absent legacy node", async () => {
  const { JSDOM } = await import("jsdom");
  for (const klass of [
    "virtual-transcript-header",
    "virtual-transcript-row",
    "messages-inner",
  ]) {
    const dom = new JSDOM(
      `<div class="thread-view"><div class="messages"><div class="${klass}"></div></div></div>`,
      { runScripts: "outside-only" },
    );
    try {
      dom.window.document.elementFromPoint = () => null;
      const observed = dom.window.eval(`(${observeReading.toString()})()`);
      assert(observed.column);
      assert.equal(observed.columnKind, klass);
      assert.equal(
        observed.column.rect.width,
        0,
        "DOM structure test, not pixel evidence",
      );
      assert.equal(observed.messageScrollbarWidth, 0);
    } finally {
      dom.window.close();
    }
  }
});

test("the observed five-pixel native-scrollbar drift still fails shared-column alignment", () => {
  const s = state();
  s.column = box(366.5, 1166.5);
  s.thread = box(264, 1279);
  s.composer = box(371.5, 1171.5);
  s.table = box(366.5, 1166.5);
  s.code = box(366.5, 1166.5);
  assert.throws(() => verifyReading(s), /shared column alignment/);
  s.column = null;
  assert.throws(() => verifyReading(s), /reading column respects/);
});

const approvalState = (reading = false) => ({
  approvalToggle: {
    ...box(),
    expanded: String(!reading),
    controls: "region",
    focused: true,
    focusVisible: true,
    outline: "solid",
    outlineWidth: 2,
  },
  approvalControlledRegion: true,
  approvalReading: reading,
  draft: "synthetic draft",
  composer: box(),
  approval: { ...box(), rect: { ...box().rect, height: reading ? 100 : 250 } },
  approvalRequestId: "same",
  approvalBody: reading ? null : box(),
  approvalSummary: reading ? box() : null,
  allow: reading ? null : box(),
  deny: reading ? null : box(),
  approvalSummaryText: reading
    ? "run_code · Request to remember permission · Waiting for your review. No decision has been made."
    : null,
  conversationUncoveredHeight: reading ? 400 : 250,
});
test("explicit approval reading preserves scope, no-decision and focus while default and restore keep full review", () => {
  const full = approvalState();
  verifyApprovalMode(full, { reading: false });
  verifyApprovalMode(approvalState(true), {
    reading: true,
    baseline: full,
    focus: true,
  });
  verifyApprovalMode(approvalState(), {
    reading: false,
    baseline: full,
    focus: true,
  });
  for (const fault of [
    "decision",
    "scope",
    "ambiguous-scope",
    "pending",
    "focus",
    "draft",
    "no-gain",
    "owner",
  ]) {
    const s = approvalState(true);
    if (fault === "decision") s.allow = box();
    if (fault === "scope")
      s.approvalSummaryText = "run_code Waiting for your review. No decision";
    if (fault === "ambiguous-scope")
      s.approvalSummaryText =
        "run_code · Remembered permission · Waiting for your review. No decision has been made.";
    if (fault === "pending")
      s.approvalSummaryText = "run_code Request to remember permission";
    if (fault === "focus") s.approvalToggle.focusVisible = false;
    if (fault === "draft") s.draft = "changed";
    if (fault === "no-gain") s.conversationUncoveredHeight = 250;
    if (fault === "owner") s.approvalToggle.controls = "wrong-region";
    assert.throws(
      () =>
        verifyApprovalMode(s, { reading: true, baseline: full, focus: true }),
      undefined,
      fault,
    );
  }
});
test("approval disclosure search uses native bounded Tab pairs and observed focus", async () => {
  const evidence = {},
    calls = [];
  let n = 0;
  const result = await tabToApprovalToggle({
    send: async (...a) => calls.push(a),
    evaluate: async () => ({
      matched: ++n === 2,
      tag: "BUTTON",
      id: "synthetic",
    }),
    evidence,
    theme: "dark",
  });
  assert.equal(result.steps, 2);
  assert.equal(result.observations.length, 2);
  assert(result.matched);
  assert.equal(calls.length, 4);
  assert(
    calls.every(([m, p]) => m === "Input.dispatchKeyEvent" && p.key === "Tab"),
  );
  assert.deepEqual(
    calls.map(([, p]) => p.type),
    ["rawKeyDown", "keyUp", "rawKeyDown", "keyUp"],
  );
});
test("approval trip adds exactly three frames per theme and never invokes a decision", async () => {
  const h = await read("../scripts/reading-main-ui-preview.mjs"),
    w = await read("../../../.github/workflows/desktop-reading-ui.yml");
  for (const step of [
    "approval-explicit-reading",
    "approval-restored",
    "approval-new-request",
  ])
    assert(h.includes(`"${step}"`));
  assert.match(h, /synthetic-host-request-replacement/);
  assert.doesNotMatch(
    h,
    /click\([^\n]*(?:approval-request-allow|approval-request-deny)|respondToApproval\(/,
  );
  assert.match(h, /dispatchNavigationKey\(send, "Enter", "Enter", 13\)/);
  for (const file of [
    "ApprovalRequestCard.tsx",
    "approval-request.css",
    "i18n/shell.ts",
  ]) {
    assert(h.includes(file));
    assert(w.includes(file));
  }
});

// Keep the screenshot contract tied to the production English text, not just
// a synthetic measurement object. Chinese copy has separate component tests.
test("reading capture requires request wording from the production permission label", async () => {
  const copy = await read("../src/renderer/src/i18n/shell.ts");
  const capture = await read("../scripts/reading-main-ui-preview.mjs");
  assert.match(
    copy,
    /approvalRememberedShortScope: "Request to remember permission"/,
  );
  assert.match(copy, /approvalOnceShortScope: "Request: this call only"/);
  assert.match(
    capture,
    /assert\.match\(s\.approvalSummaryText, \/Request to remember permission\/\)/,
  );
  assert.doesNotMatch(
    capture,
    /assert\.match\(s\.approvalSummaryText, \/Remembered permission\/\)/,
  );
});

test("Information readiness follows the sole expanded toggle and visible dock, never a duplicate close control", async () => {
  const dock = {
    id: "information-1",
    hidden: false,
    getBoundingClientRect: () => ({ width: 340, height: 300 }),
  };
  let expanded = true;
  let controls = "information-1";
  let mounted = true;
  const toggle = { disabled: false, getAttribute: () => controls };
  const root = {
    querySelector: (selector) =>
      selector === ".information-dock"
        ? mounted
          ? dock
          : null
        : expanded
          ? toggle
          : null,
  };
  assert.equal(informationDockReady(root), true);
  expanded = false;
  assert.equal(informationDockReady(root), false);
  expanded = true;
  controls = "another-owner";
  assert.equal(informationDockReady(root), false);
  controls = dock.id;
  dock.hidden = true;
  assert.equal(informationDockReady(root), false);
  dock.hidden = false;
  mounted = false;
  assert.equal(informationDockReady(root), false);
  const source = await read("../scripts/reading-main-ui-preview.mjs");
  assert.match(source, /informationDockReady\.toString\(\)/);
  assert.doesNotMatch(source, /information-dismiss-toolbar/);
});

test("scrollbar lifecycle changes trigger both short-reading path gates", async () => {
  const path = "apps/zenx/src/renderer/src/scrollbar-visibility.ts";
  assert.equal(readingPathsChanged([path]), true);
  assert.equal(
    readingPathsChanged(["docs/ui-quality/evidence/example.png"]),
    false,
  );
  const workflow = await read(
    "../../../.github/workflows/desktop-reading-ui.yml",
  );
  assert(workflow.includes(`      - ${path}\n`));
  assert.match(workflow, /timeout-minutes: 6/);
});

// Optional data scene, exercised by the existing desktop-reading capture only.
import {
  inlineTraceGeometryReady,
  verifyInlineTrace,
} from "../scripts/inline-trace-main-ui-preview.mjs";

test("inline trace waits when output becomes visible before its full panel", () => {
  const state = {
    turns: [
      { answerMarker: { visible: true } },
      {
        answerMarker: { visible: true },
        failedOutput: { visible: true },
        traces: [{ expanded: "true", visible: true, detailVisible: false }],
      },
    ],
    dockOpen: true,
    dockVisible: true,
  };
  assert.equal(inlineTraceGeometryReady(state, true), false);
  state.turns[1].traces[0].detailVisible = true;
  assert.equal(inlineTraceGeometryReady(state, true), true);
  state.turns[0].answerMarker.visible = false;
  assert.equal(inlineTraceGeometryReady(state, true), false);
  state.turns[0].answerMarker.visible = true;
  assert.equal(inlineTraceGeometryReady(state, false), false);
  state.turns[1].failedOutput.visible = false;
  assert.equal(inlineTraceGeometryReady(state, false), true);
  assert.equal(inlineTraceGeometryReady({ ...state, turns: [] }, false), false);
});
test("inline trace preserves answers, Information and mutation-free bridge", () => {
  const baseline = {
    turns: [
      {
        answer: "Summary checked",
        expanded: "false",
        traces: [],
        answerMarker: { visible: true },
        failedOutput: { visible: false },
      },
      {
        answer: "Label check needs attention",
        expanded: "true",
        traces: [{ expanded: "false" }],
        answerMarker: { visible: true },
        failedOutput: { visible: false },
      },
    ],
    dockOpen: true,
    dockVisible: true,
    telemetry: {
      informationUpdates: 0,
      machineThreadCreateCalls: 0,
      sideChatCreateCommandCalls: 0,
      protocolCalls: [],
      informationReads: [],
    },
  };
  verifyInlineTrace(baseline, null, false);
  const next = structuredClone(baseline);
  next.turns[1].failedOutput.visible = true;
  next.turns[1].text = "Expected reader_name, received reader_label";
  next.turns[1].traces = [
    {
      expanded: "true",
      visible: true,
      detailVisible: true,
      detailText: "Expected reader_name, received reader_label",
    },
  ];
  next.telemetry.informationReads.push({ kind: "thread", id: "thread-1" });
  verifyInlineTrace(next, baseline, true);
  for (const mutate of [
    (s) => (s.dockVisible = false),
    (s) => (s.turns[0].answerMarker.visible = false),
    (s) => (s.turns[1].failedOutput.visible = false),
    (s) => (s.turns[0].expanded = "true"),
    (s) => (s.turns[1].answer = "lost"),
    (s) => s.telemetry.informationUpdates++,
    (s) => s.telemetry.sideChatCreateCommandCalls++,
    (s) => s.telemetry.protocolCalls.push("zen/turn/send"),
  ]) {
    const bad = structuredClone(next);
    mutate(bad);
    assert.throws(() => verifyInlineTrace(bad, baseline, true));
  }
});
test("inline trace uses native pointer and stays desktop scoped", async () => {
  const module = await read("../scripts/inline-trace-main-ui-preview.mjs");
  const parent = await read("../scripts/reading-main-ui-preview.mjs");
  assert.match(
    module,
    /section\.turn:has\(\.agent-copy \[data-thread-find-item-id=/,
  );
  assert.doesNotMatch(module, /section\.turn\[data-read-message-id=/);
  assert.match(module, /mousePressed/);
  assert.match(module, /mouseReleased/);
  assert.match(module, /mouseWheel/);
  assert.doesNotMatch(module, /\.click\(\)|dispatchEvent\(/);
  assert.match(module, /inlineTrace.*1/);
  assert.match(parent, /await captureInlineTrace/);
  assert.match(
    await read("../scripts/build-main-ui-preview.mjs"),
    /"apps\/zenx\/scripts\/inline-trace-main-ui-preview\.mjs"/,
  );
  assert.equal(
    readingPathsChanged(["apps/zenx/scripts/inline-trace-main-ui-preview.mjs"]),
    true,
  );
});

test("inline trace observer rejects retained, ancestor-hidden and clipped original output", async () => {
  const { JSDOM } = await import("jsdom");
  const { observeInlineTrace } =
    await import("../scripts/inline-trace-main-ui-preview.mjs");
  const dom = new JSDOM(
    `<div class="messages"><section class="turn"><div class="agent-copy"><h2>Summary checked</h2></div></section><section class="turn"><div class="agent-copy"><h2>Label check needs attention</h2></div><div id="clip" style="overflow-x:hidden;overflow-y:hidden"><div id="detail"><span>Expected reader_name, received reader_label</span></div></div></section></div><div class="composer"></div><div class="information-dock"></div>`,
  );
  const keys = [
    "document",
    "window",
    "NodeFilter",
    "getComputedStyle",
    "innerWidth",
    "innerHeight",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  let clipHeight = 100,
    outputX = 100;
  const rect = (x, y, width, height) => ({
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height,
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.className === "messages") return rect(0, 0, 900, 700);
    if (this.className === "composer") return rect(0, 700, 900, 100);
    if (this.id === "clip") return rect(90, 280, 600, clipHeight);
    return rect(90, 290, 600, 60);
  };
  for (const [name, dimension] of [
    ["clientWidth", "width"],
    ["clientHeight", "height"],
  ])
    Object.defineProperty(dom.window.HTMLElement.prototype, name, {
      get() {
        return this.getBoundingClientRect()[dimension];
      },
    });
  dom.window.Range.prototype.getBoundingClientRect = function () {
    return rect(
      this.startContainer.textContent.includes("Expected") ? outputX : 100,
      300,
      300,
      20,
    );
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    innerWidth: 1280,
    innerHeight: 900,
  });
  dom.window.__uiPolishTelemetry = {};
  try {
    const read = () => observeInlineTrace().turns[1].failedOutput;
    const clip = document.getElementById("clip");
    assert.equal(read().visible, true);
    clipHeight = 10;
    assert.equal(
      read().visible,
      false,
      "Range can stay full while overflow parent clips",
    );
    clipHeight = 100;
    for (const attr of ["hidden", "inert", "aria-hidden"]) {
      clip.setAttribute(attr, attr === "aria-hidden" ? "true" : "");
      assert.equal(read().visible, false, attr);
      clip.removeAttribute(attr);
    }
    clip.style.visibility = "hidden";
    assert.equal(read().visible, false);
    clip.style.visibility = "";
    clip.style.opacity = "0";
    assert.equal(read().visible, false);
    clip.style.opacity = "";
    outputX = 1000;
    assert.equal(
      read().visible,
      false,
      "off transcript even if DOM range exists",
    );
    outputX = 100;
    assert.equal(read().visible, true, "restored visible geometry");
  } finally {
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});
