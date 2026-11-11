import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertNavigationState,
  dispatchNavigationKey,
  navigationDraft,
  observeNavigation,
} from "../scripts/navigation-main-ui-preview.mjs";

// Synthetic geometry exercises observation/assertion failures only. Browser
// evidence must come from sandboxed Chrome, never these JSDOM/model boxes.
const target = (overrides = {}) => ({
  rect: { x: 1100, y: 50, right: 1130, bottom: 80, width: 30, height: 30 },
  fullyVisible: true,
  centerHit: true,
  focused: false,
  focusVisible: false,
  hovered: false,
  current: "page",
  background: "primary",
  region: "no-drag",
  outline: { style: "solid", width: "2px", color: "blue" },
  ...overrides,
});
const state = () => ({
  draft: navigationDraft,
  telemetry: {
    informationUpdates: 0,
    informationReads: [{ kind: "thread", id: "thread-1" }],
    protocolCalls: [],
  },
  projects: target({ expanded: "true" }),
  project: target(),
  recent: target({ background: "alias" }),
  entry: target({ expanded: "true" }),
  titlebar: target({
    rect: { x: 260, y: 40, right: 1280, bottom: 90, width: 1020 },
  }),
  close: target({
    rect: { x: 1100, y: 100, right: 1130, bottom: 130, width: 30, height: 30 },
  }),
  chat: target({ rect: { right: 900 } }),
  dock: target({ rect: { x: 920 } }),
  popover: null,
  composer: target(),
  informationTitleCount: 2,
  questionReadErrors: [],
});

test("Enter uses native character-producing CDP events; Escape stays nonprinting", async () => {
  for (const [key, code, number] of [
    ["Enter", "Enter", 13],
    ["Escape", "Escape", 27],
  ]) {
    const calls = [];
    await dispatchNavigationKey(
      async (...args) => calls.push(args),
      key,
      code,
      number,
    );
    assert.equal(calls.length, 2);
    assert(calls.every(([method]) => method === "Input.dispatchKeyEvent"));
    assert.deepEqual(calls[0][1], {
      type: key === "Enter" ? "keyDown" : "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: number,
      ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
    assert.deepEqual(calls[1][1], {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: number,
    });
  }
});

test("navigation question fixture returns a real empty native page only for the exact owner", async () => {
  const { tsImport } = await import("tsx/esm/api");
  const { readNavigationQuestions } = await tsImport(
    "./fixtures/ui-polish-visual-navigation.ts",
    import.meta.url,
  );
  assert.deepEqual(readNavigationQuestions({ threadId: "thread-1" }), {
    questions: [],
    totalPending: 0,
  });
  for (const request of [
    undefined,
    "thread-1",
    [],
    {},
    { threadId: "other" },
    { threadId: "thread-1", afterQuestionCallItemId: "unexpected" },
  ])
    assert.throws(
      () => readNavigationQuestions(request),
      /Unexpected synthetic/,
    );
  const bad = state();
  bad.questionReadErrors = ["Loading failed"];
  assert.throws(() => assertNavigationState(bad), /visible error/);
});

test("normal titlebar dock accepts clear entry/close, real content and preserved draft", () => {
  assert.doesNotThrow(() =>
    assertNavigationState(state(), { mode: "information-open" }),
  );
});
test("a measured entry may extend below a short title row without a false failure", () => {
  const s = state();
  s.titlebar.rect.bottom = 60;
  assert(s.entry.rect.bottom > s.titlebar.rect.bottom);
  assert.doesNotThrow(() =>
    assertNavigationState(s, { mode: "information-open" }),
  );
});
test("dock checks reject overlap, covered controls, missing content and clipped Composer", () => {
  for (const fault of [
    "close-overlap",
    "entry-covered",
    "close-covered",
    "chat-covered",
    "composer-clipped",
    "empty-card",
    "draggable-entry",
    "no-read",
  ]) {
    const s = state();
    if (fault === "close-overlap") s.close.rect.y = 79;
    if (fault === "entry-covered") s.entry.centerHit = false;
    if (fault === "close-covered") s.close.centerHit = false;
    if (fault === "chat-covered") s.chat.rect.right = 930;
    if (fault === "composer-clipped") s.composer.fullyVisible = false;
    if (fault === "empty-card") s.informationTitleCount = 0;
    if (fault === "draggable-entry") s.entry.region = "drag";
    if (fault === "no-read") s.telemetry.informationReads = [];
    assert.throws(
      () => assertNavigationState(s, { mode: "information-open" }),
      undefined,
      fault,
    );
  }
});
test("close and Escape checks require actual closure and return to the real entry", () => {
  const s = state();
  s.dock = null;
  s.entry.expanded = "false";
  s.entry.focused = true;
  assert.doesNotThrow(() =>
    assertNavigationState(s, { mode: "information-closed" }),
  );
  s.entry.focused = false;
  assert.throws(
    () => assertNavigationState(s, { mode: "information-closed" }),
    /returns focus/,
  );
  s.entry.focused = true;
  s.dock = target();
  assert.throws(
    () => assertNavigationState(s, { mode: "information-closed" }),
    /really closed/,
  );
});
test("keyboard focus requires native focus-visible, visible outline and center hit", () => {
  for (const fault of [
    null,
    "not-focused",
    "not-focus-visible",
    "covered",
    "clipped",
    "no-outline",
    "zero-outline",
  ]) {
    const s = state();
    s.close.focused = s.close.focusVisible = true;
    if (fault === "not-focused") s.close.focused = false;
    if (fault === "not-focus-visible") s.close.focusVisible = false;
    if (fault === "covered") s.close.centerHit = false;
    if (fault === "clipped") s.close.fullyVisible = false;
    if (fault === "no-outline") s.close.outline.style = "none";
    if (fault === "zero-outline") s.close.outline.width = "0px";
    const check = () => assertNavigationState(s, { focus: "close" });
    if (fault) assert.throws(check, undefined, fault);
    else assert.doesNotThrow(check);
  }
});
test("Recent acquires the same primary fill only after Projects genuinely collapses", () => {
  const baseline = state(),
    s = state();
  s.projects.expanded = "false";
  s.project = null;
  s.recent.background = baseline.project.background;
  assert.doesNotThrow(() =>
    assertNavigationState(s, { mode: "projects-collapsed", baseline }),
  );
  s.recent.background = "alias";
  assert.throws(
    () => assertNavigationState(s, { mode: "projects-collapsed", baseline }),
    /primary current fill/,
  );
  s.recent.background = "primary";
  s.project = target();
  assert.throws(
    () => assertNavigationState(s, { mode: "projects-collapsed", baseline }),
    /unmounted/,
  );
});
test("Projects restoration preserves both aliases but only one primary fill", () => {
  const baseline = state(),
    s = state();
  assert.doesNotThrow(() =>
    assertNavigationState(s, { mode: "projects-expanded", baseline }),
  );
  s.recent.background = "primary";
  assert.throws(
    () => assertNavigationState(s, { mode: "projects-expanded", baseline }),
    /duplicate/,
  );
  s.recent.background = "alias";
  s.recent.hovered = true;
  assert.throws(
    () => assertNavigationState(s, { mode: "projects-expanded", baseline }),
    /pointer moved away/,
  );
});
test("navigation must not send, edit Information, switch current identity or lose draft", () => {
  for (const fault of ["send", "edit", "draft", "identity"]) {
    const s = state();
    if (fault === "send") s.telemetry.protocolCalls.push("zen/turn/send");
    if (fault === "edit") s.telemetry.informationUpdates++;
    if (fault === "draft") s.draft = "";
    if (fault === "identity") s.recent.current = null;
    assert.throws(() => assertNavigationState(s), undefined, fault);
  }
});
test("browser observer supports real CodeMirror contenteditable and textarea DOM", async () => {
  const { JSDOM } = await import("jsdom");
  for (const editor of [
    '<div contenteditable="true">Synthetic draft</div>',
    "<textarea>Synthetic draft</textarea>",
  ]) {
    const dom = new JSDOM(
      `<form class="composer">${editor}</form><div class="information-toolbar"><button aria-expanded="false">Information</button></div>`,
      { runScripts: "outside-only" },
    );
    try {
      dom.window.document.elementFromPoint = () => null;
      dom.window.__uiPolishTelemetry = {
        informationUpdates: 0,
        informationReads: [],
        protocolCalls: [],
      };
      const observed = dom.window.eval(`(${observeNavigation.toString()})()`);
      assert.equal(observed.draft, "Synthetic draft");
      assert.equal(observed.entry.expanded, "false");
      assert.equal(
        observed.entry.fullyVisible,
        false,
        "JSDOM zero boxes never imply visible pixels",
      );
      assert.equal(observed.entry.centerHit, false);
      assert.equal(observed.dock, null);
    } finally {
      dom.window.close();
    }
  }
});
test("navigation remains opt-in desktop production App with source-bound native input", async () => {
  const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
  const [workflow, build, capture, navigation, fixture] = await Promise.all([
    read("../../../.github/workflows/main-ui-preview.yml"),
    read("../scripts/build-main-ui-preview.mjs"),
    read("../scripts/capture-main-ui-preview.mjs"),
    read("../scripts/navigation-main-ui-preview.mjs"),
    read("./fixtures/ui-polish-visual.tsx"),
  ]);
  assert.match(
    workflow,
    /options: \[all, main, navigation, pending, information\]/,
  );
  assert.match(workflow, /inputs.scene == 'pending'/);
  assert.match(
    build,
    /navigation: \{\s*entry: "apps\/zenx\/test\/fixtures\/ui-polish-visual.tsx"/,
  );
  assert.ok(
    build.includes('"apps/zenx/scripts/navigation-main-ui-preview.mjs"'),
  );
  assert.match(
    capture,
    /scene === "navigation" &&[\s\S]*?options.width !== 1280[\s\S]*?options.height !== 900/,
  );
  assert.match(capture, /process.env.GITHUB_ACTIONS,\s*"true"/);
  assert.doesNotMatch(
    navigation,
    /\.focus\(|\.click\(|__\w+\.set|document\.createElement/,
  );
  assert.match(navigation, /Input.insertText/);
  assert.match(navigation, /tabTo/);
  assert.match(navigation, /key\("Escape", "Escape", 27\)/);
  assert.match(fixture, /params.get\("scene"\) === "navigation"/);
  assert.match(fixture, /Unexpected synthetic information owner/);
  assert.match(fixture, /Navigation preview does not admit information edits/);
});

test("independent navigation workflow auto-triggers on related PR paths without dispatch or aggregate work", async () => {
  const workflow = await readFile(
    new URL(
      "../../../.github/workflows/desktop-navigation-ui.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /pull_request:\s+paths:/);
  assert.match(
    workflow,
    /apps\/zenx\/src\/renderer\/src\/plugin-information-host\.tsx/,
  );
  assert.match(workflow, /apps\/zenx\/src\/renderer\/src\/Sidebar\.tsx/);
  assert.match(workflow, /github.event.pull_request.head.sha/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, /build-main-ui-preview\.mjs[^\n]* navigation/);
  assert.match(workflow, /capture-main-ui-preview\.mjs[^\n]* fine/);
  assert.doesNotMatch(
    workflow,
    /\bneeds:|workflow_dispatch:|pull_request_target:|npm (?:test|run (?:check|build|typecheck))\b|capture-main-ui-preview\.mjs[^\n]* coarse/,
  );
  assert.match(workflow, /if: always\(\)/);
  assert.match(
    workflow,
    /desktop-navigation-\$\{\{ github.event.pull_request.head.sha \}\}/,
  );
});
