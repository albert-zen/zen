import assert from "node:assert/strict";

export const navigationSelectors = {
  project: '.project-group [data-thread-id="thread-1"] .thread-row',
  recent: '.recent-thread-group [data-thread-id="thread-1"] .thread-row',
  projects: ".projects-section-toggle",
  entry: ".information-toolbar button",
  close: '.information-toolbar button[aria-expanded="true"]',
  editor: '.composer [contenteditable="true"], .composer textarea',
};
export const navigationDraft =
  "Keep this synthetic draft while checking navigation.";

/** Enter needs Chromium's character-producing path for native button activation.
 * Keep Escape/other nonprinting keys raw; never substitute a DOM click. */
export async function dispatchNavigationKey(
  send,
  key,
  code,
  windowsVirtualKeyCode,
) {
  await send("Input.dispatchKeyEvent", {
    type: key === "Enter" ? "keyDown" : "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode,
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode,
  });
}

/** Read-only browser observation; tests exercise its shape, not simulated layout. */
export function observeNavigation() {
  const read = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      rect: {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
      fullyVisible:
        r.width > 0 &&
        r.height > 0 &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight,
      centerHit: element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      ),
      focused: document.activeElement === element,
      focusVisible: element.matches(":focus-visible"),
      hovered: element.matches(":hover"),
      current: element.getAttribute("aria-current"),
      expanded: element.getAttribute("aria-expanded"),
      controls: element.getAttribute("aria-controls"),
      background: style.backgroundColor,
      region: style.webkitAppRegion,
      outline: {
        style: style.outlineStyle,
        width: style.outlineWidth,
        color: style.outlineColor,
      },
    };
  };
  const editor = document.querySelector(
    '.composer [contenteditable="true"], .composer textarea',
  );
  return {
    entry: read(".information-toolbar button"),
    close: read('.information-toolbar button[aria-expanded="true"]'),
    titlebar: read(".window-titlebar-session"),
    dock: read(".information-dock"),
    popover: read(".information-popover"),
    chat: read(".agent-surface"),
    composer: read(".composer"),
    projects: read(".projects-section-toggle"),
    project: read('.project-group [data-thread-id="thread-1"] .thread-row'),
    recent: read(
      '.recent-thread-group [data-thread-id="thread-1"] .thread-row',
    ),
    draft: editor
      ? "value" in editor
        ? editor.value
        : editor.textContent
      : null,
    informationTitleCount: document.querySelectorAll(".subagent-tree-title")
      .length,
    questionReadErrors: [
      ...document.querySelectorAll(".user-question-read-error"),
    ].map((element) => element.textContent),
    telemetry: window.__uiPolishTelemetry,
  };
}

export function assertNavigationState(state, { mode, focus, baseline } = {}) {
  const s = navigationSelectors;
  assert.equal(
    state.draft,
    navigationDraft,
    "Navigation preserves the unsent draft",
  );
  assert.deepEqual(
    state.questionReadErrors,
    [],
    "Read-only question fixture loads without a visible error",
  );
  assert.equal(
    state.telemetry.informationUpdates,
    0,
    "No information edit was requested",
  );
  assert(
    !state.telemetry.protocolCalls.includes("zen/turn/send"),
    "No synthetic Send was requested",
  );
  assert.equal(
    state.recent?.current,
    "page",
    "Recent retains the same current thread",
  );
  if (focus) {
    const target = state[focus];
    assert(
      target?.focused && target.focusVisible,
      `${s[focus] ?? focus} has real keyboard focus`,
    );
    assert(
      target.fullyVisible && target.centerHit,
      "Focused control is visible and unobscured",
    );
    assert(
      target.outline.style !== "none" && parseFloat(target.outline.width) > 0,
      "Focused control has a visible outline",
    );
  }
  if (mode === "information-open") {
    assert(
      state.dock && !state.popover,
      "Normal desktop titlebar opens the dock, not a forced fixture overlay",
    );
    assert.equal(state.entry.expanded, "true");
    assert(
      state.titlebar?.rect.width > 0,
      "Production conversation title row is present",
    );
    // A measured entry may legally extend below a short title row. Record both
    // rectangles, but require safe hit testing rather than containment.
    assert.equal(
      state.entry.region,
      "no-drag",
      "Information entry is not a window drag target",
    );
    assert(
      state.entry.fullyVisible && state.entry.centerHit,
      "Entry remains reachable",
    );
    assert(
      state.close?.fullyVisible && state.close.centerHit,
      "Close remains reachable",
    );
    assert(
      state.close.rect.x === state.entry.rect.x &&
        state.close.rect.y === state.entry.rect.y,
      "Information closes through the same titlebar toggle",
    );
    assert(
      state.chat.rect.right <= state.dock.rect.x + 1,
      "Information does not cover the conversation",
    );
    assert(state.composer?.fullyVisible, "Composer remains in the viewport");
    assert(
      state.informationTitleCount >= 2,
      "Real lineage cards loaded from the synthetic Host",
    );
    assert(
      state.telemetry.informationReads.length > 0,
      "Production panel read its owner",
    );
  } else if (mode === "information-closed") {
    assert(!state.dock && !state.popover, "Information really closed");
    assert.equal(state.entry.expanded, "false");
    assert(
      state.entry.focused,
      "Closing returns focus to the actual titlebar entry",
    );
  } else if (mode === "projects-collapsed") {
    assert.equal(state.projects.expanded, "false");
    assert.equal(state.project, null, "Project copy is unmounted, not covered");
    assert(
      state.recent.fullyVisible && state.recent.centerHit,
      "Recent fallback remains reachable",
    );
    assert.equal(
      state.recent.background,
      baseline.project.background,
      "Recent acquires the primary current fill",
    );
  } else if (mode === "projects-expanded") {
    assert.equal(state.projects.expanded, "true");
    assert.equal(state.project?.current, "page");
    assert(
      state.project.fullyVisible && state.recent.fullyVisible,
      "Both navigation locations are visible",
    );
    assert(
      !state.project.hovered && !state.recent.hovered,
      "Compare current fills with pointer moved away",
    );
    assert.notEqual(
      state.project.background,
      state.recent.background,
      "Recent alias does not duplicate the primary fill",
    );
    if (baseline) {
      assert.equal(state.project.background, baseline.project.background);
      assert.equal(state.recent.background, baseline.recent.background);
    }
  }
}

/** Uses only CDP native input. No DOM focus(), synthetic click(), or fixture state setters. */
export async function captureDesktopNavigation({
  send,
  evaluate,
  wait,
  click,
  tabTo,
  capture,
  evidence,
  options,
}) {
  const s = navigationSelectors;
  const key = async (key, code, windowsVirtualKeyCode) => {
    const attempt = {
      key,
      code,
      windowsVirtualKeyCode,
      before: await evaluate(`(${observeNavigation.toString()})()`),
    };
    (evidence.navigationKeyAttempts ??= []).push(attempt);
    await dispatchNavigationKey(send, key, code, windowsVirtualKeyCode);
    await evaluate(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
    );
    attempt.after = await evaluate(`(${observeNavigation.toString()})()`);
  };
  const away = () =>
    send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 220 });
  const record = async (step, expectation) => {
    await away();
    // Let production transitions settle before measuring and taking the paired pixels.
    await evaluate(
      "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = await evaluate(`(${observeNavigation.toString()})()`);
    (evidence.navigationCases ??= []).push({
      step,
      theme: options.theme,
      ...state,
    });
    await capture(`navigation-${options.name}-${step}`, options, "navigation");
    assertNavigationState(state, expectation);
    return state;
  };
  await wait(`!!document.querySelector(${JSON.stringify(s.project)})`);
  await click(s.project);
  await wait(
    `!!document.querySelector(${JSON.stringify(s.entry)}) && !!document.querySelector(${JSON.stringify(s.editor)})`,
  );
  await click(s.editor);
  await send("Input.insertText", { text: navigationDraft });
  const baseline = await record("projects-current", {
    mode: "projects-expanded",
  });
  await click(s.entry);
  await wait(
    "!!document.querySelector('.information-dock .subagent-tree-title') && document.querySelectorAll('.subagent-tree-title').length >= 2",
  );
  await record("titlebar-information-open", { mode: "information-open" });
  assert(
    await tabTo(`${s.close}:focus-visible`),
    "Native Tab reaches Information close",
  );
  await record("information-close-focus", {
    mode: "information-open",
    focus: "close",
  });
  await key("Escape", "Escape", 27);
  await wait("!document.querySelector('.information-dock')");
  await record("escape-return-focus", {
    mode: "information-closed",
    focus: "entry",
  });
  await key("Enter", "Enter", 13);
  await wait(
    "!!document.querySelector('.information-dock') && document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded') === 'true'",
  );
  await click(s.close);
  await wait("!document.querySelector('.information-dock')");
  await record("close-return-focus", { mode: "information-closed" });
  assert(
    await tabTo(`${s.projects}:focus-visible`),
    "Native Tab reaches Projects disclosure",
  );
  await key("Enter", "Enter", 13);
  await wait(
    "document.querySelector('.projects-section-toggle').getAttribute('aria-expanded') === 'false'",
  );
  await record("recent-fallback", {
    mode: "projects-collapsed",
    focus: "projects",
    baseline,
  });
  assert(
    await tabTo(`${s.recent}:focus-visible`),
    "Native Tab reaches Recent current fallback",
  );
  await record("recent-keyboard-focus", {
    mode: "projects-collapsed",
    focus: "recent",
    baseline,
  });
  await key("Enter", "Enter", 13);
  assert(
    await tabTo(`${s.projects}:focus-visible`),
    "Projects can be restored without a pointer",
  );
  await key("Enter", "Enter", 13);
  await wait(`!!document.querySelector(${JSON.stringify(s.project)})`);
  await record("projects-restored", {
    mode: "projects-expanded",
    focus: "projects",
    baseline,
  });
}
