import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  syntheticSteerFocusText,
  observeQueueSteerFocus,
  verifyQueueSteerFocus,
  verifyQueueSteerFocusCandidate,
  verifyQueueSteerFocusGeometry,
  captureQueueSteerFocus,
  settleQueueSteerFocus,
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

const steerFocusState = () => ({
  rowRect: { x: 350, y: 420, right: 1150, bottom: 500, width: 800, height: 80 },
  scrollport: {
    id: "synthetic-tray",
    isQueueTray: true,
    rect: { x: 350, y: 300, right: 1150, bottom: 768, width: 800, height: 468 },
    top: 0,
    left: 0,
    clientWidth: 800,
    clientHeight: 468,
    scrollWidth: 800,
    scrollHeight: 800,
  },
  dock: { x: 350, y: 300, right: 1150, bottom: 884, width: 800, height: 584 },
  viewport: [1280, 900],
  outsideScroll: { page: [0, 0], messages: [0, 150] },
  transcript: {
    rect: { x: 264, y: 44, width: 1016, height: 856, right: 1280, bottom: 900 },
    clientHeight: 856,
    scrollHeight: 1006,
    tail: {
      text: "Synthetic answer tail",
      rect: { x: 350, y: 240, right: 650, bottom: 260, width: 300, height: 20 },
      visible: true,
      hit: true,
    },
  },
  rowCount: 1,
  text: syntheticSteerFocusText,
  source: "From Planning assistant",
  order: ["synthetic-thread-message", "queue-1"],
  running: true,
  composer: { x: 350, y: 774, width: 800, height: 110 },
  draft: "",
  button: {
    rect: { x: 1050, y: 420, right: 1078, bottom: 448, width: 28, height: 28 },
    focused: true,
    focusVisible: true,
    painted: true,
    disabled: false,
    label: "Steer queued message 1",
    nativeTitleAttribute: "At the next safe point",
    visibleText: "",
    hasIcon: true,
    outline: "solid",
    outlineWidth: 2,
  },
  sourceRect: {
    x: 350,
    y: 420,
    right: 500,
    bottom: 444,
    width: 150,
    height: 24,
  },
  bodyRect: {
    x: 350,
    y: 450,
    right: 1000,
    bottom: 490,
    width: 650,
    height: 40,
  },
  sourceClipped: false,
  hint: {
    text: "Steer now",
    rect: { x: 930, y: 423, right: 1000, bottom: 441, width: 70, height: 18 },
    visible: true,
    ariaHidden: "true",
    pointerEvents: "none",
  },
  paintedDomTooltips: [],
});

test("isolated Steer baseline uses native Tab without activating the action in either desktop theme", async () => {
  for (const theme of ["light", "dark"]) {
    const evidence = {},
      inputs = [],
      clicks = [],
      frames = [];
    let keyboardFocused = false;
    await captureQueueSteerFocus({
      options: { width: 1280, height: 900, theme, name: `desktop-${theme}` },
      evidence,
      send: async (method, args) => {
        inputs.push([method, args]);
        if (method === "Input.dispatchKeyEvent" && args.type === "keyUp")
          keyboardFocused = !keyboardFocused;
      },
      wait: async () => {},
      click: async (selector) => clicks.push(selector),
      evaluate: async (expression) => {
        if (expression === "location.href")
          return (
            "http://localhost/pending.html?theme=" +
            theme +
            "&hostQueue=1&many="
          );
        if (expression.startsWith("document.activeElement")) return true;
        const state = structuredClone(steerFocusState());
        state.hint.visible = keyboardFocused;
        state.button.focused = keyboardFocused;
        return state;
      },
      capture: async (...args) => frames.push(args),
    });
    const trip = evidence.queueSteerFocusTrips[0];
    assert.equal(trip.status, "passed");
    assert.equal(
      trip.held.button.visibleText,
      "",
      "Record current icon-only presentation without prescribing a fix",
    );
    assert.deepEqual(trip.held.paintedDomTooltips, []);
    assert.match(trip.nativeTooltipPixels, /Not established/);
    assert.equal(frames.length, 1);
    assert.equal(
      frames[0][0],
      `queue-reading-desktop-${theme}-steer-tab-candidate`,
    );
    assert.deepEqual(clicks, [".queue-reading-toggle"]);
    const navigation = new URL(inputs[0][1].url);
    assert.equal(navigation.searchParams.get("steerFocus"), "1");
    assert.equal(navigation.searchParams.has("hostQueue"), false);
    assert.equal(navigation.searchParams.get("lang"), "en");
    const keys = inputs.filter(
      ([method]) => method === "Input.dispatchKeyEvent",
    );
    assert.deepEqual(
      keys.map(([, p]) => [p.type, p.key]),
      [
        ["rawKeyDown", "Tab"],
        ["keyUp", "Tab"],
        ["rawKeyDown", "Tab"],
        ["keyUp", "Tab"],
      ],
    );
    assert.equal(evidence.queueReadingTabAttempts[0].matched, true);
  }
});

test("Steer focus acceptance rejects wrong content, hidden focus and changed queue or draft", () => {
  const before = steerFocusState();
  for (const mutate of [
    (s) => (s.text = "Short item"),
    (s) => (s.running = false),
    (s) => (s.source = null),
    (s) => (s.button.painted = false),
    (s) => (s.button.focusVisible = false),
    (s) => (s.button.outline = "none"),
    (s) => (s.button.outlineWidth = 0),
    (s) => s.order.reverse(),
    (s) => (s.draft = "changed"),
    (s) => s.composer.height++,
  ]) {
    const s = steerFocusState();
    mutate(s);
    assert.throws(() => verifyQueueSteerFocus(s, before));
  }
});

test("Steer baseline observer distinguishes native title from rendered DOM tooltip without changing the page", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    `<div class="bottom-zone"><div class="pending-tray" id="observe-queue" style="overflow-y:auto"><div class="queue-row" data-queue-id="synthetic-thread-message"><span class="message-source-link">From Planning assistant</span><div class="user-bubble">${syntheticSteerFocusText}</div><button data-queue-control="steer" aria-label="Steer queued message 1" title="At the next safe point"><svg></svg></button></div></div><form class="composer"><textarea></textarea><button class="action-orb stop"></button></form></div>`,
    { runScripts: "outside-only" },
  );
  try {
    dom.window.document.elementFromPoint = () => null;
    dom.window.document.getElementById("observe-queue").scrollTop = 3;
    const before = dom.window.document.body.innerHTML;
    const s = dom.window.eval(`(${observeQueueSteerFocus.toString()})()`);
    assert.equal(s.scrollport.id, "observe-queue");
    assert.equal(s.scrollport.isQueueTray, true);
    assert.equal(
      s.scrollport.top,
      3,
      "Observe actual queue scroll, not infer it from moved rows",
    );
    assert(s.dock);
    assert.deepEqual(Array.from(s.outsideScroll.page), [0, 0]);
    assert.equal(s.text, syntheticSteerFocusText);
    assert.equal(s.button.nativeTitleAttribute, "At the next safe point");
    assert.equal(s.button.visibleText, "");
    assert.deepEqual(Array.from(s.paintedDomTooltips), []);
    assert.equal(s.button.painted, false, "JSDOM is not pixel acceptance");
    assert.equal(dom.window.document.body.innerHTML, before);
  } finally {
    dom.window.close();
  }
});

test("new observation is appended after established queue captures and is opt-in only", async () => {
  const source = await readFile(
    new URL("../scripts/queue-reading-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  const fixture = await readFile(
    new URL("./fixtures/queue-steer-visual.tsx", import.meta.url),
    "utf8",
  );
  const call = source.lastIndexOf("await captureQueueSteerFocus({");
  assert(call > source.indexOf('await save("trigger-source-hover", true)'));
  assert.match(fixture, /text: params.has\("steerFocus"\)/);
  assert(fixture.includes(syntheticSteerFocusText));
  assert.doesNotMatch(
    captureQueueSteerFocus.toString(),
    /\.focus\(|\.click\(|scrollIntoView|scrollTop\s*=/,
  );
});

test("keyboard-only candidate rejects missing, clipped, overlapping or geometry-changing hints", () => {
  const before = steerFocusState();
  before.hint.visible = false;
  verifyQueueSteerFocusCandidate(steerFocusState(), before);
  for (const mutate of [
    (s) => (s.hint.visible = false),
    (s) => (s.hint.text = "Send into the current turn"),
    (s) => (s.hint.ariaHidden = "false"),
    (s) => (s.hint.pointerEvents = "auto"),
    (s) => (s.sourceClipped = true),
    (s) => (s.hint.rect.x = s.sourceRect.right),
    (s) => (s.hint.rect.bottom = s.bodyRect.y + 1),
    (s) => s.sourceRect.right++,
    (s) => s.bodyRect.y++,
    (s) => s.button.rect.width++,
  ]) {
    const state = steerFocusState();
    mutate(state);
    assert.throws(() => verifyQueueSteerFocusCandidate(state, before));
  }
});

function scrollSteerFocusState(state, delta) {
  state.scrollport.top += delta;
  for (const rect of [
    state.rowRect,
    state.sourceRect,
    state.bodyRect,
    state.button.rect,
    state.hint.rect,
  ]) {
    rect.y -= delta;
    rect.bottom -= delta;
  }
  return state;
}

test("a rigid three-pixel shift passes only when measured nearest-queue scroll explains every edge", () => {
  const before = steerFocusState();
  before.hint.visible = false;
  const scrolled = scrollSteerFocusState(steerFocusState(), 3);
  verifyQueueSteerFocusCandidate(scrolled, before);
  assert.deepEqual(verifyQueueSteerFocusGeometry(scrolled, before), {
    scrollDelta: { x: 0, y: 3 },
    roundingTolerancePx: 0.5,
  });
  for (const mutate of [
    (s) => (s.scrollport.top = 0),
    (s) => (s.scrollport.top = 2),
    (s) => (s.scrollport = null),
    (s) => (s.scrollport.isQueueTray = false),
    (s) => (s.scrollport.id = "another-owner"),
    (s) => s.scrollport.rect.y++,
    (s) => s.scrollport.scrollHeight++,
    (s) => s.scrollport.clientHeight++,
    (s) => s.dock.y++,
    (s) => s.viewport[1]++,
    (s) => s.outsideScroll.page[1]++,
    (s) => s.outsideScroll.messages[1]++,
    (s) => s.bodyRect.height++,
    (s) => s.sourceRect.y++,
    (s) => s.button.rect.x++,
    (s) => s.hint.rect.width++,
  ]) {
    const bad = structuredClone(scrolled);
    mutate(bad);
    assert.throws(() => verifyQueueSteerFocusCandidate(bad, before));
  }
});

test("failed candidate geometry retains the actual screenshot and before/after diagnostics but never passes", async () => {
  const evidence = {},
    frames = [];
  let focused = false;
  await assert.rejects(
    captureQueueSteerFocus({
      options: {
        width: 1280,
        height: 900,
        theme: "light",
        name: "desktop-light",
      },
      evidence,
      send: async (method, args) => {
        if (method === "Input.dispatchKeyEvent" && args.type === "keyUp")
          focused = true;
      },
      wait: async () => {},
      click: async () => {},
      evaluate: async (expression) => {
        if (expression === "location.href")
          return "http://localhost/pending.html?many=";
        if (expression.startsWith("document.activeElement")) return focused;
        const state = steerFocusState();
        state.hint.visible = focused;
        state.button.focused = focused;
        if (focused) {
          scrollSteerFocusState(state, 3);
          state.scrollport.top = 0; // Movement without measured scroll is not excused.
        }
        return state;
      },
      capture: async (name) => frames.push(name),
    }),
    /measured queue scroll alone/,
  );
  const trip = evidence.queueSteerFocusTrips[0];
  assert.equal(trip.status, "failed");
  assert.deepEqual(frames, ["queue-reading-desktop-light-steer-tab-candidate"]);
  assert.equal(trip.candidateScreenshot.captured, true);
  assert.equal(trip.candidateScreenshot.verification, "failed");
  assert.equal(trip.held.sourceRect.y - trip.before.sourceRect.y, -3);
  assert.equal(trip.afterScreenshot.sourceRect.y, trip.held.sourceRect.y);
  assert.equal(trip.afterBlur, undefined);
});

test("pre-keyboard readiness records initial auto-tail movement then requires a sustained stable real end", async () => {
  const trip = {};
  let samples = 0,
    waits = 0;
  const settled = await settleQueueSteerFocus({
    trip,
    pause: async () => {
      waits++;
    },
    observe: async () => {
      const state = steerFocusState();
      state.button.focused = false;
      state.hint.visible = false;
      state.transcript.scrollHeight = 1023;
      state.outsideScroll.messages[1] = samples++ < 3 ? 0 : 167;
      return state;
    },
  });
  assert.equal(trip.preKeyboardReadiness.status, "passed");
  assert.equal(trip.preKeyboardReadiness.samples.length, 14);
  assert.equal(waits, 13);
  assert.equal(
    trip.preKeyboardReadiness.samples[0].outsideScroll.messages[1],
    0,
  );
  assert.equal(settled.outsideScroll.messages[1], 167);
  assert.equal(trip.preKeyboardReadiness.stableSamples, 11);
});

test("readiness cannot bless an unsettled initial frame, persistent drift, or content mutation", async () => {
  for (const fault of ["not-at-end", "drift", "draft", "tail-covered"]) {
    const trip = {};
    let index = 0;
    await assert.rejects(
      settleQueueSteerFocus({
        trip,
        pause: async () => {},
        observe: async () => {
          const state = steerFocusState();
          state.button.focused = false;
          state.hint.visible = false;
          if (fault === "not-at-end") state.outsideScroll.messages[1] = 0;
          if (fault === "drift") state.sourceRect.y = 420 + (index % 2);
          if (fault === "draft" && index > 0) state.draft = "changed";
          if (fault === "tail-covered") state.transcript.tail.hit = false;
          index++;
          return state;
        },
      }),
    );
    assert.equal(trip.preKeyboardReadiness.status, "failed");
    assert(trip.preKeyboardReadiness.samples.length <= 30);
  }
});

test("unsettled initial transcript retains all measurements and dispatches no Tab or candidate screenshot", async () => {
  const evidence = {},
    inputs = [],
    frames = [];
  await assert.rejects(
    captureQueueSteerFocus({
      options: {
        width: 1280,
        height: 900,
        theme: "light",
        name: "desktop-light",
      },
      evidence,
      send: async (method, args) => inputs.push([method, args]),
      wait: async () => {},
      click: async (selector) =>
        assert.equal(selector, ".queue-reading-toggle"),
      evaluate: async (expression) => {
        if (expression === "location.href")
          return "http://localhost/pending.html?many=";
        const state = steerFocusState();
        state.button.focused = false;
        state.hint.visible = false;
        state.outsideScroll.messages[1] = 0;
        return state;
      },
      capture: async (name) => frames.push(name),
    }),
    /did not settle before keyboard input/,
  );
  const trip = evidence.queueSteerFocusTrips[0];
  assert.equal(trip.status, "failed");
  assert.equal(trip.preKeyboardReadiness.status, "failed");
  assert.equal(trip.preKeyboardReadiness.samples.length, 30);
  assert.equal(evidence.queueReadingTabAttempts, undefined);
  assert.equal(
    inputs.filter(([method]) => method === "Input.dispatchKeyEvent").length,
    0,
  );
  assert.deepEqual(frames, []);
});
