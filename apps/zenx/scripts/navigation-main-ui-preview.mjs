import { sidebarIdentityCase } from "./sidebar-identity-cases.mjs";
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
              ...document.querySelectorAll(
                childNavigation
                  ? ".messages .agent-copy > [data-message-quote-body]"
                  : ".messages .agent-copy",
              ),
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
  if (await evaluate("!!window.__ordinaryTitleFixture"))
    return captureOrdinaryTitles({
      send,
      evaluate,
      wait,
      click,
      tabTo,
      capture,
      evidence,
      options,
    });
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

/** Display-only stress observation. Width loss is reported, never patched away. */
export function observeBusyChild() {
  const read = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect(),
      css = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const glyphs = [...range.getClientRects()].map((r) => ({
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      centerHit: element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      ),
    }));
    return {
      text: element.textContent,
      ariaHidden: element.getAttribute("aria-hidden"),
      disabled:
        !!element.disabled || element.getAttribute("aria-disabled") === "true",
      title: element.getAttribute("title"),
      rect: {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      ellipsized: element.scrollWidth > element.clientWidth + 1,
      visible:
        r.width > 0 &&
        r.height > 0 &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight &&
        css.visibility === "visible" &&
        Number(css.opacity) > 0,
      centerHit: element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      ),
      focused: document.activeElement === element,
      focusVisible: element.matches(":focus-visible"),
      outline: {
        width: css.outlineWidth,
        style: css.outlineStyle,
        color: css.outlineColor,
      },
      font: css.font,
      glyphs,
    };
  };
  const shell = document
    .querySelector('.sidebar .project-group [data-thread-id="design-child"]')
    ?.closest(".app-shell");
  const composers = [
    ...(shell?.querySelectorAll(
      ":scope > main.workspace #primary-conversation-content .composer",
    ) ?? []),
  ].filter((element) => {
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility === "visible" &&
      Number(style.opacity) > 0
    );
  });
  const composer = composers.length === 1 ? composers[0] : null;
  const editor = composer?.querySelector('[contenteditable="true"], textarea');
  return {
    composerCount: composers.length,
    fixture: window.__busyChildFixture,
    theme: document.documentElement.dataset.appearance,
    viewport: { width: innerWidth, height: innerHeight },
    aliases: ["project-group", "recent-thread-group"].map((scope) => {
      const shell = document.querySelector(
        `.sidebar .${scope} [data-thread-id="design-child"]`,
      );
      const row = shell?.querySelector(".thread-row");
      return {
        scope,
        row: read(row),
        title: read(row?.querySelector(".thread-title > span")),
        child: read(row?.querySelector(".thread-child-label")),
        model: read(row?.querySelector(".thread-model-name")),
        metadata: read(row?.querySelector(".thread-model")),
        approval: read(row?.querySelector(".thread-state-inline")),
        approvalFull: read(row?.querySelector(".thread-approval-full")),
        approvalCompact: read(row?.querySelector(".thread-approval-compact")),
        menu: read(shell?.querySelector(".thread-menu-trigger")),
        asking: !!row?.querySelector(".thread-asking-badge"),
      };
    }),
    reveal: read(document.querySelector(".thread-information-title > span")),
    detailFacts: [
      ...document.querySelectorAll(".thread-information [data-thread-fact]"),
    ].map((fact) => ({
      kind: fact.getAttribute("data-thread-fact"),
      row: read(fact),
      label: read(fact.querySelector("dt")),
      value: read(fact.querySelector("dd")),
    })),
    selected: [
      ...document.querySelectorAll('.sidebar .thread-row[aria-current="page"]'),
    ].map((e) => e.closest("[data-thread-id]")?.dataset.threadId),
    pane: read(document.querySelector(".thread-information")),
    composerEditor: read(editor),
    composerPrimary: read(composer?.querySelector(".action-orb")),
    composer: read(composer),
    draft: editor
      ? "value" in editor
        ? editor.value
        : editor.textContent
      : null,
    telemetry: window.__uiPolishTelemetry,
  };
}

export function verifyBusyChild(state, focusScope, baseline) {
  assert.deepEqual(state.viewport, { width: 1280, height: 900 });
  assert.equal(state.theme, "light");
  assert(state.fixture?.approval && state.fixture.asking === false);
  assert.equal(state.aliases.length, 2);
  assert.deepEqual(
    state.aliases.map((a) => a.scope),
    ["project-group", "recent-thread-group"],
  );
  for (const alias of state.aliases) {
    assert(
      alias.row &&
        alias.title &&
        alias.model &&
        alias.child &&
        alias.approval &&
        alias.menu,
      "Actual busy child and existing controls must render",
    );
    assert.equal(alias.title.text, state.fixture.title);
    assert.equal(alias.model.text, state.fixture.model);
    assert.equal(alias.model.title, state.fixture.model);
    assert.equal(alias.child.text, "Child");
    // textContent includes the decorative compact variant even when CSS hides it.
    // Keep the canonical accessible wording exact, and validate both variants
    // instead of accepting a prefix or weakening the approval-only assertion.
    assert.equal(
      (alias.approvalFull ?? alias.approval).text,
      "Needs your approval",
    );
    if (alias.approvalFull || alias.approvalCompact) {
      assert(
        alias.approvalFull,
        "Compact approval requires canonical full text",
      );
      assert.notEqual(alias.approvalFull.ariaHidden, "true");
      if (alias.approvalCompact) {
        assert.equal(alias.approvalCompact.text, "Needs approval");
        assert.equal(alias.approvalCompact.ariaHidden, "true");
      }
      assert.equal(
        alias.approval.text,
        alias.approvalFull.text + (alias.approvalCompact?.text ?? ""),
        "Approval wrapper contains only the validated wording variants",
      );
    }
    assert.equal(
      alias.asking,
      false,
      "Approval-only scene must not be confused with Asking",
    );
  }
  assert(
    state.selected.length > 0 &&
      state.selected.every((id) => id === "thread-1"),
    "Name inspection must not navigate",
  );
  assert.equal(state.draft, navigationDraft);
  assert.equal(state.telemetry.informationUpdates, 0);
  assert(
    !state.telemetry.protocolCalls.some((method) =>
      /send|respond|interrupt|archive|delete|create|answer/.test(method),
    ),
    "No real or simulated action is accepted",
  );
  assert.equal(
    state.composerCount,
    1,
    "Exactly one visible primary Composer is measured",
  );
  for (const control of [state.composerEditor, state.composerPrimary])
    assert(
      control?.visible && control.centerHit && !control.disabled,
      "Actual Composer editor and action remain usable",
    );
  if (baseline) {
    assert.deepEqual(state.composer.rect, baseline.composer.rect);
    assert.equal(
      state.telemetry.workspaceUsedCalls,
      baseline.telemetry.workspaceUsedCalls,
    );
  }
  if (focusScope) {
    const pane = state.pane?.rect,
      composer = state.composer?.rect;
    assert(
      state.pane?.visible &&
        pane.width > 0 &&
        pane.height > 0 &&
        composer?.width > 0 &&
        composer.height > 0,
      "Observe actual pane and Composer, not only a computed layout",
    );
    if (pane.x < composer.right && pane.right > composer.x)
      assert(
        pane.bottom + 8 <= composer.y,
        "Pending child detail keeps an actual 8px Composer gap",
      );
    assert.deepEqual(
      state.detailFacts.map((f) => f.kind),
      ["pending-approval", "model"],
    );
    assert.equal(state.detailFacts[0].value.text, "Needs your approval");
    assert.equal(state.detailFacts[1].value.text, state.fixture.model);
    for (const fact of state.detailFacts)
      for (const part of [fact.label, fact.value]) {
        assert(
          part.visible &&
            part.centerHit &&
            !part.ellipsized &&
            part.glyphs.length > 0,
          "Detail fact has observed visible text",
        );
        for (const glyph of part.glyphs)
          assert(
            glyph.width > 0 &&
              glyph.height > 0 &&
              glyph.centerHit &&
              glyph.x >= Math.max(pane.x, part.rect.x) - 1 &&
              glyph.right <= Math.min(pane.right, part.rect.right) + 1 &&
              glyph.y >= Math.max(pane.y, part.rect.y) - 1 &&
              glyph.bottom <= Math.min(pane.bottom, part.rect.bottom) + 1,
            "Full fact glyph fragments fit their own value and the actual pane",
          );
      }
    const target = state.aliases.find((a) => a.scope === focusScope).row;
    assert(
      target.focused &&
        target.focusVisible &&
        target.visible &&
        target.centerHit,
    );
    assert(
      target.outline.style !== "none" && parseFloat(target.outline.width) > 0,
    );
    assert.equal(state.reveal?.text, state.fixture.title);
    assert(
      state.reveal.visible &&
        state.reveal.centerHit &&
        !state.reveal.ellipsized &&
        state.reveal.scrollHeight <= state.reveal.clientHeight + 1,
      "Keyboard reveal must show the exact full title",
    );
  }
}

/** Three images only; separate profile, no preference write or approval decision. */
export async function captureBusyChild({
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
  const trip = {
    scope: "synthetic-approval-only-sidebar-measurement",
    status: "running",
    states: [],
  };
  (evidence.busyChildTrips ??= []).push(trip);
  const observe = () => evaluate(`(${observeBusyChild.toString()})()`);
  const settle = async () => {
    let previous;
    for (let n = 0; n < 12; n++) {
      await evaluate(
        "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
      );
      const state = await observe();
      trip.lastObservation = state;
      const value = JSON.stringify({ ...state, telemetry: undefined });
      if (previous === value) return state;
      previous = value;
    }
    throw Error("Busy child geometry did not settle");
  };
  const record = async (name, focusScope, baseline) => {
    const before = await settle();
    trip.states.push({ name, before });
    // These are observation frames, not proof that the compact model line fits.
    await capture(`busy-child-${options.name}-${name}`, options, "navigation");
    const after = await observe();
    trip.states.at(-1).after = after;
    verifyBusyChild(before, focusScope, baseline);
    verifyBusyChild(after, focusScope, baseline);
    assert.deepEqual(
      { ...after, telemetry: undefined },
      { ...before, telemetry: undefined },
      "Screenshot geometry/focus are stable",
    );
    return after;
  };
  try {
    await wait(
      "!!window.__busyChildFixture && document.querySelectorAll('.sidebar [data-thread-id=\"design-child\"] .thread-state-inline').length===2",
    );
    await click(navigationSelectors.project);
    await wait(
      `!!document.querySelector(${JSON.stringify(navigationSelectors.editor)})`,
    );
    await click(navigationSelectors.editor);
    await send("Input.insertText", { text: navigationDraft });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 700,
      y: 220,
    });
    await wait("!document.querySelector('.thread-information')");
    const baseline = await record("rest", null, null);
    for (const scope of ["project-group", "recent-thread-group"]) {
      const row = `.sidebar .${scope} [data-thread-id="design-child"] .thread-row`;
      assert(
        await tabTo(`${row}:focus-visible`),
        "Native Tab reaches the existing child row",
      );
      await wait(
        `document.querySelector('.thread-information-title > span')?.textContent===${JSON.stringify(baseline.fixture.title)}`,
      );
      await record(`${scope}-keyboard-reveal`, scope, baseline);
      await dispatchNavigationKey(send, "Escape", "Escape", 27);
      await wait("!document.querySelector('.thread-information')");
    }
    trip.status = "observed";
    trip.visualAcceptance =
      "Not asserted: model clipping and competing labels require pixel/measurement review.";
  } catch (error) {
    trip.status = "failed";
    trip.error = String(error);
    throw error;
  } finally {
    trip.elapsedMs = Date.now() - started;
  }
}

// Opt-in evidence only; the original approval-only acceptance remains unchanged.
/** Preserve exact canonical identity separately from fitted presentation evidence. */
export function verifySidebarTitlePresentation(presentation, expected, slot) {
  if (!presentation) return;
  assert.equal(
    presentation.canonical?.text,
    expected,
    "Exact canonical sibling title",
  );
  assert.equal(
    presentation.canonicalAttribute,
    expected,
    "Canonical marker matches actual text",
  );
  assert.equal(presentation.canonicalCount, 1);
  assert.equal(presentation.canonicalExposed, true);
  assert.equal(presentation.displayHiddenFromAT, true);
  assert.equal(presentation.probesHiddenFromAT, true);
  assert.equal(presentation.additionalTabStops, 0);
  const { mode, display } = presentation;
  assert(["canonical", "marked", "bare"].includes(mode));
  assert(display?.visible, "Presentation is visible");
  if (mode === "canonical") {
    assert.equal(display.text, expected);
  } else {
    const suffix = mode === "marked" ? display.text.slice(2) : display.text;
    if (mode === "marked") assert(display.text.startsWith("… "));
    assert(
      suffix && expected.endsWith(suffix),
      "Presentation is an exact canonical suffix",
    );
    assert.equal(
      display.ellipsized,
      false,
      "Abbreviated label must fit, not clip again",
    );
    assert(
      display.rect.width > 0 &&
        display.rect.x >= slot.rect.x - 1 &&
        display.rect.right <= slot.rect.right + 1,
    );
  }
}

export function observeCombinedAttention(owner = null) {
  const read = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect(),
      css = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const glyphs = [...range.getClientRects()].map((r) => ({
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      centerHit: element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      ),
    }));
    return {
      text: element.textContent,
      disabled:
        !!element.disabled || element.getAttribute("aria-disabled") === "true",
      title: element.getAttribute("title"),
      rect: {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      ellipsized: element.scrollWidth > element.clientWidth + 1,
      visible:
        r.width > 0 &&
        r.height > 0 &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight &&
        css.visibility === "visible" &&
        Number(css.opacity) > 0,
      centerHit: element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      ),
      focused: document.activeElement === element,
      focusVisible: element.matches(":focus-visible"),
      outline: {
        width: css.outlineWidth,
        style: css.outlineStyle,
        color: css.outlineColor,
      },
      font: css.font,
      glyphs,
    };
  };
  const presentation = (element) => {
    if (!element?.matches(".sidebar-collision-title")) return null;
    const canonical = element.querySelector(".sidebar-title-canonical");
    const display = element.querySelector(".sidebar-title-display");
    const probes = [...element.querySelectorAll('[class$="-probe"]')];
    return {
      canonical: read(canonical),
      canonicalAttribute: element.getAttribute("data-canonical-title"),
      canonicalCount: element.querySelectorAll(".sidebar-title-canonical")
        .length,
      canonicalExposed:
        !!canonical &&
        !canonical.closest('[aria-hidden="true"]') &&
        getComputedStyle(canonical).visibility === "visible",
      display: read(display),
      displayHiddenFromAT: display?.getAttribute("aria-hidden") === "true",
      probesHiddenFromAT:
        probes.length >= 2 &&
        probes.every((probe) => probe.getAttribute("aria-hidden") === "true"),
      additionalTabStops: element.querySelectorAll(
        "[tabindex],button,a[href],input,select,textarea",
      ).length,
      mode: element.getAttribute("data-label-mode"),
    };
  };
  const shell = document
    .querySelector('.sidebar .project-group [data-thread-id="design-child"]')
    ?.closest(".app-shell");
  const composers = [
    ...(shell?.querySelectorAll(
      ":scope > main.workspace #primary-conversation-content .composer",
    ) ?? []),
  ].filter((element) => {
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility === "visible" &&
      Number(style.opacity) > 0
    );
  });
  const composer = composers.length === 1 ? composers[0] : null;
  const editor = composer?.querySelector('[contenteditable="true"], textarea');
  const trigger = owner
    ? document.querySelector(
        `.sidebar .${owner.scope} [data-thread-id="test-child"] > .thread-status-rail > .thread-menu-trigger`,
      )
    : null;
  const expectedId = trigger?.id?.replace(
    /^thread-menu-trigger-/,
    "thread-menu-",
  );
  const panels = owner
    ? [
        ...document.querySelectorAll(".thread-information, .thread-item-menu"),
      ].filter((element) => {
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility === "visible" &&
          Number(style.opacity) > 0
        );
      })
    : [];
  const owned = owner
    ? panels.find(
        (element) =>
          element.id === expectedId &&
          element.getAttribute("aria-labelledby") === trigger?.id,
      )
    : null;
  const panelRoot = owner ? owned : document;
  const detailPane = owner
    ? owned?.matches(".thread-information")
      ? owned
      : null
    : document.querySelector(".thread-information");
  const actionMenu = owner
    ? owned?.matches(".thread-item-menu")
      ? owned
      : null
    : document.querySelector(".thread-item-menu");
  return {
    ...(owner
      ? {
          paneOwnership: {
            expectedId,
            triggerId: trigger?.id,
            controls: trigger?.getAttribute("aria-controls"),
            visibleCount: panels.length,
            ownedId: owned?.id,
            labelledBy: owned?.getAttribute("aria-labelledby"),
            kind: owned?.matches(".thread-item-menu")
              ? "menu"
              : owned?.matches(".thread-information")
                ? "detail"
                : null,
          },
        }
      : {}),
    composerCount: composers.length,
    fixture: window.__busyChildFixture,
    theme: document.documentElement.dataset.appearance,
    language: document.documentElement.lang,
    viewport: { width: innerWidth, height: innerHeight },
    aliases: ["project-group", "recent-thread-group"].map((scope) => {
      const shell = document.querySelector(
        `.sidebar .${scope} [data-thread-id="design-child"]`,
      );
      const row = shell?.querySelector(".thread-row");
      return {
        scope,
        row: read(row),
        title: read(row?.querySelector(".thread-title > span")),
        titlePresentation: presentation(
          row?.querySelector(".thread-title > span"),
        ),
        child: read(row?.querySelector(".thread-child-label")),
        model: read(row?.querySelector(".thread-model-name")),
        metadata: read(row?.querySelector(".thread-model")),
        approval: read(row?.querySelector(".thread-state-inline")),
        menu: read(shell?.querySelector(".thread-menu-trigger")),
        asking: read(row?.querySelector(".thread-asking-badge")),
        askingLabel: row
          ?.querySelector(".thread-asking-badge")
          ?.getAttribute("aria-label"),
        approvalFull: read(row?.querySelector(".thread-approval-full")),
        approvalCompact: read(row?.querySelector(".thread-approval-compact")),
        siblingRow: read(
          document.querySelector(
            `.sidebar .${scope} [data-thread-id="test-child"] > .thread-row`,
          ),
        ),
        siblingMenu: read(
          document.querySelector(
            `.sidebar .${scope} [data-thread-id="test-child"] > .thread-status-rail > .thread-menu-trigger`,
          ),
        ),
        siblingMenuId: document.querySelector(
          `.sidebar .${scope} [data-thread-id="test-child"] > .thread-status-rail > .thread-menu-trigger`,
        )?.id,
        siblingTitle: read(
          document.querySelector(
            `.sidebar .${scope} [data-thread-id="test-child"] .thread-title > span`,
          ),
        ),
        siblingTitlePresentation: presentation(
          document.querySelector(
            `.sidebar .${scope} [data-thread-id="test-child"] .thread-title > span`,
          ),
        ),
      };
    }),
    menuPanel: read(actionMenu),
    menuPanelCount: owner
      ? panels.filter((e) => e.matches(".thread-item-menu")).length
      : document.querySelectorAll(".thread-item-menu").length,
    menuPanelLabelledBy: actionMenu?.getAttribute("aria-labelledby"),
    menuPanelFocusWithin: actionMenu?.contains(document.activeElement) ?? false,
    reveal: read(panelRoot?.querySelector(".thread-information-title > span")),
    detailFacts: [
      ...(owner
        ? (owned?.querySelectorAll("[data-thread-fact]") ?? [])
        : document.querySelectorAll(".thread-information [data-thread-fact]")),
    ].map((fact) => ({
      kind: fact.getAttribute("data-thread-fact"),
      row: read(fact),
      label: read(fact.querySelector("dt")),
      value: read(fact.querySelector("dd")),
    })),
    selected: [
      ...document.querySelectorAll('.sidebar .thread-row[aria-current="page"]'),
    ].map((e) => e.closest("[data-thread-id]")?.dataset.threadId),
    pane: read(detailPane),
    composerEditor: read(editor),
    composerPrimary: read(composer?.querySelector(".action-orb")),
    composer: read(composer),
    draft: editor
      ? "value" in editor
        ? editor.value
        : editor.textContent
      : null,
    telemetry: window.__uiPolishTelemetry,
  };
}

export function verifyCombinedAttention(state, options) {
  assert.deepEqual(state.viewport, { width: 1280, height: 900 });
  assert.equal(state.theme, options.theme);
  const wording = {
    en: {
      child: "Child",
      asking: "Asking",
      count: "2 open question requests",
      approval: "Needs your approval",
      compact: "Needs approval",
    },
    "zh-CN": {
      child: "子会话",
      asking: "待回答",
      count: "2 组问题待回答",
      approval: "需要你的审批",
      compact: "待审批",
    },
  }[options.lang];
  assert(wording, "Explicit supported capture locale is required");
  const identity = options.identityCase
    ? sidebarIdentityCase(options.identityCase)
    : null;
  assert.equal(
    state.fixture?.identityCase ?? null,
    options.identityCase ?? null,
  );
  const siblingTitle =
    identity?.siblingTitle ?? `${state.fixture.title} · alternate review`;
  if (identity) {
    assert.equal(options.lang, identity.lang);
    assert.equal(state.fixture.title, identity.title);
    assert.equal(state.fixture.siblingTitle, identity.siblingTitle);
  }
  assert.equal(state.fixture?.scene, "approval-asking");
  assert.equal(state.fixture.approval, true);
  assert.equal(state.fixture.openQuestionCount, 2);
  assert.equal(state.fixture.asking, true);
  assert.equal(state.aliases.length, 2);
  assert.deepEqual(
    state.aliases.map((a) => a.scope),
    ["project-group", "recent-thread-group"],
  );
  for (const alias of state.aliases) {
    assert(
      alias.title &&
        alias.model &&
        alias.child &&
        alias.approval &&
        alias.asking &&
        alias.menu,
    );
    verifySidebarTitlePresentation(
      alias.titlePresentation,
      state.fixture.title,
      alias.title,
    );
    assert.equal(
      (alias.titlePresentation?.canonical ?? alias.title).text,
      state.fixture.title,
    );
    assert.equal(alias.model.text, state.fixture.model);
    assert.equal(
      (alias.siblingTitlePresentation?.canonical ?? alias.siblingTitle)?.text,
      siblingTitle,
    );
    verifySidebarTitlePresentation(
      alias.siblingTitlePresentation,
      siblingTitle,
      alias.siblingTitle,
    );
    assert.equal(alias.child.text, wording.child, "Rendered child locale");
    assert.equal(alias.asking.text, wording.asking, "Rendered Asking locale");
    assert.equal(alias.askingLabel, wording.count, "Localized Asking count");
    assert.equal(
      (alias.approvalFull ?? alias.approval).text,
      wording.approval,
      "Localized full approval text",
    );
    if (alias.approvalCompact)
      assert.equal(alias.approvalCompact.text, wording.compact);
  }
  assert.equal(state.composerCount, 1);
  assert.equal(state.draft, navigationDraft);
  assert(
    state.selected.length > 0 &&
      state.selected.every((id) => id === "thread-1"),
  );
  assert.equal(state.telemetry.informationUpdates, 0);
  assert(
    !state.telemetry.protocolCalls.some((method) =>
      /send|respond|interrupt|archive|delete|create|answer/.test(method),
    ),
  );
  // Observational baseline may expose clipping: record it, never bless it as fit.
}

export function combinedPaneOwned(state, menuOpen) {
  const p = state.paneOwnership;
  return (
    !!p?.triggerId &&
    !!p.expectedId &&
    p.visibleCount === 1 &&
    p.ownedId === p.expectedId &&
    p.labelledBy === p.triggerId &&
    p.kind === (menuOpen ? "menu" : "detail") &&
    (!menuOpen || p.controls === p.expectedId)
  );
}

export async function captureCombinedAttention({
  send,
  evaluate,
  wait,
  click,
  tabTo,
  capture,
  evidence,
  options,
}) {
  const trip = {
    scope: "synthetic-combined-sidebar-observation",
    status: "running",
    states: [],
    visualAcceptance:
      "Not asserted; inspect matched original captures for legibility.",
  };
  (evidence.combinedAttentionTrips ??= []).push(trip);
  const observe = (owner = null) =>
    evaluate(
      `(${observeCombinedAttention.toString()})(${JSON.stringify(owner)})`,
    );
  const summary = ({ telemetry, ...geometry }) => geometry;
  const record = async (
    name,
    scope,
    baseline,
    sibling = false,
    menuOpen = false,
  ) => {
    const owner = options.identityCase && sibling ? { scope, menuOpen } : null;
    let previous;
    let sample;
    let stable = 0;
    for (let n = 0; n < 12; n++) {
      await evaluate(
        owner
          ? "document.fonts.ready.then(()=>new Promise(r=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(r)),100)))"
          : "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
      );
      const state = await observe(owner);
      trip.lastObservation = state;
      const value = JSON.stringify(summary(state));
      const ready = !owner || combinedPaneOwned(state, menuOpen);
      stable = ready && previous === value ? stable + 1 : 0;
      if (ready && stable >= (owner ? 3 : 1)) {
        sample = state;
        break;
      }
      previous = ready ? value : undefined;
    }
    assert(sample, "Combined status geometry/owner did not settle");
    const entry = { name, before: sample };
    trip.states.push(entry);
    await capture(
      `combined-attention-${options.name}-${name}`,
      options,
      "navigation",
    );
    entry.after = await observe(owner);
    if (owner)
      assert(
        combinedPaneOwned(entry.after, menuOpen),
        "Screenshot retains exact pane owner",
      );
    verifyCombinedAttention(sample, options);
    verifyCombinedAttention(entry.after, options);
    assert.deepEqual(summary(entry.after), summary(sample));
    for (const control of [sample.composerEditor, sample.composerPrimary])
      assert(control?.visible && control.centerHit && !control.disabled);
    if (baseline)
      assert.deepEqual(sample.composer.rect, baseline.composer.rect);
    if (scope) {
      const alias = sample.aliases.find((a) => a.scope === scope);
      const row = sibling ? alias?.siblingRow : alias?.row;
      const menu = sibling ? alias?.siblingMenu : alias?.menu;
      if (!menuOpen) assert(row?.focused && row.focusVisible);
      assert(menu?.visible && menu.centerHit);
      assert.equal(
        sample.reveal?.text,
        sibling ? sample.fixture.siblingTitle : sample.fixture.title,
      );
      if (menuOpen) {
        assert(sample.menuPanel?.visible && sample.menuPanelFocusWithin);
        assert.equal(
          sample.menuPanelCount,
          1,
          "Exactly one second sibling menu",
        );
        assert.equal(sample.menuPanelLabelledBy, alias.siblingMenuId);
      } else
        assert(
          sample.pane?.visible &&
            sample.pane.rect.bottom <= sample.composer.rect.y,
        );
    }
    return sample;
  };
  try {
    await wait(
      "window.__busyChildFixture?.scene==='approval-asking' && document.querySelectorAll('.sidebar [data-thread-id=\"design-child\"] .thread-asking-badge').length===2",
    );
    await click(navigationSelectors.project);
    await wait(
      `!!document.querySelector(${JSON.stringify(navigationSelectors.editor)})`,
    );
    await click(navigationSelectors.editor);
    await send("Input.insertText", { text: navigationDraft });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 700,
      y: 220,
    });
    await wait("!document.querySelector('.thread-information')");
    const baseline = await record("rest", null, null);
    for (const scope of ["project-group", "recent-thread-group"]) {
      const row = `.sidebar .${scope} [data-thread-id="design-child"] .thread-row`;
      assert(
        await tabTo(`${row}:focus-visible`),
        "Keyboard reaches existing child row",
      );
      await wait(
        `document.querySelector('.thread-information-title > span')?.textContent===${JSON.stringify(baseline.fixture.title)}`,
      );
      await record(`${scope}-keyboard-reveal`, scope, baseline);
      await dispatchNavigationKey(send, "Escape", "Escape", 27);
      await wait("!document.querySelector('.thread-information')");
    }
    if (options.identityCase) {
      for (const scope of ["project-group", "recent-thread-group"]) {
        const shell = `.sidebar .${scope} [data-thread-id="test-child"]`;
        assert(
          await tabTo(`${shell} > .thread-row:focus-visible`),
          "Native Tab reaches second sibling",
        );
        await wait(
          `document.querySelector('.thread-information-title > span')?.textContent===${JSON.stringify(baseline.fixture.siblingTitle)}`,
        );
        await record(`${scope}-second-sibling-detail`, scope, baseline, true);
        assert(
          await tabTo(
            `${shell} > .thread-status-rail > .thread-menu-trigger:focus-visible`,
          ),
          "Native Tab reaches second sibling menu",
        );
        await dispatchNavigationKey(send, "Enter", "Enter", 13);
        await wait("!!document.querySelector('.thread-item-menu')");
        await record(
          `${scope}-second-sibling-menu`,
          scope,
          baseline,
          true,
          true,
        );
        await dispatchNavigationKey(send, "Escape", "Escape", 27);
        await wait("!document.querySelector('.thread-item-menu')");
        const returned = await observe();
        verifyCombinedAttention(returned, options);
        assert.equal(
          returned.menuPanelCount,
          0,
          "Escape removes second sibling menu",
        );
        const alias = returned.aliases.find((a) => a.scope === scope);
        assert(
          alias?.siblingMenu?.focused,
          "Escape restores exact second sibling menu trigger",
        );
        trip.states.push({
          name: `${scope}-second-sibling-menu-dismissed`,
          after: returned,
        });
      }
    }
    trip.status = "observed";
  } catch (error) {
    trip.status = "failed";
    trip.error = String(error);
    throw error;
  }
}

/** Opt-in ordinary-title A/B; geometry is not OCR or proof of identity. */
export async function captureOrdinaryTitles({
  send,
  evaluate,
  wait,
  click,
  tabTo,
  capture,
  evidence,
  options,
}) {
  await click(navigationSelectors.project);
  await wait(
    `!!document.querySelector(${JSON.stringify(navigationSelectors.editor)})`,
  );
  await click(navigationSelectors.editor);
  await send("Input.insertText", { text: navigationDraft });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 700,
    y: 220,
  });
  await evaluate(
    "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
  );
  await wait(
    `['project-group','recent-thread-group'].every(scope =>
      window.__ordinaryTitleFixture.every(item =>
        !!document.querySelector('.'+scope+' [data-thread-id="'+item.threadId+'"] .thread-title > span:first-child')))`,
  );
  const state = await evaluate(`(() => {
    const sidebar=document.querySelector('.sidebar'), scroll=sidebar.querySelector('.sidebar-scroll'), band=scroll.getBoundingClientRect();
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
    const rows=[...sidebar.querySelectorAll('.thread-row-shell[data-thread-id]')];
    const pair=window.__ordinaryTitleFixture.flatMap(item=>['project-group','recent-thread-group'].map(scope=>{
      const shell=sidebar.querySelector('.'+scope+' [data-thread-id="'+item.threadId+'"]'), row=shell.querySelector('.thread-row'), title=row.querySelector('.thread-title > span:first-child'),r=title.getBoundingClientRect(),css=getComputedStyle(title);
      const canvas=new OffscreenCanvas(1, 1),ctx=canvas.getContext('2d');ctx.font=css.font;
      const clipped=(title.scrollWidth>title.clientWidth||title.scrollHeight>title.clientHeight), reserve=clipped?ctx.measureText('…').width:0;
      const glyphs=[...new Intl.Segmenter('zh-CN',{granularity:'grapheme'}).segment(title.textContent)].map(({segment,index})=>{
        const range=document.createRange();range.setStart(title.firstChild,index);range.setEnd(title.firstChild,index+segment.length);const g=range.getBoundingClientRect();
        return {text:segment,top:g.top,visible:g.width>0&&g.left>=r.left&&g.right<=r.right-reserve&&g.top>=Math.max(r.top,band.top)&&g.bottom<=Math.min(r.bottom,band.bottom)};
      });
      return {id:item.threadId,scope,fullTitle:title.textContent,expected:item.title,ordinary:!title.matches('.sidebar-collision-title'),row:rect(row),title:rect(title),clamp:css.webkitLineClamp,clipped,visibleText:glyphs.filter(g=>g.visible).map(g=>g.text).join(''),lineCount:new Set(glyphs.filter(g=>g.visible).map(g=>Math.round(g.top))).size};
    }));
    return {density:sidebar.dataset.threadDensity,width:sidebar.getBoundingClientRect().width,pair,order:rows.map(e=>e.dataset.threadId),visibleRows:rows.filter(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.top>=band.top&&r.bottom<=band.bottom}).length,scrollTop:scroll.scrollTop};
  })()`);
  (evidence.ordinaryTitleCases ??= []).push({
    theme: options.theme,
    variant: options.variant,
    scope:
      "Default-width resting Detailed preview; Compact/minimum-width/control actions not covered",
    ...state,
  });
  await capture(`${options.name}-rest`, options, "navigation");
  assert.equal(state.density, "detailed");
  assert(state.width > 0);
  assert.equal(state.pair.length, 4);
  for (const item of state.pair) {
    assert.equal(item.fullTitle, item.expected);
    assert(item.ordinary);
    assert.equal(item.clamp, options.variant === "two-lines" ? "2" : "none");
    assert(
      item.lineCount >= 1 &&
        item.lineCount <= (options.variant === "baseline" ? 1 : 2),
    );
  }
  if (options.theme !== "dark" || options.variant !== "two-lines") return;
  const target =
    '.project-group [data-thread-id="ordinary-reader"] > .thread-row:focus-visible';
  assert(await tabTo(target), "Native Tab reaches ordinary title");
  const full = state.pair.find(
    (item) => item.id === "ordinary-reader",
  ).fullTitle;
  await wait(
    `document.querySelector('.thread-information-title > span')?.textContent===${JSON.stringify(full)}`,
  );
  await dispatchNavigationKey(send, "ArrowRight", "ArrowRight", 39);
  await wait("!!document.activeElement?.closest('.thread-information')");
  await capture(`${options.name}-full-name`, options, "navigation");
  await dispatchNavigationKey(send, "Escape", "Escape", 27);
  await wait(
    `!document.querySelector('.thread-information') && !!document.querySelector(${JSON.stringify(target)})`,
  );
}
