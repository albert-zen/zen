import assert from "node:assert/strict";

export const RESULT_DRAFT =
  "Keep this synthetic draft while inspecting RESULT.md.";

/** Read-only observation. Never opens files, assigns focus, clicks or scrolls. */
export function observeResultFile() {
  const rect = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      bottom: r.bottom,
    };
  };
  const visible = (e) =>
    !!e &&
    !e.hidden &&
    !!e.getClientRects().length &&
    getComputedStyle(e).visibility !== "hidden";
  const link = document.querySelector('.agent-copy a[href="RESULT.md"]');
  const marker = [...document.querySelectorAll(".agent-copy p")].find((e) =>
    e.textContent.startsWith(
      "Keep this paragraph as the reading-position marker",
    ),
  );
  const editor = document.querySelector(
    '.composer [contenteditable="true"], .composer textarea',
  );
  const workspace = document.querySelector(
    '#thread-workspace-panel[data-open="true"]:not([inert])',
  );
  const selected = workspace?.querySelector(
    '[role="tab"][aria-selected="true"][data-canonical-title="RESULT.md"]',
  );
  const panel =
    selected && document.getElementById(selected.getAttribute("aria-controls"));
  const close = [
    ...(workspace?.querySelectorAll(".auxiliary-close-button") ?? []),
  ].find(visible);
  const focus = document.activeElement;
  const messages = document.querySelector(".messages");
  return {
    receipt: window.__resultFileFixture?.receipt(),
    href: location.href,
    link: link && {
      href: link.getAttribute("href"),
      text: link.textContent,
      rect: rect(link),
      focused: focus === link,
      focusVisible: link.matches(":focus-visible"),
    },
    marker: marker && { text: marker.textContent, rect: rect(marker) },
    messages: messages && {
      rect: rect(messages),
      scrollTop: messages.scrollTop,
    },
    draft: editor?.value ?? editor?.textContent ?? null,
    composer: rect(document.querySelector(".composer")),
    selectedFile: selected && {
      title: selected.getAttribute("data-canonical-title"),
      tabId: selected.closest("[data-tab-id]")?.getAttribute("data-tab-id"),
      controls: selected.getAttribute("aria-controls"),
    },
    file: visible(panel)
      ? {
          text: panel.textContent,
          editable: !!panel.querySelector(
            '[contenteditable="true"], textarea:not([readonly])',
          ),
          rect: rect(panel),
        }
      : null,
    workspaceOpen: !!workspace,
    closeVisible: !!close,
    closeFocused: !!close && focus === close,
    focus: {
      tag: focus?.tagName,
      id: focus?.id,
      label: focus?.getAttribute("aria-label"),
      text: focus?.textContent?.slice(0, 100),
    },
    alerts: [...document.querySelectorAll('[role="alert"]')]
      .filter(visible)
      .map((e) => e.textContent),
  };
}

export function verifyResultFile(state, phase, baseline) {
  assert(state?.receipt?.synthetic);
  assert.equal(state.receipt.owner, "thread-1");
  assert.equal(state.receipt.path, "RESULT.md");
  assert.equal(state.draft, RESULT_DRAFT);
  assert.deepEqual(state.alerts, []);
  assert.equal(state.link?.href, "RESULT.md");
  assert(state.marker && state.messages && state.composer);
  if (baseline) {
    assert.equal(
      state.href,
      baseline.href,
      "Existing thread route is retained",
    );
    assert.equal(state.marker.text, baseline.marker.text);
  }
  if (phase === "focused") {
    assert.deepEqual(state.receipt.reads, [], "No eager or guessed file read");
    assert(
      state.link.focused && state.link.focusVisible,
      "Native keyboard focus reaches link",
    );
    assert.equal(state.workspaceOpen, false);
    assert(!state.closeVisible, "Comparable closed-panel starting width");
  } else {
    assert.deepEqual(state.receipt.reads, [
      { threadId: "thread-1", path: "RESULT.md" },
    ]);
    if (phase === "opened") {
      assert.equal(state.selectedFile?.title, "RESULT.md");
      assert(
        state.file?.text.includes(
          "This in-memory document is the exact linked artifact.",
        ),
      );
      assert(!state.file.editable);
      assert.equal(state.workspaceOpen, true);
      assert(state.closeVisible);
      // Record actual focus destination rather than inventing a focus contract.
    } else if (phase === "returned") {
      assert.equal(state.workspaceOpen, false);
      assert(!state.closeVisible);
      assert.equal(
        state.focus?.id,
        "thread-browser-toggle",
        "Native close restores existing toggle focus",
      );
      assert.equal(state.composer.width, baseline.composer.width);
      const offset = (s) => s.marker.rect.y - s.messages.rect.y;
      assert(
        Math.abs(offset(state) - offset(baseline)) <= 2,
        "Reading position restored at original width",
      );
    } else assert.fail("Unknown evidence phase");
  }
  // Semantic marker visibility matters while panel reflow changes line count.
  const top = Math.max(state.messages.rect.y, 0);
  const bottom = Math.min(state.messages.rect.bottom, state.composer.y);
  assert(
    state.marker.rect.y >= top - 2 && state.marker.rect.bottom <= bottom + 2,
    "Reading marker remains visible, not hidden by Composer",
  );
}

export async function captureResultFile({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
  url,
}) {
  const { dispatchNavigationKey } =
    await import("./navigation-main-ui-preview.mjs");
  const target = new URL(url);
  assert.equal(target.searchParams.get("scene"), "reading");
  assert.equal(target.searchParams.get("resultFile"), "1");
  for (const key of [
    "results",
    "inlineTrace",
    "nestedOutput",
    "codeWrap",
    "tableKeyboard",
    "childQuestions",
    "streaming",
    "pending",
    "busyChild",
    "conversationTabs",
    "launchers",
  ])
    assert(
      !target.searchParams.has(key),
      "Exclusive result-file scene required",
    );
  assert.equal(options.width, 1280);
  assert.equal(options.height, 900);
  await send("Page.navigate", { url: target.href });
  await wait(
    "!!window.__resultFileFixture && !!document.querySelector('.thread-row')",
  );
  await click('.project-group [data-thread-id="thread-1"] .thread-row');
  await wait(`!!document.querySelector('.agent-copy a[href="RESULT.md"]')`);
  const observe = () => evaluate(`(${observeResultFile.toString()})()`);
  const settle = async () => {
    let previous = "",
      stable = 0;
    for (let i = 0; i < 20; i++) {
      const s = await observe();
      const measured = JSON.stringify({
        marker: s.marker?.rect,
        composer: s.composer,
        file: s.file,
        workspaceOpen: s.workspaceOpen,
        closeVisible: s.closeVisible,
        focus: s.focus,
        messages: s.messages,
      });
      stable = measured === previous ? stable + 1 : 0;
      if (stable >= 2) return;
      previous = measured;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("Result-file geometry/focus did not settle within 2 seconds");
  };
  let stage = "initial-panel-state";
  try {
    if ((await observe()).workspaceOpen) {
      stage = "initial-close-readiness";
      await wait(`(() => {
        const e = document.querySelector('#thread-workspace-panel[data-open="true"]:not([inert]) .auxiliary-close-button');
        if (!e || e.disabled) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })()`);
      stage = "initial-close-pointer";
      await click(
        '#thread-workspace-panel[data-open="true"]:not([inert]) .auxiliary-close-button',
      );
    }
    await wait(
      "!document.querySelector('#thread-workspace-panel[data-open=true]:not([inert])')",
    );
    stage = "compose-draft";
    await click('.composer [contenteditable="true"], .composer textarea');
    await send("Input.insertText", { text: RESULT_DRAFT });
    const tabTo = async (condition) => {
      for (let i = 0; i < 60; i++) {
        if (condition(await observe())) return;
        await dispatchNavigationKey(send, "Tab", "Tab", 9);
      }
      assert.fail(
        "Native Tab traversal did not reach expected control in 60 steps",
      );
    };
    stage = "tab-to-result-link";
    await tabTo((s) => s.link?.focused);
    let baseline;
    const save = async (phase) => {
      await settle();
      const state = await observe();
      verifyResultFile(state, phase, baseline);
      (evidence.resultFileCases ??= []).push({
        theme: options.theme,
        phase,
        ...state,
      });
      await capture(
        `reading-${options.name}-result-file-${phase}`,
        options,
        "reading",
      );
      return state;
    };
    stage = "focused-receipt";
    baseline = await save("focused");
    stage = "activate-result-link";
    await dispatchNavigationKey(send, "Enter", "Enter", 13);
    stage = "opened-readiness";
    await wait(
      "window.__resultFileFixture.receipt().reads.length === 1 && !!document.querySelector('#thread-workspace-panel[data-open=true]:not([inert]) [role=tab][aria-selected=true][data-canonical-title=\"RESULT.md\"]')",
    );
    await wait(`(() => {
    const tab = document.querySelector('#thread-workspace-panel[data-open="true"]:not([inert]) [role="tab"][aria-selected="true"][data-canonical-title="RESULT.md"]');
    const panel = tab && document.getElementById(tab.getAttribute("aria-controls"));
    return !!panel && !panel.hidden && panel.textContent.includes("This in-memory document is the exact linked artifact.");
  })()`);
    stage = "opened-receipt";
    await save("opened");
    stage = "tab-to-close";
    await tabTo((s) => s.closeFocused);
    stage = "activate-close";
    await dispatchNavigationKey(send, "Enter", "Enter", 13);
    stage = "closed-readiness";
    await wait(
      "!document.querySelector('#thread-workspace-panel[data-open=true]:not([inert])')",
    );
    stage = "returned-receipt";
    await save("returned");
  } catch (error) {
    // Preserve what actually rendered on readiness/assertion failure, without repair.
    evidence.resultFileFailure = {
      stage,
      theme: options.theme,
      message: String(error),
      observed: await observe().catch(() => null),
    };
    await capture(
      `reading-${options.name}-result-file-failed`,
      options,
      "reading",
    ).catch(() => {});
    throw error;
  }
}

/** Validate exact copied reading build before any browser starts. */
export function verifyResultFileSource(
  source,
  expectedHead,
  actualTree,
  clean,
) {
  assert.match(expectedHead ?? "", /^[a-f0-9]{40}$/);
  assert.equal(source.commit, expectedHead);
  assert.equal(source.tree, actualTree);
  assert.equal(source.schemaVersion, 1);
  assert(
    Object.hasOwn(source, "dirtyFiles") && Array.isArray(source.dirtyFiles),
  );
  assert.deepEqual(source.dirtyFiles, []);
  assert.equal(clean, true);
  assert.deepEqual(Object.keys(source.scenes ?? {}), ["reading"]);
  for (const file of [
    "apps/zenx/scripts/result-file-main-ui-preview.mjs",
    "apps/zenx/test/fixtures/ui-polish-result-file.ts",
    "apps/zenx/test/fixtures/ui-polish-visual.tsx",
    "apps/zenx/scripts/reading-main-ui-preview.mjs",
  ])
    assert.match(source.sources?.[file] ?? "", /^[a-f0-9]{64}$/);
}
