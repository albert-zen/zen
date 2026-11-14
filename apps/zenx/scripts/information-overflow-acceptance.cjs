const assert = require("node:assert/strict");

// Read-only renderer observation. readOwner is the existing native wheel-owner
// probe, serialized alongside this function; it is not replaced or loosened.
function informationOverflowMetrics(readOwner) {
  const owner = readOwner();
  const popover = document.querySelector(".information-popover");
  const content = popover?.querySelector(":scope > .information-content");
  const toolbar = popover?.querySelector(".information-dismiss-toolbar");
  const cue = toolbar?.querySelector(".information-overflow-cue");
  const resource = document.querySelector(".workspace > .auxiliary-panel");
  const composer = document.querySelector("#thread-composer");
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };
  const cueRect = rect(cue);
  const cueStyle = cue && getComputedStyle(cue);
  const cueHit =
    cueRect?.width && cueRect.height
      ? document.elementFromPoint(
          cueRect.left + cueRect.width / 2,
          cueRect.top + cueRect.height / 2,
        )
      : null;
  const close = toolbar?.querySelector("button");
  const closeRect = rect(close);
  const closeHit =
    closeRect &&
    document.elementFromPoint(
      closeRect.left + closeRect.width / 2,
      closeRect.top + closeRect.height / 2,
    );
  let lastVisibleContent = null;
  for (const node of [
    ...(content?.querySelectorAll("h3,legend,p,button,summary,label") ?? []),
  ]
    .slice(-512)
    .reverse()) {
    const r = rect(node);
    const top = Math.max(r.top, owner.panel?.top ?? 0, 0);
    const bottom = Math.min(r.bottom, owner.panel?.bottom ?? 0, innerHeight);
    if (!r.width || !r.height || bottom <= top) continue;
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      (top + bottom) / 2,
    );
    if (!hit || !node.contains(hit)) continue;
    lastVisibleContent = {
      tag: node.tagName,
      text: node.textContent?.trim().slice(0, 120),
      rect: r,
    };
    break;
  }
  const active = document.activeElement;
  const activePath = [];
  for (
    let node = active;
    node && activePath.length < 24;
    node = node.parentElement
  ) {
    activePath.unshift(
      `${node.tagName}:${node.parentElement ? [...node.parentElement.children].indexOf(node) : 0}`,
    );
  }
  return {
    ...owner,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    resource: resource
      ? {
          open: resource.dataset.open,
          expanded: resource.dataset.expanded,
          primaryActive: resource.dataset.primaryActive,
        }
      : null,
    overlayCount: document.querySelectorAll(".information-popover").length,
    dockCount: document.querySelectorAll(".information-dock").length,
    ownerKey: content?.querySelector(".editable-information-panel")?.dataset
      .owner,
    popover: rect(popover),
    toolbar: rect(toolbar),
    closeHit: !!close && !!closeHit && close.contains(closeHit),
    clientHeight: content?.clientHeight,
    scrollHeight: content?.scrollHeight,
    remaining: content
      ? content.scrollHeight - content.clientHeight - content.scrollTop
      : null,
    transcript: rect(document.querySelector(".agent-surface .messages")),
    composerDraft: composer?.value,
    active: {
      path: activePath,
      tag: active?.tagName,
      id: active?.id,
      name: active?.getAttribute("name"),
      question: active?.closest(".user-question-card")?.dataset.questionCallId,
    },
    cue: cue
      ? {
          hidden: cue.hidden,
          display: cueStyle.display,
          visibility: cueStyle.visibility,
          pointerEvents: cueStyle.pointerEvents,
          text: cue.textContent?.trim(),
          rect: cueRect,
          ariaHidden: cue.getAttribute("aria-hidden"),
          tabIndex: cue.tabIndex,
          interactiveCount: cue.querySelectorAll(
            "button,a[href],input,textarea,select,[tabindex],[contenteditable=true]",
          ).length,
          ownsPointer: !!cueHit && cue.contains(cueHit),
        }
      : null,
    lastVisibleContent,
  };
}

async function verifyInformationOverflowCue({
  read,
  sendInput,
  pause,
  screenshot,
  result,
  expectedSecondPrompt,
  darkPartial = false,
}) {
  const receipt = {
    name: darkPartial
      ? "desktop-split-information-overflow-cue-dark-partial"
      : "desktop-split-information-overflow-cue",
    input:
      "existing owned-point probe + Electron native wheel only; no answers or focus helpers",
    status: "running",
    samples: [],
    wheels: [],
    noOverflowScene: "not-exercised; this fixture genuinely overflows",
    baselineGeometryComparison:
      "not performed here; compare source-bound native baseline separately",
  };
  if (darkPartial) {
    receipt.darkScope =
      "same overlay after Stage1, not fresh open: initial and partial native wheel, then restoration; no dark bottom or no-overflow claim";
    receipt.forcedColorsScope =
      "media value observed only; not changed or tested";
  }
  result.cases.push(receipt);
  try {
    const stable = async (label) => {
      let previous = await read();
      for (let attempt = 0; attempt < 20; attempt++) {
        await pause(50);
        const next = await read();
        if (JSON.stringify(next) === JSON.stringify(previous)) return next;
        previous = next;
      }
      receipt.unsettled = { label, sample: previous };
      assert.fail(`${label}: Information observation did not settle`);
    };
    const before = await stable("initial");
    receipt.before = before;
    for (const key of [
      "popover",
      "toolbar",
      "panel",
      "composer",
      "toggle",
      "dismiss",
      "transcript",
    ])
      assert.ok(
        before[key]?.width > 0 && before[key]?.height > 0,
        `initial: ${key} has real geometry`,
      );
    assert.ok(
      Number.isFinite(before.transcriptScroll) &&
        typeof before.composerDraft === "string" &&
        before.clientHeight > 0 &&
        before.scrollHeight > before.clientHeight,
      "initial: actual transcript, draft and overflowing viewport exist",
    );
    assert.ok(
      before.viewport.width >= 1280 &&
        before.overlayCount === 1 &&
        before.dockCount === 0,
      "ordinary desktop overlay, not a narrow/dock scene",
    );
    assert.ok(
      before.resource?.open === "true" &&
        before.resource.expanded !== "true" &&
        before.resource.primaryActive !== "true",
      "existing workspace split is open and non-expanded",
    );
    assert.ok(
      before.ownerKey &&
        before.questions.length === 2 &&
        before.questions.every((q) => q.id && q.actions?.length) &&
        before.questions[1].prompts.includes(expectedSecondPrompt),
      "same scoped synthetic owner and two pending questions",
    );
    assert.ok(
      (darkPartial
        ? Math.abs(before.panelScroll) <= 1
        : before.panelScroll === 0) && before.remaining > 2,
      "initial fixture has real remaining overflow from the top",
    );

    const pendingState = (sample) =>
      sample.questions.map((q) => ({
        id: q.id,
        prompts: q.prompts,
        actions: q.actions.map(
          ({ text, type, answerAction, disabled, focused }) => ({
            text,
            type,
            answerAction,
            disabled,
            focused,
          }),
        ),
      }));
    const check = (sample, label) => {
      receipt.samples.push({ label, sample });
      if (darkPartial) {
        assert.equal(
          sample.appearance,
          "dark",
          `${label}: actual production dark appearance`,
        );
        assert.equal(
          sample.prefersDark,
          true,
          `${label}: actual native dark media`,
        );
        assert.equal(
          typeof sample.forcedColorsActive,
          "boolean",
          `${label}: forced-colors observation is explicit`,
        );
      }
      for (const key of [
        "viewport",
        "resource",
        "overlayCount",
        "dockCount",
        "ownerKey",
        "popover",
        "toolbar",
        "panel",
        "clientHeight",
        "scrollHeight",
        "composer",
        "composerDraft",
        "toggle",
        "dismiss",
        "transcript",
        "transcriptScroll",
        "active",
      ])
        assert.deepEqual(
          sample[key],
          before[key],
          `${label}: ${key} unchanged`,
        );
      assert.deepEqual(
        pendingState(sample),
        pendingState(before),
        `${label}: scoped pending questions and action state unchanged`,
      );
      assert.ok(sample.closeHit, `${label}: Close remains hit-testable`);
      assert.ok(
        sample.cue &&
          sample.cue.ariaHidden === "true" &&
          sample.cue.tabIndex === -1 &&
          sample.cue.interactiveCount === 0 &&
          sample.cue.pointerEvents === "none" &&
          !sample.cue.ownsPointer,
        `${label}: cue is noninteractive and adds no Tab stop`,
      );
      const visible = sample.clientHeight > 0 && sample.remaining > 1;
      const cue = sample.cue;
      assert.equal(
        cue.hidden,
        !visible,
        `${label}: cue follows actual remaining overflow`,
      );
      if (visible) {
        assert.equal(
          cue.text,
          "More below",
          `${label}: actual English fixture label`,
        );
        const r = cue.rect,
          t = sample.toolbar,
          c = sample.dismiss;
        assert.ok(
          cue.display !== "none" &&
            cue.visibility === "visible" &&
            r.width > 0 &&
            r.height > 0 &&
            r.left >= t.left &&
            r.right <= t.right &&
            r.top >= t.top &&
            r.bottom <= t.bottom,
          `${label}: cue fully inside existing toolbar`,
        );
        assert.ok(
          r.right <= c.left ||
            r.left >= c.right ||
            r.bottom <= c.top ||
            r.top >= c.bottom,
          `${label}: cue does not overlap Close`,
        );
      } else {
        assert.ok(
          cue.display === "none" &&
            cue.rect.width === 0 &&
            cue.rect.height === 0,
          `${label}: hidden cue has no layout box`,
        );
      }
    };
    const wheel = async (deltaY, label) => {
      const fresh = await stable(`${label}-before`);
      check(fresh, `${label}-before`);
      assert.ok(
        fresh.owned && fresh.point,
        `${label}: fresh owned non-control wheel point`,
      );
      assert.ok(
        Math.abs(deltaY) > 0 && Math.abs(deltaY) <= 360,
        `${label}: bounded native wheel`,
      );
      assert.ok(
        deltaY < 0 ? fresh.remaining > 1 : fresh.panelScroll > 1,
        `${label}: never wheel beyond the known edge`,
      );
      assert.ok(
        deltaY < 0 ? -deltaY <= fresh.remaining : deltaY <= fresh.panelScroll,
        `${label}: wheel cannot exceed fresh remaining distance`,
      );
      receipt.wheels.push({
        label,
        point: fresh.point,
        from: fresh.panelScroll,
        deltaY,
      });
      sendInput({ type: "mouseMove", ...fresh.point });
      sendInput({
        type: "mouseWheel",
        ...fresh.point,
        deltaY,
        deltaX: 0,
        canScroll: true,
      });
      let moved = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await pause(35);
        const current = await read();
        receipt.lastMovementRead = current;
        if (
          deltaY < 0
            ? current.panelScroll > fresh.panelScroll
            : current.panelScroll < fresh.panelScroll
        ) {
          moved = true;
          break;
        }
      }
      assert.ok(moved, `${label}: native inner scroll made progress`);
      const after = await stable(label);
      check(after, label);
      return after;
    };
    check(before, "initial");
    await screenshot("03c-overflow-cue-initial.png");
    let current = await wheel(
      -Math.min(360, Math.floor(before.remaining / 2)),
      "partial",
    );
    assert.ok(
      current.remaining > 1 && !current.cue.hidden,
      "partial wheel still leaves content and keeps cue visible",
    );
    await screenshot("03d-overflow-cue-partial.png");
    if (!darkPartial) {
      for (let step = 0; current.remaining > 1 && step < 8; step++)
        current = await wheel(
          -Math.min(360, current.remaining),
          `bottom-${step + 1}`,
        );
      assert.ok(
        current.remaining <= 1 && current.cue.hidden,
        "bounded native wheel actually reaches bottom and hides cue",
      );
      assert.ok(
        current.lastVisibleContent?.text,
        "actual hit-tested visible provider content is recorded at bottom",
      );
      receipt.bottom = current;
      await screenshot("03e-overflow-cue-bottom.png");
      current = await wheel(
        Math.min(360, current.panelScroll),
        "up-from-bottom",
      );
      assert.ok(
        current.remaining > 1 && !current.cue.hidden,
        "upward native wheel reveals remaining content and cue again",
      );
      await screenshot("03f-overflow-cue-up.png");
    }
    for (
      let step = 0;
      Math.abs(current.panelScroll - before.panelScroll) > 1 && step < 8;
      step++
    )
      current = await wheel(
        Math.min(360, current.panelScroll - before.panelScroll),
        `restore-${step + 1}`,
      );
    receipt.restored = current;
    assert.ok(
      Math.abs(current.panelScroll - before.panelScroll) <= 1,
      "native cleanup restores starting scroll before existing keyboard/Stage2 cases",
    );
    receipt.status = "passed";
  } catch (error) {
    receipt.status = "failed";
    receipt.error = String(error);
    throw error;
  }
}

// Separate read-only observation: do not change existing English/dark receipts.
function informationCueLabelMetrics(readBase) {
  const sample = readBase();
  const label = document.querySelector(
    ".information-popover .information-overflow-cue > span",
  );
  const r = label?.getBoundingClientRect();
  return {
    ...sample,
    language: document.documentElement.lang,
    storedLanguage: localStorage.getItem("zenx.language"),
    innerLabel: label
      ? {
          text: label.textContent?.trim(),
          clientWidth: label.clientWidth,
          scrollWidth: label.scrollWidth,
          rect: {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          },
          fontFamily: getComputedStyle(label).fontFamily,
        }
      : null,
  };
}

function assertChineseInformationCue(sample, before) {
  assert.equal(
    sample.language,
    "zh-CN",
    "actual document locale, not an assumed translation",
  );
  assert.equal(sample.storedLanguage, "zh-CN");
  assert.equal(sample.viewport.width, 1600, "same ordinary desktop width");
  assert.ok(
    sample.overlayCount === 1 &&
      sample.dockCount === 0 &&
      sample.resource?.open === "true" &&
      sample.resource.expanded !== "true" &&
      sample.resource.primaryActive !== "true",
    "ordinary resource split, not dock or narrow",
  );
  assert.ok(
    before.ownerKey &&
      before.questions.length === 2 &&
      before.questions.every((q) => q.id),
    "original scoped two-question scene exists",
  );
  assert.equal(sample.ownerKey, before.ownerKey);
  assert.deepEqual(
    sample.questions.map((q) => q.id),
    before.questions.map((q) => q.id),
    "locale switch never answers or changes pending questions",
  );
  assert.ok(
    sample.panel?.width > 0 &&
      sample.panel?.height > 0 &&
      sample.clientHeight > 0 &&
      sample.scrollHeight > sample.clientHeight &&
      sample.remaining > 1,
    "Chinese cue is tested with real content remaining below",
  );
  const cue = sample.cue,
    label = sample.innerLabel;
  assert.ok(
    cue &&
      !cue.hidden &&
      cue.display !== "none" &&
      cue.visibility === "visible",
    "actual Chinese cue is rendered",
  );
  assert.equal(cue.text, "下方还有内容");
  assert.ok(
    label &&
      label.text === "下方还有内容" &&
      label.clientWidth > 0 &&
      label.scrollWidth <= label.clientWidth &&
      label.rect.width > 0 &&
      label.rect.height > 0,
    "inner Chinese text fits without ellipsis or horizontal clipping",
  );
  assert.ok(
    cue.ariaHidden === "true" &&
      cue.tabIndex === -1 &&
      cue.interactiveCount === 0 &&
      cue.pointerEvents === "none" &&
      !cue.ownsPointer,
    "label adds no action or pointer surface",
  );
  const r = cue.rect,
    t = sample.toolbar,
    c = sample.dismiss,
    l = label.rect;
  assert.ok(
    r.left >= t.left &&
      r.right <= t.right &&
      r.top >= t.top &&
      r.bottom <= t.bottom,
    "Chinese cue remains inside toolbar",
  );
  assert.ok(
    l.left >= r.left &&
      l.right <= r.right &&
      l.top >= r.top &&
      l.bottom <= r.bottom,
    "inner Chinese label remains inside cue",
  );
  assert.ok(
    r.right <= c.left ||
      r.left >= c.right ||
      r.bottom <= c.top ||
      r.top >= c.bottom,
    "Chinese cue does not overlap translated Close",
  );
  assert.ok(sample.closeHit, "translated Close remains hit-testable");
}

function classifySingleSiblingCueFit(sample, ownerKey, siblingId) {
  const scope =
    sample.viewport.width === 1600 &&
    sample.overlayCount === 1 &&
    sample.dockCount === 0 &&
    sample.resource?.open === "true" &&
    sample.resource.expanded !== "true" &&
    sample.resource.primaryActive !== "true" &&
    sample.ownerKey === ownerKey &&
    sample.questions.length === 1 &&
    sample.questions[0].id === siblingId;
  if (
    !scope ||
    !sample.owned ||
    !sample.panel ||
    sample.panel.width <= 0 ||
    sample.panel.height <= 0 ||
    !(sample.clientHeight > 0)
  )
    return {
      status: "not-exercised",
      reason: "exact visible single-sibling desktop split was not observed",
    };
  // A scrolled-to-bottom panel is NOT a fitting/no-overflow scene.
  if (!(sample.scrollHeight <= sample.clientHeight && sample.panelScroll === 0))
    return {
      status: "not-exercised",
      reason:
        "single sibling still overflows or is not at zero scroll; no scene alteration attempted",
    };
  const cue = sample.cue;
  assert.ok(
    cue &&
      cue.hidden &&
      cue.display === "none" &&
      cue.rect.width === 0 &&
      cue.rect.height === 0,
    "genuinely fitting owner hides the cue with no layout box",
  );
  assert.ok(
    cue.ariaHidden === "true" &&
      cue.tabIndex === -1 &&
      cue.interactiveCount === 0 &&
      cue.pointerEvents === "none" &&
      !cue.ownsPointer,
    "hidden fitting cue cannot become an action",
  );
  return {
    status: "passed",
    reason:
      "visible owner has positive clientHeight, scrollHeight<=clientHeight and exact zero scroll; no rounding tolerance",
  };
}

module.exports = {
  informationOverflowMetrics,
  verifyInformationOverflowCue,
  informationCueLabelMetrics,
  assertChineseInformationCue,
  classifySingleSiblingCueFit,
};
