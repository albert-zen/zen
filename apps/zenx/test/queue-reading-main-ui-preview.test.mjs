import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  verifyQueueReading,
  observeQueueReading,
  verifyQueueReturn,
  verifyQueueBridge,
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
  rect: { x: 100, right: 600, height: 100 },
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
  expanded: String(expanded),
  rowActions: [{ control: "edit", disabled: false, tabIndex: 0 }],
  returnAction: null,
  returnFooter: null,
  returnHost: { ...target(), rect: { height: 0 } },
  bridge: expanded
    ? {
        ...target(),
        controls: "pending",
        expanded: "true",
        focusVisible: false,
        hit: false,
        pointerEvents: "none",
        clipPath: "inset(50%)",
      }
    : null,
  returnPlacement: {
    ownerMatchesTray: true,
    outsideTray: true,
    followsTray: true,
    bridgeInHost: true,
    beforeComposer: true,
  },
  bottomZone: { ...target(), scrollsVertical: false },
});
test("keyboard bridge has no footer footprint and preserves row actions", () => {
  const baseline = returnState();
  verifyQueueReturn(baseline, baseline, false);
  verifyQueueReturn(returnState(true), baseline, true);
  for (const field of ["returnAction", "returnFooter"]) {
    const s = returnState(true);
    s[field] = target();
    assert.throws(() => verifyQueueReturn(s, baseline, true));
  }
  for (const mutate of [
    (s) => s.rowActions.pop(),
    (s) => (s.returnHost.rect.height = 8),
    (s) => (s.bridge = null),
    (s) => (s.bridge.hit = true),
    (s) => (s.bridge.controls = "another-thread"),
    (s) => (s.returnPlacement.outsideTray = false),
    (s) => (s.rowActions[0].tabIndex = -1),
    (s) => (s.rowActions[0].disabled = true),
    (s) => (s.toggle.hit = false),
    (s) => (s.controls = "wrong"),
    (s) => (s.bottomZone.scrollsVertical = true),
  ]) {
    const s = returnState(true);
    mutate(s);
    assert.throws(() => verifyQueueReturn(s, baseline, true));
  }
});
test("outer frame matches Composer exactly, including native scrollbar width", () => {
  const b = state();
  verifyQueueReading(b, b, false);
  for (const edge of ["x", "right"]) {
    const s = state();
    s.tray.rect[edge] += 8;
    assert.throws(() => verifyQueueReading(s, b, false), /outer frame/);
  }
});
test("header collapse requires its own visible keyboard focus", () => {
  const b = state(),
    s = state();
  s.expanded = "true";
  s.tray.rect.height = 300;
  verifyQueueReading(s, b, true, "toggle");
  s.toggle.focusVisible = false;
  assert.throws(
    () => verifyQueueReading(s, b, true, "toggle"),
    /Native keyboard/,
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
    selector: '[data-queue-control="reading-space"]:focus-visible',
    step: "reading-space",
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
      step: "reading-space",
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
test("header-only implementation retains localized accessibility and Composer focus on collapse", async () => {
  const q = await readFile(
    new URL("../src/renderer/src/QueuedMessages.tsx", import.meta.url),
    "utf8",
  );
  const t = await readFile(
    new URL("../src/renderer/src/ThreadView.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(q + t, /readingReturnHost|queue-reading-return-host/);
  assert.match(q, /integrated && readingExpanded && readingBridgeHost/);
  assert.match(q, /if \(event.key !== "Escape"\) return/);
  assert.doesNotMatch(
    q,
    /event.key === "Tab"|event.key !== "Tab"|tabIndex=\{[1-9]/,
  );
  assert.match(t, /readingBridgeHost=\{queueReadingBridgeHost\}/);
  assert.match(q, /aria-controls=\{viewportId\}/);
  assert.match(q, /if \(readingExpanded\) focusComposer\?\.\(\)/);
  assert.match(q, /name=\{readingExpanded \? "compress" : "expand"\}/);
  assert.match(
    q,
    /title=\{t\(\s*readingExpanded\s*\? "queueReduceReadingArea"/,
  );
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
  assert.match(
    h,
    /CSS.escape\(document.querySelector\('\.queue-reading-toggle'\).getAttribute\('aria-controls'\)\)/,
  );
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
      `<div class="bottom-zone"><div class="pending-tray" id="pending"><button class="queue-reading-toggle" aria-controls="pending"></button></div><form class="composer" style="--color-focus-ring:${hex};border:1px solid ${hex}"><div contenteditable="true"></div></form></div>`,
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

import { verifyQueueSenderAttribution } from "../scripts/queue-reading-main-ui-preview.mjs";
const attributionState = () => ({
  tray: { rect: { right: 1180 } },
  senderAttribution: {
    rowId: "synthetic-thread-message",
    sameRow: true,
    sourceText: "From Planning assistant",
    bodyText: "Exact known body",
    overflow: false,
    sourceLine: { visible: true, rect: { bottom: 450 } },
    source: {
      visible: true,
      hit: true,
      rect: { x: 540, right: 700, bottom: 450 },
    },
    bubble: { visible: true, hit: true, rect: { x: 540, right: 1020, y: 456 } },
  },
});
test("known sender attribution verifies own-message alignment without relaxing existing queue checks", () => {
  const s = attributionState();
  verifyQueueSenderAttribution(s);
  const detached = attributionState();
  detached.senderAttribution.source.rect.x = 370;
  assert.throws(() => verifyQueueSenderAttribution(detached), /own bubble/);
});
test("sender criterion rejects clipping, cross-row attribution, overflow and changed identities", () => {
  for (const mutate of [
    (s) => (s.senderAttribution.rowId = "other"),
    (s) => (s.senderAttribution.sameRow = false),
    (s) => (s.senderAttribution.source.hit = false),
    (s) => (s.senderAttribution.bubble.visible = false),
    (s) => (s.senderAttribution.overflow = true),
    (s) => (s.senderAttribution.sourceLine.rect.bottom = 400),
    (s) => (s.senderAttribution.sourceLine.rect.bottom = 470),
    (s) => (s.senderAttribution.bubble.rect.right = 1300),
    (s) => (s.senderAttribution.sourceText = "Other sender"),
    (s) => (s.senderAttribution.bodyText = "Other body"),
  ]) {
    const s = attributionState();
    mutate(s);
    assert.throws(() => verifyQueueSenderAttribution(s, attributionState()));
  }
});

test("source status line owns adjacency while actual source action stays hittable", () => {
  const s = attributionState();
  s.senderAttribution.source.rect.bottom = 430;
  verifyQueueSenderAttribution(s);
  s.senderAttribution.source.hit = false;
  assert.throws(() => verifyQueueSenderAttribution(s), /not covered/);
});

const bridgeState = () => ({
  ...returnState(true),
  tray: {
    rect: { x: 100, y: 200, width: 500, right: 600, bottom: 500, height: 300 },
  },
  composer: { rect: { x: 100, y: 506, width: 500, height: 100 } },
  bottomZone: { rect: { x: 80, y: 190, width: 540, height: 430 } },
  bridge: {
    ...target(),
    clipPath: "none",
    rect: { x: 400, y: 460, right: 592, bottom: 492, width: 192, height: 32 },
  },
});
test("focused bridge is reachable without geometry cost or Composer overlap", () => {
  const rest = bridgeState();
  verifyQueueBridge(bridgeState(), rest);
  for (const mutate of [
    (s) => (s.bridge.hit = false),
    (s) => (s.bridge.focusVisible = false),
    (s) => (s.bridge.clipPath = "inset(50%)"),
    (s) => (s.bridge.outlineWidth = 0),
    (s) => (s.bridge.rect.bottom = 510),
    (s) => (s.bridge.rect.y = 100),
    (s) => (s.composer.rect.y += 8),
    (s) => (s.bottomZone.rect.height += 8),
    (s) => (s.tray.rect.height -= 8),
  ]) {
    const s = bridgeState();
    mutate(s);
    assert.throws(() => verifyQueueBridge(s, rest));
  }
});
test("bridge host and approval reuse one gap token without changing coarse layouts", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/queued-messages.css", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /--bottom-zone-gap: 8px;\s*gap: var\(--bottom-zone-gap\)/,
  );
  assert.match(css, /@media \(min-width: 961px\) and \(pointer: fine\)/);
  assert.match(
    css,
    /margin-block-start: calc\(-1 \* var\(--bottom-zone-gap, 0px\)\)/,
  );
  assert.match(css, /queue-reading-bridge-host \{\s*display: none/);
  assert.match(css, /queue-reading-bridge:focus-visible/);
});
test("observer binds bridge and Composer to the selected thread, not a decoy", async () => {
  const { JSDOM } = await import("jsdom");
  const thread = (id) =>
    `<div class="thread-view"><div class="bottom-zone"><div class="pending-tray" id="${id}"><section class="queue-shelf"><button class="queue-reading-toggle" aria-controls="${id}" aria-expanded="true"></button><ul class="queue-shelf-list"><li class="queue-row"><button data-queue-control="edit"></button></li></ul></section></div><div class="queue-reading-bridge-host"><button data-queue-control="reading-bridge" aria-controls="${id}" aria-expanded="true"></button></div><form class="composer" id="composer-${id}"><textarea id="editor-${id}"></textarea></form></div></div>`;
  const dom = new JSDOM(thread("decoy") + thread("actual"), {
    runScripts: "outside-only",
  });
  try {
    dom.window.matchMedia = () => ({ matches: false });
    dom.window.document.elementFromPoint = () => null;
    const observe = () =>
      dom.window.eval(`(${observeQueueReading.toString()})("actual")`);
    const s = observe();
    assert.equal(s.trayId, "actual");
    assert.equal(s.composer.id, "composer-actual");
    assert.equal(s.editor.id, "editor-actual");
    assert.equal(s.bridge.controls, "actual");
    assert(Object.values(s.returnPlacement).every(Boolean));
    dom.window.document
      .querySelector("#actual + div button")
      .setAttribute("aria-controls", "decoy");
    assert.equal(observe().returnPlacement.ownerMatchesTray, false);
  } finally {
    dom.window.close();
  }
});
