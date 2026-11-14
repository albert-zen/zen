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
export function observeNavigation(
  childSidebar = false,
  childNavigation = false,
) {
  const read = (selector, visibility = false) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      ...(visibility
        ? {
            checked: element.getAttribute("aria-checked"),
            busy: element.getAttribute("aria-busy"),
            disabled: element.getAttribute("aria-disabled"),
            role: element.getAttribute("role"),
            label: element.getAttribute("aria-label"),
            text: element.textContent,
          }
        : {}),
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
    ...(childNavigation
      ? {
          navigationTitle:
            document.querySelector(".thread-heading .thread-title-path")
              ?.textContent ?? null,
          activeControl: {
            tag: document.activeElement?.tagName,
            role: document.activeElement?.getAttribute("role"),
            label: document.activeElement?.getAttribute("aria-label"),
          },
        }
      : {}),
    ...(childSidebar
      ? {
          childSidebar: {
            toggle: read(
              '.information-dock .subagent-sidebar-visibility[aria-label="Show in sidebar: Design review"]',
              true,
            ),
            sibling: read(
              '.information-dock .subagent-sidebar-visibility[aria-label="Show in sidebar: Test coverage"]',
              true,
            ),
            left: read(
              '.sidebar .project-group [data-thread-id="design-child"] .thread-row',
            ),
            recent: read(
              '.sidebar .recent-thread-group [data-thread-id="design-child"] .thread-row',
            ),
            siblingProject: read(
              '.sidebar .project-group [data-thread-id="test-child"] .thread-row',
            ),
            siblingRecent: read(
              '.sidebar .recent-thread-group [data-thread-id="test-child"] .thread-row',
            ),
            siblingLeftCount: document.querySelectorAll(
              '.sidebar [data-thread-id="test-child"]',
            ).length,
            leftCount: document.querySelectorAll(
              '.sidebar .project-group [data-thread-id="design-child"] .thread-row',
            ).length,
            leftTotalCount: document.querySelectorAll(
              '.sidebar [data-thread-id="design-child"]',
            ).length,
            sidebar: read(".sidebar"),
            owner: document
              .querySelector(".information-dock .editable-information-panel")
              ?.getAttribute("data-owner"),
            switchCount: document.querySelectorAll(
              ".information-dock .subagent-sidebar-visibility",
            ).length,
            errors: document.querySelectorAll(
              ".information-dock .subagent-sidebar-error",
            ).length,
            answers: [
              ...document.querySelectorAll(".messages .agent-copy"),
            ].map((e) => e.textContent),
            preference: window.__childSidebarPreference.receipt(),
          },
        }
      : {}),
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

export function assertChildSidebarState(state, visible, baseline, writes) {
  assertNavigationState(state, { mode: "information-open" });
  const child = state.childSidebar,
    toggle = child.toggle;
  assert.equal(child.owner, "thread:thread-1");
  assert.equal(child.switchCount, 2);
  assert.equal(child.errors, 0);
  assert.equal(toggle?.role, "switch");
  assert.equal(toggle.label, "Show in sidebar: Design review");
  assert.equal(toggle.checked, String(visible));
  assert.equal(toggle.busy, "false");
  assert.equal(toggle.disabled, "false");
  assert(
    toggle.focused &&
      toggle.focusVisible &&
      toggle.fullyVisible &&
      toggle.centerHit,
    "Native keyboard focus stays on the visible child switch",
  );
  assert(
    toggle.outline.style !== "none" && parseFloat(toggle.outline.width) > 0,
    "Child switch has its production keyboard focus outline",
  );
  assert.equal(child.sibling.checked, "true");
  assert.equal(child.siblingLeftCount, 2);
  assert(
    child.siblingProject?.fullyVisible &&
      child.siblingProject.centerHit &&
      child.siblingRecent?.fullyVisible &&
      child.siblingRecent.centerHit,
    "Unrelated shown sibling keeps both left navigation memberships",
  );
  assert.equal(child.leftCount, visible ? 1 : 0);
  assert.equal(child.leftTotalCount, visible ? 2 : 0);
  if (visible) {
    assert(child.left.fullyVisible && child.left.centerHit);
    assert(
      child.left.rect.x >= child.sidebar.rect.x &&
        child.left.rect.right <= child.sidebar.rect.right,
      "Child appears in left navigation, not the right Information tree",
    );
    assert(child.sidebar.rect.right <= state.dock.rect.x);
    assert.notEqual(child.left.current, "page");
    assert(child.recent?.fullyVisible && child.recent.centerHit);
    assert.notEqual(child.recent.current, "page");
  } else {
    assert.equal(child.left, null);
    assert.equal(child.recent, null);
  }
  assert.equal(state.project.current, "page");
  assert.equal(child.preference.scope, "synthetic-in-memory-preference-only");
  assert.deepEqual(
    child.preference.visibleSubagentThreadIds,
    visible ? ["test-child", "design-child"] : ["test-child"],
  );
  assert.deepEqual(child.preference.changes, writes);
  if (baseline) {
    assert.deepEqual(child.answers, baseline.childSidebar.answers);
    assert.deepEqual(
      child.preference.pinnedThreadIds,
      baseline.childSidebar.preference.pinnedThreadIds,
    );
    assert.deepEqual(
      child.preference.sidebarOrder,
      baseline.childSidebar.preference.sidebarOrder,
    );
    for (const key of [
      "machineThreadCreateCalls",
      "sideChatCreateCommandCalls",
      "informationUpdates",
      "workspaceUsedCalls",
    ])
      assert.equal(
        state.telemetry[key],
        baseline.telemetry[key],
        `No unrelated ${key}`,
      );
    assert.deepEqual(
      state.telemetry.protocolCalls,
      baseline.telemetry.protocolCalls,
      "Visibility never navigates, sends or calls the Host",
    );
    assert.deepEqual(
      state.telemetry.informationReads,
      baseline.telemetry.informationReads,
      "Information owner is not replaced",
    );
  }
}

/** Separate opt-in synthetic preference probe. Ordinary navigation route stays unchanged. */
export async function captureChildSidebar({
  send,
  evaluate,
  wait,
  click,
  tabTo,
  capture,
  evidence,
  options,
}) {
  const started = Date.now();
  const selector =
    '.information-dock .subagent-sidebar-visibility[aria-label="Show in sidebar: Design review"]';
  const receipt = {
    theme: options.theme,
    scope: "synthetic-in-memory-preference-only",
    status: "running",
    states: [],
  };
  (evidence.childSidebarTrips ??= []).push(receipt);
  const observe = () => evaluate(`(${observeNavigation.toString()})(true)`);
  const settle = () =>
    evaluate(
      "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
    );
  const record = async (name, visible, baseline, writes) => {
    let before, prior;
    for (let attempt = 0; attempt < 12; attempt++) {
      await settle();
      const sample = await observe();
      receipt.lastObservation = sample;
      if (
        prior &&
        JSON.stringify(sample.childSidebar) ===
          JSON.stringify(prior.childSidebar)
      ) {
        before = sample;
        break;
      }
      prior = sample;
    }
    assert(
      before,
      "Child visibility and left navigation geometry settle before capture",
    );
    receipt.states.push({ name, before });
    assertChildSidebarState(before, visible, baseline, writes);
    await capture(
      `child-sidebar-${options.name}-${name}`,
      options,
      "navigation",
    );
    const after = await observe();
    receipt.states.at(-1).after = after;
    assertChildSidebarState(after, visible, baseline, writes);
    assert.deepEqual(
      after.childSidebar,
      before.childSidebar,
      "Screenshot-time child ownership and geometry are stable",
    );
    return after;
  };
  try {
    await wait(
      `!!document.querySelector(${JSON.stringify(navigationSelectors.project)})`,
    );
    await click(navigationSelectors.project);
    await wait(
      `!!document.querySelector(${JSON.stringify(navigationSelectors.editor)})`,
    );
    await click(navigationSelectors.editor);
    await send("Input.insertText", { text: navigationDraft });
    await click(navigationSelectors.entry);
    await wait(
      `document.querySelectorAll('.information-dock .subagent-sidebar-visibility').length===2`,
    );
    assert(
      await tabTo(`${selector}:focus-visible`),
      "Actual Tab reaches the child visibility switch",
    );
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 700,
      y: 220,
    });
    const baseline = await record("hidden-focus", false, null, []);
    const writes = [];
    for (const visible of [true, false]) {
      const before = await observe();
      assertChildSidebarState(before, !visible, baseline, writes);
      const inputSequence =
        before.telemetry.navigationInputEvents.at(-1)?.sequence ?? 0;
      await dispatchNavigationKey(send, "Enter", "Enter", 13);
      await wait(
        `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked')===${JSON.stringify(String(visible))} && document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-busy')==='false'`,
      );
      writes.push({ threadId: "design-child", visible });
      const after = await record(
        visible ? "shown" : "hidden-again",
        visible,
        baseline,
        writes,
      );
      const native = after.telemetry.navigationInputEvents.filter(
        (event) => event.sequence > inputSequence,
      );
      assert(
        native.some(
          (event) =>
            event.target === "child-sidebar" &&
            event.type === "keydown" &&
            event.key === "Enter" &&
            event.trusted,
        ),
      );
      assert(
        native.some(
          (event) =>
            event.target === "child-sidebar" &&
            event.type === "keyup" &&
            event.key === "Enter" &&
            event.trusted,
        ),
      );
      assert(
        native.some(
          (event) =>
            event.target === "child-sidebar" &&
            event.type === "click" &&
            event.trusted,
        ),
      );
    }
    receipt.status = "passed";
  } catch (error) {
    receipt.status = "failed";
    receipt.error = String(error);
    throw error;
  } finally {
    receipt.elapsedMs = Date.now() - started;
  }
}

export const childNavigationDraft =
  "Unsent design-child draft; keep parent separate.";
export const childNavigationAnswer =
  "Synthetic Design review. This conversation has its own draft and reading state.";

export function assertChildNavigationState(state, owner, draft, baseline) {
  const child = state.childSidebar;
  assert.equal(
    state.draft,
    draft,
    "Each conversation retains only its own unsent draft",
  );
  assert.deepEqual(state.questionReadErrors, []);
  assert.equal(
    child.owner,
    `thread:${owner}`,
    "Information matches the selected conversation",
  );
  assert(
    state.dock?.fullyVisible &&
      state.composer?.fullyVisible &&
      state.composer.centerHit,
  );
  assert.equal(state.entry.expanded, "true");
  assert.equal(state.popover, null);
  const active = owner === "design-child" ? child.left : state.project;
  const alias = owner === "design-child" ? child.recent : state.recent;
  const inactive = owner === "design-child" ? state.project : child.left;
  assert(
    active?.fullyVisible &&
      active.centerHit &&
      alias?.fullyVisible &&
      alias.centerHit,
  );
  assert.equal(active.current, "page");
  assert.equal(alias.current, "page");
  assert.notEqual(inactive?.current, "page");
  assert(child.siblingProject?.centerHit && child.siblingRecent?.centerHit);
  assert.equal(child.leftCount, 1);
  assert.equal(child.leftTotalCount, 2);
  assert.equal(child.siblingLeftCount, 2);
  assert.deepEqual(child.preference, {
    ...baseline.childSidebar.preference,
    visibleSubagentThreadIds: ["test-child", "design-child"],
    changes: [{ threadId: "design-child", visible: true }],
  });
  if (owner === "design-child") {
    assert.deepEqual(
      child.answers,
      [childNavigationAnswer],
      "Actual child answer, not a renamed parent",
    );
  } else {
    assert.deepEqual(
      child.answers,
      baseline.childSidebar.answers,
      "Parent transcript returns unchanged",
    );
    assert(!child.answers.includes(childNavigationAnswer));
    assert.equal(child.toggle?.checked, "true");
    assert.equal(child.sibling?.checked, "true");
  }
  for (const key of [
    "informationUpdates",
    "machineThreadCreateCalls",
    "sideChatCreateCommandCalls",
  ])
    assert.equal(state.telemetry[key], baseline.telemetry[key], `No ${key}`);
  assert(
    state.telemetry.navigationReads.some(
      (read) =>
        read.threadId === owner &&
        /^zen\/thread\/resume(?:-window)?$/.test(read.method),
    ),
  );
  assert(
    state.telemetry.navigationReads.every((read) =>
      ["thread-1", "design-child"].includes(read.threadId),
    ),
  );
  assert(
    state.telemetry.informationReads.some(
      (read) => read.kind === "thread" && read.id === owner,
    ),
  );
  assert(
    state.telemetry.informationReads.every(
      (read) =>
        read.kind === "thread" &&
        ["thread-1", "design-child"].includes(read.id),
    ),
  );
  assert(
    state.telemetry.protocolCalls.every((method) =>
      [
        "zen/initialize",
        "zen/thread/resume",
        "zen/thread/resume-window",
        "zen/thread/read",
        "zen/thread/questions/list",
      ].includes(method),
    ),
    "Read-only navigation does not send, create, archive, stop or respond",
  );
}

export function assertChildNavigationTransition(
  before,
  after,
  owner,
  keyboard,
) {
  const reads = after.telemetry.navigationReads.slice(
    before.telemetry.navigationReads.length,
  );
  assert(
    reads.some(
      (read) =>
        read.threadId === owner &&
        /^zen\/thread\/resume(?:-window)?$/.test(read.method),
    ),
    "Each navigation performs a fresh exact-owner resume",
  );
  const seq = before.telemetry.navigationInputEvents.at(-1)?.sequence ?? 0;
  const events = after.telemetry.navigationInputEvents.filter(
    (event) => event.sequence > seq,
  );
  assert(
    events.some(
      (event) =>
        event.threadId === owner && event.type === "click" && event.trusted,
    ),
    "Trusted input selects the exact left-sidebar row",
  );
  if (keyboard)
    for (const type of ["keydown", "keyup"])
      assert(
        events.some(
          (event) =>
            event.threadId === owner &&
            event.type === type &&
            event.key === "Enter" &&
            event.trusted,
        ),
        `Trusted Enter ${type} reaches the exact parent row`,
      );
}

/** Independent opt-in whole-App round trip, not part of the preference-only route. */
export async function captureChildNavigation({
  send,
  evaluate,
  wait,
  click,
  tabTo,
  capture,
  evidence,
  options,
}) {
  const receipt = {
    scope: "synthetic-child-open-return-no-send",
    theme: options.theme,
    status: "running",
    states: [],
    transitions: [],
  };
  (evidence.childNavigationTrips ??= []).push(receipt);
  const started = Date.now();
  const observe = () =>
    evaluate(`(${observeNavigation.toString()} )(true, true)`);
  const settle = async () => {
    let prior;
    for (let n = 0; n < 12; n++) {
      await evaluate(
        "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
      );
      const sample = await observe();
      receipt.lastObservation = sample;
      // Ignore read telemetry timestamps/counts, but not UI identity, geometry or drafts.
      const stable = JSON.stringify({ ...sample, telemetry: undefined });
      if (stable === prior) return sample;
      prior = stable;
    }
    throw new Error("Child navigation UI did not settle");
  };
  const switchSelector =
    '.information-dock .subagent-sidebar-visibility[aria-label="Show in sidebar: Design review"]';
  const projectChild =
    '.sidebar .project-group [data-thread-id="design-child"] .thread-row';
  const recentChild =
    '.sidebar .recent-thread-group [data-thread-id="design-child"] .thread-row';
  const information = async (owner) => {
    const before = await observe();
    receipt.transitions.push({
      name: "information-after-navigation",
      owner,
      expanded: before.entry?.expanded,
      observedOwner: before.childSidebar.owner,
    });
    assert(
      before.childSidebar.owner == null ||
        before.childSidebar.owner === `thread:${owner}`,
      "No stale Information owner remains after the selected row changes",
    );
    if (before.entry?.expanded === "false")
      await click(navigationSelectors.entry);
    await wait(
      `document.querySelector('.information-dock .editable-information-panel')?.getAttribute('data-owner')===${JSON.stringify(`thread:${owner}`)}`,
    );
  };
  const record = async (name, owner, draft, baseline) => {
    const before = await settle();
    receipt.states.push({ name, before });
    assertChildNavigationState(before, owner, draft, baseline);
    await capture(
      `child-navigation-${options.name}-${name}`,
      options,
      "navigation",
    );
    const after = await observe();
    receipt.states.at(-1).after = after;
    assertChildNavigationState(after, owner, draft, baseline);
    assert.deepEqual(
      { ...after, telemetry: undefined },
      { ...before, telemetry: undefined },
      "Screenshot-time owner, draft and geometry stay settled",
    );
  };
  const navigate = async (selector, owner, keyboard = false) => {
    const before = await observe();
    if (keyboard) {
      assert(
        await tabTo(`${selector}:focus-visible`),
        "Actual Tab reaches the parent row",
      );
      const focused = await observe();
      receipt.transitions.push({
        name: "parent-keyboard-focus",
        owner,
        observed: focused.project,
      });
      assert(
        focused.project?.focused &&
          focused.project.focusVisible &&
          focused.project.fullyVisible &&
          focused.project.centerHit &&
          focused.project.outline.style !== "none" &&
          parseFloat(focused.project.outline.width) > 0,
        "Parent row has visible keyboard focus before Enter",
      );
      await dispatchNavigationKey(send, "Enter", "Enter", 13);
    } else await click(selector);
    await wait(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-current')==='page'`,
    );
    const after = await observe();
    receipt.transitions.push({
      name: "row-navigation",
      owner,
      keyboard,
      after,
    });
    assertChildNavigationTransition(before, after, owner, keyboard);
    await information(owner);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 700,
      y: 220,
    });
  };
  try {
    await wait(
      `!!document.querySelector(${JSON.stringify(navigationSelectors.project)})`,
    );
    await click(navigationSelectors.project);
    await wait(
      `!!document.querySelector(${JSON.stringify(navigationSelectors.editor)})`,
    );
    await click(navigationSelectors.editor);
    await send("Input.insertText", { text: navigationDraft });
    await click(navigationSelectors.entry);
    await wait(`!!document.querySelector(${JSON.stringify(switchSelector)})`);
    assert(await tabTo(`${switchSelector}:focus-visible`));
    const baseline = await settle();
    receipt.baseline = baseline;
    assertChildSidebarState(baseline, false, null, []);
    await dispatchNavigationKey(send, "Enter", "Enter", 13);
    await wait(
      `document.querySelector(${JSON.stringify(switchSelector)})?.getAttribute('aria-checked')==='true' && document.querySelector(${JSON.stringify(switchSelector)})?.getAttribute('aria-busy')==='false'`,
    );
    const shown = await settle();
    receipt.shown = shown;
    assertChildSidebarState(shown, true, baseline, [
      { threadId: "design-child", visible: true },
    ]);
    assert(
      shown.telemetry.navigationInputEvents.some(
        (event) =>
          event.sequence >
            (baseline.telemetry.navigationInputEvents.at(-1)?.sequence ?? 0) &&
          event.target === "child-sidebar" &&
          event.type === "click" &&
          event.trusted,
      ),
      "Trusted switch activation shows the child",
    );
    await navigate(projectChild, "design-child");
    const emptyChild = await settle();
    receipt.childBeforeEdit = emptyChild;
    assertChildNavigationState(emptyChild, "design-child", "", baseline);
    await click(navigationSelectors.editor);
    await send("Input.insertText", { text: childNavigationDraft });
    await record("child-draft", "design-child", childNavigationDraft, baseline);
    await navigate(navigationSelectors.project, "thread-1", true);
    await record("parent-return", "thread-1", navigationDraft, baseline);
    await navigate(recentChild, "design-child");
    await record(
      "child-return",
      "design-child",
      childNavigationDraft,
      baseline,
    );
    receipt.status = "passed";
  } catch (error) {
    receipt.status = "failed";
    receipt.error = String(error);
    throw error;
  } finally {
    receipt.elapsedMs = Date.now() - started;
  }
}
