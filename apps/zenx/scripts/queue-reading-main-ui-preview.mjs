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
      opacity: Number(style.opacity),
      pointerEvents: style.pointerEvents,
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
  const senderRow = tray?.querySelector(
    '[data-queue-id="synthetic-thread-message"]',
  );
  const senderLink = senderRow?.querySelector(".message-source-link");
  const senderLine = senderLink?.closest(".message-source-line");
  const senderBubble = senderRow?.querySelector(
    ".queue-message-body .user-bubble",
  );
  const senderContent = senderRow?.querySelector(".queue-row-content");
  const triggerRow = tray?.querySelector(
    '[data-queue-id="synthetic-trigger-message"]',
  );
  const triggerContent = triggerRow?.querySelector(".queue-row-content");
  const triggerCard = triggerRow?.querySelector(".host-message-content");
  const triggerSteer = triggerRow?.querySelector(".queue-row-steer");
  return {
    triggerRow: triggerRow
      ? {
          content: target(triggerContent),
          card: target(triggerCard),
          header: target(triggerCard?.querySelector("header")),
          summary: target(triggerCard?.querySelector(".host-message-summary")),
          source: target(triggerCard?.querySelector(".host-message-source")),
          steer: target(triggerSteer),
          steerTitle: triggerSteer?.getAttribute("title"),
          steerLabel: triggerSteer?.getAttribute("aria-label"),
          steerText: triggerSteer?.textContent?.trim(),
          hasSteerIcon: !!triggerSteer?.querySelector("svg"),
        }
      : null,
    senderAttribution: {
      rowId: senderRow?.getAttribute("data-queue-id"),
      source: target(senderLink),
      sourceLine: target(senderLine),
      bubble: target(senderBubble),
      sameRow:
        !!senderLink &&
        !!senderBubble &&
        senderLink.closest(".queue-row") === senderBubble.closest(".queue-row"),
      sourceText: senderLink?.textContent,
      bodyText: senderBubble?.textContent,
      overflow: [senderContent, senderLine, senderLink, senderBubble].some(
        (e) => !e || e.scrollWidth > e.clientWidth + 1,
      ),
    },
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
  assert(s.toggle.visible && s.toggle.hit, "Reading toggle remains reachable");
  for (const edge of ["x", "right"]) {
    assert(
      Number.isFinite(s.tray.rect[edge]) &&
        Math.abs(s.tray.rect[edge] - s.composer.rect[edge]) <= 1,
      "Queue outer frame matches Composer edges",
    );
  }
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

/** Rest/expanded only: these original states expose the known source row. */
export function verifyQueueSenderAttribution(s, baseline = s) {
  const a = s.senderAttribution;
  assert.equal(a?.rowId, "synthetic-thread-message");
  assert(
    a.sameRow && a.sourceText?.trim() && a.bodyText?.trim(),
    "Source and body belong to the known nonempty sender row",
  );
  assert.equal(a.sourceText, baseline.senderAttribution.sourceText);
  assert.equal(a.bodyText, baseline.senderAttribution.bodyText);
  assert.equal(
    a.overflow,
    false,
    "Source and body do not overflow their existing row",
  );
  assert(
    a.source?.visible && a.source.hit && a.bubble?.visible && a.bubble.hit,
    "Known source action and body are visible and not covered",
  );
  assert(
    Math.abs(a.source.rect.x - a.bubble.rect.x) <= 2,
    "Source starts at its own bubble, not at the group header edge",
  );
  assert(
    a.sourceLine?.visible,
    "Entire source line including any status is visible",
  );
  const gap = a.bubble.rect.y - a.sourceLine.rect.bottom;
  assert(gap >= -1 && gap <= 12, "Source is immediately above its own message");
  assert(
    a.source.rect.right <= s.tray.rect.right + 1 &&
      a.bubble.rect.right <= s.tray.rect.right + 1,
    "Attribution stays inside the tray",
  );
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
  assert.equal(s.returnAction, null, "No extra return control");
  assert.equal(s.returnFooter, null, "No separate footer space cost");
  assert.equal(s.returnHost, null, "No empty return host");
  assert(
    s.toggle?.visible && s.toggle.hit,
    "Header collapse remains reachable",
  );
  assert.equal(s.expanded, String(expanded));
  assert.equal(s.controls, s.trayId);
  assert(
    s.bottomZone &&
      (!s.bottomZone.scrollsVertical || baseline.bottomZone.scrollsVertical),
    "Header return does not introduce whole bottom-zone scrolling",
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
  const save = async (step, keepPointer = false) => {
    if (!keepPointer)
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
    verifyQueueSenderAttribution(baseline);
    await click(".queue-reading-toggle");
    await wait(
      "document.querySelector('.queue-reading-toggle')?.getAttribute('aria-expanded')==='true'",
    );
    const expanded = await save("expanded");
    verifyQueueReading(expanded, baseline, true);
    verifyQueueReturn(expanded, baseline, true);
    verifyQueueSenderAttribution(expanded, baseline);
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
      ".queue-reading-toggle:focus-visible",
      "reading-header",
      "backward",
    );
    const returnState = await save("collapse-header-focus");
    verifyQueueReading(returnState, baseline, true, "toggle");
    verifyQueueReturn(returnState, baseline, true);
    const trip = {
      theme: options.theme,
      backwardTabs: returnTrace.steps,
      footerHeight: 0,
      fullyVisibleRows: returnState.fullyVisibleRows,
      bottomZoneHeight: returnState.bottomZone.rect.height,
      headerFocused: returnState.toggle.focused,
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
    // A separate Host-source scene preserves matched, six-row before/after
    // evidence above. No action is invoked on the synthetic queued message.
    const hostUrl = new URL(await evaluate("location.href"));
    hostUrl.searchParams.set("hostQueue", "1");
    await send("Page.navigate", { url: hostUrl.href });
    await wait(
      `location.href===${JSON.stringify(hostUrl.href)} && !!document.querySelector('.queue-reading-toggle')`,
    );
    await click(".queue-reading-toggle");
    const hostSelector = '[data-queue-id="synthetic-trigger-message"]';
    await wait(
      `!!document.querySelector(${JSON.stringify(hostSelector + " .host-message-source")})`,
    );
    await evaluate(
      `document.querySelector(${JSON.stringify(hostSelector)}).scrollIntoView({block:"center",inline:"nearest"})`,
    );
    const hostRest = (await save("trigger-source-rest")).triggerRow;
    assert(
      hostRest?.source?.visible &&
        hostRest.source.hit &&
        hostRest.summary?.visible &&
        hostRest.card?.visible &&
        Math.abs(hostRest.card.rect.right - hostRest.content.rect.right) <= 2 &&
        Math.abs(hostRest.header.rect.x - hostRest.summary.rect.x) <= 2,
      "Queued trigger source belongs to its own aligned card and stays operable",
    );
    assert(
      hostRest.steer?.opacity === 0 &&
        hostRest.steer.pointerEvents === "none" &&
        !hostRest.steerText &&
        hostRest.hasSteerIcon &&
        hostRest.steerTitle &&
        hostRest.steerLabel,
      "Resting desktop Steer is a labelled icon with no invisible pointer action",
    );
    const { x, y, width, height } = hostRest.summary.rect;
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x + width / 2,
      y: y + height / 2,
    });
    const hover = (await save("trigger-source-hover", true)).triggerRow;
    assert(
      hover?.steer?.opacity === 1 &&
        hover.steer.hit &&
        hover.steer.pointerEvents !== "none",
      "Steer appears and can be reached when hovering its own row",
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
