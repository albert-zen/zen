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
