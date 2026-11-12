import { captureScrollbarStates } from "./scrollbar-main-ui-preview.mjs";
import assert from "node:assert/strict";
import { dispatchNavigationKey } from "./navigation-main-ui-preview.mjs";

/** Read-only measurements of production App/Markdown/Information/pending surfaces. */
/** Wait for the actual desktop surface and its sole, expanded entry. */
export function informationDockReady(root) {
  const dock = root.querySelector(".information-dock");
  const toggle = root.querySelector(
    '.information-toolbar button[aria-expanded="true"]',
  );
  if (!dock || !toggle || dock.hidden || toggle.disabled) return false;
  const rect = dock.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    toggle.getAttribute("aria-controls") === dock.id
  );
}

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
      offsetWidth: e.offsetWidth,
      clientLeft: e.clientLeft,
      scrollHeight: e.scrollHeight,
      clientHeight: e.clientHeight,
      scrollTop: e.scrollTop,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      disabled: !!e.disabled,
      id: e.id,
      controls: e.getAttribute("aria-controls"),
      expanded: e.getAttribute("aria-expanded"),
      focused: document.activeElement === e,
      focusVisible: e.matches(":focus-visible"),
      outline: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
    };
  };
  const names = {
    sidebar: ".sidebar",
    thread: ".thread-view",
    column:
      ".virtual-transcript-header, .virtual-transcript-row, .messages-inner",
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
    approvalToggle: ".approval-request-card .approval-reading-toggle",
    approvalSummary: ".approval-request-card .approval-reading-summary",
    approvalBody: ".approval-request-card .approval-request-body",
    allow: ".approval-request-card .approval-request-allow",
    deny: ".approval-request-card .approval-request-deny",
    informationEntry: ".information-toolbar button",
    dock: ".information-dock",
    informationClose: '.information-toolbar button[aria-expanded="true"]',
  };
  const targets = Object.fromEntries(
    Object.entries(names).map(([key, selector]) => [key, read(selector)]),
  );
  const card = document.querySelector(names.approval);
  const toggle = document.querySelector(names.approvalToggle);
  const region = document.getElementById(toggle?.getAttribute("aria-controls"));
  const editor = document.querySelector(names.editor);
  return {
    ...targets,
    approvalRequestId: card?.getAttribute("data-approval-request") ?? null,
    approvalReading: card?.getAttribute("data-reading") === "true",
    approvalControlledRegion: !!region && !!card?.contains(region),
    approvalSummaryText:
      document.querySelector(names.approvalSummary)?.textContent ?? null,
    approvalScopeText:
      document.querySelector(".approval-request-card .approval-request-scope")
        ?.textContent ?? null,
    draft: editor
      ? "value" in editor
        ? editor.value
        : editor.textContent
      : null,
    columnKind: document.querySelector(names.column)?.className ?? null,
    messageScrollbarWidth: targets.messages
      ? targets.messages.offsetWidth -
        targets.messages.clientWidth -
        2 * targets.messages.clientLeft
      : null,
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
  { information = false, pending = false, approvalReading = false } = {},
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
      "Real desktop Information dock and its single toggle are reachable",
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
    for (const name of approvalReading
      ? ["queueEdit"]
      : ["queueEdit", "allow", "deny"])
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

export function verifyApprovalMode(
  s,
  { reading, baseline, focus = false } = {},
) {
  assert(
    s.approvalToggle?.visible &&
      s.approvalToggle.hit &&
      !s.approvalToggle.disabled,
    "Approval disclosure stays available",
  );
  assert(
    s.approvalControlledRegion,
    "Disclosure owns its actual stable content region",
  );
  assert.equal(s.approvalToggle.expanded, String(!reading));
  assert.equal(s.approvalReading, reading);
  if (baseline) {
    assert.equal(
      s.draft,
      baseline.draft,
      "Reading and request changes preserve the draft",
    );
    assert(
      s.composer.rect.height >= baseline.composer.rect.height - 1,
      "Reading does not shrink Composer",
    );
  }
  if (focus)
    assert(
      s.approvalToggle.focused &&
        s.approvalToggle.focusVisible &&
        s.approvalToggle.outline !== "none" &&
        s.approvalToggle.outlineWidth > 0,
      "Native keyboard toggle keeps visible focus",
    );
  if (reading) {
    assert(
      s.approvalSummary?.visible && !s.approvalBody && !s.allow && !s.deny,
      "Summary contains no approval decision controls or hidden full body",
    );
    assert.match(s.approvalSummaryText, /run_code/);
    assert.match(s.approvalSummaryText, /Request to remember permission/);
    assert.match(
      s.approvalSummaryText,
      /Waiting for your review.*No decision/s,
    );
    if (baseline) {
      assert.equal(s.approvalRequestId, baseline.approvalRequestId);
      assert.equal(s.approvalToggle.controls, baseline.approvalToggle.controls);
      assert(
        s.approval.rect.height < baseline.approval.rect.height,
        "Explicit reading actually reduces the card height",
      );
      assert(
        s.conversationUncoveredHeight > baseline.conversationUncoveredHeight,
        "Explicit reading gains real conversation space",
      );
    }
  } else
    assert(
      !s.approvalSummary && s.approvalBody && s.allow && s.deny,
      "Default or restored request exposes the full review and decisions",
    );
}

export async function tabToApprovalToggle({ send, evaluate, evidence, theme }) {
  const attempt = { theme, steps: 0, matched: false, observations: [] };
  (evidence.approvalReadingKeyAttempts ??= []).push(attempt);
  for (let i = 0; i < 80; i++) {
    await dispatchNavigationKey(send, "Tab", "Tab", 9);
    attempt.steps = i + 1;
    const observation = await evaluate(
      "({matched: document.activeElement?.matches('.approval-reading-toggle:focus-visible'), tag: document.activeElement?.tagName, id: document.activeElement?.id, classes: document.activeElement?.className})",
    );
    attempt.observations.push(observation);
    if (observation.matched) {
      attempt.matched = true;
      return attempt;
    }
  }
  throw Error("Native Tab did not reach approval reading disclosure");
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
    await wait(`(${informationDockReady.toString()})(document)`);
  };
  try {
    await openThread();
    await scroll();
    await save("prose-top", {});
    await captureScrollbarStates({
      send,
      evaluate,
      capture,
      evidence,
      options,
    });
    await scroll();
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
    // Opt-in synthetic stress cases use the same production desktop components.
    // Collapsed is a saved initial layout, not a claim of click acceptance.
    for (const rails of ["long", "collapsed"]) {
      const stressUrl = new URL(url);
      stressUrl.searchParams.set("rails", rails);
      await send("Page.navigate", { url: stressUrl.href });
      await wait(
        `location.href===${JSON.stringify(stressUrl.href)} && !!document.querySelector('.thread-row')`,
      );
      await openThread();
      await openInformation();
      await scroll();
      await wait(
        "document.querySelectorAll('.information-widget').length >= 2",
      );
      await save(`supporting-rails-${rails}`, { information: true });
    }
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
    // Approval coexistence intentionally starts the compact Queue collapsed.
    // Open its real disclosure before judging message actions, never alter DOM.
    if (
      await evaluate(
        "document.querySelector('.queue-shelf-toggle')?.getAttribute('aria-expanded') === 'false'",
      )
    )
      await click(".queue-shelf-toggle");
    await wait("!!document.querySelector('.queue-row-edit:not(:disabled)')");
    await scroll();
    await save("pending-approval", { pending: true });
    await openInformation();
    await scroll();
    const fullApproval = await save("pending-information", {
      pending: true,
      information: true,
    });
    verifyApprovalMode(fullApproval, { reading: false });
    await tabToApprovalToggle({
      send,
      evaluate,
      evidence,
      theme: options.theme,
    });
    await dispatchNavigationKey(send, "Enter", "Enter", 13);
    await wait(
      "document.querySelector('.approval-request-card')?.getAttribute('data-reading') === 'true'",
    );
    const summary = await save("approval-explicit-reading", {
      pending: true,
      information: true,
      approvalReading: true,
    });
    verifyApprovalMode(summary, {
      reading: true,
      baseline: fullApproval,
      focus: true,
    });
    await dispatchNavigationKey(send, "Enter", "Enter", 13);
    await wait("!document.querySelector('.approval-reading-summary')");
    const restored = await save("approval-restored", {
      pending: true,
      information: true,
    });
    verifyApprovalMode(restored, {
      reading: false,
      baseline: fullApproval,
      focus: true,
    });
    assert.equal(restored.approvalRequestId, fullApproval.approvalRequestId);
    assert.equal(
      restored.approvalToggle.controls,
      fullApproval.approvalToggle.controls,
    );
    await dispatchNavigationKey(send, "Enter", "Enter", 13);
    await wait("!!document.querySelector('.approval-reading-summary')");
    await click('.composer [contenteditable="true"], .composer textarea');
    // Synthetic Host lifecycle event, NOT a keyboard action or approval response.
    const hostEvent = await evaluate(
      "window.__readingApprovalFixture.replaceRequest()",
    );
    (evidence.approvalReadingHostEvents ??= []).push({
      theme: options.theme,
      ...hostEvent,
    });
    await wait(
      `document.querySelector('.approval-request-card')?.getAttribute('data-approval-request') === ${JSON.stringify(hostEvent.newRequestId)}`,
    );
    const newer = await save("approval-new-request", {
      pending: true,
      information: true,
    });
    verifyApprovalMode(newer, { reading: false, baseline: fullApproval });
    assert.equal(hostEvent.kind, "synthetic-host-request-replacement");
    assert.equal(hostEvent.oldRequestId, fullApproval.approvalRequestId);
    assert.equal(newer.approvalRequestId, hostEvent.newRequestId);
    assert.notEqual(newer.approvalRequestId, fullApproval.approvalRequestId);
    assert(
      newer.editor.focused,
      "New request does not take focus from Composer",
    );
    assert.match(newer.approvalScopeText, /once|one.time|this call/i);
    (evidence.approvalReadingTrips ??= []).push({
      theme: options.theme,
      defaultCardHeight: fullApproval.approval.rect.height,
      summaryCardHeight: summary.approval.rect.height,
      defaultReadingHeight: fullApproval.conversationUncoveredHeight,
      summaryReadingHeight: summary.conversationUncoveredHeight,
      restoredRequestId: restored.approvalRequestId,
      newRequestId: newer.approvalRequestId,
      composerFocusRetained: newer.editor.focused,
    });
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
  "apps/zenx/scripts/scrollbar-main-ui-preview.mjs",
  "apps/zenx/test/scrollbar-main-ui-preview.test.mjs",
  "apps/zenx/scripts/prepare-preview-fonts.mjs",
  "apps/zenx/scripts/preview-font-probe.mjs",
  "apps/zenx/scripts/preview-fonts-OFL.txt",
  "apps/zenx/test/preview-fonts.test.mjs",
  ".github/workflows/desktop-reading-ui.yml",
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/src/renderer/src/scrollbar-visibility.ts",
  "apps/zenx/src/renderer/src/theme.css",
  "apps/zenx/src/renderer/src/Markdown.tsx",
  "apps/zenx/src/renderer/src/ThreadView.tsx",
  "apps/zenx/src/renderer/src/App.tsx",
  "apps/zenx/src/renderer/src/ApprovalRequestCard.tsx",
  "apps/zenx/src/renderer/src/approval-request.css",
  "apps/zenx/src/renderer/src/i18n/shell.ts",
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
