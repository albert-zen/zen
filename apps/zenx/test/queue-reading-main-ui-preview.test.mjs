import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  verifyQueueReading,
  observeQueueReading,
  verifyQueueReturn,
  tabToQueueControl,
} from "../scripts/queue-reading-main-ui-preview.mjs";
const target = () => ({
  visible: true,
  hit: true,
  focused: true,
  focusVisible: true,
  disabled: false,
  outline: "solid",
  outlineWidth: 2,
  rect: { height: 100 },
});

const state = () => ({
  toggle: target(),
  expanded: "false",
  controls: "pending",
  trayId: "pending",
  tray: target(),
  composer: target(),
  editor: target(),
  edit: target(),
  backendNodeId: 1,
  scrollContainers: [],
  bodyReading: [
    { visibleHeight: 60, width: 400, height: 60, horizontalOverflow: false },
  ],
});

const returnState = (expanded = false) => ({
  ...state(),
  rowActions: [
    {
      control: "edit",
      classes: "queue-row-edit",
      disabled: false,
      tabIndex: 0,
    },
  ],
  returnAction: expanded
    ? { ...target(), controls: "pending", expanded: "true" }
    : null,
  returnFooter: expanded
    ? {
        ...target(),
        position: "static",
        rect: { y: 600, bottom: 634, height: 34 },
      }
    : null,
  lastRow: { ...target(), rect: { y: 500, bottom: 600, height: 100 } },
  composer: { ...target(), rect: { y: 700, height: 100 } },
});
test("return footer exists only when expanded and leaves row actions and writing space intact", () => {
  const baseline = returnState();
  verifyQueueReturn(baseline, baseline, false);
  verifyQueueReturn(returnState(true), baseline, true, true);
  const phantom = returnState(true);
  assert.throws(
    () => verifyQueueReturn(phantom, baseline, false),
    /no extra return/,
  );
});
test("return verification rejects missing controls, floating overlap and removed/retabbed actions", () => {
  for (const fault of [
    "missing",
    "controls",
    "sticky",
    "row-overlap",
    "composer-overlap",
    "removed-action",
    "disabled-action",
    "retabbed-action",
    "missing-row",
  ]) {
    const baseline = returnState(),
      s = returnState(true);
    if (fault === "missing") s.returnAction = null;
    if (fault === "controls") s.returnAction.controls = "wrong-tray";
    if (fault === "sticky") s.returnFooter.position = "sticky";
    if (fault === "row-overlap") s.returnFooter.rect.y = 598;
    if (fault === "composer-overlap") s.returnFooter.rect.bottom = 702;
    if (fault === "removed-action") s.rowActions = [];
    if (fault === "disabled-action") s.rowActions[0].disabled = true;
    if (fault === "retabbed-action") s.rowActions[0].tabIndex = -1;
    if (fault === "missing-row") s.lastRow = null;
    assert.throws(
      () => verifyQueueReturn(s, baseline, true, true),
      undefined,
      fault,
    );
  }
});
test("footer focus requires its own visible hit target while retaining the original header contract elsewhere", () => {
  const baseline = returnState(),
    s = returnState(true);
  s.expanded = "true";
  s.tray.rect.height = 300;
  s.toggle.visible = s.toggle.hit = false;
  verifyQueueReading(s, baseline, true, "returnAction");
  assert.throws(
    () => verifyQueueReading(s, baseline, true, "edit"),
    /Reading toggle remains reachable/,
  );
  s.returnAction.hit = false;
  assert.throws(
    () => verifyQueueReading(s, baseline, true, "returnAction"),
    /Native keyboard focus/,
  );
});
test("reverse-Tab distance counts actual native key pairs and stops at the observed return", async () => {
  const calls = [],
    evidence = {};
  let attempts = 0;
  const result = await tabToQueueControl({
    send: async (...args) => calls.push(args),
    observe: async () => ({ active: { inQueueRow: false } }),
    evaluate: async () => ++attempts === 3,
    evidence,
    options: { theme: "light" },
    selector: '[data-queue-control="reading-return"]:focus-visible',
    step: "reading-return",
    direction: "backward",
  });
  assert.equal(result.steps, 3);
  assert.equal(result.observations.length, 3);
  assert.equal(result.matched, true);
  assert.equal(result.theme, "light");
  assert.equal(calls.length, 6);
  assert(
    calls.every(
      ([method, event]) =>
        method === "Input.dispatchKeyEvent" &&
        event.key === "Tab" &&
        event.modifiers === 8,
    ),
  );
  assert.deepEqual(
    calls.map(([, event]) => event.type),
    ["rawKeyDown", "keyUp", "rawKeyDown", "keyUp", "rawKeyDown", "keyUp"],
  );
  assert.equal(evidence.queueReadingTabAttempts[0], result);
});
test("failed native search retains all 80 attempts without success or an enlarged budget", async () => {
  const evidence = {};
  let calls = 0;
  await assert.rejects(
    tabToQueueControl({
      send: async () => {
        calls++;
      },
      observe: async () => ({ active: { inQueueRow: true } }),
      evaluate: async () => false,
      evidence,
      options: { theme: "dark" },
      selector: "not-found",
      step: "reading-return",
      direction: "backward",
    }),
    /Native Tab failed/,
  );
  const result = evidence.queueReadingTabAttempts[0];
  assert.equal(result.steps, 80);
  assert.equal(result.limit, 80);
  assert.equal(result.matched, false);
  assert.equal(result.observations.length, 80);
  assert.equal(calls, 160);
});
test("observer uses production queue-shelf-list DOM and records return cost without geometry simulation", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    '<div class="pending-tray" id="pending"><section class="queue-shelf steer-shelf"><ul class="queue-shelf-list"><li class="queue-row" id="steer-last"></li></ul></section><section class="queue-shelf"><ul class="queue-shelf-list"><li class="queue-row"><button data-queue-control="edit">Edit</button></li><li class="queue-row" id="queued-last"><button disabled>Move</button></li></ul><div class="queue-reading-return"><button data-queue-control="reading-return" aria-expanded="true" aria-controls="pending">Less space</button></div></section></div>',
    { runScripts: "outside-only" },
  );
  try {
    dom.window.matchMedia = () => ({ matches: false });
    dom.window.document.elementFromPoint = () => null;
    const observed = dom.window.eval(`(${observeQueueReading.toString()})()`);
    assert(observed.lastRow);
    assert.equal(
      observed.lastRow.id,
      "queued-last",
      "Footer geometry is paired with its own Queue, never the earlier Steer list",
    );
    assert.equal(observed.returnAction.controls, "pending");
    assert.equal(observed.returnAction.expanded, "true");
    assert.equal(
      observed.returnFooter.rect.height,
      0,
      "JSDOM is not pixel evidence",
    );
    assert.equal(observed.rowActions.length, 2);
    assert.equal(observed.rowActions[1].disabled, true);
  } finally {
    dom.window.close();
  }
});

test("default, expanded and collapsed states preserve native container and Composer", () => {
  const b = state();
  verifyQueueReading(b, b, false);
  const s = state();
  s.expanded = "true";
  s.tray.rect.height = 300;
  verifyQueueReading(s, b, true, "edit");
  verifyQueueReading(b, b, false, "toggle");
});
test("reject replacement, missing gains, shrinking Composer and mismatched controls", () => {
  for (const fault of [
    "node",
    "gain",
    "composer",
    "editor",
    "controls",
    "covered",
    "focus",
  ]) {
    const b = state(),
      s = state();
    s.expanded = "true";
    s.tray.rect.height = 300;
    if (fault === "node") s.backendNodeId = 2;
    if (fault === "gain") s.tray.rect.height = 100;
    if (fault === "composer") s.composer.rect.height = 90;
    if (fault === "editor") s.editor.rect.height = 90;
    if (fault === "controls") s.controls = "other";
    if (fault === "covered") s.editor.hit = false;
    if (fault === "focus") s.edit.focusVisible = false;
    assert.throws(
      () => verifyQueueReading(s, b, true, "edit"),
      undefined,
      fault,
    );
  }
});
test("observer parses and does not mutate DOM", () => {
  assert.doesNotThrow(
    () => new Function(`return (${observeQueueReading.toString()})();`),
  );
  assert.doesNotMatch(
    observeQueueReading.toString(),
    /\.focus\(|\.click\(|\.setAttribute\(/,
  );
});
test("profile guards, receipts and independent workflow are retained", async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const c = await read("../scripts/capture-main-ui-preview.mjs"),
    b = await read("../scripts/build-main-ui-preview.mjs"),
    w = await read("../../../.github/workflows/desktop-queue-reading-ui.yml"),
    h = await read("../scripts/queue-reading-main-ui-preview.mjs");
  assert.match(c, /process.env.GITHUB_ACTIONS,\s*"true"/);
  assert.match(c, /process.platform, "linux"/);
  assert.doesNotMatch(c, /['"]--no-sandbox/);
  assert.match(c, /c.width === 1280 && c.height === 900/);
  assert.match(c, /Object.keys\(source.scenes\),\s*\["pending"\]/);
  assert.match(b, /queue-reading-main-ui-preview.test.mjs/);
  assert.match(h, /DOM.describeNode/);
  assert.match(h, /i < 80|i<80/);
  assert.match(h, /contenteditable/);
  assert.match(w, /desktop-queue/);
  assert.doesNotMatch(w, /\bneeds:| coarse|npm run check/);
});

test("incremental capture gate includes its own patch and excludes unrelated evidence/navigation", async () => {
  const { queueReadingPathsChanged, queueReadingPaths } =
    await import("../scripts/queue-reading-main-ui-preview.mjs");
  for (const path of queueReadingPaths)
    assert(queueReadingPathsChanged([path]));
  assert.equal(
    queueReadingPathsChanged([
      "docs/ui-quality/evidence.png",
      "apps/zenx/scripts/navigation-main-ui-preview.mjs",
    ]),
    false,
  );
  const workflow = await readFile(
    new URL(
      "../../../.github/workflows/desktop-queue-reading-ui.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /fetch-depth: 2/);
  assert.match(workflow, /'HEAD\^', 'HEAD'/);
  assert.doesNotMatch(workflow, /github.event.before/);
  assert.match(workflow, /steps.selection.outputs.needsCapture/);
});

test("failure retains diagnostic capture attempt without replacing original error", async () => {
  const { captureQueueReading } =
    await import("../scripts/queue-reading-main-ui-preview.mjs");
  const evidence = {},
    captures = [],
    error = new Error("synthetic readiness failure");
  await assert.rejects(
    () =>
      captureQueueReading({
        send: async (method) =>
          method === "DOM.getDocument"
            ? { root: { nodeId: 1 } }
            : method === "DOM.querySelector"
              ? { nodeId: 2 }
              : method === "DOM.describeNode"
                ? { node: { backendNodeId: 3 } }
                : {},
        evaluate: async () => state(),
        wait: async () => {
          throw error;
        },
        click: async () => {},
        capture: async (name) => {
          captures.push(name);
        },
        evidence,
        options: { name: "desktop-light", theme: "light" },
      }),
    (actual) => actual === error,
  );
  assert.deepEqual(captures, ["queue-reading-desktop-light-failed"]);
  assert.equal(evidence.queueReadingFailures.length, 1);
  assert.equal(evidence.queueReadingCases[0].backendNodeId, 3);
});

test("editor uses the Composer focus border, not a fabricated CodeMirror outline", () => {
  const b = state(),
    s = state();
  s.expanded = "true";
  s.tray.rect.height = 300;
  s.editor.outline = "none";
  s.editor.outlineWidth = 0;
  Object.assign(s.composer, {
    focusWithin: true,
    borderWidth: 1,
    borderColor: "rgb(77, 83, 97)",
    focusRing: "rgb(77, 83, 97)",
    forcedColors: false,
  });
  verifyQueueReading(s, b, true, "editor");
  s.composer.borderColor = "transparent";
  assert.throws(
    () => verifyQueueReading(s, b, true, "editor"),
    /Composer owns/,
  );
  s.composer.forcedColors = true;
  verifyQueueReading(s, b, true, "editor");
  s.composer.focusWithin = false;
  assert.throws(
    () => verifyQueueReading(s, b, true, "editor"),
    /Composer owns/,
  );
});

test("observer normalizes current hex focus tokens to computed RGB without inserting DOM", async () => {
  const { JSDOM } = await import("jsdom");
  for (const [hex, rgb] of [
    ["#4d5361", "rgb(77, 83, 97)"],
    ["#b4b6bd", "rgb(180, 182, 189)"],
  ]) {
    const dom = new JSDOM(
      `<form class="composer" style="--color-focus-ring:${hex};border:1px solid ${hex}"><div contenteditable="true"></div></form>`,
      { runScripts: "outside-only" },
    );
    try {
      dom.window.matchMedia = () => ({ matches: false });
      dom.window.document.elementFromPoint = () => null;
      const count = dom.window.document.querySelectorAll("*").length;
      const s = dom.window.eval(`(${observeQueueReading.toString()})()`);
      assert.equal(s.composer.focusRing, rgb);
      assert.equal(s.composer.borderColor, rgb);
      assert.equal(dom.window.document.querySelectorAll("*").length, count);
    } finally {
      dom.window.close();
    }
  }
});

test("empty tray bodies cannot masquerade as a real reading-space result", () => {
  const b = state(),
    s = state();
  s.bodyReading = [];
  assert.throws(
    () => verifyQueueReading(s, b, false),
    /real queued-message body/,
  );
});
