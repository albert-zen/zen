import assert from "node:assert/strict";
export function observeQueueReading() {
  const target = (selector) => {
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
      focused: document.activeElement === e,
      focusVisible: e.matches(":focus-visible"),
      focusWithin: e.matches(":focus-within"),
      borderColor: style.borderTopColor,
      borderWidth: parseFloat(style.borderTopWidth),
      focusRing: style
        .getPropertyValue("--color-focus-ring")
        .trim()
        .replace(
          /^#([0-9a-f]{6})$/i,
          (_, hex) =>
            `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`,
        ),
      forcedColors: matchMedia("(forced-colors: active)").matches,
      outline: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      disabled: !!e.disabled,
    };
  };
  const tray = document.querySelector(".pending-tray"),
    toggle = document.querySelector(".queue-reading-toggle");
  const r = tray?.getBoundingClientRect();
  return {
    toggle: target(".queue-reading-toggle"),
    expanded: toggle?.getAttribute("aria-expanded"),
    controls: toggle?.getAttribute("aria-controls"),
    trayId: tray?.id,
    tray: target(".pending-tray"),
    scrollTop: tray?.scrollTop,
    scrollHeight: tray?.scrollHeight,
    scrollContainers: [...(tray?.querySelectorAll("*") ?? [])]
      .filter(
        (e) =>
          /auto|scroll/.test(getComputedStyle(e).overflowY) &&
          e.scrollHeight > e.clientHeight + 1,
      )
      .map((e) => e.className),
    composer: target(".composer"),
    editor: target('.composer [contenteditable="true"], .composer textarea'),
    edit: target(".queue-row-edit:not(:disabled)"),
    bodyReading: [
      ...document.querySelectorAll(".pending-tray .queue-row-content"),
    ].map((e) => {
      const b = e.getBoundingClientRect();
      return {
        height: b.height,
        width: b.width,
        visibleHeight: r
          ? Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.y, r.y))
          : 0,
        horizontalOverflow: e.scrollWidth > e.clientWidth + 1,
      };
    }),
    readableRows: [
      ...document.querySelectorAll(".pending-tray .queue-row"),
    ].filter((e) => {
      const b = e.getBoundingClientRect();
      return r && b.bottom > r.y && b.y < r.bottom;
    }).length,
    active: {
      tag: document.activeElement?.tagName,
      id: document.activeElement?.id,
      classes: document.activeElement?.className,
      focusVisible: document.activeElement?.matches(":focus-visible"),
    },
    documentFocused: document.hasFocus(),
  };
}
export function verifyQueueReading(s, baseline, expanded, focus) {
  assert(
    s.bodyReading.length > 0,
    "Observe real queued-message body content, not an empty tray",
  );
  assert(s.toggle?.visible && s.toggle.hit, "Reading toggle remains reachable");
  assert.equal(s.expanded, String(expanded));
  assert(
    s.controls && s.controls === s.trayId,
    "Toggle controls the actual shared tray",
  );
  assert(
    s.composer?.visible && s.editor?.visible && s.editor.hit,
    "Composer remains visible and reachable",
  );
  assert.equal(
    s.backendNodeId,
    baseline.backendNodeId,
    "Same native scrolling container, not a replacement",
  );
  assert(
    s.composer.rect.height >= baseline.composer.rect.height - 1,
    "Composer does not shrink",
  );
  assert(
    s.editor.rect.height >= baseline.editor.rect.height - 1,
    "Editor does not shrink",
  );
  assert(
    s.scrollContainers.every((name) =>
      baseline.scrollContainers.includes(name),
    ),
    "Expansion introduces no new nested scrolling region",
  );
  if (expanded)
    assert(
      s.tray.rect.height > baseline.tray.rect.height + 1,
      "Expanded tray gains actual reading height",
    );
  else
    assert(
      Math.abs(s.tray.rect.height - baseline.tray.rect.height) <= 1,
      "Collapse restores default tray height",
    );
  if (focus) {
    const t = s[focus];
    assert(
      t?.focused && t.focusVisible && t.visible && t.hit && !t.disabled,
      "Native keyboard focus is visible and reachable",
    );
    if (focus === "editor") {
      const c = s.composer;
      assert(
        c.focusWithin &&
          ((c.borderWidth > 0 && c.borderColor === c.focusRing) ||
            (c.forcedColors && c.outline !== "none" && c.outlineWidth > 0)),
        "Composer owns the editor focus ring",
      );
    } else
      assert(
        t.outline !== "none" && t.outlineWidth > 0,
        "Focus outline exists",
      );
  }
}
export async function captureQueueReading({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
}) {
  const prefix = `queue-reading-${options.name}`;
  const identity = async () => {
    const { root } = await send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: ".pending-tray",
    });
    const { node } = await send("DOM.describeNode", { nodeId });
    return node.backendNodeId;
  };
  const observe = async () => ({
    ...(await evaluate(`(${observeQueueReading.toString()})()`)),
    backendNodeId: await identity(),
  });
  const save = async (step) => {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 700,
      y: 180,
    });
    await new Promise((r) => setTimeout(r, 300));
    const s = await observe();
    s.queueBodyVisibleHeight = s.bodyReading.reduce(
      (sum, body) => sum + body.visibleHeight,
      0,
    );
    (evidence.queueReadingCases ??= []).push({
      step,
      theme: options.theme,
      ...s,
    });
    await capture(`${prefix}-${step}`, options, "pending");
    return s;
  };
  const tab = async (selector, step, direction = "forward") => {
    const trace = { step, direction, limit: 80, observations: [] };
    (evidence.queueReadingTabAttempts ??= []).push(trace);
    for (let i = 0; i < 80; i++) {
      for (const type of ["rawKeyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type,
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
          modifiers: direction === "backward" ? 8 : 0,
        });
      const s = await observe();
      trace.observations.push(s);
      if (
        await evaluate(
          `document.activeElement?.matches(${JSON.stringify(selector)})`,
        )
      )
        return;
    }
    throw Error(`Native Tab failed: ${step}`);
  };
  try {
    await wait("!!document.querySelector('.queue-reading-toggle')");
    const baseline = await save("rest");
    verifyQueueReading(baseline, baseline, false);
    await click(".queue-reading-toggle");
    await wait(
      "document.querySelector('.queue-reading-toggle')?.getAttribute('aria-expanded')==='true'",
    );
    const expanded = await save("expanded");
    verifyQueueReading(expanded, baseline, true);
    assert(
      expanded.readableRows >= baseline.readableRows,
      "More space does not reduce visible rows",
    );
    await tab(".queue-row-edit:not(:disabled):focus-visible", "edit");
    verifyQueueReading(await save("edit-focus"), baseline, true, "edit");
    await tab(
      '.composer [contenteditable="true"]:focus-visible, .composer textarea:focus-visible',
      "composer",
    );
    verifyQueueReading(await save("composer-focus"), baseline, true, "editor");
    await tab(".queue-reading-toggle:focus-visible", "toggle", "backward");
    verifyQueueReading(
      await save("collapse-toggle-focus"),
      baseline,
      true,
      "toggle",
    );
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}),
      });
    await wait(
      "document.querySelector('.queue-reading-toggle')?.getAttribute('aria-expanded')==='false'",
    );
    verifyQueueReading(
      await save("collapsed-focus"),
      baseline,
      false,
      "toggle",
    );
  } catch (error) {
    (evidence.queueReadingFailures ??= []).push({
      theme: options.theme,
      error: String(error),
    });
    try {
      await save("failed");
    } catch (diagnostic) {
      evidence.queueReadingDiagnosticError = String(diagnostic);
    }
    throw error;
  }
}

export const queueReadingPaths = [
  ".github/workflows/desktop-queue-reading-ui.yml",
  "apps/zenx/src/renderer/src/QueuedMessages.tsx",
  "apps/zenx/src/renderer/src/queued-messages.css",
  "apps/zenx/src/renderer/src/ThreadView.tsx",
  "apps/zenx/src/renderer/src/i18n/shell.ts",
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/test/fixtures/queue-steer-visual.tsx",
  "apps/zenx/scripts/build-main-ui-preview.mjs",
  "apps/zenx/scripts/capture-main-ui-preview.mjs",
  "apps/zenx/scripts/queue-reading-main-ui-preview.mjs",
  "apps/zenx/test/queue-reading-main-ui-preview.test.mjs",
];
export function queueReadingPathsChanged(paths) {
  return paths.some((path) => queueReadingPaths.includes(path));
}
