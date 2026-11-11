import assert from "node:assert/strict";
export function observeQueueReading() {
  const target = (selector) => {
    const e =
      typeof selector === "string"
        ? document.querySelector(selector)
        : selector;
    if (!e) return null;
    const r = e.getBoundingClientRect(),
      style = getComputedStyle(e);
    return {
      id: e.id,
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
      position: style.position,
      display: style.display,
      overflowY: style.overflowY,
      scrollsVertical:
        /auto|scroll/.test(style.overflowY) &&
        e.scrollHeight > e.clientHeight + 1,
      controls: e.getAttribute("aria-controls"),
      expanded: e.getAttribute("aria-expanded"),
    };
  };
  const toggle = document.querySelector(".queue-reading-toggle"),
    tray = document.getElementById(toggle?.getAttribute("aria-controls")),
    returnAction = document.querySelector(
      '[data-queue-control="reading-return"]',
    ),
    returnOwner = document.getElementById(
      returnAction?.getAttribute("aria-controls"),
    ),
    returnFooter = returnAction?.closest(".queue-reading-return"),
    returnHost = tray?.nextElementSibling?.matches(".queue-reading-return-host")
      ? tray.nextElementSibling
      : null,
    queue = toggle?.closest(".queue-shelf"),
    composer = tray?.closest(".bottom-zone")?.querySelector(".composer");
  const r = tray?.getBoundingClientRect();
  const bottomZone = target(tray?.closest(".bottom-zone"));
  const conversation = target(
    tray?.closest(".thread-view")?.querySelector(".messages"),
  );
  const rows = [...(tray?.querySelectorAll(".queue-row") ?? [])];
  return {
    toggle: target(".queue-reading-toggle"),
    expanded: toggle?.getAttribute("aria-expanded"),
    controls: toggle?.getAttribute("aria-controls"),
    trayId: tray?.id,
    tray: target(tray),
    bottomZone,
    conversation,
    conversationUncoveredHeight:
      conversation && bottomZone
        ? Math.max(
            0,
            Math.min(conversation.rect.bottom, bottomZone.rect.y) -
              Math.max(0, conversation.rect.y),
          )
        : null,
    scrollTop: tray?.scrollTop,
    scrollHeight: tray?.scrollHeight,
    scrollContainers: [...(tray?.querySelectorAll("*") ?? [])]
      .filter(
        (e) =>
          /auto|scroll/.test(getComputedStyle(e).overflowY) &&
          e.scrollHeight > e.clientHeight + 1,
      )
      .map((e) => e.className),
    composer: target(composer),
    editor: target(
      composer?.querySelector('[contenteditable="true"], textarea'),
    ),
    edit: target(queue?.querySelector(".queue-row-edit:not(:disabled)")),
    returnAction: target(returnAction),
    returnFooter: target(returnFooter),
    returnHost: target(returnHost),
    returnPlacement: {
      ownerMatchesTray:
        !!returnOwner && returnOwner === tray && tray.matches(".pending-tray"),
      outsideTray: !!returnHost && !tray.contains(returnHost),
      followsTray: !!returnHost && tray.nextElementSibling === returnHost,
      footerInHost: !!returnFooter && returnFooter.parentElement === returnHost,
      beforeComposer:
        !!returnHost &&
        !!composer &&
        !!(
          returnHost.compareDocumentPosition(composer) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    },
    // Queue ownership comes from its original header inside the aria-controlled
    // tray, not from the portalled footer or the earlier Steer shelf.
    lastRow: target(
      tray?.contains(queue)
        ? queue.querySelector(".queue-shelf-list > .queue-row:last-child")
        : null,
    ),
    rowActions: [...(tray?.querySelectorAll(".queue-row button") ?? [])].map(
      (button) => ({
        control: button.getAttribute("data-queue-control"),
        classes: button.className,
        disabled: button.disabled,
        tabIndex: button.tabIndex,
      }),
    ),
    bodyReading: [...(tray?.querySelectorAll(".queue-row-content") ?? [])].map(
      (e) => {
        const b = e.getBoundingClientRect();
        return {
          height: b.height,
          width: b.width,
          visibleHeight: r
            ? Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.y, r.y))
            : 0,
          horizontalOverflow: e.scrollWidth > e.clientWidth + 1,
        };
      },
    ),
    fullyVisibleRows: rows.filter((e) => {
      const b = e.getBoundingClientRect();
      // Include native clipping/sticky occlusion, not only geometric containment.
      return (
        r &&
        b.width > 0 &&
        b.height > 2 &&
        b.y >= r.y &&
        b.bottom <= r.bottom &&
        [b.y + 1, b.y + b.height / 2, b.bottom - 1].every((y) =>
          e.contains(document.elementFromPoint(b.x + b.width / 2, y)),
        )
      );
    }).length,
    readableRows: rows.filter((e) => {
      const b = e.getBoundingClientRect();
      return r && b.bottom > r.y && b.y < r.bottom;
    }).length,
    active: {
      tag: document.activeElement?.tagName,
      id: document.activeElement?.id,
      classes: document.activeElement?.className,
      focusVisible: document.activeElement?.matches(":focus-visible"),
      inQueueRow: !!document.activeElement?.closest(".queue-row"),
    },
    documentFocused: document.hasFocus(),
  };
}
export function verifyQueueReading(s, baseline, expanded, focus) {
  assert(
    s.bodyReading.length > 0,
    "Observe real queued-message body content, not an empty tray",
  );
  assert(s.toggle, "Original header reading toggle remains present");
  // At the trailing return, require the focused footer's real hit target below.
  // The sticky header's geometry remains recorded, not a second focus contract.
  if (focus !== "returnAction")
    assert(
      s.toggle.visible && s.toggle.hit,
      "Reading toggle remains reachable",
    );
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

export function verifyQueueReturn(s, baseline, expanded) {
  assert(
    baseline.rowActions.length > 0,
    "Fixture includes actual per-message actions",
  );
  assert.deepEqual(
    s.rowActions,
    baseline.rowActions,
    "Return shortcut does not remove or retab message actions",
  );
  if (!expanded) {
    assert.equal(
      s.returnAction,
      null,
      "Default/collapsed state has no extra return control",
    );
    assert.equal(
      s.returnFooter,
      null,
      "Default/collapsed state has no footer space cost",
    );
    assert(
      s.returnHost && s.returnHost.rect.height === 0,
      "Empty return host has no collapsed space cost",
    );
    return;
  }
  assert(
    s.returnAction && s.returnFooter && s.returnHost && s.lastRow,
    "Expanded return and actual controlled Queue are observed",
  );
  assert(
    [
      "ownerMatchesTray",
      "outsideTray",
      "followsTray",
      "footerInHost",
      "beforeComposer",
    ].every((key) => s.returnPlacement?.[key] === true),
    "Return belongs to the actual tray and its adjacent external host before Composer",
  );
  assert(
    s.returnAction.visible &&
      s.returnAction.hit &&
      !s.returnAction.disabled &&
      s.returnFooter.visible &&
      s.returnHost.visible,
    "External return is visible and hittable immediately, not only after keyboard scrolling",
  );
  assert.equal(s.returnAction.controls, s.trayId);
  assert.equal(s.returnAction.expanded, "true");
  assert(
    [s.returnFooter, s.returnHost].every((t) =>
      ["static", "relative"].includes(t.position),
    ),
    "Return is ordinary flow, not a sticky or floating overlay",
  );
  assert(s.returnFooter.rect.height > 0, "Record real footer space cost");
  assert(
    s.returnHost.rect.y >= s.tray.rect.bottom - 1 &&
      s.returnFooter.rect.y >= s.returnHost.rect.y - 1 &&
      s.returnFooter.rect.bottom <= s.returnHost.rect.bottom + 1,
    "External footer starts after the tray viewport and stays within its own host",
  );
  assert(
    s.returnHost.rect.bottom <= s.composer.rect.y + 1,
    "Return host stays above the Composer without overlay",
  );
  assert(
    s.bottomZone &&
      s.returnHost.rect.y >= s.bottomZone.rect.y - 1 &&
      s.returnHost.rect.bottom <= s.bottomZone.rect.bottom + 1,
    "Return host is fully inside the bottom-zone clipping boundary",
  );
  assert(
    s.bottomZone &&
      (!s.bottomZone.scrollsVertical || baseline.bottomZone.scrollsVertical),
    "External return does not introduce whole bottom-zone scrolling",
  );
}

export async function tabToQueueControl({
  send,
  observe,
  evaluate,
  evidence,
  options,
  selector,
  step,
  direction = "forward",
}) {
  const trace = {
    step,
    theme: options.theme,
    selector,
    direction,
    limit: 80,
    steps: 0,
    matched: false,
    before: await observe(),
    observations: [],
  };
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
    trace.steps = i + 1;
    trace.observations.push(s);
    if (
      await evaluate(
        `document.activeElement?.matches(${JSON.stringify(selector)})`,
      )
    ) {
      trace.matched = true;
      return trace;
    }
  }
  throw Error(`Native Tab failed: ${step}`);
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
      selector: await evaluate(
        `'.pending-tray#' + CSS.escape(document.querySelector('.queue-reading-toggle').getAttribute('aria-controls'))`,
      ),
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
  const tab = (selector, step, direction = "forward") =>
    tabToQueueControl({
      send,
      observe,
      evaluate,
      evidence,
      options,
      selector,
      step,
      direction,
    });
  try {
    await wait("!!document.querySelector('.queue-reading-toggle')");
    const baseline = await save("rest");
    verifyQueueReading(baseline, baseline, false);
    verifyQueueReturn(baseline, baseline, false);
    await click(".queue-reading-toggle");
    await wait(
      "document.querySelector('.queue-reading-toggle')?.getAttribute('aria-expanded')==='true'",
    );
    const expanded = await save("expanded");
    verifyQueueReading(expanded, baseline, true);
    verifyQueueReturn(expanded, baseline, true);
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
    const returnTrace = await tab(
      '[data-queue-control="reading-return"]:focus-visible',
      "reading-return",
      "backward",
    );
    assert(
      !returnTrace.observations.some((s) => s.active.inQueueRow),
      "Reverse Tab reaches the trailing return before per-message actions",
    );
    const returnState = await save("collapse-return-focus");
    verifyQueueReading(returnState, baseline, true, "returnAction");
    verifyQueueReturn(returnState, baseline, true);
    const trip = {
      theme: options.theme,
      backwardTabs: returnTrace.steps,
      footerHeight: returnState.returnFooter.rect.height,
      returnHostHeight: returnState.returnHost.rect.height,
      fullyVisibleRows: returnState.fullyVisibleRows,
      bottomZoneHeight: returnState.bottomZone.rect.height,
      conversationHeight: returnState.conversation?.rect.height ?? null,
      conversationUncoveredHeight: returnState.conversationUncoveredHeight,
      initialReturnHittable: expanded.returnAction.hit,
      footerToComposerGap:
        returnState.composer.rect.y - returnState.returnFooter.rect.bottom,
      returnedToComposer: false,
    };
    (evidence.queueReadingReturnTrips ??= []).push(trip);
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}),
      });
    await wait(
      "document.querySelector('.queue-reading-toggle')?.getAttribute('aria-expanded')==='false' && !document.querySelector('[data-queue-control=\"reading-return\"]') && document.activeElement?.matches('.composer [contenteditable=\"true\"], .composer textarea')",
    );
    const collapsed = await save("collapsed-composer-focus");
    verifyQueueReading(collapsed, baseline, false, "editor");
    verifyQueueReturn(collapsed, baseline, false);
    trip.returnedToComposer = collapsed.editor.focused;
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
