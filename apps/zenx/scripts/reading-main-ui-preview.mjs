import { captureResultFile } from "./result-file-main-ui-preview.mjs";
import {
  captureInlineTrace,
  observeInlineTrace,
} from "./inline-trace-main-ui-preview.mjs";
import { captureChildQuestions } from "./child-question-main-ui-preview.mjs";
import { captureEmptyProjects } from "./empty-project-main-ui-preview.mjs";
import { captureResultReading } from "./result-reading-main-ui-preview.mjs";
import { captureCodeWrap } from "./code-wrap-main-ui-preview.mjs";
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

/** Verify the existing full-name route; no new product tooltip or DOM mutation. */
export function verifySidebarName(state, expected, { keyboard = false } = {}) {
  assert.equal(
    state.text,
    expected,
    "The displayed detail contains the complete name",
  );
  assert(state.visible && !state.clipped, "Full name fits the visible popover");
  if (keyboard)
    assert(state.focusVisible, "Native keyboard focus remains visible");
}

export async function captureSidebarNames({
  send,
  evaluate,
  wait,
  capture,
  evidence,
  options,
}) {
  const row = '.project-group [data-thread-id="thread-1"] .thread-row';
  const title = ".thread-information-title > span";
  const project =
    '.project-group:has([data-thread-id="thread-1"]) .project-more-trigger';
  const full = await evaluate(
    `({thread:document.querySelector(${JSON.stringify(row)} + ' .thread-title > span:first-child').textContent.trim(),project:document.querySelector('.project-group .project-toggle > span').textContent.trim()})`,
  );
  const key = (name, code, value) =>
    dispatchNavigationKey(send, name, code, value);
  const tabTo = async (selector) => {
    for (let i = 0; i < 100; i++) {
      await key("Tab", "Tab", 9);
      if (
        await evaluate(
          `document.activeElement?.matches(${JSON.stringify(selector)})`,
        )
      )
        return;
    }
    throw Error(`Native Tab did not reach ${selector}`);
  };
  const record = async (step, selector, expected, keyboard = false) => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    const state = await evaluate(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)}), r=e.getBoundingClientRect();
      const focused=document.activeElement;
      return {text:e.textContent.trim(),visible:r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
        clipped:e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1,
        focusVisible:!!focused?.matches(':focus-visible'),focusedClass:focused?.className,
        rect:{x:r.x,y:r.y,width:r.width,height:r.height},
        selected:document.querySelector('.project-group .thread-row[aria-current="page"]')?.closest('[data-thread-id]')?.dataset.threadId};
    })()`);
    (evidence.sidebarNameCases ??= []).push({
      step,
      theme: options.theme,
      ...state,
    });
    verifySidebarName(state, expected, { keyboard });
    assert.equal(
      state.selected,
      "thread-1",
      "Reading a name does not select a different conversation",
    );
    await capture(`reading-${options.name}-${step}`, options, "reading");
  };
  const point = await evaluate(
    `(() => {const r=document.querySelector(${JSON.stringify(row)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await new Promise((resolve) => setTimeout(resolve, 450));
  await record("long-name-hover", title, full.thread);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 700,
    y: 200,
  });
  await tabTo(row);
  await record("long-name-keyboard", title, full.thread, true);
  await key("ArrowRight", "ArrowRight", 39);
  await record("long-name-details-focus", title, full.thread, true);
  await key("Escape", "Escape", 27);
  await wait(
    `!document.querySelector('.thread-information') && document.activeElement?.matches(${JSON.stringify(row)})`,
  );
  await tabTo(project);
  await key("Enter", "Enter", 13);
  await record(
    "long-project-keyboard",
    ".project-menu-summary > strong",
    full.project,
    true,
  );
  await key("Escape", "Escape", 27);
  await wait(
    `!document.querySelector('.project-menu') && document.activeElement?.matches(${JSON.stringify(project)})`,
  );
}

/** Observe production time elements; never inject text, focus, style or geometry. */
export function observeMessageTimes(locale) {
  const receipt = window.__messageTimesFixture?.receipt();
  const user = document.querySelector(
    '[data-sent-message-id="message-times-user"]',
  );
  const answer = document.querySelector(
    '.turn-final [data-read-message-id="message-times-answer"]',
  );
  const now = new Date();
  const clock = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const read = (owner, expected) => {
    const time = owner?.querySelector(".message-actions time");
    if (!owner || !time) return null;
    // The article includes empty alignment space. Hover its actual message body.
    const body = owner.querySelector(".user-bubble, [data-message-quote-body]");
    const view = owner.closest(".thread-view");
    const viewport = owner.closest(".messages")?.getBoundingClientRect();
    const viewRect = view?.getBoundingClientRect();
    const bottomRect = view
      ?.querySelector(":scope > .bottom-zone")
      ?.getBoundingClientRect();
    const top = Math.max(
      0,
      viewRect?.top ?? innerHeight,
      viewport?.top ?? innerHeight,
    );
    const bottom = Math.min(
      innerHeight,
      viewRect?.bottom ?? 0,
      viewport?.bottom ?? 0,
      bottomRect?.top ?? 0,
    );
    const rect = time.getBoundingClientRect(),
      row = owner.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const oldPoint = { x: row.x + row.width / 2, y: row.y + row.height / 2 };
    const point = bodyRect
      ? {
          x: bodyRect.x + bodyRect.width / 2,
          y: bodyRect.y + bodyRect.height / 2,
        }
      : null;
    const hitAt = (p) => (p ? document.elementFromPoint(p.x, p.y) : null);
    const oldHit = hitAt(oldPoint),
      hit = hitAt(point);
    const identity = (e) =>
      e ? { tag: e.tagName, className: e.className } : null;
    const actions = time.closest(".message-actions"),
      style = getComputedStyle(actions);
    return {
      dateTime: time.getAttribute("datetime"),
      text: time.textContent.trim(),
      expectedClock: clock.format(new Date(expected)),
      hovered: owner.matches(":hover"),
      focused: owner.contains(document.activeElement),
      opacity: Number(style.opacity),
      visibility: style.visibility,
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        rect.top >= top &&
        rect.bottom <= bottom,
      hit: !!body && body.contains(hit),
      point,
      targetVisible:
        !!bodyRect &&
        bodyRect.width > 0 &&
        bodyRect.height > 0 &&
        bodyRect.left >= 0 &&
        bodyRect.right <= innerWidth &&
        bodyRect.top >= top &&
        bodyRect.bottom <= bottom,
      boundaries: {
        top,
        bottom,
        viewTop: viewRect?.top,
        viewportTop: viewport?.top,
        viewportBottom: viewport?.bottom,
        composerTop: bottomRect?.top,
      },
      oldPoint,
      oldHit: owner.contains(oldHit),
      oldHitTarget: identity(oldHit),
      hitTarget: identity(hit),
      clockHit: owner.contains(
        document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ),
      ),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
  return {
    receipt,
    capturedAt: now.toISOString(),
    locale,
    timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    selectedThread: document
      .querySelector('.project-group .thread-row[aria-current="page"]')
      ?.closest("[data-thread-id]")?.dataset.threadId,
    sameTurn: !!user && user.closest(".turn") === answer?.closest(".turn"),
    userCount: document.querySelectorAll(
      '[data-sent-message-id="message-times-user"]',
    ).length,
    answerCount: document.querySelectorAll(
      '.turn-final [data-read-message-id="message-times-answer"]',
    ).length,
    user: receipt ? read(user, receipt.sent) : null,
    answer: receipt ? read(answer, receipt.completed) : null,
  };
}

export function verifyMessageTimes(s, hovered) {
  assert.equal(s.selectedThread, "thread-1");
  assert.equal(s.receipt?.threadId, "thread-1");
  assert.equal(s.sameTurn, true);
  assert.equal(s.userCount, 1);
  assert.equal(s.answerCount, 1);
  assert.equal(s.receipt.sent, "2026-10-15T09:00:00.000Z");
  assert.equal(s.receipt.started, "2026-10-15T09:01:00.000Z");
  assert.equal(s.receipt.completed, "2026-10-15T09:05:00.000Z");
  assert(Number.isFinite(Date.parse(s.receipt.received)));
  assert.equal(
    new Set([
      s.receipt.sent,
      s.receipt.started,
      s.receipt.completed,
      s.receipt.received,
    ]).size,
    4,
  );
  for (const [name, expected] of [
    ["user", s.receipt.sent],
    ["answer", s.receipt.completed],
  ]) {
    const row = s[name];
    assert(
      row?.visible && row.targetVisible && row.hit,
      "Both actual message timestamps fit the reading band",
    );
    assert.equal(row.dateTime, expected);
    assert(
      row.text.endsWith(row.expectedClock),
      "Visible local clock matches the canonical time",
    );
    assert.equal(
      row.hovered,
      name === hovered,
      "Only the intended message owns native hover",
    );
    assert.equal(
      row.focused,
      false,
      "No stale message focus may substitute for hover",
    );
    if (name === hovered) {
      assert.equal(row.clockHit, true, "Revealed timestamp is not covered");
      assert.equal(row.opacity, 1);
      assert.equal(row.visibility, "visible");
    }
  }
}

// LegendList mounts rows before its initial-layout/scroll readiness removes
// pointer suppression. DOM presence alone is not an actionable hover target.
export function messageTimesReady(s) {
  return (
    s.sameTurn &&
    ["user", "answer"].every(
      (name) => s[name]?.visible && s[name].targetVisible && s[name].hit,
    )
  );
}

export async function captureMessageTimes({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
  url,
}) {
  const target = new URL(url);
  target.searchParams.set("messageTimes", "1");
  await send("Page.navigate", { url: target.href });
  await wait(
    `location.href === ${JSON.stringify(target.href)} && !!document.querySelector('.thread-row')`,
  );
  await click('.project-group [data-thread-id="thread-1"] .thread-row');
  await wait(
    "!!document.querySelector('.turn-final [data-read-message-id=\"message-times-answer\"] .message-time')",
  );
  const observe = () =>
    evaluate(
      `(${observeMessageTimes.toString()})(${JSON.stringify(options.lang)})`,
    );
  for (const owner of ["user", "answer"]) {
    const initial = await observe();
    (evidence.messageTimeAttempts ??= []).push({
      theme: options.theme,
      owner,
      phase: "before",
      state: initial,
    });
    try {
      await wait(
        `(${messageTimesReady.toString()})((${observeMessageTimes.toString()})(${JSON.stringify(options.lang)}))`,
      );
      const before = await observe();
      (evidence.messageTimeAttempts ??= []).push({
        theme: options.theme,
        owner,
        phase: "ready",
        state: before,
      });
      assert(
        before[owner]?.visible &&
          before[owner].targetVisible &&
          before[owner].hit,
        "Native hover target is on screen",
      );
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...before[owner].point,
      });
      await wait(
        `(() => { const s = (${observeMessageTimes.toString()})(${JSON.stringify(options.lang)}); return s.${owner}?.hovered && s.${owner}.opacity === 1; })()`,
      );
      const state = await observe();
      (evidence.messageTimeAttempts ??= []).push({
        theme: options.theme,
        owner,
        phase: "after",
        state,
      });
      verifyMessageTimes(state, owner);
      (evidence.messageTimeCases ??= []).push({
        theme: options.theme,
        hovered: owner,
        ...state,
      });
      await capture(
        `reading-${options.name}-message-time-${owner}-hover`,
        options,
        "reading",
      );
    } catch (error) {
      (evidence.messageTimeAttempts ??= []).push({
        theme: options.theme,
        owner,
        phase: "failed",
        state: await observe().catch(() => null),
        error: String(error),
      });
      throw error;
    }
  }
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
  if (new URL(url).searchParams.get("resultFile") === "1")
    return captureResultFile({
      send,
      evaluate,
      wait,
      click,
      capture,
      evidence,
      options,
      url,
    });
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
        "Array.from(document.querySelectorAll('.information-widget')).filter(e => !e.hidden && e.getBoundingClientRect().height > 0).length >= 2",
      );
      const scene = await save(`supporting-rails-${rails}`, {
        information: true,
      });
      if (rails === "long") {
        const dark = options.theme === "dark";
        assert.equal(
          scene.sidebar.background,
          dark ? "rgb(0, 0, 0)" : "rgb(249, 250, 251)",
          "Desktop capture actually renders the default Graphite sidebar",
        );
        assert.equal(
          scene.thread.background,
          dark ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
          "Desktop capture actually renders the default Graphite conversation canvas",
        );
      }
      const headers = await evaluate(`(() => {
        const panel = document.querySelector(".information-dock .editable-information-panel");
        const toolbar = panel?.querySelector(":scope > .information-settings-toolbar");
        if (!toolbar) return null;
        const hit = (element) => {
          const r = element.getBoundingClientRect();
          return r.width > 0 && r.height > 0 &&
            element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        };
        const customize = toolbar.querySelector(".information-customize");
        return {
          toolbarPosition: getComputedStyle(toolbar).position,
          toolbarLeft: toolbar.getBoundingClientRect().left,
          customizeHit: !!customize && hit(customize),
          widgets: [...panel.querySelectorAll(
            ":scope > .information-widget-list > .information-widget:not([hidden]) > header"
          )].map(header => {
            const controls = [...header.querySelectorAll("button")];
            return {
              right: header.getBoundingClientRect().right,
              paddingRight: parseFloat(getComputedStyle(header).paddingRight),
              controlRight: Math.max(...controls.map(e => e.getBoundingClientRect().right)),
              controlsHit: controls.length > 0 && controls.every(hit),
            };
          }),
        };
      })()`);
      assert(headers?.customizeHit, "Customize stays hittable");
      assert.equal(headers.toolbarPosition, "absolute");
      assert(
        headers.widgets.length >= 2,
        "First and later widgets are rendered",
      );
      for (const [index, header] of headers.widgets.entries()) {
        const padding = index === 0 ? 30 : 0;
        assert.equal(header.paddingRight, padding);
        assert(header.controlsHit, "Visible widget controls stay hittable");
        assert(header.controlRight <= header.right - padding + 1);
        if (index === 0) {
          assert(header.controlRight <= headers.toolbarLeft + 1);
        }
      }
      (evidence.dockHeaderCases ??= []).push({
        theme: options.theme,
        rails,
        ...headers,
      });
      if (rails === "long")
        await captureSidebarNames({
          send,
          evaluate,
          wait,
          capture,
          evidence,
          options,
        });
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
    await captureChildQuestions({
      send,
      evaluate,
      wait,
      click,
      capture,
      evidence,
      options,
      url,
    });
    await captureEmptyProjects({
      send,
      evaluate,
      wait,
      click,
      capture,
      evidence,
      options,
      url,
    });
    await captureResultReading({
      send,
      evaluate,
      wait,
      click,
      capture,
      evidence,
      options,
      url,
      scroll,
    });
    await captureInlineTrace({
      send,
      evaluate,
      wait,
      capture,
      evidence,
      options,
      url,
    });
    await captureCodeWrap({
      send,
      evaluate,
      wait,
      click,
      capture,
      evidence,
      options,
      url,
      scrollToTop: () => scroll(),
    });
    await captureMessageTimes({
      send,
      evaluate,
      wait,
      click,
      capture,
      evidence,
      options,
      url,
    });
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
  "apps/zenx/test/conversation-reading-position.test.mjs",
  "apps/zenx/src/renderer/src/conversation-reading-position.css",
  "apps/zenx/scripts/inline-trace-main-ui-preview.mjs",
  "apps/zenx/src/renderer/src/subagents-ui.tsx",
  "apps/zenx/src/renderer/src/subagents.css",
  "apps/zenx/test/subagents-ui.test.ts",
  "apps/zenx/scripts/child-question-main-ui-preview.mjs",
  "apps/zenx/scripts/child-question-main-ui-preview.d.mts",
  "apps/zenx/test/fixtures/child-question-data.ts",
  "apps/zenx/test/child-question-main-ui-preview.test.ts",
  "apps/zenx/scripts/empty-project-main-ui-preview.mjs",
  "apps/zenx/test/empty-project-main-ui-preview.test.mjs",
  "apps/zenx/scripts/result-reading-main-ui-preview.mjs",
  "apps/zenx/test/result-reading-main-ui-preview.test.mjs",
  "apps/zenx/test/fixtures/result-reading-content.ts",
  "apps/zenx/scripts/code-wrap-main-ui-preview.mjs",
  "apps/zenx/test/code-wrap-main-ui-preview.test.mjs",
  "apps/zenx/test/fixtures/code-wrap-content.ts",
  "apps/zenx/src/renderer/src/Sidebar.tsx",
  "apps/zenx/test/sidebar-information-interaction.test.ts",
  "apps/zenx/test/sidebar-name-preview.test.mjs",
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
/** A fixed synthetic stream, resumed through real standard-desktop UI; no parked-stream duplicate. */
export function verifyReadingReentry(state, previous, phase) {
  assert.equal(state.receipt.phase, Math.min(phase, 2));
  assert.equal(state.receipt.completed, phase === 3);
  assert.equal(state.receipt.watermark, phase === 3 ? 6 : phase + 2);
  for (const key of ["itemId", "turnId", "threadId"])
    assert.equal(state.receipt[key], previous.receipt[key]);
  assert.equal(state.primary, phase === 3 ? "send" : "stop");
  assert.equal(
    state.cuePresent,
    false,
    "Live mode has no active conversation return cue, even if it would be hidden",
  );
  assert(
    Math.abs(state.maxTop - state.top) <= 1,
    "Actual transcript is at its live end within rounding",
  );
  assert(
    state.primaryHit && state.editorPresent,
    "Actual primary action and Composer editor remain available",
  );
  assert(
    !state.cue && state.tail.visible && state.tail.hit,
    "Live terminal prose paints inside the actual reading band",
  );
  assert.equal(state.itemCount, 1);
  assert.deepEqual(
    state.paragraphs,
    state.receipt.text
      .split("\n\n")
      .filter(Boolean)
      .map((p) => p.replace(/^## /, "")),
    "Exact fixed synthetic prose renders completely and in order",
  );
  if (phase < 3)
    assert(
      state.height - previous.height > state.band,
      "Same-item growth exceeds one available reading band",
    );
  for (const key of ["page", "left", "output", "draft", "composer"])
    assert.deepEqual(
      state[key],
      previous[key],
      `${key} is unchanged during stream growth`,
    );
  assert.equal(state.telemetry.informationUpdates, 0);
  assert(
    !state.telemetry.protocolCalls.some((m) =>
      /send|interrupt|respond|retry/.test(m),
    ),
    "No real task or approval is requested",
  );
}

/** The held-reading control belongs above the dock, not inside the editor. */
export function verifyReadingCue(state, previous) {
  const placement = state.cuePlacement;
  assert(
    state.cuePresent && state.cue && placement,
    "Return cue is painted and hit-testable",
  );
  assert.equal(placement.count, 1, "One desktop return control");
  assert(
    placement.outsideComposer && placement.outsideBottomZone,
    "Return control is separate from the Composer and its dock",
  );
  assert.deepEqual(
    state.composer,
    previous.composer,
    "Holding history does not resize or move Composer",
  );
  const [x, , width] = state.composer;
  const rect = placement.rect;
  assert(
    [
      x,
      width,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      rect.bottom,
      placement.bottomZoneTop,
    ].every(Number.isFinite) &&
      rect.width > 0 &&
      rect.height > 0,
    "Control and dock have actual measured geometry",
  );
  assert(
    Math.abs(rect.x + rect.width / 2 - (x + width / 2)) <= 2,
    "Return control is centered over Composer",
  );
  assert(
    rect.bottom <= placement.bottomZoneTop - 4,
    "Return control clears the entire dock rather than overlaying it",
  );
}

export async function captureReadingReentry({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
}) {
  const trip = {
    status: "running",
    startedAt: Date.now(),
    scope: "standard desktop light, explicit conversation return control only",
    phases: [],
  };
  evidence.readingReentry = trip;
  const sample = () =>
    evaluate(
      `(${observeInlineTrace.toString()})(true,window.__readingStream.receipt())`,
    );
  const signature = (s) =>
    JSON.stringify([
      s.top,
      s.height,
      s.tail,
      s.composer,
      s.cue,
      s.cuePresent,
      s.cuePlacement,
      s.maxTop,
      s.primary,
      s.paragraphs,
    ]);
  const settle = async (predicate) => {
    let previous;
    for (let n = 0; n < 24; n++) {
      await evaluate(
        "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
      );
      const state = await sample();
      if (
        predicate(state) &&
        previous &&
        signature(state) === signature(previous)
      )
        return state;
      previous = state;
    }
    throw Error("Re-entry geometry did not settle within bounded observations");
  };
  try {
    assert.equal(options.width, 1280);
    assert.equal(options.height, 900);
    assert.equal(options.theme, "light");
    await click('.project-group [data-thread-id="thread-1"] .thread-row');
    await wait(
      "!!window.__readingStream && !!document.querySelector('.composer .composer-send-control button.action-orb.stop') && !!document.querySelector('.agent-copy h1')",
    );
    let state = await settle(
      (s) =>
        s.primary === "stop" &&
        s.tail.visible &&
        s.tail.hit &&
        s.cuePresent === false &&
        Math.abs(s.maxTop - s.top) <= 1 &&
        s.top > 480,
    );
    trip.initial = state;
    assert(
      state.wheel,
      "Native upward wheel belongs to the actual transcript, not nested output",
    );
    trip.wheel = { ...state.wheel, deltaY: -360 };
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...trip.wheel,
      deltaX: 0,
    });
    const parked = await settle(
      (s) => s.top < state.top && s.top > 120 && s.cuePresent && s.cue,
    );
    for (const key of ["page", "left", "output", "draft", "composer"])
      assert.deepEqual(parked[key], state[key]);
    trip.afterWheel = parked;
    verifyReadingCue(parked, state);
    await capture("reading-reentry-parked-cue", options, "reading");
    assert.equal(
      signature(await sample()),
      signature(parked),
      "Visible cue and native parked geometry are unchanged around the screenshot",
    );
    trip.parkedScreenshot = {
      file: "reading-reentry-parked-cue.png",
      scope:
        "Precondition only: native wheel exposed the real conversation return control; no growth yet",
    };
    await click(".conversation-reading-position button");
    state = await settle(
      (s) =>
        s.cuePresent === false &&
        Math.abs(s.maxTop - s.top) <= 1 &&
        s.tail.visible &&
        s.tail.hit &&
        s.top > parked.top,
    );
    trip.resumed = state;
    for (const phase of [1, 2, 3]) {
      const previous = state;
      await evaluate(
        phase === 3
          ? "window.__readingStream.finalize()"
          : "window.__readingStream.advance()",
      );
      state = await settle(
        (s) =>
          s.receipt.phase === Math.min(phase, 2) &&
          s.receipt.completed === (phase === 3) &&
          s.primary === (phase === 3 ? "send" : "stop") &&
          s.cuePresent === false &&
          Math.abs(s.maxTop - s.top) <= 1 &&
          s.tail.visible &&
          s.tail.hit,
      );
      verifyReadingReentry(state, previous, phase);
      trip.phases.push(state);
    }
    await capture("reading-reentry-terminal", options, "reading");
    assert.equal(
      signature(await sample()),
      signature(state),
      "Terminal Range and offset remain stable around the actual screenshot",
    );
    trip.status = "passed";
  } catch (error) {
    trip.status = "failed";
    trip.error = String(error);
    throw error;
  } finally {
    trip.durationMs = Date.now() - trip.startedAt;
  }
}
