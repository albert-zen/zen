import assert from "node:assert/strict";

/** Read-only measurements of production App/Markdown/Information/pending surfaces. */
export function observeReading() {
  const read = (selector) => {
    const e = document.querySelector(selector);
    if (!e) return null;
    const r = e.getBoundingClientRect(),
      style = getComputedStyle(e);
    return {
      rect: {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
      visible:
        r.width > 0 &&
        r.height > 0 &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight,
      hit: e.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      ),
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      color: style.color,
      background: style.backgroundColor,
      scrollWidth: e.scrollWidth,
      clientWidth: e.clientWidth,
      scrollHeight: e.scrollHeight,
      clientHeight: e.clientHeight,
      scrollTop: e.scrollTop,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      disabled: !!e.disabled,
    };
  };
  const names = {
    sidebar: ".sidebar",
    thread: ".thread-view",
    column: ".messages-inner",
    messages: ".messages",
    prose: ".agent-copy",
    paragraph: ".agent-copy .markdown-body p",
    h1: ".agent-copy h1",
    h2: ".agent-copy h2",
    h3: ".agent-copy h3",
    list: ".agent-copy ul",
    orderedList: ".agent-copy ol",
    quote: ".agent-copy blockquote",
    table: ".agent-copy .markdown-table-wrap",
    code: ".agent-copy .markdown-code",
    composer: ".composer",
    editor: '.composer [contenteditable="true"], .composer textarea',
    primary: ".composer .action-orb",
    bottom: ".bottom-zone",
    tray: ".pending-tray",
    queue: ".queue-shelf",
    queueEdit: ".queue-row-edit:not(:disabled)",
    approval: ".approval-request-card",
    allow: ".approval-request-card .approval-request-allow",
    deny: ".approval-request-card .approval-request-deny",
    informationEntry: ".information-toolbar button",
    dock: ".information-dock",
    informationClose: ".information-dock .information-dismiss-toolbar button",
  };
  const targets = Object.fromEntries(
    Object.entries(names).map(([key, selector]) => [key, read(selector)]),
  );
  return {
    ...targets,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    conversationUncoveredHeight:
      targets.messages && targets.bottom
        ? Math.max(
            0,
            Math.min(targets.messages.rect.bottom, targets.bottom.rect.y) -
              targets.messages.rect.y,
          )
        : null,
    markdownCounts: Object.fromEntries(
      ["h1", "h2", "h3", "p", "ul", "ol", "table", "pre", "blockquote"].map(
        (tag) => [tag, document.querySelectorAll(`.agent-copy ${tag}`).length],
      ),
    ),
    questionReadErrors: [
      ...document.querySelectorAll(".user-question-read-error"),
    ].map((e) => e.textContent),
    telemetry: window.__uiPolishTelemetry,
  };
}

export function verifyReading(
  s,
  { information = false, pending = false } = {},
) {
  assert(!s.horizontalOverflow, "Whole app stays within the desktop viewport");
  for (const tag of [
    "h1",
    "h2",
    "h3",
    "p",
    "ul",
    "ol",
    "table",
    "pre",
    "blockquote",
  ])
    assert(
      s.markdownCounts[tag] > 0,
      `Real production Markdown renders ${tag}`,
    );
  assert(
    s.column?.rect.width > 0 && s.column.rect.width <= 801,
    "Shared desktop reading column respects its maximum without disappearing",
  );
  assert(
    s.column.rect.x >= s.thread.rect.x &&
      s.column.rect.right <= s.thread.rect.right + 1,
    "Message column stays in its actual conversation panel",
  );
  assert(
    s.composer?.visible && s.editor?.visible && s.editor.hit,
    "Composer stays visible and writable",
  );
  assert(
    s.primary?.visible && s.primary.hit,
    "Primary Composer action remains reachable",
  );
  assert(
    Math.abs(s.column.rect.x - s.composer.rect.x) <= 2 &&
      Math.abs(s.column.rect.right - s.composer.rect.right) <= 2,
    "Transcript and Composer retain their shared column alignment",
  );
  for (const name of ["table", "code"])
    assert(
      s[name]?.rect.x >= s.column.rect.x - 1 &&
        s[name].rect.right <= s.column.rect.right + 1,
      `Structured ${name} remains inside the column; any horizontal scroll is local`,
    );
  assert.deepEqual(s.questionReadErrors, []);
  assert.equal(s.telemetry.informationUpdates, 0, "No Information writes");
  assert(
    !s.telemetry.protocolCalls.includes("zen/turn/send"),
    "No send was requested",
  );
  if (information) {
    assert(
      s.dock?.visible && s.informationClose?.visible && s.informationClose.hit,
      "Real desktop Information dock and close control are reachable",
    );
    assert(
      s.thread.rect.right <= s.dock.rect.x + 1,
      "Information does not cover the message panel",
    );
    assert(
      s.telemetry.informationReads.length > 0,
      "Production Information reads the synthetic owner",
    );
  } else
    assert(!s.dock, "Closed Information is absent, not an overlaid fixture");
  if (pending) {
    assert(s.queue && s.approval, "Actual Queue and Approval cards coexist");
    for (const name of ["queue", "approval"])
      assert(
        s[name].rect.x >= s.column.rect.x - 2 &&
          s[name].rect.right <= s.column.rect.right + 2,
        `${name} fits the same reading width`,
      );
    for (const name of ["queueEdit", "allow", "deny"])
      assert(
        s[name]?.visible && s[name].hit && !s[name].disabled,
        `${name} remains available without a side-effecting click`,
      );
  } else
    assert(
      !s.queue && !s.approval,
      "Normal reading does not inject pending chrome",
    );
}

/** Native wheel only. Observe each outcome; never rewrite scrollTop or DOM. */
export async function scrollReadingTo({
  send,
  evaluate,
  evidence,
  theme,
  target = null,
}) {
  const attempt = { theme, target: target ?? "top", wheels: [] };
  (evidence.readingScrollAttempts ??= []).push(attempt);
  for (let n = 0; n < 12; n++) {
    const state = await evaluate(`(() => {
      const scroller=document.querySelector('.messages'), r=scroller.getBoundingClientRect();
      const zone=document.querySelector('.bottom-zone').getBoundingClientRect();
      const e=${target ? `document.querySelector(${JSON.stringify(target)})` : "null"};
      return {scrollTop:scroller.scrollTop, targetY:e?.getBoundingClientRect().y??null,
        top:r.y, x:r.x+r.width/2, y:r.y+Math.min(80,Math.max(20,(zone.y-r.y)/2))};
    })()`);
    if (target)
      assert(
        Number.isFinite(state.targetY),
        "Requested production reading block exists",
      );
    const deltaY = target ? state.targetY - (state.top + 32) : -state.scrollTop;
    assert(
      Number.isFinite(deltaY),
      "Requested production reading block exists",
    );
    if (Math.abs(deltaY) <= 2) {
      attempt.matched = true;
      return;
    }
    attempt.wheels.push({ ...state, deltaY });
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: state.x,
      y: state.y,
      deltaX: 0,
      deltaY,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Native reading scroll did not reach ${target ?? "top"}`);
}

export async function captureDesktopReading({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
  url,
}) {
  const observe = () => evaluate(`(${observeReading.toString()})()`);
  const openThread = async () => {
    await click('.project-group [data-thread-id="thread-1"] .thread-row');
    await wait(
      "!!document.querySelector('.agent-copy h1') && !!document.querySelector('.composer')",
    );
    await click('.composer [contenteditable="true"], .composer textarea');
    await send("Input.insertText", {
      text: "Keep this synthetic draft while reviewing the layout.",
    });
  };
  const save = async (step, expected) => {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 10,
      y: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = await observe();
    (evidence.readingCases ??= []).push({
      step,
      theme: options.theme,
      ...state,
    });
    await capture(`reading-${options.name}-${step}`, options, "reading");
    verifyReading(state, expected);
    return state;
  };
  const scroll = (target) =>
    scrollReadingTo({ send, evaluate, evidence, theme: options.theme, target });
  const openInformation = async () => {
    await click(".information-toolbar button");
    await wait(
      "!!document.querySelector('.information-dock .information-dismiss-toolbar button')",
    );
  };
  try {
    await openThread();
    await scroll();
    await save("prose-top", {});
    await scroll(".agent-copy h3");
    const list = await save("heading-list", {});
    assert(
      list.h3.visible &&
        list.list.visible &&
        list.list.rect.bottom <= list.bottom.rect.y,
      "Third-level heading and list are actually visible in their frame",
    );
    await scroll(".agent-copy .markdown-table-wrap");
    const detail = await save("table-code", {});
    assert(
      detail.table.visible &&
        detail.code.visible &&
        detail.code.rect.bottom <= detail.bottom.rect.y,
      "Table and code are both visible in the detail frame",
    );
    await openInformation();
    await scroll();
    await save("information-reading", { information: true });
    const pendingUrl = new URL(url);
    pendingUrl.searchParams.set("pending", "1");
    await send("Page.navigate", { url: pendingUrl.href });
    await wait(
      `location.href===${JSON.stringify(pendingUrl.href)} && !!document.querySelector('.thread-row')`,
    );
    await openThread();
    await wait(
      "!!document.querySelector('.approval-request-card') && !!document.querySelector('.queue-shelf')",
    );
    await scroll();
    await save("pending-approval", { pending: true });
    await openInformation();
    await scroll();
    await save("pending-information", { pending: true, information: true });
  } catch (error) {
    (evidence.readingFailures ??= []).push({
      theme: options.theme,
      error: String(error),
    });
    try {
      await capture(`reading-${options.name}-failed`, options, "reading");
    } catch {}
    throw error;
  }
}

export const readingPaths = [
  ".github/workflows/desktop-reading-ui.yml",
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/src/renderer/src/theme.css",
  "apps/zenx/src/renderer/src/Markdown.tsx",
  "apps/zenx/src/renderer/src/ThreadView.tsx",
  "apps/zenx/src/renderer/src/App.tsx",
  "apps/zenx/src/renderer/src/queued-messages.css",
  "apps/zenx/test/fixtures/ui-polish-visual.tsx",
  "apps/zenx/test/fixtures/ui-polish-reading.ts",
  "apps/zenx/test/reading-fixture.test.ts",
  "apps/zenx/test/reading-main-ui-preview.test.mjs",
  "apps/zenx/scripts/reading-main-ui-preview.mjs",
  "apps/zenx/scripts/build-main-ui-preview.mjs",
  "apps/zenx/scripts/capture-main-ui-preview.mjs",
];
export const readingPathsChanged = (paths) =>
  paths.some((path) => readingPaths.includes(path));
