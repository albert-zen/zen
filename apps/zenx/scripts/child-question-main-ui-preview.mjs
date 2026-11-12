import { projectElementVisible } from "./empty-project-main-ui-preview.mjs";
import assert from "node:assert/strict";
import { dispatchNavigationKey } from "./navigation-main-ui-preview.mjs";

export function observeChildQuestions(visible = projectElementVisible) {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      visible: visible(el),
      viewportIntersection: {
        width: Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.x, 0)),
        height: Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.y, 0)),
      },
      bottom: r.bottom,
      right: r.right,
    };
  };
  // These are geometric/hit-test observations, not pixel-legibility proof.
  const overlay = (shell) => {
    const badge = shell.querySelector(".thread-asking-badge");
    const rail = shell.querySelector(".thread-status-rail");
    const menu = shell.querySelector(".thread-menu-trigger");
    const overlap = (a, b) =>
      a && b
        ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y))
        : 0;
    const b = rect(badge),
      r = rect(rail),
      m = rect(menu);
    let textRects = [];
    if (badge) {
      const range = document.createRange();
      range.selectNodeContents(badge);
      textRects = [...range.getClientRects()].map((box) => ({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      }));
    }
    const hit = (x, y) =>
      document
        .elementsFromPoint(x, y)
        .slice(0, 6)
        .map((el) => ({
          tag: el.tagName,
          className: el.className,
          menuTarget: el === menu || !!menu?.contains(el),
          rowTarget: !!el.closest?.(".thread-row"),
        }));
    return {
      interpretation:
        "Geometry and pointer hit-testing only; inspect screenshots for text legibility",
      badge: b,
      rail: r,
      menu: m,
      textRects,
      railBackground: rail ? getComputedStyle(rail).backgroundImage : null,
      badgeOpacity: badge ? getComputedStyle(badge).opacity : null,
      badgeRailOverlapArea: overlap(b, r),
      badgeMenuOverlapArea: overlap(b, m),
      textMenuOverlapArea: textRects.reduce(
        (sum, box) => sum + overlap(box, m),
        0,
      ),
      slots: [...shell.querySelectorAll(".thread-status-slot")].map((el) => ({
        rect: rect(el),
        badgeOverlapArea: overlap(b, rect(el)),
      })),
      samples: b
        ? [0.1, 0.5, 0.9].map((fraction) => ({
            x: b.x + b.width * fraction,
            y: b.y + b.height / 2,
            stack: hit(b.x + b.width * fraction, b.y + b.height / 2),
          }))
        : [],
      menuCenterHit: m?.width ? hit(m.x + m.width / 2, m.y + m.height / 2) : [],
      hovered: shell.matches(":hover"),
      focusWithin: shell.matches(":focus-within"),
    };
  };
  const dock = document.querySelector(".information-dock");
  const sidebar = [
    ...document.querySelectorAll(".project-group [data-thread-id]"),
  ]
    .filter((el) => el.dataset.threadId.startsWith("question-"))
    .map((el) => ({
      id: el.dataset.threadId,
      text: el.textContent,
      badge: el.querySelector(".thread-asking-badge")?.textContent ?? null,
      badgeLabel:
        el.querySelector(".thread-asking-badge")?.getAttribute("aria-label") ??
        null,
      rect: rect(el),
      overlay: overlay(el),
    }));
  const namesById = {
    "question-idle": "Design review · 等待方案确认",
    "question-active": "Implementation · 跨项目组件一致性检查",
    "question-clear": "Test coverage",
    "question-error": "Unavailable review",
  };
  const rows = [
    ...(dock?.querySelectorAll("button.subagent-tree-row") ?? []),
  ].map((el) => ({
    id:
      Object.keys(namesById).find(
        (id) =>
          namesById[id] ===
          el.querySelector(".subagent-tree-title")?.textContent,
      ) ?? null,
    title: el.querySelector(".subagent-tree-title")?.textContent,
    text: el.textContent,
    status: el.querySelector(".subagent-tree-status")?.textContent ?? null,
    badge: el.querySelector(".thread-asking-badge")?.textContent ?? null,
    badgeLabel:
      el.querySelector(".thread-asking-badge")?.getAttribute("aria-label") ??
      null,
    rect: rect(el),
  }));
  return {
    sidebar,
    rows,
    dock: rect(dock),
    composer: rect(document.querySelector(".composer")),
    focusThreadId:
      document.activeElement?.closest("[data-thread-id]")?.dataset.threadId,
    focusClass: document.activeElement?.className,
    focusText: document.activeElement?.textContent,
    focusVisible: document.activeElement?.matches(":focus-visible"),
    overflow: document.documentElement.scrollWidth - innerWidth,
    previewCount: document.querySelectorAll(".thread-information").length,
    selectedThreadIds: [
      ...document.querySelectorAll(".project-group .thread-row.selected"),
    ].map((el) => el.closest("[data-thread-id]")?.dataset.threadId),
    transcriptScrollTop: document.querySelector(".messages")?.scrollTop ?? null,
  };
}

export function verifyChildQuestions(state, cleared = false) {
  assert.equal(state.sidebar.length, 4);
  assert.equal(state.rows.length, 4);
  const names = [
    "Design review · 等待方案确认",
    "Implementation · 跨项目组件一致性检查",
    "Test coverage",
    "Unavailable review",
  ];
  for (const name of names)
    assert(state.rows.some((row) => row.title === name));
  assert(state.dock?.width > 0 && state.dock.bottom <= 900);
  assert(state.composer?.width > 0);
  assert.equal(state.overflow, 0);
  for (const row of [...state.sidebar, ...state.rows])
    assert(
      row.rect.width > 0 &&
        row.rect.height > 0 &&
        row.rect.visible &&
        row.rect.viewportIntersection.width === row.rect.width &&
        row.rect.viewportIntersection.height === row.rect.height,
    );
  assert.deepEqual(
    state.rows.map((row) => row.id).sort(),
    state.sidebar.map((row) => row.id).sort(),
  );
  const badge = (id) => state.sidebar.find((r) => r.id === id).badge;
  assert.equal(!!badge("question-idle"), !cleared);
  assert.equal(!!badge("question-active"), !cleared);
  assert.equal(badge("question-clear"), null);
  assert.equal(badge("question-error"), null);
  // Baseline may omit dock attention; record it, never require candidate rendering here.
  assert(state.rows.every((row) => row.status));
}

export async function captureChildQuestions({
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
  for (const key of [
    "rails",
    "codeWrap",
    "results",
    "tableKeyboard",
    "emptyProjects",
    "pending",
  ])
    target.searchParams.delete(key);
  target.searchParams.set("childQuestions", "1");
  target.searchParams.set("lang", options.theme === "dark" ? "zh" : "en");
  await send("Page.navigate", { url: target.href });
  await wait(
    `location.href===${JSON.stringify(target.href)} && document.querySelectorAll('.project-group [data-thread-id^="question-"]').length===4`,
  );
  await click('.project-group [data-thread-id="thread-1"] .thread-row');
  await wait("!!document.querySelector('.composer')");
  if (
    !(await evaluate(
      "document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded')==='true'",
    ))
  )
    await click(".information-toolbar button");
  await wait(
    "document.querySelectorAll('.information-dock button.subagent-tree-row').length===4",
  );
  const focusSelector =
    '.project-group [data-thread-id="question-idle"] .thread-row';
  let reached = false;
  for (let i = 0; i < 100; i++) {
    await dispatchNavigationKey(send, "Tab", "Tab", 9);
    if (
      await evaluate(
        `document.activeElement?.matches(${JSON.stringify(focusSelector)})`,
      )
    ) {
      reached = true;
      break;
    }
  }
  assert(reached, "Native Tab must reach child navigation without opening it");
  const observe = () =>
    evaluate(
      `(${observeChildQuestions.toString()})(${projectElementVisible.toString()})`,
    );
  const before = await observe();
  verifyChildQuestions(before);
  (evidence.childQuestionCases ??= []).push({
    theme: options.theme,
    step: "pending",
    ...before,
  });
  await capture(
    `reading-${options.name}-child-questions-pending`,
    options,
    "reading",
  );
  // Keep the established pending/cleared captures and assertions unchanged.
  // Native navigation reveals whether the detail preview can be dismissed.
  const probeRecord = async (step) => {
    const state = await observe();
    (evidence.childQuestionOverlayCases ??= []).push({
      theme: options.theme,
      step,
      ...state,
    });
    return state;
  };
  const settle = async (milliseconds) =>
    evaluate(`new Promise(resolve => setTimeout(resolve, ${milliseconds}))`);
  const tabToChild = async () => {
    for (let i = 0; i < 100; i++) {
      if (
        await evaluate(
          `document.activeElement?.matches(${JSON.stringify(focusSelector)})`,
        )
      )
        return;
      await dispatchNavigationKey(send, "Tab", "Tab", 9);
    }
    throw new Error("Native Tab did not restore the child navigation focus");
  };
  const tabOutsideRows = async () => {
    for (let i = 0; i < 100; i++) {
      await dispatchNavigationKey(send, "Tab", "Tab", 9);
      if (
        await evaluate(
          "document.activeElement !== document.body && !document.activeElement?.closest('.thread-row-shell, .thread-information')",
        )
      ) {
        await settle(220);
        return;
      }
    }
    throw new Error("Native Tab did not reach a control outside row previews");
  };
  const hoverChild = async () => {
    const point = await evaluate(
      `(() => { const r=document.querySelector(${JSON.stringify(focusSelector)}).getBoundingClientRect(); return {x:r.x+8,y:r.y+r.height/2}; })()`,
    );
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await settle(400);
  };
  await probeRecord("dock-open-tab");
  await dispatchNavigationKey(send, "Escape", "Escape", 27);
  await settle(200);
  await probeRecord("dock-open-escape");
  await capture(
    `reading-${options.name}-child-questions-overlay-escape`,
    options,
    "reading",
  );
  // Moving away then back exercises pointer entry, even if the earlier click
  // left the cursor over this row. Do not dispatch click/Enter on a child.
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 12 });
  await tabOutsideRows();
  await hoverChild();
  await probeRecord("dock-open-hover");
  await click(".information-toolbar button");
  await wait("!document.querySelector('.information-dock')");
  // The real toolbar click owns focus; do not Tab into the child for this hover case.
  await hoverChild();
  await probeRecord("dock-closed-hover");
  await capture(
    `reading-${options.name}-child-questions-overlay-dock-closed`,
    options,
    "reading",
  );
  await click(".information-toolbar button");
  await wait(
    "document.querySelectorAll('.information-dock button.subagent-tree-row').length===4",
  );
  await tabToChild();
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 12 });
  await settle(200);
  const restored = await probeRecord("dock-restored-tab");
  verifyChildQuestions(restored);
  assert.deepEqual(restored.selectedThreadIds, before.selectedThreadIds);
  assert.equal(restored.focusThreadId, before.focusThreadId);
  assert.equal(restored.dock.width, before.dock.width);
  assert.equal(restored.composer.width, before.composer.width);
  const receipt = await evaluate("window.__childQuestionFixture.clear()");
  await wait(
    "![...document.querySelectorAll('.project-group [data-thread-id^=\"question-\"] .thread-asking-badge')].length",
  );
  await wait(
    "[...document.querySelectorAll('.information-dock .thread-asking-badge')].length===0",
  );
  const after = await observe();
  verifyChildQuestions(after, true);
  assert.deepEqual(
    after.sidebar.map((row) => row.id).sort(),
    before.sidebar.map((row) => row.id).sort(),
  );
  assert.equal(after.focusThreadId, before.focusThreadId);
  assert.equal(after.focusThreadId, "question-idle");
  assert.equal(after.focusClass, before.focusClass);
  assert(after.focusVisible);
  (evidence.childQuestionCases ??= []).push({
    theme: options.theme,
    step: "cleared",
    receipt,
    ...after,
  });
  await capture(
    `reading-${options.name}-child-questions-cleared`,
    options,
    "reading",
  );
}
