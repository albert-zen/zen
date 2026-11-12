import assert from "node:assert/strict";
import { dispatchNavigationKey } from "./navigation-main-ui-preview.mjs";

export function observeCodeWrap() {
  const frame = document.querySelector(".agent-copy .markdown-code");
  const pre = frame?.querySelector("pre");
  const code = pre?.querySelector("code");
  const wrap = frame?.querySelector(".markdown-code-wrap");
  const copy = frame?.querySelector(
    ".markdown-code-copy, .markdown-code-actions button:last-child",
  );
  const composer = document.querySelector(".composer");
  const rect = (e) => {
    const r = e.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      right: r.right,
      bottom: r.bottom,
    };
  };
  if (!frame || !pre || !code || !copy || !composer) return null;
  const r = rect(pre),
    cr = rect(composer);
  return {
    text: code.textContent,
    expected: window.__codeWrapFixture?.text,
    clipboardKind: window.__codeWrapFixture?.kind,
    clipboardWrites: [...(window.__codeWrapFixture?.copied ?? [])],
    wrapAvailable: !!wrap,
    wrapped: wrap?.getAttribute("aria-pressed") === "true",
    frameWrapped: frame.getAttribute("data-wrapped"),
    wrapFocused: document.activeElement === wrap,
    wrapFocusVisible: wrap?.matches(":focus-visible") ?? false,
    copyFocused: document.activeElement === copy,
    whiteSpace: getComputedStyle(pre).whiteSpace,
    proseLineHeight: getComputedStyle(document.querySelector(".agent-copy"))
      .lineHeight,
    scrollWidth: pre.scrollWidth,
    clientWidth: pre.clientWidth,
    scrollLeft: pre.scrollLeft,
    pre: r,
    frame: rect(frame),
    composer: cr,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    horizontalPageOverflow:
      document.documentElement.scrollWidth > innerWidth + 1,
  };
}

export function verifyCodeWrap(
  s,
  { wrapped, focus = false, copied = false } = {},
) {
  assert(s, "Real code controls must exist");
  assert.equal(s.clipboardKind, "synthetic-clipboard-only");
  assert.equal(s.text, s.expected, "Displayed source text is unchanged");
  assert.equal(s.wrapped, wrapped);
  if (s.wrapAvailable) assert.equal(s.frameWrapped, String(wrapped));
  else
    assert(!wrapped, "A baseline without a wrap control must remain unwrapped");
  assert.equal(
    s.proseLineHeight,
    "27px",
    "Ordinary prose leading remains unchanged",
  );
  assert(!s.horizontalPageOverflow, "Long source cannot widen the application");
  assert(
    s.pre.x >= 0 &&
      s.pre.right <= s.viewportWidth &&
      s.frame.bottom <= s.composer.y + 1,
    "Code and its ending are not hidden behind the Composer in this test scene",
  );
  if (wrapped)
    assert(
      s.scrollWidth <= s.clientWidth + 1,
      "Wrapped source fits its viewport",
    );
  else
    assert(
      s.scrollWidth > s.clientWidth + 100,
      "The fixture exercises actual long-line overflow",
    );
  if (focus)
    assert(
      s.wrapFocused && s.wrapFocusVisible,
      "Native keyboard focus is visible on the wrap control",
    );
  if (copied) {
    assert.equal(
      s.clipboardWrites.length,
      1,
      "Exactly one synthetic copy write",
    );
    assert.equal(
      s.clipboardWrites[0],
      s.expected,
      "Copy preserves complete source, including tabs and Unicode",
    );
  }
}

// Read-only element identity bookkeeping, never a product DOM/focus mutation.
export function observeCodeKeyboard() {
  const pre = document.querySelector(".agent-copy .markdown-code pre");
  const active = document.activeElement;
  const ids = window.__zenCodeKeyboardProbe;
  if (active && !ids.nodes.has(active)) ids.nodes.set(active, ++ids.next);
  return {
    activeId: active ? ids.nodes.get(active) : null,
    activeTag: active?.tagName ?? null,
    activeClass:
      typeof active?.className === "string" ? active.className : null,
    preFocused: !!pre && active === pre,
    focusVisible: pre?.matches(":focus-visible") ?? false,
    scrollLeft: pre?.scrollLeft ?? null,
    scrollWidth: pre?.scrollWidth ?? null,
    clientWidth: pre?.clientWidth ?? null,
    transcriptScrollTop: document.querySelector(".messages")?.scrollTop ?? null,
    pageScrollX: scrollX,
    pageScrollY: scrollY,
  };
}

export async function probeCodeKeyboard({
  send,
  evaluate,
  capture,
  evidence,
  options,
}) {
  const record = {
    theme: options.theme,
    outcome: "tab-limit",
    observations: [],
  };
  const observe = () => evaluate(`(${observeCodeKeyboard.toString()})()`);
  await evaluate(
    "window.__zenCodeKeyboardProbe = {nodes: new WeakMap(), next: 0}; true",
  );
  try {
    const seen = new Set();
    for (let index = 0; index <= 60; index++) {
      const state = await observe();
      record.observations.push(state);
      if (state.preFocused) {
        record.beforeArrow = state;
        await dispatchNavigationKey(send, "ArrowRight", "ArrowRight", 39);
        // Native scrolling can animate; observe after a short bounded settle.
        await new Promise((resolve) => setTimeout(resolve, 250));
        record.afterArrow = await observe();
        record.outcome =
          record.afterArrow.scrollLeft > state.scrollLeft
            ? "reached-and-scrolled"
            : "reached-no-scroll";
        break;
      }
      if (seen.has(state.activeId)) {
        record.outcome = "tab-cycle-without-pre";
        break;
      }
      seen.add(state.activeId);
      if (index < 60) await dispatchNavigationKey(send, "Tab", "Tab", 9);
    }
    await capture(
      `reading-${options.name}-code-keyboard-scroll-probe`,
      options,
      "reading",
    );
    (evidence.codeKeyboardCases ??= []).push(record);
    return record;
  } finally {
    await evaluate("delete window.__zenCodeKeyboardProbe");
  }
}

export function observeTableKeyboard() {
  const wrapper = document.querySelector(".agent-copy .markdown-table-wrap");
  const active = document.activeElement;
  const ids = window.__zenTableKeyboardProbe;
  if (active && !ids.nodes.has(active)) ids.nodes.set(active, ++ids.next);
  return {
    activeId: active ? ids.nodes.get(active) : null,
    activeTag: active?.tagName ?? null,
    wrapperFocused: !!wrapper && active === wrapper,
    linkFocused:
      !!wrapper && !!active?.matches("a[href]") && wrapper.contains(active),
    focusVisible: active?.matches(":focus-visible") ?? false,
    scrollLeft: wrapper?.scrollLeft ?? null,
    scrollWidth: wrapper?.scrollWidth ?? null,
    clientWidth: wrapper?.clientWidth ?? null,
    text: wrapper?.textContent ?? null,
    linkCount: wrapper?.querySelectorAll("a[href]").length ?? 0,
    transcriptScrollTop: document.querySelector(".messages")?.scrollTop ?? null,
    pageScrollX: scrollX,
    pageScrollY: scrollY,
    href: location.href,
  };
}

export async function probeTableKeyboard({
  send,
  evaluate,
  capture,
  evidence,
  options,
  mode,
}) {
  const record = {
    theme: options.theme,
    mode,
    outcome: "tab-limit",
    observations: [],
    arrowAttempts: [],
  };
  const observe = () => evaluate(`(${observeTableKeyboard.toString()})()`);
  await evaluate(
    "window.__zenTableKeyboardProbe = {nodes: new WeakMap(), next: 0}; true",
  );
  try {
    const seen = new Set();
    for (let index = 0; index <= 60; index++) {
      const state = await observe();
      record.observations.push(state);
      if (seen.has(state.activeId)) {
        record.outcome = record.arrowAttempts.length
          ? "reachable-no-scroll"
          : "tab-cycle-without-table-stop";
        break;
      }
      seen.add(state.activeId);
      if (state.wrapperFocused || state.linkFocused) {
        await dispatchNavigationKey(send, "ArrowRight", "ArrowRight", 39);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const after = await observe();
        record.arrowAttempts.push({ before: state, after });
        if (after.scrollLeft > state.scrollLeft) {
          record.outcome = state.wrapperFocused
            ? "wrapper-reached-and-scrolled"
            : "link-reached-and-scrolled";
          break;
        }
      }
      if (index < 60) await dispatchNavigationKey(send, "Tab", "Tab", 9);
    }
    const initial = record.observations[0];
    record.overflow = initial.scrollWidth > initial.clientWidth + 1;
    // No overflow is an observed control condition, not a scrolling failure.
    if (!record.overflow)
      record.outcome = record.arrowAttempts.length
        ? "fits-with-table-stop"
        : "fits-without-table-stop";
    await capture(
      `reading-${options.name}-table-keyboard-${mode}`,
      options,
      "reading",
    );
    (evidence.tableKeyboardCases ??= []).push(record);
    return record;
  } finally {
    await evaluate("delete window.__zenTableKeyboardProbe");
  }
}

export async function captureTableKeyboard({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
  url,
  scrollToTop,
}) {
  for (const mode of ["plain", "links", "fit"]) {
    const target = new URL(url);
    target.searchParams.delete("codeWrap");
    target.searchParams.delete("results");
    target.searchParams.set("tableKeyboard", mode);
    await send("Page.navigate", { url: target.href });
    await wait(
      `location.href===${JSON.stringify(target.href)} && !!document.querySelector('.thread-row')`,
    );
    await click('.project-group [data-thread-id="thread-1"] .thread-row');
    await wait("!!document.querySelector('.agent-copy .markdown-table-wrap')");
    await scrollToTop();
    await probeTableKeyboard({
      send,
      evaluate,
      capture,
      evidence,
      options,
      mode,
    });
  }
}

export async function captureCodeWrap({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
  url,
  scrollToTop,
}) {
  await captureTableKeyboard({
    send,
    evaluate,
    wait,
    click,
    capture,
    evidence,
    options,
    url,
    scrollToTop,
  });
  const target = new URL(url);
  target.searchParams.delete("tableKeyboard");
  target.searchParams.set("codeWrap", "1");
  await send("Page.navigate", { url: target.href });
  await wait(
    `location.href===${JSON.stringify(target.href)} && !!document.querySelector('.thread-row')`,
  );
  await click('.project-group [data-thread-id="thread-1"] .thread-row');
  await wait(
    "!!document.querySelector('.markdown-code pre') && !!window.__codeWrapFixture",
  );
  await scrollToTop();
  const observe = () => evaluate(`(${observeCodeWrap.toString()})()`);
  const key = (key, code, value) =>
    dispatchNavigationKey(send, key, code, value);
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
  const save = async (step, expected) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = await observe();
    verifyCodeWrap(state, expected);
    (evidence.codeWrapCases ??= []).push({
      theme: options.theme,
      step,
      ...state,
    });
    await capture(`reading-${options.name}-code-${step}`, options, "reading");
    return state;
  };
  await probeCodeKeyboard({ send, evaluate, capture, evidence, options });
  // Restore through ordinary navigation, not focus/scroll DOM manipulation.
  await send("Page.navigate", { url: target.href });
  await wait(
    `location.href===${JSON.stringify(target.href)} && !!document.querySelector('.thread-row')`,
  );
  await click('.project-group [data-thread-id="thread-1"] .thread-row');
  await wait(
    "!!document.querySelector('.markdown-code pre') && !!window.__codeWrapFixture",
  );
  await scrollToTop();
  const idle = await save("long-unwrapped", { wrapped: false });
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: idle.pre.x + 100,
    y: idle.pre.y + 20,
    deltaX: 500,
    deltaY: 0,
  });
  await wait("document.querySelector('.markdown-code pre').scrollLeft > 0");
  await save("horizontal-scroll", { wrapped: false });
  if (!idle.wrapAvailable) return;
  await tabTo(".markdown-code-wrap");
  await save("wrap-keyboard-focus", { wrapped: false, focus: true });
  await key("Enter", "Enter", 13);
  await wait(
    "document.querySelector('.markdown-code-wrap')?.getAttribute('aria-pressed') === 'true'",
  );
  await save("wrapped", { wrapped: true, focus: true });
  await tabTo(".markdown-code-copy");
  await key("Enter", "Enter", 13);
  await wait("window.__codeWrapFixture.copied.length === 1");
  await save("copied", { wrapped: true, copied: true });
  await tabTo(".markdown-code-wrap");
  await key(" ", "Space", 32);
  await wait(
    "document.querySelector('.markdown-code-wrap')?.getAttribute('aria-pressed') === 'false'",
  );
  await save("unwrapped-restored", {
    wrapped: false,
    focus: true,
    copied: true,
  });
}
