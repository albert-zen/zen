import ts from "typescript";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createChildQuestionData } from "./fixtures/child-question-data.js";
import { verifyChildQuestions } from "../scripts/child-question-main-ui-preview.mjs";
import type { ThreadSummary } from "../../../src/thread-summary.js";
const base = (threadId: string, name: string): ThreadSummary => ({
  threadId,
  name,
  currentMetadata: {
    model: "fake",
    provider: "fake",
    cwd: "/work/zen",
    sandbox: "read-only",
    approvalPolicy: "never",
  },
  archived: false,
  createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
  preview: "",
  status: "idle",
});
test("synthetic catalog distinguishes running from attention and unavailable", () => {
  const data = createChildQuestionData(base);
  assert.deepEqual(
    data.rows.map((row) => row.status),
    ["idle", "active", "idle", "systemError"],
  );
  assert.deepEqual(
    data.rows.map((row) =>
      row.status === "systemError" ? null : row.userQuestionSummary?.openCount,
    ),
    [1, 2, 0, null],
  );
  assert(data.rows.every((row) => row.parentThreadId === "thread-1"));
  const receipt = data.clear();
  assert.equal(receipt.kind, "synthetic-question-attention-cleared");
  assert(
    data.rows.every(
      (row) =>
        row.status === "systemError" ||
        row.userQuestionSummary?.openCount === 0,
    ),
  );
  assert.equal(data.rows[1]?.status, "active");
});
test("capture accepts missing baseline dock badges but requires same four named rows", () => {
  const data = createChildQuestionData(base);
  const rect = {
    width: 100,
    height: 30,
    visible: true,
    viewportIntersection: { width: 100, height: 30 },
  };
  const state = {
    sidebar: data.rows.map((row, i) => ({
      id: row.threadId,
      badge: i < 2 ? "Asking" : null,
      rect,
    })),
    rows: data.rows.map((row) => ({
      id: row.threadId,
      title: row.name,
      status: row.status,
      rect,
    })),
    dock: { width: 340, bottom: 700 },
    composer: { width: 600 },
    overflow: 0,
  };
  verifyChildQuestions(state);
  assert.throws(() =>
    verifyChildQuestions({ ...state, rows: state.rows.slice(1) }),
  );
  assert.throws(() => verifyChildQuestions(state, true));
  verifyChildQuestions(
    {
      ...state,
      sidebar: state.sidebar.map((row) => ({ ...row, badge: null })),
    },
    true,
  );
});
test("opt-in uses existing invalidation path, guards default scenes, receipts all additions", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const fixture = read("./fixtures/ui-polish-visual.tsx");
  assert.match(
    fixture,
    /childQuestionScene\s*\? createChildQuestionData\(summary\)\s*: null/,
  );
  assert.match(
    fixture,
    /type: "user_question_attention_invalidated",\s*threadId/,
  );
  assert.match(fixture, /if \(!childQuestionScene\) return \(\) => undefined/);
  const helper = read("../scripts/child-question-main-ui-preview.mjs");
  assert.doesNotMatch(helper, /\.focus\(|\.click\(/);
  assert.match(helper, /focusThreadId/);
  for (const p of [
    "../scripts/build-main-ui-preview.mjs",
    "../scripts/reading-main-ui-preview.mjs",
  ]) {
    const receipt = read(p);
    for (const name of [
      "child-question-data.ts",
      "child-question-main-ui-preview.mjs",
      "child-question-main-ui-preview.test.ts",
    ])
      assert(receipt.includes(name));
  }
});

test("workflow and last-commit gates retain short budget and cover product changes", () => {
  const workflow = readFileSync(
    new URL(
      "../../../.github/workflows/desktop-reading-ui.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const reading = readFileSync(
    new URL("../scripts/reading-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  for (const name of [
    "subagents-ui.tsx",
    "subagents.css",
    "subagents-ui.test.ts",
    "child-question-main-ui-preview.test.ts",
  ]) {
    assert(workflow.includes(name));
    assert(reading.includes(name));
  }
  assert.match(workflow, /timeout-minutes: 6/);
  assert.match(workflow, /contents: read/);
  assert(
    workflow.includes(
      "timeout 30s node --import tsx --test --test-timeout=10000 --test-name-pattern='^subagent question attention follows Host summaries independently of activity'",
    ),
  );
  assert(
    workflow.indexOf("Targeted question-attention DOM checks") >
      workflow.indexOf(
        "run: node apps/zenx/scripts/capture-main-ui-preview.mjs",
      ),
  );
  assert(
    workflow.indexOf("Targeted question-attention DOM checks") <
      workflow.indexOf("- uses: actions/upload-artifact@v4"),
  );
  assert(
    workflow.includes("if: always() && steps.selection.outputs.needsCapture"),
  );
});

test("real production sidebar filter needs explicit synthetic visibility and survives count clear", () => {
  const source = readFileSync(
    new URL("../src/renderer/src/thread-list.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "thread-list.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const fn = ast.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "deriveSidebarThreads",
  );
  assert(fn);
  const compiled = ts.transpileModule(fn.getText(ast).replace(/^export /, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const derive = new Function(compiled + "; return deriveSidebarThreads;")();
  const data = createChildQuestionData(base),
    visible = data.rows.map((row) => row.threadId);
  assert.equal(derive(data.rows, []).length, 0);
  assert.deepEqual(
    derive(data.rows, visible).map((row: ThreadSummary) => row.threadId),
    visible,
  );
  data.clear();
  assert.deepEqual(
    derive(data.rows, visible).map((row: ThreadSummary) => row.threadId),
    visible,
  );
  const fixture = readFileSync(
    new URL("./fixtures/ui-polish-visual.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(fixture.match(/visibleSubagentThreadIds:/g)?.length, 2);
});

function probeFunction(name: string, bindings: Record<string, unknown> = {}) {
  const source = readFileSync(
    new URL("../scripts/child-question-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "probe.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const fn = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert(fn);
  return new Function(
    ...Object.keys(bindings),
    fn.getText(ast).replace(/^export /, "") + `;return ${name}`,
  )(...Object.values(bindings));
}

test("overlay probe distinguishes gradient geometry from actual menu overlap without claiming pixels", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    '<div class="project-group"><div data-thread-id="question-idle"><button class="thread-row"><span class="thread-asking-badge">Asking</span></button><div class="thread-status-rail"><button class="thread-menu-trigger"></button></div></div></div>',
  );
  const previous = {
    document: globalThis.document,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    getComputedStyle: globalThis.getComputedStyle,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    innerWidth: 1280,
    innerHeight: 900,
    getComputedStyle: () => ({
      backgroundImage: "linear-gradient(...)",
      opacity: "1",
    }),
  });
  const box = (x: number, width: number, height = 20, y = 10) => ({
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON() {},
  });
  const doc = dom.window.document;
  const badge = doc.querySelector(".thread-asking-badge")!;
  const rail = doc.querySelector(".thread-status-rail")!;
  const menu = doc.querySelector(".thread-menu-trigger")!;
  let menuX = 160;
  for (const el of doc.querySelectorAll("*"))
    el.getBoundingClientRect = () => box(0, 240);
  badge.getBoundingClientRect = () => box(100, 50);
  rail.getBoundingClientRect = () => box(125, 63);
  menu.getBoundingClientRect = () => box(menuX, 28);
  doc.createRange = (() => ({
    selectNodeContents() {},
    getClientRects: () => [box(108, 37, 12, 14)],
  })) as unknown as typeof doc.createRange;
  doc.elementsFromPoint = (x) =>
    x >= menuX ? [menu, rail] : [badge, doc.querySelector(".thread-row")!];
  try {
    const observe = probeFunction("observeChildQuestions");
    const first = observe(() => true).sidebar[0].overlay;
    assert.equal(first.badgeRailOverlapArea, 500);
    assert.equal(first.badgeMenuOverlapArea, 0);
    assert.equal(first.textMenuOverlapArea, 0);
    assert(first.menuCenterHit[0].menuTarget);
    menuX = 130;
    const second = observe(() => true).sidebar[0].overlay;
    assert.equal(second.badgeMenuOverlapArea, 400);
    assert.equal(second.textMenuOverlapArea, 180);
    assert(second.samples[2].stack[0].menuTarget);
    assert.match(second.interpretation, /inspect screenshots/);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("overlay probe preserves original clear assertions, uses native input and restores dock", async () => {
  const data = createChildQuestionData(base);
  let dock = true,
    cleared = false;
  const events: Array<[string, unknown]> = [],
    captures: string[] = [],
    observations: string[] = [];
  const rect = {
    x: 0,
    y: 0,
    width: 100,
    height: 30,
    bottom: 30,
    visible: true,
    viewportIntersection: { width: 100, height: 30 },
  };
  const state = () => ({
    sidebar: data.rows.map((row, i) => ({
      id: row.threadId,
      badge: !cleared && i < 2 ? "Asking" : null,
      rect,
    })),
    rows: data.rows.map((row) => ({
      id: row.threadId,
      title: row.name,
      status: row.status,
      rect,
    })),
    dock: dock ? { width: 340, bottom: 700 } : null,
    composer: { width: 600 },
    overflow: 0,
    focusThreadId: "question-idle",
    focusClass: "thread-row",
    focusVisible: true,
    selectedThreadIds: ["thread-1"],
  });
  const run = probeFunction("captureChildQuestions", {
    assert,
    verifyChildQuestions,
    observeChildQuestions: function observeChildQuestions() {},
    projectElementVisible: function projectElementVisible() {},
    dispatchNavigationKey: async (send: Function, key: string) =>
      send("Input.dispatchKeyEvent", { key }),
  });
  const evidence: { childQuestionOverlayCases?: Array<{ step: string }> } = {};
  await run({
    send: async (method: string, params: unknown) =>
      events.push([method, params]),
    evaluate: async (source: string) => {
      observations.push(source);
      if (source.includes("function observeChildQuestions")) return state();
      if (source.includes("__childQuestionFixture.clear")) {
        cleared = true;
        return { kind: "synthetic-question-attention-cleared" };
      }
      if (source.includes("getBoundingClientRect")) return { x: 10, y: 20 };
      if (source.includes("setTimeout")) return;
      return true;
    },
    wait: async () => {},
    click: async (selector: string) => {
      if (selector === ".information-toolbar button") dock = !dock;
    },
    capture: async (name: string) => captures.push(name),
    evidence,
    options: { theme: "light", name: "desktop-light" },
    url: "http://localhost/reading.html",
  });
  assert(dock && cleared);
  assert.equal(captures.length, 4);
  assert.equal(captures[0]?.endsWith("pending"), true);
  assert.equal(captures[3]?.endsWith("cleared"), true);
  assert.deepEqual(
    evidence.childQuestionOverlayCases?.map((row) => row.step),
    [
      "dock-open-tab",
      "dock-open-escape",
      "dock-open-hover",
      "dock-closed-hover",
      "dock-restored-tab",
    ],
  );
  assert(
    events.some(
      ([m, p]) =>
        m === "Input.dispatchKeyEvent" &&
        (p as { key: string }).key === "Escape",
    ),
  );
  assert(
    events.some(
      ([m, p]) =>
        m === "Input.dispatchMouseEvent" &&
        (p as { type: string }).type === "mouseMoved",
    ),
  );
  assert(observations.every((s) => !/\.focus\(|\.click\(/.test(s)));
});
