import assert from "node:assert/strict";
export function observeQueueReading(viewportId) {
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
      clipPath: style.clipPath,
      overflowY: style.overflowY,
      scrollsVertical:
        /auto|scroll/.test(style.overflowY) &&
        e.scrollHeight > e.clientHeight + 1,
      controls: e.getAttribute("aria-controls"),
      expanded: e.getAttribute("aria-expanded"),
    };
  };
  const selectedTray = viewportId ? document.getElementById(viewportId) : null;
  const toggle = (viewportId ? selectedTray : document)?.querySelector(
      ".queue-reading-toggle",
    ),
    tray = document.getElementById(toggle?.getAttribute("aria-controls")),
    returnHost = tray?.nextElementSibling?.matches(".queue-reading-bridge-host")
      ? tray.nextElementSibling
      : null,
    bridge = returnHost?.querySelector('[data-queue-control="reading-bridge"]'),
    returnOwner = document.getElementById(
      bridge?.getAttribute("aria-controls"),
    ),
    returnAction = tray
      ?.closest(".bottom-zone")
      ?.querySelector('[data-queue-control="reading-return"]'),
    returnFooter = tray
      ?.closest(".bottom-zone")
      ?.querySelector(".queue-reading-return"),
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
    bridge: target(bridge),
    returnAction: target(returnAction),
    returnFooter: target(returnFooter),
    returnHost: target(returnHost),
    returnPlacement: {
      ownerMatchesTray:
        !!returnOwner && returnOwner === tray && tray.matches(".pending-tray"),
      outsideTray: !!returnHost && !tray.contains(returnHost),
      followsTray: !!returnHost && tray.nextElementSibling === returnHost,
      bridgeInHost: !!bridge && bridge.parentElement === returnHost,
      beforeComposer:
        !!returnHost &&
        !!composer &&
        !!(
          returnHost.compareDocumentPosition(composer) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    },
    // Queue ownership comes from its original header inside the aria-controlled
    // tray, not from the portalled shortcut or the earlier Steer shelf.
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
  assert(
    s.returnHost && s.returnHost.rect.height === 0,
    "Bridge host has no flow footprint",
  );
  if (expanded) {
    assert(s.bridge, "Expanded reading has a native keyboard bridge");
    assert.equal(s.bridge.controls, s.trayId);
    assert.equal(s.bridge.expanded, "true");
    assert(
      Object.values(s.returnPlacement).every(Boolean),
      "Bridge belongs to its own tray before Composer",
    );
    if (!s.bridge.focusVisible) {
      assert(
        !s.bridge.hit &&
          s.bridge.pointerEvents === "none" &&
          s.bridge.clipPath !== "none",
        "Unfocused bridge is clipped and cannot intercept pointer actions",
      );
    }
  } else
    assert.equal(s.bridge, null, "Collapsed reading has no bridge tab stop");
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

export function verifyQueueBridge(s, rest) {
  const b = s.bridge;
  assert(
    b?.focused && b.focusVisible && b.visible && b.hit && !b.disabled,
    "Focused bridge is visible and operable outside the clipped scroller",
  );
  assert(
    b.outline !== "none" && b.outlineWidth > 0,
    "Bridge has a visible keyboard focus ring",
  );
  assert(b.clipPath === "none", "Focused bridge is not clipped");
  for (const name of ["tray", "composer", "bottomZone"]) {
    for (const edge of ["x", "y", "width", "height"]) {
      assert(
        Number.isFinite(s[name].rect[edge]) &&
          Math.abs(s[name].rect[edge] - rest[name].rect[edge]) <= 1,
        "Focusing bridge does not move or resize reading/writing surfaces",
      );
    }
  }
  assert(
    b.rect.x >= s.tray.rect.x + 2 &&
      b.rect.right <= s.tray.rect.right - 2 &&
      b.rect.y >= s.tray.rect.y + 2 &&
      b.rect.bottom <= s.tray.rect.bottom + 1,
    "Bridge and its focus ring stay inside the tray frame, above Composer",
  );
  assert(
    b.rect.bottom + 2 <= s.composer.rect.y,
    "Bridge focus ring does not cover Composer",
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
export const syntheticSteerFocusText =
  "Compare the synthetic desktop notes, keep each queued instruction readable, and verify keyboard actions without sending messages or changing the saved draft.";

/** Read-only DOM observation. A title attribute is not a painted tooltip. */
export function observeQueueSteerFocus() {
  const row = document.querySelector(
    '[data-queue-id="synthetic-thread-message"]',
  );
  const button = row?.querySelector('[data-queue-control="steer"]');
  const composer = document.querySelector(".composer");
  const rect = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };
  const painted = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    if (!(
      r.width > 0 &&
      r.height > 0 &&
      r.x >= 0 &&
      r.y >= 0 &&
      r.right <= innerWidth &&
      r.bottom <= innerHeight
    ))
      return false;
    for (let parent = e; parent; parent = parent.parentElement) {
      const s = getComputedStyle(parent);
      if (
        parent.hidden ||
        s.display === "none" ||
        s.visibility === "hidden" ||
        s.opacity === "0"
      )
        return false;
    }
    return e.contains(
      document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
    );
  };
  const hint = row?.querySelector(".queue-steer-keyboard-hint");
  const hintRect = rect(hint),
    trayRect = rect(row?.closest(".pending-tray"));
  const hintStyle = hint ? getComputedStyle(hint) : null;
  const source = row?.querySelector(".message-source-link");
  const sourceText = source?.querySelector("span");
  let scrollport = row?.parentElement ?? null;
  while (
    scrollport &&
    !/(auto|scroll)/.test(getComputedStyle(scrollport).overflowY)
  )
    scrollport = scrollport.parentElement;
  const messages = document.querySelector(".messages");
  const editor = composer?.querySelector('textarea,[contenteditable="true"]');
  return {
    rowRect: rect(row),
    scrollport: scrollport && {
      id: scrollport.id,
      isQueueTray: scrollport.matches(".pending-tray"),
      rect: rect(scrollport),
      top: scrollport.scrollTop,
      left: scrollport.scrollLeft,
      clientWidth: scrollport.clientWidth,
      clientHeight: scrollport.clientHeight,
      scrollWidth: scrollport.scrollWidth,
      scrollHeight: scrollport.scrollHeight,
    },
    dock: rect(row?.closest(".bottom-zone")),
    viewport: [innerWidth, innerHeight],
    outsideScroll: {
      page: [window.scrollX, window.scrollY],
      messages: messages ? [messages.scrollLeft, messages.scrollTop] : null,
    },
    sourceRect: rect(source),
    bodyRect: rect(row?.querySelector(".user-bubble")),
    sourceClipped:
      !!sourceText && sourceText.scrollWidth > sourceText.clientWidth + 1,
    hint: hint && {
      text: hint.textContent.trim(),
      rect: hintRect,
      ariaHidden: hint.getAttribute("aria-hidden"),
      pointerEvents: hintStyle.pointerEvents,
      visible:
        hintRect.width > 0 &&
        hintRect.height > 0 &&
        hintStyle.display !== "none" &&
        hintStyle.visibility === "visible" &&
        Number(hintStyle.opacity) > 0 &&
        !!trayRect &&
        hintRect.x >= trayRect.x &&
        hintRect.right <= trayRect.right &&
        hintRect.y >= trayRect.y &&
        hintRect.bottom <= trayRect.bottom &&
        hint.scrollWidth <= hint.clientWidth + 1,
    },
    rowCount: document.querySelectorAll(
      '[data-queue-id="synthetic-thread-message"]',
    ).length,
    text: row?.querySelector(".user-bubble")?.textContent?.trim() ?? null,
    source:
      row?.querySelector(".message-source-link")?.textContent?.trim() ?? null,
    order: [...document.querySelectorAll(".queue-row")].map(
      (e) => e.dataset.queueId,
    ),
    running: !!composer?.querySelector(".action-orb.stop"),
    composer: rect(composer),
    draft: editor?.value ?? editor?.textContent ?? null,
    button: button && {
      rect: rect(button),
      painted: painted(button),
      focused: document.activeElement === button,
      focusVisible: button.matches(":focus-visible"),
      disabled: button.disabled,
      label: button.getAttribute("aria-label"),
      nativeTitleAttribute: button.getAttribute("title"),
      visibleText: button.textContent?.trim(),
      hasIcon: !!button.querySelector("svg"),
      outline: getComputedStyle(button).outlineStyle,
      outlineWidth: parseFloat(getComputedStyle(button).outlineWidth),
    },
    paintedDomTooltips: [...document.querySelectorAll('[role="tooltip"]')]
      .filter(painted)
      .map((e) => e.textContent?.trim()),
  };
}

export function verifyQueueSteerFocus(s, before) {
  assert.equal(s.rowCount, 1);
  assert.equal(s.text, syntheticSteerFocusText);
  assert(
    s.source && s.running,
    "Same agent-origin queued-message purpose while running",
  );
  assert(
    s.button?.focused &&
      s.button.focusVisible &&
      s.button.painted &&
      !s.button.disabled,
    "Actual native keyboard focus must be visible and unobstructed",
  );
  assert(s.button.label && s.button.hasIcon);
  assert(
    s.button.outline !== "none" && s.button.outlineWidth > 0,
    "Visible focus ring",
  );
  for (const key of ["text", "source", "order", "draft", "composer", "running"])
    assert.deepEqual(s[key], before[key], "Focus must not mutate " + key);
}

/** Native Tab may scroll its queue. Only measured scroll can explain a rigid shift. */
export function verifyQueueSteerFocusGeometry(state, before) {
  assert(
    state.scrollport?.isQueueTray && before.scrollport?.isQueueTray,
    "The measured nearest scroll owner is the queue tray",
  );
  assert(
    state.dock && before.dock && state.outsideScroll && before.outsideScroll,
    "The dock and outer scroll are actually observed",
  );
  for (const key of ["dock", "viewport", "outsideScroll"])
    assert.deepEqual(
      state[key],
      before[key],
      "Focus keeps the outer " + key + " anchored",
    );
  for (const key of [
    "id",
    "rect",
    "clientWidth",
    "clientHeight",
    "scrollWidth",
    "scrollHeight",
  ])
    assert.deepEqual(
      state.scrollport[key],
      before.scrollport[key],
      "Focus does not change queue scrollport " + key,
    );
  const scroll = state.scrollport,
    original = before.scrollport;
  for (const sample of [scroll, original]) {
    assert(
      [sample.top, sample.left].every(Number.isFinite),
      "Measured scroll offsets are finite",
    );
    assert(
      sample.top >= 0 &&
        sample.top <= sample.scrollHeight - sample.clientHeight + 1,
    );
    assert(
      sample.left >= 0 &&
        sample.left <= sample.scrollWidth - sample.clientWidth + 1,
    );
  }
  const delta = {
    x: scroll.left - original.left,
    y: scroll.top - original.top,
  };
  for (const [name, current, previous] of [
    ["row", state.rowRect, before.rowRect],
    ["source", state.sourceRect, before.sourceRect],
    ["body", state.bodyRect, before.bodyRect],
    ["button", state.button.rect, before.button.rect],
    ["hint", state.hint.rect, before.hint.rect],
  ]) {
    assert(current && previous, "Actual geometry exists for " + name);
    for (const edge of ["x", "right", "y", "bottom", "width", "height"]) {
      const correction =
        edge === "x" || edge === "right"
          ? delta.x
          : edge === "y" || edge === "bottom"
            ? delta.y
            : 0;
      assert(Number.isFinite(current[edge]) && Number.isFinite(previous[edge]));
      assert(
        Math.abs(current[edge] + correction - previous[edge]) <= 0.5,
        name +
          " " +
          edge +
          " change must be explained by measured queue scroll alone",
      );
    }
  }
  return { scrollDelta: delta, roundingTolerancePx: 0.5 };
}

export function verifyQueueSteerFocusCandidate(state, before) {
  verifyQueueSteerFocus(state, before);
  assert(
    before.hint && !before.hint.visible,
    "Pointer-away baseline has no visible label",
  );
  assert(
    state.hint?.visible,
    "Keyboard hint is fully visible within its own tray",
  );
  assert.equal(state.hint.text, "Steer now");
  assert.equal(
    state.hint.ariaHidden,
    "true",
    "Do not repeat the existing accessible action name",
  );
  assert.equal(
    state.hint.pointerEvents,
    "none",
    "Hint cannot become another control",
  );
  assert(!state.sourceClipped, "The evidenced source remains complete");
  verifyQueueSteerFocusGeometry(state, before);
  assert(
    state.hint.rect.x >= state.sourceRect.right + 4,
    "Hint does not cover provenance",
  );
  assert(
    state.hint.rect.bottom <= state.bodyRect.y,
    "Hint stays above message content",
  );
}

/** Separate synthetic scene appended after existing queue evidence; no Steer activation. */
export async function captureQueueSteerFocus({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
}) {
  const trip = {
    theme: options.theme,
    status: "running",
    scope:
      "Synthetic long agent-origin queue while running; native Tab observation only",
  };
  (evidence.queueSteerFocusTrips ??= []).push(trip);
  const observe = () => evaluate(`(${observeQueueSteerFocus.toString()})()`);
  try {
    const url = new URL(await evaluate("location.href"));
    url.searchParams.delete("hostQueue");
    url.searchParams.delete("idle");
    url.searchParams.set("steerFocus", "1");
    url.searchParams.set("lang", "en");
    await send("Page.navigate", { url: url.href });
    await wait(
      `location.href===${JSON.stringify(url.href)} && !!document.querySelector('.queue-reading-toggle')`,
    );
    await click(".queue-reading-toggle");
    await wait(
      "document.querySelector('.queue-reading-toggle')?.getAttribute('aria-expanded')==='true'",
    );
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 700,
      y: 180,
    });
    const before = (trip.before = await observe());
    assert.equal(
      before.text,
      syntheticSteerFocusText,
      "Require the isolated long synthetic item",
    );
    assert(before.running && before.source);
    await tabToQueueControl({
      send,
      observe,
      evaluate,
      evidence,
      options,
      selector:
        '[data-queue-id="synthetic-thread-message"] [data-queue-control="steer"]:focus-visible',
      step: "long-agent-message-steer-baseline",
    });
    // Observe a delayed product tooltip if one exists; never synthesize it.
    await evaluate("new Promise(resolve => setTimeout(resolve, 900))");
    const held = (trip.held = await observe());
    trip.candidateScreenshot = {
      file: `queue-reading-${options.name}-steer-tab-candidate.png`,
      captured: false,
      verification: "pending",
    };
    // Keep the real candidate frame even when a following geometry guard fails.
    await capture(
      `queue-reading-${options.name}-steer-tab-candidate`,
      options,
      "pending",
    );
    trip.candidateScreenshot.captured = true;
    const after = (trip.afterScreenshot = await observe());
    verifyQueueSteerFocusCandidate(held, before);
    verifyQueueSteerFocusCandidate(after, before);
    trip.focusGeometry = verifyQueueSteerFocusGeometry(held, before);
    assert.deepEqual(after, held, "Captured focus state remains stable");
    for (const type of ["rawKeyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
    const released = (trip.afterBlur = await observe());
    trip.blurGeometry = verifyQueueSteerFocusGeometry(released, before);
    assert(
      !released.button.focused && !released.hint.visible,
      "The hint disappears when native Tab leaves Steer",
    );
    for (const key of [
      "text",
      "source",
      "order",
      "draft",
      "composer",
      "running",
    ])
      assert.deepEqual(
        released[key],
        before[key],
        "Leaving focus does not mutate " + key,
      );
    trip.nativeTooltipPixels =
      "Not established by Page.captureScreenshot; title attribute recorded separately";
    trip.candidateScreenshot.verification = "passed";
    trip.status = "passed";
  } catch (error) {
    if (trip.candidateScreenshot)
      trip.candidateScreenshot.verification = "failed";
    trip.status = "failed";
    trip.error = String(error);
    throw error;
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
    // Geometry-only stress, not an approval-decision or full approval-flow test.
    // Compare with the optional host suppressed; restore every style/class before
    // any native interaction or screenshot, including on an assertion failure.
    const bridgeGeometry = await evaluate(`(() => {
      const tray = document.getElementById(document.querySelector('.queue-reading-toggle').getAttribute('aria-controls'));
      const zone = tray.closest('.bottom-zone');
      const host = tray.nextElementSibling;
      const composer = zone.querySelector('.composer');
      const originalClass = zone.className;
      const originalDisplay = host.style.display;
      const rects = () => [tray, composer, zone].map(e => {
        const r = e.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
      });
      const result = [];
      try {
        for (const approvalGap of [false, true]) {
          zone.classList.toggle('has-approval', approvalGap);
          host.style.display = 'none';
          const withoutHost = rects();
          host.style.display = originalDisplay;
          const withHost = rects();
          result.push({approvalGap, withoutHost, withHost, hostHeight:host.getBoundingClientRect().height});
        }
      } finally {
        zone.className = originalClass;
        host.style.display = originalDisplay;
      }
      return result;
    })()`);
    for (const geometry of bridgeGeometry) {
      assert.equal(geometry.hostHeight, 0);
      for (let i = 0; i < geometry.withHost.length; i++)
        for (const edge of ["x", "y", "width", "height"])
          assert(
            Math.abs(
              geometry.withHost[i][edge] - geometry.withoutHost[i][edge],
            ) <= 1,
            "Bridge has zero layout cost with ordinary queue and approval-gap layout",
          );
    }
    (evidence.queueReadingBridgeGeometry ??= []).push({
      theme: options.theme,
      cases: bridgeGeometry,
    });
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
    const bridgeSelector =
      '[data-queue-control="reading-bridge"]:focus-visible';
    const editorSelector =
      '.composer [contenteditable="true"]:focus-visible, .composer textarea:focus-visible';
    const key = async (key, code = key, windowsVirtualKeyCode = 27) => {
      for (const type of ["keyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type,
          key,
          code,
          windowsVirtualKeyCode,
          ...(key === "Enter" && type === "keyDown"
            ? { text: "\r", unmodifiedText: "\r" }
            : {}),
        });
    };
    const returnTrace = await tab(bridgeSelector, "reading-bridge", "backward");
    assert.equal(
      returnTrace.steps,
      1,
      "Composer reaches bridge in one reverse Tab",
    );
    const returnState = await save("collapse-bridge-focus");
    verifyQueueReading(returnState, baseline, true, "bridge");
    verifyQueueReturn(returnState, baseline, true);
    verifyQueueBridge(returnState, expanded);
    const forward = await tab(editorSelector, "bridge-forward-composer");
    assert.equal(
      forward.steps,
      1,
      "Forward Tab leaves bridge for Composer without interception",
    );
    verifyQueueReading(
      await save("bridge-forward-composer-focus"),
      baseline,
      true,
      "editor",
    );
    await tab(bridgeSelector, "bridge-escape", "backward");
    await key("Escape");
    const escaped = await save("bridge-escape-composer-focus");
    verifyQueueReading(escaped, baseline, true, "editor");
    verifyQueueReturn(escaped, baseline, true);
    // Escape elsewhere must not become a global queue-close/focus shortcut.
    await tab(bridgeSelector, "bridge-row-access", "backward");
    const rowTrace = await tab(
      ".queue-row button:focus-visible",
      "bridge-to-row",
      "backward",
    );
    assert.equal(
      rowTrace.steps,
      1,
      "Reverse Tab preserves ordinary per-row access",
    );
    const rowBeforeEscape = await observe();
    await key("Escape");
    const rowAfterEscape = await observe();
    assert(
      rowAfterEscape.active.inQueueRow,
      "Escape in a row does not hijack focus to Composer",
    );
    assert.deepEqual(
      rowAfterEscape.active,
      rowBeforeEscape.active,
      "Bridge Escape handling is local to its own button",
    );
    assert.equal(rowAfterEscape.expanded, "true");
    await tab(editorSelector, "rows-to-composer");
    const collapseTrace = await tab(
      bridgeSelector,
      "bridge-collapse",
      "backward",
    );
    assert.equal(collapseTrace.steps, 1);
    verifyQueueBridge(await save("bridge-enter-focus"), expanded);
    const trip = {
      theme: options.theme,
      backwardTabs: returnTrace.steps,
      forwardTabs: forward.steps,
      rowAccessTabs: rowTrace.steps,
      footerHeight: 0,
      fullyVisibleRows: returnState.fullyVisibleRows,
      bottomZoneHeight: returnState.bottomZone.rect.height,
      bridgeFocused: returnState.bridge.focused,
      escapeKeepsExpanded: escaped.expanded === "true",
      returnedToComposer: false,
    };
    (evidence.queueReadingReturnTrips ??= []).push(trip);
    await key("Enter", "Enter", 13);
    await wait(
      "document.querySelector('.queue-reading-toggle')?.getAttribute('aria-expanded')==='false' && !document.querySelector('[data-queue-control=\"reading-bridge\"]') && document.activeElement?.matches('.composer [contenteditable=\"true\"], .composer textarea')",
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
    await captureQueueSteerFocus({
      send,
      evaluate,
      wait,
      click,
      capture,
      evidence,
      options,
    });
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
