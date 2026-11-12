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
  assert.match(
    workflow,
    /run: node --import tsx --test .*subagents-ui.test.ts/,
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
