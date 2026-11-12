import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const load = (file) => readFile(new URL(file, import.meta.url), "utf8");
test("fast capture preserves browser sandbox and requires actual CI", async () => {
  const capture = await load("../scripts/capture-main-ui-preview.mjs");
  assert.match(capture, /process\.env\.GITHUB_ACTIONS,\s*"true"/u);
  assert.doesNotMatch(
    capture,
    /["']--(?:no-sandbox|disable-setuid-sandbox|disable-web-security)/u,
  );
  assert.match(capture, /browserSandboxDisabled: false/u);
  assert.match(capture, /Page\.captureScreenshot/u);
  assert.match(capture, /Input\.dispatchMouseEvent/u);
  assert.match(capture, /primaryPointerType=4.*primaryHoverType=2/u);
  assert.ok(capture.includes("matchMedia('(pointer:fine)').matches"));
  assert.ok(capture.includes("matchMedia('(hover:hover)').matches"));
  assert.ok(capture.includes("matches(':hover')"));
});
test("bundle source and screenshot receipts bind actual production scenes", async () => {
  const build = await load("../scripts/build-main-ui-preview.mjs");
  const capture = await load("../scripts/capture-main-ui-preview.mjs");
  for (const file of [
    "ui-polish-visual.tsx",
    "queue-steer-visual.tsx",
    "information-layout-preview.tsx",
  ])
    assert.ok(build.includes(file));
  assert.match(build, /preview-source-receipt/u);
  assert.match(build, /connect-src 'none'/u);
  assert.match(build, /dirtyFiles:/u);
  assert.match(build, /diffSha256:/u);
  assert.match(capture, /Rebuild changed source/u);
  assert.match(capture, /evidence\.screenshots\[filename\] = hash\(bytes\)/u);
});
test("independent fast workflow does not depend on aggregate CI or native build", async () => {
  const workflow = await load("../../../.github/workflows/main-ui-preview.yml");
  assert.match(workflow, /head\.sha \|\| github\.sha/u);
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/u);
  assert.doesNotMatch(
    workflow,
    /\bneeds:|npm (?:test|run (?:check|build|typecheck))\b/u,
  );
  assert.match(workflow, /timeout-minutes: 6/u);
  assert.match(workflow, /persist-credentials: false/u);
});

test("pending density captures real compact widths and source-bound DOM geometry", async () => {
  const capture = await load("../scripts/capture-main-ui-preview.mjs");
  for (const name of ["narrow-dark", "compact-light", "compact-dark"])
    assert.ok(capture.includes(`name: "${name}"`));
  assert.match(capture, /width: 390/u);
  assert.match(capture, /options\.onlyScene && scene !== options\.onlyScene/u);
  for (const field of [
    "bodyWidthRatio",
    "bodyHorizontalOverflow",
    "actionLineCount",
    "fullyWithinTrayCount",
    "centerHit",
    "pendingLayout",
  ])
    assert.ok(capture.includes(field));
  // Parse, but do not execute, the exact browser-side observation expression.
  // Browser geometry must come from the hosted renderer, never JSDOM estimates.
  const observation = capture.match(
    /const observation = await evaluate\(`([\s\S]*?)`\);/u,
  );
  assert.ok(observation);
  assert.doesNotThrow(() => new Function(`return ${observation[1]};`));
});

async function inspectMarkup(markup, { zeroRowWidth = false } = {}) {
  const [{ JSDOM }, { runInNewContext }] = await Promise.all([
    import("jsdom"),
    import("node:vm"),
  ]);
  const capture = await load("../scripts/capture-main-ui-preview.mjs");
  const expression = capture.match(
    /const observation = await evaluate\(`([\s\S]*?)`\);/u,
  )[1];
  const dom = new JSDOM(markup, {
    url: "https://preview.invalid/pending.html",
  });
  const { document, HTMLElement } = dom.window;
  try {
    // Explicit synthetic boxes test observation logic, not browser layout.
    // JSDOM's default zero boxes would filter out the real failing Steer rows.
    HTMLElement.prototype.getBoundingClientRect = function () {
      const width = this.matches(".queue-row-content")
        ? 400
        : this.matches(".queue-row") && zeroRowWidth
          ? 0
          : 500;
      return { x: 10, y: 10, width, height: 40, right: 10 + width, bottom: 50 };
    };
    document.elementFromPoint = () => document.querySelector("button");
    document.body.innerText = document.body.textContent;
    return JSON.parse(
      JSON.stringify(
        runInNewContext(expression, {
          document,
          location: dom.window.location,
          navigator: { maxTouchPoints: 0 },
          innerWidth: 1280,
          innerHeight: 900,
          matchMedia: () => ({ matches: true }),
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        }),
      ),
    );
  } finally {
    dom.window.close();
  }
}

async function productionPendingMarkup() {
  const [{ tsImport }, React, { renderToStaticMarkup }] = await Promise.all([
    import("tsx/esm/api"),
    import("react"),
    import("react-dom/server"),
  ]);
  const [{ PendingSteerPanel }, { QueuedMessages }] = await Promise.all([
    tsImport("../src/renderer/src/PendingSteerPanel.tsx", import.meta.url),
    tsImport("../src/renderer/src/QueuedMessages.tsx", import.meta.url),
  ]);
  const prior = globalThis.React;
  globalThis.React = React;
  try {
    const pending = [
      {
        id: "steer-text",
        input: [{ type: "text", text: "Synthetic pending text" }],
      },
      {
        id: "steer-image",
        input: [
          {
            type: "image",
            attachment: {
              sha256: "a".repeat(64),
              byteLength: 1,
              mediaType: "image/png",
            },
          },
        ],
      },
    ].map((item) => ({
      ...item,
      clientId: item.id,
      threadId: "synthetic-thread",
      type: "user_message_queued",
      createdAt: "2026-11-11T00:00:00Z",
      deliveryMode: "steer",
      expectedTurnId: "synthetic-turn",
      revision: 0,
    }));
    return renderToStaticMarkup(
      React.createElement(
        "div",
        { className: "pending-tray" },
        React.createElement(PendingSteerPanel, {
          integrated: true,
          threadId: "synthetic-thread",
          items: [],
          pending,
          runningTurnId: "synthetic-turn",
        }),
        React.createElement(QueuedMessages, {
          threadId: "synthetic-thread",
          integrated: true,
          messages: [
            {
              id: "queue-text",
              clientId: "queue-text",
              text: "Synthetic queue",
              imageCount: 0,
            },
          ],
          onMove() {},
          onSteer() {},
          onEdit() {},
          onCancel() {},
        }),
      ),
    );
  } finally {
    if (prior === undefined) delete globalThis.React;
    else globalThis.React = prior;
  }
}

test("observer executes on actual production text/image Steer and Queue DOM", async () => {
  const markup = await productionPendingMarkup();
  assert.match(markup, /queue-row user-row steer-shelf-row/u);
  assert.match(markup, /pending-steer-images/u);
  const { pendingLayout } = await inspectMarkup(markup);
  assert.equal(pendingLayout.rows.length, 3);
  const [text, image, queue] = pendingLayout.rows;
  assert.equal(text.kind, "steer");
  assert.equal(text.bodySelector, ".user-bubble");
  assert.equal(image.kind, "steer");
  assert.equal(image.bodySelector, ".pending-steer-images");
  for (const row of [text, image]) {
    assert.equal(row.actionsRect, null);
    assert.equal(row.actionLineCount, null);
    assert.deepEqual(row.controls, []);
    assert.deepEqual(row.observationWarnings, []);
    assert.equal(row.bodyWidthRatio, 1);
  }
  assert.equal(queue.kind, "queue");
  assert.equal(queue.id, "queue-text");
  assert.equal(queue.bodyWidthRatio, 0.8);
  assert.equal(queue.actionLineCount, 1);
  assert.equal(queue.controls.length, 5);
  assert.deepEqual(queue.observationWarnings, []);
});

test("observer reports missing and zero-width bodies without fabricated measurements", async () => {
  const { pendingLayout } = await inspectMarkup(
    `<div class="pending-tray">
    <div class="queue-row">Unknown row</div>
    <div class="queue-row" data-queue-id="missing-body"><div class="queue-row-actions"></div></div>
    <div class="queue-row" data-queue-id="zero"><div class="queue-row-content"></div></div>
  </div>`,
    { zeroRowWidth: true },
  );
  const [unknown, missing, zero] = pendingLayout.rows;
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.bodyRect, null);
  assert.equal(unknown.bodyWidthRatio, null);
  assert.equal(unknown.bodyHorizontalOverflow, null);
  assert.ok(unknown.observationWarnings.includes("unrecognized-row-kind"));
  assert.equal(missing.kind, "queue");
  assert.equal(missing.bodyRect, null);
  assert.ok(missing.observationWarnings.includes("missing-body"));
  assert.equal(zero.bodyWidthRatio, null);
  assert.ok(zero.observationWarnings.includes("zero-width-row"));
});

async function captureInitializer(name, context = {}) {
  const [{ default: ts }, { runInNewContext }] = await Promise.all([
    import("typescript"),
    import("node:vm"),
  ]);
  const text = await load("../scripts/capture-main-ui-preview.mjs");
  const ast = ts.createSourceFile(
    "capture.mjs",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(initializer, name);
  return runInNewContext(`(${initializer.getText(ast)})`, context);
}

test("fine and independently launched coarse profiles cover actual 390 by 600 views", async () => {
  const fineCases = await captureInitializer("fineCases");
  const coarseCases = await captureInitializer("cases", {
    coarse: true,
    fineCases,
  });
  assert.equal(
    fineCases.filter((value) => value.width === 390 && value.height === 600)
      .length,
    2,
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        coarseCases.map((value) => [
          value.width,
          value.height,
          value.theme,
          value.onlyScene,
        ]),
      ),
    ),
    [
      [390, 600, "light", "pending"],
      [390, 600, "dark", "pending"],
    ],
  );
  const source = await load("../scripts/capture-main-ui-preview.mjs");
  assert.match(
    source,
    /primaryPointerType=2,availablePointerTypes=2,primaryHoverType=0,availableHoverTypes=0/u,
  );
  assert.ok(
    source.includes(
      "matchMedia('(pointer:coarse)').matches && !matchMedia('(pointer:fine)').matches",
    ),
  );
  assert.ok(
    source.includes(
      "matchMedia('(hover:none)').matches && !matchMedia('(hover:hover)').matches && navigator.maxTouchPoints > 0",
    ),
  );
  assert.ok(source.includes('"Emulation.setTouchEmulationEnabled"'));
  assert.ok(source.includes("maxTouchPoints: 1"));
  assert.ok(source.includes('"evidence-coarse.json"'));
  assert.ok(source.includes('path.join(directory, "coarse")'));
  assert.match(
    source,
    /if \(!coarse\)\s*\{\s*await send\("Input.dispatchMouseEvent"/u,
  );
  assert.ok(source.includes('await tabTo(".composer textarea")'));
  const workflow = await load("../../../.github/workflows/main-ui-preview.yml");
  assert.match(workflow, /capture-main-ui-preview\.mjs[^\n]* fine/u);
  assert.match(workflow, /capture-main-ui-preview\.mjs[^\n]* coarse/u);
  assert.match(workflow, /main-ui-preview\/coarse\/\*\.json/u);
  assert.ok(
    workflow.includes("!cancelled() && steps.bundle.outcome == 'success'"),
  );
});

test("coarse pointer interaction uses native touch start/end, not a mouse surrogate", async () => {
  const calls = [];
  const click = await captureInitializer("click", {
    coarse: true,
    wait: async () => {},
    evaluate: async () => ({ x: 30, y: 40 }),
    send: async (...args) => calls.push(args),
  });
  await click(".composer textarea");
  const normalized = JSON.parse(JSON.stringify(calls));
  assert.deepEqual(
    normalized.map(([method, params]) => [method, params.type]),
    [
      ["Input.dispatchTouchEvent", "touchStart"],
      ["Input.dispatchTouchEvent", "touchEnd"],
    ],
  );
  assert.equal(normalized[0][1].touchPoints[0].x, 30);
  assert.deepEqual(normalized[1][1].touchPoints, []);
});

test("short/coarse acceptance checks reject inaccessible Composer and tiny targets after saving diagnostics", async () => {
  const { default: path } = await import("node:path");
  const goodTarget = () => ({
    rect: { width: 44, height: 44 },
    fullyInViewport: true,
    centerHit: true,
    disabled: false,
  });
  for (const fault of [
    null,
    "editor-clipped",
    "editor-covered",
    "primary-clipped",
    "queue-tiny",
    "primary-tiny",
  ]) {
    const observation = {
      composerAccess: { editor: goodTarget(), primary: goodTarget() },
      pendingLayout: { rows: [{ controls: [goodTarget()] }] },
    };
    if (fault === "editor-clipped")
      observation.composerAccess.editor.fullyInViewport = false;
    if (fault === "editor-covered")
      observation.composerAccess.editor.centerHit = false;
    if (fault === "primary-clipped")
      observation.composerAccess.primary.fullyInViewport = false;
    if (fault === "queue-tiny")
      observation.pendingLayout.rows[0].controls[0].rect.width = 28;
    if (fault === "primary-tiny")
      observation.composerAccess.primary.rect.height = 28;
    const writes = [];
    const evidence = { screenshots: {}, cases: [] };
    const capture = await captureInitializer("capture", {
      assert,
      coarse: true,
      Buffer,
      path,
      directory: "/synthetic",
      evidenceFile: "evidence-coarse.json",
      evidence,
      hash: () => "synthetic-hash",
      delay: async () => {},
      evaluate: async (expression) =>
        expression.startsWith("document.fonts") ? undefined : observation,
      send: async (method) => {
        assert.equal(method, "Page.captureScreenshot");
        return { data: Buffer.from("not-a-real-png").toString("base64") };
      },
      writeFile: async (file) => writes.push(file),
    });
    const run = () =>
      capture("synthetic-case", { width: 390, height: 600 }, "pending");
    if (fault) await assert.rejects(run, /viewport|44 by 44/u, fault);
    else await run();
    assert.deepEqual(writes, [
      "/synthetic/synthetic-case.png",
      "/synthetic/evidence-coarse.json",
    ]);
    assert.equal(evidence.cases.length, 1);
  }
});
