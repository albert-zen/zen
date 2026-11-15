import {
  sidebarIdentityCases,
  sidebarIdentityCase,
} from "../scripts/sidebar-identity-cases.mjs";
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
  glyphs: [
    {
      x: 15,
      y: 12,
      right: 100,
      bottom: 28,
      width: 85,
      height: 16,
      centerHit: true,
    },
  ],
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
    composer: {
      ...box(""),
      rect: { x: 0, y: 500, right: 800, bottom: 608, width: 800, height: 108 },
    },
    composerCount: 1,
    composerEditor: box(""),
    composerPrimary: box(""),
    pane: {
      ...box(""),
      rect: { x: 0, y: 0, right: 328, bottom: 300, width: 328, height: 300 },
    },
    detailFacts: [
      {
        kind: "pending-approval",
        label: box("Status"),
        value: box("Needs your approval"),
      },
      { kind: "model", label: box("Model"), value: box(model) },
    ],
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
    (s) => (s.pane = null),
    (s) => (s.pane.rect.bottom = 501),
    (s) => (s.composerCount = 2),
    (s) => (s.composerEditor.centerHit = false),
    (s) => (s.composerPrimary.disabled = true),
    (s) => (s.detailFacts[1].value.glyphs = []),
    (s) => (s.detailFacts[1].value.glyphs[0].right = 400),
    (s) => (s.detailFacts[1].value.glyphs[0].centerHit = false),
  ]) {
    const bad = sample();
    mutate(bad);
    assert.throws(() => verifyBusyChild(bad, "project-group"));
  }
});
test("approval-only observer validates canonical and decorative compact text separately", () => {
  const dual = () => {
    const state = sample();
    for (const alias of state.aliases) {
      alias.approval.text = "Needs your approvalNeeds approval";
      alias.approvalFull = { ...box("Needs your approval"), ariaHidden: null };
      alias.approvalCompact = { ...box("Needs approval"), ariaHidden: "true" };
    }
    return state;
  };
  const state = dual();
  verifyBusyChild(state, null);
  verifyBusyChild(state, "project-group", state);
  verifyBusyChild(state, "recent-thread-group", state);
  for (const mutate of [
    (a) => (a.approvalFull.text = "Wrong full wording"),
    (a) => (a.approvalFull.ariaHidden = "true"),
    (a) => (a.approvalFull = null),
    (a) => (a.approvalCompact.text = "Wrong compact wording"),
    (a) => (a.approvalCompact.ariaHidden = null),
    (a) => (a.approval.text += "unexpected text"),
  ]) {
    for (const index of [0, 1]) {
      const bad = dual();
      mutate(bad.aliases[index]);
      assert.throws(() => verifyBusyChild(bad, null));
    }
  }
  const legacyWrong = sample();
  legacyWrong.aliases[0].approval.text = "Needs your approvalNeeds approval";
  assert.throws(() => verifyBusyChild(legacyWrong, null));
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
    "combinedAttention",
    "busyChild",
    "identityCaseName",
    "identityCase",
    "busyChildTitle",
    "busyChildSiblingTitle",
    "busyChildModel",
    "sideConversations",
  ]
    .map(variable)
    .join("\n");
  for (const [query, on, combined, identityName] of [
    ["scene=navigation&busyChild=approval", true],
    ["scene=navigation&busyChild=approval-asking", true, true],
    ["scene=reading&busyChild=approval-asking", false],
    ["scene=reading&busyChild=approval", false],
    ["scene=navigation", false],
    ["scene=navigation&busyChild=asking", false],
    ...Object.entries(sidebarIdentityCases).map(([name, scene]) => [
      `scene=navigation&busyChild=approval-asking&identityCase=${name}&lang=${scene.lang}`,
      true,
      true,
      name,
    ]),
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
        sidebarIdentityCase,
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
    if (identityName)
      assert.equal(row.name, sidebarIdentityCase(identityName).title);
    assert.equal(row.parentThreadId, "thread-1");
    assert.equal(
      row.currentMetadata.model,
      on ? result.busyChildModel : "fake",
    );
    assert.equal(
      row.userQuestionSummary?.openCount,
      combined ? 2 : on ? 0 : undefined,
    );
    assert.equal(
      result.sideConversations[1].name,
      identityName
        ? sidebarIdentityCase(identityName).siblingTitle
        : combined
          ? `${row.name} · alternate review`
          : "Test coverage",
    );
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
    /desktopChildNavigation \|\| desktopBusyChild \|\| desktopCombinedAttention\s*\? "navigation"/,
  );
  assert.match(
    source,
    /if \(desktopBusyChild\) query.set\("busyChild", "approval"\)/,
  );
  assert.match(source, /desktopBusyChild\s*\? captureBusyChild/);
  assert.match(
    source,
    /desktopCombinedAttention\s*\? process.env.ZENX_COMBINED_ATTENTION_EXPECTED_HEAD/,
  );
  assert.match(
    source,
    /if \(desktopCombinedAttention\) query.set\("busyChild", "approval-asking"\)/,
  );
  assert.match(
    source,
    /desktopCombinedAttention\s*\? combinedAttentionCapture/,
  );
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
    `<div class="sidebar">${["project-group", "recent-thread-group"].map((scope) => `<div class="${scope}"><div data-thread-id="design-child"><div class="thread-row"><span class="thread-state-inline"><span class="thread-approval-full">Needs your approval</span><span class="thread-approval-compact" aria-hidden="true">Needs approval</span></span></div></div></div>`).join("")}</div><div class="thread-information"><dl><div data-thread-fact="pending-approval"><dt>Status</dt><dd>Needs your approval</dd></div><div data-thread-fact="model"><dt>Model</dt><dd>Long genuine model</dd></div></dl></div>`,
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
    for (const alias of result.aliases) {
      assert.equal(alias.approval.text, "Needs your approvalNeeds approval");
      assert.equal(alias.approvalFull.text, "Needs your approval");
      assert.equal(alias.approvalFull.ariaHidden, null);
      assert.equal(alias.approvalCompact.text, "Needs approval");
      assert.equal(alias.approvalCompact.ariaHidden, "true");
    }
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
    /alias\.model\.ellipsized/,
    "New receipt does not relabel the previous observed inline fit as passed",
  );
});

test("scoped pending-child placement keeps default algorithm, protects Composer and preserves row hover bridge", async () => {
  const ts = await import("typescript");
  const source = await read("../src/renderer/src/Sidebar.tsx");
  const ast = ts.createSourceFile(
    "Sidebar.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fn = (n) =>
    ast.statements.find(
      (s) => ts.isFunctionDeclaration(s) && s.name?.text === n,
    );
  let update;
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(ast) === "update")
      update = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(fn("SidebarMenuPopover"));
  assert(update);
  const code = ts.transpileModule(
    `const SIDEBAR_MENU_GAP=6, SIDEBAR_MENU_VIEWPORT_MARGIN=8;\n${fn("sidebarMenuLayout").getText(ast)};return {update:(${update.getText(ast)}), base:sidebarMenuLayout};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const run = (changes = {}) => {
    const a = {
      left: 8,
      right: 246,
      top: 512,
      bottom: 562,
      width: 238,
      height: 50,
      ...changes.anchor,
    };
    const m = { width: 328, height: 280.8, ...changes.menu };
    const c = {
      left: 371.5,
      right: 1171.5,
      top: 774,
      bottom: 882,
      width: 800,
      height: 108,
      ...changes.composer,
    };
    let result,
      queried = 0,
      measured = 0,
      styled = 0,
      observed = 0;
    const target = changes.missingComposer
      ? null
      : {
          getBoundingClientRect: () => {
            measured++;
            return c;
          },
        };
    const api = new Function(
      "anchor",
      "menu",
      "composer",
      "window",
      "getComputedStyle",
      "setLayout",
      "observer",
      code,
    )(
      {
        getBoundingClientRect: () => a,
        closest: () => {
          queried++;
          return { querySelector: () => target };
        },
      },
      {
        getBoundingClientRect: () => m,
        matches: () => changes.informationOnly !== false,
        querySelector: () => (changes.pending !== false ? {} : null),
      },
      null,
      { innerWidth: 1280, innerHeight: 900 },
      () => {
        styled++;
        return { visibility: "visible", opacity: changes.hidden ? "0" : "1" };
      },
      (f) => {
        result = f(result);
      },
      {
        observe: () => {
          observed++;
        },
        unobserve: () => {},
      },
    );
    const original = api.base(a, m, 1280, 900);
    api.update();
    return { result, original, a, m, c, queried, measured, styled, observed };
  };
  const recent = run();
  assert.equal(recent.result.top, 485);
  assert(recent.result.top + recent.m.height + 8 <= recent.c.top);
  assert(recent.result.top + recent.m.height > recent.a.top);
  const project = run({ anchor: { top: 302, bottom: 352 } });
  assert.deepEqual(project.result, project.original);
  for (const changes of [
    { pending: false },
    { informationOnly: false },
    { missingComposer: true },
    { hidden: true },
    { menu: { width: 0 } },
    { menu: { height: 0 } },
    { composer: { height: 0 } },
    { anchor: { height: 0 } },
    { composer: { left: 900, right: 1200, width: 300 } },
    { menu: { height: 800 } },
    { anchor: { top: 850, bottom: 900 } },
  ]) {
    const s = run(changes);
    assert.deepEqual(s.result, s.original);
    if (changes.pending === false || changes.informationOnly === false)
      assert.deepEqual(
        [s.queried, s.measured, s.styled, s.observed],
        [0, 0, 0, 0],
      );
  }
  assert.match(
    source,
    /:scope > main\.workspace #primary-conversation-content \.composer/,
  );
  assert.match(source, /if \(composer\) observer\?\.observe\(composer\)/);
});
