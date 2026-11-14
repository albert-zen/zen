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
  close: target(),
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
    "different-close-control",
    "entry-covered",
    "close-covered",
    "chat-covered",
    "composer-clipped",
    "empty-card",
    "draggable-entry",
    "no-read",
  ]) {
    const s = state();
    if (fault === "different-close-control") s.close.rect.y = 79;
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

test("desktop navigation retains only the production information toggle as close control", async () => {
  const source = await readFile(
    new URL("../scripts/navigation-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /information-dismiss-toolbar/);
  assert.match(source, /Information closes through the same titlebar toggle/);
});

import { createChildSidebarPreference } from "./fixtures/ui-polish-visual-child-sidebar.mjs";
import {
  assertChildSidebarState,
  captureChildSidebar,
} from "../scripts/navigation-main-ui-preview.mjs";

function childState(visible = false, writes = []) {
  const s = state();
  const sidebar = target({
    rect: { x: 0, y: 0, right: 264, bottom: 900, width: 264, height: 900 },
  });
  const row = () =>
    target({
      current: null,
      rect: { x: 16, y: 240, right: 250, bottom: 270, width: 234, height: 30 },
    });
  s.telemetry.navigationInputEvents = [];
  Object.assign(s.telemetry, {
    machineThreadCreateCalls: 0,
    sideChatCreateCommandCalls: 0,
    workspaceUsedCalls: 1,
  });
  s.childSidebar = {
    owner: "thread:thread-1",
    switchCount: 2,
    errors: 0,
    toggle: target({
      role: "switch",
      label: "Show in sidebar: Design review",
      checked: String(visible),
      busy: "false",
      disabled: "false",
      focused: true,
      focusVisible: true,
    }),
    sibling: target({ checked: "true" }),
    siblingLeftCount: 2,
    siblingProject: row(),
    siblingRecent: row(),
    leftCount: visible ? 1 : 0,
    leftTotalCount: visible ? 2 : 0,
    left: visible ? row() : null,
    recent: visible ? row() : null,
    sidebar,
    answers: ["Synthetic parent conversation"],
    preference: {
      scope: "synthetic-in-memory-preference-only",
      changes: structuredClone(writes),
      visibleSubagentThreadIds: visible
        ? ["test-child", "design-child"]
        : ["test-child"],
      pinnedThreadIds: [],
      sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
    },
  };
  return s;
}
test("synthetic child preference admits exactly target Show then Hide and preserves sibling", () => {
  for (const args of [
    ["test-child", false],
    ["unknown", true],
    ["design-child", false],
    ["design-child", "true"],
    ["design-child", true, "extra"],
  ]) {
    const f = createChildSidebarPreference();
    assert.throws(() => f.setVisible(...args));
    assert.deepEqual(f.receipt().changes, []);
  }
  const f = createChildSidebarPreference();
  assert.deepEqual(f.read().visibleSubagentThreadIds, ["test-child"]);
  assert.deepEqual(
    f.setVisible("design-child", true).visibleSubagentThreadIds,
    ["test-child", "design-child"],
  );
  assert.deepEqual(
    f.setVisible("design-child", false).visibleSubagentThreadIds,
    ["test-child"],
  );
  assert.throws(() => f.setVisible("design-child", true));
  const receipt = f.receipt();
  receipt.visibleSubagentThreadIds.length = 0;
  receipt.changes[0].visible = false;
  assert.deepEqual(f.receipt().changes, [
    { threadId: "design-child", visible: true },
    { threadId: "design-child", visible: false },
  ]);
  assert.deepEqual(f.read().visibleSubagentThreadIds, ["test-child"]);
});
test("child visibility assertions reject right-vs-left confusion, lost focus/draft, lingering aliases and unrelated effects", () => {
  const before = childState(),
    writes = [{ threadId: "design-child", visible: true }];
  assertChildSidebarState(before, false, null, []);
  assertChildSidebarState(childState(true, writes), true, before, writes);
  for (const mutate of [
    (s) => {
      s.childSidebar.left.rect.x = 930;
      s.childSidebar.left.rect.right = 1164;
    },
    (s) => (s.childSidebar.leftTotalCount = 0),
    (s) => (s.childSidebar.toggle.focused = false),
    (s) => (s.childSidebar.toggle.outline.width = "0px"),
    (s) => (s.childSidebar.sibling.checked = "false"),
    (s) => (s.childSidebar.siblingRecent = null),
    (s) => (s.childSidebar.siblingProject.centerHit = false),
    (s) => (s.childSidebar.siblingRecent.centerHit = false),
    (s) => (s.childSidebar.owner = "thread:design-child"),
    (s) => (s.draft = ""),
    (s) => (s.project.current = null),
    (s) => s.telemetry.informationUpdates++,
    (s) => s.telemetry.protocolCalls.push("zen/thread/read"),
    (s) => s.childSidebar.preference.pinnedThreadIds.push("design-child"),
  ]) {
    const bad = childState(true, writes);
    mutate(bad);
    assert.throws(() => assertChildSidebarState(bad, true, before, writes));
  }
  const hidden = childState();
  hidden.childSidebar.leftTotalCount = 1;
  assert.throws(
    () => assertChildSidebarState(hidden, false, before, []),
    "Hidden must remove all left navigation aliases",
  );
});
test("separate child probe uses real Tab and native Enter events, requiring trusted switch activation", async () => {
  for (const trusted of [true, false]) {
    let s = childState(),
      shown = false,
      sequence = 0;
    const evidence = {},
      shots = [],
      calls = [],
      writes = [],
      events = [];
    const action = captureChildSidebar({
      options: { name: "desktop-light", theme: "light" },
      evidence,
      evaluate: async (expression) =>
        expression.startsWith("(function observeNavigation")
          ? structuredClone(s)
          : true,
      wait: async () => {},
      click: async (selector) => calls.push(["click", selector]),
      tabTo: async (selector) => {
        calls.push(["tabTo", selector]);
        return true;
      },
      capture: async (name) => shots.push(name),
      send: async (method, input) => {
        calls.push([method, input]);
        if (method !== "Input.dispatchKeyEvent") return;
        events.push({
          type: input.type === "keyUp" ? "keyup" : "keydown",
          key: input.key,
          target: "child-sidebar",
          trusted,
          sequence: ++sequence,
        });
        if (input.type === "keyUp") {
          shown = !shown;
          writes.push({ threadId: "design-child", visible: shown });
          events.push({
            type: "click",
            target: "child-sidebar",
            trusted,
            sequence: ++sequence,
          });
          s = childState(shown, writes);
          s.telemetry.navigationInputEvents = structuredClone(events);
        }
      },
    });
    if (!trusted) {
      await assert.rejects(action);
      assert.equal(evidence.childSidebarTrips[0].status, "failed");
      continue;
    }
    await action;
    assert.equal(evidence.childSidebarTrips[0].status, "passed");
    assert.deepEqual(shots, [
      "child-sidebar-desktop-light-hidden-focus",
      "child-sidebar-desktop-light-shown",
      "child-sidebar-desktop-light-hidden-again",
    ]);
    assert.equal(calls.filter(([method]) => method === "tabTo").length, 1);
    assert(
      calls
        .filter(([method]) => method === "click")
        .every(([, selector]) => !selector.includes("subagent")),
    );
    assert.deepEqual(
      calls
        .filter(([method]) => method === "Input.dispatchKeyEvent")
        .map(([, p]) => [p.type, p.key, p.text]),
      [
        ["keyDown", "Enter", "\r"],
        ["keyUp", "Enter", undefined],
        ["keyDown", "Enter", "\r"],
        ["keyUp", "Enter", undefined],
      ],
    );
  }
});
test("isolated child profile reuses exact navigation build, sandbox and synthetic-only preferences", async () => {
  const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
  const [capture, workflow, fixture, port] = await Promise.all([
    read("../scripts/capture-main-ui-preview.mjs"),
    read("../../../.github/workflows/desktop-navigation-ui.yml"),
    read("./fixtures/ui-polish-visual.tsx"),
    read("./fixtures/ui-polish-visual-child-sidebar.mjs"),
  ]);
  assert.match(capture, /ZENX_CHILD_SIDEBAR_EXPECTED_HEAD/);
  assert.match(capture, /desktopChildSidebar \? "navigation" : "reading"/);
  assert.match(capture, /source\.dirtyFiles/);
  assert.match(capture, /"HEAD\^\{tree\}"/);
  assert.match(capture, /process.env.GITHUB_ACTIONS,\s*"true"/);
  assert.match(
    workflow,
    /!cancelled\(\).*steps.fonts.outcome == 'success'.*steps.navigationBuild.outcome == 'success'/,
  );
  assert.match(workflow, /desktop-child-sidebar" desktop-child-sidebar/);
  assert.match(workflow, /synthetic in-memory preference only/);
  assert.match(fixture, /if \(childSidebar\) \{/);
  assert.match(fixture, /setSubagentThreadSidebarVisible:/);
  assert.doesNotMatch(
    port,
    /localStorage|fetch\(|writeFile|window\.zenx|child_process/,
  );
});

import {
  assertChildNavigationState,
  assertChildNavigationTransition,
  captureChildNavigation,
  childNavigationDraft,
  childNavigationAnswer,
} from "../scripts/navigation-main-ui-preview.mjs";
function journeyState(owner = "design-child", draft = childNavigationDraft) {
  const s = childState(true, [{ threadId: "design-child", visible: true }]);
  s.draft = draft;
  s.childSidebar.owner = `thread:${owner}`;
  s.childSidebar.answers =
    owner === "design-child"
      ? [childNavigationAnswer]
      : ["Synthetic parent conversation"];
  s.childSidebar.left.current = s.childSidebar.recent.current =
    owner === "design-child" ? "page" : null;
  s.project.current = s.recent.current = owner === "thread-1" ? "page" : null;
  s.telemetry.navigationReads = [
    { method: "zen/thread/resume-window", threadId: "thread-1" },
    { method: "zen/thread/resume-window", threadId: "design-child" },
  ];
  s.telemetry.informationReads = [
    { kind: "thread", id: "thread-1" },
    { kind: "thread", id: "design-child" },
  ];
  return s;
}
test("child navigation read admission remains opt-in and owner/schema bounded", async () => {
  const { tsImport } = await import("tsx/esm/api");
  const { readNavigationQuestions } = await tsImport(
    "./fixtures/ui-polish-visual-navigation.ts",
    import.meta.url,
  );
  assert.throws(() => readNavigationQuestions({ threadId: "design-child" }));
  assert.deepEqual(
    readNavigationQuestions({ threadId: "design-child" }, true),
    { questions: [], totalPending: 0 },
  );
  for (const request of [
    { threadId: "test-child" },
    { threadId: "other" },
    { threadId: "design-child", extra: true },
    [],
    null,
  ])
    assert.throws(() => readNavigationQuestions(request, true));
});
test("whole-App child round trip rejects draft leakage, wrong content/owner and unrelated effects", () => {
  const baseline = childState();
  assert.doesNotThrow(() =>
    assertChildNavigationState(
      journeyState(),
      "design-child",
      childNavigationDraft,
      baseline,
    ),
  );
  assert.doesNotThrow(() =>
    assertChildNavigationState(
      journeyState("thread-1", navigationDraft),
      "thread-1",
      navigationDraft,
      baseline,
    ),
  );
  for (const mutate of [
    (s) => (s.draft = navigationDraft),
    (s) => (s.childSidebar.answers = baseline.childSidebar.answers),
    (s) => (s.childSidebar.owner = "thread:thread-1"),
    (s) => (s.childSidebar.left.current = null),
    (s) => (s.childSidebar.recent.centerHit = false),
    (s) => (s.childSidebar.siblingProject.centerHit = false),
    (s) =>
      (s.childSidebar.preference.visibleSubagentThreadIds = ["design-child"]),
    (s) => (s.telemetry.navigationReads = []),
    (s) =>
      s.telemetry.informationReads.push({ kind: "thread", id: "test-child" }),
    (s) => s.telemetry.protocolCalls.push("zen/turn/send"),
    (s) => (s.telemetry.informationUpdates = 1),
    (s) => (s.composer.fullyVisible = false),
    (s) => (s.questionReadErrors = ["Loading failed"]),
  ]) {
    const s = journeyState();
    mutate(s);
    assert.throws(() =>
      assertChildNavigationState(
        s,
        "design-child",
        childNavigationDraft,
        baseline,
      ),
    );
  }
});
test("child open/return uses trusted left-row input, native keyboard return and distinct unsent drafts", async () => {
  for (const trusted of [true, false]) {
    let s = childState(),
      sequence = 0,
      tab = "",
      showed = false;
    s.telemetry.navigationReads = [
      { method: "zen/thread/resume-window", threadId: "thread-1" },
    ];
    const telemetry = s.telemetry,
      calls = [],
      shots = [],
      evidence = {};
    const drafts = { "thread-1": "", "design-child": "" };
    let owner = "thread-1";
    const select = (selector) => {
      owner = selector.includes("design-child") ? "design-child" : "thread-1";
      s = journeyState(owner, drafts[owner]);
      s.telemetry = telemetry;
      telemetry.navigationReads.push({
        method: "zen/thread/resume-window",
        threadId: owner,
      });
      telemetry.informationReads.push({ kind: "thread", id: owner });
      telemetry.navigationInputEvents.push({
        type: "click",
        trusted,
        threadId: owner,
        target: selector.includes("recent") ? "recent" : "project",
        sequence: ++sequence,
      });
    };
    const action = captureChildNavigation({
      options: { name: "desktop-light", theme: "light" },
      evidence,
      evaluate: async (exp) =>
        exp.startsWith("(function observeNavigation")
          ? structuredClone(s)
          : true,
      wait: async () => {},
      click: async (selector) => {
        calls.push(["click", selector]);
        if (selector.includes("thread-row") && showed) select(selector);
      },
      tabTo: async (selector) => {
        tab = selector;
        calls.push(["tabTo", selector]);
        if (selector.includes("thread-1")) {
          s.project.focused = true;
          s.project.focusVisible = true;
        }
        return true;
      },
      capture: async (name) => shots.push(name),
      send: async (method, input) => {
        calls.push([method, input]);
        if (method === "Input.insertText") {
          drafts[owner] = input.text;
          s.draft = input.text;
        }
        if (method === "Input.dispatchKeyEvent") {
          telemetry.navigationInputEvents.push({
            type: input.type === "keyUp" ? "keyup" : "keydown",
            key: input.key,
            threadId: tab.includes("thread-1") ? "thread-1" : undefined,
            target: tab.includes("subagent-sidebar-visibility")
              ? "child-sidebar"
              : "project",
            trusted: true,
            sequence: ++sequence,
          });
        }
        if (method === "Input.dispatchKeyEvent" && input.type === "keyUp") {
          if (tab.includes("subagent-sidebar-visibility")) {
            telemetry.navigationInputEvents.push({
              type: "click",
              target: "child-sidebar",
              trusted: true,
              sequence: ++sequence,
            });
            showed = true;
            s = childState(true, [{ threadId: "design-child", visible: true }]);
            s.telemetry = telemetry;
          } else select(tab);
        }
      },
    });
    if (!trusted) {
      await assert.rejects(action, /Trusted input/);
      assert.equal(evidence.childNavigationTrips[0].status, "failed");
      continue;
    }
    await action;
    assert.equal(evidence.childNavigationTrips[0].status, "passed");
    assert.deepEqual(shots, [
      "child-navigation-desktop-light-child-draft",
      "child-navigation-desktop-light-parent-return",
      "child-navigation-desktop-light-child-return",
    ]);
    assert.equal(calls.filter(([m]) => m === "Input.insertText").length, 2);
    assert(
      calls.some(([m, value]) => m === "tabTo" && value.includes("thread-1")),
    );
    assert.deepEqual(
      calls
        .filter(([m]) => m === "Input.dispatchKeyEvent")
        .map(([, p]) => [p.type, p.key]),
      [
        ["keyDown", "Enter"],
        ["keyUp", "Enter"],
        ["keyDown", "Enter"],
        ["keyUp", "Enter"],
      ],
    );
    assert.equal(drafts["thread-1"], navigationDraft);
    assert.equal(drafts["design-child"], childNavigationDraft);
  }
});
test("child navigation is isolated, fixed-head, light desktop only, with separate timed artifacts", async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const [capture, fixture, workflow] = await Promise.all([
    read("../scripts/capture-main-ui-preview.mjs"),
    read("./fixtures/ui-polish-visual.tsx"),
    read("../../../.github/workflows/desktop-navigation-ui.yml"),
  ]);
  assert.match(capture, /captureProfile === "desktop-child-navigation"/);
  assert.match(capture, /ZENX_CHILD_NAVIGATION_EXPECTED_HEAD/);
  assert.match(
    capture,
    /desktopReentry \|\| desktopNested \|\| desktopChildNavigation[\s\S]*?c.theme === "light"/,
  );
  assert.match(
    capture,
    /if \(desktopChildNavigation\) query.set\("childNavigation", "1"\)/,
  );
  assert.match(
    fixture,
    /childSidebar !== null && params.get\("childNavigation"\) === "1"/,
  );
  assert.match(fixture, /childNavigation && owner.id === "design-child"/);
  assert.match(fixture, /readNavigationQuestions\(request, childNavigation\)/);
  assert.match(workflow, /desktop-child-navigation" desktop-child-navigation/);
  assert.match(
    workflow,
    /ZENX_CHILD_NAVIGATION_EXPECTED_HEAD: \$\{\{ github.event.pull_request.head.sha \}\}/,
  );
  assert.match(workflow, /unsent per-thread drafts/);
});

test("fresh transition proof rejects historical owner reads or missing native keyboard events", () => {
  const before = journeyState("design-child", childNavigationDraft);
  const after = structuredClone(before);
  after.telemetry.navigationReads.push({
    method: "zen/thread/resume-window",
    threadId: "thread-1",
  });
  after.telemetry.navigationInputEvents = ["keydown", "click", "keyup"].map(
    (type, n) => ({
      type,
      key: "Enter",
      threadId: "thread-1",
      trusted: true,
      sequence: n + 1,
    }),
  );
  assert.doesNotThrow(() =>
    assertChildNavigationTransition(before, after, "thread-1", true),
  );
  const stale = structuredClone(after);
  stale.telemetry.navigationReads = before.telemetry.navigationReads;
  assert.throws(
    () => assertChildNavigationTransition(before, stale, "thread-1", true),
    /fresh/,
  );
  for (const type of ["keydown", "keyup", "click"]) {
    const bad = structuredClone(after);
    bad.telemetry.navigationInputEvents =
      bad.telemetry.navigationInputEvents.filter(
        (event) => event.type !== type,
      );
    assert.throws(() =>
      assertChildNavigationTransition(before, bad, "thread-1", true),
    );
  }
});

test("only child navigation reads the production Markdown body, excluding sibling message actions", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    `<div class="messages"><article class="agent-copy"><div data-message-quote-body><div class="markdown-body"><p>${childNavigationAnswer}</p></div></div><div class="assistant-message-actions">Oct 15 03:00</div></article></div>`,
    { runScripts: "outside-only" },
  );
  try {
    dom.window.document.elementFromPoint = () => null;
    dom.window.__uiPolishTelemetry = {};
    dom.window.__childSidebarPreference = { receipt: () => ({}) };
    const read = (childNavigation) =>
      dom.window.eval(
        `(${observeNavigation.toString()})(true, ${childNavigation})`,
      ).childSidebar.answers;
    const baseline = childState();
    const actual = journeyState();
    actual.childSidebar.answers = Array.from(read(true));
    assert.deepEqual(actual.childSidebar.answers, [childNavigationAnswer]);
    assert.doesNotThrow(() =>
      assertChildNavigationState(
        actual,
        "design-child",
        childNavigationDraft,
        baseline,
      ),
    );
    assert.deepEqual(
      Array.from(read(false)),
      [`${childNavigationAnswer}Oct 15 03:00`],
      "The existing preference-only observer remains unchanged",
    );
    dom.window.document.querySelector(".markdown-body p").textContent =
      "Wrong conversation body.";
    dom.window.document.querySelector(
      ".assistant-message-actions",
    ).textContent = `${childNavigationAnswer}Oct 15 03:00`;
    actual.childSidebar.answers = Array.from(read(true));
    assert.deepEqual(actual.childSidebar.answers, ["Wrong conversation body."]);
    assert.throws(
      () =>
        assertChildNavigationState(
          actual,
          "design-child",
          childNavigationDraft,
          baseline,
        ),
      /Actual child answer/,
    );
    dom.window.document.querySelector("[data-message-quote-body]").remove();
    actual.childSidebar.answers = Array.from(read(true));
    assert.deepEqual(actual.childSidebar.answers, []);
    assert.throws(
      () =>
        assertChildNavigationState(
          actual,
          "design-child",
          childNavigationDraft,
          baseline,
        ),
      /Actual child answer/,
    );
  } finally {
    dom.window.close();
  }
});
