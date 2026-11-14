import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  verifyBusyChild,
  navigationDraft,
} from "../scripts/navigation-main-ui-preview.mjs";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const box = (text) => ({
  text,
  title: text,
  rect: { x: 10, y: 10, right: 110, bottom: 30, width: 100, height: 20 },
  visible: true,
  centerHit: true,
  focused: true,
  focusVisible: true,
  outline: { style: "solid", width: "2px" },
  ellipsized: false,
  clientHeight: 20,
  scrollHeight: 20,
});
function sample() {
  const title = "Synthetic long title",
    model = "Synthetic long model";
  return {
    viewport: { width: 1280, height: 900 },
    theme: "light",
    fixture: { title, model, approval: true, asking: false },
    aliases: ["project-group", "recent-thread-group"].map((scope) => ({
      scope,
      row: box(""),
      title: box(title),
      model: box(model),
      child: box("Child"),
      approval: box("Needs your approval"),
      menu: box(""),
      asking: false,
    })),
    reveal: box(title),
    selected: ["thread-1", "thread-1"],
    draft: navigationDraft,
    composer: box(""),
    telemetry: {
      informationUpdates: 0,
      protocolCalls: ["initialize", "zen/thread/resume-window"],
      workspaceUsedCalls: 1,
    },
  };
}
test("busy measurement checks exact owner/name/model/approval and keyboard reveal without pretending model fits", () => {
  const state = sample();
  verifyBusyChild(state, null);
  verifyBusyChild(state, "project-group", state);
  state.aliases[0].model.ellipsized = true;
  state.aliases[0].model.clientWidth = 0;
  verifyBusyChild(state, null);
  for (const mutate of [
    (s) => (s.aliases[0].asking = true),
    (s) => (s.aliases[0].approval = null),
    (s) => (s.aliases[1].model.text = "wrong"),
    (s) => (s.selected = ["design-child"]),
    (s) => (s.draft = "lost"),
    (s) => (s.reveal.ellipsized = true),
    (s) => (s.reveal.centerHit = false),
    (s) => (s.aliases[0].row.focusVisible = false),
    (s) => s.telemetry.protocolCalls.push("zen/turn/send"),
  ]) {
    const bad = sample();
    mutate(bad);
    assert.throws(() => verifyBusyChild(bad, "project-group"));
  }
});
test("busy fixture is navigation opt-in, approval-only and preserves ordinary row/model seeds", async () => {
  const source = await read("./fixtures/ui-polish-visual.tsx");
  const ts = await import("typescript");
  const ast = ts.createSourceFile(
    "fixture.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const variable = (name) =>
    ast.statements
      .find(
        (s) =>
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.some(
            (d) => d.name.getText(ast) === name,
          ),
      )
      .getText(ast);
  const setup = [
    "busyChild",
    "busyChildTitle",
    "busyChildModel",
    "sideConversations",
  ]
    .map(variable)
    .join("\n");
  for (const [query, on] of [
    ["scene=navigation&busyChild=approval", true],
    ["scene=reading&busyChild=approval", false],
    ["scene=navigation", false],
    ["scene=navigation&busyChild=asking", false],
  ]) {
    const result = vm.runInNewContext(
      ts.transpileModule(
        setup + "\nresult={busyChild,busyChildModel,sideConversations};",
        {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        },
      ).outputText,
      {
        params: new URLSearchParams(query),
        childQuestionData: null,
        rails: null,
        summary: (id = "thread-1", name = "Thread one") => ({
          threadId: id,
          name,
          currentMetadata: { model: "fake" },
        }),
      },
    );
    assert.equal(result.busyChild, on);
    const row = result.sideConversations[0];
    assert.equal(row.parentThreadId, "thread-1");
    assert.equal(
      row.currentMetadata.model,
      on ? result.busyChildModel : "fake",
    );
    assert.equal(row.userQuestionSummary?.openCount, on ? 0 : undefined);
    assert.equal(result.sideConversations[1].name, "Test coverage");
  }
  const threadList = await read("../src/renderer/src/thread-list.ts");
  const modelAst = ts.createSourceFile(
    "thread-list.ts",
    threadList,
    ts.ScriptTarget.Latest,
    true,
  );
  const identity = modelAst.statements
    .find(
      (s) =>
        ts.isFunctionDeclaration(s) && s.name?.text === "threadModelIdentity",
    )
    .getText(modelAst)
    .replace(/^export /, "");
  const run = vm.runInNewContext(
    ts.transpileModule(identity + "\nthreadModelIdentity;", {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      providerLogoKindForIdentity: () => "generic",
      i18n: { t: () => "Local demo" },
    },
  );
  const longModel = "Local demonstration model · extended reasoning preview";
  assert.equal(
    run({
      status: "idle",
      currentMetadata: { model: longModel, provider: "fake" },
    }).label,
    longModel,
  );
  assert.match(source, /if \(readingScene \|\| busyChild\)\s*throw new Error/);
  assert.match(source, /requestId: "busy-child-display-only"/);
  assert.match(
    source,
    /params: \{ \.\.\.request.params, threadId: "design-child" \}/,
  );
});
test("isolated fine desktop profile binds clean navigation bundle and keeps native input plus existing sandbox", async () => {
  const [source, helper, builder] = await Promise.all([
    read("../scripts/capture-main-ui-preview.mjs"),
    read("../scripts/navigation-main-ui-preview.mjs"),
    read("../scripts/build-main-ui-preview.mjs"),
  ]);
  assert.match(
    source,
    /desktopBusyChild = captureProfile === "desktop-busy-child"/,
  );
  assert.match(
    source,
    /desktopBusyChild\s*\? process.env.ZENX_BUSY_CHILD_EXPECTED_HEAD/,
  );
  assert.match(
    source,
    /desktopChildNavigation \|\| desktopBusyChild\s*\? "navigation"/,
  );
  assert.match(
    source,
    /if \(desktopBusyChild\) query.set\("busyChild", "approval"\)/,
  );
  assert.match(source, /desktopBusyChild\s*\? captureBusyChild/);
  assert.match(source, /process.env.GITHUB_ACTIONS,\s*"true"/);
  assert.doesNotMatch(source, /"--no-sandbox"/);
  assert.match(
    builder,
    /"apps\/zenx\/scripts\/navigation-main-ui-preview.mjs"/,
  );
  const route = helper.slice(
    helper.indexOf("export async function captureBusyChild"),
  );
  assert.match(route, /await tabTo\(`/);
  assert.match(route, /dispatchNavigationKey\(send, "Escape"/);
  assert.doesNotMatch(
    route,
    /\.focus\(|\.click\(|scrollTop\s*=(?!=)|respondToApproval/,
  );
  assert.match(route, /trip\.states\.push\(\{ name, before \}\)/);
  assert.match(route, /trip.status = "failed"/);
});

test("busy route records only rest plus two native keyboard reveals without selecting child or deciding approval", async () => {
  const { captureBusyChild } =
    await import("../scripts/navigation-main-ui-preview.mjs");
  const state = sample(),
    calls = [],
    names = [];
  state.reveal = null;
  await captureBusyChild({
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === "Input.dispatchKeyEvent" && params.key === "Escape")
        state.reveal = null;
    },
    evaluate: async (expression) =>
      expression.includes("observeBusyChild")
        ? structuredClone(state)
        : undefined,
    wait: async () => {},
    click: async (selector) => calls.push(["click", selector]),
    tabTo: async (selector) => {
      calls.push(["tabTo", selector]);
      state.reveal = box(state.fixture.title);
      return true;
    },
    capture: async (name) => names.push(name),
    evidence: {},
    options: { name: "desktop-light", theme: "light" },
  });
  assert.deepEqual(names, [
    "busy-child-desktop-light-rest",
    "busy-child-desktop-light-project-group-keyboard-reveal",
    "busy-child-desktop-light-recent-thread-group-keyboard-reveal",
  ]);
  assert.deepEqual(
    calls.filter(([m]) => m === "click").map(([, s]) => s),
    [
      '.project-group [data-thread-id="thread-1"] .thread-row',
      '.composer [contenteditable="true"], .composer textarea',
    ],
  );
  assert.equal(calls.filter(([m]) => m === "tabTo").length, 2);
  assert.deepEqual(
    calls.filter(([m]) => m === "Input.dispatchKeyEvent").map(([, p]) => p.key),
    ["Escape", "Escape", "Escape", "Escape"],
  );
});

test("busy receipt separately records wrapped detail facts without changing inline observation gates", async () => {
  const { JSDOM } = await import("jsdom");
  const { observeBusyChild } =
    await import("../scripts/navigation-main-ui-preview.mjs");
  // Unit geometry only: no claim that JSDOM renders or validates wrapping.
  const dom = new JSDOM(
    `<div class="thread-information"><dl><div data-thread-fact="pending-approval"><dt>Status</dt><dd>Needs your approval</dd></div><div data-thread-fact="model"><dt>Model</dt><dd>Long genuine model</dd></div></dl></div>`,
    { runScripts: "outside-only" },
  );
  try {
    const w = dom.window;
    w.__busyChildFixture = { approval: true, asking: false };
    w.__uiPolishTelemetry = {};
    w.HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 300,
      y: 100,
      right: 500,
      bottom: 140,
      width: 200,
      height: 40,
    });
    w.Range.prototype.getClientRects = () => [
      { x: 310, y: 105, right: 490, bottom: 125, width: 180, height: 20 },
    ];
    w.document.elementFromPoint = () => null;
    const result = w.eval(`(${observeBusyChild.toString()})()`);
    assert.deepEqual(
      Array.from(result.detailFacts, (f) => [
        f.kind,
        f.label.text,
        f.value.text,
      ]),
      [
        ["pending-approval", "Status", "Needs your approval"],
        ["model", "Model", "Long genuine model"],
      ],
    );
    assert.equal(result.detailFacts[1].value.glyphs.length, 1);
    assert.equal(result.detailFacts[1].value.rect.height, 40);
    assert.equal(typeof result.detailFacts[1].value.scrollWidth, "number");
    w.document.querySelector(".thread-information").remove();
    assert.equal(
      w.eval(`(${observeBusyChild.toString()})()`).detailFacts.length,
      0,
    );
  } finally {
    dom.window.close();
  }
  const helper = await read("../scripts/navigation-main-ui-preview.mjs");
  const verify = helper.slice(
    helper.indexOf("export function verifyBusyChild"),
    helper.indexOf("/** Three images only"),
  );
  assert.doesNotMatch(
    verify,
    /detailFacts/,
    "New receipt does not relabel the previous observed inline fit as passed",
  );
});
